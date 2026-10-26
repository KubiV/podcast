# Prompt: Kompletní funkční a UI audit AI MedStudio

> Zkopíruj vše pod čarou do Codexu / Antigravity / Claude Code spuštěného v kořeni repozitáře.

---

## Role a cíl

Jsi senior QA inženýr a full-stack vývojář. Tvým úkolem je **systematicky projít celou aplikaci AI MedStudio** (FastAPI backend + SPA frontend bez build kroku) a ověřit, že **každá funkce a každý prvek UI** (tlačítko, odkaz, přepínač, formulář, modal, záložka, dropdown, klávesová zkratka) je funkční a dělá **správně** to, co má – nejen že „nespadne“.

Výstupem je **report s nálezy** a **pokrytím** (co bylo otestováno, jak a s jakým výsledkem). Kód **neopravuj**, dokud o to výslovně nepožádám – jen hlas nálezy s přesnou reprodukcí a návrhem opravy.

Nejdřív si přečti: `README.md`, `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, `docs/audit/AUDIT.md` (známé nálezy – neduplikuj je, jen ověř, zda stále platí), `.env.example`.

## ⚠️ Bezpečnostní pravidla (závazná)

1. **Nikdy nepracuj s reálnými daty.** Při spuštění ze zdrojů leží data v kořeni repozitáře (`auth.db`, `chat_history.db`, `chroma_db/`, `uploads/`, `generated_*/`, `lessons_data/`, `user_config.json`). Aplikaci spouštěj **výhradně** s izolovaným adresářem:
   ```bash
   export AIMEDSTUDIO_DATA_DIR="$(mktemp -d)/qa-data"
   ```
   Před začátkem a na konci porovnej `mtime` souborů `auth.db` a `chat_history.db` v kořeni repa – nesmí se změnit. Pokud se změní, okamžitě přestaň a nahlas to.
2. **Testy spouštěj jen tímto příkazem** (jiné tvary už jednou zapsaly do reálných dat):
   ```bash
   venv/bin/python -m unittest discover -s tests -t .
   ```
   případně jednotlivý modul `venv/bin/python -m unittest tests.<modul>`. Nikdy `python -m unittest discover tests` ani holé `python -m unittest`.
3. **API klíče a náklady:** AI volání (Gemini, OpenAI, ElevenLabs) stojí peníze. Klíče nikdy nevypisuj do logů ani reportu. Pokud nemáš testovací klíč, otestuj AI funkce do bodu odeslání požadavku a ošetření chyby (neplatný/chybějící klíč) a zbytek označ jako „neověřeno – vyžaduje klíč“. S klíčem používej **minimální vstupy** (malý TXT materiál, 1–2 otázky, 3–5 kartiček, krátký podcast).
4. Žádné `git push`, commit ani změny konfigurace mimo dočasný adresář. Neměň `requirements.txt`.

## Fáze 0 – Příprava a baseline

- Ověř prostředí: Python ≥ 3.11, `venv`, `ffmpeg` v PATH, `pip install -r requirements.txt -r requirements-dev.txt`.
- Spusť unit testy (viz výše), `ruff check .` a frontendové kontroly v `tests/frontend/` (`handlers_check.js`, `render_check.js` – zjisti z `tests/test_frontend_smoke.py`, jak se spouštějí). Zaznamenej výsledek jako baseline.
- Spusť server s izolovanými daty: `uvicorn main:app --port 8000` a ověř `GET /health`.
- Připrav testovací materiály v dočasném adresáři: malý `.txt`, `.pdf` (textový i naskenovaný/obrázkový), `.docx`, `.pptx`, CSV s otázkami, prostý text s otázkami, obrázek, prázdný soubor, soubor s nepovolenou příponou, soubor s diakritikou/mezerami v názvu, nadměrně velký soubor.

## Fáze 1 – Inventura (než začneš testovat)

Vytvoř si **úplný seznam** toho, co budeš testovat, a ten seznam přilož k reportu jako matici pokrytí:

1. **API endpointy:** projdi všechny `@router.*` v `routers/*.py` a endpointy v `main.py` (vč. `/api/logs` SSE, statických mountů `/uploads`, `/lessons-data`, `/audio`, `/notes-files`). Pro každý zapiš metodu, cestu, požadovanou roli, vstupní model (`core/request_models.py`).
2. **UI prvky:** projdi `static/index.html` a `static/js/*.js`. Vypiš každý `onclick`/`onchange`/`oninput`/`onsubmit`, každý `addEventListener`, každé `id` tlačítka/inputu/selectu, každý `view*` pohled a `modal*` modal. Ověř, že **každý handler volaný z HTML skutečně existuje** jako globální funkce a každé `getElementById` míří na existující `id` (mrtvé odkazy = nález).
3. **Překlady:** porovnej klíče v `static/js/translations.js` mezi jazyky a proti klíčům použitým v HTML/JS (`data-i18n` apod.). Chybějící/nepoužité klíče = nález.

## Fáze 2 – Funkční test po modulech (UI + API)

Testuj v reálném prohlížeči (Playwright / vestavěný browser). U každého prvku ověř: **viditelnost → kliknutelnost → správný efekt v UI → správný požadavek na API → správný stav dat po reloadu stránky → žádná chyba v konzoli ani v serverovém logu**. Testuj i negativní cesty (prázdný vstup, neplatný vstup, zrušení, dvojklik, akce bez vybraného projektu).

### 2.1 Autentizace a první spuštění
- `modalWelcome`, první setup admina (`/api/auth/setup`), přihlášení, odhlášení, registrace, chybné heslo, rate limiting přihlášení, expirace/neplatná cookie.
- Admin v Nastavení → záložka *Uživatelé*: schválení/odmítnutí čekajícího uživatele, změna role, zablokování/odblokování, smazání uživatele, přepínače *registrace*, *režim hosta*, *sdílené projekty*, *sdílené API klíče*. Po každém přepnutí ověř skutečný dopad (viz Fáze 3).

### 2.2 Projekty (`modalProjectManager`, `modalProjectExport`, `modalProjectImport`)
- Vytvoření, přejmenování, přepnutí, smazání projektu, vymazání dat projektu (`clear-data`), reindex.
- Export `.medproj` (export-info, velikost, obsah) a import (inspect → import), import poškozeného/cizího/příliš velkého archivu, kolize názvů, path traversal v archivu.
- Nabídka otázek po vytvoření projektu (`modalNewProjectQuestionsOffer`).

### 2.3 Domů / dashboard (`viewHome`)
- Statistiky (`/api/stats`) odpovídají skutečnému počtu materiálů, otázek, audia, poznámek, kartiček, testů; rozcestník vede na správné pohledy; prázdný stav bez projektu.

### 2.4 Materiály a prohlížeč dokumentů (`viewFiles`, `modalDocumentViewer`)
- Upload všech typů souborů (vč. negativních), smazání, vyhledávání v seznamu, počítadlo souborů.
- Prohlížeč: PDF (zoom, skok na stránku, celkový počet stran), textové dokumenty (velikost písma, téma čtečky, kapitoly/dropdown, fulltext s počítadlem výskytů, citace), nativní náhled vs. textový náhled, loading a empty state, navigace mezi soubory (`viewer-navigation.js`).

### 2.5 Plánovač zkoušky a správce otázek (`viewPlanner`, `modalQuestionsManager`, `modalPlannerImport`, `modalPlannerAddQuestion`)
- Přidání/úprava/smazání otázky, okruhy, fulltext a filtry, označení naučeno, přepínač řazení naučených (ON posouvá na konec), uložení plánu a jeho perzistence.
- Import ze souboru (CSV/TXT), z textu, z jiného projektu (všechny tři záložky), duplicity, prázdné řádky, kódování (UTF-8 s BOM, cp1250).
- AI klasifikace otázek do okruhů.

### 2.6 Medulingo (`viewMedulingo`)
- Mapa otázek po kategoriích, pacing, streak (simuluj změnu dne), odemykání kroků.
- 5 kroků: studijní text, minipodcast, kartičky, AI asistent, finální test; `generate-pack`, `complete`; dohledání poznámek k otázkám s dlouhými názvy.
- Integrace Pomodora (zapnutí/vypnutí 1 klikem).

### 2.7 Pomodoro (`viewPomodoro`, `modalPomodoroComplete`, mini-časovač v záhlaví)
- Start/pauza/reset/přeskočení, cykly 25/5/15 (zrychli čas přes mock `Date`/timerů), dlouhá pauza po 4 cyklech, zvuk přes Web Audio, mini-časovač zůstává při přepínání pohledů, chování po reloadu.

### 2.8 Podcast Studio (`viewPodcast`, `modalPodcastPlayer`)
- Generování scénáře → audio → titulky SRT/MP4, výběr hlasu/poskytovatele, přehrávač (play/pause/seek/rychlost), stažení, smazání výstupu, chyba bez TTS klíče, chybějící ffmpeg.

### 2.9 Poznámky (`viewNotes`)
- Generování pro jednu i více otázek, struktura sekcí, citace v horním indexu odpovídají zdrojům, render Markdownu (marked + DOMPurify + KaTeX), export do Markdownu, tisk/PDF (`/api/print/prepare`, `/print_preview/{id}`), smazání.

### 2.10 Kartičky (`viewCards`)
- Předvolby i vlastní počet (hranice 1 a 500, mimo rozsah), série bez duplicit, 3D otáčení, navigace, export Anki `.txt/.tsv` (tabulátory, HTML), export všeho, kopírování pro Quizlet, smazání, prompty (`/api/flashcards-prompts`).

### 2.11 Testy (`viewTests`)
- Generování z otázek / z materiálů / vlastního zadání; všechny typy otázek (ABCD jedna i více správných, otevřené, kazuistiky, pravda/nepravda).
- Režim okamžitého vyhodnocení vs. zkouškový, výpočet skóre, hodnocení otevřené odpovědi (% shody) a sebehodnocení Znovu/Těžké/Dobré/Snadné, uložení výsledku, „Opakovat pouze chyby“, export Markdown, generování navazujících otázek (lehčí/stejná/těžší, počet).

### 2.12 Chat se zdroji (`viewChat`)
- Streamování tokenů (SSE), inline citace `[Zdroj: …]` a rozbalovací úryvky, vlákna (nové, přejmenování, připnutí 📌, smazání), fulltext v historii (názvy i obsah), export vlákna i projektu, přerušení streamu, perzistence po reloadu, odpověď mimo zdroje (musí odmítnout halucinovat).

### 2.13 Výuková lekce (`viewLesson`, `modalNewLesson`)
- Založení lekce z různých podkladů, vytvoření izolovaného projektu, `lesson_material.md`, `lecture_audio.mp3`, kapitoly, časový scrubber, duální prohlížeč, smazání lekce.

### 2.14 Dávkové zpracování a noční režim
- Dávky pro podcasty, poznámky, kartičky; „jen nehotové“; retry (až 3 pokusy – simuluj selhání), závěrečný sweep, zrušení dávky (`/api/cancel-batch`), souběh dvou dávek, průběh v živé SSE konzoli (`/api/logs`).

### 2.15 Nastavení (`modalSettings`)
- Uložení/načtení klíčů (maskování – plný klíč se nesmí vrátit z API ani objevit v DOM), „Ověřit“ klíč (platný/neplatný/prázdný), výběr modelu z allowlistu, tlačítko „📂 Otevřít“ složku dat, jazyk aplikace CZ/EN (přepni a projdi všechny pohledy – nepřeložené texty = nález).

## Fáze 3 – Průřezové kontroly

- **Role a režimy sdílení:** pro `admin`, `user`, `viewer` a host (s režimem hosta zapnutým i vypnutým) a pro kombinace přepínačů sdílených projektů/klíčů ověř, co vidí UI **a** co vrátí API. Viewer musí dostat `403` na každý zápis kromě výjimek v `docs/SECURITY.md`; UI má zápisové prvky skrýt/zakázat. Uživatel A nesmí přes API přistoupit k projektu/výstupu uživatele B v privátním režimu (IDOR, přímé URL na `/uploads/...`, `/audio/...`).
- **Bezpečnost vstupů:** XSS v názvech projektů, otázek, souborů, vláken a v AI výstupu (použij `tests/frontend/seed_xss_data.py` jako inspiraci), path traversal v `filename`, CSP a bezpečnostní hlavičky, velikostní limity uploadu.
- **Konzistence stavu:** po každé akci reload stránky – data musí sedět; přepnutí projektu nesmí ukázat data jiného projektu (zastaralé cache v JS); dvojklik na „Generovat“ nesmí spustit dvě operace.
- **Chybové stavy:** výpadek sítě, server vrátí 500, AI vrátí timeout/chybu/prázdnou odpověď – UI musí ukázat srozumitelnou hlášku a nezůstat v nekonečném loaderu.
- **Responzivita a přístupnost:** šířky 375 / 768 / 1280 / 1920 px; žádný horizontální scroll, překrývající se prvky, nedostupná tlačítka; modaly zavíratelné Esc i křížkem, focus trap; ovladatelnost klávesnicí; popisky inputů; kontrast.
- **Konzole a síť:** v každém pohledu nula JS chyb a nula neočekávaných 4xx/5xx; zaznamenej varování.
- **Desktopový režim:** `python desktop_app.py --browser` (s izolovaným `AIMEDSTUDIO_DATA_DIR`) – start, otevření složky dat.

## Formát reportu

Ulož do `docs/qa/QA_REPORT.md`:

1. **Shrnutí** – celkový stav, počty nálezů podle závažnosti, co nebylo možné ověřit a proč.
2. **Matice pokrytí** – tabulka: modul | prvek / endpoint | testovaný scénář | výsledek (✅ OK / ❌ chyba / ⚠️ podezřelé / ⏭️ neověřeno) | odkaz na nález.
3. **Nálezy**, seřazené podle závažnosti (Kritická / Vysoká / Střední / Nízká / Kosmetická), každý s:
   - ID (např. `QA-012`), modul, `soubor:řádek`,
   - kroky k reprodukci, očekávané vs. skutečné chování,
   - důkaz (screenshot, výpis konzole, HTTP odpověď – bez klíčů a osobních dat),
   - pravděpodobná příčina a návrh opravy,
   - zda jde o známý nález z `docs/audit/AUDIT.md`.
4. **Návrh automatizace** – které ručně ověřené scénáře stojí za to převést na automatické testy (unittest / Playwright) a jak.

Pracuj důkladně a nic nepřeskakuj potichu: pokud nějaký prvek nebo funkci nemůžeš otestovat, uveď ji v matici jako ⏭️ s důvodem. Na závěr ověř, že se reálná data v kořeni repa nezměnila.
