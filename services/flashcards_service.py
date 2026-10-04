"""
Služba pro generování, správu a export Anki / Quizlet studijních kartiček.
"""

import json
import os
import re
from typing import Any

from core.config import FLASHCARDS_DIR
from core.logger import send_log
from core.security import safe_filename, safe_join
from core.utils import sanitize_name
from prompts.flashcards import (
    ADVANCED_ANKI_FLASHCARDS_PROMPT,
    DEFAULT_FLASHCARDS_PROMPT,
)
from services.ai_service import call_gemini_with_retries, clean_and_parse_json


def normalize_front(text: str) -> str:
    return re.sub(r"[^\w\s]", "", str(text or "")).strip().lower()


def resolve_card_source(
    card: dict[str, Any], sources_list: list[dict[str, Any]] = None, project: str = ""
) -> dict[str, Any]:
    """
    Zajistí, že kartička má doplněné source_file, source_page a čistý odkaz pro zobrazení i Anki export.
    Funguje plně zpětně kompatibilně i pro starší formáty.
    """
    source_file = str(card.get("source_file") or "").strip()
    source_page = str(card.get("source_page") or card.get("page") or "").strip()
    source_ref = str(card.get("source_ref") or "").strip()
    source_quote = str(card.get("source_quote") or "").strip()

    id_to_file: dict[str, str] = {}
    if sources_list:
        for s in sources_list:
            if isinstance(s, dict):
                sid = str(s.get("id", ""))
                fname = str(s.get("filename", ""))
                if sid and fname:
                    id_to_file[sid] = fname

    if not source_file and source_ref:
        m_page = re.search(r"\[(?:Zdroj\s*)?(\d+)(?:,\s*s(?:tr)?\.?\s*([^\]]+))?\]", source_ref, re.IGNORECASE)
        if m_page:
            sid = m_page.group(1)
            if not source_page and m_page.group(2):
                source_page = m_page.group(2).strip()
            if sid in id_to_file:
                source_file = id_to_file[sid]

    clean_page_num = ""
    if source_page:
        m_num = re.search(r"\d+", source_page)
        if m_num:
            clean_page_num = m_num.group(0)

    card["source_file"] = source_file
    card["source_page"] = source_page
    card["clean_page"] = clean_page_num
    card["source_ref"] = source_ref
    card["source_quote"] = source_quote
    return card


