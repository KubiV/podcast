"""
Modul pro sdílené kontextové proměnné (ContextVar) napříč asynchronními úlohami v rámci HTTP požadavku.
Umožňuje transparentně předávat identitu aktuálně přihlášeného uživatele a zvolený jazyk
do hlubších vrstev aplikace (klienti API, systémové prompty, RAG generování) bez nutnosti
přepisovat signatury desítek existujících funkcí.
"""

from contextvars import ContextVar
from typing import Any, Optional

# Aktuálně přihlášený uživatel (dict s poli id, username, role, status apod.)
current_user_var: ContextVar[dict[str, Any] | None] = ContextVar("current_user_var", default=None)

# Aktuálně zvolený jazyk rozhraní a generování AI ("cs", "en", "fr")
current_language_var: ContextVar[str] = ContextVar("current_language_var", default="cs")


def get_current_user() -> dict[str, Any] | None:
    return current_user_var.get()


def set_current_user(user: dict[str, Any] | None) -> None:
    current_user_var.set(user)


def get_current_language() -> str:
    lang = current_language_var.get()
    return lang if lang in ("cs", "en", "fr") else "cs"


def set_current_language(lang: str) -> None:
    norm = (lang or "cs").lower().strip()
    if norm in ("cs", "en", "fr"):
        current_language_var.set(norm)
    else:
        current_language_var.set("cs")


def get_language_directive(lang: str) -> str:
    """
    Vrací striktní instrukci pro systémový prompt modelu Gemini / OpenAI,
    která vynutí generování výstupu v požadovaném jazyce s profesionální lékařskou terminologií.
    """
    lang = (lang or "cs").lower().strip()
    if lang == "en":
        return (
            "\n\n===============================================================================\n"
            "CRITICAL MANDATORY LANGUAGE REQUIREMENT:\n"
            "TARGET OUTPUT LANGUAGE: ENGLISH (EN).\n"
            "Generate all output, explanations, questions, study summaries, podcast scripts, and answers "
            "strictly and idiomatically in ENGLISH with international standard medical terminology "
            "(WHO, ICD-11, evidence-based guidelines standards). Do not output in any other language."
            "\n==============================================================================="
        )
    elif lang == "fr":
        return (
            "\n\n===============================================================================\n"
            "EXIGENCE LINGUISTIQUE CRITIQUE ET OBLIGATOIRE :\n"
            "LANGUE DE SORTIE : FRANÇAIS (FR).\n"
            "Rédigez l'intégralité du contenu, des explications, des questions, des synthèses d'étude, "
            "du script de podcast et des réponses strictement en FRANÇAIS soigné, en utilisant la terminologie "
            "médicale standard francophone (Collèges médicaux, HAS, OMS). Ne produisez aucun texte dans une autre langue."
            "\n==============================================================================="
        )
    else:
        return (
            "\n\n===============================================================================\n"
            "ZÁVAZNÝ POŽADAVEK NA JAZYK VÝSTUPU:\n"
            "CÍLOVÝ JAZYK VÝSTUPU: ČEŠTINA (CS).\n"
            "Veškerý generovaný obsah, vysvětlení, testové otázky, studijní texty, kartičky a skripty generuj "
            "v bezchybné spisovné češtině se správnou standardní českou lékařskou terminologií."
            "\n==============================================================================="
        )
