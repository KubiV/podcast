import json
import os
import re
import shutil
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Body, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.responses import StreamingResponse

from core.clients import get_chroma_client
from core.config import (
    AUDIO_DIR,
    LESSONS_DIR,
    NOTES_DIR,
    PLANNER_FILENAME,
    TESTS_DIR,
    UPLOAD_DIR,
)
from core.context import current_user_var
from core.logger import publish_event, send_log
from core.utils import friendly_api_error, sanitize_name
from services.ai_service import call_gemini_with_retries, clean_and_parse_json
from services.chat_service import (
    clear_project_messages,
    create_thread,
    delete_lesson,
    delete_thread,
    export_project_chat_markdown,
    export_thread_chat_markdown,
    get_lesson,
    get_project_messages,
    get_thread,
    get_thread_messages,
    list_lessons,
    list_threads,
    save_message,
    stream_grounded_chat,
    toggle_thread_pin,
    update_thread,
)
from services.lesson_service import generate_lesson_package

router = APIRouter()


# --- 1. PROJEKTOVÝ GROUNDED CHAT ---
@router.post("/api/chat/completions")
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


@router.get("/api/chat/threads")
async def get_chat_threads_endpoint(project_id: str | None = None, q: str | None = None):
    safe_proj = sanitize_name(project_id) if project_id and project_id != "__all__" else None
    threads = list_threads(project_id=safe_proj, search_query=q)
    return {"threads": threads}


@router.post("/api/chat/threads")
async def create_chat_thread_endpoint(payload: dict = Body(...)):
    project = payload.get("project_id") or payload.get("project")
    if not project:
        raise HTTPException(status_code=400, detail="Chybí identifikátor projektu.")
    title = payload.get("title")
    thread_id = payload.get("id")
    safe_proj = sanitize_name(project)
    thread = create_thread(project_id=safe_proj, title=title, thread_id=thread_id)
    return {"status": "success", "thread": thread}


@router.get("/api/chat/threads/{thread_id}")
async def get_chat_thread_detail_endpoint(thread_id: str):
    thread = get_thread(thread_id)
    if not thread:
        raise HTTPException(status_code=404, detail="Konverzace nenalezena.")
    messages = get_thread_messages(thread_id)
    return {"thread": thread, "messages": messages}


@router.patch("/api/chat/threads/{thread_id}")
async def update_chat_thread_endpoint(thread_id: str, payload: dict = Body(...)):
    title = payload.get("title")
    is_pinned = payload.get("is_pinned")
    updated = update_thread(thread_id, title=title, is_pinned=is_pinned)
    if not updated:
        raise HTTPException(status_code=404, detail="Konverzace nenalezena.")
    return {"status": "success", "thread": updated}


@router.post("/api/chat/threads/{thread_id}/pin")
async def toggle_chat_thread_pin_endpoint(thread_id: str):
    updated = toggle_thread_pin(thread_id)
    if not updated:
        raise HTTPException(status_code=404, detail="Konverzace nenalezena.")
    return {"status": "success", "thread": updated}


@router.delete("/api/chat/threads/{thread_id}")
async def delete_chat_thread_endpoint(thread_id: str):
    success = delete_thread(thread_id)
    return {"status": "success", "deleted": success}


@router.get("/api/chat/threads/{thread_id}/export")
async def export_chat_thread_endpoint(thread_id: str):
    thread = get_thread(thread_id)
    if not thread:
        raise HTTPException(status_code=404, detail="Konverzace nenalezena.")
    md_content = export_thread_chat_markdown(thread_id)
    clean_title = re.sub(r"[^a-zA-Z0-9_-]", "_", thread["title"][:30])
    filename = f"chat_{clean_title}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.md"

    return Response(
        content=md_content,
        media_type="text/markdown; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/api/projects/{project_id}/messages")
async def get_project_chat_messages(project_id: str, thread_id: str | None = None):
    safe_proj = sanitize_name(project_id)
    messages = get_project_messages(safe_proj, thread_id=thread_id)
    return {"project": safe_proj, "messages": messages}


@router.delete("/api/projects/{project_id}/messages")
async def clear_project_chat(project_id: str):
    safe_proj = sanitize_name(project_id)
    clear_project_messages(safe_proj)
    await send_log(f"🗑️ Historie chatu pro projekt '{safe_proj}' byla vyčištěna.")
    return {"status": "success", "project": safe_proj}


