import os
import glob
import shutil
import httpx
import asyncio
import re
from fastapi import FastAPI, HTTPException, Body, UploadFile, File, BackgroundTasks
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
import pdfplumber
import chromadb
from dotenv import load_dotenv
from google import genai
from google.genai import types
from openai import OpenAI

# PRO TITULKY A VIDEO
try:
    from mutagen.mp3 import MP3
except ImportError:
    MP3 = None

try:
    import ffmpeg
except ImportError:
    ffmpeg = None

load_dotenv()

app = FastAPI()

ai_client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))
openai_client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
ELEVENLABS_API_KEY = os.getenv("ELEVENLABS_API_KEY")

UPLOAD_DIR = "uploads"
AUDIO_DIR = "generated_audio"
DB_DIR = "chroma_db"

os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(AUDIO_DIR, exist_ok=True)
os.makedirs(DB_DIR, exist_ok=True)

chroma_client = chromadb.PersistentClient(path=DB_DIR)
log_queue = asyncio.Queue()

async def send_log(message: str):
    await log_queue.put(message)
    print(f"[LOG] {message}")

@app.get("/api/logs")
async def stream_logs():
    async def event_generator():
        while True:
            log_msg = await log_queue.get()
            yield f"data: {log_msg}\n\n"
    return StreamingResponse(event_generator(), media_type="text/event-stream")


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

async def index_pdf_to_chroma(file_path: str, filename: str):
    await send_log(f"📖 Extraktuji a vektorizuji dokument: {filename}...")
    full_text = ""
    try:
        with pdfplumber.open(file_path) as pdf:
            total_pages = len(pdf.pages)
            for idx, page in enumerate(pdf.pages):
                if idx % 10 == 0 or idx == total_pages - 1:
                    await send_log(f"⏳ Čtení {filename}: strana {idx + 1}/{total_pages}")
                    await asyncio.sleep(0.01)
                
                page_text = page.extract_text()
                if page_text:
                    full_text += page_text + "\n"
                    
        chunks = chunk_text(full_text)
        collection = chroma_client.get_or_create_collection(name="studijni_materialy")
        
        ids = [f"{filename}_chunk_{i}" for i in range(len(chunks))]
        metadatas = [{"source": filename} for _ in range(len(chunks))]
        
        collection.add(
            documents=chunks,
            metadatas=metadatas,
            ids=ids
        )
        await send_log(f"✅ Dokument {filename} úspěšně zpracován ({len(chunks)} vektorů uloženo).")
    except Exception as e:
        await send_log(f"❌ Selhalo indexování souboru {filename}: {str(e)}")


@app.get("/api/files")
async def list_files():
    files = glob.glob(os.path.join(UPLOAD_DIR, "*.pdf"))
    return {"files": [os.path.basename(f) for f in files]}

@app.post("/api/files/upload")
async def upload_file(background_tasks: BackgroundTasks, file: UploadFile = File(...)):
    if not file.filename.endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Podporovány jsou pouze PDF.")
    
    file_path = os.path.join(UPLOAD_DIR, file.filename)
    with open(file_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)
        
    await send_log(f"📥 Soubor {file.filename} nahrán. Zahajuji vektorizaci na pozadí...")
    background_tasks.add_task(index_pdf_to_chroma, file_path, file.filename)
    return {"filename": file.filename}

@app.delete("/api/files/{filename}")
async def delete_file(filename: str):
    file_path = os.path.join(UPLOAD_DIR, filename)
    if os.path.exists(file_path):
        os.remove(file_path)
        
        collection = chroma_client.get_or_create_collection(name="studijni_materialy")
        collection.delete(where={"source": filename})
        
        await send_log(f"🗑️ Soubor {filename} a jeho vektory byly smazány.")
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

async def internal_generate_script(question: str, custom_prompt: str, provider: str):
    final_prompt = enrich_prompt_for_tts(custom_prompt, provider)
    
    await send_log(f"🔍 RAG: Prohledávám lokální databázi pro klíčové slovo: '{question}'")
    collection = chroma_client.get_or_create_collection(name="studijni_materialy")
    
    db_count = collection.count()
    if db_count == 0:
        raise ValueError("Databáze textů je prázdná. Nahrajte nejprve nějaká PDF.")
    
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
    
    await send_log(f"🤖 Kontext nalezen ({len(context_text)} znaků). Odesílám zadání do Gemini API...")
    
    max_retries = 3
    for attempt in range(max_retries):
        try:
            response = ai_client.models.generate_content(
                model='gemini-3.5-flash',
                contents=[full_user_content],
                config=types.GenerateContentConfig(
                    system_instruction=final_prompt,
                    temperature=0.7,
                )
            )
            return response.text, context_text
            
        except Exception as e:
            error_msg = str(e)
            if "503" in error_msg or "UNAVAILABLE" in error_msg or "429" in error_msg:
                if attempt < max_retries - 1:
                    wait_time = (attempt + 1) * 5 
                    await send_log(f"⚠️ API je přetížené (pokus {attempt + 1}/{max_retries}). Čekám {wait_time} sekund...")
                    await asyncio.sleep(wait_time)
                else:
                    raise ValueError("Servery Googlu jsou aktuálně zcela přetížené. Zkuste to prosím za pár minut.")
            else:
                raise e

