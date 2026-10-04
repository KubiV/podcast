import csv
import io
import mimetypes
import os
import re
import shutil
from typing import Any
from urllib.parse import quote

import pdfplumber
from fastapi import APIRouter, BackgroundTasks, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response

from core.clients import get_chroma_client
from core.config import UPLOAD_DIR
from core.logger import send_log
from core.security import safe_filename, safe_join
from core.utils import sanitize_name
from services.rag_service import extract_sections_from_file, index_file_to_chroma

router = APIRouter()


@router.get("/api/files")
async def list_files(project: str):
    safe_proj = sanitize_name(project)
    proj_dir = os.path.join(UPLOAD_DIR, safe_proj)
    if not os.path.exists(proj_dir):
        return {"files": []}

    allowed_exts = (".pdf", ".docx", ".pptx", ".txt")
    all_files = os.listdir(proj_dir)
    valid_files = [f for f in all_files if f.lower().endswith(allowed_exts)]
    return {"files": valid_files}


# ZDE JE OPRAVA PRO VÍCE SOUBORŮ NARÁZ:
@router.post("/api/files/upload")
async def upload_files(
    background_tasks: BackgroundTasks, project: str = Form(...), files: list[UploadFile] = File(...)
):
    safe_proj = sanitize_name(project)
    proj_dir = safe_join(UPLOAD_DIR, safe_proj)
    os.makedirs(proj_dir, exist_ok=True)

    allowed_exts = (".pdf", ".docx", ".pptx", ".txt")
    saved_files = []

    for file in files:
        if not file.filename or not file.filename.lower().endswith(allowed_exts):
            await send_log(f"⚠️ Přeskočen soubor {file.filename}: Nepodporovaný formát.")
            continue

        clean_fn = safe_filename(file.filename)
        file_path = safe_join(proj_dir, clean_fn)
        with open(file_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)

        saved_files.append(clean_fn)
        await send_log(f"📥 Soubor {clean_fn} nahrán. Řadím do fronty pro vektorizaci...")
        background_tasks.add_task(index_file_to_chroma, file_path, clean_fn, safe_proj)

    return {"filenames": saved_files}


_preview_cache: dict[str, dict] = {}


@router.delete("/api/files/{filename}")
async def delete_file(filename: str, project: str):
    safe_proj = sanitize_name(project)
    file_path = safe_join(UPLOAD_DIR, safe_proj, safe_filename(filename))
    if os.path.exists(file_path):
        os.remove(file_path)

        # Invalidate preview cache for deleted file
        keys_to_del = [k for k in _preview_cache if k.startswith(f"{safe_proj}:{filename}:")]
        for k in keys_to_del:
            _preview_cache.pop(k, None)

        collection_name = f"proj_{safe_proj}"
        try:
            collection = get_chroma_client().get_collection(name=collection_name)
            collection.delete(where={"source": filename})
        except Exception:
            pass

        try:
            from chat_service import delete_chunks_from_fts

            delete_chunks_from_fts(project_id=safe_proj, source=filename)
        except Exception:
            pass

        await send_log(f"🗑️ Soubor {filename} a jeho vektory byly z projektu smazány.")
        return {"status": "success"}
    raise HTTPException(status_code=404, detail="Soubor nenalezen.")


def get_file_mime_type(filename: str) -> str:
    ext = filename.lower().split(".")[-1]
    mime_map = {
        "pdf": "application/pdf",
        "txt": "text/plain; charset=utf-8",
        "md": "text/markdown; charset=utf-8",
        "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "png": "image/png",
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
        "webp": "image/webp",
    }
    return mime_map.get(ext, "application/octet-stream")


@router.get("/api/files/{project}/{filename}/view")
async def view_project_file(project: str, filename: str):
    """Servíruje nahraný soubor (PDF, TXT apod.) pro přímé zobrazení v prohlížeči (inline disposition)."""
    safe_proj = sanitize_name(project)
    clean_fn = safe_filename(filename)
    file_path = safe_join(UPLOAD_DIR, safe_proj, clean_fn)
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="Soubor nenalezen.")

    media_type = get_file_mime_type(clean_fn)
    return FileResponse(
        file_path, media_type=media_type, headers={"Content-Disposition": f"inline; filename*=UTF-8''{quote(clean_fn)}"}
    )


