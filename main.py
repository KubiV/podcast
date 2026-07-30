import os
import glob
import shutil
import httpx
import asyncio
import json
import re
import uuid
from collections import deque
from dataclasses import dataclass, field
from typing import Any, List
from fastapi import FastAPI, HTTPException, Body, UploadFile, File, Form, BackgroundTasks
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
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

ai_client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))
openai_client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
ELEVENLABS_API_KEY = os.getenv("ELEVENLABS_API_KEY")

UPLOAD_DIR = "uploads"
AUDIO_DIR = "generated_audio"
DB_DIR = "chroma_db"
STATIC_DIR = "static"

for d in [UPLOAD_DIR, AUDIO_DIR, DB_DIR, STATIC_DIR]:
    os.makedirs(d, exist_ok=True)

chroma_client = chromadb.PersistentClient(path=DB_DIR)
LOG_HISTORY_LIMIT = 250
LOG_SUBSCRIBER_QUEUE_SIZE = 300
log_history: deque[str] = deque(maxlen=LOG_HISTORY_LIMIT)
log_subscribers: set[asyncio.Queue[tuple[str, dict[str, Any]]]] = set()


@dataclass
class BatchState:
    """Stav jedné běžící dávky pro konkrétní projekt."""

    batch_id: str
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

# --- UNIVERZÁLNÍ EXTRAKCE TEXTU ---
async def extract_text_from_file(file_path: str, filename: str) -> str:
    ext = filename.lower().split('.')[-1]
    full_text = ""
    
    if ext == "pdf":
        with pdfplumber.open(file_path) as pdf:
            total_pages = len(pdf.pages)
            for idx, page in enumerate(pdf.pages):
                if idx % 10 == 0: await asyncio.sleep(0.01) # Udržení asynchronicity
                text = page.extract_text()
                if text: full_text += text + "\n"
    
    elif ext == "docx":
        if docx is None: raise ImportError("Chybí knihovna python-docx")
        doc = docx.Document(file_path)
        for idx, para in enumerate(doc.paragraphs):
            if idx % 100 == 0: await asyncio.sleep(0.01)
            if para.text: full_text += para.text + "\n"
            
    elif ext == "pptx":
        if pptx is None: raise ImportError("Chybí knihovna python-pptx")
        prs = pptx.Presentation(file_path)
        for idx, slide in enumerate(prs.slides):
            if idx % 5 == 0: await asyncio.sleep(0.01)
            for shape in slide.shapes:
                if hasattr(shape, "text") and shape.text:
                    full_text += shape.text + "\n"
                    
    elif ext == "txt":
        with open(file_path, "r", encoding="utf-8") as f:
            full_text = f.read()
    else:
        raise ValueError(f"Nepodporovaný formát: {ext}")
        
    return full_text

# --- PRÁCE S MATERIÁLY (RAG) ---
def chunk_text(text: str, chunk_size: int = 1500, overlap: int = 300) -> list:
    chunks = []
    start = 0
    text_len = len(text)
    while start < text_len:
        end = min(start + chunk_size, text_len)
        chunks.append(text[start:end])
        if end == text_len:
            break
        start += chunk_size - overlap
    return chunks

async def index_file_to_chroma(file_path: str, filename: str, project_name: str):
    await send_log(f"📖 Extraktuji text z dokumentu: {filename} ({project_name})...")
    try:
        full_text = await extract_text_from_file(file_path, filename)
        
        if not full_text.strip():
            await send_log(f"⚠️ Dokument {filename} neobsahuje žádný strojově čitelný text.")
            return

        chunks = chunk_text(full_text)
        collection_name = f"proj_{sanitize_name(project_name)}"
        collection = chroma_client.get_or_create_collection(name=collection_name)
        
        ids = [f"{filename}_chunk_{i}" for i in range(len(chunks))]
        metadatas = [{"source": filename} for _ in range(len(chunks))]
        
        collection.add(documents=chunks, metadatas=metadatas, ids=ids)
        await send_log(f"✅ Dokument {filename} úspěšně zpracován ({len(chunks)} vektorů uloženo).")
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
        
        await send_log(f"🗑️ Soubor {filename} a jeho vektory byly z projektu smazány.")
        return {"status": "success"}
    raise HTTPException(status_code=404, detail="Soubor nenalezen.")

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


def is_retryable_gemini_error(error: Exception) -> bool:
    normalized_error = str(error).lower()
    return any(
        marker in normalized_error
        for marker in ("503", "unavailable", "429", "resource exhausted", "overloaded", "timeout")
    )

