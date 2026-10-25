"""Generování cvičných testů a navazujících otázek přes RAG a Gemini v dávkách."""

import time
import uuid
from datetime import datetime
from typing import Any

from core.config import AI
from prompts.test import DEFAULT_TEST_PROMPT_SYSTEM
from services.practice_tests.parsing import parse_and_validate_test_json
from services.practice_tests.storage import TestStorageManager


def calculate_batch_sizes(total: int, max_per_batch: int = 6) -> list[int]:
    """Rozdělí celkový počet otázek do bezpečných dávek, aby nedošlo k useknutí tokenového limitu modelu."""
    if total <= max_per_batch:
        return [total]
    num_batches = (total + max_per_batch - 1) // max_per_batch
    base = total // num_batches
    rem = total % num_batches
    return [base + 1 if i < rem else base for i in range(num_batches)]


async def generate_practice_test(
    project: str,
    questions: list[str],
    count: int = 10,
    question_types: list[str] | None = None,
    difficulty: str = "normal",
    mode: str = "instant",
    custom_prompt: str = "",
    gemini_model: str = AI.default_gemini_model,
    tests_dir: str = "",
    rag_query_fn=None,
    gemini_call_fn=None,
    log_fn=None,
    categories: list[str] | None = None,
    categories_map: dict[str, list[str]] | None = None,
    question_id: str | None = None,
) -> tuple[dict[str, Any], str]:
    """
    Vygeneruje kompletní procvičovací test na základě zadaných otázek, kategorií a materiálů v RAG.
    Při větším počtu otázek automaticky využívá dávkování (chunking) pro prevenci limitu výstupních tokenů.
    """
    target_count = max(1, min(int(count), 50))
    valid_types = ["single_choice", "multi_choice", "open_ended", "case_study", "true_false"]
    if not question_types:
        selected_types = ["single_choice", "multi_choice"]
    else:
        selected_types = [t for t in question_types if t in valid_types]
        if not selected_types:
            selected_types = ["single_choice", "multi_choice"]

    valid_diffs = {
        "easy": "easy (lehčí, základní algoritmy a koncepty)",
        "normal": "normal (standardní zkoušková úroveň LF, vícekrokové uvažování)",
        "hard": "hard (těžší, klinické zvraty, atypické manifestace, překryvné syndromy)",
    }
    diff_desc = valid_diffs.get(difficulty.lower(), valid_diffs["normal"])

    # 1. RAG Rešerše podkladů
    if categories:
        combined_query = " ".join(categories)
        if questions:
            combined_query += " " + " ".join(questions[:4])
    else:
        combined_query = " ".join(questions[:5]) if questions else project

    if log_fn:
        cat_info = f" ({len(categories)} kategorií)" if categories else ""
        await log_fn(
            f"📋 Testové otázky: Načítám RAG kontext pro {len(questions)} témat{cat_info} v projektu '{project}'..."
        )

    context_text = ""
    unique_sources = []
    if rag_query_fn:
        try:
            context_text, unique_sources, _ = await rag_query_fn(combined_query, project, n_results=35)
        except Exception as e:
            if log_fn:
                await log_fn(f"⚠️ RAG dotaz skončil s varováním ({e}), pokračuji bez RAG kontextu...")

    sources_summary = "\n".join(
        [f"[{s.get('id', idx + 1)}] {s.get('filename', 'materiál')}" for idx, s in enumerate(unique_sources)]
    )

    # 2. Sestavení struktury témat a pokrytí
    allowed_types_str = ", ".join(selected_types)

    if categories_map:
        cat_lines = []
        for cat, q_list in categories_map.items():
            cat_lines.append(f"📁 KATEGORIE / OKRUH: {cat}")
            if q_list:
                cat_lines.append("  Zkouškové otázky zařazené v této kategorii:")
                for q_title in q_list:
                    cat_lines.append(f"   - {q_title}")
            else:
                cat_lines.append(f"   - Všechna témata v okruhu {cat}")
            cat_lines.append("")
        topics_str = "\n".join(cat_lines).strip()
        coverage_requirement = (
            "\n[STRIKTNÍ POŽADAVEK NA POKRÝTÍ KATEGORIÍ A ZKOUŠKOVÝCH OTÁZEK]:\n"
            "Uživatel vybral tyto kategorie a požaduje, aby test komplexně a rovnoměrně "
            "pokryl VŠECHNA tato témata včetně konceptů ze VŠECH uvedených zkouškových otázek v těchto kategoriích. "
            "Každá vygenerovaná otázka musí v poli 'topic' nést název příslušné kategorie / zkouškové otázky!\n\n"
        )
    elif categories:
        topics_str = "\n".join([f"📁 KATEGORIE / OKRUH: {cat}" for cat in categories])
        if questions:
            topics_str += "\n\nZkouškové otázky z těchto kategorií:\n" + "\n".join([f"- {q}" for q in questions])
        coverage_requirement = (
            "\n[STRIKTNÍ POŽADAVEK NA POKRÝTÍ KATEGORIÍ A ZKOUŠKOVÝCH OTÁZEK]:\n"
            "Uživatel vybral tyto kategorie a požaduje, aby test komplexně a rovnoměrně pokryl zadaná témata "
            "včetně všech uvedených zkouškových otázek.\n\n"
        )
    else:
        topics_str = "\n".join([f"- {q}" for q in questions]) if questions else f"- {project}"
        coverage_requirement = ""

    # 3. Dávkování (Chunking) pro garanci generování požadovaného počtu bez useknutí tokeny
    batches = calculate_batch_sizes(target_count, max_per_batch=6)
    total_batches = len(batches)
    accumulated_questions: list[dict[str, Any]] = []

    for b_idx, b_count in enumerate(batches, 1):
        if log_fn:
            if total_batches > 1:
                await log_fn(
                    f"🚀 Generuji testové otázky: dávka {b_idx}/{total_batches} ({b_count} otázek, cíl celkem: {target_count})..."
                )
            else:
                await log_fn(
                    f"🚀 Odesílám požadavek na generování {b_count} testových otázek přes {gemini_model} (obtížnost: {difficulty})..."
                )

        system_instruction = (
            DEFAULT_TEST_PROMPT_SYSTEM.replace("{COUNT}", str(b_count))
            .replace("{ALLOWED_TYPES}", allowed_types_str)
            .replace("{DIFFICULTY}", diff_desc)
        )

        if custom_prompt and custom_prompt.strip():
            system_instruction += f"\n\n[DOPLŇUJÍCÍ UŽIVATELSKÉ INSTRUKCE]:\n{custom_prompt.strip()}"

        # Zákaz duplicit vůči předchozím dávkám
        if accumulated_questions:
            prev_q_texts = [f"- {q.get('question', '')}" for q in accumulated_questions if q.get("question")]
            system_instruction += (
                "\n\n[STRIKTNÍ ZÁKAZ DUPLICIT V TÉTO DÁVCE]: V předchozích dávkách již byly vytvořeny tyto otázky. "
                "JE PŘÍSNĚ ZAKÁZÁNO je opakovat nebo se ptát na stejné klinické souvislosti:\n"
                + "\n".join(prev_q_texts[-20:])
            )

        batch_user_content = (
            f"VYBRANÁ TÉMATA / KATEGORIE A ZKOUŠKOVÉ OTÁZKY PRO TEST:\n{topics_str}\n\n"
            f"{coverage_requirement}"
            f"POČET POŽADOVANÝCH OTÁZEK PRO TUTO DÁVKU: {b_count}\n"
            f"POVOLENÉ TYPY OTÁZEK: {allowed_types_str}\n"
            f"POŽADOVANÁ OBTÍŽNOST: {difficulty}\n\n"
            f"DŮRAZNÁ KONTROLA PŘED VYGENEROVÁNÍM KAŽDÉ OTÁZKY:\n"
            f"1. DÉLKA MOŽNOSTÍ: Správná odpověď nesmí být delší ani upovídanější než distraktory (všechny možnosti A-D musí mít symetrickou délku a formu)!\n"
            f"2. NÁHODNÁ POZICE: Neumisťuj správnou odpověď automaticky na A! Náhodně střídej písmena správné odpovědi (např. C, B, D, A) a v poli 'explanation' uveď odpovídající písmeno.\n\n"
            f"SEZNAM PŘIŘAZENÝCH ZDROJŮ PRO CITACE:\n{sources_summary if sources_summary else 'Využij odborné medicínské standardy.'}\n\n"
            f"=== ÚRYVKY ZE STUDIJNÍCH MATERIÁLŮ ===\n"
            f"{context_text if context_text else 'Učební podklady nejsou dostupné, generuj z medicínských znalostních standardů.'}\n"
            f"======================================"
        )

        raw_response = await gemini_call_fn(
            model=gemini_model,
            contents=[batch_user_content],
            system_instruction=system_instruction,
            temperature=AI.practice_test.temperature,
            max_output_tokens=AI.practice_test.max_output_tokens,
            response_mime_type="application/json",
        )

        parsed_batch = parse_and_validate_test_json(raw_response)
        if not parsed_batch:
            if log_fn:
                await log_fn(f"⚠️ Dávka {b_idx} selhala na prvním pokusu, zkouším opravný pokus...")
            retry_prompt = (
                system_instruction
                + "\n\nKRITICKÉ: Předchozí výstup nebyl platný JSON. Vrať POUZE čisté pole objektů [ { ... } ] bez jakéhokoliv dalšího textu."
            )
            try:
                raw_response = await gemini_call_fn(
                    model=gemini_model,
                    contents=[batch_user_content, "\n\nVrať prosím čisté JSON pole testových otázek."],
                    system_instruction=retry_prompt,
                    temperature=AI.practice_test_json_retry.temperature,
                    max_output_tokens=AI.practice_test_json_retry.max_output_tokens,
                    response_mime_type="application/json",
                )
                parsed_batch = parse_and_validate_test_json(raw_response)
            except Exception as retry_err:
                if log_fn:
                    await log_fn(f"⚠️ Opravný pokus dávky {b_idx} skončil chybou: {retry_err}")

        if parsed_batch:
            accumulated_questions.extend(parsed_batch)

    if not accumulated_questions:
        if log_fn:
            await log_fn("❌ Model nevrátil platný JSON seznam otázek. Zkuste generování zopakovat.")
        raise ValueError("Model nevrátil platný JSON seznam otázek. Zkuste generování zopakovat.")

    # Přečíslování ID a označení kola
    for idx, q in enumerate(accumulated_questions, 1):
        q["id"] = idx
        q["round"] = 1

    if questions and len(questions) == 1:
        test_title = f"Test: {questions[0]}"
    elif categories:
        if len(categories) == 1:
            test_title = f"Vlákno: {categories[0]}"
        elif len(categories) <= 3:
            test_title = f"Vlákno: {', '.join(categories)}"
        else:
            test_title = f"Vlákno: {', '.join(categories[:2])} (+{len(categories) - 2} kat.)"
    elif questions:
        test_title = f"Vlákno: {questions[0][:35]}"
        if len(questions) > 1:
            test_title += f" (+{len(questions) - 1} dalších)"
    else:
        test_title = f"Vlákno: {project}"

    test_payload = {
        "id": f"test_{int(time.time())}_{uuid.uuid4().hex[:6]}",
        "project": project,
        "title": test_title,
        "question_id": question_id or (questions[0] if (questions and len(questions) == 1) else None),
        "question_title": questions[0] if (questions and len(questions) == 1) else None,
        "created_at": datetime.now().isoformat(),
        "updated_at": datetime.now().isoformat(),
        "difficulty": difficulty,
        "mode": mode,
        "rounds": 1,
        "question_types": selected_types,
        "categories": categories or [],
        "categories_map": categories_map or {},
        "topics": questions,
        "sources": unique_sources,
        "questions": accumulated_questions,
        "result": {
            "completed": False,
            "score": 0,
            "max_score": len(accumulated_questions),
            "percentage": 0,
            "user_answers": {},
            "time_spent_seconds": 0,
        },
    }

    storage = TestStorageManager(tests_dir)
    filename = storage.save_test(test_payload)

    if log_fn:
        await log_fn(
            f"✅ Úspěšně vygenerován test s {len(accumulated_questions)} otázkami a uložen do vlákna '{filename}'."
        )

    return test_payload, filename


