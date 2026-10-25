# Audit AI MedStudio – Fáze 1

Datum: 2026-10-25 · commit `c172594` · baseline viz [BASELINE.md](BASELINE.md)
Stav: **čeká na schválení plánu** (Fáze 2 nezahájena)

Legenda: závažnost **K** kritická / **V** vysoká / **S** střední / **N** nízká · jistota **O** ověřeno / **P** podezření

---

## 1. Shrnutí

Projekt je FastAPI backend (~10k řádků Pythonu v `core/`, `services/`, `routers/`, `prompts/`) a vanilla-JS SPA bez build kroku (`static/js/app.js` 15 074 ř., `static/index.html` 5 528 ř.). Poslední refaktoring (`e10bcc0`) rozdělil kód do vrstev, ale nedokončil to: zůstaly paralelní kopie infrastruktury (druhý Gemini/Chroma klient a vlastní detekce datového adresáře v `services/chat_service.py`, druhá implementace retry v `lesson_service.py`, 5 variant `sanitize_name`), kořenové „shim“ moduly, na kterých kód stále závisí, a 132 nepoužitých importů (50 jen v `main.py`). Tajemství v repozitáři ani v git historii nejsou.

**Tři nejzávažnější problémy:**

1. **Chybějící autorizace na úrovni projektů a dat (IDOR).** Vlastnictví projektu se kontroluje jen při smazání a přejmenování (`routers/projects.py:122`, `:205`). Všechny ostatní endpointy (soubory, poznámky, kartičky, testy, chat vlákna, export, `clear-data`, import s `overwrite`) i statické mounty `/uploads`, `/audio`, `/notes-files`, `/lessons-data` jsou dostupné komukoli přihlášenému, včetně hosta. Režim „privátní projekty“ tak chrání jen výpis seznamu.
2. **Několik cest k XSS na stejném originu.** (a) Markdown z AI výstupu jde přes `marked.parse` do `innerHTML` bez sanitizace (`static/js/app.js:5378-5386`, DOMPurify v projektu chybí), takže prompt injection v nahraném PDF vede ke spuštění skriptu u každého čtenáře. (b) Username se vkládá do `onclick` (`app.js:12192`) a backend v něm nijak neomezuje znaky, takže **neautentizovaná registrace vede k XSS v admin panelu**. (c) `/api/print/prepare` → `/print_preview/{id}` (`routers/print.py:20-66`) servíruje libovolné HTML a je povolen i hostovi (`main.py:229-232`).
3. **Globální SSE log `/api/logs` sdílený všemi uživateli** (`main.py:247-263`, `core/logger.py:30-34`). Každý přihlášený (i host) vidí v reálném čase názvy projektů a souborů, úryvky textů a dotazů ostatních uživatelů (`services/podcast_service.py:76`, `services/rag_service.py:257`).

Dále: AI vrstva nemá centrální konfiguraci modelů (`"gemini-3.6-flash"` natvrdo na 15+ místech, klient smí poslat libovolný `gemini_model` i vlastní systémový prompt, přičemž se platí sdíleným klíčem admina). Volání modelu nemá timeout. Výstupy JSON se neověřují proti schématu. Testy pokrývají jen bezpečnostní helpery, takže pro služby a routery jsou před refaktoringem nutné charakterizační testy.

---

## 2. Nálezy podle kategorií

### 2.1 Architektura a modularita

| # | Umístění | Popis | Záv. | Jist. |
|---|---|---|---|---|
| A1 | `services/chat_service.py` (1 641 ř.) | God modul se 7 zodpovědnostmi: vlastní detekce datového adresáře (`:24-43`), vlastní Chroma i Gemini klient (`:49-83`), SQLite schéma a migrace (`:86-268`), CRUD vláken a zpráv (`:281-627`), export/import projektu (`:629-816`), úložiště lekcí (`:818-945`), český stemmer + FTS5 (`:947-1221`), hybridní retrieval (`:1223-1387`), streamovaný grounded chat (`:1417-1641`) | V | O |
| A2 | `static/js/app.js` (15 074 ř.) | Celý frontend v jednom souboru, viz sekce 2.6 | V | O |
| A3 | `routers/projects.py` (1 021 ř.) | Router obsahuje business logiku exportu a importu ZIP (`:376-952`), přímé SQL přes `get_db_connection` (`:443`), správu Chroma kolekcí a souborového systému | V | O |
| A4 | `services/test_service.py` (884 ř.) | Parsování a oprava JSON (`:33-238`), hodnocení otevřených odpovědí (`:240`), souborové úložiště `TestStorageManager` (`:315-434`), generování (`:446-884`) | S | O |
| A5 | `services/medulingo_service.py` (672 ř.), `services/lesson_service.py` (641 ř.), `routers/batch.py` (624 ř.) | Míchají I/O, doménovou logiku a orchestraci AI. `batch.py` obsahuje 3 téměř shodné background funkce (`:37`, `:243`, `:434`) se shodnou kostrou (stav dávky, cancel, události) | S | O |
| A6 | `core/clients.py:10` | Vrstva `core` importuje `services.auth_service`, což je obrácená závislost. `routers/projects.py:35-53` to obchází proxy třídami `_AuthServiceProxy` a `_ChromaClientProxy` | S | O |
| A7 | `services/rag_service.py:204,258`, `services/lesson_service.py:215`, `routers/files.py:89,227`, `routers/projects.py:145,235,307,443,590,783,854,862`, `routers/chat_api.py:491` | 14 lokálních importů `from chat_service import …`, které jdou přes kořenové shimy (`chat_service.py` atd.) a ne přímo na `services.chat_service`. Shimy proto nejdou smazat bez úpravy těchto míst. Lokální importy zřejmě obcházejí cyklus `rag_service ↔ chat_service` | S | O |
| A8 | `services/chat_service.py:24-35` | Fallback datového adresáře je `os.path.dirname(__file__)` = `services/`, zatímco `core/config.py:27` má kořen repa. Funguje jen díky tomu, že `core.config` nastaví `AIMEDSTUDIO_DATA_DIR` do `os.environ` dřív, než se importuje `chat_service`. Závisí to na pořadí importů | S | O (kód) / P (reálný dopad) |
| A9 | `main.py:1-127` | 50 nepoužitých importů. `main.py` slouží jako „re-export“, ale nikdo z něj kromě `app` neimportuje (`tests/*`, `desktop_app.py:67`) | N | O |
| A10 | `routers/auth.py:11-16` vs. `routers/projects.py:35`, `routers/settings.py` | Tři různé způsoby, jak router získá `AuthService`: `init()` s globálem, proxy třída, `AuthService.get_instance()`. Chybí FastAPI `Depends` | N | O |
| A11 | 27× `payload: dict = Body(...)` v `routers/*` | Kromě `routers/auth.py` žádný router nepoužívá Pydantic modely. Chybí validace, typy a OpenAPI kontrakt | S | O |
| A12 | Importní cesty | Absolutní importy z kořene (`core.`, `services.`) bez hlubokých relativních cest, to je v pořádku. Cyklus `chat_service ↔ rag_service` je jen skrytý lokálními importy | N | P |

