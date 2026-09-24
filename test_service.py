import os
import re
import json
import uuid
import time
from datetime import datetime
from typing import Any, List, Dict, Optional, Tuple

# Pomocná funkce pro sanitizaci jména
def sanitize_name(name: str) -> str:
    cleaned = re.sub(r"[^\w\-_.]", "_", name.strip())
    return re.sub(r"_+", "_", cleaned)


# Normalizace textu pro porovnávání (odstranění diakritiky, lowercase, interpunkce)
def normalize_text(text: str) -> str:
    if not text:
        return ""
    import unicodedata
    normalized = unicodedata.normalize('NFKD', text)
    stripped = "".join([c for c in normalized if not unicodedata.combining(c)])
    cleaned = re.sub(r"[^\w\s]", " ", stripped.lower())
    return " ".join(cleaned.split())


DEFAULT_TEST_PROMPT_SYSTEM = """Jsi špičkový profesor medicíny a expert na psychometrickou tvorbu zkouškových testových položek (SBA / Single Best Answer / MCQ) pro studenty závěrečného ročníku lékařských fakult (5. a 6. ročník, příprava na státní rigorózní zkoušku z vnitřního lékařství a medicíny).
Kvalita tvých otázek musí plně odpovídat mezinárodním standardům psychometrie testování (PubMed 40504491, UKMLA, USMLE Step 2 CK).

Tvým úkolem je na základě přiložených studijních materiálů a zadaných okruhů sestavit didaktický procvičovací test skládající se z přesně {COUNT} testových otázek.

STRIKTNÍ PSYCHOMETRICKÁ PRAVIDLA PRO TESTOVÉ POLOŽKY (PubMed 40504491):
1. CÍLOVÁ ÚROVEŇ A VÍCEKROKOVÉ UVAŽOVÁNÍ:
   - Cílit na aplikaci znalostí v klinické praxi a sekvenční diagnostické uvažování.
   - Otázka MUSÍ po studentovi vyžadovat více než jeden myšlenkový krok:
     Krok 1: Syntéza symptomů, anamnézy, nálezů a laboratoře -> stanovení pravděpodobného patofyziologického procesu / syndromu.
     Krok 2: Vyhodnocení klinického zvratu či komplikace -> volba definitivního diagnostického kroku, akutní intervence nebo terapie 1. volby.

2. STRIKTNÍ ZÁKAZ PŘEDČASNÉHO PROZRAZENÍ DIAGNÓZY:
   - NIKDY neprozrazuj diagnózu ani hledaný syndrom ve vinětě, kmeni otázky (stem) ani v úvodním klinickém zarámování!
   - Pokud je tématem konkrétní choroba (např. 'Hodgkinův lymfom' nebo 'Leidenská mutace'), AI ji MUSÍ převést výhradně do klinických projevů, věku, časové osy, fyzikálních a laboratorních nálezů. V kmeni otázky ji nesmí jmenovat.
   - Finální diagnóza se smí objevit VÝHRADNĚ v nabízených možnostech odpovědí (pokud je otázka na dg.) a v následném vysvětlení (explanation).
   - Rozpoznání diagnózy se nepočítá jako krok v uvažování, pokud by byla v textu předem prozrazena.

3. STRUKTURA OTÁZKY A KLINICKÝ ZVRAT (THE TWIST):
   - Realistická klinická viněta: Věk, pohlaví pacienta, časový průběh (např. potíže trvající několik týdnů), klíčová anamnéza, fyzikální nález a iniciální laboratorní/zobrazovací výsledky.
   - Klinický zvrat ("The Twist"): Zařazení neočekávaného zvratu, náhlého zhoršení stavu, atypického sekundárního laboratorního výsledku nebo kontraindikace standardního postupu, což nutí studenta k hlubšímu diferenčně diagnostickému úsudku.

4. KONTROLA KVALITY MOŽNOSTÍ (DISTRAKTORŮ):
   - Všech 4 až 5 nabízených možností (A, B, C, D případně E) MUSÍ mít stejnou délku, gramatickou strukturu, podobnou úroveň detailu a vysokou klinickou věrohodnost (plauzibilitu).
   - Žádný distraktor nesmí být očividně absurdní nebo do očí bijící nesmysl. Distraktory musí představovat reálné diferenciální diagnózy nebo běžné klinické omyly.
   - Správná odpověď nesmí být identifikovatelná pouze délkou textu či přítomností nápovědních slov.

5. TYPY OTÁZEK (generuj pouze povolené typy: {ALLOWED_TYPES}):
   - 'single_choice' (SBA / ABCD - jedna nejlepší správná): 4 nebo 5 možností (A, B, C, D, E). Přesně JEDNA je správná.
   - 'multi_choice' (ABCD - jedna nebo více správných): 4 nebo 5 možností. V zadání musí být 'Vyberte všechny správné možnosti'.
   - 'case_study' (Klinická kazuistika s vinětou): Pole 'scenario' obsahuje detailní vinětu se zvratem (Twist), kmen otázky směřuje na další postup/terapii/dif. dg.
   - 'open_ended' (Otevřená otázka): Žádné možnosti A-D (pole options bude []). Otázka testuje aktivní vybavení. Pole 'model_answer' obsahuje přesnou vzorovou odpověď a pole 'key_points' 3–6 klíčových pojmů.
   - 'true_false' (Pravda / Nepravda): Konkrétní klinické tvrzení. Options: A = Pravda, B = Nepravda.

6. OBTÍŽNOST ({DIFFICULTY}):
   - 'easy': Základní algoritmy, klasické manifestace, léky 1. volby.
   - 'normal': Standardní úroveň státnic na LF (sekvenční dif. dg., skórovací schémata, interpretace lab/EKG/RTG).
   - 'hard': Klinické chytáky, překryvné syndromy, vzácnější komplikace, změny postupů při renální insuficienci/komorbiditách.

7. DIDAKTICKÉ VYSVĚTLENÍ A CITACE (NOTEBOOKLM STANDARD):
   - U KAŽDÉ otázky uveď výstižné a úderné vysvětlení (2–4 věty): Proč je správná možnost správná a PROČ ostatní konkrétní distraktory v této klinické konstelaci neplatí.
   - Každá otázka MUSÍ být přesně ozdrojována z přiložených podkladů (source_file, source_page, source_quote, source_ref).

8. FORMÁT VÝSTUPU:
   Vrať VÝHRADNĚ platný JSON formát (čisté pole objektů bez markdown obalů):
   [
     {
       "id": 1,
       "type": "single_choice",
       "topic": "Obecný název okruhu (nikoliv specifická diagnóza, aby nebyla prozrazena)",
       "scenario": "Text klinické viněty s věkem, anamnézou, nálezy a zvratem (Twist), nebo prázdný řetězec",
       "question": "Jasný kmen otázky (např. 'Jaký je nejvhodnější další diagnostický krok?' nebo 'Které z následujících tvrzení je správné?')",
       "options": [
         {"id": "A", "text": "Možnost A"},
         {"id": "B", "text": "Možnost B"},
         {"id": "C", "text": "Možnost C"},
         {"id": "D", "text": "Možnost D"}
       ],
       "correct_answers": ["A"],
       "model_answer": "Stručná vzorová odpověď",
       "key_points": ["klíčový pojem 1", "klíčový pojem 2"],
       "explanation": "Didaktické zdůvodnění správné volby a vyloučení jednotlivých distraktorů.",
       "difficulty": "normal",
       "source_file": "nazev_souboru.pdf",
       "source_page": "45",
       "source_quote": "Doslovný fragment z materiálu",
       "source_ref": "[1, s. 45]"
     }
   ]
"""


