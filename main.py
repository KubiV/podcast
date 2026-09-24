import os
import sys
import subprocess
import glob
import shutil
import httpx
import asyncio
import json
import re
import uuid
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, List, Optional, Tuple
import webbrowser
import html as html_lib
from fastapi import FastAPI, HTTPException, Body, UploadFile, File, Form, BackgroundTasks, Request
from fastapi.responses import StreamingResponse, FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from urllib.parse import quote
import pdfplumber
import chromadb
from dotenv import load_dotenv
from google import genai
from google.genai import types
from openai import OpenAI

try:
    from mutagen.mp3 import MP3
except ImportError:
    MP3 = None

try:
    import ffmpeg
except ImportError:
    ffmpeg = None

# --- NOVÉ KNIHOVNY PRO DOCX a PPTX ---
try:
    import docx
except ImportError:
    docx = None

try:
    import pptx
except ImportError:
    pptx = None

load_dotenv()

app = FastAPI()

# Detekce prostředí: Zabalená binárka (PyInstaller) vs Běžný vývoj (Python)
IS_FROZEN = getattr(sys, "frozen", False)
if IS_FROZEN:
    BUNDLE_DIR = sys._MEIPASS
    exe_dir = os.path.dirname(sys.executable)
    portable_data_dir = os.path.join(exe_dir, "data")
    if os.path.exists(portable_data_dir):
        USER_DATA_DIR = portable_data_dir
    else:
        USER_DATA_DIR = os.path.expanduser("~/Documents/AIMedStudio")
else:
    BUNDLE_DIR = os.path.dirname(os.path.abspath(__file__))
    USER_DATA_DIR = BUNDLE_DIR

os.environ["AIMEDSTUDIO_DATA_DIR"] = USER_DATA_DIR

# Pokud je přibalena lokální binárka ffmpeg, přidáme ji na začátek PATH
for b_dir in [BUNDLE_DIR, os.path.join(BUNDLE_DIR, "bin"), os.path.dirname(sys.executable) if IS_FROZEN else ""]:
    if b_dir and os.path.exists(b_dir):
        if (sys.platform == "win32" and os.path.exists(os.path.join(b_dir, "ffmpeg.exe"))) or \
           (sys.platform != "win32" and os.path.exists(os.path.join(b_dir, "ffmpeg"))):
            os.environ["PATH"] = b_dir + os.pathsep + os.environ.get("PATH", "")
            break

STATIC_DIR = os.path.join(BUNDLE_DIR, "static")
UPLOAD_DIR = os.path.join(USER_DATA_DIR, "uploads")
AUDIO_DIR = os.path.join(USER_DATA_DIR, "generated_audio")
NOTES_DIR = os.path.join(USER_DATA_DIR, "generated_notes")
FLASHCARDS_DIR = os.path.join(USER_DATA_DIR, "generated_flashcards")
TESTS_DIR = os.path.join(USER_DATA_DIR, "generated_tests")
DB_DIR = os.path.join(USER_DATA_DIR, "chroma_db")
CONFIG_FILE = os.path.join(USER_DATA_DIR, "user_config.json")

for d in [UPLOAD_DIR, AUDIO_DIR, NOTES_DIR, FLASHCARDS_DIR, TESTS_DIR, DB_DIR, STATIC_DIR]:
    os.makedirs(d, exist_ok=True)

# Správa uživatelské konfigurace (BYOK: Bring Your Own Key)
def load_user_config() -> dict[str, Any]:
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            print(f"⚠️ Chyba při načítání konfigurace {CONFIG_FILE}: {e}")
    return {}

def save_user_config(cfg: dict[str, Any]) -> None:
    os.makedirs(USER_DATA_DIR, exist_ok=True)
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2, ensure_ascii=False)

def get_gemini_api_key() -> str:
    cfg = load_user_config()
    return (cfg.get("gemini_api_key") or os.getenv("GEMINI_API_KEY") or "").strip()

def get_openai_api_key() -> str:
    cfg = load_user_config()
    return (cfg.get("openai_api_key") or os.getenv("OPENAI_API_KEY") or "").strip()

def get_elevenlabs_api_key() -> str:
    cfg = load_user_config()
    return (cfg.get("elevenlabs_api_key") or os.getenv("ELEVENLABS_API_KEY") or "").strip()

def get_gemini_client() -> genai.Client:
    key = get_gemini_api_key()
    if not key:
        raise HTTPException(
            status_code=400,
            detail="Není nastaven Google Gemini API klíč. Přejděte v horní liště do 'Nastavení ⚙️' a vložte svůj API klíč."
        )
    return genai.Client(api_key=key)

def get_openai_client() -> OpenAI:
    key = get_openai_api_key()
    if not key:
        raise HTTPException(
            status_code=400,
            detail="Není nastaven OpenAI API klíč. Přejděte v horní liště do 'Nastavení ⚙️' a zadejte svůj API klíč."
        )
    return OpenAI(api_key=key)

chroma_client = chromadb.PersistentClient(path=DB_DIR)
LOG_HISTORY_LIMIT = 250
LOG_SUBSCRIBER_QUEUE_SIZE = 300
log_history: deque[str] = deque(maxlen=LOG_HISTORY_LIMIT)
log_subscribers: set[asyncio.Queue[tuple[str, dict[str, Any]]]] = set()


@dataclass
class BatchState:
    """Stav jedné běžící dávky pro konkrétní projekt."""

    batch_id: str
    mode: str = "podcast"  # "podcast", "notes", "flashcards"
    cancel_requested: bool = False
    completed_question_indexes: list[int] = field(default_factory=list)


# V jednom projektu smí běžet jen jedna dávka. Díky tomu nelze omylem spustit
# dvě souběžné syntézy, které by přepisovaly stejné výstupní soubory.
active_batches: dict[str, BatchState] = {}


def serialize_sse(event_name: str, payload: dict[str, Any]) -> str:
    return f"event: {event_name}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"


async def publish_event(event_name: str, payload: dict[str, Any]):
    """Rozešle událost všem připojeným konzolím bez blokování zpracování."""
    for subscriber in tuple(log_subscribers):
        if subscriber.full():
            try:
                subscriber.get_nowait()
            except asyncio.QueueEmpty:
                pass
        try:
            subscriber.put_nowait((event_name, payload))
        except asyncio.QueueFull:
            # Ojedinělá plná fronta nesmí zastavit vlastní dávkové zpracování.
            pass


async def send_log(message: str):
    """Jediné místo pro zápis provozních logů: terminál aplikace i webová konzole."""
    clean_message = str(message).replace("\r", " ").replace("\n", " ")
    log_history.append(clean_message)
    print(f"[LOG] {clean_message}", flush=True)
    await publish_event("log", {"message": clean_message})


async def send_batch_event(project: str, event_type: str, batch_id: str, **data: Any):
    await publish_event(
        "batch",
        {
            "project": project,
            "type": event_type,
            "batch_id": batch_id,
            **data,
        },
    )

@app.get("/api/logs")
async def stream_logs():
    async def event_generator():
        subscriber: asyncio.Queue[tuple[str, dict[str, Any]]] = asyncio.Queue(
            maxsize=LOG_SUBSCRIBER_QUEUE_SIZE
        )
        log_subscribers.add(subscriber)
        try:
            # Nově otevřená konzole dostane i krátký kontext před připojením.
            # Kopie brání chybě při souběžném přidání nového logu do deque.
            for log_message in tuple(log_history):
                yield serialize_sse("log", {"message": log_message})

            while True:
                event_name, payload = await subscriber.get()
                yield serialize_sse(event_name, payload)
        finally:
            log_subscribers.discard(subscriber)

    return StreamingResponse(event_generator(), media_type="text/event-stream")

def sanitize_name(name: str) -> str:
    return re.sub(r'[^a-zA-Z0-9_-]', '_', name.strip())

# --- SPRÁVA PROJEKTŮ ---
@app.get("/api/projects")
async def list_projects():
    projects = [d for d in os.listdir(UPLOAD_DIR) if os.path.isdir(os.path.join(UPLOAD_DIR, d))]
    return {"projects": projects}

@app.post("/api/projects")
async def create_project(payload: dict = Body(...)):
    name = payload.get("name")
    if not name:
        raise HTTPException(status_code=400, detail="Název projektu je prázdný.")
    safe_name = sanitize_name(name)
    os.makedirs(os.path.join(UPLOAD_DIR, safe_name), exist_ok=True)
    await send_log(f"📁 Nový projekt vytvořen: {safe_name}")
    return {"project": safe_name}

@app.delete("/api/projects/{project_id}")
async def delete_project(project_id: str):
    """Kompletně smaže projekt včetně všech materiálů, ChromaDB vektorů, SQLite historie i výstupů."""
    safe_proj = sanitize_name(project_id)
    if not safe_proj:
        raise HTTPException(status_code=400, detail="Neplatný název projektu.")
    
    proj_dir = os.path.join(UPLOAD_DIR, safe_proj)
    if not os.path.exists(proj_dir):
        raise HTTPException(status_code=404, detail="Projekt nebyl nalezen.")

    # 1. Smazání složky projektu s materiály a plánovačem
    try:
        shutil.rmtree(proj_dir, ignore_errors=True)
    except Exception as e:
        print(f"⚠️ Chyba při mazání složky {proj_dir}: {e}")

    # 2. Smazání vektorové kolekce ChromaDB
    try:
        chroma_client.delete_collection(name=f"proj_{safe_proj}")
    except Exception:
        pass

    # 3. Smazání SQLite záznamů (FTS index, chat, lekce)
    try:
        from chat_service import delete_project_records
        delete_project_records(safe_proj)
    except Exception as e:
        print(f"⚠️ Chyba při mazání SQLite záznamů pro projekt {safe_proj}: {e}")

    # 4. Smazání vygenerovaných výstupů na disku
    deleted_counts = {"notes": 0, "flashcards": 0, "tests": 0, "audio": 0}
    
    for fname in os.listdir(NOTES_DIR):
        if fname.startswith(f"{safe_proj}_"):
            try:
                os.remove(os.path.join(NOTES_DIR, fname))
                deleted_counts["notes"] += 1
            except Exception:
                pass

    for fname in os.listdir(FLASHCARDS_DIR):
        if fname.startswith(f"{safe_proj}_"):
            try:
                os.remove(os.path.join(FLASHCARDS_DIR, fname))
                deleted_counts["flashcards"] += 1
            except Exception:
                pass

    for fname in os.listdir(TESTS_DIR):
        if fname.startswith(f"{safe_proj}_"):
            try:
                os.remove(os.path.join(TESTS_DIR, fname))
                deleted_counts["tests"] += 1
            except Exception:
                pass

    for fname in os.listdir(AUDIO_DIR):
        if fname.startswith(f"{safe_proj}_"):
            try:
                os.remove(os.path.join(AUDIO_DIR, fname))
                deleted_counts["audio"] += 1
            except Exception:
                pass

    await send_log(f"🗑️ Projekt '{safe_proj}' a veškerá jeho data byla úspěšně smazána.")
    return {
        "status": "deleted",
        "project": safe_proj,
        "deleted_outputs": deleted_counts
    }

@app.post("/api/projects/{project_id}/rename")
async def rename_project(project_id: str, payload: dict = Body(...)):
    """Přejmenuje projekt, jeho složku, ChromaDB kolekci, SQLite vazby i generované soubory."""
    new_name = str(payload.get("new_name", "")).strip()
    if not new_name:
        raise HTTPException(status_code=400, detail="Nový název projektu nesmí být prázdný.")
    
    old_proj = sanitize_name(project_id)
    new_proj = sanitize_name(new_name)

    if not old_proj or not new_proj:
        raise HTTPException(status_code=400, detail="Neplatný název projektu.")
    
    if old_proj == new_proj:
        return {"status": "unchanged", "project": new_proj}

    old_dir = os.path.join(UPLOAD_DIR, old_proj)
    new_dir = os.path.join(UPLOAD_DIR, new_proj)

    if not os.path.exists(old_dir):
        raise HTTPException(status_code=404, detail=f"Původní projekt '{old_proj}' nebyl nalezen.")

    if os.path.exists(new_dir):
        raise HTTPException(status_code=400, detail=f"Projekt s názvem '{new_proj}' již existuje.")

    # 1. Přejmenování složky v uploads/
    os.rename(old_dir, new_dir)

    # 2. Přejmenování v ChromaDB
    try:
        col = chroma_client.get_collection(f"proj_{old_proj}")
        col.modify(name=f"proj_{new_proj}")
    except Exception as e:
        print(f"⚠️ ChromaDB rename collection notice: {e}")

    # 3. Přejmenování v SQLite (chat, lekce, FTS)
    try:
        from chat_service import rename_project_records
        rename_project_records(old_proj, new_proj)
    except Exception as e:
        print(f"⚠️ Chyba při SQLite rename: {e}")

    # 4. Přejmenování v exam_planner.json
    planner_file = os.path.join(new_dir, "exam_planner.json")
    if os.path.exists(planner_file):
        try:
            with open(planner_file, "r", encoding="utf-8") as f:
                pdata = json.load(f)
            if "project" in pdata:
                pdata["project"] = new_proj
            with open(planner_file, "w", encoding="utf-8") as f:
                json.dump(pdata, f, ensure_ascii=False, indent=2)
        except Exception:
            pass

    # 5. Přejmenování generovaných souborů (notes, flashcards, tests, audio)
    for folder, is_test in [
        (NOTES_DIR, False),
        (FLASHCARDS_DIR, False),
        (TESTS_DIR, True),
        (AUDIO_DIR, False)
    ]:
        if not os.path.exists(folder):
            continue
        for fname in os.listdir(folder):
            if fname.startswith(f"{old_proj}_"):
                rest = fname[len(old_proj) + 1:]
                new_fname = f"{new_proj}_{rest}"
                old_fpath = os.path.join(folder, fname)
                new_fpath = os.path.join(folder, new_fname)
                try:
                    if is_test and fname.endswith(".json"):
                        try:
                            with open(old_fpath, "r", encoding="utf-8") as jf:
                                jdata = json.load(jf)
                            jdata["project"] = new_proj
                            jdata["filename"] = new_fname
                            with open(new_fpath, "w", encoding="utf-8") as jf:
                                json.dump(jdata, jf, ensure_ascii=False, indent=2)
                            if old_fpath != new_fpath:
                                os.remove(old_fpath)
                        except Exception:
                            os.rename(old_fpath, new_fpath)
                    else:
                        os.rename(old_fpath, new_fpath)
                except Exception as e:
                    print(f"⚠️ Chyba při přejmenování souboru {fname}: {e}")

    await send_log(f"✏️ Projekt '{old_proj}' byl úspěšně přejmenován na '{new_proj}'.")
    return {
        "status": "renamed",
        "old_project": old_proj,
        "new_project": new_proj
    }

@app.post("/api/projects/{project_id}/clear-data")
async def clear_project_data(project_id: str, payload: dict = Body(...)):
    """Selektivní vyčištění generovaných dat projektu se zachováním nahraných zdrojových podkladů."""
    safe_proj = sanitize_name(project_id)
    if not safe_proj:
        raise HTTPException(status_code=400, detail="Neplatný název projektu.")
    
    proj_dir = os.path.join(UPLOAD_DIR, safe_proj)
    if not os.path.exists(proj_dir):
        raise HTTPException(status_code=404, detail="Projekt nebyl nalezen.")

    clear_chat = payload.get("clear_chat", False)
    clear_notes = payload.get("clear_notes", False)
    clear_flashcards = payload.get("clear_flashcards", False)
    clear_tests = payload.get("clear_tests", False)
    clear_audio = payload.get("clear_audio", False)
    clear_questions = payload.get("clear_questions", False)

    cleared = []

    if clear_chat:
        from chat_service import clear_project_messages
        clear_project_messages(safe_proj)
        cleared.append("chat")

    if clear_notes:
        for f in os.listdir(NOTES_DIR):
            if f.startswith(f"{safe_proj}_"):
                try: os.remove(os.path.join(NOTES_DIR, f))
                except Exception: pass
        cleared.append("notes")

    if clear_flashcards:
        for f in os.listdir(FLASHCARDS_DIR):
            if f.startswith(f"{safe_proj}_"):
                try: os.remove(os.path.join(FLASHCARDS_DIR, f))
                except Exception: pass
        cleared.append("flashcards")

    if clear_tests:
        for f in os.listdir(TESTS_DIR):
            if f.startswith(f"{safe_proj}_"):
                try: os.remove(os.path.join(TESTS_DIR, f))
                except Exception: pass
        cleared.append("tests")

    if clear_audio:
        for f in os.listdir(AUDIO_DIR):
            if f.startswith(f"{safe_proj}_"):
                try: os.remove(os.path.join(AUDIO_DIR, f))
                except Exception: pass
        cleared.append("audio")

    if clear_questions:
        planner_file = os.path.join(proj_dir, PLANNER_FILENAME)
        if os.path.exists(planner_file):
            try:
                with open(planner_file, "r", encoding="utf-8") as f:
                    pdata = json.load(f)
                if isinstance(pdata, dict):
                    pdata["questions"] = []
                    with open(planner_file, "w", encoding="utf-8") as f:
                        json.dump(pdata, f, ensure_ascii=False, indent=2)
            except Exception as e:
                print(f"⚠️ Chyba při mazání otázek v {planner_file}: {e}")
        cleared.append("questions")

    await send_log(f"🧹 Projekt '{safe_proj}': Vyčištěna vybraná data ({', '.join(cleared)}).")
    return {"status": "cleared", "project": safe_proj, "cleared_categories": cleared}