### 2.2 Technický dluh a redundance

| # | Výskyty | Popis | Návrh (co ponechat) | Záv. | Jist. |
|---|---|---|---|---|---|
| R1 | `core/utils.py:4`, `core/security.py:30` (`safe_filename`), `services/test_service.py:13`, `services/medulingo_service.py:23`, `services/chat_service.py:270` (`sanitize_project_name`) | 5 variant sanitizace názvu s **různým chováním**: varianty v test/medulingo neořezávají `_` na krajích. `sanitize_project_name` povoluje jen ASCII `[a-zA-Z0-9_-]`, takže projekt `Kardiologie_č` má jiné ID v uploads (`Kardiologie_č`) než v chat DB a Chroma (`Kardiologie__`) | `core/utils.sanitize_name`. **Pozor:** sjednocení změní ID u projektů s diakritikou, je to změna chování a vyžaduje migraci | V | O (kód) / P (dopad na existující data) |
| R2 | `services/ai_service.py:177-236`, `services/lesson_service.py:308-376` | Dvě kopie `call_gemini_with_resilience`. Verze v `ai_service` je mrtvá (importuje ji jen `main.py`) | Jedna implementace v `ai_service`, `lesson_service` ji importuje | S | O |
| R3 | `services/ai_service.py:22-35`, `services/lesson_service.py:297-305` | Dvě `get_fallback_model` s **různými** mapami (např. `gemini-3.6-flash → gemini-flash-latest` v obou, ale neznámý model vrací `"gemini-3.6-flash"` vs. `None`) | Jedna mapa v konfiguraci | S | O |
| R4 | `core/clients.py:16-73` vs. `services/chat_service.py:56-83` | Druhý getter Gemini klíče a klienta. Verze v `chat_service` **ignoruje per-user BYOK režim** a vždy použije globální klíč (chat i lekce, `chat_service.py:1426`, `lesson_service.py:401`) | `core.clients.get_gemini_client` | V | O |
| R5 | `core/clients.py:111` vs. `services/chat_service.py:49` | Dva `chromadb.PersistentClient` nad stejným adresářem v jednom procesu | `core.clients.get_chroma_client` | S | O (kód) / P (riziko nekonzistence) |
| R6 | `core/clients.py:16,38,57` | 3× copy-paste getteru klíče (gemini/openai/elevenlabs) | Jedna funkce `get_api_key(provider)` | N | O |
| R7 | `services/ai_service.py:38` (`clean_and_parse_json`), `services/test_service.py:33-238`, `routers/chat_api.py:360-367` (regex + `json.loads`) | Tři různé parsery JSON výstupu modelu | Jeden parser + Pydantic validace (viz AI3) | S | O |
| R8 | `services/test_service.py:19` (`normalize_text`), `services/medulingo_service.py:13` (`normalize_name`) | Skoro shodná normalizace bez diakritiky | `core/utils` | N | O |
| R9 | Kořen: `auth_service.py`, `chat_service.py`, `lesson_service.py`, `medulingo_service.py`, `test_service.py` | Shimy pro zpětnou kompatibilitu. Používané jsou `chat_service` (A7) a `lesson_service` (`medstudio.spec:41-42` hiddenimports), ostatní 3 nemají žádného importéra | Po přesměrování importů smazat | N | O |
| R10 | `core/context.py:18-36` | `get_current_user`, `set_current_user`, `set_current_language` mají 0 referencí | Smazat | N | O (grep) |
| R11 | 132× F401 (`ruff --select F401`) | Nepoužité importy, pravidlo je v `pyproject.toml:20` vypnuté | `ruff --fix` + zapnout F401 | N | O |
| R12 | Tracked: `__pycache__/main_v1.cpython-314.pyc`, `.DS_Store` | Soubory v gitu navzdory `.gitignore` | `git rm --cached` | N | O |
| R13 | `requirements.txt` | Chybí `pypdf` (používá ho `services/rag_service.py:41`, ve venv je nainstalovaný ručně, v Docker image nebude a PDF extrakce tam spadne do jiné větve). Chybí `Pillow` (`lesson_service.py:70`, jen tranzitivně). Serverový image zbytečně instaluje `pywebview` a `pyinstaller` | Rozdělit na `requirements.txt` / `requirements-desktop.txt` / `requirements-dev.txt` (**vyžaduje souhlas, mění závislosti**) | S | O (chybí v souboru) / P (dopad v Dockeru) |
| R14 | `pyproject.toml:5` (`>=3.10`), `Dockerfile:2` (3.11), venv 3.14, `docs/ARCHITECTURE.md:6` (3.12+), `README.md:123` (3.11+) | Nekonzistentní cílová verze Pythonu | Sjednotit na 3.11 | N | O |
| R15 | `routers/projects.py:71`, `create_project:106` | Projekty bez vlastníka se při každém výpisu tiše přiřadí uživateli `id=1` | Jednorázová migrace místo side-effectu v GET | N | O |
| R16 | `services/auth_service.py:33-37` + `with self._get_connection() as conn` | Kontextový manažer `sqlite3` spojení nezavírá (jen commit), proto 9× `ResourceWarning` v testech. Stejně v `chat_service.get_db_connection` | `contextlib.closing` / helper | N | O |
| R17 | `scratch/` (lokálně, ignorováno, 80+ jednorázových skriptů `fix_*.py`, `patch_*.py`, `test_*.py`) | Necommitnuté, ale matoucí. Některé `test_*` by mohly být užitečné jako testy | Rozhodnutí vlastníka | N | O |

