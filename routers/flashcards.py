import json
import os
from typing import Any
from urllib.parse import quote

from fastapi import APIRouter, Body, HTTPException, Response

from core.config import FLASHCARDS_DIR
from core.logger import send_log
from core.security import safe_filename, safe_join
from core.utils import sanitize_name
from prompts.flashcards import (
    ADVANCED_ANKI_FLASHCARDS_PROMPT,
    DEFAULT_FLASHCARDS_PROMPT,
    FLASHCARDS_PROMPTS,
)
from services.flashcards_service import (
    build_anki_tsv,
    build_quizlet_text,
    internal_generate_flashcards,
    normalize_front,
    resolve_card_source,
)

router = APIRouter()


@router.get("/api/flashcards-prompts")
async def get_flashcards_prompts():
    return {
        "presets": [
            {
                "id": "standard",
                "name": "Standardní medicínské kartičky",
                "description": "Základní klinické kartičky pro internu a medicínské zkoušky (kritéria, léky, diagnostika).",
                "prompt": DEFAULT_FLASHCARDS_PROMPT,
            },
            {
                "id": "advanced",
                "name": "Pokročilé Anki Kartičky",
                "description": "Metodika Anki-konvence (Sorbonne / Collège / Ole): kognitivní odvoditelnost (princip -> fakta), přihrádková nápověda v závorce, Rang A/B, Pourquoi/Piège/Aussi, přehledové karty (dělicí, faux-ami) a rozbalovací česká vrstva (MKN-10).",
                "prompt": ADVANCED_ANKI_FLASHCARDS_PROMPT,
            },
        ]
    }


@router.post("/api/generate-flashcards")
async def generate_flashcards_endpoint(payload: dict = Body(...)):
    question = payload.get("question")
    project = payload.get("project")
    count = int(payload.get("count", 10))
    custom_prompt = payload.get("prompt", "")
    gemini_model = payload.get("gemini_model", "gemini-3.6-flash")
    force_regenerate = bool(payload.get("force_regenerate", False))

    if not question or not project:
        raise HTTPException(status_code=400, detail="Chybí znění otázky nebo projekt.")

    try:
        deck_data, filename = await internal_generate_flashcards(
            question=question,
            project=project,
            count=count,
            custom_prompt=custom_prompt,
            gemini_model=gemini_model,
            force_regenerate=force_regenerate,
        )
        return {**deck_data, "filename": filename}
    except Exception as e:
        await send_log(f"❌ Selhalo generování kartiček: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/flashcards")
async def list_flashcards(project: str = ""):
    try:
        files = [f for f in os.listdir(FLASHCARDS_DIR) if f.endswith(".json")]
        if project:
            safe_proj = sanitize_name(project)
            files = [f for f in files if f.startswith(f"{safe_proj}_")]

        files.sort(key=lambda x: os.path.getmtime(os.path.join(FLASHCARDS_DIR, x)), reverse=True)
        results = []
        for f in files:
            path = os.path.join(FLASHCARDS_DIR, f)
            try:
                with open(path, encoding="utf-8") as file_handle:
                    data = json.load(file_handle)
                    results.append(
                        {
                            "filename": f,
                            "question": data.get("question", f),
                            "count": data.get("count", len(data.get("cards", []))),
                            "mtime": os.path.getmtime(path),
                        }
                    )
            except Exception:
                results.append(
                    {
                        "filename": f,
                        "question": f,
                        "count": 0,
                        "mtime": os.path.getmtime(path),
                    }
                )
        return {"decks": results}
    except Exception as e:
        return {"decks": [], "error": str(e)}