def extract_all_question_objects(text: str) -> List[Dict[str, Any]]:
    """
    Záchranný parser pro neúplné (truncated), zabalené nebo poškozené JSON streamy.
    Prochází text a extrahuje všechny validně uzavřené objekty { ... }, které obsahují klíč 'question' nebo 'otázka'.
    """
    objects = []
    stack = []
    in_str = False
    escape = False

    for idx, ch in enumerate(text):
        if in_str:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_str = False
        else:
            if ch == '"':
                in_str = True
            elif ch == "{":
                stack.append(idx)
            elif ch == "}":
                if stack:
                    start_idx = stack.pop()
                    chunk = text[start_idx : idx + 1]
                    if '"question"' in chunk or '"otázka"' in chunk.lower() or '"options"' in chunk:
                        try:
                            clean_chunk = re.sub(r",\s*([\]\}])", r"\1", chunk)
                            obj = json.loads(clean_chunk, strict=False)
                            if isinstance(obj, dict) and ("question" in obj or "otázka" in obj or "text" in obj):
                                objects.append(obj)
                        except Exception:
                            # Regex záchrana polí, pokud objekt obsahuje vnořené uvozovky
                            q_m = re.search(r'"question"\s*:\s*"((?:[^"\\]|\\.)*)"', chunk)
                            if q_m:
                                exp_m = re.search(r'"explanation"\s*:\s*"((?:[^"\\]|\\.)*)"', chunk)
                                sf_m = re.search(r'"source_file"\s*:\s*"((?:[^"\\]|\\.)*)"', chunk)
                                sp_m = re.search(r'"source_page"\s*:\s*"((?:[^"\\]|\\.)*)"', chunk)
                                sr_m = re.search(r'"source_ref"\s*:\s*"((?:[^"\\]|\\.)*)"', chunk)
                                objects.append({
                                    "question": q_m.group(1),
                                    "explanation": exp_m.group(1) if exp_m else "",
                                    "source_file": sf_m.group(1) if sf_m else "",
                                    "source_page": sp_m.group(1) if sp_m else "",
                                    "source_ref": sr_m.group(1) if sr_m else "",
                                    "type": "single_choice",
                                    "options": []
                                })
    return objects