**Mrtvý kód – metodika:** grep-based (definice vs. reference ve všech `.py`, `medstudio.spec`, `tests`). `vulture` ani `deptry` nejsou nainstalované. **Navrhuji** spustit `pipx run vulture . --exclude venv,scratch --min-confidence 80` a `pipx run deptry .`, ale až s tvým souhlasem. FastAPI routy (dekorátory) a funkce volané z frontendu přes URL statická analýza nevidí, ty jsem nehodnotil jako mrtvé.

### 2.3 Bezpečnost

**Tajemství:** v aktuálním stromu ani v celé git historii (`git log -p --all`, vzory `AIza…`, `sk-…`, `sk_…`, `ghp_…`, privátní klíče) **nic nenalezeno**. `.env`, `.deploy.env`, `user_config.json`, `*.db` a `chroma_db/` jsou správně ignorované a nikdy nebyly commitnuté. Lokální `.env` obsahuje reálné klíče (jen názvy proměnných ověřeny, hodnoty nečteny) a `user_config.json` a `auth.db` (`user_api_keys`) je drží v plaintextu. Rotace není nutná, protože neunikly do gitu. Doporučení k at-rest šifrování viz S12.

| # | Umístění | Popis | Záv. | Jist. |
|---|---|---|---|---|
| S1 | `routers/files.py`, `notes.py`, `flashcards.py`, `podcast.py`, `tests_api.py`, `chat_api.py:150-299`, `routers/projects.py:287` (`clear-data`), `:376`/`:472` (export), `medulingo.py` | **IDOR:** přístup k projektu se neověřuje vůči vlastníkovi. V režimu `shared_projects=0` může kterýkoli uživatel číst, mazat a přepisovat cizí projekt, stačí znát jeho název (a ten prozradí `/api/logs`, viz S3) | K | O |
| S2 | `main.py:286-289` (StaticFiles `/uploads`, `/lessons-data`, `/audio`, `/notes-files`) | Statické mounty servírují soubory všech projektů každému přihlášenému včetně hosta (`role=viewer`, `is_guest`), bez ohledu na vlastnictví | V | O |
| S3 | `main.py:247-263`, `core/logger.py:30-34` | `/api/logs` je globální broadcast. Host i uživatel vidí logy všech ostatních (názvy projektů a souborů, úryvky textů `podcast_service.py:76`, dotazy `rag_service.py:257`, username při ukládání klíčů `settings.py:166`) | V | O |
| S4 | `routers/print.py:20-66` + `main.py:229-232` | **Stored XSS:** `/api/print/prepare` uloží libovolné HTML, `/print_preview/{id}` ho vrátí bez sanitizace ze stejného originu. Povoleno i pro viewer/host | V | O |
| S5 | `routers/print.py:46-51` | `auto_open_browser` volá `webbrowser.open()` **na serveru**, spustitelné i hostem. `_print_jobs` je neomezený in-memory slovník (memory DoS) | S | O |
| S6 | `routers/projects.py:736-952` | Import `.medproj`: (a) `overwrite=True` smaže a přepíše **cizí** projekt (`:772-786`), (b) žádný limit velikosti ani počtu souborů (zip bomb), (c) do `uploads/` zapíše soubory libovolné přípony (`.html`, `.svg`), které pak `/uploads` servíruje ze stejného originu, což je další XSS vektor, (d) kontrola `startswith(target_dir)` bez `os.sep` (`:797`) | V | O |
| S7 | `services/test_service.py:322-323` | `TestStorageManager._file_path` používá `os.path.join` bez `safe_join`. Na Linuxu Starlette `/` v path parametru nepustí. **Na Windows desktopu** (`scripts/build_desktop.bat`) by `..\\..\\x.json` mohl vést mimo adresář | S | P (Windows nezkoušeno) |
| S8 | `routers/auth.py:114-125`, `main.py:202-213` | Login ani legacy Basic Auth (`APP_PASSWORD` → admin `id=0`) nemají rate limiting ani lockout | S | O |
| S9 | `routers/auth.py:101` + `services/auth_service.py:342` | `/api/auth/setup` je veřejný: kdo první otevře čerstvou instanci (např. přes Cloudflare tunel), stane se adminem. Kontrola `needs_setup()` a INSERT nejsou atomické (TOCTOU) | S | O |
| S10 | `docker-compose.yml:9-11` + `Dockerfile:58` | Port `8000` publikovaný na všech rozhraních vedle `proxy_net`, a k tomu `--forwarded-allow-ips=*`. Přímý přístup obchází reverzní proxy a `X-Forwarded-Proto` jde podvrhnout (`routers/auth.py:57`, `secure` cookie) | S | O |
| S11 | `services/chat_service.py:1417-1453`, `routers/*` (`gemini_model` z payloadu, 7 míst) | Klient smí poslat libovolný `gemini_model` a `custom_system_prompt` (plně nahradí systémový prompt). Ve sdíleném režimu jde o náklady adminova klíče a obejití „grounded“ chování | S | O |
| S12 | `services/auth_service.py:82-92`, `core/config.py:57-61` | API klíče uživatelů a session tokeny v plaintextu v SQLite / JSON | N | O |
| S13 | `routers/settings.py:88-106` | `pomodoro_settings` ukládá kterýkoli uživatel do **globálního** `user_config.json`, takže si uživatelé navzájem přepisují nastavení | N | O |
| S14 | `routers/settings.py:250-262` | `open-data-folder` spouští `subprocess.Popen` na serveru pro kteroukoli roli kromě viewer. Na serveru nedává smysl | N | O |
| S15 | `routers/files.py:38-66` | Upload bez limitu velikosti. Kontrola jen podle přípony, bez kontroly obsahu | S | O |
| S16 | `.env.example` | Chybí `APP_PASSWORD`, `HOST`, `PORT`, `AIMEDSTUDIO_DATA_DIR`, `AIMEDSTUDIO_SERVER_URL` (všechny čtené v kódu) | N | O |
| S17 | `entrypoint.sh:6` | Fallback `chmod -R 777 /app/data` | N | O |
| S18 | Závislosti | `pip-audit` není nainstalovaný, **neověřeno**. Navrhuji `pipx run pip-audit -r requirements.txt` (vyžaduje síť a souhlas). Verze jsou pinnuté, lockfile chybí | ? | P |
| S19 | SQL | Všechny dotazy v `auth_service`/`chat_service` jsou parametrizované, FTS dotaz se staví přes `build_czech_fts_query` (`chat_service.py:1064`). SQL injection **nenalezena** | – | O |
| S20 | Path traversal | `safe_join`/`safe_filename` (`core/security.py`) se používají konzistentně v files/notes/flashcards/podcast. Výjimkou jsou S6(d) a S7 | – | O |