def build_anki_tsv(
    cards: list[dict[str, Any]], project: str, question: str, sources_list: list[dict[str, Any]] = None
) -> str:
    lines = [
        "#separator:tab",
        "#html:true",
        f"#tags:interna zkouška {sanitize_name(project)}",
    ]
    safe_proj = sanitize_name(project)
    for c in cards:
        resolved = resolve_card_source(c, sources_list or [], safe_proj)
        front = str(resolved.get("front", "")).replace("\t", " ").replace("\n", "<br>")
        back = str(resolved.get("back", "")).replace("\t", " ").replace("\n", "<br>")

        rang = str(resolved.get("rang", "")).strip()
        if rang and f"[Rang {rang}]" not in front:
            front = f"[Rang {rang}] " + front

        hint = str(resolved.get("hint", "")).strip()
        if hint and hint not in front and f"({hint})" not in front:
            front += f"<br><small style='color:#a8a29e;'><i>({hint})</i></small>"

        cz_data = resolved.get("cz")
        if cz_data and "<details" not in back:
            if isinstance(cz_data, dict):
                cz_q = cz_data.get("q", "")
                cz_a = cz_data.get("a", "")
                cz_pojmy = cz_data.get("pojmy", [])
                pojmy_html = ""
                if cz_pojmy and isinstance(cz_pojmy, list):
                    items = []
                    for p in cz_pojmy:
                        if isinstance(p, (list, tuple)) and len(p) >= 2:
                            items.append(f"• <em>{p[0]}</em>: {p[1]}")
                        elif isinstance(p, dict):
                            term = p.get("term") or p.get("pojem") or ""
                            expl = p.get("expl") or p.get("vyznam") or p.get("popis") or ""
                            items.append(f"• <em>{term}</em>: {expl}")
                        elif isinstance(p, str):
                            items.append(f"• {p}")
                    if items:
                        pojmy_html = f"<div style='margin-top:6px; font-size:0.9em; border-top:1px dashed rgba(255,255,255,0.15); padding-top:4px;'><strong>Pojmy (MKN-10 / Glosář):</strong><br>{'<br>'.join(items)}</div>"

                cz_block = (
                    f"<br><br><details class='cz' style='margin-top:10px; padding:6px 10px; border-left:3px solid #3d7cc9; background:rgba(61,124,201,0.08); font-size:0.92em; border-radius:4px; text-align:left;'>"
                    f"<summary style='cursor:pointer; color:#38bdf8; font-weight:600;'>🇨🇿 Česky — překlad a pojmy</summary>"
                    f"<div style='margin-top:6px;'>"
                    f"<div><strong>Otázka:</strong> {cz_q}</div>"
                    f"<div style='margin-top:4px;'><strong>Odpověď:</strong> {cz_a}</div>"
                    f"{pojmy_html}"
                    f"</div></details>"
                )
                back += cz_block

        src_file = resolved.get("source_file", "")
        src_page = resolved.get("source_page", "")
        src_ref = resolved.get("source_ref", "")
        clean_page = resolved.get("clean_page", "")

        citation_html = ""
        if src_file:
            page_text = f" (s. {src_page})" if src_page else ""
            hash_page = f"#page={clean_page}" if clean_page else ""
            file_url = f"http://localhost:8000/uploads/{safe_proj}/{src_file}{hash_page}"
            citation_html = f"<br><br><small style='color:#0284c7; font-size: 11px;'>📖 <a href='{file_url}' target='_blank' style='color:#0284c7; text-decoration: underline;'>{src_file}{page_text}</a></small>"
        elif src_ref:
            citation_html = f" <small style='color:gray;'>{src_ref}</small>"

        back += citation_html
        lines.append(f"{front}\t{back}")
    return "\n".join(lines)


def build_quizlet_text(cards: list[dict[str, Any]], sources_list: list[dict[str, Any]] = None) -> str:
    lines = []
    for c in cards:
        resolved = resolve_card_source(c, sources_list or [])
        front = str(resolved.get("front", "")).replace("\t", " ").replace("\n", " ")
        back = str(resolved.get("back", "")).replace("\t", " ").replace("\n", " ")
        src_file = resolved.get("source_file", "")
        src_page = resolved.get("source_page", "")
        src_ref = resolved.get("source_ref", "")
        if src_file:
            page_text = f", s. {src_page}" if src_page else ""
            back += f" [📖 {src_file}{page_text}]"
        elif src_ref:
            back += f" {src_ref}"
        lines.append(f"{front}\t{back}")
    return "\n".join(lines)


