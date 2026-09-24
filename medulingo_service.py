import os
import re
import json
import time
import asyncio
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

# Helper for string normalization
def normalize_name(s: str) -> str:
    if not s:
        return ""
    import unicodedata
    n = unicodedata.normalize('NFKD', s)
    stripped = "".join([c for c in n if not unicodedata.combining(c)])
    return re.sub(r'[^a-zA-Z0-9]+', '', stripped.lower())

def sanitize_name(name: str) -> str:
    cleaned = re.sub(r"[^\w\-_.]", "_", name.strip())
    return re.sub(r"_+", "_", cleaned)

# Thematic icons for categories
CATEGORY_ICONS = {
    "pneumo": "🫁",
    "plíc": "🫁",
    "kardio": "❤️",
    "srdc": "❤️",
    "hemato": "🩸",
    "krev": "🩸",
    "gastro": "🧪",
    "jater": "🧪",
    "tráv": "🧪",
    "endokrin": "🧬",
    "štítn": "🧬",
    "diabetes": "🧬",
    "nefro": "💧",
    "ledvin": "💧",
    "revmat": "🦴",
    "kloub": "🦴",
    "neuro": "🧠",
    "mozek": "🧠",
    "infekc": "🦠",
    "onko": "🎗️",
    "lymfom": "🩸",
    "všeobec": "🩺",
    "interna": "🩺",
    "akutn": "⚡",
    "aro": "⚡",
}

def get_category_icon(category_name: str) -> str:
    cat_lower = (category_name or "").lower()
    for key, icon in CATEGORY_ICONS.items():
        if key in cat_lower:
            return icon
    return "🩺"

MEDULINGO_PODCAST_PROMPT = r"""Jsi špičkový profesor medicíny a charismatický klinický pedagog.
Tvým úkolem je vytvořit krátký, svižný a maximálně hutný výukový audio podcast (cca 3 až 5 minut mluveného slova, cca 450 až 750 slov) ke zkouškové otázce: {QUESTION}.

KRITICKÁ PRAVIDLA PRO MEDULINGO PODCAST:
1. PŘÍMÝ ÚDERNÝ START BEZ OMÁČKY:
   - Žádné zdlouhavé uvítací řeči, formální ceremonie ani prázdný úvod typu "Vítám vás u dnešního dílu".
   - Začni maximálně jednou svižnou větou a OKAMŽITĚ jdi k meritu věci a klinickému problému.

2. KLINICKÁ HLOUBKA & INTUITIVNÍ ANALOGIE:
   - Proč onemocnění vzniká (patofyziologie vysvětlená pomocí jedné trefné analogie ze života).
   - Rozhodující diagnostická kritéria a mezní čísla.
   - Farmakoterapie první volby a zásadní kontraindikace.
   - 2–3 nejnebezpečnější klinické pasti a chytáky zkoušejících (Red Flags).

3. STRUKTURA S KAPITOLAMI:
   Scénář striktně rozděl do 3 až 4 logických kapitol označených přesně tímto značkovačem na samostatném řádku:
   [KAPITOLA: 01 | Klinický obraz a jádro problému]
   [KAPITOLA: 02 | Klíčová patofyziologie a diagnostika]
   [KAPITOLA: 03 | Léčebná strategie a Red Flags]
"""