Hranice klient/server: frontend nemá build krok a žádné `VITE_`/`NEXT_PUBLIC_` proměnné. `GET /api/settings` vrací klíče jen maskované (`routers/settings.py:72-77`), což je v pořádku. Zbytek viz 2.6.

### 2.4 AI pipeline

| # | Umístění | Popis | Záv. | Jist. |
|---|---|---|---|---|
| AI1 | `prompts/*.py` | Šablony jsou oddělené do `prompts/`, to je dobře. Výjimky: `MEDULINGO_PODCAST_PROMPT` re-export přes `services/medulingo_service.py:9`, jazykové direktivy v `core/context.py:39-73`, inline prompty v `routers/chat_api.py:300-414` (klasifikace otázek) a `services/test_service.py:240` (hodnocení odpovědí) | N | O |
| AI2 | `services/chat_service.py:1460-1477` | Prompt injection: dokumenty (RAG úryvky), historie konverzace i dotaz jdou do jednoho textového bloku, oddělené jen řádky `===`, bez instrukce „obsah zdrojů jsou data, ne pokyny“. Model **nemá nástroje** (žádné `tools=`/function calling), takže dopad je omezený na manipulaci výstupu. Ten se ale renderuje do DOM, viz 2.6 | S | O |
| AI3 | `services/flashcards_service.py:278`, `test_service.py:599`, `chat_api.py:360` | `response_mime_type="application/json"` bez `response_schema`. Výstup se opravuje regexy (R7) a dál se používá jako `dict` bez Pydantic validace. Chybějící klíče řeší ad hoc `.get()` | S | O |
| AI4 | `services/ai_service.py:140-145`, `lesson_service.py:330-335`, `chat_service.py:1505-1525` | Volání `generate_content` přes `asyncio.to_thread` **bez timeoutu**. Visící request blokuje vlákno a dávku | V | O |
| AI5 | `core/utils.py:81-104` | `is_retryable_gemini_error` matchuje podřetězce `"500"` a `"quota"`, takže retryuje i denní vyčerpání kvóty (~3 min čekání zbytečně) a chybu, jejíž text náhodou obsahuje „500“. Retry bez jitteru | S | O |
| AI6 | 15+ míst (`grep "gemini-3.6-flash"`), teploty a `max_output_tokens` v každé službě zvlášť | Názvy modelů, teploty a limity nejsou v konfiguraci. Fallback mapy jsou 2 a liší se (R3) | S | O |
| AI7 | `services/chat_service.py:1450,1482-1486` | Historie se oříznutí po znacích (`[:800]`, 6 zpráv), RAG 15 úryvků. Chybí počítání tokenů a cache. Dávky (`routers/batch.py`) generují pro každou otázku RAG dotaz znovu, bez cache | N | P |
| AI8 | `services/podcast_service.py:229,241-250` | TTS: OpenAI bez timeoutu, ElevenLabs `timeout=120`. Retry/backoff pro TTS chybí | S | O |
| AI9 | `services/ai_service.py:106-109` | Jazyková direktiva se přilepí do systémového promptu automaticky. U `lesson_service` (vlastní retry) a `chat_service` se řeší ručně jinde, proto je chování nekonzistentní | N | O |

