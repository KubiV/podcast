"""Extrakce a validace testových otázek z (často nevalidního) JSON výstupu modelu."""

import json
import re
from typing import Any


def extract_all_question_objects(text: str) -> list[dict[str, Any]]:
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
                                objects.append(
                                    {
                                        "question": q_m.group(1),
                                        "explanation": exp_m.group(1) if exp_m else "",
                                        "source_file": sf_m.group(1) if sf_m else "",
                                        "source_page": sp_m.group(1) if sp_m else "",
                                        "source_ref": sr_m.group(1) if sr_m else "",
                                        "type": "single_choice",
                                        "options": [],
                                    }
                                )
    return objects


def parse_and_validate_test_json(raw_text: str) -> list[dict[str, Any]]:
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
            clean_opts = [{"id": "A", "text": "Pravda"}, {"id": "B", "text": "Nepravda"}]

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
            "key_points": [str(kp).strip() for kp in q.get("key_points", []) if str(kp).strip()]
            if isinstance(q.get("key_points"), list)
            else [],
            "explanation": str(q.get("explanation", "")).strip(),
            "difficulty": str(q.get("difficulty", "normal")).strip().lower(),
            "source_file": str(q.get("source_file", "")).strip(),
            "source_page": str(q.get("source_page", "")).strip(),
            "source_quote": str(q.get("source_quote", "")).strip(),
            "source_ref": str(q.get("source_ref", "")).strip(),
        }
        validated.append(item)

    return validated
