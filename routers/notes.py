import json
import os
import re
from typing import Any

from fastapi import APIRouter, Body, HTTPException

from core.config import NOTES_DIR
from core.logger import send_log
from core.security import safe_filename, safe_join
from core.utils import friendly_api_error, sanitize_name
from services.notes_service import (
    internal_generate_notes,
    sanitize_markdown_tables,
)

router = APIRouter()


@router.post("/api/generate-notes")
async def generate_notes_endpoint(payload: dict = Body(...)):
    question = payload.get("question")
    project = payload.get("project")
    custom_prompt = payload.get("prompt", "")
    gemini_model = payload.get("gemini_model", "gemini-3.6-flash")

    if not question or not project:
        raise HTTPException(status_code=400, detail="Chybí znění otázky nebo projekt.")

    try:
        markdown, sources, filename = await internal_generate_notes(
            question=question,
            project=project,
            custom_prompt=custom_prompt,
            gemini_model=gemini_model,
        )
        return {"markdown": markdown, "sources": sources, "filename": filename}
    except Exception as e:
        err_msg = friendly_api_error(e, "Gemini")
        await send_log(f"❌ Selhalo generování studijního textu: {err_msg}")
        raise HTTPException(status_code=500, detail=err_msg)


@router.get("/api/notes")
async def list_notes(project: str = ""):
    try:
        files = [f for f in os.listdir(NOTES_DIR) if f.endswith(".md")]
        if project:
            safe_proj = sanitize_name(project)
            files = [f for f in files if f.startswith(f"{safe_proj}_")]

        files.sort(key=lambda x: os.path.getmtime(os.path.join(NOTES_DIR, x)), reverse=True)
        results = []
        for f in files:
            path = os.path.join(NOTES_DIR, f)
            mtime = os.path.getmtime(path)
            q_title = f.replace(".md", "")
            # Pokus o extrakci názvu otázky z metadat na začátku souboru
            try:
                with open(path, encoding="utf-8") as file_handle:
                    header = file_handle.read(1024)
                    match = re.search(r"<!-- METADATA\s*(\{.*?\})\s*-->", header, re.DOTALL)
                    if match:
                        meta = json.loads(match.group(1))
                        if "question" in meta:
                            q_title = meta["question"]
            except Exception:
                pass

            results.append(
                {
                    "filename": f,
                    "title": q_title,
                    "mtime": mtime,
                    "size": os.path.getsize(path),
                }
            )
        return {"notes": results}
    except Exception as e:
        return {"notes": [], "error": str(e)}


@router.get("/api/notes/{filename}")
async def get_note(filename: str):
    clean_fn = safe_filename(filename)
    file_path = safe_join(NOTES_DIR, clean_fn)
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="Poznámky nenalezeny.")
    with open(file_path, encoding="utf-8") as f:
        content = f.read()
    # Očištění metadata komentáře pro čistý Markdown náhled
    clean_markdown = re.sub(r"^<!-- METADATA.*?-->\s*", "", content, flags=re.DOTALL)
    sources = []
    project = ""
    meta_match = re.search(r"^<!-- METADATA\s*(\{.*?\})\s*-->", content, flags=re.DOTALL)
    if meta_match:
        try:
            meta_json = json.loads(meta_match.group(1))
            sources = meta_json.get("sources", [])
            project = meta_json.get("project", "")
        except Exception:
            pass
    return {"filename": clean_fn, "markdown": clean_markdown, "raw": content, "sources": sources, "project": project}


@router.delete("/api/notes/{filename}")
async def delete_note(filename: str):
    clean_fn = safe_filename(filename)
    file_path = safe_join(NOTES_DIR, clean_fn)
    if os.path.exists(file_path):
        os.remove(file_path)
        await send_log(f"🗑️ Smazány poznámky: {clean_fn}")
        return {"status": "success"}
    raise HTTPException(status_code=404, detail="Soubor nenalezen.")


# --- KARTIČKY (ANKI / QUIZLET) ---