### 2.5 Dokumentace a DX

| # | Umístění | Popis | Záv. | Jist. |
|---|---|---|---|---|
| D1 | `README.md` | Dobrý přehled funkcí a spuštění. Chybí: prerekvizity (ffmpeg, verze Pythonu), `pip install -r`, lint, popis rolí a bezpečnostního modelu. Tvrdí Python 3.11+ (R14) | N | O |
| D2 | `docs/ARCHITECTURE.md` | Existuje, má mermaid diagram. Neodpovídá realitě v detailech (Python 3.12+, nezmiňuje duplicitní klienty v `chat_service`, shimy) | N | O |
| D3 | `DOCKER_GUIDE.md`, `CLOUDFLARE_GUIDE.md` v kořeni | Patří do `docs/`. CLOUDFLARE_GUIDE popisuje role jako bezpečnostní hranici, ale ta kvůli S1–S4 neplatí | S | O |
| D4 | In-code | Docstringy česky, nekonzistentní. Typové anotace u služeb částečné (`list`, `dict` bez parametrů, `Any`). Žádný mypy | N | O |
| D5 | CI | Žádné CI, testy ani lint se automaticky nespouštějí | S | O |

### 2.6 Frontend (`static/`)

**Struktura `app.js`:** jeden klasický skript (ne ES modul) se 468 top-level funkcemi, ~95 globálními `let` (ř. 1–240) a paralelně používaným `window.*` stavem (`window.currentDeck` vs. `let currentDeck`). Hlavní sekce: plánovač 2038–3934 (~1 900 ř.), testy 6263–7894 (~1 630 ř.), Medulingo 12632–14133 (~1 500 ř.), chat 7895–10161 (~2 270 ř.), auth+admin 11446–12631 (~1 185 ř.), Pomodoro 14134–15074 (~940 ř.). Volání API: 95× ad-hoc `fetch(`, bez wrapperu. Jediná centralizace je monkeypatch `window.fetch` (`app.js:11452-11490`). `index.html` má ~480 inline handlerů (`onclick` 396…), které vyžadují globální funkce a brání přechodu na moduly.