@router.get("/api/projects/{project_id}/chat/export")
async def export_chat_history(project_id: str, thread_id: str | None = None):
    safe_proj = sanitize_name(project_id)
    md_content = export_project_chat_markdown(safe_proj, thread_id=thread_id)
    filename = f"chat_{safe_proj}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.md"

    return Response(
        content=md_content,
        media_type="text/markdown; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# --- SPRÁVA PLÁNOVAČE ZKOUŠKY (EXAM PLANNER) ---
@router.get("/api/projects/{project_id}/planner")
async def get_project_planner(project_id: str):
    safe_proj = sanitize_name(project_id)
    proj_dir = os.path.join(UPLOAD_DIR, safe_proj)
    planner_file = os.path.join(proj_dir, PLANNER_FILENAME)

    default_planner = {
        "examDate": "",
        "startDate": "",
        "revisionDays": 14,
        "scheduleMode": "sequential",
        "questions": [],
    }

    if not os.path.exists(planner_file):
        return {"project": safe_proj, "planner": default_planner}

    try:
        with open(planner_file, encoding="utf-8") as f:
            data = json.load(f)
            return {"project": safe_proj, "planner": data}
    except Exception as e:
        await send_log(f"⚠️ Chyba při čtení plánovače zkoušky ({safe_proj}): {str(e)}")
        return {"project": safe_proj, "planner": default_planner}


@router.post("/api/projects/{project_id}/planner")
async def save_project_planner(project_id: str, request: Request, payload: dict = Body(...)):
    user = getattr(request.state, "user", None) or current_user_var.get()
    if user and user.get("role") == "viewer":
        raise HTTPException(status_code=403, detail="Režim pozorovatele: Nemáte oprávnění ukládat plánovač zkoušky.")

    safe_proj = sanitize_name(project_id)
    proj_dir = os.path.join(UPLOAD_DIR, safe_proj)
    os.makedirs(proj_dir, exist_ok=True)
    planner_file = os.path.join(proj_dir, PLANNER_FILENAME)

    planner_data = payload.get("planner") if "planner" in payload else payload

    clean_data = {
        "examDate": str(planner_data.get("examDate", "") or ""),
        "startDate": str(planner_data.get("startDate", "") or ""),
        "revisionDays": int(planner_data.get("revisionDays", 14) or 14),
        "scheduleMode": str(planner_data.get("scheduleMode", "sequential") or "sequential"),
        "questions": planner_data.get("questions", []),
    }

    try:
        with open(planner_file, "w", encoding="utf-8") as f:
            json.dump(clean_data, f, ensure_ascii=False, indent=2)
        await send_log(
            f"💾 Plánovač zkoušky pro projekt '{safe_proj}' úspěšně uložen ({len(clean_data['questions'])} otázek)."
        )
        return {"status": "success", "project": safe_proj, "planner": clean_data}
    except Exception as e:
        await send_log(f"❌ Chyba při ukládání plánovače zkoušky ({safe_proj}): {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/projects/{project_id}/questions")
async def get_project_questions(project_id: str):
    safe_proj = sanitize_name(project_id)
    proj_dir = os.path.join(UPLOAD_DIR, safe_proj)
    planner_file = os.path.join(proj_dir, PLANNER_FILENAME)

    if not os.path.exists(planner_file):
        return {"project": safe_proj, "questions": []}

    try:
        with open(planner_file, encoding="utf-8") as f:
            data = json.load(f)
            return {"project": safe_proj, "questions": data.get("questions", [])}
    except Exception as e:
        await send_log(f"⚠️ Chyba při čtení otázek projektu ({safe_proj}): {str(e)}")
        return {"project": safe_proj, "questions": []}


@router.post("/api/projects/{project_id}/questions")
async def save_project_questions(project_id: str, request: Request, payload: dict = Body(...)):
    user = getattr(request.state, "user", None) or current_user_var.get()
    if user and user.get("role") == "viewer":
        raise HTTPException(status_code=403, detail="Režim pozorovatele: Nemáte oprávnění upravovat otázky projektu.")

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
        "scheduleMode": "sequential",
        "questions": [],
    }
    if os.path.exists(planner_file):
        try:
            with open(planner_file, encoding="utf-8") as f:
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