def parse_and_validate_test_json(raw_text: str) -> List[Dict[str, Any]]:
    """Vyčistí výstup modelu a zvaliduje formát testových otázek s maximální odolností."""
    if not raw_text or not raw_text.strip():
        return []

    cleaned = raw_text.strip()

    # 1. Extrakce obsahu z markdown code bloků ```json ... ``` (i pokud je před/za nimi text)
    fence_match = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", cleaned, re.IGNORECASE)
    if fence_match:
        cleaned = fence_match.group(1).strip()
    else:
        cleaned = re.sub(r"^```[a-zA-Z]*\s*", "", cleaned)
        cleaned = re.sub(r"\s*```$", "", cleaned)
        cleaned = cleaned.strip()

    data = None

    # 2. Standardní json.loads
    try:
        data = json.loads(cleaned, strict=False)
    except Exception:
        pass

    # 3. Odstranění trailing commas a kontrolních znaků
    if data is None:
        try:
            sanitized = re.sub(r",\s*([\]\}])", r"\1", cleaned)
            data = json.loads(sanitized, strict=False)
        except Exception:
            pass

    # 4. Regex extrakce pole [...]
    if data is None:
        m = re.search(r"\[\s*\{[\s\S]*\}\s*\]", cleaned)
        if m:
            try:
                sanitized = re.sub(r",\s*([\]\}])", r"\1", m.group(0))
                data = json.loads(sanitized, strict=False)
            except Exception:
                pass

    # 5. Regex extrakce objektu {...}
    if data is None:
        m = re.search(r"\{\s*[\s\S]*\}", cleaned)
        if m:
            try:
                sanitized = re.sub(r",\s*([\]\}])", r"\1", m.group(0))
                data = json.loads(sanitized, strict=False)
            except Exception:
                pass

    # 6. Rozbalení zabalených struktur v dict (např. {"questions": [...]}, {"test": [...]}, atd.)
    if isinstance(data, dict):
        found_list = None
        for key in ["questions", "test", "items", "quiz", "data", "results", "test_questions"]:
            if key in data and isinstance(data[key], list) and len(data[key]) > 0:
                found_list = data[key]
                break
        if found_list is None:
            for v in data.values():
                if isinstance(v, list) and len(v) > 0 and isinstance(v[0], dict):
                    found_list = v
                    break
        if found_list is not None:
            data = found_list
        else:
            data = [data]

    # 7. Záchranný parser pro useknutý (truncated) stream nebo částečně poškozený JSON
    if not isinstance(data, list) or len(data) == 0:
        data = extract_all_question_objects(cleaned)

    if not isinstance(data, list) or len(data) == 0:
        return []

    # Validace a normalizace otázek
    validated = []
    for idx, q in enumerate(data, 1):
        if not isinstance(q, dict):
            continue

        q_type = str(q.get("type", "single_choice")).strip().lower()
        if q_type not in ("single_choice", "multi_choice", "open_ended", "case_study", "true_false"):
            q_type = "single_choice"

        q_text = str(q.get("question") or q.get("text") or q.get("prompt") or "").strip()
        if not q_text:
            continue

        raw_opts = q.get("options") or q.get("choices") or []
        clean_opts = []

        if q_type in ("single_choice", "multi_choice", "case_study"):
            if isinstance(raw_opts, dict):
                for opt_id, opt_text in raw_opts.items():
                    clean_opts.append({"id": str(opt_id).strip().upper(), "text": str(opt_text).strip()})
            elif isinstance(raw_opts, list):
                for o in raw_opts:
                    if isinstance(o, dict):
                        oid = o.get("id") or o.get("label") or o.get("letter") or chr(ord("A") + len(clean_opts))
                        otext = o.get("text") or o.get("option") or o.get("value") or ""
                        if str(otext).strip():
                            clean_opts.append({"id": str(oid).strip().upper(), "text": str(otext).strip()})
                    elif isinstance(o, str) and o.strip():
                        m_opt = re.match(r"^([A-Ea-e])[\.\)]\s*(.*)$", o.strip())
                        if m_opt:
                            clean_opts.append({"id": m_opt.group(1).upper(), "text": m_opt.group(2).strip()})
                        else:
                            clean_opts.append({"id": chr(ord("A") + len(clean_opts)), "text": o.strip()})
            if len(clean_opts) < 2:
                continue
        elif q_type == "true_false":
            clean_opts = [
                {"id": "A", "text": "Pravda"},
                {"id": "B", "text": "Nepravda"}
            ]

        raw_correct = q.get("correct_answers") or q.get("correct_answer") or q.get("correct") or q.get("answer") or []
        if isinstance(raw_correct, str):
            raw_correct = [c.strip().upper() for c in re.split(r"[,;|\s]+", raw_correct) if c.strip()]
        elif isinstance(raw_correct, list):
            raw_correct = [str(c).strip().upper() for c in raw_correct if str(c).strip()]
        else:
            raw_correct = []

        if q_type in ("single_choice", "case_study", "true_false") and len(raw_correct) > 1:
            raw_correct = [raw_correct[0]]
        if q_type in ("single_choice", "case_study", "true_false") and not raw_correct and clean_opts:
            raw_correct = [clean_opts[0]["id"]]

        item = {
            "id": idx,
            "type": q_type,
            "topic": str(q.get("topic") or q.get("category") or "").strip() or "Všeobecné",
            "scenario": str(q.get("scenario", "")).strip(),
            "question": q_text,
            "options": clean_opts,
            "correct_answers": raw_correct,
            "model_answer": str(q.get("model_answer") or q.get("answer") or "").strip(),
            "key_points": [str(kp).strip() for kp in q.get("key_points", []) if str(kp).strip()] if isinstance(q.get("key_points"), list) else [],
            "explanation": str(q.get("explanation", "")).strip(),
            "difficulty": str(q.get("difficulty", "normal")).strip().lower(),
            "source_file": str(q.get("source_file", "")).strip(),
            "source_page": str(q.get("source_page", "")).strip(),
            "source_quote": str(q.get("source_quote", "")).strip(),
            "source_ref": str(q.get("source_ref", "")).strip(),
        }
        validated.append(item)

    return validated