| # | Umístění | Popis | Záv. | Jist. |
|---|---|---|---|---|
| F1 | `static/js/app.js:5378-5386` (`renderMarkdownWithKaTeX`, 19 volání), `:622,667,711,13404,13602-13631` | **AI výstup (markdown) jde přes `marked.parse` do `innerHTML` bez sanitizace.** DOMPurify v projektu není (0 výskytů). Řetěz: prompt injection v nahraném PDF → model vrátí `<img onerror=…>` → XSS u každého, kdo si poznámky, kartičky nebo chat otevře (sdílené projekty) | K | O |
| F2 | `app.js:12192` (+ `3403`, `4332-4338`, `6413`, `6419`) | `onclick="adminDeleteUser(id,'${escapeHtml(u.username)}')"`: HTML entity se dekódují před parsováním JS, takže jde o injekci do JS kontextu. Backend username neomezuje znaky (`services/auth_service.py:385-390`, jen délka ≥ 3), a proto **neautentizovaná registrace → XSS v admin panelu** | V | O (vzor + backend) / P (neprovedeno prakticky) |
| F3 | `app.js:5455,5542,6165,7783-7799,9909,11203-11210,6080,718` | Názvy souborů a zdrojů neescapované v `innerHTML` a `onclick="fn('${…}')"`. `safe_filename` na backendu `'"<>` odstraní, ale import ZIP (S6) a `source_ref` z AI výstupu ne | V | O (kód) / P (zneužitelnost) |
| F4 | `app.js:9902` | Při chybě renderu se vloží raw `msg.content` | V | O |
| F5 | `static/index.html:14-15` | `cdn.tailwindcss.com` (Play CDN, není pro produkci) a `marked` **bez verze** (vždy latest), bez SRI. KaTeX pinnutý, ale také bez SRI. CSP chybí | V | O |
| F6 | `app.js:6077-6078`, `1431,5284,7982,8181,8566,8764,9080,13641`, `translations.js:4316-4320` | Atributová injekce přes `title="${cleanFront}"`, neescapované `e.message`/`detail` v `innerHTML`, `t()` interpoluje parametry bez escapování | S | O / P (t()) |
| F7 | Escapování: `escapeHtml` 2064, ruční `.replace(/</g…)` 674/713/8589/9098, `escapeQuotes` 2074 (neescapuje `\`) | Pět variant escapování. `innerHTML` 219×, `escapeHtml` 58× | S | O |
| F8 | Duplicity | Markdown render 2 cesty, notifikace (`alert` 138×, `confirm` 23×, `prompt` 10×, `showGlobalToast` 54×), výpočet jazyka 5×, ~25 párů open/close modal, 15× formátování data, `"Content-Type": "application/json"` 37×, stream reader 2× (10042, 13564) | S | O |
| F9 | Mrtvý kód | `loadQuestionsFromStorage` 2591, `loadExamPlanner` 2595, `updateQuestionTitle` 4582, `clearCurrentChatHistory` 10145, `showStatus` 10689, `selectMedTestOption` 13800 (0 referencí vč. HTML). 249 i18n klíčů/jazyk bez statické reference (**P** – mohou být skládány dynamicky) | N | O / P |
| F10 | `translations.js` | Duplicitní klíče `settings.statusActive`, `settings.statusBlocked`, `qm.allTopics`, `qm.questionsCount` (hodnoty se liší, platí pozdější). Chybí `common.active/general/readOnly/viewerReadOnly`. Slovník obsahuje i UI logiku (toast, přepínač). Zhruba 600 řádků hardcoded češtiny v `app.js` | N | O |
| F11 | Dlouhé funkce | `renderCurrentQuestion` 6896–7144 (249 ř.), `renderPlannerTable` 3226–3450, `renderQuestionsManagerTable` 4156–4374, `loadAdminUserManagement` 11997–12210 | N | O |

V pořádku: session token se v JS nevyskytuje (HttpOnly cookie, `routers/auth.py:59-61`), BYOK klíče jsou na klientu jen maskované, žádné `eval`/`new Function`, SSE log se renderuje přes `textContent`.

---

## 3. Cílová struktura

```
podcast/
├── app/                         # (volitelně později; v 1. vlně ponechat kořen kvůli Dockerfile/spec)
├── main.py                      # jen vytvoření app, middleware, include_router, mounty
├── core/
│   ├── config.py                # cesty + NOVĚ AISettings (modely, teploty, limity, timeouty, fallback mapa)
│   ├── clients.py               # jediný Gemini/OpenAI/Chroma klient; get_api_key(provider); bez importu services
│   ├── db.py                    # NOVÉ: sqlite helper (closing, WAL, row_factory) pro auth i chat
│   ├── security.py              # safe_join, safe_filename
│   ├── authz.py                 # NOVÉ: Depends – current_user, require_role, require_project_access(project)
│   ├── context.py, logger.py    # logger: per-user/per-project kanály SSE
│   └── utils.py                 # jediné sanitize_name, normalize_text, chyby API
├── prompts/                     # beze změny + přesun inline promptů z chat_api/test_service
├── schemas/                     # NOVÉ: Pydantic modely requestů a AI výstupů (flashcards, test, klasifikace)
├── services/
│   ├── ai_service.py            # jediné call_gemini (retry, timeout, fallback, jazyk), parse+validate JSON
│   ├── chat/                    # rozpad chat_service.py
│   │   ├── repository.py        #   SQLite vlákna/zprávy/lekce, export/import
│   │   ├── fts.py               #   český stemmer + FTS5
│   │   ├── retrieval.py         #   hybridní retrieval
│   │   └── grounded_chat.py     #   stream odpovědi
│   ├── projects/                # NOVÉ: export/import .medproj vytažený z routers/projects.py
│   ├── tests/                   # rozpad test_service: parser, storage, generator
│   ├── batch.py                 # společná kostra dávky (stav, cancel, události) + 3 strategie
│   └── auth_service.py, rag_service.py, podcast_service.py, notes_service.py, flashcards_service.py, …
├── routers/                     # tenké: validace (schemas) → authz → service
├── static/
│   ├── index.html
│   └── js/
│       ├── app.js → main.js     # bootstrap
│       ├── lib/ api.js, dom.js (escapeHtml, renderMarkdown+DOMPurify), modal.js, toast.js, i18n.js
│       └── features/ planner.js, questions.js, notes.js, flashcards.js, tests.js, chat.js, lesson.js,
│                    podcast.js, settings.js, auth-admin.js, medulingo.js, pomodoro.js, print.js
├── tests/                       # unit + characterization (routers přes TestClient s tmp data dir)
├── docs/
│   ├── ARCHITECTURE.md, SECURITY.md (role, authz model), deployment/docker.md, deployment/cloudflare.md
│   └── audit/ AUDIT.md, BASELINE.md, CHANGELOG.md
└── requirements.txt / requirements-desktop.txt / requirements-dev.txt   # jen se souhlasem
```

**Zdůvodnění:** Rozdělení kopíruje stávající vrstvy (`core` → `services` → `routers`) a jen je dotahuje. `core` přestane záviset na `services` a autorizace bude jedna `Depends` funkce místo rozptýlených `if role == …`. Rozpad `chat_service.py` odpovídá jeho sedmi zodpovědnostem. Frontend se dělí podle už existujících bannerů v `app.js`, takže přesun je mechanický. Kvůli 480 inline handlerům se ale musí dělat postupně: moduly nejdřív exportují funkce na `window`.

---

## 4. Plán refaktoringu

Každý krok = 1 commit na větvi `refactor/cleanup`. Po každém kroku: `ruff check`, `ruff format --check`, `unittest` (izolovaný data dir), `node --check`, porovnání s BASELINE.

> **Poznámka k pravidlu „refaktoring nemění chování“:** fáze 1 (bezpečnost) chování **záměrně mění**: přidává 403, sanitizaci a limity. Navrhuji ji vést jako samostatné, výslovně schválené *security-fix* commity a nemíchat ji s čistým refaktoringem. Kroky označené ⚠ mění chování.

### Fáze 1 – Sanace bezpečnosti

| Krok | Co a kde | Riziko | Ověření | Testy předem |
|---|---|---|---|---|
| 1.1 ⚠ | `core/authz.py`: `require_project_access(project, write)`. Napojit ve všech routerech s parametrem projektu (S1) a v importu s `overwrite` (S6a). Chat vlákna ověřit přes projekt vlákna | V (dotkne se ~50 endpointů, riziko 403 tam, kde dřív prošlo) | Nové testy: vlastník OK, cizí 403, admin OK, shared mode beze změny | **Ano**, charakterizační testy shared módu + nové negativní testy |
| 1.2 ⚠ | Statické mounty `/uploads`, `/audio`, `/notes-files`, `/lessons-data` nahradit endpointem s kontrolou z 1.1 (S2) | S (frontend URL zůstanou, mění se jen handler) | TestClient: cizí soubor 403, vlastní 200 + stejné `Content-Type` | Ano |
| 1.3 ⚠ | `/api/logs`: filtrovat události podle uživatele/projektu, admin vidí vše (S3). Odstranit úryvky textů z logů (`podcast_service.py:76`) | S | Test se dvěma subscribery | Ano |
| 1.4 ⚠ | Frontend: DOMPurify (pinnutá verze + SRI) v jediném `renderMarkdown()`, sjednotit všech 7 přímých `marked.parse` (F1, F4) | S (může odstranit legitimní HTML z poznámek, např. `<sup>` citace, nutný allowlist) | Ruční průchod: poznámky, chat, kartičky, Medulingo, tisk. Snapshot HTML na vzorových výstupech | Ano: zachytit HTML výstup `renderMarkdownWithKaTeX` na 5 vzorcích (node) |
| 1.5 ⚠ | Print: sanitizovat HTML na serveru (allowlist) nebo renderovat jen z ID uloženého obsahu. Zakázat viewerům, odstranit `webbrowser.open` mimo desktop, omezit `_print_jobs` (S4, S5) | S | Test: `<script>` v payloadu se ve výstupu neobjeví | Ano |
| 1.6 ⚠ | Inline `onclick` s interpolovanými řetězci (F2, F3) → `data-*` + delegovaný listener. Backend: omezit znaky username (nový validátor jen pro nové registrace) | S | Ruční: admin panel, seznamy souborů. Uživatel s `'` v názvu | Ne (UI), backend validátor ano |
| 1.7 ⚠ | Import ZIP: limity velikosti/počtu, allowlist přípon do `uploads/`, `startswith(base + os.sep)` (S6b–d). Upload limit (S15). `TestStorageManager` → `safe_join` (S7) | N–S | Testy s podvrženým ZIP | Ano |
| 1.8 ⚠ | Pinnout `marked`, SRI pro CDN, CSP hlavička (F5). Tailwind Play CDN zatím ponechat (přechod na build = nová závislost) | N | Aplikace se načte, KaTeX funguje | Ne |
| 1.9 ⚠ | Rate limit loginu (in-memory, bez závislosti), atomický `create_initial_admin` (S8, S9). `docker-compose` bez publikovaného portu nebo `127.0.0.1:8000`, `forwarded-allow-ips` na síť proxy (S10) | N | Testy pro lockout. Ruční nasazení na Pi | Ano (auth) |
| 1.10 ⚠ | Allowlist `gemini_model` z konfigurace. `custom_system_prompt` jen pro admina, nebo ho jen připojovat (S11) | N | Test: neznámý model → 400 | Ano |
| 1.11 | `.env.example` doplnit (S16) | N | – | Ne |

### Fáze 2 – Charakterizační testy (bez změny kódu aplikace)

| Krok | Co | Riziko | Ověření |
|---|---|---|---|
| 2.1 | `tests/conftest`-like base třída: tmp `AIMEDSTUDIO_DATA_DIR`, fake Gemini klient (monkeypatch `core.clients.get_gemini_client` a `services.chat_service.get_ai_client`) | N | Stávajících 18 testů projde |
| 2.2 | Routery: projekty (CRUD, rename, clear-data, export→import round-trip), files (upload/list/delete), notes/flashcards/tests (list/get/delete) | N | Nové testy zelené na `main` |
| 2.3 | Služby: `sanitize_*` všech 5 variant (zachytí rozdíly R1), `get_fallback_model` obě verze, `clean_and_parse_json` + `parse_and_validate_test_json` na reálných vzorcích, `build_czech_fts_query`, `chunk_text` | N | – |
| 2.4 | `call_gemini_with_retries` / `_resilience` s fake klientem (retry, fallback, výjimky) | N | – |

### Fáze 3 – Rozdělení god souborů (čistý refaktoring, beze změny chování)

| Krok | Co a kde | Riziko | Ověření | Testy předem |
|---|---|---|---|---|
| 3.1 | `services/chat_service.py` rozdělit do `services/chat/{repository,fts,retrieval,grounded_chat}.py`. `services/chat_service.py` zůstane jako re-export fasáda | S (cyklus s `rag_service`, pořadí `init_db()` při importu) | Testy 2.2–2.3, OpenAPI diff = 0 | 2.2, 2.3 |
| 3.2 | Export/import z `routers/projects.py:376-952` → `services/projects/transfer.py` | S | Round-trip test 2.2 | 2.2 |
| 3.3 | `services/test_service.py` → parser / storage / generator | N | 2.3 | 2.3 |
| 3.4 | `routers/batch.py`: společná kostra dávky, 3 strategie | S (cancel/resume logika) | Test s fake generátory: pořadí událostí `send_batch_event` beze změny | Ano (nový) |
| 3.5 | `app.js` → ES moduly podle sekcí, funkce volané z HTML dočasně exportovat na `window`. Po jedné sekci na commit (začít Pomodoro a Medulingo, které jsou nejvíc izolované) | V (bez testů frontendu, globální stav) | Ruční smoke checklist pro každou záložku + `node --check` | Doporučeno: Playwright smoke (**nová závislost → souhlas**). Jinak ruční checklist |

### Fáze 4 – Sloučení utilit a mrtvý kód

| Krok | Co | Riziko | Ověření |
|---|---|---|---|
| 4.1 | `ruff --fix` F401 (132), zapnout F401 v `pyproject.toml` | N | testy, OpenAPI diff |
| 4.2 | Smazat mrtvou `ai_service.call_gemini_with_resilience`, `lesson_service` použije sdílenou implementaci. **Ponechat mapu fallbacků `lesson_service`** jako parametr, jinak by se změnilo chování (R2, R3) | N | test 2.4 |
| 4.3 | `chat_service`/`lesson_service` → `core.clients` (R4, R5) | ⚠ **mění chování** v BYOK režimu (chat začne používat klíč uživatele). Je to oprava chyby, a proto patří do samostatného commitu se souhlasem | test s per-user klíčem |
| 4.4 | Sjednotit `sanitize_name` (R1): varianty test/medulingo → `core.utils` (rozdíl jen v okrajových `_`, ověřit testem 2.3). `sanitize_project_name` **nesjednocovat bez migrace dat**, jen zdokumentovat | S | 2.3 |
| 4.5 | Přesměrovat 14 `from chat_service import` na `services.chat_service`, smazat 5 kořenových shimů, upravit `medstudio.spec` hiddenimports (R9, A7) | S (PyInstaller build) | `scripts/build_desktop.sh` build + spuštění |
| 4.6 | Smazat `core/context.py` nepoužité funkce (R10), frontend F9 (6 funkcí, ověřené). i18n klíče F9 **ne** (jen podezření) | N | grep + testy |
| 4.7 | `git rm --cached` `.DS_Store`, `__pycache__/main_v1…pyc` (R12) | N | – |
| 4.8 | Frontend helpery: `apiFetch`, `escapeHtml` (jediný), `openModal/closeModal`, `toast/confirm` (F7, F8) | S | ruční checklist |
| 4.9 | `core/config.py` AISettings: modely, teploty, limity, fallback mapa. Nahradit literály (AI6) se zachováním hodnot | N | testy + grep na literály = 0 |
| 4.10 | Pydantic modely requestů (A11) se zachováním defaultů | S (422 místo dřívějšího tichého defaultu) | OpenAPI diff, testy 2.2 |

### Fáze 5 – Dokumentace

| Krok | Co |
|---|---|
| 5.1 | `README.md`: prerekvizity (Python 3.11, ffmpeg), instalace, testy, lint |
| 5.2 | Přesun `DOCKER_GUIDE.md`, `CLOUDFLARE_GUIDE.md` → `docs/deployment/`. Opravit tvrzení o rolích (D3) |
| 5.3 | `docs/ARCHITECTURE.md` aktualizovat podle nové struktury. Nový `docs/SECURITY.md` (role, authz model, sdílené klíče) |
| 5.4 | Navrhnout CI (GitHub Actions: ruff + unittest), **jen se souhlasem** |

**Body vyžadující tvůj samostatný souhlas:** změny závislostí (DOMPurify z CDN, rozdělení requirements, Playwright, vulture/pip-audit), všechny ⚠ kroky (mění chování), migrace ID projektů s diakritikou (R1), CI.

---

## 5. Pokrytí auditu

| Oblast | Hloubka |
|---|---|
| `main.py`, `core/*`, `routers/auth.py`, `routers/settings.py`, `routers/print.py`, `services/ai_service.py`, `services/auth_service.py` (klíčové části) | důkladně |
| `routers/projects.py` (výpis, delete, import), `routers/files.py`, `routers/tests_api.py`, `routers/chat_api.py` (vlákna), `services/chat_service.py` (klienti, schéma, grounded chat), `services/lesson_service.py` (retry) | středně, cílené části |
| `routers/batch.py`, `routers/medulingo.py`, `routers/notes.py`, `routers/flashcards.py`, `routers/podcast.py`, `services/{rag,podcast,notes,flashcards,medulingo,test}_service.py` | **zběžně**: struktura funkcí, grep na autorizaci, cesty, modely, logování. Logiku (např. FTS stemmer, chunking, medulingo pacing) jsem nečetl řádek po řádku |
| `prompts/*.py` | jen velikost a umístění, obsah promptů nehodnocen |
| `static/*` | paralelní audit (subagent), klíčová tvrzení F1, F2, F5 ověřena ručně |
| `desktop_app.py`, `medstudio.spec`, `scripts/*`, `deploy.sh`, `update.sh` | **zběžně / neprošlo** (deploy skripty jen podle názvů proměnných) |
| Závislosti (CVE) | **neprověřeno**, `pip-audit` není nainstalovaný |
| Mrtvý kód Python | grep-based, ne `vulture` |
| Runtime chování | nic jsem nespouštěl proti reálným datům. XSS a IDOR jsou ověřené čtením kódu, ne exploitací |
| `scratch/`, `venv/`, data adresáře | vynecháno (nejsou v gitu) |
