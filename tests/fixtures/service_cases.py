"""
Vstupy pro charakterizační (golden master) testy čistých funkcí služeb (krok 2.3).

`compute_all()` spočítá výstupy všech funkcí pro všechny vstupy. Golden soubor
`services_golden.json` vytvoří `python -m tests.fixtures.generate_services_golden` – generuje se
jen záměrně (na kódu, jehož chování chceme zafixovat), nikdy automaticky v testu.
"""

from collections.abc import Callable
from typing import Any

NAMES = [
    "Kardiologie",
    "Kardiologie_č",
    "Moje Zkouška 2026!",
    "  mezery okolo  ",
    "__podtržítka__",
    "a//b\\c",
    "../../etc/passwd",
    "file;rm -rf.mp3",
    "x.y.z",
    "...",
    "",
    "Ü-ber_Test-2",
    "ščř ŽÝÁ",
    "emoji 🫀 srdce",
    "a'b\"c<d>",
    "Interna II. – kardio",
]

MODELS = [
    "gemini-2.5-pro",
    "gemini-3.6-pro",
    "gemini-3.6-flash",
    "gemini-flash-latest",
    "gemini-3.8-flash",
    "gemini-pro-latest",
    "gemini-3.5-flash",
    "neznamy-model",
    "",
]

RAW_MODEL_OUTPUTS = [
    '[{"q": "A", "n": 1}, {"q": "B", "n": 2}]',
    '```json\n[{"front": "Co?", "back": "To."}]\n```',
    'Zde jsou otázky:\n```json\n[{"id": "q1", "question": "X?"}]\n```\nDoufám, že pomohou.',
    '{"single": true}',
    '[{"a": 1}, {"b": 2},]',
    '[{"question": "Celá", "options": [{"id": "A"}]}, {"question": "Useknut',
    'Text {"q": "první"} mezi {"q": "druhá", "x": {"y": 1}} text',
    '[{"text": "řádek 1\nřádek 2\tTab"}]',
    "```\n[1, 2, 3]\n```",
    "Tohle není JSON.",
    "",
    '[{"questions": [{"id": "q1"}]}]',
    '{"questions": [{"id": "q1", "question": "Vnořené?"}]}',
    # Realistické výstupy testových otázek (větve parse_and_validate_test_json)
    '[{"type": "single_choice", "topic": "Kardio", "question": "Lék první volby?", '
    '"options": [{"id": "a", "text": "Digoxin"}, {"label": "B", "option": "Furosemid"}], '
    '"correct_answer": "b", "explanation": "Protože.", "source_ref": "[1, s. 4]"}]',
    '```json\n{"test": [{"type": "multi_choice", "text": "Které platí?", '
    '"choices": {"A": "První", "B": "Druhá", "C": "Třetí"}, "correct": "a, c", "difficulty": "HARD"}]}\n```',
    '[{"question": "Řetězcové možnosti?", "options": ["A) Ano", "B. Ne", "Možná"], "answer": ["B"]}]',
    '[{"type": "true_false", "question": "Srdce má 4 oddíly.", "correct_answers": ["A"]}]',
    '[{"type": "open_ended", "prompt": "Popište léčbu.", "model_answer": "ACEi, BB.", "key_points": ["ACEi", " ", "BB"]}]',
    # Neznámý typ „open“ se převede na single_choice a bez možností se zahodí
    '[{"type": "open", "prompt": "Popište léčbu.", "model_answer": "ACEi, BB."}]',
    '[{"question": "Bez textu?", "options": []}, {"question": "", "options": ["A) x"]}, '
    '{"question": "Druhá celá", "options": ["A) x", "B) y"], "correct": "A"}, {"question": "Useknutá", "opt',
]

FTS_QUERIES = [
    "Jaká je léčba srdečního selhání?",
    "digoxin",
    "ACE inhibitory a beta-blokátory",
    "",
    "a i v",
    "NYHA III–IV",
    '"citace" OR AND NOT * (závorky)',
    "ledvinách ledviny ledvinové",
    "Diabetes mellitus 2. typu",
    "Lístek 1: a) Astma bronchiale, b) Lymfomy",
]

STEM_TOKENS = [
    "srdečního",
    "selhání",
    "ledvinách",
    "ledviny",
    "ledvinové",
    "léčba",
    "léčbou",
    "inhibitory",
    "kardiomyopatie",
    "plicní",
    "plic",
    "hypertenze",
    "hypertenzí",
    "nemocnice",
    "a",
    "v",
    "DNA",
]


def _long_text() -> str:
    paragraphs = []
    for i in range(12):
        sentences = " ".join(f"Věta {i}.{j} o tématu číslo {i} a jeho souvislostech." for j in range(6))
        paragraphs.append(f"Odstavec {i}. {sentences}")
    return "\n\n".join(paragraphs)


SECTIONS = [
    {"text": f"Strana {p}: " + " ".join(f"obsah{p}_{w}" for w in range(60)), "source": "skripta.pdf", "page": str(p)}
    for p in range(1, 6)
] + [{"text": "Jiný dokument. " * 30, "source": "jiny.docx", "page": "1"}]