@router.post("/api/projects/{project_id}/ai-classify-questions")
async def ai_classify_questions_endpoint(project_id: str, request: Request, payload: dict = Body(default={})):
    user = getattr(request.state, "user", None) or current_user_var.get()
    if user and user.get("role") == "viewer":
        raise HTTPException(
            status_code=403, detail="Režim pozorovatele: Nemáte oprávnění provádět AI klasifikaci otázek."
        )
    safe_proj = sanitize_name(project_id)
    proj_dir = os.path.join(UPLOAD_DIR, safe_proj)
    planner_file = os.path.join(proj_dir, PLANNER_FILENAME)

    if not os.path.exists(planner_file):
        raise HTTPException(status_code=404, detail="Pro daný projekt neexistuje plánovač ani seznam otázek.")

    try:
        with open(planner_file, encoding="utf-8") as f:
            planner_data = json.load(f)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Chyba při čtení plánovače: {str(e)}")

    questions = planner_data.get("questions", [])
    if not questions:
        raise HTTPException(status_code=400, detail="Projekt neobsahuje žádné otázky ke klasifikaci.")

    await send_log(f"🤖 Zahajuji AI klasifikaci {len(questions)} otázek pro projekt '{safe_proj}'...")

    compact_questions = []
    for idx, q in enumerate(questions):
        compact_questions.append(
            {
                "id": q.get("id") or f"pq_{idx + 1}",
                "index": idx + 1,
                "title": q.get("title", ""),
                "current_topic": q.get("topic", "Všeobecné"),
            }
        )

    prompt_system = (
        "Jsi špičkový profesor medicíny a didaktik lékařských fakult. "
        "Tvým úkolem je každou z následujících zkouškových otázek z medicíny přesně a logicky zařadit do správného lékařského oboru / okruhu.\n\n"
        "STRIKTNÍ PRAVIDLA:\n"
        "1. Používej čisté, zavedené české názvy lékařských oborů (např. Kardiologie, Pneumologie, Gastroenterologie, Hematologie, Nefrologie, Endokrinologie, Revmatologie, Infektologie, Neurologie, Onkologie, Akutní medicína, Všeobecné vnitřní lékařství, Chirurgie apod.).\n"
        "2. Pokud je otázka složená z více témat (např. 'a) Astma bronchiale, b) Nehodgkinské lymfomy'), zvol obor prvního/dominantního tématu nebo nejvýstižnější obor.\n"
        "3. Vyhni se obecným nicneříkajícím názvům jako 'Lístek 1' nebo 'Otázka'.\n"
        "4. Výstup musí být striktní JSON pole objektů s klíči 'id' a 'topic'. Pokud text otázky obsahuje číslo lístku nebo otázky, můžeš doplnit i 'number'.\n"
        "Příklad:\n"
        '[{"id": "pq_1", "topic": "Pneumologie", "number": "1"}]'
    )

    prompt_user = (
        f"Zde je seznam otázek k didaktickému zařazení do lékařských oborů:\n"
        f"{json.dumps(compact_questions, ensure_ascii=False, indent=1)}"
    )

    gemini_model = payload.get("gemini_model") or "gemini-3.6-flash"
    try:
        response_text = await call_gemini_with_retries(
            model=gemini_model,
            contents=[prompt_user],
            system_instruction=prompt_system,
            temperature=0.1,
            response_mime_type="application/json",
        )

        classified = clean_and_parse_json(response_text)
        if not isinstance(classified, list) or len(classified) == 0:
            match = re.search(r"\[\s*\{.*\}\s*\]", response_text, re.DOTALL)
            if match:
                classified = json.loads(match.group(0), strict=False)

        topic_map = {}
        number_map = {}
        for item in classified or []:
            if isinstance(item, dict) and "id" in item:
                if item.get("topic"):
                    topic_map[str(item["id"])] = str(item["topic"]).strip()
                if item.get("number"):
                    number_map[str(item["id"])] = str(item["number"]).strip()

        updated_count = 0
        categories_set = set()
        for idx, q in enumerate(questions):
            q_id = str(q.get("id") or f"pq_{idx + 1}")
            if q_id in topic_map:
                q["topic"] = topic_map[q_id]
                updated_count += 1
            elif idx < len(classified) and isinstance(classified[idx], dict) and classified[idx].get("topic"):
                q["topic"] = str(classified[idx]["topic"]).strip()
                updated_count += 1

            if q_id in number_map and not q.get("number"):
                q["number"] = number_map[q_id]

            categories_set.add(q.get("topic") or "Všeobecné")

        planner_data["questions"] = questions
        with open(planner_file, "w", encoding="utf-8") as f:
            json.dump(planner_data, f, ensure_ascii=False, indent=2)

        categories_list = sorted(list(categories_set))
        await send_log(
            f"✅ AI úspěšně překategorizovala {updated_count} otázek do {len(categories_list)} oborů: {', '.join(categories_list[:5])}..."
        )
        return {
            "status": "success",
            "project": safe_proj,
            "questions": questions,
            "categories": categories_list,
            "updated_count": updated_count,
        }
    except Exception as e:
        await send_log(f"❌ Chyba při AI klasifikaci otázek: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Chyba AI klasifikace: {str(e)}")