async def internal_generate_script(question: str, custom_prompt: str, provider: str, project: str, gemini_model: str):
    final_prompt = enrich_prompt_for_tts(custom_prompt, provider)
    safe_proj = sanitize_name(project)
    collection_name = f"proj_{safe_proj}"
    
    await send_log(f"🔍 RAG: Prohledávám databázi pro dotaz: '{question[:30]}...'")
    try:
        collection = chroma_client.get_collection(name=collection_name)
    except Exception:
        raise ValueError(f"Databáze pro projekt '{safe_proj}' neexistuje nebo je prázdná.")
    
    db_count = collection.count()
    if db_count == 0:
        raise ValueError("Databáze textů je prázdná. Nahrajte nejprve nějaká PDF do tohoto projektu.")
    
    n_results = min(25, db_count) 
    results = collection.query(
        query_texts=[question],
        n_results=n_results
    )
    
    if not results["documents"] or not results["documents"][0]:
        raise ValueError("V materiálech nebyly nalezeny žádné podklady k této otázce.")
        
    context_chunks = results["documents"][0]
    context_text = "\n\n...[pokračování textu]...\n\n".join(context_chunks)
    
    ukazka_textu = context_text[:150].replace('\n', ' ')
    await send_log(f"📄 NALEZENÝ TEXT (ukázka): {ukazka_textu}...")
    
    full_user_content = f"ZPRACOVÁVANÁ ZKOUŠKOVÁ OTÁZKA: {question}\n\n=== RELEVANTNÍ VÝTAŽEK ZE SKRIPT ===\n{context_text}\n=================================="
    
    await send_log(f"🤖 Kontext nalezen. Odesílám zadání do {gemini_model} API...")
    
    max_retries = 3
    for attempt in range(max_retries):
        try:
            # Knihovna Gemini je synchronní. Přesun do vlákna ponechá běžet
            # event loop, takže funguje live konzole i tlačítko Storno.
            response = await asyncio.to_thread(
                ai_client.models.generate_content,
                model=gemini_model,
                contents=[full_user_content],
                config=types.GenerateContentConfig(
                    system_instruction=final_prompt,
                    temperature=0.7,
                ),
            )
            return response.text, context_text
            
        except Exception as e:
            if is_retryable_gemini_error(e):
                if attempt < max_retries - 1:
                    wait_time = (attempt + 1) * 8 
                    await send_log(f"⚠️ API Přetížení (pokus {attempt + 1}/{max_retries}). Čekám {wait_time} s...")
                    await asyncio.sleep(wait_time)
                else:
                    raise ValueError(friendly_api_error(e, "Gemini")) from e
            else:
                raise

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
                        response = openai_client.audio.speech.create(
                            model="tts-1", voice=voice, input=chunk
                        )
                        return b"".join(response.iter_bytes())

                    final_audio_file.write(await asyncio.to_thread(create_openai_speech))

                elif provider == "elevenlabs":
                    if not ELEVENLABS_API_KEY:
                        raise ValueError("Chybí klíč ElevenLabs v .env")
                    headers = {"xi-api-key": ELEVENLABS_API_KEY, "Content-Type": "application/json"}
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
):
    batch = active_batches.get(project)
    if not batch or batch.batch_id != batch_id:
        return

    pending_question_indexes = [question.get("q_index") for question in questions]
    outcome = "completed"
    failed_message = None

    try:
        await send_log(f"🚀 Spouštím dávkové zpracování pro {len(questions)} otázek...")
        await send_batch_event(
            project,
            "started",
            batch_id,
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

            script, _ = await internal_generate_script(title, custom_prompt, provider, project, gemini_model)

            if batch.cancel_requested:
                await send_log("🛑 Dávkové zpracování zrušeno před tvorbou audia!")
                outcome = "cancelled"
                break

            await send_log(f"✅ Scénář vytvořen. Spouštím syntézu zvuku...")
            safe_filename = f"{project}_Q{question_index}_{title[:15]}"
            await internal_generate_audio(script, safe_filename, provider, voice, output_format, title)

            batch.completed_question_indexes.append(question_index)
            pending_question_indexes.remove(question_index)
            await send_batch_event(
                project,
                "question_completed",
                batch_id,
                question_index=question_index,
            )
            await send_log(f"🎉 Hotovo [{idx+1}/{len(questions)}].")
            await asyncio.sleep(1.5)

        if outcome == "completed":
            await send_log("🏁 Dávkové zpracování kompletně dokončeno!")
        elif outcome == "cancelled":
            await send_log("🏁 Dávkové zpracování bylo zrušeno. Nehotové otázky jsou připravené k novému spuštění.")
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
    gemini_model = payload.get("gemini_model", "gemini-3.5-flash")

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
    )
    return {"status": "started", "batch_id": batch_id}

@app.post("/api/generate-script")
async def generate_script(payload: dict = Body(...)):
    question = payload.get("question")
    custom_prompt = payload.get("prompt")
    provider = payload.get("provider", "openai")
    project = payload.get("project")
    gemini_model = payload.get("gemini_model", "gemini-3.5-flash")
    
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

app.mount("/audio", StaticFiles(directory=AUDIO_DIR), name="audio")
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=False)