THOUGHT_SAMPLES = [
    "<thought>interní úvaha</thought>Odpověď.",
    "Odpověď <think>neuzavřené",
    "Strict grounding check: ok\n\nSkutečná odpověď.",
    "Normální text bez úvah.",
    "",
]

SCRIPTS = [
    "[KAPITOLA: Úvod]\nText úvodu je tady.\n\n[KAPITOLA: Diagnostika]\nDelší text diagnostiky "
    + "slovo " * 50
    + "\n\n[KAPITOLA: Léčba]\nKrátká léčba.",
    "Skript bez kapitol, jen text " + "slova " * 20,
    "## Nadpis\n**Tučně** a *kurzíva*\n\n\n\n<!-- poznámka -->Konec",
]

TABLES = [
    "| A | B |\n|---|---|\n| 1 | 2 || 3 | 4 |",
    "Text\n| A | B |\n|---|---|\n| 1 | 2 |\nPokračování",
    "| A | B |\n\n\n| 1 | 2 |",
    "Bez tabulky.",
]

CATEGORIES = ["Pneumologie", "Kardiologie – srdce", "Hematologie", "Neznámá kategorie", ""]


def _safe_call(fn: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
    try:
        return fn(*args, **kwargs)
    except Exception as exc:  # zachycujeme i chování „vyhodí výjimku“
        return {"__error__": type(exc).__name__}


def compute_all() -> dict[str, Any]:
    from core.security import safe_filename
    from core.utils import chunk_text, sanitize_name
    from services import ai_service, lesson_service
    from services.chat_service import (
        build_czech_fts_query,
        clean_czech_stem,
        clean_leaked_thoughts,
        sanitize_project_name,
    )
    from services.lesson_service import clean_script_for_tts, extract_chapters_from_script
    from services.medulingo_service import get_category_icon, normalize_name
    from services.medulingo_service import sanitize_name as medulingo_sanitize_name
    from services.notes_service import sanitize_markdown_tables
    from services.rag_service import chunk_sections_with_metadata, decompose_question_to_subqueries
    from services.test_service import (
        calculate_batch_sizes,
        extract_all_question_objects,
        normalize_text,
        parse_and_validate_test_json,
    )
    from services.test_service import sanitize_name as test_sanitize_name

    long_text = _long_text()
    return {
        "sanitizers": {
            name: {
                "core.utils.sanitize_name": _safe_call(sanitize_name, name),
                "core.security.safe_filename": _safe_call(safe_filename, name),
                "test_service.sanitize_name": _safe_call(test_sanitize_name, name),
                "medulingo_service.sanitize_name": _safe_call(medulingo_sanitize_name, name),
                "chat_service.sanitize_project_name": _safe_call(sanitize_project_name, name),
                "test_service.normalize_text": _safe_call(normalize_text, name),
                "medulingo_service.normalize_name": _safe_call(normalize_name, name),
            }
            for name in NAMES
        },
        "fallback_models": {
            model: {
                "ai_service": _safe_call(ai_service.get_fallback_model, model),
                "lesson_service": _safe_call(lesson_service.get_fallback_model, model),
            }
            for model in MODELS
        },
        "json_parsers": {
            raw: {
                "clean_and_parse_json": _safe_call(ai_service.clean_and_parse_json, raw),
                "parse_and_validate_test_json": _safe_call(parse_and_validate_test_json, raw),
                "extract_all_question_objects": _safe_call(extract_all_question_objects, raw),
            }
            for raw in RAW_MODEL_OUTPUTS
        },
        "fts_query": {q: _safe_call(build_czech_fts_query, q) for q in FTS_QUERIES},
        "czech_stem": {t: _safe_call(clean_czech_stem, t) for t in STEM_TOKENS},
        "subqueries": {q: _safe_call(decompose_question_to_subqueries, q) for q in FTS_QUERIES},
        "chunk_text": {
            "default": _safe_call(chunk_text, long_text),
            "small": _safe_call(chunk_text, long_text, chunk_size=400, overlap=80),
            "empty": _safe_call(chunk_text, ""),
        },
        "chunk_sections": {
            "default": _safe_call(chunk_sections_with_metadata, SECTIONS),
            "small": _safe_call(chunk_sections_with_metadata, SECTIONS, chunk_size=500, overlap=100),
        },
        "clean_leaked_thoughts": {t: _safe_call(clean_leaked_thoughts, t) for t in THOUGHT_SAMPLES},
        "chapters": {
            str(i): _safe_call(extract_chapters_from_script, s, total_duration_seconds=300.0)
            for i, s in enumerate(SCRIPTS)
        },
        "tts_clean": {str(i): _safe_call(clean_script_for_tts, s) for i, s in enumerate(SCRIPTS)},
        "markdown_tables": {t: _safe_call(sanitize_markdown_tables, t) for t in TABLES},
        "batch_sizes": {str(n): _safe_call(calculate_batch_sizes, n) for n in (0, 1, 5, 6, 7, 12, 13, 20)},
        "category_icons": {c: _safe_call(get_category_icon, c) for c in CATEGORIES},
    }