async def create_srt_for_audio(script: str, audio_filename: str):
    if MP3 is None:
        await send_log("⚠️ Pro generování .srt titulků chybí knihovna 'mutagen'. (pip install mutagen)")
        return False

    audio_path = os.path.join(AUDIO_DIR, audio_filename)
    if not os.path.exists(audio_path):
        await send_log(f"⚠️ Zvukový soubor {audio_filename} nebyl nalezen. Nelze vygenerovat titulky.")
        return False

    try:
        await send_log("📝 Počítám časové stopy a generuji .srt titulky...")
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
                if not clean_sentence:
                    continue
                    
                duration = total_duration * (len(clean_sentence) / total_chars)
                start_time = current_time
                end_time = current_time + duration
                
                srt_file.write(f"{srt_index}\n")
                srt_file.write(f"{format_srt_time(start_time)} --> {format_srt_time(end_time)}\n")
                srt_file.write(f"{clean_sentence}\n\n")
                
                current_time = end_time
                srt_index += 1
                
        await send_log(f"✅ Titulky uloženy jako {srt_filename}")
        return True
    except Exception as e:
        await send_log(f"⚠️ Nelze vytvořit titulky: {str(e)}")
        return False

# --- NOVINKA: Generování MP4 přes FFmpeg ---
async def create_mp4_with_subtitles(audio_filename: str):
    if ffmpeg is None:
        await send_log("⚠️ Chybí knihovna 'ffmpeg-python'. Video nebude vytvořeno.")
        return False

    base_name = audio_filename.replace(".mp3", "")
    audio_path = os.path.join(AUDIO_DIR, audio_filename)
    srt_path = os.path.join(AUDIO_DIR, f"{base_name}.srt")
    video_path = os.path.join(AUDIO_DIR, f"{base_name}.mp4")
    
    # 1. Dynamické vytvoření černé "čtečky" (obrázku) s názvem otázky (Zjednodušeně pomocí FFmpeg filtru)
    await send_log("🎬 FFmpeg: Vytvářím video s napevno vloženými titulky...")
    try:
        # Převedeme SRT cestu na formát s lomítky pro FFmpeg filtr
        srt_path_esc = srt_path.replace("\\", "/")
        
        # Sestavení příkazu pro ffmpeg
        (
            ffmpeg
            .input(audio_path)
            .output(video_path, 
                    vcodec='libx264', 
                    acodec='aac', 
                    shortest=None, # Video bude přesně tak dlouhé jako audio
                    vf=f"color=c=black:s=1280x720[bg];[bg]subtitles='{srt_path_esc}':force_style='FontSize=24,PrimaryColour=&H00FFFFFF'")
            .overwrite_output()
            .run(quiet=True)
        )
        await send_log(f"✅ Video uloženo jako {base_name}.mp4")
        return True
    except Exception as e:
        await send_log(f"⚠️ Selhalo vytváření videa. Je nainstalován systémový balíček ffmpeg? Chyba: {str(e)}")
        return False
# ---------------------------------------------


async def internal_generate_audio(script: str, filename: str, provider: str, voice: str, output_format: str):
    safe_title = "".join([c for c in filename if c.isalnum() or c in (' ', '_', '-')]).strip().replace(" ", "_")
    audio_filename = f"{safe_title}.mp3"
    audio_path = os.path.join(AUDIO_DIR, audio_filename)

    sentences = re.split(r'(?<=[.!?]) +', script)
    chunks = []
    current_chunk = ""
    CHUNK_LIMIT = 4000
    
    if len(script) > CHUNK_LIMIT:
        await send_log(f"✂️ Text je delší než {CHUNK_LIMIT} znaků ({len(script)}). Zapínám chunking.")

    for sentence in sentences:
        if len(current_chunk) + len(sentence) < CHUNK_LIMIT:
            current_chunk += sentence + " "
        else:
            if current_chunk.strip():
                chunks.append(current_chunk.strip())
            current_chunk = sentence + " "
            
    if current_chunk.strip():
        chunks.append(current_chunk.strip())

    with open(audio_path, 'wb') as final_audio_file:
        for idx, chunk in enumerate(chunks):
            if not chunk: continue
            
            if len(chunks) > 1:
                await send_log(f"🔊 {provider.upper()} TTS: Generuji část audia {idx + 1}/{len(chunks)}...")
            else:
                await send_log(f"🔊 {provider.upper()} TTS: Generuji audiosoubor...")
            
            if provider == "openai":
                response = openai_client.audio.speech.create(
                    model="tts-1", voice=voice, input=chunk
                )
                for byte_chunk in response.iter_bytes():
                    final_audio_file.write(byte_chunk)
                    
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
    
    # Vždy vygenerujeme titulky, i pro MP3
    await create_srt_for_audio(script, audio_filename)
    
    # Pokud uživatel chtěl video
    if output_format == "mp4":
        success = await create_mp4_with_subtitles(audio_filename)
        if success:
            return f"/audio/{safe_title}.mp4", f"{safe_title}.mp4", "mp4"
                    
    return f"/audio/{audio_filename}", audio_filename, "mp3"