async def internal_generate_flashcards(
    question: str,
    project: str,
    count: int = 10,
    custom_prompt: str = "",
    gemini_model: str = "gemini-3.6-flash",
    force_regenerate: bool = False,
    rag_query_fn=None,
) -> tuple[dict[str, Any], str]:
    if rag_query_fn is None:
        from services.rag_service import query_rag_context_with_sources

        rag_query_fn = query_rag_context_with_sources

    target_count = max(1, min(int(count), 500))
    safe_title = sanitize_name(question[:40])
    safe_proj = sanitize_name(project)
    flashcards_filename = f"{safe_proj}_{safe_title}.json"
    file_path = safe_join(FLASHCARDS_DIR, flashcards_filename)

    existing_data = None
    if not force_regenerate:
        if os.path.exists(file_path):
            try:
                with open(file_path, encoding="utf-8") as f:
                    existing_data = json.load(f)
            except Exception:
                existing_data = None

        if not existing_data and os.path.exists(FLASHCARDS_DIR):
            try:
                norm_q = question.strip().lower()
                for fname in os.listdir(FLASHCARDS_DIR):
                    if fname.startswith(f"{safe_proj}_") and fname.endswith(".json"):
                        fpath = safe_join(FLASHCARDS_DIR, fname)
                        try:
                            with open(fpath, encoding="utf-8") as f:
                                cand = json.load(f)
                                if str(cand.get("question", "")).strip().lower() == norm_q:
                                    existing_data = cand
                                    file_path = fpath
                                    flashcards_filename = fname
                                    break
                        except Exception:
                            continue
            except Exception:
                pass

    existing_cards = []
    existing_count = 0
    if existing_data and isinstance(existing_data.get("cards"), list):
        existing_cards = existing_data["cards"]
        existing_count = len(existing_cards)

    tolerance = max(3, int(target_count * 0.15))

    if not force_regenerate and existing_count >= (target_count - tolerance):
        await send_log(
            f"⏩ Otázka '{question[:35]}' již má {existing_count} hotových kartiček "
            f"(požadováno: {target_count}). Přeskakuji generování."
        )
        return existing_data, flashcards_filename

    if not force_regenerate and existing_count > 0:
        missing_count = target_count - existing_count
        await send_log(
            f"🔄 Otázka '{question[:35]}' již má {existing_count} kartiček, ale cíl je {target_count}. "
            f"Dogeneruji zbývajících {missing_count} kartiček bez duplicit..."
        )
        all_cards = list(existing_cards)
        seen_fronts = set()
        for c in existing_cards:
            k = normalize_front(c.get("front", ""))
            if k:
                seen_fronts.add(k)
    else:
        all_cards = []
        seen_fronts = set()

    context_text, unique_sources, raw_context = await rag_query_fn(question, project, n_results=25)

    prompt_template = DEFAULT_FLASHCARDS_PROMPT
    if custom_prompt and custom_prompt.strip():
        cp_clean = custom_prompt.strip()
        cp_lower = cp_clean.lower()
        if cp_lower in ["advanced", "advanced_anki", "pokrocile_anki", "pokročilé anki", "pokročilé anki kartičky"]:
            prompt_template = ADVANCED_ANKI_FLASHCARDS_PROMPT
        elif cp_lower in ["standard", "default"]:
            prompt_template = DEFAULT_FLASHCARDS_PROMPT
        else:
            prompt_template = cp_clean
    sources_summary = "\n".join([f"[{s['id']}] {s['filename']}" for s in unique_sources])

    full_user_content = (
        f"ZKOUŠKOVÁ OTÁZKA: {question}\n\n"
        f"SEZNAM PŘIŘAZENÝCH ZDROJŮ PRO CITACE:\n{sources_summary}\n\n"
        f"=== ÚRYVKY Z MATERIÁLŮ ===\n"
        f"{context_text}\n"
        f"=========================="
    )

    remaining_needed = target_count - len(all_cards)

    if len(all_cards) == 0 and remaining_needed <= 35:
        final_prompt = prompt_template.replace("{QUESTION}", question).replace("{COUNT}", str(target_count))
        final_prompt += (
            f"\n\n[STRIKTNÍ POŽADAVEK NA UNIKÁTNOST]: Vytvoř přesně {target_count} zcela unikátních kartiček. "
            "Každá otázka na lícové straně se musí ptát na jiný klinický fakt bez jakýchkoliv duplicit a parafrází."
        )
        await send_log(
            f"🗂️ Generuji {target_count} unikátních Anki/Quizlet kartiček k otázce: '{question}' přes {gemini_model}..."
        )
        raw_response = await call_gemini_with_retries(
            model=gemini_model,
            contents=[full_user_content],
            system_instruction=final_prompt,
            temperature=0.3,
            max_output_tokens=8192,
            response_mime_type="application/json",
        )
        parsed = clean_and_parse_json(raw_response)
        for c in parsed:
            key = normalize_front(c.get("front", ""))
            if key and key not in seen_fronts:
                seen_fronts.add(key)
                all_cards.append(c)
            elif not key:
                all_cards.append(c)

    if len(all_cards) < target_count:
        domains = [
            "Klíčová diagnostická kritéria, klasifikace, skórovací schémata a patognomické znaky",
            "Léčebné algoritmy, léky první volby, farmakoterapie a akutní management",
            "Diferenciální diagnostika, odlišení podobných klinických jednotek a atypické prezentace",
            "Akutní a chronické komplikace, závažné lékové interakce a kontraindikace",
            "Oblíbené chytáky zkoušejících, nejčastější chyby u zkoušky a klinické Red Flags",
            "Etiologie, patofyziologické mechanismy a rizikové faktory",
            "Interpretace laboratorních nálezů, biochemie, EKG a zobrazovacích metod",
            "Prognóza, dlouhodobé sledování, dispenzarizace a prevence",
        ]

        sub_batch_size = 25
        needed = target_count - len(all_cards)
        num_batches = (needed + sub_batch_size - 1) // sub_batch_size
        max_rounds = num_batches + 4
        await send_log(
            f"🗂️ Cíl {target_count} kartiček (zbývá dogenerovat {needed} ks): generuji v tematických sériích bez duplicit..."
        )

        round_idx = 0
        while len(all_cards) < target_count and round_idx < max_rounds:
            remaining = target_count - len(all_cards)
            current_b_count = min(sub_batch_size, remaining)
            domain_focus = domains[round_idx % len(domains)]
            round_idx += 1

            await send_log(
                f"▶️ Série {round_idx} (cíl: +{current_b_count} ks, celkem unikátních: {len(all_cards)}/{target_count}) – oblast: {domain_focus[:45]}..."
            )

            sub_prompt = prompt_template.replace("{QUESTION}", question).replace("{COUNT}", str(current_b_count))
            sub_prompt += f"\n\n[SPECIFICKÉ ZAMĚŘENÍ TÉTO SÉRIE]: Zaměř se specificky a do hloubky na tuto klinickou oblast: {domain_focus}."

            if all_cards:
                prev_sample = [f'- "{c.get("front", "").strip()}"' for c in all_cards[-35:]]
                sub_prompt += (
                    f"\n\n[STRIKTNÍ ZÁKAZ DUPLICIT]: V této sadě již existuje následujících {len(all_cards)} otázek. "
                    f"JE PŘÍSNĚ ZAKÁZÁNO je opakovat nebo se ptát na stejné detaily:\n" + "\n".join(prev_sample)
                )

            try:
                raw_response = await call_gemini_with_retries(
                    model=gemini_model,
                    contents=[full_user_content],
                    system_instruction=sub_prompt,
                    temperature=0.35,
                    max_output_tokens=8192,
                    response_mime_type="application/json",
                )
                batch_cards = clean_and_parse_json(raw_response)
                for c in batch_cards:
                    key = normalize_front(c.get("front", ""))
                    if key and key not in seen_fronts:
                        seen_fronts.add(key)
                        all_cards.append(c)
                        if len(all_cards) >= target_count:
                            break
            except Exception as sub_err:
                await send_log(f"⚠️ Chyba v sérii {round_idx}: {str(sub_err)}. Pokračuji...")

    all_cards = all_cards[:target_count]

    for i, card in enumerate(all_cards):
        card["id"] = i + 1

    if not all_cards:
        raise ValueError("Nepodařilo se vytvořit žádné kartičky. Zkontrolujte spojení nebo opakujte dotaz.")

    combined_sources = (
        list(existing_data.get("sources", []))
        if (existing_data and isinstance(existing_data.get("sources"), list))
        else []
    )
    seen_source_ids = {s.get("id") for s in combined_sources if isinstance(s, dict)}
    for s in unique_sources:
        if isinstance(s, dict) and s.get("id") not in seen_source_ids:
            seen_source_ids.add(s.get("id"))
            combined_sources.append(s)

    active_sources = combined_sources if combined_sources else unique_sources

    for c in all_cards:
        resolve_card_source(c, active_sources, project)

    anki_tsv = build_anki_tsv(all_cards, project, question, sources_list=active_sources)
    quizlet_text = build_quizlet_text(all_cards, sources_list=active_sources)

    payload = {
        "project": project,
        "question": question,
        "count": len(all_cards),
        "sources": active_sources,
        "cards": all_cards,
        "anki_tsv": anki_tsv,
        "quizlet_text": quizlet_text,
    }

    with open(file_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

    if existing_count > 0:
        added = len(all_cards) - existing_count
        await send_log(
            f"✅ Úspěšně dogenerováno {added} nových kartiček. Celkem uloženo {len(all_cards)} kartiček do {flashcards_filename}."
        )
    else:
        await send_log(f"✅ Vytvořeno a uloženo celkem {len(all_cards)} kartiček do {flashcards_filename}.")
    return payload, flashcards_filename
