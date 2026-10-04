"""
Služba pro generování výukových podcastů, syntézu hlasu (OpenAI / ElevenLabs),
vytváření titulků (.srt) a videa (.mp4) přes FFmpeg.
"""

import asyncio
import os
import re
from typing import Optional, Tuple

import httpx

try:
    from mutagen.mp3 import MP3
except ImportError:
    MP3 = None

try:
    import ffmpeg
except ImportError:
    ffmpeg = None

from core.clients import get_elevenlabs_api_key, get_openai_client
from core.config import AUDIO_DIR
from core.logger import send_log
from core.security import safe_filename, safe_join
from core.utils import friendly_api_error
from prompts.podcast import DEFAULT_PODCAST_PROMPT
from services.ai_service import call_gemini_with_retries


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


async def internal_generate_script(
    question: str,
    custom_prompt: str,
    provider: str,
    project: str,
    gemini_model: str,
    rag_query_fn=None,
) -> tuple[str, str]:
    if rag_query_fn is None:
        from services.rag_service import query_rag_context_with_sources

        rag_query_fn = query_rag_context_with_sources

    prompt_to_use = custom_prompt if custom_prompt and custom_prompt.strip() else DEFAULT_PODCAST_PROMPT
    if "[NÁZEV OTÁZKY]" in prompt_to_use:
        prompt_to_use = prompt_to_use.replace("[NÁZEV OTÁZKY]", question)
    if "{QUESTION}" in prompt_to_use:
        prompt_to_use = prompt_to_use.replace("{QUESTION}", question)
    if "{MAX_CHARS}" in prompt_to_use:
        prompt_to_use = prompt_to_use.replace("{MAX_CHARS}", "8000")

    final_prompt = enrich_prompt_for_tts(prompt_to_use, provider)

    context_text, unique_sources, raw_context = await rag_query_fn(question, project, n_results=40)

    ukazka_textu = raw_context[:150].replace("\n", " ")
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


async def create_srt_for_audio(script: str, audio_filename: str) -> bool:
    if MP3 is None:
        await send_log("⚠️ Pro generování .srt titulků chybí knihovna 'mutagen'. (pip install mutagen)")
        return False

    audio_path = safe_join(AUDIO_DIR, safe_filename(audio_filename))
    if not os.path.exists(audio_path):
        return False

    try:
        await send_log("📝 Generuji .srt titulky...")
        audio_info = MP3(audio_path)
        total_duration = audio_info.info.length

        srt_filename = safe_filename(audio_filename.replace(".mp3", ".srt"))
        srt_path = safe_join(AUDIO_DIR, srt_filename)

        def format_srt_time(seconds):
            hours = int(seconds // 3600)
            minutes = int((seconds % 3600) // 60)
            secs = int(seconds % 60)
            millis = int((seconds - int(seconds)) * 1000)
            return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"

        sentences = re.split(r"(?<=[.!?]) +", script)
        total_chars = sum(len(s) for s in sentences if s.strip())

        with open(srt_path, "w", encoding="utf-8") as srt_file:
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

        return True
    except Exception as e:
        await send_log(f"⚠️ Nelze vytvořit titulky: {str(e)}")
        return False


async def create_mp4_with_subtitles(audio_filename: str, question_title: str) -> bool:
    if ffmpeg is None:
        await send_log("⚠️ Chybí knihovna 'ffmpeg-python'. Video nebude vytvořeno.")
        return False

    base_name = safe_filename(audio_filename.replace(".mp3", ""))
    audio_path = safe_join(AUDIO_DIR, safe_filename(audio_filename))
    srt_path = safe_join(AUDIO_DIR, f"{base_name}.srt")
    video_path = safe_join(AUDIO_DIR, f"{base_name}.mp4")
    title_txt_path = safe_join(AUDIO_DIR, f"{base_name}_title.txt")

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
            ffmpeg.input(audio_path)
            .output(video_path, vcodec="libx264", acodec="aac", shortest=None, vf=vf_filter)
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


async def internal_generate_audio(
    script: str, filename: str, provider: str, voice: str, output_format: str, question_title: str
) -> tuple[str, str, str]:
    safe_title = "".join([c for c in filename if c.isalnum() or c in (" ", "_", "-")]).strip().replace(" ", "_")
    audio_filename = f"{safe_title}.mp3"
    audio_path = safe_join(AUDIO_DIR, safe_filename(audio_filename))
    temporary_audio_path = f"{audio_path}.part"

    sentences = re.split(r"(?<=[.!?]) +", script)
    chunks = []
    current_chunk = ""
    CHUNK_LIMIT = 4000

    if len(script) > CHUNK_LIMIT:
        await send_log("✂️ Text je rozdělen pro překročení limitů TTS.")

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
        with open(temporary_audio_path, "wb") as final_audio_file:
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
                        response = client.audio.speech.create(model="tts-1", voice=voice, input=chunk)
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
                        "voice_settings": {"stability": 0.5, "similarity_boost": 0.75},
                    }
                    voice_id = voice if len(voice) > 5 else "21m00Tcm4TlvDq8ikWAM"
                    async with httpx.AsyncClient() as client:
                        res = await client.post(
                            f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}",
                            headers=headers,
                            json=data,
                            timeout=120.0,
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
