# Changelog refaktoringu

Větev `refactor/cleanup`. Každý krok plánu (viz [AUDIT.md](AUDIT.md) §4) = jeden commit.
Hash commitu se doplňuje v následujícím kroku (commit nemůže obsahovat vlastní hash).

## 1.1 ⚠ Autorizace přístupu k projektům (IDOR, nález S1, částečně S6a)

Commit: `fix(security): Enforce project ownership on project-scoped endpoints` (hash doplní další krok)

**Zabezpečeno:**
- Nový modul `core/authz.py`: `require_project_access`, `require_output_file_access`, `filter_accessible_output_files`, `require_thread_access`, `can_access_chat_project`.
- Pravidla převzata z původní kontroly v `delete_project`/`rename_project`. Ve sdíleném režimu (`shared_projects=1`) a pro admina se nic nemění. Pozorovatel (viewer/host) smí číst všechny projekty, stejně jako je vidí ve výpisu. Ostatní uživatelé mají přístup jen k vlastním projektům. Projekt bez vlastníka zůstává přístupný.
- Kontrola napojena na všechny endpointy s projektem, výstupním souborem nebo chat vláknem v `routers/files.py`, `notes.py`, `podcast.py`, `flashcards.py`, `tests_api.py`, `medulingo.py`, `batch.py`, `chat_api.py` a `projects.py` (clear-data, export-info, export, import, stats). Celkem 50 endpointů.
- Výpisy bez parametru projektu (`/api/notes`, `/api/flashcards`, `/api/tests`, `/api/outputs`, `/api/chat/threads?project_id=__all__`, `/api/stats`) skrývají cizí výstupy.
- Import `.medproj` s `overwrite=true` do cizího projektu vrací 403 dřív, než se cokoli smaže.

**Změna chování (záměrná):** v privátním režimu vrací přístup k cizímu projektu `403` s textem „Nemáte oprávnění pracovat s cizím privátním projektem.“

**Refaktoring v rámci kroku:** z `services/podcast_service.internal_generate_audio` vytažen `audio_filename_for()`, aby router kontroloval přesně ten název souboru, který služba zapíše. Chování služby je beze změny a pokrývá ho nový unit test.

**Testy:**
- `tests/__init__.py` izoluje testy: dočasný `AIMEDSTUDIO_DATA_DIR` a prázdné API klíče, takže testy nenačtou `.env`.
- Nový `tests/test_project_authz.py` (10 testů, ~60 kontrolovaných požadavků). Charakterizace sdíleného režimu a oprávnění vlastníka, admina a vieweru prošla už **před** změnou. Negativní testy před změnou selhaly (24 selhání v read-only části), po změně prochází.

**Ověření vůči baseline:** 29/29 testů OK (baseline 18 + 11 nových), `ruff check` beze změny (2× UP038), F401 131 (baseline 132), `ruff format` OK, seznam OpenAPI cest a metod je identický.

**Zjištěné chyby (zapsáno, neopraveno – mimo rozsah kroku):**
- Import projektu nenastaví importujícího jako vlastníka. Nový projekt pak připadne adminovi (`ensure_existing_projects_owned`, `routers/projects.py:72`), takže ho uživatel v privátním režimu po importu neuvidí.
- Výukové lekce (`/api/lessons*`, `lekce_*`) nemají model vlastnictví. Zůstávají globální knihovnou. Vyřešit je lze jen novou funkcí (uložení vlastníka při generování), proto jsou mimo tento krok.
- Výstupní soubory se k projektu přiřazují podle prefixu `{projekt}_`. Když existují projekty `a` a `a_b`, soubor `a_b_x.md` patří projektu `a_b` (nejdelší shoda), i kdyby vznikl v projektu `a` z otázky „b x“. To je důsledek stávajícího pojmenování souborů.
- Statické mounty `/uploads`, `/audio`, `/notes-files`, `/lessons-data` dál obcházejí autorizaci. Řeší je krok 1.2.

**Incident při psaní testů:** první spuštění nových testů proti **neopravenému** kódu (bez izolace klíčů) načetlo skutečné API klíče z lokálního `.env`. Proběhla tím reálná volání Gemini API (vrátila HTTP 429 „prepayment credits are depleted“, takže nevznikly žádné náklady) a pravděpodobně jedno volání OpenAI TTS s jednoznakovým textem „S“. Výsledek toho volání není z logu zřejmý. Data se zapisovala jen do dočasného adresáře. Opraveno v `tests/__init__.py`, kde jsou teď API klíče v testech vždy prázdné.
