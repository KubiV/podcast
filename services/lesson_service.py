import asyncio
import json
import os
import re
from typing import Any, Dict, List, Optional, Tuple

import pdfplumber
from dotenv import load_dotenv
from google import genai
from google.genai import types
from mutagen.mp3 import MP3

from core.utils import is_retryable_gemini_error  # noqa: F401 – re-export pro zpětnou kompatibilitu
from prompts.lesson import STAGE_A_STUDY_MATERIAL_PROMPT, STAGE_B_LECTURE_SCRIPT_PROMPT
from services.chat_service import (
    delete_lesson,
    get_ai_client,
    get_chroma_client,
    get_lesson,
    list_lessons,
    sanitize_project_name,
    save_or_update_lesson,
)

load_dotenv()


# --- MULTIMODÁLNÍ INGESCE A ZPRACOVÁNÍ ---


def detect_mime_type(filename: str) -> str:
    ext = filename.lower().split(".")[-1]
    mime_map = {
        "pdf": "application/pdf",
        "png": "image/png",
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
        "webp": "image/webp",
        "gif": "image/gif",
        "txt": "text/plain",
        "md": "text/markdown",
        "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    }
    return mime_map.get(ext, "application/octet-stream")


def normalize_image_part_bytes(blob: bytes, original_mime: str) -> tuple[bytes, str] | None:
    """
    Zajistí, že obrazová data mají validní MIME type podporovaný Google Gemini API
    (image/jpeg, image/png, image/webp, image/heic, image/heif). Pokud je formát
    nekompatibilní (TIFF, BMP, GIF apod.), pokusí se jej zkonvertovat přes PIL na JPEG/PNG.
    Nepodporované formáty (např. vektorový WMF / EMF ze slidů), které nelze převést, bezpečně přeskočí,
    aby nezpůsobily chybu 400 INVALID_ARGUMENT.
    """
    supported = {"image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"}
    norm_mime = (original_mime or "").lower().strip()

    # Ignorujeme vektorové Windows metafiles (WMF / EMF), které Gemini odmítá s HTTP 400
    if "wmf" in norm_mime or "emf" in norm_mime:
        return None

    if norm_mime in supported:
        return blob, norm_mime

    # Pokusíme se převést TIFF, BMP, GIF apod. na JPEG/PNG přes PIL
    try:
        import io

        from PIL import Image

        img = Image.open(io.BytesIO(blob))
        out = io.BytesIO()
        if img.mode in ("RGBA", "LA", "P"):
            img.convert("RGBA").save(out, format="PNG")
            return out.getvalue(), "image/png"
        else:
            img.convert("RGB").save(out, format="JPEG", quality=88)
            return out.getvalue(), "image/jpeg"
    except Exception:
        return None


async def extract_multimodal_parts(file_paths: list[tuple[str, str]]) -> tuple[list[Any], str, list[dict[str, Any]]]:
    """
    Zpracuje nahrané soubory do seznamu Gemini Part objektů a extrahovaného textu.
    file_paths je seznam dvojic (cesta_k_souboru, puvodni_nazev).
    """
    parts = []
    combined_text = ""
    file_metadata = []

    for file_path, original_filename in file_paths:
        mime = detect_mime_type(original_filename)
        ext = original_filename.lower().split(".")[-1]

        with open(file_path, "rb") as f:
            file_bytes = f.read()

        file_metadata.append(
            {
                "filename": original_filename,
                "mime_type": mime,
                "size_bytes": len(file_bytes),
            }
        )

        # PDF předáváme přímo nativně do Gemini přes Part.from_bytes
        if mime == "application/pdf":
            try:
                part = types.Part.from_bytes(data=file_bytes, mime_type=mime)
                parts.append(part)
            except Exception as e:
                print(f"[WARN] Nelze vytvořit Part.from_bytes pro {original_filename}: {e}")

        # Samostatné obrázky normalizujeme pro Gemini API
        elif mime.startswith("image/"):
            norm = normalize_image_part_bytes(file_bytes, mime)
            if norm:
                norm_bytes, norm_mime = norm
                try:
                    part = types.Part.from_bytes(data=norm_bytes, mime_type=norm_mime)
                    parts.append(part)
                except Exception as e:
                    print(f"[WARN] Nelze vytvořit Part.from_bytes pro obrázek {original_filename}: {e}")

        # Pro textové formáty a PDF se pokusíme vytáhnout i text pro RAG indexaci
        if ext == "pdf":
            try:
                with pdfplumber.open(file_path) as pdf:
                    for idx, page in enumerate(pdf.pages):
                        text = page.extract_text()
                        if text:
                            combined_text += f"\n--- [{original_filename} str. {idx + 1}] ---\n{text}\n"
            except Exception as e:
                print(f"[WARN] pdfplumber selhal pro {original_filename}: {e}")

        elif ext == "txt" or ext == "md":
            try:
                text = file_bytes.decode("utf-8", errors="ignore")
                combined_text += f"\n--- [{original_filename}] ---\n{text}\n"
            except Exception as e:
                print(f"[WARN] TXT čtení selhalo: {e}")

        elif ext == "docx":
            try:
                import docx

                doc = docx.Document(file_path)
                docx_text = "\n".join([p.text for p in doc.paragraphs if p.text])
                combined_text += f"\n--- [{original_filename}] ---\n{docx_text}\n"
            except Exception as e:
                print(f"[WARN] DOCX čtení selhalo: {e}")

        elif ext == "pptx":
            try:
                import pptx

                prs = pptx.Presentation(file_path)
                pptx_text = ""
                for s_idx, slide in enumerate(prs.slides):
                    slide_text = []
                    for shape in slide.shapes:
                        if hasattr(shape, "text") and shape.text:
                            slide_text.append(shape.text)
                    if slide_text:
                        pptx_text += f"\n[Slide {s_idx + 1}]: " + " | ".join(slide_text)
                combined_text += f"\n--- [{original_filename}] ---\n{pptx_text}\n"

                # Extrakce obrázků a grafů ze slidů (např. fotografie otázek, kazuistik, diagramy)
                pptx_images_added = 0
                for s_idx, slide in enumerate(prs.slides):
                    for shape in slide.shapes:
                        if shape.shape_type == pptx.enum.shapes.MSO_SHAPE_TYPE.PICTURE:
                            try:
                                img = shape.image
                                blob = img.blob
                                # Filtrujeme drobné dekorace/ikony (< 10 KB) a omezíme celkový počet částí
                                if len(blob) >= 10240 and len(parts) < 35:
                                    norm = normalize_image_part_bytes(blob, img.content_type or "image/png")
                                    if norm:
                                        norm_bytes, norm_mime = norm
                                        part = types.Part.from_bytes(data=norm_bytes, mime_type=norm_mime)
                                        parts.append(part)
                                        pptx_images_added += 1
                            except Exception:
                                pass
                if pptx_images_added > 0:
                    print(
                        f"[INFO] Přidáno {pptx_images_added} validních obrázků ze slidů prezentace '{original_filename}'."
                    )
            except Exception as e:
                print(f"[WARN] PPTX čtení selhalo: {e}")

    return parts, combined_text, file_metadata


async def index_lesson_text_to_chroma(project_id: str, combined_text: str, lesson_title: str):
    """Zaindexuje extrahovaný text a osnovu do ChromaDB kolekce projektu."""
    if not combined_text.strip():
        return

    from core.utils import chunk_text

    chroma = get_chroma_client()
    collection_name = f"proj_{sanitize_project_name(project_id)}"
    collection = chroma.get_or_create_collection(name=collection_name)

    chunks = chunk_text(combined_text)
    ids = [f"lesson_{sanitize_project_name(lesson_title)}_chunk_{i}" for i in range(len(chunks))]
    metadatas = [{"source": f"Lekce: {lesson_title}"} for _ in range(len(chunks))]

    collection.add(documents=chunks, metadatas=metadatas, ids=ids)
    try:
        from chat_service import index_chunks_to_fts

        fts_chunks = [
            {
                "id": ids[i],
                "document": chunks[i],
                "source": metadatas[i]["source"],
                "page": "1",
            }
            for i in range(len(chunks))
        ]
        index_chunks_to_fts(project_id, fts_chunks)
    except Exception as e:
        print(f"[lesson_service] FTS lesson indexing warning: {e}")


# --- DVOUFÁZOVÁ PEDAGOGICKÁ PIPELINE ---

# Moved STAGE_A_STUDY_MATERIAL_PROMPT to prompts.lesson


# Moved STAGE_B_LECTURE_SCRIPT_PROMPT to prompts.lesson


def extract_chapters_from_script(script: str, total_duration_seconds: float = 600.0) -> list[dict[str, Any]]:
    """Vyparsuje z textu přednášky značky [KAPITOLA: XX | Název] a dopočítá časové razítko."""
    pattern = r"\[KAPITOLA:\s*([0-9A-Za-z]+)\s*\|\s*([^\]]+)\]"
    matches = list(re.finditer(pattern, script))

    if not matches:
        # Fallback – vygenerujeme standardní kapitoly po úsecích
        return [
            {"time": "00:00", "seconds": 0, "title": "Klinický kontext a jádro problému"},
            {"time": "02:30", "seconds": 150, "title": "Patofyziologie v analogii"},
            {"time": "05:00", "seconds": 300, "title": "Diagnostický rozbor a tabulky"},
            {"time": "07:30", "seconds": 450, "title": "Léčebná strategie a perly"},
            {"time": "10:00", "seconds": 600, "title": "Závěrečné shrnutí"},
        ]

    total_len = len(script) if len(script) > 0 else 1
    chapters = []

    for idx, match in enumerate(matches):
        char_offset = match.start()
        ratio = char_offset / total_len
        calculated_seconds = round(ratio * total_duration_seconds, 1)

        minutes = int(calculated_seconds // 60)
        seconds = int(calculated_seconds % 60)
        time_str = f"{minutes:02d}:{seconds:02d}"

        title = match.group(2).strip()
        chapters.append(
            {
                "id": idx + 1,
                "time": time_str,
                "seconds": calculated_seconds,
                "title": title,
            }
        )

    # První kapitola vždy začíná na 00:00
    if chapters and chapters[0]["seconds"] > 0:
        chapters[0]["seconds"] = 0.0
        chapters[0]["time"] = "00:00"

    return chapters


def clean_script_for_tts(script: str) -> str:
    """Odstraní značky kapitol a metadat z textu před odesláním do TTS syntezátoru."""
    clean = re.sub(r"\[KAPITOLA:[^\]]+\]", "", script)
    clean = re.sub(r"<!--.*?-->", "", clean, flags=re.DOTALL)
    # Odstranění markdown značek pro plynulý přednes TTS
    clean = re.sub(r"\*\*([^*]+)\*\*", r"\1", clean)
    clean = re.sub(r"\*([^*]+)\*", r"\1", clean)
    clean = re.sub(r"^#+\s*", "", clean, flags=re.MULTILINE)
    # Vyčištění nadbytečných prázdných řádků
    clean = re.sub(r"\n{3,}", "\n\n", clean)
    return clean.strip()


def get_fallback_model(model: str) -> str | None:
    """Vrátí spolehlivý záložní model v případě trvalého přetížení vybraného modelu."""
    fallbacks = {
        "gemini-3.8-flash": "gemini-3.6-flash",
        "gemini-pro-latest": "gemini-3.6-flash",
        "gemini-flash-latest": "gemini-3.6-flash",
        "gemini-3.6-flash": "gemini-flash-latest",
    }
    return fallbacks.get(model)


async def call_gemini_with_resilience(
    ai_client: Any,
    model: str,
    contents: list[Any],
    config: types.GenerateContentConfig,
    report_fn: Any | None = None,
    step_name: str = "generating_markdown",
    step_pct: int = 30,
    wait_intervals: list[int] | None = None,
) -> Any:
    """
    Spolehlivé volání Gemini API s automatickými retries při přetížení (HTTP 503 / 429),
    progresivním čekáním, průběžnými notifikacemi pro uživatele a záložním modelem (fallback).
    """
    if wait_intervals is None:
        wait_intervals = [6, 12, 25, 45, 60]

    current_model = model
    fallback_used = False
    max_attempts = len(wait_intervals) + 1

    for attempt in range(max_attempts):
        try:
            resp = await asyncio.to_thread(
                ai_client.models.generate_content,
                model=current_model,
                contents=contents,
                config=config,
            )
            return resp
        except Exception as e:
            if is_retryable_gemini_error(e):
                err_detail = str(e)
                try:
                    from core.utils import extract_gemini_error_detail

                    err_detail = extract_gemini_error_detail(e)
                except Exception:
                    pass

                # Pokud primární model selhává opakovaně (od 3. pokusu), zkusíme záložní model
                if attempt >= 2 and not fallback_used:
                    fallback = get_fallback_model(current_model)
                    if fallback and fallback != current_model:
                        fallback_used = True
                        if report_fn:
                            await report_fn(
                                step_name,
                                step_pct,
                                f"⚠️ Model {current_model} je na straně Googlu dočasně přetížen ({err_detail}). Přepínám na záložní model {fallback}...",
                            )
                        current_model = fallback
                        await asyncio.sleep(4)
                        continue

                if attempt < max_attempts - 1:
                    wait_time = wait_intervals[attempt]
                    if report_fn:
                        await report_fn(
                            step_name,
                            step_pct,
                            f"⚠️ Gemini API je dočasně přetížené ({err_detail}). Pokus {attempt + 1}/{max_attempts}, čekám {wait_time} s...",
                        )
                    await asyncio.sleep(wait_time)
                else:
                    raise
            else:
                raise


async def generate_lesson_package(
    project_id: str,
    lesson_title: str,
    target_language: str,
    file_paths: list[tuple[str, str]],
    gemini_model: str = "gemini-3.6-flash",
    tts_provider: str = "openai",
    tts_voice: str = "onyx",
    progress_callback: Any | None = None,
) -> dict[str, Any]:
    """
    Kompletní orchestrace generování výukové lekce od A do Z:
    1. Multimodální extrakce z nahraných souborů (PDF, skeny, obrázky)
    2. Stage A: Generování strukturovaného studijního textu (Markdown)
    3. Stage B: Generování scénáře mluvené přednášky
    4. TTS syntéza mluveného audia (lecture_audio.mp3)
    5. Spočtení časových značek kapitol a uložení do SQLite
    """
    from core.config import AUDIO_DIR, LESSONS_DIR, NOTES_DIR
    from core.logger import send_log
    from services.podcast_service import internal_generate_audio

    safe_proj = sanitize_project_name(project_id)
    ai = get_ai_client()

    async def report(step: str, pct: int, msg: str):
        await send_log(f"🎓 [Lekce '{lesson_title}'] ({pct}%): {msg}")
        if progress_callback:
            try:
                await progress_callback(
                    {
                        "step": step,
                        "percentage": pct,
                        "message": msg,
                        "project": safe_proj,
                    }
                )
            except Exception:
                pass

    # --- KROK 1: EXTRAKCE A PŘÍPRAVA MULTIMODÁLNÍCH VSTUPŮ ---
    await report("extracting", 10, "Extrahuji a analyzuji multimodální podklady (PDF, obrázky, text)...")
    multimodal_parts, extracted_text, file_metas = await extract_multimodal_parts(file_paths)

    # Uložíme extrahovaný text do ChromaDB pro budoucí chat
    if extracted_text.strip():
        await index_lesson_text_to_chroma(safe_proj, extracted_text, lesson_title)

    # --- KROK 2: STAGE A – GENERACE STRUKTUROVANÉHO STUDIJNÍHO TEXTU ---
    await report(
        "generating_markdown",
        30,
        f"Generuji komplexní studijní materiál v jazyce: {target_language} přes {gemini_model}...",
    )

    prompt_a = STAGE_A_STUDY_MATERIAL_PROMPT.replace("{TOPIC}", lesson_title).replace(
        "{TARGET_LANGUAGE}", target_language
    )

    contents_a: list[Any] = []
    # Přidáme multimodální části (obrázky, PDF)
    contents_a.extend(multimodal_parts)
    # Přidáme textový extrakt a zadání
    user_payload_a = f"TÉMA VÝUKOVÉ LEKCE: {lesson_title}\n\n"
    if extracted_text.strip():
        # Poskytneme bohatý textový kontext (až 150 000 znaků, aby nebyly oříznuty otázky na konci materiálů)
        user_payload_a += f"=== TEXTOVÝ EXTRAKT Z NAHRANÝCH SOUBORŮ ===\n{extracted_text[:150000]}\n==========================================\n\n"
    user_payload_a += (
        "Vytvoř kompletní a detailní studijní text podle zadané osnovy.\n\n"
        "DŮLEŽITÉ POKYNY:\n"
        "1. Vynech jakýkoliv zdlouhavý úvod či obecnou omáčku v úvodní sekci – jdi přímo k definici a odbornému konceptu.\n"
        "2. Důkladně prozkoumej celé přiložené podklady VČETNĚ FOTOGRAFIÍ SLIDŮ A PREZENTACÍ (např. kazuistiky Cas clinique, otázky na závěrečných snímcích).\n"
        "3. Pokud na fotografiích slidů najdeš testové otázky (MCQ s volbami A/B/C/D/E), kde jsou odpovědi zakroužkované perem/fixem, podtržené nebo doplněné rukopisem:\n"
        "   - Tyto otázky a jejich možnosti kompletně zařaď do Sekce 8 v cílovém jazyce.\n"
        "   - Zakroužkovanou volbu uveď jako správnou odpověď ze slidu a pro všechny možnosti uveď detailní zdůvodnění.\n"
        "4. Dbej na to, abys vygeneroval kompletní text všech 8 sekcí osnovy a text se nikde neusekl."
    )
    contents_a.append(user_payload_a)

    config_a = types.GenerateContentConfig(
        system_instruction=prompt_a,
        temperature=0.3,
        max_output_tokens=32768,
        thinking_config=types.ThinkingConfig(thinking_budget=2048),
    )

    resp_a = await call_gemini_with_resilience(
        ai_client=ai,
        model=gemini_model,
        contents=contents_a,
        config=config_a,
        report_fn=report,
        step_name="generating_markdown",
        step_pct=30,
    )
    study_text_markdown = resp_a.text or ""

    # Záchranná pojistka: pokud výstup dosáhl limitu tokenů, automaticky navážeme a dopíšeme zbývající sekce
    candidate = resp_a.candidates[0] if resp_a.candidates else None
    finish_reason = getattr(candidate, "finish_reason", None)
    if finish_reason and "MAX_TOKENS" in str(finish_reason):
        await send_log(
            f"⚠️ Výstup studijního textu dosáhl limitu tokenů ({finish_reason}). Automaticky navazuji a dopisuji zbývající sekce..."
        )
        cont_prompt = (
            f"Předchozí výstup byl useknut kvůli limitu tokenů na tomto místě:\n"
            f'"...{study_text_markdown[-300:]}"\n\n'
            f"Navazuj přesně tam, kde text skončil (bez opakování předchozího textu) "
            f"a dopiš všechny zbývající sekce osnovy až do úplného konce včetně Sekce 8 s testovými otázkami a zakroužkovanými odpověďmi ze slidů."
        )
        resp_cont = await call_gemini_with_resilience(
            ai_client=ai,
            model=gemini_model,
            contents=[*contents_a, types.Part.from_text(text=study_text_markdown), cont_prompt],
            config=config_a,
            report_fn=report,
            step_name="generating_markdown",
            step_pct=45,
        )
        if resp_cont.text:
            study_text_markdown += "\n" + resp_cont.text.strip()

    if not study_text_markdown.strip():
        raise ValueError("Model nevrátil žádný studijní text.")

    # Uložení Markdownu na disk do lessons_data/{safe_proj}/lesson_material.md i generated_notes
    lesson_dir = os.path.join(LESSONS_DIR, safe_proj)
    os.makedirs(lesson_dir, exist_ok=True)
    lesson_md_path = os.path.join(lesson_dir, "lesson_material.md")
    with open(lesson_md_path, "w", encoding="utf-8") as f:
        f.write(study_text_markdown)

    notes_backup_path = os.path.join(NOTES_DIR, f"{safe_proj}_lesson_material.md")
    with open(notes_backup_path, "w", encoding="utf-8") as f:
        f.write(study_text_markdown)

    # Zaindexujeme i výsledný studijní text do Chroma pro okamžitou přesnost chatu
    await index_lesson_text_to_chroma(safe_proj, study_text_markdown, f"{lesson_title} (Studijní text)")

    # --- KROK 3: STAGE B – GENERACE SCÉNÁŘE MLUVENÉ PŘEDNÁŠKY ---
    await report(
        "generating_lecture",
        60,
        "Vytvářím didaktický scénář přednášky profesora s kapitolami a analogiemi...",
    )

    prompt_b = STAGE_B_LECTURE_SCRIPT_PROMPT.replace("{TOPIC}", lesson_title).replace(
        "{TARGET_LANGUAGE}", target_language
    )

    user_payload_b = (
        f"TÉMA PŘEDNÁŠKY: {lesson_title}\n\n"
        f"=== HOTOVÝ STUDIJNÍ TEXT, KTERÝ MÁ STUDENT PŘED SEBOU ===\n"
        f"{study_text_markdown}\n"
        f"========================================================\n\n"
        "Vytvoř mluvený přednáškový výklad profesora s kapitolami [KAPITOLA: XX | Název].\n\n"
        "DŮLEŽITÉ POKYNY PRO PŘEDNÁŠKU:\n"
        "1. VYNECH ZDLOUHAVÝ ÚVOD: Začni maximálně jednou svižnou větou a okamžitě jdi do klinického problému a výkladu.\n"
        "2. POUŽÍVEJ SKUTEČNÝ VÝUKOVÝ PŘEDNÁŠKOVÝ STYL: Mluv živě k publiku, vysvětluj 'proč' pomocí analogií, upozorňuj na klinické chytáky.\n"
        "3. AKTIVNĚ ODKAZUJ NA TEXT: Naváděj studenta na konkrétní sekce, tabulky a schémata ve studijním materiálu.\n"
        "4. TESTOVÉ OTÁZKY: Pokud jsou na konci textu testové otázky, v závěru na ně studenta pouze stručně odkaž pro samostudium – v nahrávce je mechanicky nečti."
    )

    config_b = types.GenerateContentConfig(
        system_instruction=prompt_b,
        temperature=0.7,
        max_output_tokens=16384,
        thinking_config=types.ThinkingConfig(thinking_budget=1024),
    )

    resp_b = await call_gemini_with_resilience(
        ai_client=ai,
        model=gemini_model,
        contents=[user_payload_b],
        config=config_b,
        report_fn=report,
        step_name="generating_lecture",
        step_pct=60,
    )
    lecture_script = resp_b.text or ""

    if not lecture_script.strip():
        raise ValueError("Model nevrátil scénář přednášky.")

    # Uložíme i scénář na disk
    script_path = os.path.join(lesson_dir, "lecture_script.txt")
    with open(script_path, "w", encoding="utf-8") as f:
        f.write(lecture_script)

    # --- KROK 4: TTS SYNTÉZA MLUVENÉHO AUDIA ---
    await report(
        "synthesizing_audio",
        75,
        f"Spouštím syntézu mluvené přednášky přes {tts_provider.upper()} (hlas: {tts_voice})...",
    )

    clean_script = clean_script_for_tts(lecture_script)
    audio_base_filename = f"{safe_proj}_lecture_audio"

    # Voláme existující funkci syntézy zvuku v main.py
    audio_url, audio_filename, _ = await internal_generate_audio(
        script=clean_script,
        filename=audio_base_filename,
        provider=tts_provider,
        voice=tts_voice,
        output_format="mp3",
        question_title=f"Výuková lekce: {lesson_title}",
    )

    # --- KROK 5: KALKULACE ČASŮ KAPITOL A ULOŽENÍ METADAT ---
    await report("finalizing", 95, "Dopočítávám časové značky kapitol pro audio přehrávač...")

    # Zjištění přesné délky vygenerovaného audia
    full_audio_path = os.path.join(AUDIO_DIR, audio_filename)
    audio_duration = 600.0
    if os.path.exists(full_audio_path):
        try:
            mp3_info = MP3(full_audio_path)
            audio_duration = mp3_info.info.length
        except Exception:
            pass

    chapters = extract_chapters_from_script(lecture_script, total_duration_seconds=audio_duration)

    # Uložení do SQLite
    save_or_update_lesson(
        project_id=safe_proj,
        title=lesson_title,
        target_language=target_language,
        markdown_content=study_text_markdown,
        lecture_script=lecture_script,
        audio_filename=audio_filename,
        audio_url=audio_url,
        chapters=chapters,
        status="completed",
    )

    # Uložení JSON metadat i do souboru v lekci pro zálohu
    meta_payload = {
        "project_id": safe_proj,
        "title": lesson_title,
        "target_language": target_language,
        "audio_filename": audio_filename,
        "audio_url": audio_url,
        "audio_duration_seconds": audio_duration,
        "chapters": chapters,
        "sources": file_metas,
    }
    with open(os.path.join(lesson_dir, "lesson_metadata.json"), "w", encoding="utf-8") as f:
        json.dump(meta_payload, f, ensure_ascii=False, indent=2)

    await report("complete", 100, "Výuková lekce byla úspěšně vygenerována a připravena k poslechu!")

    return {
        "status": "completed",
        "project_id": safe_proj,
        "title": lesson_title,
        "target_language": target_language,
        "audio_url": audio_url,
        "audio_filename": audio_filename,
        "chapters": chapters,
        "markdown_content": study_text_markdown,
        "lecture_script": lecture_script,
    }