class MedulingoService:
    def __init__(self, user_data_dir: str):
        self.user_data_dir = user_data_dir
        self.upload_dir = os.path.join(user_data_dir, "uploads")
        self.audio_dir = os.path.join(user_data_dir, "generated_audio")
        self.notes_dir = os.path.join(user_data_dir, "generated_notes")
        self.flashcards_dir = os.path.join(user_data_dir, "generated_flashcards")
        self.tests_dir = os.path.join(user_data_dir, "generated_tests")

    def _get_planner_data(self, project: str) -> Dict[str, Any]:
        safe_proj = sanitize_name(project)
        planner_file = os.path.join(self.upload_dir, safe_proj, "exam_planner.json")
        if not os.path.exists(planner_file):
            return {
                "examDate": "",
                "startDate": "",
                "revisionDays": 14,
                "questions": []
            }
        try:
            with open(planner_file, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return {
                "examDate": "",
                "startDate": "",
                "revisionDays": 14,
                "questions": []
            }

    def _save_planner_data(self, project: str, data: Dict[str, Any]) -> None:
        safe_proj = sanitize_name(project)
        proj_dir = os.path.join(self.upload_dir, safe_proj)
        os.makedirs(proj_dir, exist_ok=True)
        planner_file = os.path.join(proj_dir, "exam_planner.json")
        with open(planner_file, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

    def scan_project_assets(self, project: str) -> Dict[str, Any]:
        """Indexuje existující soubory v projektu pro bleskurychlé párování k otázkám."""
        safe_proj = sanitize_name(project)
        safe_proj_norm = normalize_name(safe_proj)

        # 1. Notes
        notes_list = []
        if os.path.exists(self.notes_dir):
            for f in os.listdir(self.notes_dir):
                if f.endswith(".md") and (not safe_proj or f.startswith(f"{safe_proj}_") or safe_proj_norm in normalize_name(f)):
                    notes_list.append(f)

        # 2. Flashcards
        cards_dict = {}  # norm_question -> file
        if os.path.exists(self.flashcards_dir):
            for f in os.listdir(self.flashcards_dir):
                if f.endswith(".json") and (not safe_proj or f.startswith(f"{safe_proj}_") or safe_proj_norm in normalize_name(f)):
                    fpath = os.path.join(self.flashcards_dir, f)
                    try:
                        with open(fpath, "r", encoding="utf-8") as fl:
                            cdata = json.load(fl)
                            q_title = cdata.get("question", "")
                            if q_title:
                                cards_dict[normalize_name(q_title)] = (f, len(cdata.get("cards", [])))
                    except Exception:
                        pass

        # 3. Audio
        audio_list = []
        if os.path.exists(self.audio_dir):
            for f in os.listdir(self.audio_dir):
                if f.endswith(".mp3") and (not safe_proj or f.startswith(f"{safe_proj}_") or safe_proj_norm in normalize_name(f)):
                    audio_list.append(f)

        # 4. Tests
        tests_list = []
        if os.path.exists(self.tests_dir):
            for f in os.listdir(self.tests_dir):
                if f.endswith(".json") and (not safe_proj or f.startswith(f"{safe_proj}_") or safe_proj_norm in normalize_name(f)):
                    fpath = os.path.join(self.tests_dir, f)
                    try:
                        with open(fpath, "r", encoding="utf-8") as fl:
                            tdata = json.load(fl)
                            t_title = tdata.get("title", "")
                            t_qs = tdata.get("questions", [])
                            tests_list.append({
                                "filename": f,
                                "title": t_title,
                                "questions": tdata.get("original_questions") or [t_title],
                                "item_count": len(t_qs)
                            })
                    except Exception:
                        pass

        return {
            "notes": notes_list,
            "cards": cards_dict,
            "audio": audio_list,
            "tests": tests_list,
        }

    def match_question_assets(self, q: Dict[str, Any], assets: Dict[str, Any], project: str) -> Dict[str, Any]:
        """Zjistí dostupnost jednotlivých studijních modulů pro danou otázku."""
        title = q.get("title", "")
        number = str(q.get("number", ""))
        q_norm = normalize_name(title)
        num_tag = f"q{number}" if number else ""

        # Match Notes
        has_notes = False
        notes_file = None
        for nf in assets["notes"]:
            nf_norm = normalize_name(nf)
            if q_norm and (q_norm in nf_norm or (num_tag and num_tag in nf_norm)):
                has_notes = True
                notes_file = nf
                break

        # Fallback to planner status
        if not has_notes and q.get("notesStatus") == "Done":
            has_notes = True

        # Match Cards
        has_cards = False
        cards_file = None
        cards_count = 0
        if q_norm in assets["cards"]:
            has_cards = True
            cards_file, cards_count = assets["cards"][q_norm]
        else:
            for c_q_norm, (cf, count) in assets["cards"].items():
                if q_norm and (q_norm in c_q_norm or c_q_norm in q_norm):
                    has_cards = True
                    cards_file = cf
                    cards_count = count
                    break

        # Match Audio
        has_audio = False
        audio_file = None
        for af in assets["audio"]:
            af_norm = normalize_name(af)
            if q_norm and (q_norm in af_norm or (num_tag and f"q{number}_" in af.lower())):
                has_audio = True
                audio_file = af
                break

        # Match Test
        has_test = False
        test_file = None
        for tf in assets["tests"]:
            t_norm = normalize_name(tf["title"])
            if q_norm and (q_norm in t_norm or any(q_norm in normalize_name(str(x)) for x in tf["questions"])):
                has_test = True
                test_file = tf["filename"]
                break

        is_completed = bool(q.get("completedDate"))

        # Ready means ready to learn without immediate generation (has at least notes or cards)
        is_ready = has_notes or has_cards or has_audio

        return {
            "has_notes": has_notes,
            "notes_file": notes_file,
            "has_cards": has_cards,
            "cards_file": cards_file,
            "cards_count": cards_count,
            "has_audio": has_audio,
            "audio_file": audio_file,
            "has_test": has_test,
            "test_file": test_file,
            "is_ready": is_ready,
            "is_completed": is_completed,
            "grade": q.get("grade"),
            "completedDate": q.get("completedDate"),
        }

    def get_medulingo_overview(self, project: str) -> Dict[str, Any]:
        planner = self._get_planner_data(project)
        questions = planner.get("questions", [])
        assets = self.scan_project_assets(project)

        today_str = datetime.now().strftime("%Y-%m-%d")
        exam_date = planner.get("examDate", "")
        start_date = planner.get("startDate", "")
        rev_days = int(planner.get("revisionDays", 14) or 14)

        # Days calculation
        study_days = 0
        if exam_date:
            try:
                d_exam = datetime.strptime(exam_date, "%Y-%m-%d").date()
                d_today = datetime.now().date()
                if start_date:
                    d_start = datetime.strptime(start_date, "%Y-%m-%d").date()
                    if d_start > d_today:
                        study_days = max(0, (d_exam - d_start).days)
                    else:
                        study_days = max(0, (d_exam - d_today).days)
                else:
                    study_days = max(0, (d_exam - d_today).days)
            except Exception:
                study_days = 0

        net_study_days = max(0, study_days - rev_days)
        total_questions = len(questions)
        completed_questions = sum(1 for q in questions if q.get("completedDate"))
        completed_today = sum(1 for q in questions if q.get("completedDate") == today_str)

        remaining = max(0, total_questions - (completed_questions - completed_today))
        if total_questions > 0 and completed_questions == total_questions:
            questions_per_day = 0
        elif study_days == 0 or net_study_days == 0:
            questions_per_day = remaining
        else:
            questions_per_day = int(-(-remaining // net_study_days))  # ceil division

        progress_pct = int(round((completed_questions / total_questions) * 100)) if total_questions > 0 else 0

        # Process each question and group by categories (Units)
        categories_map: Dict[str, Dict[str, Any]] = {}
        processed_questions: List[Dict[str, Any]] = []

        uncompleted_in_order: List[Dict[str, Any]] = []

        for idx, q in enumerate(questions):
            q_id = q.get("id") or f"q_{idx+1}"
            topic = (q.get("topic") or "Všeobecné").strip()
            match_info = self.match_question_assets(q, assets, project)

            q_obj = {
                "id": q_id,
                "q_index": idx + 1,
                "number": q.get("number", str(idx + 1)),
                "title": q.get("title", f"Otázka {idx+1}"),
                "topic": topic,
                "note": q.get("note", ""),
                **match_info,
            }
            processed_questions.append(q_obj)

            if not match_info["is_completed"]:
                uncompleted_in_order.append(q_obj)

            # Group into Unit
            if topic not in categories_map:
                categories_map[topic] = {
                    "id": sanitize_name(topic).lower(),
                    "title": topic,
                    "icon": get_category_icon(topic),
                    "questions": [],
                    "total_count": 0,
                    "completed_count": 0,
                    "ready_count": 0,
                    "progress_pct": 0,
                }

            cat = categories_map[topic]
            cat["questions"].append(q_obj)
            cat["total_count"] += 1
            if match_info["is_completed"]:
                cat["completed_count"] += 1
            if match_info["is_ready"]:
                cat["ready_count"] += 1

        # Ensure no unit has only 1 question if there are multiple categories
        single_cats = [t for t, c in categories_map.items() if c["total_count"] == 1 and t != "Všeobecné"]
        if single_cats and len(categories_map) > 1:
            if "Všeobecné" not in categories_map:
                categories_map["Všeobecné"] = {
                    "id": "vseobecne",
                    "title": "Všeobecné",
                    "icon": get_category_icon("Všeobecné"),
                    "questions": [],
                    "total_count": 0,
                    "completed_count": 0,
                    "ready_count": 0,
                    "progress_pct": 0,
                }
            vseb = categories_map["Všeobecné"]
            for sc in single_cats:
                cat = categories_map.pop(sc)
                for q in cat["questions"]:
                    q["topic"] = "Všeobecné"
                    vseb["questions"].append(q)
                    vseb["total_count"] += 1
                    if q["is_completed"]:
                        vseb["completed_count"] += 1
                    if q["is_ready"]:
                        vseb["ready_count"] += 1

        # Calculate unit progress
        units: List[Dict[str, Any]] = []
        for cat in categories_map.values():
            if cat["total_count"] > 0:
                cat["progress_pct"] = int(round((cat["completed_count"] / cat["total_count"]) * 100))
            units.append(cat)

        # Buffer Analysis: How many upcoming uncompleted questions in order are already generated?
        buffer_ready_count = 0
        for uq in uncompleted_in_order:
            if uq["is_ready"]:
                buffer_ready_count += 1
            else:
                break  # Stopped at first non-ready question

        target_today = max(1, questions_per_day)
        needs_buffer_warning = (buffer_ready_count < 2 and len(uncompleted_in_order) > 0)
        
        warning_message = ""
        if needs_buffer_warning:
            if buffer_ready_count == 0:
                warning_message = f"Pozor: Pro následující otázku nemáte vygenerovaný obsah! Váš cíl je {questions_per_day} ot./den. Vygenerujte si podklady dopředu pro plynulé učení."
            else:
                warning_message = f"Pozor: Máte připraveno pouze {buffer_ready_count} otázek dopředu. Doporučujeme vygenerovat podklady pro další 2–3 otázky."

        suggested_question = uncompleted_in_order[0] if uncompleted_in_order else None

        # Streak calculation (simulate or check completed dates)
        streak = 1 if completed_today > 0 else 0

        return {
            "project": project,
            "metrics": {
                "today_str": today_str,
                "exam_date": exam_date,
                "study_days_remaining": study_days,
                "net_study_days": net_study_days,
                "total_questions": total_questions,
                "completed_questions": completed_questions,
                "completed_today": completed_today,
                "questions_per_day": questions_per_day,
                "progress_pct": progress_pct,
                "streak": streak,
            },
            "buffer": {
                "buffer_ready_count": buffer_ready_count,
                "needs_warning": needs_buffer_warning,
                "warning_message": warning_message,
                "suggested_question_id": suggested_question["id"] if suggested_question else None,
                "suggested_question_title": suggested_question["title"] if suggested_question else None,
            },
            "units": units,
            "all_questions": processed_questions,
        }

    def get_question_path_content(self, project: str, question_id_or_title: str) -> Dict[str, Any]:
        """Načte kompletní data pro 5 uzlů zkouškové otázky."""
        planner = self._get_planner_data(project)
        questions = planner.get("questions", [])

        target_q = None
        for idx, q in enumerate(questions):
            qid = q.get("id") or f"q_{idx+1}"
            if qid == question_id_or_title or q.get("title") == question_id_or_title or str(q.get("number")) == str(question_id_or_title):
                target_q = q
                target_q["id"] = qid
                target_q["q_index"] = idx + 1
                break

        if not target_q:
            return {"error": "Otázka nenalezena v plánovači."}

        assets = self.scan_project_assets(project)
        match_info = self.match_question_assets(target_q, assets, project)

        # 1. Notes Breakdown into Subtopics
        subtopics = []
        raw_markdown = ""
        sources = []
        notes_project = project
        if match_info["has_notes"] and match_info["notes_file"]:
            fpath = os.path.join(self.notes_dir, match_info["notes_file"])
            if os.path.exists(fpath):
                try:
                    with open(fpath, "r", encoding="utf-8") as f:
                        raw_markdown = f.read()
                    meta_match = re.search(r'^<!-- METADATA\s*(\{.*?\})\s*-->', raw_markdown, flags=re.DOTALL)
                    if meta_match:
                        try:
                            meta_json = json.loads(meta_match.group(1))
                            sources = meta_json.get("sources", [])
                            if meta_json.get("project"):
                                notes_project = meta_json.get("project")
                        except Exception:
                            pass
                    # Strip metadata header
                    clean_md = re.sub(r'^<!-- METADATA.*?-->\s*', '', raw_markdown, flags=re.DOTALL)
                    subtopics = self._extract_subtopics(clean_md, target_q.get("title", ""))
                except Exception:
                    pass

        # 2. Podcast info
        podcast_info = None
        if match_info["has_audio"] and match_info["audio_file"]:
            audio_url = f"/audio/{match_info['audio_file']}"
            srt_file = match_info["audio_file"].replace(".mp3", ".srt")
            srt_path = os.path.join(self.audio_dir, srt_file)
            has_subtitles = os.path.exists(srt_path)
            podcast_info = {
                "audio_url": audio_url,
                "filename": match_info["audio_file"],
                "has_subtitles": has_subtitles,
                "srt_url": f"/audio/{srt_file}" if has_subtitles else None,
            }

        # 3. Flashcards
        cards = []
        if match_info["has_cards"] and match_info["cards_file"]:
            fpath = os.path.join(self.flashcards_dir, match_info["cards_file"])
            if os.path.exists(fpath):
                try:
                    with open(fpath, "r", encoding="utf-8") as f:
                        cdata = json.load(f)
                        cards = cdata.get("cards", [])
                except Exception:
                    pass

        # 4. Final Test
        test_questions = []
        if match_info["has_test"] and match_info["test_file"]:
            fpath = os.path.join(self.tests_dir, match_info["test_file"])
            if os.path.exists(fpath):
                try:
                    with open(fpath, "r", encoding="utf-8") as f:
                        tdata = json.load(f)
                        test_questions = tdata.get("questions", [])
                except Exception:
                    pass

        return {
            "project": project,
            "question": {
                "id": target_q["id"],
                "number": target_q.get("number", "1"),
                "title": target_q.get("title", ""),
                "topic": target_q.get("topic", "Všeobecné"),
                "grade": target_q.get("grade"),
                "completedDate": target_q.get("completedDate"),
            },
            "status": match_info,
            "sources": sources,
            "project": notes_project,
            "subtopics": subtopics,
            "podcast": podcast_info,
            "flashcards": cards,
            "test": {
                "questions": test_questions,
                "filename": match_info.get("test_file"),
            }
        }

    def _extract_subtopics(self, markdown_text: str, question_title: str) -> List[Dict[str, Any]]:
        """Rozdělí komplexní studijní text na logická stravitelná podtémata pro Duolingo čtení."""
        # Split by ## headers
        sections = re.split(r'\n(?=##\s+)', markdown_text)
        subtopics = []

        if len(sections) <= 1:
            # Fallback if no ## found: split by # or return single topic
            return [{
                "id": 1,
                "title": question_title or "Kompletní výklad",
                "content": markdown_text
            }]

        for idx, sec in enumerate(sections):
            sec_clean = sec.strip()
            if not sec_clean:
                continue

            # Extract title
            m = re.match(r'^(?:#+)\s*([^:\n]+)[:\n]?(.*)$', sec_clean, re.DOTALL)
            if m:
                s_title = m.group(1).strip()
                s_content = sec_clean
            else:
                s_title = f"Část {idx + 1}"
                s_content = sec_clean

            # Clean up redundant prefixes like ## 1. or ## Otvírák
            display_title = re.sub(r'^[0-9]+[\.\)]\s*', '', s_title)

            subtopics.append({
                "id": idx + 1,
                "title": display_title,
                "content": s_content
            })

        return subtopics

    def complete_question(self, project: str, question_id: str, grade: str = "A", completed: bool = True) -> Dict[str, Any]:
        """Označí otázku v Plánovači zkoušky jako splněnou a zapíše známku, nebo označí jako nesplněnou."""
        planner = self._get_planner_data(project)
        questions = planner.get("questions", [])
        today_str = datetime.now().strftime("%Y-%m-%d")

        found = False
        next_q_id = None

        for idx, q in enumerate(questions):
            qid = q.get("id") or f"q_{idx+1}"
            if qid == question_id or q.get("title") == question_id or str(q.get("number")) == str(question_id):
                if completed:
                    q["completedDate"] = today_str
                    q["grade"] = grade.upper() if grade else "A"
                    q["status"] = "Completed"
                else:
                    q["completedDate"] = None
                    q["grade"] = None
                    q["status"] = "Ready"
                found = True
                # Find next uncompleted question
                for next_idx in range(idx + 1, len(questions)):
                    if not questions[next_idx].get("completedDate"):
                        next_q_id = questions[next_idx].get("id") or f"q_{next_idx+1}"
                        break
                break

        if found:
            self._save_planner_data(project, planner)

        return {
            "status": "success",
            "is_completed": bool(completed),
            "completedDate": today_str if completed else None,
            "grade": grade if completed else None,
            "next_question_id": next_q_id,
        }