async def generate_more_test_questions(
    previous_test_id: str,
    project: str,
    count: int = 5,
    difficulty_shift: str = "same",  # "easier" | "same" | "harder"
    focus_mistakes: bool = True,
    gemini_model: str = AI.default_gemini_model,
    tests_dir: str = "",
    rag_query_fn=None,
    gemini_call_fn=None,
    log_fn=None,
) -> tuple[dict[str, Any], str]:
    """
    Dogeneruje další otázky přímo do stávajícího vlákna testu se zachováním jeho kategorií,
    otázek, historie a předchozích odpovědí uživatele.
    """
    storage = TestStorageManager(tests_dir)
    prev_test = storage.get_test(previous_test_id)
    if not prev_test:
        raise ValueError(f"Původní testovací vlákno '{previous_test_id}' nebyl nalezen.")

    prev_difficulty = prev_test.get("difficulty", "normal").lower()
    if difficulty_shift == "easier":
        new_difficulty = "easy" if prev_difficulty != "hard" else "normal"
    elif difficulty_shift == "harder":
        new_difficulty = "hard" if prev_difficulty != "easy" else "normal"
    else:
        new_difficulty = prev_difficulty

    existing_questions = prev_test.get("questions", [])
    prev_q_texts = [q.get("question", "") for q in existing_questions if q.get("question")]

    # Zjištění chybných otázek a témat z dosavadních výsledků
    mistaken_topics = []
    mistaken_questions = []
    res = prev_test.get("result", {})
    user_answers = res.get("user_answers", {})

    for q in existing_questions:
        qid_str = str(q.get("id"))
        u_ans = user_answers.get(qid_str)
        is_correct = False
        if isinstance(u_ans, dict):
            is_correct = bool(u_ans.get("is_correct", False))
        if not is_correct and u_ans is not None:
            mistaken_questions.append(q.get("question"))
            if q.get("topic") and q.get("topic") not in mistaken_topics:
                mistaken_topics.append(q.get("topic"))

    # Zachování původních kategorií a okruhů z vlákna!
    thread_categories = prev_test.get("categories", [])
    thread_categories_map = prev_test.get("categories_map", {})
    thread_topics = prev_test.get("topics", [])
    target_topics = thread_topics

    if focus_mistakes and mistaken_topics:
        target_topics = mistaken_topics

    rounds = prev_test.get("rounds", 1) + 1

    if log_fn:
        await log_fn(
            f"🔄 Vlákno '{prev_test.get('title')}': dogenerování {count} otázek (Kolo {rounds}, obtížnost shift '{difficulty_shift}' -> '{new_difficulty}', zaměření na chyby: {focus_mistakes})..."
        )

    # RAG rešerše zachovávající kontext vlákna
    if thread_categories:
        rag_query = " ".join(thread_categories)
        if target_topics:
            rag_query += " " + " ".join(target_topics[:4])
    else:
        rag_query = " ".join(target_topics[:4]) if target_topics else project

    context_text, unique_sources = "", []
    if rag_query_fn:
        try:
            context_text, unique_sources, _ = await rag_query_fn(rag_query, project, n_results=35)
        except Exception:
            pass

    target_count = max(1, min(int(count), 30))
    allowed_types = prev_test.get("question_types", ["single_choice", "multi_choice"])
    valid_diffs = {
        "easy": "easy (lehčí, základní algoritmy a koncepty)",
        "normal": "normal (standardní zkoušková úroveň LF, vícekrokové uvažování)",
        "hard": "hard (těžší, klinické zvraty, atypické manifestace, překryvné syndromy)",
    }
    diff_desc = valid_diffs.get(new_difficulty, valid_diffs["normal"])
    allowed_types_str = ", ".join(allowed_types)

    batches = calculate_batch_sizes(target_count, max_per_batch=6)
    new_questions_accumulated: list[dict[str, Any]] = []

    for b_idx, b_count in enumerate(batches, 1):
        system_instruction = (
            DEFAULT_TEST_PROMPT_SYSTEM.replace("{COUNT}", str(b_count))
            .replace("{ALLOWED_TYPES}", allowed_types_str)
            .replace("{DIFFICULTY}", diff_desc)
        )

        # Přísný zákaz duplicit vůči VŠEM otázkám ve vlákně i právě dogenerovaným
        all_prior_texts = prev_q_texts + [q.get("question", "") for q in new_questions_accumulated if q.get("question")]
        if all_prior_texts:
            sampled_prev = [f"- {t}" for t in all_prior_texts[-25:]]
            system_instruction += (
                "\n\n[STRIKTNÍ ZÁKAZ DUPLICIT]: V tomto vlákně již byly použity tyto otázky. "
                "JE PŘÍSNĚ ZAKÁZÁNO je opakovat nebo se ptát na stejné klinické souvislosti:\n"
                + "\n".join(sampled_prev)
            )

        if focus_mistakes and mistaken_questions:
            sample_mistakes = [f"- {m}" for m in mistaken_questions[:5]]
            system_instruction += (
                "\n\n[ZAMĚŘENÍ NA CHYBY UŽIVATELE Z PŘEDCHOZÍHO KOLA]: Uživatel v minulém kole chyboval u těchto konceptů:\n"
                + "\n".join(sample_mistakes)
                + "\nVytvoř nové otázky, které pomohou upevnit pochopení těchto témat, ale z jiného klinického úhlu pohledu (např. jiná manifestace, komplikace či diferenciální diagnostika)."
            )

        sources_summary = "\n".join(
            [f"[{s.get('id', idx + 1)}] {s.get('filename', 'materiál')}" for idx, s in enumerate(unique_sources)]
        )

        if thread_categories_map:
            cat_lines = []
            for cat, q_list in thread_categories_map.items():
                cat_lines.append(f"📁 KATEGORIE / OKRUH: {cat}")
                if q_list:
                    for q_title in q_list[:5]:
                        cat_lines.append(f"   - {q_title}")
            topics_desc = "\n".join(cat_lines)
        elif thread_categories:
            topics_desc = "\n".join([f"📁 KATEGORIE: {c}" for c in thread_categories])
        else:
            topics_desc = "\n".join([f"- {t}" for t in target_topics]) if target_topics else f"- {project}"

        batch_user_content = (
            f"TÉMATA VLÁKNA PRO DOGENEROVÁNÍ:\n{topics_desc}\n\n"
            f"POČET DALŠÍCH OTÁZEK PRO TUTO DÁVKU: {b_count}\n"
            f"POŽADOVANÁ OBTÍŽNOST: {new_difficulty} (posun: {difficulty_shift})\n"
            f"POVOLENÉ TYPY: {allowed_types_str}\n\n"
            f"DŮRAZNÁ KONTROLA PŘED VYGENEROVÁNÍM KAŽDÉ OTÁZKY:\n"
            f"1. DÉLKA MOŽNOSTÍ: Správná odpověď nesmí být delší ani upovídanější než distraktory (všechny možnosti A-D musí mít symetrickou délku a formu)!\n"
            f"2. NÁHODNÁ POZICE: Neumisťuj správnou odpověď automaticky na A! Náhodně střídej písmena správné odpovědi (např. C, B, D, A) a v poli 'explanation' uveď odpovídající písmeno.\n\n"
            f"SEZNAM ZDROJŮ:\n{sources_summary}\n\n"
            f"=== ÚRYVKY Z MATERIÁLŮ ===\n{context_text}\n=========================="
        )

        raw_response = await gemini_call_fn(
            model=gemini_model,
            contents=[batch_user_content],
            system_instruction=system_instruction,
            temperature=AI.practice_test.temperature,
            max_output_tokens=AI.practice_test.max_output_tokens,
            response_mime_type="application/json",
        )

        parsed_new_q = parse_and_validate_test_json(raw_response)
        if parsed_new_q:
            new_questions_accumulated.extend(parsed_new_q)

    if not new_questions_accumulated:
        raise ValueError("Model nevygeneroval žádné nové otázky pro toto vlákno.")

    # Přečíslování ID navazující na konec existujících otázek
    start_id = len(existing_questions)
    for idx, q in enumerate(new_questions_accumulated, 1):
        q["id"] = start_id + idx
        q["round"] = rounds

    # Připojení nových otázek do existujícího vlákna
    existing_questions.extend(new_questions_accumulated)
    prev_test["questions"] = existing_questions
    prev_test["rounds"] = rounds
    prev_test["difficulty"] = new_difficulty
    prev_test["updated_at"] = datetime.now().isoformat()

    # Aktualizace výsledků – test se stává nekompletním pro nově přidané otázky
    if "result" not in prev_test or not isinstance(prev_test["result"], dict):
        prev_test["result"] = {}

    prev_test["result"]["completed"] = False
    prev_test["result"]["max_score"] = len(existing_questions)
    if "user_answers" not in prev_test["result"]:
        prev_test["result"]["user_answers"] = {}

    # Uložení zpět do původního souboru vlákna
    filename = storage.update_test(prev_test)

    if log_fn:
        await log_fn(
            f"✅ Úspěšně dogenerováno {len(new_questions_accumulated)} nových otázek (Kolo {rounds}, celkem {len(existing_questions)} otázek) do vlákna '{filename}'."
        )

    return prev_test, filename