def evaluate_open_answer(user_answer: str, model_answer: str, key_points: List[str]) -> Dict[str, Any]:
    """
    Vyhodnotí otevřenou odpověď uživatele ve stylu Anki active recall:
    Vypočítá procentuální shodu (% match) na základě klíčových bodů a textové podobnosti.
    """
    if not user_answer or not user_answer.strip():
        return {
            "match_percentage": 0,
            "matched_key_points": [],
            "missing_key_points": key_points,
            "grade": "again",
            "feedback": "Byla odevzdána prázdná odpověď."
        }

    norm_user = normalize_text(user_answer)
    user_words = set(norm_user.split())

    # 1. Kontrola přítomnosti klíčových bodů
    matched_kp = []
    missing_kp = []

    for kp in key_points:
        norm_kp = normalize_text(kp)
        kp_words = norm_kp.split()
        # Pokud se v odpovědi nachází celý řetězec nebo většina slov klíčového bodu
        if norm_kp in norm_user:
            matched_kp.append(kp)
        elif kp_words and all(w in norm_user for w in kp_words):
            matched_kp.append(kp)
        elif kp_words and sum(1 for w in kp_words if w in user_words) >= max(1, len(kp_words) * 0.6):
            matched_kp.append(kp)
        else:
            missing_kp.append(kp)

    kp_score = (len(matched_kp) / len(key_points)) if key_points else 0.0

    # 2. Textová tokenová podobnost s modelovou odpovědí (Jaccard + Bigram overlap)
    norm_model = normalize_text(model_answer)
    model_words = set(norm_model.split())

    # Jaccard
    intersection = user_words.intersection(model_words)
    union = user_words.union(model_words)
    jaccard = (len(intersection) / len(union)) if union else 0.0

    # Dice coefficient pro model words
    overlap_with_model = (len(intersection) / len(model_words)) if model_words else 0.0

    # Vážený celkový výpočet
    if key_points:
        final_score = (kp_score * 0.65) + (overlap_with_model * 0.35)
    else:
        final_score = overlap_with_model

    percentage = min(100, max(0, int(round(final_score * 100))))

    # Určení Anki známky
    if percentage >= 80:
        grade = "easy"
        feedback = "Výborná odpověď! Zahrnuje všechny klíčové body a medicínská kritéria."
    elif percentage >= 60:
        grade = "good"
        feedback = "Dobrá odpověď. Základní koncepty jsou správné, chybí některé detaily."
    elif percentage >= 40:
        grade = "hard"
        feedback = "Částečně správná odpověď. Zkontrolujte chybějící klíčové pojmy ve vzorové odpovědi."
    else:
        grade = "again"
        feedback = "Odpověď nepokrývá většinu požadovaných klinických kritérií. Doporučeno zopakovat."

    return {
        "match_percentage": percentage,
        "matched_key_points": matched_kp,
        "missing_key_points": missing_kp,
        "grade": grade,
        "feedback": feedback
    }