@router.get("/api/flashcards/export-all")
async def export_all_flashcards(project: str = ""):
    try:
        files = [f for f in os.listdir(FLASHCARDS_DIR) if f.endswith(".json")]
        if project:
            safe_proj = sanitize_name(project)
            files = [f for f in files if f.startswith(f"{safe_proj}_")]

        files.sort(key=lambda x: os.path.getmtime(os.path.join(FLASHCARDS_DIR, x)))
        all_cards = []
        decks_info = []
        seen_fronts = set()

        for f in files:
            path = os.path.join(FLASHCARDS_DIR, f)
            try:
                with open(path, encoding="utf-8") as file_handle:
                    data = json.load(file_handle)
                    q_title = data.get("question", f)
                    cards = data.get("cards", [])
                    decks_info.append(
                        {
                            "filename": f,
                            "question": q_title,
                            "count": len(cards),
                        }
                    )
                    for c in cards:
                        front = str(c.get("front", "")).strip()
                        key = normalize_front(front)
                        if key and key in seen_fronts:
                            continue
                        if key:
                            seen_fronts.add(key)

                        card_copy = dict(c)
                        card_copy["question_context"] = q_title
                        card_copy["deck_sources"] = data.get("sources", [])
                        all_cards.append(card_copy)
            except Exception:
                continue

        for idx, c in enumerate(all_cards, 1):
            c["id"] = idx

        anki_lines = [
            "#separator:tab",
            "#html:true",
            f"#tags:interna zkouška {sanitize_name(project)} souhrn",
        ]
        quizlet_lines = []

        safe_proj = sanitize_name(project)
        for c in all_cards:
            resolved = resolve_card_source(c, c.get("deck_sources", []), project)
            front = str(resolved.get("front", "")).replace("\t", " ").replace("\n", "<br>")
            back = str(resolved.get("back", "")).replace("\t", " ").replace("\n", "<br>")

            # Podpora pro Rang v hlavičce
            rang = str(resolved.get("rang", "")).strip()
            if rang and f"[Rang {rang}]" not in front:
                front = f"[Rang {rang}] " + front

            # Podpora pro nápovědu v závorce
            hint = str(resolved.get("hint", "")).strip()
            if hint and hint not in front and f"({hint})" not in front:
                front += f"<br><small style='color:#a8a29e;'><i>({hint})</i></small>"

            # Podpora pro českou vrstvu (cz)
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
            q_ctx = resolved.get("question_context", "")

            extra = []
            if q_ctx:
                extra.append(f"📌 {q_ctx}")

            if src_file:
                page_text = f" (s. {src_page})" if src_page else ""
                hash_page = f"#page={clean_page}" if clean_page else ""
                file_url = f"http://localhost:8000/uploads/{safe_proj}/{src_file}{hash_page}"
                extra.append(
                    f"<a href='{file_url}' target='_blank' style='color:#0284c7; text-decoration: underline;'>📖 {src_file}{page_text}</a>"
                )
            elif src_ref:
                extra.append(f"📖 {src_ref}")

            if extra:
                back += f" <small style='color:gray;'>({' | '.join(extra)})</small>"
            anki_lines.append(f"{front}\t{back}")

            q_front = str(resolved.get("front", "")).replace("\t", " ").replace("\n", " ")
            q_back = str(resolved.get("back", "")).replace("\t", " ").replace("\n", " ")
            if src_file:
                page_text = f", s. {src_page}" if src_page else ""
                q_back += f" [📖 {src_file}{page_text}]"
            elif src_ref:
                q_back += f" [{src_ref}]"
            quizlet_lines.append(f"{q_front}\t{q_back}")

        return {
            "project": project,
            "total_decks": len(decks_info),
            "total_cards": len(all_cards),
            "decks": decks_info,
            "anki_tsv": "\n".join(anki_lines),
            "quizlet_text": "\n".join(quizlet_lines),
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/flashcards/{filename}")
async def get_flashcard_deck(filename: str):
    clean_fn = safe_filename(filename)
    file_path = safe_join(FLASHCARDS_DIR, clean_fn)
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="Sada kartiček nenalezena.")
    with open(file_path, encoding="utf-8") as f:
        data = json.load(f)

    # Automatické dovyřešení zdrojů i pro dříve uložené starší sady
    cards = data.get("cards", [])
    sources = data.get("sources", [])
    project = data.get("project", "")
    for c in cards:
        resolve_card_source(c, sources, project)

    return data


@router.delete("/api/flashcards/{filename}")
async def delete_flashcards(filename: str):
    clean_fn = safe_filename(filename)
    file_path = safe_join(FLASHCARDS_DIR, clean_fn)
    if os.path.exists(file_path):
        os.remove(file_path)
        await send_log(f"🗑️ Smazána sada kartiček: {clean_fn}")
        return {"status": "success"}
    raise HTTPException(status_code=404, detail="Soubor nenalezen.")