# --- UNIVERZÁLNÍ EXTRAKCE TEXTU SE ZACHOVÁNÍM STRAN ---
async def extract_sections_from_file(file_path: str, filename: str) -> list[dict[str, Any]]:
    """
    Extrahuje strukturovaný text s metadaty (číslo stránky, snímku nebo sekce).
    Vrací seznam dictů: [{"text": str, "source": filename, "page": str}].
    """
    ext = filename.lower().split('.')[-1]
    sections: list[dict[str, Any]] = []

    if ext == "pdf":
        with pdfplumber.open(file_path) as pdf:
            total_pages = len(pdf.pages)
            for idx, page in enumerate(pdf.pages):
                if idx % 10 == 0:
                    await asyncio.sleep(0.01)  # Udržení asynchronicity
                text = page.extract_text()
                if text and text.strip():
                    sections.append({
                        "text": text.strip(),
                        "source": filename,
                        "page": str(idx + 1)
                    })

    elif ext == "docx":
        if docx is None:
            raise ImportError("Chybí knihovna python-docx")
        doc = docx.Document(file_path)
        current_block = []
        current_heading = "Úvod"
        for idx, para in enumerate(doc.paragraphs):
            if idx % 100 == 0:
                await asyncio.sleep(0.01)
            p_text = para.text.strip()
            if not p_text:
                continue
            if para.style and para.style.name.startswith("Heading"):
                if current_block:
                    sections.append({
                        "text": "\n".join(current_block),
                        "source": filename,
                        "page": current_heading
                    })
                    current_block = []
                current_heading = p_text[:40]
            current_block.append(p_text)
        if current_block:
            sections.append({
                "text": "\n".join(current_block),
                "source": filename,
                "page": current_heading
            })

    elif ext == "pptx":
        if pptx is None:
            raise ImportError("Chybí knihovna python-pptx")
        prs = pptx.Presentation(file_path)
        for idx, slide in enumerate(prs.slides):
            if idx % 5 == 0:
                await asyncio.sleep(0.01)
            slide_lines = []
            for shape in slide.shapes:
                if hasattr(shape, "text") and shape.text and shape.text.strip():
                    slide_lines.append(shape.text.strip())
            if slide_lines:
                sections.append({
                    "text": "\n".join(slide_lines),
                    "source": filename,
                    "page": f"Slide {idx + 1}"
                })

    elif ext in ("txt", "md"):
        with open(file_path, "r", encoding="utf-8") as f:
            content = f.read()
        raw_parts = re.split(r'\n(?=#{1,3}\s+|\n---+\n)', content)
        page_counter = 1
        for part in raw_parts:
            part_clean = part.strip()
            if part_clean:
                sections.append({
                    "text": part_clean,
                    "source": filename,
                    "page": str(page_counter)
                })
                page_counter += 1
    else:
        raise ValueError(f"Nepodporovaný formát: {ext}")

    return sections

async def extract_text_from_file(file_path: str, filename: str) -> str:
    """Zpětně kompatibilní agregovaná extrakce celého textu dokumentu."""
    sections = await extract_sections_from_file(file_path, filename)
    return "\n\n".join(s["text"] for s in sections)

# --- PRÁCE S MATERIÁLY (POKROČILÝ RAG & CHUNKING) ---

def sanitize_markdown_tables(text: str) -> str:
    """
    Opraví případné slití řádků tabulek, normalizuje escape sekvence a zajistí
    prázdné řádky okolo tabulek, aby se nikdy neslily do jednoho nečitelného bloku.
    Zároveň odstraní prázdné řádky uvnitř tabulek, které by rozbily jejich vykreslení v Markdownu.
    """
    if not text:
        return ""
    # 1. Normalizace surového \\n na skutečné nové řádky, pokud došlo k dvojitému escapování
    if "\\n" in text and "\n\n" not in text:
        text = text.replace("\\n", "\n")

    # 2. Oprava slitých řádků tabulky na jednom řádku: "| buňka | | další |" -> "| buňka |\n| další |"
    text = re.sub(r'(\|\s*)\|\s*([^\s|])', r'\1\n| \2', text)

    # 3. Odstranění prázdných řádků MEZI řádky tabulky (řádky začínající a končící |)
    while re.search(r'(\|[^\n\r]+\|)\s*\n\s*\n+(\s*\|)', text):
        text = re.sub(r'(\|[^\n\r]+\|)\s*\n\s*\n+(\s*\|)', r'\1\n\2', text)

    # 4. Zajistit prázdný řádek před Markdown tabulkou, pokud bezprostředně předchází běžný text (nikoliv řádek tabulky!)
    text = re.sub(r'([^\n\r|])\r?\n(\s*\|[^\n\r]+\|)', r'\1\n\n\2', text)

    # 5. Zajistit prázdný řádek za Markdown tabulkou (následující řádek nesmí být řádek tabulky)
    text = re.sub(r'(\|[^\n\r]+\|)\r?\n([^\n\r|\s])', r'\1\n\n\2', text)
    return text

def chunk_sections_with_metadata(
    sections: list[dict[str, Any]],
    chunk_size: int = 7000,
    overlap: int = 1000
) -> list[dict[str, Any]]:
    """
    Sémantický token-aware chunking (cca 1500–2200 tokenů = 6000–8000 znaků).
    Sdružuje sekce, zachovává přesná čísla stran / slidy a dělí výhradně na
    přirozených hranicích odstavců a vět, nikoliv uprostřed slov či tabulek.
    """
    chunks: list[dict[str, Any]] = []
    current_text = ""
    current_source = ""
    start_page = None
    end_page = None

    def flush_chunk(text_to_save: str, src: str, p_start: Any, p_end: Any):
        clean_t = text_to_save.strip()
        if not clean_t:
            return
        page_label = str(p_start) if p_start == p_end or not p_end else f"{p_start}–{p_end}"
        chunks.append({
            "document": clean_t,
            "source": src,
            "page": page_label,
        })

    for sec in sections:
        sec_text = sec["text"]
        source = sec["source"]
        page = sec.get("page", "1")

        if not current_text:
            current_text = sec_text
            current_source = source
            start_page = page
            end_page = page
            continue

        if len(current_text) + len(sec_text) + 2 <= chunk_size:
            current_text += "\n\n" + sec_text
            end_page = page
        else:
            flush_chunk(current_text, current_source, start_page, end_page)

            # Inteligentní překryv (overlap) na hranici odstavce nebo věty
            overlap_text = ""
            if len(current_text) > overlap:
                overlap_start = len(current_text) - overlap
                split_idx = current_text.find("\n\n", overlap_start)
                if split_idx == -1:
                    split_idx = current_text.find(". ", overlap_start)
                    if split_idx != -1:
                        split_idx += 2
                if split_idx == -1:
                    split_idx = overlap_start
                overlap_text = current_text[split_idx:].strip()

            if overlap_text:
                current_text = overlap_text + "\n\n" + sec_text
                start_page = end_page
                end_page = page
            else:
                current_text = sec_text
                start_page = page
                end_page = page

    if current_text.strip():
        flush_chunk(current_text, current_source, start_page, end_page)

    return chunks

def chunk_text(text: str, chunk_size: int = 6500, overlap: int = 1000) -> list:
    """Zpětně kompatibilní funkce chunkingu pro čistý text se sémantickým dělením."""
    if not text:
        return []
    chunks = []
    start = 0
    text_len = len(text)
    while start < text_len:
        end = min(start + chunk_size, text_len)
        if end < text_len:
            cut = text.rfind("\n\n", start + overlap, end)
            if cut == -1:
                cut = text.rfind(". ", start + overlap, end)
                if cut != -1:
                    cut += 2
            if cut != -1 and cut > start:
                end = cut
        clean_chunk = text[start:end].strip()
        if clean_chunk:
            chunks.append(clean_chunk)
        if end == text_len:
            break
        start = max(end - overlap, start + 1)
    return chunks

async def index_file_to_chroma(file_path: str, filename: str, project_name: str):
    await send_log(f"📖 Extraktuji text z dokumentu s analýzou stran: {filename} ({project_name})...")
    try:
        sections = await extract_sections_from_file(file_path, filename)

        if not sections:
            await send_log(f"⚠️ Dokument {filename} neobsahuje žádný strojově čitelný text.")
            return

        chunks = chunk_sections_with_metadata(sections)
        collection_name = f"proj_{sanitize_name(project_name)}"
        collection = chroma_client.get_or_create_collection(name=collection_name)

        docs = [c["document"] for c in chunks]
        ids = [f"{filename}_chunk_{i}" for i in range(len(chunks))]
        metadatas = [
            {
                "source": c["source"],
                "page": str(c.get("page", "1")),
                "chunk_index": i
            }
            for i, c in enumerate(chunks)
        ]

        collection.add(documents=docs, metadatas=metadatas, ids=ids)
        try:
            from chat_service import index_chunks_to_fts
            fts_chunks = [
                {
                    "id": ids[i],
                    "document": docs[i],
                    "source": metadatas[i]["source"],
                    "page": metadatas[i]["page"],
                }
                for i in range(len(chunks))
            ]
            index_chunks_to_fts(safe_proj, fts_chunks)
        except Exception as e:
            print(f"[main] FTS indexing warning: {e}")
        await send_log(f"✅ Dokument {filename} úspěšně zpracován ({len(chunks)} sémantických chunků s metadaty stran uloženo).")
    except Exception as e:
        await send_log(f"❌ Selhalo indexování souboru {filename}: {str(e)}")

@app.get("/api/files")
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
@app.post("/api/files/upload")
async def upload_files(background_tasks: BackgroundTasks, project: str = Form(...), files: List[UploadFile] = File(...)):
    safe_proj = sanitize_name(project)
    proj_dir = os.path.join(UPLOAD_DIR, safe_proj)
    os.makedirs(proj_dir, exist_ok=True)
    
    allowed_exts = (".pdf", ".docx", ".pptx", ".txt")
    saved_files = []

    for file in files:
        if not file.filename.lower().endswith(allowed_exts):
            await send_log(f"⚠️ Přeskočen soubor {file.filename}: Nepodporovaný formát.")
            continue
            
        file_path = os.path.join(proj_dir, file.filename)
        with open(file_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)
            
        saved_files.append(file.filename)
        await send_log(f"📥 Soubor {file.filename} nahrán. Řadím do fronty pro vektorizaci...")
        background_tasks.add_task(index_file_to_chroma, file_path, file.filename, safe_proj)
        
    return {"filenames": saved_files}

@app.delete("/api/files/{filename}")
async def delete_file(filename: str, project: str):
    safe_proj = sanitize_name(project)
    file_path = os.path.join(UPLOAD_DIR, safe_proj, filename)
    if os.path.exists(file_path):
        os.remove(file_path)
        
        collection_name = f"proj_{safe_proj}"
        try:
            collection = chroma_client.get_collection(name=collection_name)
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
    ext = filename.lower().split('.')[-1]
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

@app.get("/api/files/{project}/{filename}/view")
async def view_project_file(project: str, filename: str):
    """Servíruje nahraný soubor (PDF, TXT apod.) pro přímé zobrazení v prohlížeči (inline disposition)."""
    safe_proj = sanitize_name(project)
    file_path = os.path.join(UPLOAD_DIR, safe_proj, filename)
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="Soubor nenalezen.")

    media_type = get_file_mime_type(filename)
    return FileResponse(
        file_path,
        media_type=media_type,
        headers={"Content-Disposition": f"inline; filename*=UTF-8''{quote(filename)}"}
    )

@app.get("/api/files/{project}/{filename}/preview")
async def preview_project_file(project: str, filename: str):
    """Vrací strukturovaný obsah a metadata souboru pro náhled v rozhraní (podporuje DOCX, PPTX, TXT, PDF)."""
    safe_proj = sanitize_name(project)
    file_path = os.path.join(UPLOAD_DIR, safe_proj, filename)
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="Soubor nenalezen.")

    file_size = os.path.getsize(file_path)
    ext = filename.lower().split('.')[-1]
    
    sections = []
    raw_text = ""
    try:
        sections = await extract_sections_from_file(file_path, filename)
        if ext in ("txt", "md"):
            with open(file_path, "r", encoding="utf-8", errors="replace") as f:
                raw_text = f.read()
    except Exception as e:
        sections = [{"text": f"Chyba při extrakci obsahu: {str(e)}", "page": "Chyba", "source": filename}]

    return {
        "filename": filename,
        "project": safe_proj,
        "extension": ext,
        "size_bytes": file_size,
        "sections_count": len(sections),
        "sections": sections,
        "raw_text": raw_text
    }


@app.post("/api/projects/{project}/reindex")
async def reindex_project_files(project: str, background_tasks: BackgroundTasks):
    """Smaže stávající index v ChromaDB a znovu hloubkově zaindexuje všechny nahrané soubory s novým sémantickým chunkingem a metadaty stran."""
    safe_proj = sanitize_name(project)
    proj_dir = os.path.join(UPLOAD_DIR, safe_proj)
    if not os.path.exists(proj_dir):
        raise HTTPException(status_code=404, detail="Projekt nenalezen.")

    collection_name = f"proj_{safe_proj}"
    try:
        chroma_client.delete_collection(name=collection_name)
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

@app.post("/api/files/upload-csv")
async def upload_csv(file: UploadFile = File(...)):
    if not file.filename.endswith(".csv") and not file.filename.endswith(".txt"):
        raise HTTPException(status_code=400, detail="Podporovány jsou pouze .csv nebo .txt soubory.")
    
    contents = await file.read()
    decoded = contents.decode("utf-8")
    lines = decoded.splitlines()
    
    parsed_questions = []
    for line in lines:
        clean = line.strip().replace('"', '').replace("'", "")
        if clean:
            parsed_questions.append(clean)
            
    await send_log(f"📋 Naimportováno {len(parsed_questions)} otázek ze souboru {file.filename}.")
    return {"questions": parsed_questions}

# --- PRŮZKUMNÍK SOUBORŮ ---
@app.get("/api/outputs")
async def list_outputs(project: str = ""):
    try:
        files = [f for f in os.listdir(AUDIO_DIR) if f.endswith(('.mp3', '.mp4', '.srt'))]
        if project:
            safe_proj = sanitize_name(project)
            files = [f for f in files if f.startswith(f"{safe_proj}_")]
            
        files.sort(key=lambda x: os.path.getmtime(os.path.join(AUDIO_DIR, x)), reverse=True)
        return {"files": files}
    except Exception as e:
        return {"files": [], "error": str(e)}

@app.delete("/api/outputs/{filename}")
async def delete_output(filename: str):
    file_path = os.path.join(AUDIO_DIR, filename)
    if os.path.exists(file_path):
        os.remove(file_path)
        await send_log(f"🗑️ Vymazán soubor média: {filename}")
        return {"status": "success"}
    raise HTTPException(status_code=404, detail="Soubor nenalezen.")

# --- ZPRACOVÁNÍ AI ---
def enrich_prompt_for_tts(base_prompt: str, provider: str) -> str:
    tts_instructions = ""
    if provider == "elevenlabs":
        tts_instructions = (
            "\n\n[TTS INSTRUKCE PRO ELEVENLABS]: Cílový syntetizátor je vysoce expresivní. "
            "Piš text tak, aby podporoval dynamickou intonaci. Můžeš používat tři tečky (...) "
            "pro dramatické pauzy nebo zamyšlení. Klad důraz na přirozený dechový rytmus mluvčího."
        )
    elif provider == "openai":
        tts_instructions = (
            "\n\n[TTS INSTRUKCE PRO OPENAI]: Cílový syntetizátor je OpenAI TTS. "
            "Tento model potřebuje jasnou interpunkci k formování intonace. "
            "Pro zdůraznění pointy používej kratší úderné věty. Dbej na jasně oddělená souvětí, "
            "aby modulace hlasu nezněla monotónně."
        )
    return base_prompt + tts_instructions


def friendly_api_error(error: Exception, provider: str) -> str:
    """Převede časté chyby vzdálených API na stručnou a použitelnou zprávu."""
    raw_error = str(error)
    normalized_error = raw_error.lower()

    if "denied access" in normalized_error or "permission_denied" in normalized_error or "403" in normalized_error:
        return (
            f"{provider}: přístup byl zamítnut (403 PERMISSION_DENIED). "
            "Google zablokoval přístup pro tento projekt (časté u free tier projektů). "
            "Řešení: Vytvořte nový API klíč v novém projektu na https://aistudio.google.com/app/apikey a uložte jej do .env."
        )
    if "404" in normalized_error or "not_found" in normalized_error:
        return (
            f"{provider}: model nebyl nalezen (404 NOT_FOUND). "
            "Původní model (např. gemini-2.5-flash) již není dostupný pro nové uživatele. "
            "Doporučujeme použít výchozí gemini-3.6-flash nebo gemini-flash-latest."
        )
    if "insufficient_quota" in normalized_error or "billing" in normalized_error:
        return (
            f"{provider}: vyčerpána dostupná kvóta nebo kredit. "
            "Zkontrolujte tarif a fakturaci, potom lze dávku spustit znovu."
        )
    if "invalid_api_key" in normalized_error or "api key" in normalized_error:
        return f"{provider}: neplatný nebo chybějící API klíč. Zkontrolujte soubor .env."
    if "429" in normalized_error or "resource exhausted" in normalized_error:
        return f"{provider}: limit požadavků je dočasně vyčerpán. Zkuste dávku spustit znovu za chvíli."
    if "503" in normalized_error or "unavailable" in normalized_error or "overloaded" in normalized_error:
        return f"{provider}: služba je dočasně nedostupná nebo přetížená. Zkuste to prosím za pár minut."
    if "timeout" in normalized_error or "timed out" in normalized_error:
        return f"{provider}: vypršel časový limit spojení. Zkuste dávku spustit znovu."
    return raw_error


def is_terminal_auth_error(error: Exception) -> bool:
    """Zjistí, zda se jedná o fatální chybu autorizace (403, zablokovaný projekt, neplatný API klíč)."""
    normalized = str(error).lower()
    return any(marker in normalized for marker in ("denied access", "permission_denied", "403", "invalid_api_key"))


