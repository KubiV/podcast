"""
Služba pro generování strukturovaných studijních poznámek z medicínských materiálů.
"""

import json
import os
import re
from typing import Any

from core.config import NOTES_DIR
from core.logger import send_log
from core.security import safe_filename, safe_join
from core.utils import sanitize_name
from prompts.notes import DEFAULT_NOTES_PROMPT
from services.ai_service import call_gemini_with_retries


def sanitize_markdown_tables(text: str) -> str:
    """
    Opraví případné slití řádků tabulek, normalizuje escape sekvence a zajistí
    prázdné řádky okolo tabulek, aby se nikdy neslily do jednoho nečitelného bloku.
    Zároveň odstraní prázdné řádky uvnitř tabulek, které by rozbily jejich vykreslení v Markdownu.
    """
    if not text:
        return ""
    if "\\n" in text and "\n\n" not in text:
        text = text.replace("\\n", "\n")

    text = re.sub(r"(\|\s*)\|\s*([^\s|])", r"\1\n| \2", text)

    while re.search(r"(\|[^\n\r]+\|)\s*\n\s*\n+(\s*\|)", text):
        text = re.sub(r"(\|[^\n\r]+\|)\s*\n\s*\n+(\s*\|)", r"\1\n\2", text)

    text = re.sub(r"([^\n\r|])\r?\n(\s*\|[^\n\r]+\|)", r"\1\n\n\2", text)
    text = re.sub(r"(\|[^\n\r]+\|)\r?\n([^\n\r|\s])", r"\1\n\n\2", text)
    return text


async def internal_generate_notes(
    question: str,
    project: str,
    custom_prompt: str = "",
    gemini_model: str = "gemini-3.6-flash",
    rag_query_fn=None,
) -> tuple[str, list[dict[str, Any]], str]:
    """
    Vygeneruje komplexní studijní text s horními indexy citací a uloží jej do NOTES_DIR.
    """
    if rag_query_fn is None:
        from services.rag_service import query_rag_context_with_sources

        rag_query_fn = query_rag_context_with_sources

    context_text, unique_sources, raw_context = await rag_query_fn(question, project, n_results=40)

    prompt_template = custom_prompt if custom_prompt and custom_prompt.strip() else DEFAULT_NOTES_PROMPT
    final_prompt = prompt_template.replace("{QUESTION}", question)

    sources_summary = "\n".join([f"[{s['id']}] {s['filename']}" for s in unique_sources])

    full_user_content = (
        f"ZPRACOVÁVANÁ ZKOUŠKOVÁ OTÁZKA: {question}\n\n"
        f"SEZNAM PŘIŘAZENÝCH ZDROJŮ PRO CITACE V TÉTO OTÁZCE:\n{sources_summary}\n\n"
        f"=== RELEVANTNÍ ÚRYVKY Z NAHRANÝCH MATERIÁLŮ (s označením stran a segmentů) ===\n"
        f"{context_text}\n"
        f"===============================================================================\n\n"
        f"INSTRUKCE PRO GENEROVÁNÍ:\n"
        f"- Vypracuj vyčerpávající, přehledný a fakticky nabitý studijní text pro medika 5. ročníku před zkouškou z interny.\n"
        f"- Dodrž striktní strukturu H2 nadpisů dle osnovy v systémovém promptu.\n"
        f"- Piš heslovitě s odrážkami, zvýrazňuj tučným písmem klíčové pojmy a léky, klinické zkratky nerozepisuj.\n"
        f"- U diferenciální diagnostiky nebo klasifikací použij přehlednou Markdown tabulku.\n"
        f"- U každého klíčového faktu uveď citaci zdroje formou horního indexu <sup>[1]</sup> nebo [1]."
    )

    await send_log(
        f"📝 Odesílám zadání pro vygenerování studijního textu do {gemini_model} (max 16k tokenů, hloubková syntéza)..."
    )
    notes_markdown = await call_gemini_with_retries(
        model=gemini_model,
        contents=[full_user_content],
        system_instruction=final_prompt,
        temperature=0.25,
        max_output_tokens=16384,
    )

    notes_markdown = sanitize_markdown_tables(notes_markdown)

    safe_title = sanitize_name(question[:40])
    safe_proj = sanitize_name(project)
    notes_filename = f"{safe_proj}_{safe_title}.md"
    file_path = safe_join(NOTES_DIR, notes_filename)

    meta_header = (
        f"<!-- METADATA\n"
        f"{json.dumps({'project': project, 'question': question, 'sources': unique_sources}, ensure_ascii=False)}\n"
        f"-->\n\n"
    )

    with open(file_path, "w", encoding="utf-8") as f:
        f.write(meta_header + notes_markdown)

    await send_log(f"✅ Studijní text úspěšně uložen do souboru {notes_filename}.")
    return notes_markdown, unique_sources, notes_filename