async def background_batch_process(questions: list, custom_prompt: str, provider: str, voice: str, output_format: str):
    await send_log(f"🚀 Spouštím dávkové zpracování pro {len(questions)} otázek...")
    try:
        for idx, question in enumerate(questions):
            await send_log(f"▶️ [{idx+1}/{len(questions)}] Zpracovávám otázku: {question}")
            
            script, _ = await internal_generate_script(question, custom_prompt, provider)
            await send_log(f"✅ Text pro '{question}' vytvořen. Spouštím syntézu zvuku...")
            
            filename = f"Otazka_{idx+1}_{question[:20]}"
            audio_url, audio_file, final_format = await internal_generate_audio(script, filename, provider, voice, output_format)
            await send_log(f"🎉 Hotovo [{idx+1}/{len(questions)}]: Uloženo jako {audio_file}")
            
            await asyncio.sleep(2)
            
        await send_log("🏁 Dávkové zpracování kompletně dokončeno!")
    except Exception as e:
        await send_log(f"❌ Dávkové zpracování přerušeno chybou: {str(e)}")

@app.post("/api/process-batch")
async def process_batch(background_tasks: BackgroundTasks, payload: dict = Body(...)):
    questions = payload.get("questions", [])
    custom_prompt = payload.get("prompt")
    provider = payload.get("provider", "openai")
    voice = payload.get("voice", "onyx")
    output_format = payload.get("format", "mp3")

    if not questions or not custom_prompt:
        raise HTTPException(status_code=400, detail="Chybí otázky nebo prompt.")

    background_tasks.add_task(background_batch_process, questions, custom_prompt, provider, voice, output_format)
    return {"status": "ok", "message": f"Dávka byla spuštěna na pozadí."}

@app.post("/api/generate-script")
async def generate_script(payload: dict = Body(...)):
    question = payload.get("question")
    custom_prompt = payload.get("prompt")
    provider = payload.get("provider", "openai")
    
    if not question or not custom_prompt:
        raise HTTPException(status_code=400, detail="Chybí zkoušková otázka nebo systémový prompt.")

    try:
        script, context = await internal_generate_script(question, custom_prompt, provider)
        await send_log("✅ Gemini úspěšně vygenerovala scénář.")
        return {"script": script, "context": context}
    except Exception as e:
        await send_log(f"❌ Chyba při generování: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/generate-audio")
async def generate_audio(payload: dict = Body(...)):
    script = payload.get("script")
    filename = payload.get("filename", "podcast")
    provider = payload.get("provider", "openai")
    voice = payload.get("voice", "onyx")
    output_format = payload.get("format", "mp3")

    await send_log(f"🔊 Spouštím TTS syntézu přes {provider}...")
    try:
        audio_url, audio_filename, final_format = await internal_generate_audio(script, filename, provider, voice, output_format)
        await send_log(f"🎉 Záznam uložen: {audio_filename}")
        return {"audio_url": audio_url, "filename": audio_filename, "format": final_format}
    except Exception as e:
        await send_log(f"❌ Tvorba záznamu selhala: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/generate-subtitles")
async def generate_subtitles_endpoint(payload: dict = Body(...)):
    script = payload.get("script")
    filename = payload.get("filename")

    if not script or not filename:
        raise HTTPException(status_code=400, detail="Chybí text nebo název souboru.")

    success = await create_srt_for_audio(script, filename)
    if success:
        return {"status": "success", "message": "Titulky vygenerovány."}
    else:
        raise HTTPException(status_code=500, detail="Titulky se nepodařilo vygenerovat.")

app.mount("/audio", StaticFiles(directory=AUDIO_DIR), name="audio")
app.mount("/", StaticFiles(directory="static", html=True), name="static")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=False)