class TestStorageManager:
    """Správce ukládání a načítání testů v adresáři generated_tests."""

    def __init__(self, tests_dir: str):
        self.tests_dir = tests_dir
        os.makedirs(self.tests_dir, exist_ok=True)

    def _file_path(self, filename: str) -> str:
        return os.path.join(self.tests_dir, filename)

    def save_test(self, test_data: Dict[str, Any]) -> str:
        project = test_data.get("project", "default")
        safe_proj = sanitize_name(project)
        test_id = test_data.get("id") or f"test_{int(time.time())}_{uuid.uuid4().hex[:6]}"
        test_data["id"] = test_id

        # Pokud už má soubor přiřazené jméno, zachováme ho pro kontinuitu vlákna
        filename = test_data.get("filename") or f"{safe_proj}_{test_id}.json"
        test_data["filename"] = filename
        if "created_at" not in test_data:
            test_data["created_at"] = datetime.now().isoformat()
        test_data["updated_at"] = datetime.now().isoformat()

        path = self._file_path(filename)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(test_data, f, ensure_ascii=False, indent=2)
        return filename

    def update_test(self, test_data_or_filename: Any, test_data: Optional[Dict[str, Any]] = None) -> str:
        """Aktualizuje existující vlákno testu se zachováním jeho souboru a historie."""
        if test_data is not None:
            test_data["filename"] = str(test_data_or_filename)
            return self.save_test(test_data)
        elif isinstance(test_data_or_filename, dict):
            return self.save_test(test_data_or_filename)
        else:
            raise ValueError("Neplatné argumenty pro update_test.")

    def get_test(self, filename_or_id: str) -> Optional[Dict[str, Any]]:
        # Přímý název souboru
        if not filename_or_id.endswith(".json"):
            # Pokus o vyhledání podle id
            for f in os.listdir(self.tests_dir):
                if f.endswith(".json") and filename_or_id in f:
                    filename_or_id = f
                    break
            else:
                filename_or_id = f"{filename_or_id}.json"

        path = self._file_path(filename_or_id)
        if not os.path.exists(path):
            return None

        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return None

    def list_tests(self, project: str = "") -> List[Dict[str, Any]]:
        if not os.path.exists(self.tests_dir):
            return []

        safe_proj = sanitize_name(project) if project else ""
        results = []

        files = [f for f in os.listdir(self.tests_dir) if f.endswith(".json")]
        if safe_proj:
            files = [f for f in files if f.startswith(f"{safe_proj}_")]

        files.sort(key=lambda x: os.path.getmtime(self._file_path(x)), reverse=True)

        for f in files:
            path = self._file_path(f)
            try:
                with open(path, "r", encoding="utf-8") as fl:
                    data = json.load(fl)
                    results.append({
                        "filename": f,
                        "id": data.get("id", f.replace(".json", "")),
                        "title": data.get("title", f),
                        "project": data.get("project", safe_proj),
                        "created_at": data.get("created_at", ""),
                        "updated_at": data.get("updated_at", data.get("created_at", "")),
                        "difficulty": data.get("difficulty", "normal"),
                        "count": len(data.get("questions", [])),
                        "rounds": data.get("rounds", 1),
                        "mode": data.get("mode", "instant"),
                        "question_types": data.get("question_types", []),
                        "categories": data.get("categories", []),
                        "topics": data.get("topics", []),
                        "result": data.get("result", None),
                        "mtime": os.path.getmtime(path)
                    })
            except Exception:
                continue

        return results

    def save_test_result(self, filename: str, result_payload: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        test_data = self.get_test(filename)
        if not test_data:
            return None

        test_data["result"] = result_payload
        test_data["updated_at"] = datetime.now().isoformat()
        path = self._file_path(test_data["filename"])
        with open(path, "w", encoding="utf-8") as f:
            json.dump(test_data, f, ensure_ascii=False, indent=2)
        return test_data

    def delete_test(self, filename: str) -> bool:
        path = self._file_path(filename)
        if os.path.exists(path):
            os.remove(path)
            return True
        return False


async def generate_practice_test(
    project: str,
    questions: List[str],
    count: int = 10,
    question_types: Optional[List[str]] = None,
    difficulty: str = "normal",
    mode: str = "instant",
    custom_prompt: str = "",
    gemini_model: str = "gemini-3.6-flash",
    tests_dir: str = "",
    rag_query_fn = None,
    gemini_call_fn = None,
    log_fn = None,
    categories: Optional[List[str]] = None,
    categories_map: Optional[Dict[str, List[str]]] = None,
) -> Tuple[Dict[str, Any], str]:
    """
    Vygeneruje kompletní procvičovací test na základě zadaných otázek, kategorií a materiálů v RAG.
    """
def calculate_batch_sizes(total: int, max_per_batch: int = 6) -> List[int]:
    """Rozdělí celkový počet otázek do bezpečných dávek, aby nedošlo k useknutí tokenového limitu modelu."""
    if total <= max_per_batch:
        return [total]
    num_batches = (total + max_per_batch - 1) // max_per_batch
    base = total // num_batches
    rem = total % num_batches
    return [base + 1 if i < rem else base for i in range(num_batches)]


async def generate_practice_test(
    project: str,
    questions: List[str],
    count: int = 10,
    question_types: Optional[List[str]] = None,
    difficulty: str = "normal",
    mode: str = "instant",
    custom_prompt: str = "",
    gemini_model: str = "gemini-3.6-flash",
    tests_dir: str = "",
    rag_query_fn = None,
    gemini_call_fn = None,
    log_fn = None,
    categories: Optional[List[str]] = None,
    categories_map: Optional[Dict[str, List[str]]] = None,
) -> Tuple[Dict[str, Any], str]:
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
        "hard": "hard (těžší, klinické zvraty, atypické manifestace, překryvné syndromy)"
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
        await log_fn(f"📋 Testové otázky: Načítám RAG kontext pro {len(questions)} témat{cat_info} v projektu '{project}'...")

    context_text = ""
    unique_sources = []
    if rag_query_fn:
        try:
            context_text, unique_sources, _ = await rag_query_fn(combined_query, project, n_results=35)
        except Exception as e:
            if log_fn:
                await log_fn(f"⚠️ RAG dotaz skončil s varováním ({e}), pokračuji bez RAG kontextu...")

    sources_summary = "\n".join([f"[{s.get('id', idx + 1)}] {s.get('filename', 'materiál')}" for idx, s in enumerate(unique_sources)])

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
    accumulated_questions: List[Dict[str, Any]] = []

    for b_idx, b_count in enumerate(batches, 1):
        if log_fn:
            if total_batches > 1:
                await log_fn(f"🚀 Generuji testové otázky: dávka {b_idx}/{total_batches} ({b_count} otázek, cíl celkem: {target_count})...")
            else:
                await log_fn(f"🚀 Odesílám požadavek na generování {b_count} testových otázek přes {gemini_model} (obtížnost: {difficulty})...")

        system_instruction = DEFAULT_TEST_PROMPT_SYSTEM.replace("{COUNT}", str(b_count))\
                                                       .replace("{ALLOWED_TYPES}", allowed_types_str)\
                                                       .replace("{DIFFICULTY}", diff_desc)

        if custom_prompt and custom_prompt.strip():
            system_instruction += f"\n\n[DOPLŇUJÍCÍ UŽIVATELSKÉ INSTRUKCE]:\n{custom_prompt.strip()}"

        # Zákaz duplicit vůči předchozím dávkám
        if accumulated_questions:
            prev_q_texts = [f"- {q.get('question', '')}" for q in accumulated_questions if q.get("question")]
            system_instruction += (
                f"\n\n[STRIKTNÍ ZÁKAZ DUPLICIT V TÉTO DÁVCE]: V předchozích dávkách již byly vytvořeny tyto otázky. "
                f"JE PŘÍSNĚ ZAKÁZÁNO je opakovat nebo se ptát na stejné klinické souvislosti:\n"
                + "\n".join(prev_q_texts[-20:])
            )

        batch_user_content = (
            f"VYBRANÁ TÉMATA / KATEGORIE A ZKOUŠKOVÉ OTÁZKY PRO TEST:\n{topics_str}\n\n"
            f"{coverage_requirement}"
            f"POČET POŽADOVANÝCH OTÁZEK PRO TUTO DÁVKU: {b_count}\n"
            f"POVOLENÉ TYPY OTÁZEK: {allowed_types_str}\n"
            f"POŽADOVANÁ OBTÍŽNOST: {difficulty}\n\n"
            f"SEZNAM PŘIŘAZENÝCH ZDROJŮ PRO CITACE:\n{sources_summary if sources_summary else 'Využij odborné medicínské standardy.'}\n\n"
            f"=== ÚRYVKY ZE STUDIJNÍCH MATERIÁLŮ ===\n"
            f"{context_text if context_text else 'Učební podklady nejsou dostupné, generuj z medicínských znalostních standardů.'}\n"
            f"======================================"
        )

        raw_response = await gemini_call_fn(
            model=gemini_model,
            contents=[batch_user_content],
            system_instruction=system_instruction,
            temperature=0.35,
            max_output_tokens=8192,
            response_mime_type="application/json"
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
                    temperature=0.2,
                    max_output_tokens=8192,
                    response_mime_type="application/json"
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

    if categories:
        if len(categories) == 1:
            test_title = f"Vlákno: {categories[0]}"
        elif len(categories) <= 3:
            test_title = f"Vlákno: {', '.join(categories)}"
        else:
            test_title = f"Vlákno: {', '.join(categories[:2])} (+{len(categories)-2} kat.)"
    elif questions:
        test_title = f"Vlákno: {questions[0][:35]}"
        if len(questions) > 1:
            test_title += f" (+{len(questions)-1} dalších)"
    else:
        test_title = f"Vlákno: {project}"

    test_payload = {
        "id": f"test_{int(time.time())}_{uuid.uuid4().hex[:6]}",
        "project": project,
        "title": test_title,
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
            "time_spent_seconds": 0
        }
    }

    storage = TestStorageManager(tests_dir)
    filename = storage.save_test(test_payload)

    if log_fn:
        await log_fn(f"✅ Úspěšně vygenerován test s {len(accumulated_questions)} otázkami a uložen do vlákna '{filename}'.")

    return test_payload, filename


async def generate_more_test_questions(
    previous_test_id: str,
    project: str,
    count: int = 5,
    difficulty_shift: str = "same",  # "easier" | "same" | "harder"
    focus_mistakes: bool = True,
    gemini_model: str = "gemini-3.6-flash",
    tests_dir: str = "",
    rag_query_fn = None,
    gemini_call_fn = None,
    log_fn = None,
) -> Tuple[Dict[str, Any], str]:
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
        await log_fn(f"🔄 Vlákno '{prev_test.get('title')}': dogenerování {count} otázek (Kolo {rounds}, obtížnost shift '{difficulty_shift}' -> '{new_difficulty}', zaměření na chyby: {focus_mistakes})...")

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
        "hard": "hard (těžší, klinické zvraty, atypické manifestace, překryvné syndromy)"
    }
    diff_desc = valid_diffs.get(new_difficulty, valid_diffs["normal"])
    allowed_types_str = ", ".join(allowed_types)

    batches = calculate_batch_sizes(target_count, max_per_batch=6)
    new_questions_accumulated: List[Dict[str, Any]] = []

    for b_idx, b_count in enumerate(batches, 1):
        system_instruction = DEFAULT_TEST_PROMPT_SYSTEM.replace("{COUNT}", str(b_count))\
                                                       .replace("{ALLOWED_TYPES}", allowed_types_str)\
                                                       .replace("{DIFFICULTY}", diff_desc)

        # Přísný zákaz duplicit vůči VŠEM otázkám ve vlákně i právě dogenerovaným
        all_prior_texts = prev_q_texts + [q.get("question", "") for q in new_questions_accumulated if q.get("question")]
        if all_prior_texts:
            sampled_prev = [f"- {t}" for t in all_prior_texts[-25:]]
            system_instruction += (
                f"\n\n[STRIKTNÍ ZÁKAZ DUPLICIT]: V tomto vlákně již byly použity tyto otázky. "
                f"JE PŘÍSNĚ ZAKÁZÁNO je opakovat nebo se ptát na stejné klinické souvislosti:\n" + "\n".join(sampled_prev)
            )

        if focus_mistakes and mistaken_questions:
            sample_mistakes = [f"- {m}" for m in mistaken_questions[:5]]
            system_instruction += (
                f"\n\n[ZAMĚŘENÍ NA CHYBY UŽIVATELE Z PŘEDCHOZÍHO KOLA]: Uživatel v minulém kole chyboval u těchto konceptů:\n"
                + "\n".join(sample_mistakes) +
                f"\nVytvoř nové otázky, které pomohou upevnit pochopení těchto témat, ale z jiného klinického úhlu pohledu (např. jiná manifestace, komplikace či diferenciální diagnostika)."
            )

        sources_summary = "\n".join([f"[{s.get('id', idx + 1)}] {s.get('filename', 'materiál')}" for idx, s in enumerate(unique_sources)])

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
            f"SEZNAM ZDROJŮ:\n{sources_summary}\n\n"
            f"=== ÚRYVKY Z MATERIÁLŮ ===\n{context_text}\n=========================="
        )

        raw_response = await gemini_call_fn(
            model=gemini_model,
            contents=[batch_user_content],
            system_instruction=system_instruction,
            temperature=0.35,
            max_output_tokens=8192,
            response_mime_type="application/json"
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
        await log_fn(f"✅ Úspěšně dogenerováno {len(new_questions_accumulated)} nových otázek (Kolo {rounds}, celkem {len(existing_questions)} otázek) do vlákna '{filename}'.")

    return prev_test, filename