def extract_gemini_error_detail(error: Exception) -> str:
    """Extrahuje stručný a přesný detail o chybě z Gemini API pro diagnostiku."""
    raw = str(error)
    normalized = raw.lower()

    code = ""
    if "403" in raw or "permission_denied" in normalized:
        code = "HTTP 403 (Přístup zamítnut / Projekt nepovolen)"
    elif "404" in raw or "not_found" in normalized:
        code = "HTTP 404 (Model nenalezen nebo již není podporován)"
    elif "429" in raw or "resource_exhausted" in normalized:
        code = "HTTP 429 (Vyčerpán limit požadavků / RPM / TPM)"
    elif "503" in raw or "unavailable" in normalized or "overloaded" in normalized:
        code = "HTTP 503 (Model Googlu je přetížený)"
    elif "504" in raw or "timeout" in normalized:
        code = "HTTP 504 / Timeout"
    elif "500" in raw:
        code = "HTTP 500 (Interní chyba serveru Google)"
    elif "connecterror" in normalized or "nodename nor servname" in normalized or "failed to resolve" in normalized:
        code = "Chyba sítě (Nelze navázat spojení se servery Google)"

    # Zkusit vytáhnout specifickou hlášku z JSON odpovědi nebo textu
    msg_match = re.search(r"['\"]message['\"]:\s*['\"]([^'\"]+)['\"]", raw)
    detail = ""
    if msg_match:
        detail = msg_match.group(1).strip()
    elif "the model is overloaded" in normalized:
        detail = "The model is overloaded. Please try again later."
    elif "quota exceeded" in normalized:
        quota_match = re.search(r"(quota exceeded[^\.\n]+)", raw, re.IGNORECASE)
        if quota_match:
            detail = quota_match.group(1).strip()

    if code and detail:
        return f"{code}: {detail}"
    if code:
        return code
    if detail:
        return detail

    clean_raw = " ".join(raw.split())
    return clean_raw[:120] + "..." if len(clean_raw) > 120 else clean_raw


def is_retryable_gemini_error(error: Exception) -> bool:
    normalized_error = str(error).lower()
    return any(
        marker in normalized_error
        for marker in (
            "503",
            "unavailable",
            "overloaded",
            "429",
            "resource exhausted",
            "resource_exhausted",
            "quota",
            "timeout",
            "timed out",
            "504",
            "500",
            "internal server error",
            "connecterror",
            "connection reset",
            "remote disconnected",
            "deadline exceeded",
        )
    )

async def call_gemini_with_retries(
    model: str,
    contents: list,
    system_instruction: str = "",
    temperature: float = 0.7,
    max_output_tokens: int = 8192,
    response_mime_type: str = "",
) -> str:
    # Pro dlouhé noční běhy a špičky Googlu: 5 pokusů s progresivním čekáním
    wait_intervals = [10, 20, 35, 60]
    max_retries = len(wait_intervals) + 1

    for attempt in range(max_retries):
        try:
            config_args = {"temperature": temperature, "max_output_tokens": max_output_tokens}
            if system_instruction:
                config_args["system_instruction"] = system_instruction
            if response_mime_type:
                config_args["response_mime_type"] = response_mime_type

            client = get_gemini_client()
            response = await asyncio.to_thread(
                client.models.generate_content,
                model=model,
                contents=contents,
                config=types.GenerateContentConfig(**config_args),
            )
            return response.text or ""
        except Exception as e:
            if is_retryable_gemini_error(e):
                err_detail = extract_gemini_error_detail(e)
                if attempt < max_retries - 1:
                    wait_time = wait_intervals[attempt]
                    await send_log(f"⚠️ Gemini API [{err_detail}] (pokus {attempt + 1}/{max_retries}). Čekám {wait_time} s...")
                    await asyncio.sleep(wait_time)
                else:
                    raise ValueError(f"{friendly_api_error(e, 'Gemini')} (Detail: {err_detail})") from e
            else:
                raise

def decompose_question_to_subqueries(question: str) -> list[str]:
    """
    Rozloží kombinovanou zkouškovou otázku (např. 'Lístek 1: a) Astma bronchiale, b) Lymfomy')
    na jednotlivá dílčí témata, aby RAG našel dostatek materiálu pro všechny části zkouškového lístku.
    """
    clean_q = question.strip()
    parts = re.split(r'(?:^|\s+)(?:[a-zA-Z0-9]\)|\([a-zA-Z0-9]\))\s*', clean_q)
    sub_queries = []
    for p in parts:
        p_clean = p.strip(" :;,.-")
        if re.match(r'^(?:Lístek|Otázka|Téma|Ot\.?)\s*\d+$', p_clean, re.IGNORECASE):
            continue
        if len(p_clean) >= 3:
            sub_queries.append(p_clean)

    if not sub_queries and (";" in clean_q or "\n" in clean_q):
        for p in re.split(r'[\n;]+', clean_q):
            p_clean = p.strip(" :;,.-")
            if len(p_clean) >= 3 and not re.match(r'^(?:Lístek|Otázka)\s*\d+$', p_clean, re.IGNORECASE):
                sub_queries.append(p_clean)

    queries = [clean_q]
    for sq in sub_queries:
        if sq.lower() not in [q.lower() for q in queries]:
            queries.append(sq)
    return queries

async def query_rag_context_with_sources(question: str, project: str, n_results: int = 40) -> tuple[str, list[dict[str, Any]], str]:
    safe_proj = sanitize_name(project)
    await send_log(f"🔍 Hybridní RAG: Prohledávám materiály pro téma: '{question[:50]}...'")
    from chat_service import retrieve_chat_context

    sub_queries = decompose_question_to_subqueries(question)
    query_to_use = " ".join(sub_queries) if sub_queries else question

    context_text, unique_sources, raw_context = await retrieve_chat_context(
        project_id=safe_proj,
        query=query_to_use,
        n_results=n_results,
        return_raw=True,
    )

    if not raw_context.strip():
        raise ValueError("V materiálech nebyly nalezeny žádné podklady k této otázce.")

    return context_text, unique_sources, raw_context


async def internal_generate_script(question: str, custom_prompt: str, provider: str, project: str, gemini_model: str):
    final_prompt = enrich_prompt_for_tts(custom_prompt, provider)
    context_text, unique_sources, raw_context = await query_rag_context_with_sources(question, project, n_results=30)

    ukazka_textu = raw_context[:150].replace('\n', ' ')
    await send_log(f"📄 NALEZENÝ TEXT (ukázka): {ukazka_textu}...")

    full_user_content = f"ZPRACOVÁVANÁ ZKOUŠKOVÁ OTÁZKA: {question}\n\n=== RELEVANTNÍ VÝTAŽEK ZE SKRIPT ===\n{raw_context}\n=================================="
    await send_log(f"🤖 Kontext nalezen. Odesílám zadání scénáře do {gemini_model} API...")

    script = await call_gemini_with_retries(
        model=gemini_model,
        contents=[full_user_content],
        system_instruction=final_prompt,
        temperature=0.7,
    )
    return script, raw_context

DEFAULT_NOTES_PROMPT = r"""Jsi šéfredaktor postgraduální akademické učebnice vnitřního lékařství a přísný zkoušející u státních rigorózních a atestačních zkoušek z interny (úroveň Klener, Češka, Harrison's Principles of Internal Medicine).
Tvým úkolem je na základě poskytnutých studijních materiálů vytvořit vyčerpávající, vysoce strukturovaný a maximálně fakticky nabitý studijní text k této zkouškové otázce: {QUESTION}.

CÍL: Výstup musí dosahovat absolutní odborné hloubky a faktické spolehlivosti (standard Google NotebookLM a rigorózní atestační přípravy).

ZÁVAZNÁ PRAVIDLA PRO ZPRACOVÁNÍ:

1. EXHAUSTIVNÍ KLINICKÁ A LABORATORNÍ HLOUBKA:
   - NIKDY nezjednodušuj, nezkracuj ani nepoužívej obecné fráze na úkor klinického, patofyziologického a farmakologického detailu.
   - Vždy uváděj KONKRÉTNÍ diagnostická kritéria s přesnými mezními čísly a jednotkami:
     * Spirometrie a BDT/BPT: obstrukce ($FEV_1/FVC < 0{,}70$ resp. pod LLN), Bronchodilatační test (BDT: nárůst $FEV_1 \ge 12\ \% \land \ge 200\text{ ml}$), Bronchoprovokační test (BPT: metacholin $PC_{20} \le 8\text{ mg/ml}$ s poklesem $FEV_1 \ge 20\ \%$), variabilita PEF ($> 10\ \%$ u dospělých).
     * FeNO prahové hodnoty: $< 25\text{ ppb}$ (norma / eozinofilní zánět nepravděpodobný), $25–50\text{ ppb}$ (šedá zóna), $> 50\text{ ppb}$ (aktivní eozinofilní zánět, vysoká predikce odpovědi na IKS).
     * Sputová cytologie a specifické markery: eozinofily $> 3\ \%$, Charcotovy-Leydenovy krystaly (krystalizovaná lyzofosfolipáza eozinofilů), Curschmannovy spirály (hlenové odlitky drobných bronchiolů), Creolova tělíska (deskvamovaný epitel), sérový/sputový ECP (eosinofilní kationtový protein).
   - Detailní fenotypizace a endotypizace:
     * T2-high (alergické, pozdní eozinofilní, aspirinem indukované/AERD – Samterova triáda: astma + nosní polypy + intolerance ASA/NSAID) vs T2-low (neutrofilní, kouřením či obezitou asociované, paucigranulocytární).

2. DETAILNÍ LÉKOVÁ SCHÉMATA A FARMAKOTERAPIE:
   - Uveď přesné stupně doporučených postupů (např. GINA 1–5):
     * Striktně rozlišuj Track 1 (preferovaný režim: nízkodávkovaný IKS + formoterol jako úleva i udržovací léčba – MART) a Track 2 (alternativní režim: SABA dle potřeby + pravidelný IKS).
     * Uveď konkrétní generika (budesonid/formoterol, beklometazon/formoterol, flutikason propionát), aplikační formy (DPI, pMDI se spacerem) a dávkování.
     * Přídatná léčba: LAMA (tiotropium Respimat), LTRA (montelukast), p.o. kortikosteroidy (prednison $40–50\text{ mg}$ u těžké exacerbace).
     * Biologická léčba u těžkého refrakterního onemocnění (stupeň 5): anti-IgE (omalizumab), anti-IL-5 (mepolizumab, reslizumab), anti-IL-5R (benralizumab), anti-IL-4R $\\alpha$ (dupilumab), anti-TSLP (tezepelumab) včetně indikačních biomarkerů (IgE, krevní eozinofily, FeNO).
   - Zásadní kontraindikace a letální kombinace:
     * ZÁKAZ monoterapie LABA bez IKS u astmatu (riziko maskování zánětu a náhlé smrti!).
     * Kardioselektivní i neselektivní beta-blokátory u astmatu (kontraindikace).
     * NSAID a ASA u pacientů s AERD.

3. STRUKTURA PRO VÍCEDÍLNÉ OTÁZKY:
   - Pokud otázka obsahuje více témat (např. část A: Astma, část B: Lymfomy), MUSÍŠ vytvořit pro KAŽDÉ onemocnění samostatnou plnohodnotnou část (`# ČÁST A: ...`, `# ČÁST B: ...`) a pro obě dodržet kompletní osnovu níže bez jakéhokoliv ošizení!

4. DIFERENCIÁLNÍ DIAGNOSTIKA V TABULCE (GFM):
   - Diferenciální diagnostiku MUSÍŠ zpracovat formou validní GitHub Flavored Markdown tabulky.
   - Minimálně 5–8 jednotek (např. CHOPN, Asthma cardiale, PE, UACS, cizí těleso, a vzácnější jednotky: EGPA / Churg-Strauss syndrom, ABPA, dysfunkce hlasivkových vazů / VCD).
   - Tabulka MUSÍ mít před sebou i za sebou prázdný řádek a řádky tabulky MUSÍ následovat bezprostředně za sebou (každý řádek začíná a končí `|` s jedním `\n`, NIKDY nevkládej prázdné řádky mezi řádky tabulky). Nikdy neslévej řádky tabulky do jednoho odstavce!

5. GRANULÁRNÍ CITACE PER-FACTUM:
   - U každého konkrétního faktu, čísla, diagnostického prahu, léku a patofyziologického tvrzení uveď bezprostředně referenci na poskytnutý segment ve formátu `[X, s. Y]` (kde X je ID zdroje a Y je číslo strany uvedené v záhlaví úryvku) nebo `[X]` (pokud strana není v záhlaví uvedena).
   - PŘÍSNÝ ZÁKAZ souhrnného citování na konci odstavce či kapitoly. Cituj granulárně přímo u každého jednotlivého faktu!

6. FORMÁTOVÁNÍ MATEMATIKY A CHEMIE (LATEX):
   - Používej standardní KaTeX syntaxi: `$výraz$` pro inline (např. `$FEV_1/FVC < 0{,}70$`, `$\\ge 12\\ \\%$`, `$400\\,\\mu\\text{g}$`) a `$$výraz$$` pro blokové výrazy.

7. POVINNÁ STRUKTURA VÝKLADU (pro každé onemocnění):
## Otvírák: (Jedna suverénní, komplexní definující věta pro zahájení zkoušky, která demonstruje hluboký přehled.)
## Definice a mezinárodní konsenzus:
## Epidemiologie a demografie:
## Etiologie a rizikové faktory: (Exogenní alergeny, infekce, léky, profesní vlivy)
## Patofyziologie a buněčné mechanismy: (Imunitní kaskáda, cytokiny, časná a pozdní fáze, remodelace stěny)
## Fenotypy a endotypy: (T2-high vs T2-low, klinické podtypy)
## Klinický obraz a fyzikální nález: (Triáda, cirkadiánní rytmus, poslechový a poklepový nález)
## Diagnostika: (Spirometrie, BDT, BPT, FeNO, PEF monitoring, laboratorní markery a cytologie sputa, zobrazovací metody)
## Diferenciální diagnostika: (Striktně ve formátu přehledné GFM tabulky s odlišujícími rysy)
## Léčba: (Stupňovité schéma např. GINA 1–5, Track 1 MART vs Track 2 SABA, farmaka, biologická léčba, terapie akutní exacerbace)
## Komplikace a život ohrožující stavy: (Status asthmaticus, remodelace, cor pulmonale)
## Prognóza, dispenzarizace a prevence:
## Chytáky zkoušejících a "Red Flags": (Tichý hrudník, letální chyby v medikaci, záludné dotazy)
## Použité zdroje: (Očíslovaný seznam citovaných souborů s rozsahem stran)

8. ČISTÝ VÝSTUP:
   - Začni přímo nadpisem první úrovně `# {QUESTION}` a pokračuj strukturovaným textem. Žádné úvodní ani závěrečné zdvořilostní řeči."""

async def internal_generate_notes(question: str, project: str, custom_prompt: str = "", gemini_model: str = "gemini-3.6-flash"):
    context_text, unique_sources, raw_context = await query_rag_context_with_sources(question, project, n_results=40)

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
        f"- Vypracuj vyčerpávající a fakticky hluboký studijní text dle zadané osnovy.\n"
        f"- Uveď přesná mezní diagnostická čísla, fenotypizaci, cytologii sputa (krystaly, spirály), schémata GINA 1-5 a kontraindikace.\n"
        f"- Diferenciální diagnostiku zpracuj jako validní kompaktní GFM Markdown tabulku (každý řádek na novém řádku, bez prázdných řádků mezi řádky tabulky).\n"
        f"- U každého jednotlivého faktu uveď granulární citaci [X, s. Y] ze záhlaví úryvků."
    )

    await send_log(f"📝 Odesílám zadání pro vygenerování studijního textu do {gemini_model} (max 16k tokenů, hloubková syntéza)...")
    notes_markdown = await call_gemini_with_retries(
        model=gemini_model,
        contents=[full_user_content],
        system_instruction=final_prompt,
        temperature=0.25,
        max_output_tokens=16384,
    )

    # Ošetření a normalizace formátování tabulek před uložením na disk
    notes_markdown = sanitize_markdown_tables(notes_markdown)

    safe_title = sanitize_name(question[:40])
    safe_proj = sanitize_name(project)
    notes_filename = f"{safe_proj}_{safe_title}.md"
    file_path = os.path.join(NOTES_DIR, notes_filename)

    meta_header = (
        f"<!-- METADATA\n"
        f"{json.dumps({'project': project, 'question': question, 'sources': unique_sources}, ensure_ascii=False)}\n"
        f"-->\n\n"
    )

    with open(file_path, "w", encoding="utf-8") as f:
        f.write(meta_header + notes_markdown)

    await send_log(f"✅ Studijní text úspěšně uložen do souboru {notes_filename}.")
    return notes_markdown, unique_sources, notes_filename

