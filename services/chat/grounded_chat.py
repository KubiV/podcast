"""Streamovaná odpověď asistenta ukotvená v materiálech projektu."""

import asyncio
import json
import re
from collections.abc import AsyncGenerator
from typing import Any

from google.genai import types

from core.context import get_current_language, get_language_directive
from prompts.chat import STRICT_GROUNDED_SYSTEM_PROMPT
from services.chat.repository import create_thread, get_thread, get_thread_messages, save_message
from services.chat.retrieval import retrieve_chat_context
from services.chat.storage import get_ai_client, sanitize_project_name

# --- STREAMING CHAT COMPLETIONS ---


def clean_leaked_thoughts(t: str) -> str:
    """Odstraní případné nechtěně uniklé myšlenkové bloky nebo scratchpad z textu odpovědi."""
    if not t:
        return ""
    # 1. Odstranění XML/HTML thought značek
    t = re.sub(r"<(thought|think)>[\s\S]*?</\1>", "", t, flags=re.IGNORECASE)
    t = re.sub(r"<(thought|think)>[\s\S]*?$", "", t, flags=re.IGNORECASE)
    # 2. Odstranění komentářových scratchpad bloků typu /* ... */
    t = re.sub(r"^\s*/\*[\s\S]*?\*/\s*", "", t)
    # 3. Odstranění všech úvodních draftů a checklistů (opakovaně, dokud nezačíná skutečný obsah)
    thought_prefix_pattern = re.compile(
        r"^\s*(?:/|/\*)?(?:\*?\*?(?:Strict grounding|Refine Citations|Check carefully|Chain of thought|Thinking process|Grounding check)[^\n]*[\s\S]*?(?:\n\n|\Z))",
        re.IGNORECASE,
    )
    prev = None
    while prev != t:
        prev = t
        t = thought_prefix_pattern.sub("", t)
    # 4. Odstranění zpětných apostrofů okolo citací: `[1, s. 286]` -> [1, s. 286]
    t = re.sub(r"`(\[(?:Zdroj\s*)?\d+(?:,\s*s(?:tr)?\.?\s*[^\]]+)?\])`", r"\1", t)
    # 5. Odstranění osiřelých zpětných apostrofů před hranatou závorkou: `[1, s. -> [1, s.
    t = re.sub(r"`(\[(?:Zdroj\s*)?\d+)", r"\1", t)
    return t.strip()


# Moved STRICT_GROUNDED_SYSTEM_PROMPT to prompts.chat


