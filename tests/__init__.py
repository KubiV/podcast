"""Automated test suite for AI MedStudio."""

import os
import tempfile

# Testy musí běžet nad izolovaným datovým adresářem: import `main` vytváří SQLite databáze,
# složky a spouští migrace. Proměnnou nastavujeme dřív, než kterýkoli testovací modul importuje `core.config`.
os.environ["AIMEDSTUDIO_DATA_DIR"] = tempfile.mkdtemp(prefix="aimedstudio_tests_")

# Testy nesmí volat placená AI API. Prázdné hodnoty zabrání `load_dotenv()` načíst skutečné klíče z `.env`
# (python-dotenv nepřepisuje proměnné, které už v prostředí existují).
for _key in ("GEMINI_API_KEY", "OPENAI_API_KEY", "ELEVENLABS_API_KEY", "APP_PASSWORD"):
    os.environ[_key] = ""