DEFAULT_FLASHCARDS_PROMPT = """Jsi špičkový profesor medicíny a expert na efektivní učení (spaced repetition). Tvým úkolem je na základě přiložených studijních materiálů vytvořit sérii přesně {COUNT} vysoce efektivních studijních kartiček (flashcards) pro Anki a Quizlet k této zkouškové otázce: {QUESTION}.

STRIKTNÍ PRAVIDLA PRO KARTIČKY:
1. CÍLOVÁ SKUPINA: Medik 5. ročníku před zkouškou z interny. Žádné triviální obecnosti. Kartičky musí testovat rozhodující diagnostická kritéria, léky první volby, patognomické nálezy, laboratorní odchylky, skórovací schémata a nebezpečné omyly (Red Flags).
2. FORMÁT KARTIČKY (Front & Back):
   - Líc (front): Přesná, jednoznačně položená klinická otázka, např. "Jaká je triáda příznaků u X?", "Lék 1. volby u těžké exacerbace Y?", "Jaká jsou diagnostická kritéria Z?".
   - Rub (back): Stručná, úderná a přesná odpověď. Používej odrážky, tučné zvýraznění klíčových léků/dávek a běžné klinické zkratky.
3. PŘESNÉ CITACE A ODKAZY NA STRÁNKU (STANDARD NOTEBOOKLM):
   Každá kartička MUSÍ být přesně ozdrojována z přiložených podkladů. V hlavičkách segmentů vidíš formát: '--- [ZDROJ X: soubor.pdf | Strana Y | Segment Z] ---'.
   Ve výstupu do pole "source_file" uveď přesný název souboru (např. 'Klener_Vnitrni_lekarstvi.pdf'), do "source_page" uveď číslo strany (např. '45' nebo '45–47') a do "source_quote" uveď krátkou doslovnou větu/údaj z textu. Do "source_ref" uveď souhrnnou citaci [X, s. Y].
4. DIVERZITA TYPŮ OTÁZEK:
   - Diagnostika & kritéria (např. Wells skóre, CURB-65, kritéria revmatoidní artritidy).
   - Terapie (iniciální management, lék volby, kontraindikace).
   - Diferenciální diagnostika (jak spolehlivě odlišit dvě podobné jednotky).
   - Red Flags a záludnosti zkoušejících.
5. UNIKÁTNOST OTÁZEK: Každá kartička musí mít ZCELA UNIKÁTNÍ otázku (lícovou stranu). Žádná otázka se nesmí opakovat, parafrázovat ani ptát na tutéž informaci. Každá kartička testuje odlišný specifický fakt, diferenciální kritérium, dávkování či komplikaci.
6. JAZYK A ZDROJE: Materiály mohou být v cizím jazyce (např. anglické guidelines). Kartičky formuluj v profesionální české lékařské terminologii. Vycházej z přiložených očíslovaných zdrojů.
7. FORMÁT VÝSTUPU:
   Vrať VÝHRADNĚ platný JSON formát bez jakéhokoliv doplňkového textu, vysvětlování či obalového markdownu (žádné ```json na začátku ani na konci).
   Výstupem musí být JSON pole objektů přesně v této struktuře:
   [
     {
       "id": 1,
       "front": "Otázka na lícové straně",
       "back": "Stručná odpověď s odrážkami či zvýrazněním",
       "source_file": "presny_nazev_souboru.pdf",
       "source_page": "45",
       "source_quote": "Doslovný fragment textu nebo kritérium",
       "source_ref": "[1, s. 45]"
     }
   ]"""

def clean_and_parse_json(raw_text: str) -> list[dict[str, Any]]:
    cleaned = raw_text.strip()
    # Odstranění markdown bloků ```json ... ```
    if "```" in cleaned:
        cleaned = re.sub(r"^```[a-zA-Z]*\s*", "", cleaned)
        cleaned = re.sub(r"\s*```$", "", cleaned)
        cleaned = cleaned.strip()

    # 1. Přímé načtení přes standardní json.loads
    try:
        data = json.loads(cleaned, strict=False)
        if isinstance(data, list) and len(data) > 0:
            return data
        if isinstance(data, dict) and "cards" in data and isinstance(data["cards"], list):
            return data["cards"]
    except Exception:
        pass

    # 2. Regex nalezení pole [ ... ] s odstraněním trailing commas
    match = re.search(r"\[\s*\{.*\}\s*\]", cleaned, re.DOTALL)
    if match:
        try:
            sanitized = re.sub(r",\s*([\]\}])", r"\1", match.group(0))
            data = json.loads(sanitized, strict=False)
            if isinstance(data, list) and len(data) > 0:
                return data
        except Exception:
            pass

    # 3. Záchranný parser: extrakce všech dokončených objektů kartiček i při useknutém výstupu
    cards = []
    card_pattern = re.compile(
        r'\{\s*"(?:id|front)"[\s\S]*?"back"\s*:\s*"(?:[^"\\]|\\.)*"[\s\S]*?\}',
        re.DOTALL
    )
    for m in card_pattern.finditer(cleaned):
        block = m.group(0)
        try:
            block_clean = re.sub(r",\s*\}", "}", block)
            obj = json.loads(block_clean, strict=False)
            if "front" in obj and "back" in obj:
                cards.append(obj)
        except Exception:
            f_match = re.search(r'"front"\s*:\s*"((?:[^"\\]|\\.)*)"', block)
            b_match = re.search(r'"back"\s*:\s*"((?:[^"\\]|\\.)*)"', block)
            s_match = re.search(r'"source_ref"\s*:\s*"((?:[^"\\]|\\.)*)"', block)
            sf_match = re.search(r'"source_file"\s*:\s*"((?:[^"\\]|\\.)*)"', block)
            sp_match = re.search(r'"source_page"\s*:\s*"((?:[^"\\]|\\.)*)"', block)
            sq_match = re.search(r'"source_quote"\s*:\s*"((?:[^"\\]|\\.)*)"', block)
            if f_match and b_match:
                cards.append({
                    "id": len(cards) + 1,
                    "front": f_match.group(1),
                    "back": b_match.group(1),
                    "source_ref": s_match.group(1) if s_match else "",
                    "source_file": sf_match.group(1) if sf_match else "",
                    "source_page": sp_match.group(1) if sp_match else "",
                    "source_quote": sq_match.group(1) if sq_match else "",
                })

    if cards:
        return cards

    raise ValueError("Model nevrátil platný JSON formát pro kartičky. Zkuste generování opakovat.")

def normalize_front(text: str) -> str:
    return re.sub(r"[^\w\s]", "", str(text or "")).strip().lower()

def resolve_card_source(card: dict[str, Any], sources_list: list[dict[str, Any]] = None, project: str = "") -> dict[str, Any]:
    """
    Zajistí, že kartička má doplněné source_file, source_page a čistý odkaz pro zobrazení i Anki export.
    Funguje plně zpětně kompatibilně i pro starší formáty (pouze source_ref: '[1]' nebo '[1, s. 45]').
    """
    source_file = str(card.get("source_file") or "").strip()
    source_page = str(card.get("source_page") or card.get("page") or "").strip()
    source_ref = str(card.get("source_ref") or "").strip()
    source_quote = str(card.get("source_quote") or "").strip()

    # Mapa zdrojů podle ID a názvu
    id_to_file: dict[str, str] = {}
    if sources_list:
        for s in sources_list:
            if isinstance(s, dict):
                sid = str(s.get("id", ""))
                fname = str(s.get("filename", ""))
                if sid and fname:
                    id_to_file[sid] = fname

    # Pokud chybí source_file, zkusíme extrahovat ze source_ref
    if not source_file and source_ref:
        m_page = re.search(r"\[(?:Zdroj\s*)?(\d+)(?:,\s*s(?:tr)?\.?\s*([^\]]+))?\]", source_ref, re.IGNORECASE)
        if m_page:
            sid = m_page.group(1)
            if not source_page and m_page.group(2):
                source_page = m_page.group(2).strip()
            if sid in id_to_file:
                source_file = id_to_file[sid]
        else:
            m_direct = re.search(r"\[Zdroj:\s*([^,\]]+)(?:,\s*s(?:tr)?\.?\s*([^\]]+))?\]", source_ref, re.IGNORECASE)
            if m_direct:
                source_file = m_direct.group(1).strip()
                if not source_page and m_direct.group(2):
                    source_page = m_direct.group(2).strip()

    # Pokud máme source_file jako číslo zdroje (např. "1" nebo "[1]"), vyhledáme v mapě
    clean_sf_num = re.sub(r"[^\d]", "", source_file)
    if clean_sf_num and clean_sf_num in id_to_file and not source_file.lower().endswith((".pdf", ".docx", ".pptx", ".txt")):
        source_file = id_to_file[clean_sf_num]

    # Pokud stále nemáme source_page, ale je v source_ref:
    if not source_page and source_ref:
        m_p = re.search(r"s(?:tr)?\.?\s*([0-9]+(?:\s*[-–]\s*[0-9]+)?)", source_ref, re.IGNORECASE)
        if m_p:
            source_page = m_p.group(1).strip()

    # Pokud stále nemáme source_file, ale máme alespoň 1 unikátní zdroj v seznamu
    if not source_file and sources_list and len(sources_list) == 1 and isinstance(sources_list[0], dict):
        source_file = sources_list[0].get("filename", "")

    # Číslo první stránky pro #page=X
    clean_page_num = ""
    if source_page:
        m_digits = re.search(r"\d+", source_page)
        if m_digits:
            clean_page_num = m_digits.group(0)

    if source_file:
        card["source_file"] = source_file
    if source_page:
        card["source_page"] = source_page
    if source_quote:
        card["source_quote"] = source_quote

    safe_proj = sanitize_name(project) if project else ""
    view_url = ""
    if source_file and safe_proj:
        view_url = f"/uploads/{safe_proj}/{source_file}"
        if clean_page_num:
            view_url += f"#page={clean_page_num}"

    card["view_url"] = view_url
    card["clean_page"] = clean_page_num
    return card

