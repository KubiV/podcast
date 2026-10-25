import json
import os
import sys
from dataclasses import dataclass, field
from types import MappingProxyType
from typing import Any

from dotenv import load_dotenv

load_dotenv()

# Detekce prostředí: Zabalená binárka (PyInstaller) vs Běžný vývoj / Docker (Python)
IS_FROZEN = getattr(sys, "frozen", False)
env_data_dir = os.environ.get("AIMEDSTUDIO_DATA_DIR")

if env_data_dir:
    USER_DATA_DIR = os.path.abspath(env_data_dir)
    BUNDLE_DIR = sys._MEIPASS if IS_FROZEN else os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
elif IS_FROZEN:
    BUNDLE_DIR = sys._MEIPASS
    exe_dir = os.path.dirname(sys.executable)
    portable_data_dir = os.path.join(exe_dir, "data")
    if os.path.exists(portable_data_dir):
        USER_DATA_DIR = portable_data_dir
    else:
        USER_DATA_DIR = os.path.expanduser("~/Documents/AIMedStudio")
else:
    BUNDLE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    USER_DATA_DIR = BUNDLE_DIR

os.environ["AIMEDSTUDIO_DATA_DIR"] = USER_DATA_DIR

STATIC_DIR = os.path.join(BUNDLE_DIR, "static")
UPLOAD_DIR = os.path.join(USER_DATA_DIR, "uploads")
LESSONS_DIR = os.path.join(USER_DATA_DIR, "lessons_data")
AUDIO_DIR = os.path.join(USER_DATA_DIR, "generated_audio")
NOTES_DIR = os.path.join(USER_DATA_DIR, "generated_notes")
FLASHCARDS_DIR = os.path.join(USER_DATA_DIR, "generated_flashcards")
TESTS_DIR = os.path.join(USER_DATA_DIR, "generated_tests")
DB_DIR = os.path.join(USER_DATA_DIR, "chroma_db")
CONFIG_FILE = os.path.join(USER_DATA_DIR, "user_config.json")

for d in [UPLOAD_DIR, LESSONS_DIR, AUDIO_DIR, NOTES_DIR, FLASHCARDS_DIR, TESTS_DIR, DB_DIR, STATIC_DIR]:
    os.makedirs(d, exist_ok=True)


# Správa uživatelské konfigurace (BYOK: Bring Your Own Key)
def load_user_config() -> dict[str, Any]:
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            print(f"⚠️ Chyba při načítání konfigurace {CONFIG_FILE}: {e}")
    return {}


def save_user_config(cfg: dict[str, Any]) -> None:
    os.makedirs(USER_DATA_DIR, exist_ok=True)
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2, ensure_ascii=False)


PLANNER_FILENAME = "exam_planner.json"
APP_PASSWORD = os.getenv("APP_PASSWORD", "").strip()

# Modely Gemini, které smí zvolit běžný uživatel, když se platí sdíleným klíčem serveru
# (admin a uživatelé s vlastním klíčem mohou zadat libovolný model). Výchozí = modely nabízené v UI.
DEFAULT_GEMINI_MODEL = "gemini-3.6-flash"
ALLOWED_GEMINI_MODELS = tuple(
    m.strip()
    for m in os.getenv(
        "AIMEDSTUDIO_ALLOWED_MODELS",
        "gemini-3.6-flash,gemini-3.5-flash,gemini-3.8-flash,gemini-flash-latest,gemini-pro-latest",
    ).split(",")
    if m.strip()
)
MAX_CUSTOM_SYSTEM_PROMPT_CHARS = 20_000


@dataclass(frozen=True)
class GenerationParams:
    """Parametry jednoho druhu generování. None = parametr se nepředává (platí výchozí hodnota volané funkce)."""

    temperature: float
    max_output_tokens: int | None = None
    thinking_budget: int | None = None


@dataclass(frozen=True)
class AISettings:
    """
    Modely, parametry generování, plány opakování a záložní modely AI na jednom místě.
    Hodnoty odpovídají dřívějším literálům ve službách a routerech (krok 4.9) – změna zde mění chování aplikace.
    """

    default_gemini_model: str = DEFAULT_GEMINI_MODEL

    # Test klíče v Nastavení: minimální odpověď, při 404 zkusí záložní model
    connection_test_fallback_model: str = "gemini-flash-latest"
    connection_test_max_output_tokens: int = 10

    # Syntéza řeči
    openai_tts_model: str = "tts-1"
    elevenlabs_tts_model: str = "eleven_multilingual_v2"
    elevenlabs_default_voice_id: str = "21m00Tcm4TlvDq8ikWAM"

    # Výchozí parametry call_gemini_with_retries, pokud je volající nepředá
    gemini_call_defaults: GenerationParams = GenerationParams(temperature=0.7, max_output_tokens=8192)

    # Generování podle úlohy
    podcast_script: GenerationParams = GenerationParams(temperature=0.7)
    notes: GenerationParams = GenerationParams(temperature=0.25, max_output_tokens=16384)
    flashcards: GenerationParams = GenerationParams(temperature=0.3, max_output_tokens=8192)
    flashcards_followup: GenerationParams = GenerationParams(temperature=0.35, max_output_tokens=8192)
    practice_test: GenerationParams = GenerationParams(temperature=0.35, max_output_tokens=8192)
    practice_test_json_retry: GenerationParams = GenerationParams(temperature=0.2, max_output_tokens=8192)
    question_classification: GenerationParams = GenerationParams(temperature=0.1)
    grounded_chat: GenerationParams = GenerationParams(temperature=0.3, max_output_tokens=8192, thinking_budget=0)
    lesson_study_text: GenerationParams = GenerationParams(
        temperature=0.3, max_output_tokens=32768, thinking_budget=2048
    )
    lesson_lecture_script: GenerationParams = GenerationParams(
        temperature=0.7, max_output_tokens=16384, thinking_budget=1024
    )

    # Čekání (s) mezi pokusy při přetížení Gemini: call_gemini_with_retries / call_gemini_with_resilience (lekce)
    gemini_retry_wait_s: tuple[int, ...] = (8, 16, 30, 45, 60)
    gemini_resilience_wait_s: tuple[int, ...] = (6, 12, 25, 45, 60)

    # Záložní modely – dvě mapy s odlišným chováním (nález R3), sjednocení by změnilo chování.
    # Obecná: první pravidlo, jehož podřetězec je v názvu modelu; jinak výchozí záložní model.
    gemini_fallback_rules: tuple[tuple[str, str], ...] = (
        ("gemini-2.5-pro", "gemini-3.6-flash"),
        ("gemini-3.6-pro", "gemini-3.6-flash"),
        ("gemini-3.6-flash", "gemini-flash-latest"),
        ("gemini-flash-latest", "gemini-3.6-flash"),
    )
    gemini_fallback_default: str = "gemini-3.6-flash"
    # Lekce: přesná shoda názvu; neznámý model záložní model nemá.
    lesson_gemini_fallbacks: MappingProxyType = field(
        default_factory=lambda: MappingProxyType(
            {
                "gemini-3.8-flash": "gemini-3.6-flash",
                "gemini-pro-latest": "gemini-3.6-flash",
                "gemini-flash-latest": "gemini-3.6-flash",
                "gemini-3.6-flash": "gemini-flash-latest",
            }
        )
    )


AI = AISettings()
