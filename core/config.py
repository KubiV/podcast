import json
import os
import sys
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