def build_anki_tsv(cards: list[dict[str, Any]], project: str, question: str, sources_list: list[dict[str, Any]] = None) -> str:
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
):
    target_count = max(1, min(int(count), 500))
    safe_title = sanitize_name(question[:40])
    safe_proj = sanitize_name(project)
    flashcards_filename = f"{safe_proj}_{safe_title}.json"
    file_path = os.path.join(FLASHCARDS_DIR, flashcards_filename)

    existing_data = None
    if not force_regenerate:
        # 1. Zkusíme přímý název souboru
        if os.path.exists(file_path):
            try:
                with open(file_path, "r", encoding="utf-8") as f:
                    existing_data = json.load(f)
            except Exception:
                existing_data = None

        # 2. Fallback: Vyhledání souboru v projektu podle shodného znění otázky
        if not existing_data and os.path.exists(FLASHCARDS_DIR):
            try:
                norm_q = question.strip().lower()
                for fname in os.listdir(FLASHCARDS_DIR):
                    if fname.startswith(f"{safe_proj}_") and fname.endswith(".json"):
                        fpath = os.path.join(FLASHCARDS_DIR, fname)
                        try:
                            with open(fpath, "r", encoding="utf-8") as f:
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

    # Tolerance pro "přibližně stejný počet kartiček":
    # 15% nebo alespoň 3 kartičky (např. u 20 je 17-20 v pořádku, u 50 je 43-50 v pořádku)
    tolerance = max(3, int(target_count * 0.15))

    # Pokud již máme dostatečný počet kartiček, přeskočíme a negenerujeme znovu
    if not force_regenerate and existing_count >= (target_count - tolerance):
        await send_log(
            f"⏩ Otázka '{question[:35]}' již má {existing_count} hotových kartiček "
            f"(požadováno: {target_count}). Přeskakuji generování."
        )
        return existing_data, flashcards_filename

    # Pokud máme hotové kartičky, ale je jich málo oproti požadovanému množství,
    # zachováme existující a budeme pouze dogenerovávat chybějící bez duplicit
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

    context_text, unique_sources, raw_context = await query_rag_context_with_sources(question, project, n_results=25)

    prompt_template = custom_prompt if custom_prompt and custom_prompt.strip() else DEFAULT_FLASHCARDS_PROMPT
    sources_summary = "\n".join([f"[{s['id']}] {s['filename']}" for s in unique_sources])

    full_user_content = (
        f"ZKOUŠKOVÁ OTÁZKA: {question}\n\n"
        f"SEZNAM PŘIŘAZENÝCH ZDROJŮ PRO CITACE:\n{sources_summary}\n\n"
        f"=== ÚRYVKY Z MATERIÁLŮ ===\n"
        f"{context_text}\n"
        f"=========================="
    )

    remaining_needed = target_count - len(all_cards)

    # Pokud začínáme od nuly a cíl je malý (<= 35), stačí 1 rychlý prompt
    if len(all_cards) == 0 and remaining_needed <= 35:
        final_prompt = prompt_template.replace("{QUESTION}", question).replace("{COUNT}", str(target_count))
        final_prompt += (
            f"\n\n[STRIKTNÍ POŽADAVEK NA UNIKÁTNOST]: Vytvoř přesně {target_count} zcela unikátních kartiček. "
            "Každá otázka na lícové straně se musí ptát na jiný klinický fakt bez jakýchkoliv duplicit a parafrází."
        )
        await send_log(f"🗂️ Generuji {target_count} unikátních Anki/Quizlet kartiček k otázce: '{question}' přes {gemini_model}...")
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

    # Pokud stále zbývá dogenerovat (buď cíl > 35, nebo dogenerováváme stávající sadu, nebo 1. prompt nevrátil dostatek)
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
        await send_log(f"🗂️ Cíl {target_count} kartiček (zbývá dogenerovat {needed} ks): generuji v tematických sériích bez duplicit...")

        round_idx = 0
        while len(all_cards) < target_count and round_idx < max_rounds:
            remaining = target_count - len(all_cards)
            current_b_count = min(sub_batch_size, remaining)
            domain_focus = domains[round_idx % len(domains)]
            round_idx += 1

            await send_log(f"▶️ Série {round_idx} (cíl: +{current_b_count} ks, celkem unikátních: {len(all_cards)}/{target_count}) – oblast: {domain_focus[:45]}...")

            sub_prompt = prompt_template.replace("{QUESTION}", question).replace("{COUNT}", str(current_b_count))
            sub_prompt += f"\n\n[SPECIFICKÉ ZAMĚŘENÍ TÉTO SÉRIE]: Zaměř se specificky a do hloubky na tuto klinickou oblast: {domain_focus}."
            
            # Předání předchozích otázek pro eliminaci duplicit
            if all_cards:
                prev_sample = [f'- "{c.get("front", "").strip()}"' for c in all_cards[-35:]]
                sub_prompt += (
                    f"\n\n[STRIKTNÍ ZÁKAZ DUPLICIT]: V této sadě již existuje následujících {len(all_cards)} otázek. "
                    f"JE PŘÍSNĚ ZAKÁZÁNO je opakovat nebo se ptát na stejné detaily:\n"
                    + "\n".join(prev_sample)
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

    # Přečíslování ID kartiček
    for i, card in enumerate(all_cards):
        card["id"] = i + 1

    if not all_cards:
        raise ValueError("Nepodařilo se vytvořit žádné kartičky. Zkontrolujte spojení nebo opakujte dotaz.")

    # Sloučení zdrojů s dřívějšími
    combined_sources = list(existing_data.get("sources", [])) if (existing_data and isinstance(existing_data.get("sources"), list)) else []
    seen_source_ids = {s.get("id") for s in combined_sources if isinstance(s, dict)}
    for s in unique_sources:
        if isinstance(s, dict) and s.get("id") not in seen_source_ids:
            seen_source_ids.add(s.get("id"))
            combined_sources.append(s)

    active_sources = combined_sources if combined_sources else unique_sources

    # Obohatíme každou kartu o přesné URL a informace o zdroji
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
        await send_log(f"✅ Úspěšně dogenerováno {added} nových kartiček. Celkem uloženo {len(all_cards)} kartiček do {flashcards_filename}.")
    else:
        await send_log(f"✅ Vytvořeno a uloženo celkem {len(all_cards)} kartiček do {flashcards_filename}.")
    return payload, flashcards_filename

async def create_srt_for_audio(script: str, audio_filename: str):
    if MP3 is None:
        await send_log("⚠️ Pro generování .srt titulků chybí knihovna 'mutagen'. (pip install mutagen)")
        return False

    audio_path = os.path.join(AUDIO_DIR, audio_filename)
    if not os.path.exists(audio_path):
        return False

    try:
        await send_log("📝 Generuji .srt titulky...")
        audio_info = MP3(audio_path)
        total_duration = audio_info.info.length
        
        srt_filename = audio_filename.replace('.mp3', '.srt')
        srt_path = os.path.join(AUDIO_DIR, srt_filename)
        
        def format_srt_time(seconds):
            hours = int(seconds // 3600)
            minutes = int((seconds % 3600) // 60)
            secs = int(seconds % 60)
            millis = int((seconds - int(seconds)) * 1000)
            return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"
        
        sentences = re.split(r'(?<=[.!?]) +', script)
        total_chars = sum(len(s) for s in sentences if s.strip())
        
        with open(srt_path, 'w', encoding='utf-8') as srt_file:
            current_time = 0.0
            srt_index = 1
            for sentence in sentences:
                clean_sentence = sentence.strip()
                if not clean_sentence: continue
                    
                duration = total_duration * (len(clean_sentence) / total_chars)
                start_time = current_time
                end_time = current_time + duration
                
                srt_file.write(f"{srt_index}\n")
                srt_file.write(f"{format_srt_time(start_time)} --> {format_srt_time(end_time)}\n")
                srt_file.write(f"{clean_sentence}\n\n")
                
                current_time = end_time
                srt_index += 1
                
        return True
    except Exception as e:
        await send_log(f"⚠️ Nelze vytvořit titulky: {str(e)}")
        return False

async def create_mp4_with_subtitles(audio_filename: str, question_title: str):
    if ffmpeg is None:
        await send_log("⚠️ Chybí knihovna 'ffmpeg-python'. Video nebude vytvořeno.")
        return False

    base_name = audio_filename.replace(".mp3", "")
    audio_path = os.path.join(AUDIO_DIR, audio_filename)
    srt_path = os.path.join(AUDIO_DIR, f"{base_name}.srt")
    video_path = os.path.join(AUDIO_DIR, f"{base_name}.mp4")
    title_txt_path = os.path.join(AUDIO_DIR, f"{base_name}_title.txt")
    
    with open(title_txt_path, "w", encoding="utf-8") as f:
        f.write(question_title)
    
    await send_log("🎬 FFmpeg: Vytvářím MP4 video s titulky...")
    try:
        srt_path_esc = srt_path.replace("\\", "/")
        title_txt_path_esc = title_txt_path.replace("\\", "/")
        
        vf_filter = (
            "color=c=#0f172a:s=1280x720[bg];"
            f"[bg]drawtext=textfile='{title_txt_path_esc}':fontcolor=white:fontsize=46:x=(w-text_w)/2:y=(h-text_h)/2-120:text_align=C[with_text];"
            f"[with_text]subtitles='{srt_path_esc}':force_style='FontSize=26,PrimaryColour=&H00FFFFFF'"
        )

        (
            ffmpeg
            .input(audio_path)
            .output(video_path, 
                    vcodec='libx264', 
                    acodec='aac', 
                    shortest=None,
                    vf=vf_filter)
            .overwrite_output()
            .run(quiet=True)
        )
        
        if os.path.exists(title_txt_path):
            os.remove(title_txt_path)
            
        await send_log(f"✅ Video uloženo jako {base_name}.mp4")
        return True
    except Exception as e:
        await send_log(f"⚠️ Selhalo vytváření videa. Chyba: {str(e)}")
        return False

async def internal_generate_audio(script: str, filename: str, provider: str, voice: str, output_format: str, question_title: str):
    safe_title = "".join([c for c in filename if c.isalnum() or c in (' ', '_', '-')]).strip().replace(" ", "_")
    audio_filename = f"{safe_title}.mp3"
    audio_path = os.path.join(AUDIO_DIR, audio_filename)
    temporary_audio_path = f"{audio_path}.part"

    sentences = re.split(r'(?<=[.!?]) +', script)
    chunks = []
    current_chunk = ""
    CHUNK_LIMIT = 4000
    
    if len(script) > CHUNK_LIMIT:
        await send_log(f"✂️ Text je rozdělen pro překročení limitů TTS.")

    for sentence in sentences:
        if len(current_chunk) + len(sentence) < CHUNK_LIMIT:
            current_chunk += sentence + " "
        else:
            if current_chunk.strip():
                chunks.append(current_chunk.strip())
            current_chunk = sentence + " "
            
    if current_chunk.strip():
        chunks.append(current_chunk.strip())

    if os.path.exists(temporary_audio_path):
        os.remove(temporary_audio_path)

    try:
        # Zapisujeme do dočasného souboru. Neúspěšný pokus tak nikdy nevydá
        # neúplné MP3 za hotový výsledek v průzkumníku.
        with open(temporary_audio_path, 'wb') as final_audio_file:
            for idx, chunk in enumerate(chunks):
                if not chunk:
                    continue

                if len(chunks) > 1:
                    await send_log(f"🔊 {provider.upper()} TTS: Generuji část audia {idx + 1}/{len(chunks)}...")
                else:
                    await send_log(f"🔊 {provider.upper()} TTS: Generuji audiosoubor...")

                if provider == "openai":
                    def create_openai_speech() -> bytes:
                        client = get_openai_client()
                        response = client.audio.speech.create(
                            model="tts-1", voice=voice, input=chunk
                        )
                        return b"".join(response.iter_bytes())

                    final_audio_file.write(await asyncio.to_thread(create_openai_speech))

                elif provider == "elevenlabs":
                    el_key = get_elevenlabs_api_key()
                    if not el_key:
                        raise ValueError("Chybí klíč ElevenLabs. Zadejte jej prosím v sekci Nastavení ⚙️.")
                    headers = {"xi-api-key": el_key, "Content-Type": "application/json"}
                    data = {
                        "text": chunk,
                        "model_id": "eleven_multilingual_v2",
                        "voice_settings": {"stability": 0.5, "similarity_boost": 0.75}
                    }
                    voice_id = voice if len(voice) > 5 else "21m00Tcm4TlvDq8ikWAM"
                    async with httpx.AsyncClient() as client:
                        res = await client.post(
                            f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}",
                            headers=headers, json=data, timeout=120.0
                        )
                        if res.status_code != 200:
                            raise ValueError(res.text)
                        final_audio_file.write(res.content)
                else:
                    raise ValueError(f"Nepodporovaný TTS poskytovatel: {provider}")

        os.replace(temporary_audio_path, audio_path)
    except Exception as e:
        if os.path.exists(temporary_audio_path):
            os.remove(temporary_audio_path)
        raise ValueError(friendly_api_error(e, provider.upper())) from e
    
    await create_srt_for_audio(script, audio_filename)
    
    if output_format == "mp4":
        success = await create_mp4_with_subtitles(audio_filename, question_title)
        if success:
            return f"/audio/{safe_title}.mp4", f"{safe_title}.mp4", "mp4"
                    
    return f"/audio/{audio_filename}", audio_filename, "mp3"

# --- ZRUŠENÍ DÁVKOVÉHO PROCESU ---
@app.post("/api/cancel-batch")
async def cancel_batch(payload: dict = Body(...)):
    project = sanitize_name(payload.get("project", ""))
    batch = active_batches.get(project)
    if not batch:
        return {"status": "not_running"}

    batch.cancel_requested = True
    await send_log("🛑 Požadavek na zrušení dávky byl přijat. Dokončující API volání doběhne, další otázka se už nespustí.")
    return {"status": "cancelling", "batch_id": batch.batch_id}


async def background_batch_process(
    questions: list,
    custom_prompt: str,
    provider: str,
    voice: str,
    output_format: str,
    project: str,
    gemini_model: str,
    batch_id: str,
    overnight_mode: bool = True,
):
    batch = active_batches.get(project)
    if not batch or batch.batch_id != batch_id:
        return

    pending_question_indexes = [question.get("q_index") for question in questions]
    outcome = "completed"
    failed_message = None
    failed_questions = []

    try:
        await send_log(f"🚀 Spouštím dávkové zpracování podcastů pro {len(questions)} otázek...")
        await send_batch_event(
            project,
            "started",
            batch_id,
            mode="podcast",
            question_indexes=[question.get("q_index") for question in questions],
        )

        for idx, question_data in enumerate(questions):
            if batch.cancel_requested:
                await send_log("🛑 Dávkové zpracování bylo zrušeno uživatelem!")
                outcome = "cancelled"
                break

            title = question_data.get('title')
            question_index = question_data.get("q_index")
            await send_log(f"▶️ [{idx+1}/{len(questions)}] Zpracovávám otázku: {title}")

            success = False
            last_err = None
            for attempt in range(3):
                if batch.cancel_requested:
                    break
                try:
                    script, _ = await internal_generate_script(title, custom_prompt, provider, project, gemini_model)
                    if batch.cancel_requested:
                        break
                    safe_filename = f"{project}_Q{question_index}_{title[:15]}"
                    await internal_generate_audio(script, safe_filename, provider, voice, output_format, title)
                    success = True
                    break
                except Exception as err:
                    last_err = err
                    if attempt < 2 and not batch.cancel_requested:
                        wait_s = (attempt + 1) * 5
                        await send_log(f"⚠️ [Pokus {attempt + 1}/3] Otázka '{title[:35]}' selhala: {str(err)}. Opakuji za {wait_s} s...")
                        await asyncio.sleep(wait_s)

            if success:
                batch.completed_question_indexes.append(question_index)
                if question_index in pending_question_indexes:
                    pending_question_indexes.remove(question_index)
                await send_batch_event(
                    project,
                    "question_completed",
                    batch_id,
                    mode="podcast",
                    question_index=question_index,
                )
                await send_log(f"🎉 Hotovo [{idx+1}/{len(questions)}].")
            else:
                await send_log(f"⚠️ Otázku '{title[:35]}' se nepodařilo dokončit: {str(last_err)}. Pokračuji v dávce...")
                failed_questions.append(question_data)
                await send_batch_event(
                    project,
                    "question_failed",
                    batch_id,
                    mode="podcast",
                    question_index=question_index,
                    error=str(last_err),
                )

            await asyncio.sleep(1.0)

        # Noční kontrola kompletnosti: doplňovací kola pro neúspěšné otázky
        if overnight_mode and failed_questions and not batch.cancel_requested:
            max_sweeps = 2
            sweep_idx = 0
            while failed_questions and sweep_idx < max_sweeps and not batch.cancel_requested:
                sweep_idx += 1
                await send_log(f"🌙 [Noční kontrola podcastů – kolo {sweep_idx}/{max_sweeps}]: Znovu zkouším {len(failed_questions)} nedokončených otázek...")
                await asyncio.sleep(6.0)
                still_failed = []
                for q_data in failed_questions:
                    if batch.cancel_requested:
                        break
                    q_title = q_data.get("title")
                    q_idx = q_data.get("q_index")
                    await send_log(f"🔄 Doplňovací pokus podcastu: {q_title[:35]}...")
                    try:
                        script, _ = await internal_generate_script(q_title, custom_prompt, provider, project, gemini_model)
                        if batch.cancel_requested:
                            break
                        safe_filename = f"{project}_Q{q_idx}_{q_title[:15]}"
                        await internal_generate_audio(script, safe_filename, provider, voice, output_format, q_title)
                        batch.completed_question_indexes.append(q_idx)
                        if q_idx in pending_question_indexes:
                            pending_question_indexes.remove(q_idx)
                        await send_batch_event(
                            project,
                            "question_completed",
                            batch_id,
                            mode="podcast",
                            question_index=q_idx,
                        )
                        await send_log(f"🎉 Úspěšně doplněno v noční kontrole: {q_title[:35]}")
                    except Exception as sw_err:
                        await send_log(f"⚠️ Doplňovací pokus pro '{q_title[:35]}' selhal: {str(sw_err)}")
                        still_failed.append(q_data)
                    await asyncio.sleep(1.0)
                failed_questions = still_failed

        if batch.cancel_requested:
            outcome = "cancelled"
            await send_log("🏁 Dávkové zpracování podcastů bylo zrušeno.")
        elif len(pending_question_indexes) == 0:
            outcome = "completed"
            await send_log(f"🏁 Dávkové zpracování podcastů kompletně dokončeno ({len(questions)}/{len(questions)} hotovo)!")
        else:
            outcome = "completed_with_errors"
            await send_log(f"🏁 Dávka podcastů dokončena: {len(batch.completed_question_indexes)}/{len(questions)} hotovo, {len(pending_question_indexes)} neúspěšných.")

    except Exception as e:
        outcome = "failed"
        failed_message = str(e)
        await send_log(f"❌ Dávkové zpracování přerušeno chybou: {failed_message}")
    finally:
        try:
            await send_batch_event(
                project,
                "finished",
                batch_id,
                mode="podcast",
                outcome=outcome,
                completed_question_indexes=batch.completed_question_indexes,
                pending_question_indexes=pending_question_indexes,
                error=failed_message,
            )
        finally:
            # Bezpodmínečný úklid je klíčový: po chybě musí jít dávku ihned
            # znovu spustit, bez restartování backendu.
            current_batch = active_batches.get(project)
            if current_batch and current_batch.batch_id == batch_id:
                del active_batches[project]

@app.post("/api/process-batch")
async def process_batch(background_tasks: BackgroundTasks, payload: dict = Body(...)):
    questions = payload.get("questions", [])
    custom_prompt = payload.get("prompt")
    provider = payload.get("provider", "openai")
    voice = payload.get("voice", "onyx")
    output_format = payload.get("format", "mp3")
    project = sanitize_name(payload.get("project", ""))
    gemini_model = payload.get("gemini_model", "gemini-3.6-flash")
    overnight_mode = bool(payload.get("overnight_mode", True))

    if not questions or not custom_prompt or not project:
        raise HTTPException(status_code=400, detail="Chybí otázky, prompt nebo projekt.")

    if project in active_batches:
        raise HTTPException(
            status_code=409,
            detail="Pro tento projekt už běží dávka. Vyčkejte na její dokončení nebo ji nejprve zrušte.",
        )

    batch_id = str(uuid.uuid4())
    active_batches[project] = BatchState(batch_id=batch_id)
    background_tasks.add_task(
        background_batch_process,
        questions,
        custom_prompt,
        provider,
        voice,
        output_format,
        project,
        gemini_model,
        batch_id,
        overnight_mode,
    )
    return {"status": "started", "batch_id": batch_id, "mode": "podcast"}


# --- DÁVKOVÉ ZPRACOVÁNÍ: STUDIJNÍ POZNÁMKY ---
async def background_notes_batch_process(
    questions: list,
    custom_prompt: str,
    project: str,
    gemini_model: str,
    batch_id: str,
    overnight_mode: bool = True,
):
    batch = active_batches.get(project)
    if not batch or batch.batch_id != batch_id:
        return

    pending_question_indexes = [question.get("q_index") for question in questions]
    outcome = "completed"
    failed_message = None
    failed_questions = []

    try:
        await send_log(f"🚀 Spouštím dávkové generování studijních textů pro {len(questions)} otázek...")
        await send_batch_event(
            project,
            "started",
            batch_id,
            mode="notes",
            question_indexes=[question.get("q_index") for question in questions],
        )

        for idx, question_data in enumerate(questions):
            if batch.cancel_requested:
                await send_log("🛑 Dávkové generování poznámek bylo zrušeno uživatelem!")
                outcome = "cancelled"
                break

            title = question_data.get("title")
            question_index = question_data.get("q_index")
            await send_log(f"📝 [{idx+1}/{len(questions)}] Generuji studijní text: {title}")

            success = False
            last_err = None
            for attempt in range(3):
                if batch.cancel_requested:
                    break
                try:
                    await internal_generate_notes(title, project, custom_prompt, gemini_model)
                    success = True
                    break
                except Exception as err:
                    last_err = err
                    if is_terminal_auth_error(err):
                        await send_log(f"🛑 Fatální chyba autorizace: {friendly_api_error(err, 'Gemini')}")
                        batch.cancel_requested = True
                        break
                    if attempt < 2 and not batch.cancel_requested:
                        wait_s = (attempt + 1) * 5
                        await send_log(f"⚠️ [Pokus {attempt + 1}/3] Otázka '{title[:35]}' selhala: {str(err)}. Opakuji za {wait_s} s...")
                        await asyncio.sleep(wait_s)

            if success:
                batch.completed_question_indexes.append(question_index)
                if question_index in pending_question_indexes:
                    pending_question_indexes.remove(question_index)
                await send_batch_event(
                    project,
                    "question_completed",
                    batch_id,
                    mode="notes",
                    question_index=question_index,
                )
                await send_log(f"🎉 Text k otázce [{idx+1}/{len(questions)}] vygenerován a uložen.")
            else:
                await send_log(f"⚠️ Otázku '{title[:35]}' se nepodařilo vygenerovat: {str(last_err)}. Pokračuji v dávce...")
                failed_questions.append(question_data)
                await send_batch_event(
                    project,
                    "question_failed",
                    batch_id,
                    mode="notes",
                    question_index=question_index,
                    error=str(last_err),
                )

            await asyncio.sleep(1.0)

        # Noční kontrola kompletnosti: doplňovací kola pro neúspěšné otázky
        if overnight_mode and failed_questions and not batch.cancel_requested:
            max_sweeps = 2
            sweep_idx = 0
            while failed_questions and sweep_idx < max_sweeps and not batch.cancel_requested:
                sweep_idx += 1
                await send_log(f"🌙 [Noční kontrola textů – kolo {sweep_idx}/{max_sweeps}]: Znovu zkouším {len(failed_questions)} nedokončených otázek...")
                await asyncio.sleep(6.0)
                still_failed = []
                for q_data in failed_questions:
                    if batch.cancel_requested:
                        break
                    q_title = q_data.get("title")
                    q_idx = q_data.get("q_index")
                    await send_log(f"🔄 Doplňovací pokus textu: {q_title[:35]}...")
                    try:
                        await internal_generate_notes(q_title, project, custom_prompt, gemini_model)
                        batch.completed_question_indexes.append(q_idx)
                        if q_idx in pending_question_indexes:
                            pending_question_indexes.remove(q_idx)
                        await send_batch_event(
                            project,
                            "question_completed",
                            batch_id,
                            mode="notes",
                            question_index=q_idx,
                        )
                        await send_log(f"🎉 Úspěšně doplněno v noční kontrole: {q_title[:35]}")
                    except Exception as sw_err:
                        await send_log(f"⚠️ Doplňovací pokus pro '{q_title[:35]}' selhal: {str(sw_err)}")
                        still_failed.append(q_data)
                    await asyncio.sleep(1.0)
                failed_questions = still_failed

        if batch.cancel_requested:
            outcome = "cancelled"
            await send_log("🏁 Dávkové generování studijních textů bylo zrušeno.")
        elif len(pending_question_indexes) == 0:
            outcome = "completed"
            await send_log(f"🏁 Dávkové generování textů kompletně dokončeno ({len(questions)}/{len(questions)} hotovo)!")
        else:
            outcome = "completed_with_errors"
            await send_log(f"🏁 Dávka textů dokončena: {len(batch.completed_question_indexes)}/{len(questions)} hotovo, {len(pending_question_indexes)} neúspěšných.")

    except Exception as e:
        outcome = "failed"
        failed_message = str(e)
        await send_log(f"❌ Dávkové generování textů přerušeno: {failed_message}")
    finally:
        try:
            await send_batch_event(
                project,
                "finished",
                batch_id,
                mode="notes",
                outcome=outcome,
                completed_question_indexes=batch.completed_question_indexes,
                pending_question_indexes=pending_question_indexes,
                error=failed_message,
            )
        finally:
            current_batch = active_batches.get(project)
            if current_batch and current_batch.batch_id == batch_id:
                del active_batches[project]


@app.post("/api/process-notes-batch")
async def process_notes_batch(background_tasks: BackgroundTasks, payload: dict = Body(...)):
    questions = payload.get("questions", [])
    custom_prompt = payload.get("prompt", "")
    project = sanitize_name(payload.get("project", ""))
    gemini_model = payload.get("gemini_model", "gemini-3.6-flash")
    overnight_mode = bool(payload.get("overnight_mode", True))

    if not questions or not project:
        raise HTTPException(status_code=400, detail="Chybí otázky nebo projekt.")

    if project in active_batches:
        raise HTTPException(
            status_code=409,
            detail="Pro tento projekt už běží dávka. Vyčkejte na její dokončení nebo ji nejprve zrušte.",
        )

    batch_id = str(uuid.uuid4())
    active_batches[project] = BatchState(batch_id=batch_id, mode="notes")
    background_tasks.add_task(
        background_notes_batch_process,
        questions,
        custom_prompt,
        project,
        gemini_model,
        batch_id,
        overnight_mode,
    )
    return {"status": "started", "batch_id": batch_id, "mode": "notes"}


# --- DÁVKOVÉ ZPRACOVÁNÍ: KARTIČKY ---
async def background_flashcards_batch_process(
    questions: list,
    count: int,
    custom_prompt: str,
    project: str,
    gemini_model: str,
    batch_id: str,
    overnight_mode: bool = True,
):
    batch = active_batches.get(project)
    if not batch or batch.batch_id != batch_id:
        return

    pending_question_indexes = [question.get("q_index") for question in questions]
    outcome = "completed"
    failed_message = None
    failed_questions = []

    try:
        await send_log(f"🚀 Spouštím dávkové generování kartiček ({count} ks/otázka) pro {len(questions)} otázek...")
        await send_batch_event(
            project,
            "started",
            batch_id,
            mode="flashcards",
            question_indexes=[question.get("q_index") for question in questions],
        )

        for idx, question_data in enumerate(questions):
            if batch.cancel_requested:
                await send_log("🛑 Dávkové generování kartiček bylo zrušeno uživatelem!")
                outcome = "cancelled"
                break

            title = question_data.get("title")
            question_index = question_data.get("q_index")
            await send_log(f"🗂️ [{idx+1}/{len(questions)}] Generuji {count} kartiček: {title}")

            success = False
            last_err = None
            for attempt in range(3):
                if batch.cancel_requested:
                    break
                try:
                    await internal_generate_flashcards(title, project, count, custom_prompt, gemini_model)
                    success = True
                    break
                except Exception as err:
                    last_err = err
                    if is_terminal_auth_error(err):
                        await send_log(f"🛑 Fatální chyba autorizace: {friendly_api_error(err, 'Gemini')}")
                        batch.cancel_requested = True
                        break
                    if attempt < 2 and not batch.cancel_requested:
                        wait_s = (attempt + 1) * 5
                        await send_log(f"⚠️ [Pokus {attempt + 1}/3] Otázka '{title[:35]}' selhala: {str(err)}. Opakuji za {wait_s} s...")
                        await asyncio.sleep(wait_s)

            if success:
                batch.completed_question_indexes.append(question_index)
                if question_index in pending_question_indexes:
                    pending_question_indexes.remove(question_index)
                await send_batch_event(
                    project,
                    "question_completed",
                    batch_id,
                    mode="flashcards",
                    question_index=question_index,
                )
                await send_log(f"🎉 Kartičky k otázce [{idx+1}/{len(questions)}] vytvořeny a uloženy.")
            else:
                await send_log(f"⚠️ Otázku '{title[:35]}' se nepodařilo vygenerovat: {str(last_err)}. Pokračuji v dávce...")
                failed_questions.append(question_data)
                await send_batch_event(
                    project,
                    "question_failed",
                    batch_id,
                    mode="flashcards",
                    question_index=question_index,
                    error=str(last_err),
                )

            await asyncio.sleep(1.0)

        # Noční kontrola kompletnosti: doplňovací kola pro neúspěšné otázky
        if overnight_mode and failed_questions and not batch.cancel_requested:
            max_sweeps = 2
            sweep_idx = 0
            while failed_questions and sweep_idx < max_sweeps and not batch.cancel_requested:
                sweep_idx += 1
                await send_log(f"🌙 [Noční kontrola kartiček – kolo {sweep_idx}/{max_sweeps}]: Znovu zkouším {len(failed_questions)} nedokončených otázek...")
                await asyncio.sleep(6.0)
                still_failed = []
                for q_data in failed_questions:
                    if batch.cancel_requested:
                        break
                    q_title = q_data.get("title")
                    q_idx = q_data.get("q_index")
                    await send_log(f"🔄 Doplňovací pokus kartiček: {q_title[:35]}...")
                    try:
                        await internal_generate_flashcards(q_title, project, count, custom_prompt, gemini_model)
                        batch.completed_question_indexes.append(q_idx)
                        if q_idx in pending_question_indexes:
                            pending_question_indexes.remove(q_idx)
                        await send_batch_event(
                            project,
                            "question_completed",
                            batch_id,
                            mode="flashcards",
                            question_index=q_idx,
                        )
                        await send_log(f"🎉 Úspěšně doplněno v noční kontrole: {q_title[:35]}")
                    except Exception as sw_err:
                        await send_log(f"⚠️ Doplňovací pokus pro '{q_title[:35]}' selhal: {str(sw_err)}")
                        still_failed.append(q_data)
                    await asyncio.sleep(1.0)
                failed_questions = still_failed

        if batch.cancel_requested:
            outcome = "cancelled"
            await send_log("🏁 Dávkové generování kartiček bylo zrušeno.")
        elif len(pending_question_indexes) == 0:
            outcome = "completed"
            await send_log(f"🏁 Dávkové generování kartiček kompletně dokončeno ({len(questions)}/{len(questions)} hotovo)!")
        else:
            outcome = "completed_with_errors"
            await send_log(f"🏁 Dávka kartiček dokončena: {len(batch.completed_question_indexes)}/{len(questions)} hotovo, {len(pending_question_indexes)} neúspěšných.")

    except Exception as e:
        outcome = "failed"
        failed_message = str(e)
        await send_log(f"❌ Dávkové generování kartiček přerušeno: {failed_message}")
    finally:
        try:
            await send_batch_event(
                project,
                "finished",
                batch_id,
                mode="flashcards",
                outcome=outcome,
                completed_question_indexes=batch.completed_question_indexes,
                pending_question_indexes=pending_question_indexes,
                error=failed_message,
            )
        finally:
            current_batch = active_batches.get(project)
            if current_batch and current_batch.batch_id == batch_id:
                del active_batches[project]


@app.post("/api/process-flashcards-batch")
async def process_flashcards_batch(background_tasks: BackgroundTasks, payload: dict = Body(...)):
    questions = payload.get("questions", [])
    count = int(payload.get("count", 10))
    custom_prompt = payload.get("prompt", "")
    project = sanitize_name(payload.get("project", ""))
    gemini_model = payload.get("gemini_model", "gemini-3.6-flash")
    overnight_mode = bool(payload.get("overnight_mode", True))

    if not questions or not project:
        raise HTTPException(status_code=400, detail="Chybí otázky nebo projekt.")

    if project in active_batches:
        raise HTTPException(
            status_code=409,
            detail="Pro tento projekt už běží dávka. Vyčkejte na její dokončení nebo ji nejprve zrušte.",
        )

    batch_id = str(uuid.uuid4())
    active_batches[project] = BatchState(batch_id=batch_id, mode="flashcards")
    background_tasks.add_task(
        background_flashcards_batch_process,
        questions,
        count,
        custom_prompt,
        project,
        gemini_model,
        batch_id,
        overnight_mode,
    )
    return {"status": "started", "batch_id": batch_id, "mode": "flashcards"}

@app.post("/api/generate-script")
async def generate_script(payload: dict = Body(...)):
    question = payload.get("question")
    custom_prompt = payload.get("prompt")
    provider = payload.get("provider", "openai")
    project = payload.get("project")
    gemini_model = payload.get("gemini_model", "gemini-3.6-flash")
    
    if not question or not custom_prompt or not project:
        raise HTTPException(status_code=400, detail="Chybí parametry dotazu.")

    try:
        script, context = await internal_generate_script(question, custom_prompt, provider, project, gemini_model)
        return {"script": script, "context": context}
    except Exception as e:
        await send_log(f"❌ Chyba při generování scénáře: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/generate-audio")
async def generate_audio(payload: dict = Body(...)):
    script = payload.get("script")
    filename = payload.get("filename", "podcast")
    provider = payload.get("provider", "openai")
    voice = payload.get("voice", "onyx")
    output_format = payload.get("format", "mp3")
    question_title = payload.get("question_title", filename)

    await send_log(f"🔊 Spouštím TTS syntézu přes {provider}...")
    try:
        audio_url, audio_filename, final_format = await internal_generate_audio(script, filename, provider, voice, output_format, question_title)
        return {"audio_url": audio_url, "filename": audio_filename, "format": final_format}
    except Exception as e:
        await send_log(f"❌ Tvorba záznamu selhala: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/generate-subtitles")
async def generate_subtitles_endpoint(payload: dict = Body(...)):
    script = payload.get("script")
    filename = payload.get("filename")

    success = await create_srt_for_audio(script, filename)
    if success:
        return {"status": "success", "message": "Titulky vygenerovány."}
    else:
        raise HTTPException(status_code=500, detail="Titulky se nepodařilo vygenerovat.")

# --- STATISTIKY PRO DASHBOARD ---
@app.get("/api/stats")
async def get_project_stats(project: str = ""):
    safe_proj = sanitize_name(project) if project else ""
    
    # Materiály
    files_count = 0
    if safe_proj:
        proj_dir = os.path.join(UPLOAD_DIR, safe_proj)
        if os.path.exists(proj_dir):
            allowed_exts = (".pdf", ".docx", ".pptx", ".txt")
            files_count = len([f for f in os.listdir(proj_dir) if f.lower().endswith(allowed_exts)])

    # Média (audio / video)
    audio_files = [f for f in os.listdir(AUDIO_DIR) if f.endswith(('.mp3', '.mp4'))]
    if safe_proj:
        audio_files = [f for f in audio_files if f.startswith(f"{safe_proj}_")]
    
    # Poznámky
    notes_files = [f for f in os.listdir(NOTES_DIR) if f.endswith(".md")]
    if safe_proj:
        notes_files = [f for f in notes_files if f.startswith(f"{safe_proj}_")]
        
    # Kartičky
    flashcards_files = [f for f in os.listdir(FLASHCARDS_DIR) if f.endswith(".json")]
    if safe_proj:
        flashcards_files = [f for f in flashcards_files if f.startswith(f"{safe_proj}_")]

    # Testové otázky
    tests_files = [f for f in os.listdir(TESTS_DIR) if f.endswith(".json")]
    if safe_proj:
        tests_files = [f for f in tests_files if f.startswith(f"{safe_proj}_")]

    # Výukové lekce a chat
    lessons_count = 0
    chat_count = 0
    try:
        from chat_service import list_lessons, get_project_messages
        all_lessons = list_lessons()
        if safe_proj:
            lessons_count = len([l for l in all_lessons if l.get("project_id") == safe_proj])
            chat_count = len(get_project_messages(safe_proj, limit=1000))
        else:
            lessons_count = len(all_lessons)
    except Exception:
        pass

    # Otázky (z plánovače / projektu)
    questions_count = 0
    if safe_proj:
        proj_dir = os.path.join(UPLOAD_DIR, safe_proj)
        planner_file = os.path.join(proj_dir, "exam_planner.json")
        if os.path.exists(planner_file):
            try:
                with open(planner_file, "r", encoding="utf-8") as f:
                    pdata = json.load(f)
                    questions_count = len(pdata.get("questions", []))
            except Exception:
                pass

    return {
        "project": project,
        "files_count": files_count,
        "media_count": len(audio_files),
        "notes_count": len(notes_files),
        "flashcards_count": len(flashcards_files),
        "tests_count": len(tests_files),
        "lessons_count": lessons_count,
        "chat_count": chat_count,
        "questions_count": questions_count,
    }

# --- STUDIJNÍ POZNÁMKY (NOTES) ---
@app.post("/api/generate-notes")
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

@app.get("/api/notes")
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
                with open(path, "r", encoding="utf-8") as file_handle:
                    header = file_handle.read(1024)
                    match = re.search(r'<!-- METADATA\s*(\{.*?\})\s*-->', header, re.DOTALL)
                    if match:
                        meta = json.loads(match.group(1))
                        if "question" in meta:
                            q_title = meta["question"]
            except Exception:
                pass

            results.append({
                "filename": f,
                "title": q_title,
                "mtime": mtime,
                "size": os.path.getsize(path),
            })
        return {"notes": results}
    except Exception as e:
        return {"notes": [], "error": str(e)}

@app.get("/api/notes/{filename}")
async def get_note(filename: str):
    file_path = os.path.join(NOTES_DIR, filename)
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="Poznámky nenalezeny.")
    with open(file_path, "r", encoding="utf-8") as f:
        content = f.read()
    # Očištění metadata komentáře pro čistý Markdown náhled
    clean_markdown = re.sub(r'^<!-- METADATA.*?-->\s*', '', content, flags=re.DOTALL)
    sources = []
    project = ""
    meta_match = re.search(r'^<!-- METADATA\s*(\{.*?\})\s*-->', content, flags=re.DOTALL)
    if meta_match:
        try:
            meta_json = json.loads(meta_match.group(1))
            sources = meta_json.get("sources", [])
            project = meta_json.get("project", "")
        except Exception:
            pass
    return {"filename": filename, "markdown": clean_markdown, "raw": content, "sources": sources, "project": project}

@app.delete("/api/notes/{filename}")
async def delete_note(filename: str):
    file_path = os.path.join(NOTES_DIR, filename)
    if os.path.exists(file_path):
        os.remove(file_path)
        await send_log(f"🗑️ Smazány poznámky: {filename}")
        return {"status": "success"}
    raise HTTPException(status_code=404, detail="Soubor nenalezen.")

# --- KARTIČKY (ANKI / QUIZLET) ---
@app.post("/api/generate-flashcards")
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

@app.get("/api/flashcards")
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
                with open(path, "r", encoding="utf-8") as file_handle:
                    data = json.load(file_handle)
                    results.append({
                        "filename": f,
                        "question": data.get("question", f),
                        "count": data.get("count", len(data.get("cards", []))),
                        "mtime": os.path.getmtime(path),
                    })
            except Exception:
                results.append({
                    "filename": f,
                    "question": f,
                    "count": 0,
                    "mtime": os.path.getmtime(path),
                })
        return {"decks": results}
    except Exception as e:
        return {"decks": [], "error": str(e)}

@app.get("/api/flashcards/export-all")
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
                with open(path, "r", encoding="utf-8") as file_handle:
                    data = json.load(file_handle)
                    q_title = data.get("question", f)
                    cards = data.get("cards", [])
                    decks_info.append({
                        "filename": f,
                        "question": q_title,
                        "count": len(cards),
                    })
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
                extra.append(f"<a href='{file_url}' target='_blank' style='color:#0284c7; text-decoration: underline;'>📖 {src_file}{page_text}</a>")
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

@app.get("/api/flashcards/{filename}")
async def get_flashcard_deck(filename: str):
    file_path = os.path.join(FLASHCARDS_DIR, filename)
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="Sada kartiček nenalezena.")
    with open(file_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    # Automatické dovyřešení zdrojů i pro dříve uložené starší sady
    cards = data.get("cards", [])
    sources = data.get("sources", [])
    project = data.get("project", "")
    for c in cards:
        resolve_card_source(c, sources, project)

    return data

@app.delete("/api/flashcards/{filename}")
async def delete_flashcards(filename: str):
    file_path = os.path.join(FLASHCARDS_DIR, filename)
    if os.path.exists(file_path):
        os.remove(file_path)
        await send_log(f"🗑️ Smazána sada kartiček: {filename}")
        return {"status": "success"}
    raise HTTPException(status_code=404, detail="Soubor nenalezen.")

# =========================================================================
# TESTOVÉ OTÁZKY (PRACTICE TESTS)
# =========================================================================
from test_service import (
    TestStorageManager,
    generate_practice_test,
    generate_more_test_questions,
    evaluate_open_answer,
)

test_storage = TestStorageManager(TESTS_DIR)

@app.post("/api/tests/generate")
async def generate_test_endpoint(payload: dict = Body(...)):
    project = payload.get("project", "")
    questions = payload.get("questions", [])
    categories = payload.get("categories", [])
    categories_map = payload.get("categories_map", {})
    count = int(payload.get("count", 10))
    question_types = payload.get("question_types", ["single_choice", "multi_choice"])
    difficulty = payload.get("difficulty", "normal")
    mode = payload.get("mode", "instant")
    custom_prompt = payload.get("prompt", "")
    gemini_model = payload.get("gemini_model", "gemini-3.6-flash")

    if not project:
        raise HTTPException(status_code=400, detail="Chybí název projektu.")
    if isinstance(questions, str):
        questions = [questions] if questions.strip() else []
    if isinstance(categories, str):
        categories = [categories] if categories.strip() else []

    try:
        test_data, filename = await generate_practice_test(
            project=project,
            questions=questions,
            count=count,
            question_types=question_types,
            difficulty=difficulty,
            mode=mode,
            custom_prompt=custom_prompt,
            gemini_model=gemini_model,
            tests_dir=TESTS_DIR,
            rag_query_fn=query_rag_context_with_sources,
            gemini_call_fn=call_gemini_with_retries,
            log_fn=send_log,
            categories=categories,
            categories_map=categories_map,
        )
        return {**test_data, "filename": filename}
    except Exception as e:
        await send_log(f"❌ Selhalo generování testu: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/tests/generate-more")
async def generate_more_tests_endpoint(payload: dict = Body(...)):
    previous_test_id = payload.get("previous_test_id", "")
    project = payload.get("project", "")
    count = int(payload.get("count", 5))
    difficulty_shift = payload.get("difficulty_shift", "same")
    focus_mistakes = bool(payload.get("focus_mistakes", True))
    gemini_model = payload.get("gemini_model", "gemini-3.6-flash")

    if not previous_test_id or not project:
        raise HTTPException(status_code=400, detail="Chybí identifikátor testu nebo projekt.")

    try:
        new_test, filename = await generate_more_test_questions(
            previous_test_id=previous_test_id,
            project=project,
            count=count,
            difficulty_shift=difficulty_shift,
            focus_mistakes=focus_mistakes,
            gemini_model=gemini_model,
            tests_dir=TESTS_DIR,
            rag_query_fn=query_rag_context_with_sources,
            gemini_call_fn=call_gemini_with_retries,
            log_fn=send_log,
        )
        return {**new_test, "filename": filename}
    except Exception as e:
        await send_log(f"❌ Selhalo dogenerování otázek testu: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/tests")
async def list_tests_endpoint(project: str = ""):
    try:
        tests = test_storage.list_tests(project=project)
        return {"tests": tests}
    except Exception as e:
        return {"tests": [], "error": str(e)}

@app.get("/api/tests/{filename}")
async def get_test_endpoint(filename: str):
    data = test_storage.get_test(filename)
    if not data:
        raise HTTPException(status_code=404, detail="Test nebyl nalezen.")
    return data

@app.post("/api/tests/{filename}/result")
async def save_test_result_endpoint(filename: str, payload: dict = Body(...)):
    updated = test_storage.save_test_result(filename, payload)
    if not updated:
        raise HTTPException(status_code=404, detail="Test nebyl nalezen.")
    return {"status": "success", "test": updated}

@app.delete("/api/tests/{filename}")
async def delete_test_endpoint(filename: str):
    success = test_storage.delete_test(filename)
    if success:
        await send_log(f"🗑️ Smazán test: {filename}")
        return {"status": "success"}
    raise HTTPException(status_code=404, detail="Test nebyl nalezen.")

@app.post("/api/tests/evaluate-open-answer")
async def evaluate_open_answer_endpoint(payload: dict = Body(...)):
    user_answer = payload.get("user_answer", "")
    model_answer = payload.get("model_answer", "")
    key_points = payload.get("key_points", [])
    if not isinstance(key_points, list):
        key_points = []
    result = evaluate_open_answer(user_answer, model_answer, key_points)
    return result

# =========================================================================
# NOVÉ MODULY: GROUNDED CHAT & VÝUKOVÁ LEKCE OD A DO Z
# =========================================================================
from chat_service import (
    get_project_messages,
    save_message,
    clear_project_messages,
    export_project_chat_markdown,
    export_thread_chat_markdown,
    stream_grounded_chat,
    list_threads,
    create_thread,
    get_thread,
    update_thread,
    toggle_thread_pin,
    delete_thread,
    get_thread_messages,
    get_lesson,
    list_lessons,
    delete_lesson,
)
from lesson_service import generate_lesson_package

# --- 1. PROJEKTOVÝ GROUNDED CHAT ---
@app.post("/api/chat/completions")
async def chat_completions_endpoint(payload: dict = Body(...)):
    project = payload.get("project")
    message = payload.get("message")
    model = payload.get("model", "gemini-3.6-flash")
    custom_sys = payload.get("system_prompt", "")
    thread_id = payload.get("thread_id")

    if not project or not message:
        raise HTTPException(status_code=400, detail="Chybí projekt nebo text zprávy.")

    safe_proj = sanitize_name(project)
    await send_log(f"💬 Chat dotaz ({safe_proj}): '{message[:50]}...'")

    return StreamingResponse(
        stream_grounded_chat(
            project_id=safe_proj,
            user_message=message,
            model=model,
            custom_system_prompt=custom_sys,
            thread_id=thread_id,
        ),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )

# --- SPRÁVA CHATOVÝCH VLÁKEN (THREADS) ---

@app.get("/api/chat/threads")
async def get_chat_threads_endpoint(project_id: Optional[str] = None, q: Optional[str] = None):
    safe_proj = sanitize_name(project_id) if project_id and project_id != "__all__" else None
    threads = list_threads(project_id=safe_proj, search_query=q)
    return {"threads": threads}


@app.post("/api/chat/threads")
async def create_chat_thread_endpoint(payload: dict = Body(...)):
    project = payload.get("project_id") or payload.get("project")
    if not project:
        raise HTTPException(status_code=400, detail="Chybí identifikátor projektu.")
    title = payload.get("title")
    thread_id = payload.get("id")
    safe_proj = sanitize_name(project)
    thread = create_thread(project_id=safe_proj, title=title, thread_id=thread_id)
    return {"status": "success", "thread": thread}


@app.get("/api/chat/threads/{thread_id}")
async def get_chat_thread_detail_endpoint(thread_id: str):
    thread = get_thread(thread_id)
    if not thread:
        raise HTTPException(status_code=404, detail="Konverzace nenalezena.")
    messages = get_thread_messages(thread_id)
    return {"thread": thread, "messages": messages}


@app.patch("/api/chat/threads/{thread_id}")
async def update_chat_thread_endpoint(thread_id: str, payload: dict = Body(...)):
    title = payload.get("title")
    is_pinned = payload.get("is_pinned")
    updated = update_thread(thread_id, title=title, is_pinned=is_pinned)
    if not updated:
        raise HTTPException(status_code=404, detail="Konverzace nenalezena.")
    return {"status": "success", "thread": updated}


@app.post("/api/chat/threads/{thread_id}/pin")
async def toggle_chat_thread_pin_endpoint(thread_id: str):
    updated = toggle_thread_pin(thread_id)
    if not updated:
        raise HTTPException(status_code=404, detail="Konverzace nenalezena.")
    return {"status": "success", "thread": updated}


@app.delete("/api/chat/threads/{thread_id}")
async def delete_chat_thread_endpoint(thread_id: str):
    success = delete_thread(thread_id)
    return {"status": "success", "deleted": success}


@app.get("/api/chat/threads/{thread_id}/export")
async def export_chat_thread_endpoint(thread_id: str):
    thread = get_thread(thread_id)
    if not thread:
        raise HTTPException(status_code=404, detail="Konverzace nenalezena.")
    md_content = export_thread_chat_markdown(thread_id)
    clean_title = re.sub(r"[^a-zA-Z0-9_-]", "_", thread["title"][:30])
    filename = f"chat_{clean_title}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.md"
    from fastapi.responses import Response
    return Response(
        content=md_content,
        media_type="text/markdown; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/api/projects/{project_id}/messages")
async def get_project_chat_messages(project_id: str, thread_id: Optional[str] = None):
    safe_proj = sanitize_name(project_id)
    messages = get_project_messages(safe_proj, thread_id=thread_id)
    return {"project": safe_proj, "messages": messages}

@app.delete("/api/projects/{project_id}/messages")
async def clear_project_chat(project_id: str):
    safe_proj = sanitize_name(project_id)
    clear_project_messages(safe_proj)
    await send_log(f"🗑️ Historie chatu pro projekt '{safe_proj}' byla vyčištěna.")
    return {"status": "success", "project": safe_proj}

@app.get("/api/projects/{project_id}/chat/export")
async def export_chat_history(project_id: str, thread_id: Optional[str] = None):
    safe_proj = sanitize_name(project_id)
    md_content = export_project_chat_markdown(safe_proj, thread_id=thread_id)
    filename = f"chat_{safe_proj}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.md"
    from fastapi.responses import Response
    return Response(
        content=md_content,
        media_type="text/markdown; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )

# --- SPRÁVA PLÁNOVAČE ZKOUŠKY (EXAM PLANNER) ---
PLANNER_FILENAME = "exam_planner.json"

@app.get("/api/projects/{project_id}/planner")
async def get_project_planner(project_id: str):
    safe_proj = sanitize_name(project_id)
    proj_dir = os.path.join(UPLOAD_DIR, safe_proj)
    planner_file = os.path.join(proj_dir, PLANNER_FILENAME)

    default_planner = {
        "examDate": "",
        "startDate": "",
        "revisionDays": 14,
        "questions": []
    }

    if not os.path.exists(planner_file):
        return {"project": safe_proj, "planner": default_planner}

    try:
        with open(planner_file, "r", encoding="utf-8") as f:
            data = json.load(f)
            return {"project": safe_proj, "planner": data}
    except Exception as e:
        await send_log(f"⚠️ Chyba při čtení plánovače zkoušky ({safe_proj}): {str(e)}")
        return {"project": safe_proj, "planner": default_planner}

@app.post("/api/projects/{project_id}/planner")
async def save_project_planner(project_id: str, payload: dict = Body(...)):
    safe_proj = sanitize_name(project_id)
    proj_dir = os.path.join(UPLOAD_DIR, safe_proj)
    os.makedirs(proj_dir, exist_ok=True)
    planner_file = os.path.join(proj_dir, PLANNER_FILENAME)

    planner_data = payload.get("planner") if "planner" in payload else payload

    clean_data = {
        "examDate": str(planner_data.get("examDate", "") or ""),
        "startDate": str(planner_data.get("startDate", "") or ""),
        "revisionDays": int(planner_data.get("revisionDays", 14) or 14),
        "questions": planner_data.get("questions", [])
    }

    try:
        with open(planner_file, "w", encoding="utf-8") as f:
            json.dump(clean_data, f, ensure_ascii=False, indent=2)
        await send_log(f"💾 Plánovač zkoušky pro projekt '{safe_proj}' úspěšně uložen ({len(clean_data['questions'])} otázek).")
        return {"status": "success", "project": safe_proj, "planner": clean_data}
    except Exception as e:
        await send_log(f"❌ Chyba při ukládání plánovače zkoušky ({safe_proj}): {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/projects/{project_id}/questions")
async def get_project_questions(project_id: str):
    safe_proj = sanitize_name(project_id)
    proj_dir = os.path.join(UPLOAD_DIR, safe_proj)
    planner_file = os.path.join(proj_dir, PLANNER_FILENAME)

    if not os.path.exists(planner_file):
        return {"project": safe_proj, "questions": []}

    try:
        with open(planner_file, "r", encoding="utf-8") as f:
            data = json.load(f)
            return {"project": safe_proj, "questions": data.get("questions", [])}
    except Exception as e:
        await send_log(f"⚠️ Chyba při čtení otázek projektu ({safe_proj}): {str(e)}")
        return {"project": safe_proj, "questions": []}

@app.post("/api/projects/{project_id}/questions")
async def save_project_questions(project_id: str, payload: dict = Body(...)):
    safe_proj = sanitize_name(project_id)
    proj_dir = os.path.join(UPLOAD_DIR, safe_proj)
    os.makedirs(proj_dir, exist_ok=True)
    planner_file = os.path.join(proj_dir, PLANNER_FILENAME)

    questions = payload.get("questions", [])
    if not isinstance(questions, list):
        raise HTTPException(status_code=400, detail="Otázky musí být seznam.")

    current_planner = {
        "examDate": "",
        "startDate": "",
        "revisionDays": 14,
        "questions": []
    }
    if os.path.exists(planner_file):
        try:
            with open(planner_file, "r", encoding="utf-8") as f:
                loaded = json.load(f)
                if isinstance(loaded, dict):
                    current_planner = loaded
        except Exception:
            pass

    current_planner["questions"] = questions

    try:
        with open(planner_file, "w", encoding="utf-8") as f:
            json.dump(current_planner, f, ensure_ascii=False, indent=2)
        await send_log(f"💾 Otázky pro projekt '{safe_proj}' úspěšně uloženy ({len(questions)} otázek).")
        return {"status": "success", "project": safe_proj, "questions": questions}
    except Exception as e:
        await send_log(f"❌ Chyba při ukládání otázek projektu ({safe_proj}): {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

# --- 2. VÝUKOVÁ LEKCE OD A DO Z (EDUCATIONAL LECTURE GENERATOR) ---
@app.post("/api/lessons/generate")
async def generate_lesson_endpoint(
    project_name: Optional[str] = Form(None),
    title: str = Form(...),
    target_language: str = Form("Čeština"),
    gemini_model: str = Form("gemini-3.6-flash"),
    tts_provider: str = Form("openai"),
    tts_voice: str = Form("onyx"),
    files: List[UploadFile] = File(...),
):
    if not title.strip():
        raise HTTPException(status_code=400, detail="Chybí název lekce.")
    if not files:
        raise HTTPException(status_code=400, detail="Musíte nahrát alespoň jeden soubor.")

    # Pokud není explicitně zadán název projektu, vygenerujeme ho z názvu lekce
    raw_proj = project_name.strip() if (project_name and project_name.strip()) else f"lekce_{title}"
    safe_proj = sanitize_name(raw_proj)

    # 1. Založení nového izolovaného projektu/složky
    proj_dir = os.path.join(UPLOAD_DIR, safe_proj)
    os.makedirs(proj_dir, exist_ok=True)
    await send_log(f"🎓 Zahajuji tvorbu výukové lekce od A do Z: '{title}' (Projekt: {safe_proj})")

    # 2. Uložení nahraných souborů na disk
    saved_file_tuples: List[Tuple[str, str]] = []
    for file in files:
        safe_fname = "".join([c for c in file.filename if c.isalnum() or c in (" ", ".", "_", "-")]).strip()
        fpath = os.path.join(proj_dir, safe_fname)
        with open(fpath, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)
        saved_file_tuples.append((fpath, safe_fname))

    # Callback pro rozesílání progress událostí do SSE
    async def progress_notifier(evt_data: dict):
        await publish_event("lesson_progress", evt_data)

    try:
        lesson_result = await generate_lesson_package(
            project_id=safe_proj,
            lesson_title=title,
            target_language=target_language,
            file_paths=saved_file_tuples,
            gemini_model=gemini_model,
            tts_provider=tts_provider,
            tts_voice=tts_voice,
            progress_callback=progress_notifier,
        )
        return lesson_result
    except Exception as e:
        friendly = friendly_api_error(e, "Gemini")
        await send_log(f"❌ Chyba při generování výukové lekce: {friendly}")
        raise HTTPException(status_code=500, detail=friendly)

@app.get("/api/lessons")
async def list_lessons_endpoint():
    try:
        lessons = list_lessons()
        return {"lessons": lessons}
    except Exception as e:
        return {"lessons": [], "error": str(e)}

@app.get("/api/lessons/{project_id}")
async def get_lesson_endpoint(project_id: str):
    safe_proj = sanitize_name(project_id)
    lesson = get_lesson(safe_proj)
    if not lesson:
        raise HTTPException(status_code=404, detail="Výuková lekce nenalezena.")
    return {"lesson": lesson}

@app.delete("/api/lessons/{project_id}")
async def delete_lesson_endpoint(project_id: str):
    safe_proj = sanitize_name(project_id)
    success = delete_lesson(safe_proj)
    await send_log(f"🗑️ Výuková lekce '{safe_proj}' smazána z databáze.")
    return {"status": "success", "project": safe_proj}


# =========================================================================
# 3. MEDULINGO™ (INTEGROVANÝ DUOLINGO MÓD PRO MEDICÍNU)
# =========================================================================
from medulingo_service import MedulingoService, MEDULINGO_PODCAST_PROMPT

@app.get("/api/medulingo/overview")
async def medulingo_overview_endpoint(project: str = ""):
    if not project:
        raise HTTPException(status_code=400, detail="Chybí parametr projektu.")
    safe_proj = sanitize_name(project)
    service = MedulingoService(USER_DATA_DIR)
    return service.get_medulingo_overview(safe_proj)

@app.get("/api/medulingo/question/{question_id}")
async def medulingo_question_detail_endpoint(question_id: str, project: str = ""):
    if not project:
        raise HTTPException(status_code=400, detail="Chybí parametr projektu.")
    safe_proj = sanitize_name(project)
    service = MedulingoService(USER_DATA_DIR)
    return service.get_question_path_content(safe_proj, question_id)

@app.post("/api/medulingo/generate-pack")
async def medulingo_generate_pack_endpoint(payload: dict = Body(...)):
    project = payload.get("project")
    question_id = payload.get("question_id")
    question_title = payload.get("question_title", "")
    modules = payload.get("modules", ["notes", "cards", "podcast", "test"])
    gemini_model = payload.get("gemini_model", "gemini-3.6-flash")
    tts_provider = payload.get("tts_provider", "openai")
    tts_voice = payload.get("tts_voice", "onyx")

    if not project or (not question_id and not question_title):
        raise HTTPException(status_code=400, detail="Chybí identifikátor otázky nebo projekt.")

    safe_proj = sanitize_name(project)
    service = MedulingoService(USER_DATA_DIR)

    planner = service._get_planner_data(safe_proj)
    target_q = None
    for q in planner.get("questions", []):
        if q.get("id") == question_id or q.get("title") == question_title or str(q.get("number")) == str(question_id):
            target_q = q
            break

    q_title = target_q.get("title", question_title) if target_q else question_title
    q_topic = target_q.get("topic", "Všeobecné") if target_q else "Všeobecné"
    q_num = target_q.get("number", "1") if target_q else "1"

    await send_log(f"🦉 [Medulingo] Zahajuji on-demand generování pro: '{q_title}' ({', '.join(modules)})...")
    results = {}

    # 1. STUDIJNÍ TEXT
    if "notes" in modules:
        try:
            await send_log(f"🦉 [Medulingo] 1/4 Generuji strukturovaný studijní text pro '{q_title}'...")
            notes_md, sources, n_file = await internal_generate_notes(
                question=q_title,
                project=safe_proj,
                custom_prompt="",
                gemini_model=gemini_model,
            )
            results["notes"] = {"status": "ok", "filename": n_file}
            if target_q:
                target_q["notesStatus"] = "Done"
        except Exception as e:
            await send_log(f"⚠️ [Medulingo] Chyba generování textu: {e}")
            results["notes"] = {"status": "error", "error": str(e)}

    # 2. KARTIČKY (FLASHCARDS)
    if "cards" in modules:
        try:
            await send_log(f"🦉 [Medulingo] 2/4 Generuji sérii flashcards pro '{q_title}'...")
            cards_data, c_file = await internal_generate_flashcards(
                question=q_title,
                project=safe_proj,
                count=10,
                custom_prompt="",
                gemini_model=gemini_model,
                force_regenerate=True,
            )
            results["cards"] = {"status": "ok", "filename": c_file, "count": len(cards_data.get("cards", []))}
            if target_q:
                target_q["cardsStatus"] = "Done"
        except Exception as e:
            await send_log(f"⚠️ [Medulingo] Chyba generování kartiček: {e}")
            results["cards"] = {"status": "error", "error": str(e)}

    # 3. KRÁTKÝ PODCAST
    if "podcast" in modules:
        try:
            await send_log(f"🦉 [Medulingo] 3/4 Vytvářím úderný Medulingo minipodcast pro '{q_title}'...")
            pod_prompt = MEDULINGO_PODCAST_PROMPT.replace("{QUESTION}", q_title)
            script, _ = await internal_generate_script(
                question=q_title,
                custom_prompt=pod_prompt,
                provider=tts_provider,
                project=safe_proj,
                gemini_model=gemini_model,
            )
            safe_q_name = sanitize_name(q_title[:30])
            audio_base_filename = f"{safe_proj}_Q{q_num}_{safe_q_name}"
            audio_url, audio_filename, _ = await internal_generate_audio(
                script=script,
                filename=audio_base_filename,
                provider=tts_provider,
                voice=tts_voice,
                output_format="mp3",
                question_title=f"Medulingo: {q_title}",
            )
            try:
                await create_srt_for_audio(script, audio_filename)
            except Exception:
                pass
            results["podcast"] = {"status": "ok", "audio_url": audio_url, "filename": audio_filename}
        except Exception as e:
            await send_log(f"⚠️ [Medulingo] Chyba generování podcastu: {e}")
            results["podcast"] = {"status": "error", "error": str(e)}

    # 4. FINÁLNÍ TEST
    if "test" in modules:
        try:
            await send_log(f"🦉 [Medulingo] 4/4 Sestavuji finální test k otázce '{q_title}'...")
            test_data, t_file = await generate_practice_test(
                project=safe_proj,
                questions=[q_title],
                count=4,
                question_types=["single_choice", "multi_choice", "case_study"],
                difficulty="normal",
                mode="instant",
                custom_prompt="",
                gemini_model=gemini_model,
                tests_dir=TESTS_DIR,
                rag_query_fn=query_rag_context_with_sources,
                gemini_call_fn=call_gemini_with_retries,
                log_fn=send_log,
                categories=[q_topic],
            )
            results["test"] = {"status": "ok", "filename": t_file, "count": len(test_data.get("questions", []))}
        except Exception as e:
            await send_log(f"⚠️ [Medulingo] Chyba generování testu: {e}")
            results["test"] = {"status": "error", "error": str(e)}

    if target_q:
        service._save_planner_data(safe_proj, planner)

    await send_log(f"🎉 [Medulingo] Balíček pro '{q_title}' byl úspěšně připraven!")

    fresh_details = service.get_question_path_content(safe_proj, target_q.get("id", question_id) if target_q else question_id)
    return {
        "status": "success",
        "results": results,
        "question_details": fresh_details,
    }

@app.post("/api/medulingo/complete")
async def medulingo_complete_endpoint(payload: dict = Body(...)):
    project = payload.get("project")
    question_id = payload.get("question_id")
    grade = payload.get("grade", "A")
    completed = payload.get("completed", True)

    if not project or not question_id:
        raise HTTPException(status_code=400, detail="Chybí projekt nebo question_id.")

    safe_proj = sanitize_name(project)
    service = MedulingoService(USER_DATA_DIR)
    res = service.complete_question(safe_proj, question_id, grade, completed=completed)
    status_str = f"úspěšně splněna se známkou {grade}" if completed else "označena jako nesplněná"
    await send_log(f"🏆 [Medulingo] Otázka '{question_id}' {status_str}!")
    return res


# =========================================================================
# ENDPOINTY PRO NASTAVENÍ A VLASTNÍ API KLÍČE (BYOK)
# =========================================================================

@app.get("/api/settings")
async def get_settings():
    cfg = load_user_config()
    g_key = (cfg.get("gemini_api_key") or os.getenv("GEMINI_API_KEY") or "").strip()
    o_key = (cfg.get("openai_api_key") or os.getenv("OPENAI_API_KEY") or "").strip()
    e_key = (cfg.get("elevenlabs_api_key") or os.getenv("ELEVENLABS_API_KEY") or "").strip()

    def mask(k: str) -> str:
        if not k:
            return ""
        if len(k) <= 8:
            return "****"
        return k[:4] + "..." + k[-4:]

    return {
        "gemini_configured": bool(g_key),
        "gemini_masked": mask(g_key),
        "openai_configured": bool(o_key),
        "openai_masked": mask(o_key),
        "elevenlabs_configured": bool(e_key),
        "elevenlabs_masked": mask(e_key),
        "user_data_dir": USER_DATA_DIR,
        "is_desktop": IS_FROZEN,
    }


@app.post("/api/settings")
async def save_settings(payload: dict[str, Any] = Body(...)):
    cfg = load_user_config()

    if "gemini_api_key" in payload:
        val = str(payload["gemini_api_key"]).strip()
        if "..." not in val:
            cfg["gemini_api_key"] = val
    if "openai_api_key" in payload:
        val = str(payload["openai_api_key"]).strip()
        if "..." not in val:
            cfg["openai_api_key"] = val
    if "elevenlabs_api_key" in payload:
        val = str(payload["elevenlabs_api_key"]).strip()
        if "..." not in val:
            cfg["elevenlabs_api_key"] = val

    save_user_config(cfg)
    await send_log("⚙️ Nastavení API klíčů bylo úspěšně uloženo.")
    return {"status": "success", "message": "Nastavení bylo úspěšně uloženo."}


@app.post("/api/settings/test-key")
async def test_api_key(payload: dict[str, Any] = Body(...)):
    provider = payload.get("provider", "gemini")
    key = str(payload.get("key") or "").strip()

    if not key or "..." in key:
        if provider == "gemini":
            key = get_gemini_api_key()
        elif provider == "openai":
            key = get_openai_api_key()
        elif provider == "elevenlabs":
            key = get_elevenlabs_api_key()

    if not key:
        return {"valid": False, "message": f"Klíč pro {provider.upper()} není zadán."}

    try:
        if provider == "gemini":
            test_client = genai.Client(api_key=key)
            test_model = str(payload.get("model") or "gemini-3.6-flash").strip()
            # Rychlé ověření modelu s automatickým fallbackem
            try:
                await asyncio.to_thread(
                    test_client.models.generate_content,
                    model=test_model,
                    contents="ping",
                    config=types.GenerateContentConfig(max_output_tokens=10),
                )
            except Exception as test_err:
                err_str = str(test_err).lower()
                if ("404" in err_str or "not_found" in err_str) and test_model != "gemini-flash-latest":
                    await asyncio.to_thread(
                        test_client.models.generate_content,
                        model="gemini-flash-latest",
                        contents="ping",
                        config=types.GenerateContentConfig(max_output_tokens=10),
                    )
                    test_model = "gemini-flash-latest"
                else:
                    raise test_err
            return {"valid": True, "message": f"Google Gemini API klíč je platný a připraven k použití ({test_model})!"}

        elif provider == "openai":
            test_client = OpenAI(api_key=key)
            await asyncio.to_thread(test_client.models.list)
            return {"valid": True, "message": "OpenAI API klíč je platný a ověřen!"}

        elif provider == "elevenlabs":
            async with httpx.AsyncClient(timeout=10) as http_client:
                res = await http_client.get(
                    "https://api.elevenlabs.io/v1/user",
                    headers={"xi-api-key": key},
                )
                if res.status_code == 200:
                    data = res.json()
                    char_count = data.get("subscription", {}).get("character_count", 0)
                    char_limit = data.get("subscription", {}).get("character_limit", 0)
                    return {
                        "valid": True,
                        "message": f"ElevenLabs klíč je platný! Využito: {char_count:,} z {char_limit:,} znaků.",
                    }
                else:
                    return {"valid": False, "message": f"ElevenLabs vrátil chybu {res.status_code}: {res.text[:100]}"}

        else:
            return {"valid": False, "message": f"Neznámý poskytovatel: {provider}"}

    except Exception as e:
        print(f"⚠️ Test klíče selhal pro {provider}: {e}")
        if provider == "gemini":
            friendly = friendly_api_error(e, "Gemini")
            detail = extract_gemini_error_detail(e)
            msg = friendly if friendly != str(e) else f"Chyba ověření ({detail})"
            return {"valid": False, "message": msg}
        return {"valid": False, "message": f"Chyba ověření: {str(e)[:150]}"}


@app.post("/api/settings/open-data-folder")
async def open_data_folder():
    os.makedirs(USER_DATA_DIR, exist_ok=True)
    try:
        if sys.platform == "darwin":
            subprocess.Popen(["open", USER_DATA_DIR])
        elif sys.platform == "win32":
            os.startfile(USER_DATA_DIR)
        else:
            subprocess.Popen(["xdg-open", USER_DATA_DIR])
        return {"status": "success", "path": USER_DATA_DIR}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Nelze otevřít složku: {e}")


# --- TISKOVÝ SERVIS (DEDIKOVANÝ NÁHLED A EXPORT DO PDF) ---
_print_jobs: dict[str, dict[str, Any]] = {}

@app.post("/api/print/prepare")
async def prepare_print_job(request: Request, payload: dict = Body(...)):
    """
    Přijme vygenerovaný HTML obsah a metadata k tisku.
    Uloží data do dočasné mezipaměti a vrátí URL adresu čistého tiskového náhledu.
    Pokud je požadováno (auto_open_browser), otevře odkaz v systémovém prohlížeči.
    """
    doc_id = uuid.uuid4().hex[:10]
    title = str(payload.get("title", "")).strip() or "Studijní dokument"
    html_content = str(payload.get("html", "")).strip()
    project = str(payload.get("project", "")).strip()
    auto_open = bool(payload.get("auto_open_browser", False))
    now_ts = datetime.now().timestamp()

    _print_jobs[doc_id] = {
        "title": title,
        "html": html_content,
        "project": project,
        "created_at": now_ts,
    }

    # Úklid úloh starších než 2 hodiny
    for k in list(_print_jobs.keys()):
        if now_ts - _print_jobs[k].get("created_at", 0) > 7200:
            _print_jobs.pop(k, None)

    base_url = str(request.base_url).rstrip("/")
    full_url = f"{base_url}/print_preview/{doc_id}"

    if auto_open:
        try:
            webbrowser.open(full_url)
        except Exception as e:
            print(f"⚠️ Nepodařilo se automaticky otevřít systémový prohlížeč pro tisk: {e}")

    return {"status": "ok", "doc_id": doc_id, "url": full_url}


@app.get("/print_preview/{doc_id}", response_class=HTMLResponse)
async def view_print_preview_page(doc_id: str):
    job = _print_jobs.get(doc_id)
    if not job:
        raise HTTPException(status_code=404, detail="Tiskový dokument nebyl nalezen nebo vypršela jeho platnost.")

    safe_title = html_lib.escape(job["title"])
    safe_project = html_lib.escape(job["project"] or "Hlavní projekt")
    date_str = datetime.now().strftime("%d.%m.%Y %H:%M")
    rendered_body = job["html"]

    html = f"""<!DOCTYPE html>
<html lang="cs">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>{safe_title} | AI MedStudio Tisk</title>
    <style>
        *, *::before, *::after {{
            box-sizing: border-box;
        }}
        body {{
            margin: 0;
            padding: 0;
            background-color: #f8fafc;
            color: #0f172a;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            line-height: 1.6;
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
        }}
        .print-toolbar {{
            position: sticky;
            top: 0;
            z-index: 1000;
            background: #0f172a;
            color: #f8fafc;
            padding: 12px 24px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            box-shadow: 0 4px 12px rgba(0,0,0,0.15);
            font-size: 14px;
        }}
        .print-toolbar-title {{
            font-weight: 700;
            display: flex;
            align-items: center;
            gap: 8px;
        }}
        .print-btn-primary {{
            background: #059669;
            color: white;
            border: none;
            padding: 8px 16px;
            border-radius: 8px;
            font-weight: 700;
            cursor: pointer;
            font-size: 13px;
            display: inline-flex;
            align-items: center;
            gap: 6px;
            transition: background 0.15s ease;
        }}
        .print-btn-primary:hover {{
            background: #047857;
        }}
        .print-btn-secondary {{
            background: #334155;
            color: #cbd5e1;
            border: none;
            padding: 8px 14px;
            border-radius: 8px;
            font-weight: 600;
            cursor: pointer;
            font-size: 13px;
            transition: background 0.15s ease;
        }}
        .print-btn-secondary:hover {{
            background: #475569;
            color: white;
        }}
        .page-sheet {{
            max-width: 860px;
            margin: 24px auto;
            background: white;
            padding: 48px;
            border-radius: 8px;
            box-shadow: 0 4px 20px rgba(0,0,0,0.06);
            border: 1px solid #e2e8f0;
        }}
        .doc-header {{
            border-bottom: 2px solid #0f172a;
            padding-bottom: 16px;
            margin-bottom: 28px;
        }}
        .doc-badge {{
            display: inline-block;
            font-size: 11px;
            font-weight: 800;
            text-transform: uppercase;
            letter-spacing: 0.05em;
            color: #059669;
            margin-bottom: 6px;
        }}
        .doc-title {{
            font-size: 26px;
            font-weight: 800;
            margin: 0 0 8px 0;
            color: #0f172a;
            line-height: 1.25;
        }}
        .doc-meta {{
            font-size: 12px;
            color: #64748b;
            display: flex;
            gap: 16px;
            flex-wrap: wrap;
        }}
        /* Typography */
        .markdown-content h1 {{ font-size: 20px; font-weight: 800; margin: 24px 0 12px 0; border-bottom: 1px solid #cbd5e1; padding-bottom: 6px; page-break-after: avoid; color: #0f172a; }}
        .markdown-content h2 {{ font-size: 17px; font-weight: 700; margin: 20px 0 10px 0; page-break-after: avoid; color: #1e293b; }}
        .markdown-content h3 {{ font-size: 15px; font-weight: 700; margin: 16px 0 8px 0; page-break-after: avoid; color: #334155; }}
        .markdown-content h4 {{ font-size: 14px; font-weight: 700; margin: 14px 0 6px 0; page-break-after: avoid; color: #475569; }}
        .markdown-content p {{ margin: 0 0 12px 0; }}
        .markdown-content ul, .markdown-content ol {{ margin: 0 0 14px 0; padding-left: 24px; }}
        .markdown-content li {{ margin-bottom: 6px; }}
        .markdown-content table {{
            width: 100%;
            border-collapse: collapse;
            margin: 16px 0;
            font-size: 12.5px;
            page-break-inside: avoid;
        }}
        .markdown-content th, .markdown-content td {{
            border: 1px solid #cbd5e1;
            padding: 8px 10px;
            text-align: left;
            vertical-align: top;
        }}
        .markdown-content th {{
            background-color: #f1f5f9;
            font-weight: 700;
            color: #0f172a;
        }}
        .markdown-content tr:nth-child(even) {{
            background-color: #f8fafc;
        }}
        .markdown-content blockquote {{
            border-left: 4px solid #0ea5e9;
            margin: 14px 0;
            padding: 8px 16px;
            background: #f0f9ff;
            color: #0369a1;
            border-radius: 0 6px 6px 0;
        }}
        .markdown-content pre, .markdown-content code {{
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
            font-size: 12px;
        }}
        .markdown-content code {{
            background: #f1f5f9;
            color: #0f172a;
            padding: 2px 5px;
            border-radius: 4px;
            border: 1px solid #e2e8f0;
        }}
        .markdown-content pre {{
            background: #f8fafc;
            border: 1px solid #e2e8f0;
            padding: 12px;
            border-radius: 6px;
            overflow-x: auto;
            page-break-inside: avoid;
        }}
        .markdown-content sup {{
            font-weight: 700;
            color: #0369a1;
            font-size: 9px;
            padding: 1px 4px;
            background: #e0f2fe;
            border-radius: 3px;
            margin-left: 2px;
        }}
        .doc-footer {{
            margin-top: 40px;
            padding-top: 16px;
            border-top: 1px solid #e2e8f0;
            font-size: 11px;
            color: #94a3b8;
            display: flex;
            justify-content: space-between;
        }}

        @media print {{
            body {{
                background: white !important;
                color: black !important;
            }}
            .print-toolbar {{
                display: none !important;
            }}
            .page-sheet {{
                max-width: 100% !important;
                margin: 0 !important;
                padding: 0 !important;
                border: none !important;
                box-shadow: none !important;
            }}
            @page {{
                size: A4;
                margin: 16mm 14mm 16mm 14mm;
            }}
            a {{
                text-decoration: none;
                color: inherit;
            }}
        }}
    </style>
</head>
<body>
    <div class="print-toolbar">
        <div class="print-toolbar-title">
            <span>🩺 AI MedStudio</span>
            <span style="opacity: 0.5;">|</span>
            <span style="font-weight: 500; font-size: 13px;">Tiskový náhled: {safe_title}</span>
        </div>
        <div style="display: flex; gap: 8px;">
            <button onclick="window.print()" class="print-btn-primary">
                <span>🖨️</span> Vytisknout / Uložit do PDF
            </button>
            <button onclick="window.close()" class="print-btn-secondary">
                Zavřít
            </button>
        </div>
    </div>
    <div class="page-sheet">
        <header class="doc-header">
            <div class="doc-badge">AI MedStudio &bull; Studijní materiály</div>
            <h1 class="doc-title">{safe_title}</h1>
            <div class="doc-meta">
                <span><strong>Projekt:</strong> {safe_project}</span>
                <span><strong>Vygenerováno:</strong> {date_str}</span>
            </div>
        </header>
        <article class="markdown-content">
            {rendered_body}
        </article>
        <footer class="doc-footer">
            <span>AI MedStudio – Vytvořeno pro lékařskou fakultu (RAG Syntéza & Citace)</span>
            <span>Vytištěno: {date_str}</span>
        </footer>
    </div>
    <script>
        window.addEventListener('load', function() {{
            setTimeout(function() {{
                window.print();
            }}, 350);
        }});
    </script>
</body>
</html>"""
    return HTMLResponse(content=html)


app.mount("/uploads", StaticFiles(directory=UPLOAD_DIR), name="uploads")
app.mount("/audio", StaticFiles(directory=AUDIO_DIR), name="audio")
app.mount("/notes-files", StaticFiles(directory=NOTES_DIR), name="notes-files")
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=False)