# --- 2. VÝUKOVÁ LEKCE OD A DO Z (EDUCATIONAL LECTURE GENERATOR) ---
@router.post("/api/lessons/generate")
async def generate_lesson_endpoint(
    project_name: str | None = Form(None),
    title: str = Form(...),
    target_language: str = Form("Čeština"),
    gemini_model: str = Form("gemini-3.6-flash"),
    tts_provider: str = Form("openai"),
    tts_voice: str = Form("onyx"),
    files: list[UploadFile] = File(...),
):
    if not title.strip():
        raise HTTPException(status_code=400, detail="Chybí název lekce.")
    if not files:
        raise HTTPException(status_code=400, detail="Musíte nahrát alespoň jeden soubor.")

    # Samostatný identifikátor lekce, ukládaný mimo prostor projektů (nepřidává se do projektů)
    raw_lesson_id = f"lekce_{title}"
    safe_lesson_id = sanitize_name(raw_lesson_id)

    # 1. Založení dedikované složky lekce v LESSONS_DIR (mimo uploads/)
    lesson_dir = os.path.join(LESSONS_DIR, safe_lesson_id)
    os.makedirs(lesson_dir, exist_ok=True)
    await send_log(f"🎓 Zahajuji tvorbu výukové lekce od A do Z: '{title}' (ID: {safe_lesson_id})")

    # 2. Uložení nahraných souborů na disk do složky lekce
    saved_file_tuples: list[tuple[str, str]] = []
    for file in files:
        safe_fname = "".join([c for c in file.filename if c.isalnum() or c in (" ", ".", "_", "-")]).strip()
        fpath = os.path.join(lesson_dir, safe_fname)
        with open(fpath, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)
        saved_file_tuples.append((fpath, safe_fname))

    # Callback pro rozesílání progress událostí do SSE
    async def progress_notifier(evt_data: dict):
        await publish_event("lesson_progress", evt_data)

    try:
        lesson_result = await generate_lesson_package(
            project_id=safe_lesson_id,
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


@router.get("/api/lessons")
async def list_lessons_endpoint():
    try:
        lessons = list_lessons()
        return {"lessons": lessons}
    except Exception as e:
        return {"lessons": [], "error": str(e)}


@router.get("/api/lessons/{project_id}")
async def get_lesson_endpoint(project_id: str):
    safe_proj = sanitize_name(project_id)
    lesson = get_lesson(safe_proj)
    if not lesson:
        raise HTTPException(status_code=404, detail="Výuková lekce nenalezena.")
    return {"lesson": lesson}


@router.delete("/api/lessons/{project_id}")
async def delete_lesson_endpoint(project_id: str):
    safe_id = sanitize_name(project_id)
    from chat_service import delete_lesson_records

    delete_lesson_records(safe_id)

    # 1. Smazání dedikované složky lekce z LESSONS_DIR a UPLOAD_DIR
    for base_dir in [LESSONS_DIR, UPLOAD_DIR]:
        p = os.path.join(base_dir, safe_id)
        if os.path.exists(p):
            try:
                shutil.rmtree(p, ignore_errors=True)
            except Exception as e:
                print(f"⚠️ Chyba při mazání složky lekce {p}: {e}")

    # 2. Smazání ChromaDB kolekce lekce
    try:
        get_chroma_client().delete_collection(name=f"proj_{safe_id}")
    except Exception:
        pass

    # 3. Smazání generovaného audia lekce
    for fname in os.listdir(AUDIO_DIR):
        if fname.startswith(f"{safe_id}_"):
            try:
                os.remove(os.path.join(AUDIO_DIR, fname))
            except Exception:
                pass

    # 4. Smazání poznámek lekce
    for fname in os.listdir(NOTES_DIR):
        if fname.startswith(f"{safe_id}_"):
            try:
                os.remove(os.path.join(NOTES_DIR, fname))
            except Exception:
                pass

    await send_log(f"🗑️ Výuková lekce '{safe_id}' a veškerá její data byla úspěšně smazána.")
    return {"status": "success", "project": safe_id}