async def stream_grounded_chat(
    project_id: str,
    user_message: str,
    model: str = "gemini-3.6-flash",
    custom_system_prompt: str = "",
    thread_id: str | None = None,
) -> AsyncGenerator[str, None]:
    """Generuje streamovanou SSE odpověď asistenta ukotvenou v materiálech projektu."""
    safe_proj = sanitize_project_name(project_id)
    ai = get_ai_client()

    # 0. Zajištění platného vlákna (thread_id)
    if not thread_id:
        new_thread = create_thread(safe_proj, title=user_message.strip()[:60])
        thread_id = new_thread["id"]
    else:
        existing = get_thread(thread_id)
        if not existing:
            create_thread(safe_proj, title=user_message.strip()[:60], thread_id=thread_id)

    # 1. RAG vyhledání kontextu
    context_text, sources = await retrieve_chat_context(safe_proj, user_message, n_results=15)

    # Odešleme událost se nalezenými zdroji
    sources_payload = {
        "type": "sources",
        "project": safe_proj,
        "thread_id": thread_id,
        "sources": sources,
    }
    yield f"event: sources\ndata: {json.dumps(sources_payload, ensure_ascii=False)}\n\n"

    # 2. Načtení předchozí historie konverzace v rámci tohoto vlákna (posledních 8 zpráv pro kontext)
    past_messages = get_thread_messages(thread_id, limit=8)

    # 3. Příprava systémové instrukce a promptu
    base_sys = custom_system_prompt.strip() if custom_system_prompt else STRICT_GROUNDED_SYSTEM_PROMPT
    system_instruction = base_sys.replace("{PROJECT}", safe_proj)
    active_lang = get_current_language()
    lang_directive = get_language_directive(active_lang)
    if lang_directive and lang_directive not in system_instruction:
        system_instruction = (system_instruction + lang_directive).strip()

    # Sestavení zprávy s kontextem
    if context_text:
        sources_list_text = "\n".join([f"- [{s['id']}] {s['filename']}" for s in sources])
        prompt_content = (
            f"SEZNAM DOSTUPNÝCH PODKLADŮ PRO TENTO DOTAZ:\n{sources_list_text}\n\n"
            f"=== VÝPIS RELEVANTNÍCH ÚRYVKŮ ZE ZDROJŮ PROJEKTU ===\n"
            f"{context_text}\n"
            f"===================================================\n\n"
        )
    elif custom_system_prompt:
        prompt_content = (
            f"POZNÁMKA: V databázi materiálů projektu '{safe_proj}' nebyly nalezeny specifické úryvky pro tento dotaz. "
            "Využij poskytnutý kontext v systémovém promptu a své odborné znalosti k zodpovězení dotazu.\n\n"
        )
    else:
        prompt_content = (
            f"POZNÁMKA: V databázi materiálů projektu '{safe_proj}' nebyly nalezeny žádné textové úryvky "
            "nebo je projekt zatím prázdný. Upozorni uživatele, že nemá nahrané podklady.\n\n"
        )

    # Přidání předchozích zpráv z tohoto vlákna do kontextu
    if past_messages:
        prompt_content += "HISTORIE NEDÁVNÉ KONVERZACE V TOMTO CHATU:\n"
        for m in past_messages[-6:]:
            role_label = "Uživatel" if m["role"] == "user" else "Asistent"
            prompt_content += f"{role_label}: {m['content'][:800]}\n"
        prompt_content += "\n"

    prompt_content += f"AKTUÁLNÍ DOTAZ UŽIVATELE: {user_message}"

    # Uložíme uživatelskou zprávu
    save_message(safe_proj, role="user", content=user_message, thread_id=thread_id)

    full_response_text = ""
    try:
        # Použijeme streamované volání Gemini API s optimalizovanou konfigurací
        def generate_stream():
            config_params: dict[str, Any] = {
                "system_instruction": system_instruction,
                "temperature": 0.3,
                "max_output_tokens": 8192,
            }
            # Pro modely s reasoningem (Gemini 2.5 / 3.8 apod.) vypneme thinking tokeny v konverzačním chatu
            try:
                config_params["thinking_config"] = types.ThinkingConfig(
                    thinking_budget=0,
                    include_thoughts=False,
                )
                cfg = types.GenerateContentConfig(**config_params)
                return ai.models.generate_content_stream(
                    model=model,
                    contents=[prompt_content],
                    config=cfg,
                )
            except Exception:
                # Bezpečný fallback bez thinking_config pro starší modely
                config_params.pop("thinking_config", None)
                cfg = types.GenerateContentConfig(**config_params)
                return ai.models.generate_content_stream(
                    model=model,
                    contents=[prompt_content],
                    config=cfg,
                )

        # Zabalení do worker vlákna s asyncio Queue pro plynulý SSE stream bez blokování event loopu
        token_queue: asyncio.Queue[tuple[str, str | None]] = asyncio.Queue()

        def stream_worker():
            try:
                stream = generate_stream()
                max_tokens_reached = False
                for chunk in stream:
                    # Detekce useknutí na limitu délky tokenů
                    if chunk.candidates:
                        cand = chunk.candidates[0]
                        fr = getattr(cand, "finish_reason", None)
                        if fr and (fr == types.FinishReason.MAX_TOKENS or "MAX_TOKENS" in str(fr)):
                            max_tokens_reached = True

                    # Bezpečný extrakt textu s vynecháním myšlenkových částí (thought == True)
                    text_delta = ""
                    if chunk.candidates and chunk.candidates[0].content and chunk.candidates[0].content.parts:
                        for part in chunk.candidates[0].content.parts:
                            if getattr(part, "thought", False):
                                continue
                            if part.text:
                                text_delta += part.text
                    elif chunk.text:
                        text_delta = chunk.text

                    if text_delta:
                        asyncio.run_coroutine_threadsafe(token_queue.put(("token", text_delta)), loop).result()

                if max_tokens_reached:
                    trunc_notice = "\n\n*(⚠️ Odpověď dosáhla maximální povolené délky textu modelu. Pokud si přejete pokračovat, napište prosím „Pokračuj“.)*"
                    asyncio.run_coroutine_threadsafe(token_queue.put(("token", trunc_notice)), loop).result()

                asyncio.run_coroutine_threadsafe(token_queue.put(("end", None)), loop).result()
            except Exception as e:
                asyncio.run_coroutine_threadsafe(token_queue.put(("error", str(e))), loop).result()

        loop = asyncio.get_running_loop()
        worker_task = asyncio.to_thread(stream_worker)
        asyncio.create_task(worker_task)

        stream_started = False
        initial_buffer = ""

        while True:
            evt_type, payload = await token_queue.get()
            if evt_type == "token" and payload:
                if not stream_started:
                    initial_buffer += payload
                    lower_buf = initial_buffer.lstrip().lower()
                    # Detekce, zda model nezačal vypisovat interní scratchpad nebo thought blok
                    if any(
                        lower_buf.startswith(prefix)
                        for prefix in (
                            "/strict grounding",
                            "/*strict grounding",
                            "*strict grounding",
                            "<thought>",
                            "<think>",
                            "/*",
                            "strict grounding:",
                            "refine citations:",
                        )
                    ):
                        cleaned_buf = clean_leaked_thoughts(initial_buffer)
                        if cleaned_buf:
                            stream_started = True
                            full_response_text += cleaned_buf
                            yield f"event: token\ndata: {json.dumps({'delta': cleaned_buf, 'text': cleaned_buf, 'thread_id': thread_id}, ensure_ascii=False)}\n\n"
                            initial_buffer = ""
                        elif len(initial_buffer) > 3000:
                            stream_started = True
                            full_response_text += initial_buffer
                            yield f"event: token\ndata: {json.dumps({'delta': initial_buffer, 'text': initial_buffer, 'thread_id': thread_id}, ensure_ascii=False)}\n\n"
                            initial_buffer = ""
                    else:
                        stream_started = True
                        full_response_text += initial_buffer
                        yield f"event: token\ndata: {json.dumps({'delta': initial_buffer, 'text': initial_buffer, 'thread_id': thread_id}, ensure_ascii=False)}\n\n"
                        initial_buffer = ""
                else:
                    full_response_text += payload
                    yield f"event: token\ndata: {json.dumps({'delta': payload, 'text': payload, 'thread_id': thread_id}, ensure_ascii=False)}\n\n"
            elif evt_type == "end":
                if initial_buffer:
                    cleaned_buf = clean_leaked_thoughts(initial_buffer)
                    if cleaned_buf:
                        full_response_text += cleaned_buf
                        yield f"event: token\ndata: {json.dumps({'delta': cleaned_buf, 'text': cleaned_buf, 'thread_id': thread_id}, ensure_ascii=False)}\n\n"
                break
            elif evt_type == "error":
                err_msg = payload or "Neznámá chyba při streamování"
                yield f"event: error\ndata: {json.dumps({'error': err_msg, 'thread_id': thread_id}, ensure_ascii=False)}\n\n"
                return

        # 4. Uložení odpovědi asistenta do SQLite (plně vyčištěný text)
        clean_full_text = clean_leaked_thoughts(full_response_text)
        msg_id = save_message(
            safe_proj,
            role="assistant",
            content=clean_full_text,
            sources=sources,
            thread_id=thread_id,
        )

        done_payload = {
            "type": "done",
            "thread_id": thread_id,
            "message_id": msg_id,
            "full_text": clean_full_text,
            "text": clean_full_text,
            "sources": sources,
        }
        yield f"event: done\ndata: {json.dumps(done_payload, ensure_ascii=False)}\n\n"

    except Exception as e:
        err_msg = str(e)
        yield f"event: error\ndata: {json.dumps({'error': err_msg, 'thread_id': thread_id}, ensure_ascii=False)}\n\n"