@router.get("/api/files/{project}/{filename}/preview")
async def preview_project_file(project: str, filename: str):
    """Vrací strukturovaný obsah a metadata souboru pro náhled v rozhraní (podporuje DOCX, PPTX, TXT, PDF)."""
    safe_proj = sanitize_name(project)
    clean_fn = safe_filename(filename)
    file_path = safe_join(UPLOAD_DIR, safe_proj, clean_fn)
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="Soubor nenalezen.")

    file_size = os.path.getsize(file_path)
    file_mtime = os.path.getmtime(file_path)
    cache_key = f"{safe_proj}:{filename}:{file_mtime}:{file_size}"
    if cache_key in _preview_cache:
        return _preview_cache[cache_key]

    ext = filename.lower().split(".")[-1]

    sections = []
    raw_text = ""
    total_pages = 0
    try:
        if ext == "pdf":
            # Bleskově zjistit celkový počet stran přes pypdf (< 0.05 s)
            try:
                import pypdf

                reader = pypdf.PdfReader(file_path)
                total_pages = len(reader.pages)
            except Exception:
                pass

        sections = await extract_sections_from_file(file_path, filename)
        if total_pages <= 0:
            if ext == "pdf":
                try:
                    with pdfplumber.open(file_path) as pdf:
                        total_pages = len(pdf.pages)
                except Exception:
                    total_pages = len(sections)
            elif ext == "pptx":
                try:
                    from pptx import Presentation

                    prs = Presentation(file_path)
                    total_pages = len(prs.slides)
                except Exception:
                    total_pages = len(sections)
            else:
                total_pages = len(sections)

        for sec in sections:
            page_val = str(sec.get("page", ""))
            m = re.search(r"\d+", page_val)
            sec["page_number"] = int(m.group(0)) if m else None

        if ext in ("txt", "md"):
            with open(file_path, encoding="utf-8", errors="replace") as f:
                raw_text = f.read()
    except Exception as e:
        sections = [
            {"text": f"Chyba při extrakci obsahu: {str(e)}", "page": "Chyba", "source": filename, "page_number": None}
        ]
        total_pages = 1

    res = {
        "filename": filename,
        "project": safe_proj,
        "extension": ext,
        "size_bytes": file_size,
        "total_pages": max(total_pages, 1) if (sections or ext == "pdf") else total_pages,
        "sections_count": len(sections),
        "sections": sections,
        "raw_text": raw_text,
    }

    if len(_preview_cache) > 80:
        _preview_cache.clear()
    _preview_cache[cache_key] = res
    return res


@router.post("/api/projects/{project}/reindex")
async def reindex_project_files(project: str, background_tasks: BackgroundTasks):
    """Smaže stávající index v ChromaDB a znovu hloubkově zaindexuje všechny nahrané soubory s novým sémantickým chunkingem a metadaty stran."""
    safe_proj = sanitize_name(project)
    proj_dir = os.path.join(UPLOAD_DIR, safe_proj)
    if not os.path.exists(proj_dir):
        raise HTTPException(status_code=404, detail="Projekt nenalezen.")

    collection_name = f"proj_{safe_proj}"
    try:
        get_chroma_client().delete_collection(name=collection_name)
    except Exception:
        pass

    try:
        from chat_service import delete_chunks_from_fts

        delete_chunks_from_fts(project_id=safe_proj)
    except Exception:
        pass

    allowed_exts = (".pdf", ".docx", ".pptx", ".txt")
    files_to_index = [f for f in os.listdir(proj_dir) if f.lower().endswith(allowed_exts)]

    for fname in files_to_index:
        fpath = os.path.join(proj_dir, fname)
        background_tasks.add_task(index_file_to_chroma, fpath, fname, safe_proj)

    await send_log(f"🔄 Spuštěno hloubkové přerindexování projektu '{safe_proj}' ({len(files_to_index)} souborů).")
    return {"status": "reindexing_started", "project": safe_proj, "files_count": len(files_to_index)}


@router.post("/api/files/upload-csv")
async def upload_csv(file: UploadFile = File(...)):
    if not file.filename.endswith(".csv") and not file.filename.endswith(".txt"):
        raise HTTPException(status_code=400, detail="Podporovány jsou pouze .csv nebo .txt soubory.")

    contents = await file.read()
    decoded = contents.decode("utf-8")
    lines = decoded.splitlines()

    parsed_questions = []
    for line in lines:
        clean = line.strip().replace('"', "").replace("'", "")
        if clean:
            parsed_questions.append(clean)

    await send_log(f"📋 Naimportováno {len(parsed_questions)} otázek ze souboru {file.filename}.")
    return {"questions": parsed_questions}
