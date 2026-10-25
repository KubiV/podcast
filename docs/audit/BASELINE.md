# Baseline – stav před refaktoringem

Datum: 2026-10-25 · commit `c172594` (main, čistý working tree)

## Stack

| Oblast | Zjištění |
|---|---|
| Backend | Python, FastAPI 0.139 / Starlette 1.3, uvicorn; venv `venv/` s Python 3.14.7 (`pyproject.toml` deklaruje `>=3.10`, Dockerfile viz AUDIT) |
| AI / data | `google-genai` (Gemini), `openai` (TTS), ElevenLabs přes `httpx`, ChromaDB (vektory), SQLite (`auth.db`, `chat_history.db`) |
| Frontend | Vanilla JS SPA bez build kroku: `static/index.html`, `static/js/app.js`, `static/js/translations.js` |
| Desktop | `desktop_app.py` (pywebview) + PyInstaller `medstudio.spec` |
| Package manager | pip + `requirements.txt` (bez lockfile), `pyproject.toml` jen pro metadata a ruff |
| CI | **žádné** (`.github/` neexistuje) |

## Dostupné kontroly

| Kontrola | Skript / zdroj | Poznámka |
|---|---|---|
| Lint | `ruff check .` (`pyproject.toml [tool.ruff]`) | ruff 0.8.4 v `venv`, globálně 0.16.10 (použit) |
| Format | `ruff format --check .` | |
| Type check | – | mypy/pyright nejsou nakonfigurovány ani nainstalovány |
| Testy | `python -m unittest discover -s tests -t .` | pytest není v requirements ani ve venv; testy jsou `unittest` |
| Build | `scripts/build_desktop.sh`, `Dockerfile` | nespouštěno (PyInstaller/Docker build by vytvářel artefakty) |
| JS syntax | `node --check` | žádný JS lint/test tooling |

Kontroly byly spuštěny v izolované kopii (`git archive HEAD`) s `AIMEDSTUDIO_DATA_DIR` nasměrovaným do dočasného adresáře, aby import `main.py` (vytváří adresáře, SQLite DB, spouští migraci `uploads/ → lessons_data/`) nesáhl na lokální data v repozitáři.

## Výsledky

| Kontrola | Výsledek |
|---|---|
| `ruff check .` (konfigurace projektu) | **2 chyby** – `UP038` v `routers/flashcards.py:191`, `services/flashcards_service.py:101` |
| `ruff check --select F401` (v projektu vypnuto) | **132** nepoužitých importů; z toho 50 v `main.py`, 8 `services/lesson_service.py`, 8 `routers/tests_api.py`, 7 `routers/projects.py`, 7 `services/medulingo_service.py` … |
| `ruff format --check .` | OK (50 souborů) |
| `python -m compileall` | OK |
| `node --check static/js/app.js`, `translations.js` | OK |
| `unittest` | **18/18 OK** (0.17 s), 9× `ResourceWarning: unclosed database` (SQLite spojení se nezavírají), 1× `DeprecationWarning` (per-request cookies v TestClient) |

## Odhad pokrytí testy

`coverage` není nainstalován, jde o kvalifikovaný odhad podle toho, co testy volají.

| Část | Testováno | Odhad |
|---|---|---|
| `core/security.py` (`safe_filename`, `safe_join`) | ano, vč. path traversal | ~80 % |
| `core/utils.py` | `sanitize_name`, `is_terminal_auth_error` | ~20 % |
| `main.py` auth middleware | veřejné cesty, 401/403 pro neautentizované a viewer | ~40 % větví |
| `services/auth_service.py` (692 ř.) | `create_initial_admin`, `register_user`, `approve_user`, `toggle_user_active` | ~15 % |
| `services/ai_service.py` | `clean_and_parse_json`, `get_fallback_model` | ~15 %, retry/resilience netestováno |
| `services/flashcards_service.py`, `notes_service.py` | 3 čisté funkce | <10 % |
| `services/chat_service.py` (1641 ř.), `lesson_service.py`, `test_service.py`, `medulingo_service.py`, `rag_service.py`, `podcast_service.py` | ne | 0 % |
| `routers/*` | jen existence cest v OpenAPI + 4 viewer 403 | ~0–5 % chování |
| Frontend (`app.js`, 15k ř.) | ne | 0 % |

**Závěr:** testy chrání jen bezpečnostní helpery a pár utilit. Jakýkoli refaktoring služeb a routerů vyžaduje nejprve charakterizační testy.

## Jak baseline zopakovat

```bash
git archive HEAD | tar -x -C /tmp/repo && cd /tmp/repo
ruff check . && ruff format --check .
AIMEDSTUDIO_DATA_DIR=/tmp/data <repo>/venv/bin/python -m unittest discover -s tests -t . -v
node --check static/js/app.js
```
