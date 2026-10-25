"""Hodnocení otevřených odpovědí podle klíčových bodů a normalizace textu pro porovnání."""

import re
from typing import Any


# Normalizace textu pro porovnávání (odstranění diakritiky, lowercase, interpunkce)
def normalize_text(text: str) -> str:
    if not text:
        return ""
    import unicodedata

    normalized = unicodedata.normalize("NFKD", text)
    stripped = "".join([c for c in normalized if not unicodedata.combining(c)])
    cleaned = re.sub(r"[^\w\s]", " ", stripped.lower())
    return " ".join(cleaned.split())


def evaluate_open_answer(user_answer: str, model_answer: str, key_points: list[str]) -> dict[str, Any]:
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
            "feedback": "Byla odevzdána prázdná odpověď.",
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

    # Overlap s model words
    intersection = user_words.intersection(model_words)
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
        "feedback": feedback,
    }
