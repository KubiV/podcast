# Changelog refaktoringu

Větev `refactor/cleanup`. Každý krok plánu (viz [AUDIT.md](AUDIT.md) §4) = jeden commit.
Hash commitu se doplňuje v následujícím kroku (commit nemůže obsahovat vlastní hash).

## 1.1 ⚠ Autorizace přístupu k projektům (IDOR, nález S1, částečně S6a)

Commit: `310d6b1` – `fix(security): Enforce project ownership on project-scoped endpoints`

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
- Statické mounty `/uploads`, `/audio`, `/notes-files`, `/lessons-data` dál obcházejí autorizaci. Řeší je krok 1.2 (hotovo).

**Incident při psaní testů:** první spuštění nových testů proti **neopravenému** kódu (bez izolace klíčů) načetlo skutečné API klíče z lokálního `.env`. Proběhla tím reálná volání Gemini API (vrátila HTTP 429 „prepayment credits are depleted“, takže nevznikly žádné náklady) a pravděpodobně jedno volání OpenAI TTS s jednoznakovým textem „S“. Výsledek toho volání není z logu zřejmý. Data se zapisovala jen do dočasného adresáře. Opraveno v `tests/__init__.py`, kde jsou teď API klíče v testech vždy prázdné.

## 1.2 ⚠ Autorizace statických souborů (nález S2)

Commit: `59ac8d8` – `fix(security): Check project access on static file mounts`

**Zabezpečeno:**
- `core/authz.py`: nová třída `ProjectStaticFiles`, podtřída `StaticFiles`. Před vrácením souboru ověří přístup k projektu (čtení) a pak deleguje na původní `StaticFiles.get_response`.
  - `/uploads/{projekt}/…` a `/lessons-data/{lekce}/…` určují projekt podle prvního segmentu cesty.
  - `/audio/…` a `/notes-files/…` určují projekt podle prefixu `{projekt}_` (stejné pravidlo jako v kroku 1.1).
- `main.py`: čtyři mounty nahrazeny touto třídou. URL zůstávají stejné, frontend se neměnil.

**Zachované chování** (charakterizační testy prošly před změnou i po ní): content-type, `Range` → 206, `If-None-Match` → 304, `HEAD`, 404 pro neexistující soubor, 401 bez přihlášení, beze změny ve sdíleném režimu, admin i viewer čtou cizí soubory.

**Změna chování (záměrná):** v privátním režimu vrací cizí soubor `403`. Lekce nemají vlastníka, proto zůstávají přístupné (stejně jako v kroku 1.1).

**Testy:** `TestStaticMounts` v `tests/test_project_authz.py` obsahuje 6 testů. Před změnou selhaly 3 negativní subtesty, po změně prochází vše.

**Ověření vůči baseline:** 35/35 testů OK, `ruff check` beze změny (2× UP038), F401 131, `ruff format` OK, seznam OpenAPI cest identický.

**Zjištěné chyby (zapsáno, neopraveno):**
- Odkazy na zdroj u kartiček mají natvrdo `http://localhost:8000/uploads/…` (`services/flashcards_service.py:132`, `routers/flashcards.py:234`). Při nasazení na serveru nefungují.

## 1.3 ⚠ Izolace živého logu `/api/logs` (nález S3)

Commit: `01fd81a` – `fix(security): Filter /api/logs events per user and project`

**Zabezpečeno:**
- `core/logger.py`: každá událost si při publikaci zapamatuje uživatele, který ji vyvolal (`current_user_var`), a projekt z payloadu. `log_history` teď ukládá i původce logu. Odběratel (`LogSubscriber`) nese svého uživatele.
- Pravidla doručení (`can_receive_event`):
  - admin vidí vše,
  - události s projektem (`batch`, `lesson_progress`) vidí ten, kdo smí projekt číst (pravidla z kroku 1.1),
  - ostatní logy vidí jen uživatel, který je vyvolal,
  - logy bez uživatelského kontextu (systémové) vidí jen admin.
- Přehrání historie po připojení používá stejná pravidla.
- `main.stream_logs` deleguje na `core.logger.stream_events(user)`. Logika proudu se přesunula z `main.py` do `core/logger.py` a z `main.py` zmizelo 6 importů, které tím přestaly být potřeba.
- `services/podcast_service.py`: log už neobsahuje úryvek textu zdrojového dokumentu (150 znaků), jen jeho délku a počet zdrojů.

**Změna chování (záměrná):**
- Běžný uživatel a host už nevidí logy ostatních. To platí **i ve sdíleném režimu projektů**: sdílené zůstávají jen projektové události (průběh dávek), ne textové logy.
- Pozorovatel (viewer/host) dál vidí průběh dávek všech projektů, protože smí číst všechny projekty.
- Průběh generování lekcí vidí všichni, protože lekce nemají vlastníka (krok 1.1).

**Zachované chování** (charakterizační testy prošly před změnou i po ní): formát SSE `event: …\ndata: {json}\n\n`, přehrání historie, nahrazení `\n` mezerou, doručení vlastních logů živě, formát událostí `batch`, sdílený režim pro dávky. Frontend se neměnil.

**Testy:** nový `tests/test_log_stream.py` (8 testů) čte generátor endpointu přímo. Před změnou selhaly 4 izolační testy, po změně prochází vše. Navíc proběhl ruční smoke test se skutečným uvicorn serverem (dočasná data, bez API klíčů): uživatel ve streamu viděl jen vlastní log, admin oba a nepřihlášený dostal 401.

**Ověření vůči baseline:** 43/43 testů OK, `ruff check` beze změny (2× UP038), F401 131, `ruff format` OK, seznam OpenAPI cest identický.

**Zbývá (mimo rozsah kroku):**
- Logy dál obsahují začátek uživatelského dotazu (`routers/chat_api.py`: `Chat dotaz … '{message[:50]}'`, `services/rag_service.py:257`) a jdou i na stdout (`print`). Vidí je jen autor a admin. Úplné odstranění je otázka zásad logování.
- `can_receive_event` se volá pro každou událost a každého odběratele a může sáhnout do SQLite (vlastník projektu). Při současném objemu událostí to nevadí.

## 1.4 ⚠ Sanitizace markdownu z AI výstupů (nálezy F1, F4, část F3)

Commit: `404b279` – `fix(security): Sanitize rendered markdown with DOMPurify`

**Nová závislost (schválena):** DOMPurify **3.4.16** z cdnjs s SRI `sha512-flQmhkXN…KjRoag==`, `crossorigin="anonymous"`. Hash jsem ověřil dvakrát: spočítal ze staženého souboru a porovnal s hodnotou z cdnjs API. Nejnovější 3.4.17 (vydaná 2026-10-12) jsem nepoužil, protože je mladší než 14 dní.

**Zabezpečeno (`static/js/app.js`):**
- `sanitizeHtml()`: HTML vždy prochází přes `DOMPurify.sanitize`. Když se knihovna nenačte, funguje fail-closed a obsah se zobrazí jako escapovaný text.
- `renderMarkdownWithKaTeX()`: výstup `marked.parse` se sanitizuje **před** vložením citací a KaTeX, které generuje sama aplikace. Při chybě `marked` se místo surového textu vrací escapovaný text.
- `renderMarkdownSafe()`: jediná cesta pro markdown bez KaTeX. Nahradila všech 7 přímých volání `marked.parse` (tisk poznámek, lekce, chatu a záložní větve v Medulingu). Záložní `<pre>${text}</pre>` už text escapuje.
- `createCitationBadge()`: text citace z výstupu modelu se dekóduje (`decodeHtmlEntities`) a pak escapuje podle kontextu. Pro JS řetězec v `onclick` slouží `escapeJsStringAttr`, pro `title` a obsah `escapeHtml`. Původní `replace(/'/g, "\\'")` nechránil, protože `marked` převádí `'` na `&#39;` a prohlížeč ho v atributu dekóduje zpět.
- Chat: při chybě renderu se zpráva vkládá escapovaná (F4, `appendChatMessageToUI`).
- `index.html`: cache-busting `app.js?v=2.4` → `v=2.5`, aby prohlížeče načetly opravu.

**Ověření (prohlížeč, dočasný server bez dat a klíčů):**
- Snapshot výstupu `renderMarkdownWithKaTeX` jsem pořídil před změnou a porovnal po ní. Všechny 4 běžné vzorky (poznámky s tabulkou, citacemi, kódem a vzorci; odpověď chatu; kartička; lekce s task listem a obrázkem) jsou **bajtově identické**.
- Škodlivé vzorky (`tests/frontend/markdown_fixtures.json`): před změnou se spustil skript u 5 z 8 (img onerror, odkaz `javascript:`, iframe srcdoc, citace s `'`, details ontoggle), po změně u 0 z 8.
- Kliknutí na citace předává handlerům přesné hodnoty, včetně názvu `O'Brien & spol.pdf`. Ten dřív rozbil JS řetězec, takže jde i o opravu chyby.
- DOMPurify se načetl se SRI. Bez něj se obsah zobrazí jako escapovaný text.
- `node --check` OK. Backend beze změny: 43/43 testů, ruff 2× UP038, format OK.

**Testovací pomůcky:** `tests/frontend/markdown_fixtures.json` (vzorky) a `tests/frontend/render_check.js` (harness pro konzoli prohlížeče se snapshotem v localStorage). Automatizovaný frontendový test chybí, Playwright by byl nová závislost.

**Zbývá (další kroky plánu):**
- Ostatní `innerHTML` s neescapovanými názvy souborů a zpráv (F3, F6) a `onclick` s interpolovanými hodnotami mimo citace (F2) řeší krok 1.6.
- `marked` a Tailwind z CDN jsou stále bez verze a bez SRI. Řeší je krok 1.8.
- Při testu bez přihlášení hlásí konzole `TypeError … reading 'forEach'` v `loadProjects` (`app.js:1205`), protože stránka čte odpověď 401 jako seznam projektů. Chyba existovala už dřív, je zapsaná a neopravená.

## 1.5 ⚠ Bezpečný tiskový náhled (nálezy S4, S5)

Commit: `ed02958` – `fix(security): Sanitize print preview HTML and harden print jobs`

**Zabezpečeno:**
- Nový `core/html_sanitizer.py`: allowlist sanitizer postavený jen na standardní knihovně (`html.parser`), **bez nové závislosti**.
  - Vypisuje jen povolené tagy a atributy. Pokrývá výstup marked, citační odznaky a KaTeX (HTML, MathML i SVG).
  - Text i hodnoty atributů znovu escapuje.
  - Obsah `script`, `style`, `iframe`, `form` a dalších nebezpečných elementů zahodí celý.
  - URL povoluje jen relativní nebo `http(s)`, `mailto` a `tel`. Kontrola probíhá po dekódování entit a odstranění řídicích znaků. Obrázky smí mít navíc `data:image/png|jpeg|gif|webp`.
  - Zahodí `style`, který obsahuje `url(` nebo `expression(`, a také `id` a `name` (ochrana proti DOM clobberingu).
  - Výstup má vyvážené tagy, takže obsah nemůže uniknout z `<article>` šablony.
- `routers/print.py`:
  - HTML se sanitizuje už při `/api/print/prepare`.
  - Limit 10 MB na dokument (jinak 413) a nejvýš 200 úloh v paměti (nejstarší se zahodí).
  - `webbrowser.open` se spustí jen pro požadavek z loopbacku bez `X-Forwarded-For`, tedy jen z lokální desktopové aplikace.
  - `/print_preview/{id}` posílá CSP `default-src 'none'`. `script-src` povoluje jen hash vlastního auto-print skriptu a obou `onclick` tlačítek šablony.

**Odchylka od schváleného plánu (schválena uživatelem po kroku 1.5):** bod „zakázat viewerům tisk“ jsem **neprovedl**. Middleware tisk pozorovatelům povoluje záměrně (`main.py`), protože jde o čtecí funkci. Se sanitizací na serveru a CSP už k zákazu není bezpečnostní důvod. Pokud ho chceš i tak, je to jednořádková změna v middleware.

**Změna chování (záměrná):** z tiskového HTML mizí skripty, event handlery (včetně `onclick` citací, které na tiskové stránce stejně nefungovaly), `id`, nepovolené tagy (jejich text zůstává) a nebezpečné URL.

**Testy:** nový `tests/test_print.py` (11 testů).
- Před změnou prošly charakterizace: struktura běžného obsahu, tisk viewerem, 404 a otevření prohlížeče z localhostu. Selhaly bezpečnostní testy: 17 škodlivých vzorků, CSP, vzdálené otevření prohlížeče, limity a citace s `onclick`.
- Po změně prochází vše, včetně jednotkových testů okrajových případů sanitizeru.

**Ověření v prohlížeči (dočasný server, jednorázový testovací admin):**
- Skutečný výstup rendereru aplikace (KaTeX, citace, tabulka, checkboxy) má po serverové sanitizaci **identický DOM** jako odeslaný obsah.
- CSP povoluje všechny vlastní skripty šablony (ověřeno hashem v prohlížeči). Auto-print se spustil a otevřel tiskový dialog.

**Ověření vůči baseline:** 54/54 testů OK, `ruff check` beze změny (2× UP038), F401 131, `ruff format` OK, seznam OpenAPI cest identický.

**Zjištěné chyby (zapsáno, neopraveno):**
- Tisková šablona nenačítá KaTeX CSS, takže se vzorce v náhledu tisknou dvakrát (MathML i HTML) a odmocniny mají rozbitou čáru. Chyba existovala už dřív, sanitizace na ní nic nemění (DOM je identický).
- `/print_preview/{id}` neověřuje, kdo úlohu vytvořil. Kdokoli přihlášený se znalostí 10hex ID ji může zobrazit. S ohledem na sanitizaci jde o nízké riziko, zapsáno pro další kolo.

## 1.6 ⚠ Escapování inline handlerů a vykreslovaných hodnot (nálezy F2, F3, F6)

Commit: `527bec2` – `fix(security): Escape interpolated values in inline handlers and HTML`

**Odchylka od plánu (schválena uživatelem po kroku 1.6):** plán počítal s přepisem inline handlerů na `data-*` a delegované listenery. Zvolil jsem **escapování podle kontextu** se stejným bezpečnostním účinkem:
- pro JS řetězec v `on*="…('…')"` slouží `escapeJsStringAttr` (nejdřív JS, pak HTML escapování),
- pro atributy a text slouží `escapeHtml`.

Důvod: pro běžné hodnoty se výstup nemění a nemusí se sahat na logiku událostí (`this.value`, `this.checked`, `stopPropagation`), na kterou neexistují testy. Přechod na delegované listenery zůstává vhodný pro kroky 3.5/4.8 (rozdělení `app.js`, frontendové helpery).

**Zabezpečeno (`static/js/app.js`):**
- 54 interpolací v inline handlerech převedeno na `escapeJsStringAttr(...)`. Přitom zmizely nefunkční `escapeQuotes(...)` a `escapeHtml(...)` použité v JS kontextu. Jde o projekty, ID otázek, ID chat vláken, názvy souborů poznámek, sad, testů, audia a podkladů, kategorie testů, ID odpovědí, zdroje kartiček a uživatelská jména.
- Medulingo citace (`handleCitationClick`) používají `escapeJsStringAttr` místo `replace(/'/g, …)`.
- 44 HTML sinků dostalo `escapeHtml`:
  - otázky (název, téma, číslo, známka, datum) v plánovači, kalendáři a tabulkách,
  - názvy poznámek, sad, testů a audia,
  - zdroje v chatu a v poznámkách, kartičky (`cleanFront`/`cleanBack`: dekódování entit a pak escapování),
  - kapitoly lekce (`ch.seconds` vynuceno jako číslo),
  - chybové zprávy `e.message`/`data.detail` v `innerHTML`,
  - `id` vláken a zdrojů a `href` audia.
- `safeNameAttr` a `safeTitle` (vlastní neúplné escapování) nahrazeny `escapeHtml`.
- `index.html`: cache-busting `app.js?v=2.6`.

**Zabezpečeno (backend):** `services/auth_service.py` přidává `validate_new_username`. Nové registrace i prvotní admin smí mít v uživatelském jménu jen písmena (vč. diakritiky), číslice a `_ . - @`, délka 3–64 znaků. Stávající účty se nekontrolují a přihlášení funguje beze změny. Tím se zavírá řetězec „neautentizovaná registrace → XSS v admin panelu“.

**Ověření před/po (prohlížeč):** dva dočasné servery, `HEAD` (před 1.6) a pracovní strom. Oba dostaly stejná data přes `tests/frontend/seed_xss_data.py` s běžnými i škodlivými hodnotami. Harness `tests/frontend/handlers_check.js` zaznamenal všechna přiřazení `innerHTML`, nahradil 42 cílových handlerů záznamníky a klikl na 58 prvků.
- **Před:** `window.__xss` se spustil. Škodlivé ID vlákna rozbilo `onclick` (handler dostal `thread_x`), handlery škodlivých souborů se nezavolaly vůbec.
- **Po:** `window.__xss` se nespustil. Všechny handlery dostaly přesné původní hodnoty, včetně škodlivých. Běžná volání (`doc_ok.txt`, `q1`, `thread_ok1`, `kardio.pdf`, data kalendáře) jsou identická.
- **Rozdíly v HTML u běžných dat:** jen `&` → `&amp;` (stejné vykreslení). Čtyři navíc přiřazení `innerHTML` pochází z `decodeHtmlEntities` (textarea, obsah se neparsuje jako HTML).

**Testy:** nový `tests/test_auth_validation.py` (4 testy). Před změnou selhaly 2 testy se 7 selháními (5 neplatných jmen a admin), po změně prochází vše.

**Oprava testovací infrastruktury:** `AuthService(...)` přepisuje globální singleton `AuthService._instance`. Nový test i stávající `test_services.test_auth_service_toggle_user_active` ho teď po sobě obnovují. Bez toho by test spuštěný před autorizačními testy rozbil 73 dalších testů. Dosud se to neprojevilo jen díky abecednímu pořadí souborů.

**Ověření vůči baseline:** 58/58 testů OK, `ruff check` beze změny (2× UP038), F401 131, `ruff format` OK, seznam OpenAPI cest identický, `node --check` OK.

**Zbývá:**
- V `app.js` je dál 219× `innerHTML`. Prošel jsem místa s daty od jiných uživatelů, z AI a z importu, která uvádí audit. Hodnoty z `t()` (překlady) a čísla jsem nechal beze změny.
- Funkce `t()` interpoluje parametry bez escapování (F7 z auditu, podezření). Ty jsou dnes převážně čísla a data, nezměněno.
- Funkce `escapeQuotes` po kroku už nemá žádné volání. Smaže se v kroku 4.6 (mrtvý kód), aby tento krok zůstal čistě bezpečnostní.

## 1.7 ⚠ Limity importu a uploadu, path traversal v úložišti testů (nálezy S6b–d, S7, S15)

Commit: `fa9894a` – `fix(security): Limit and validate project imports and uploads`

**Zabezpečeno:**
- Nový `core/uploads.py`:
  - `copy_with_limit` kopíruje proud po 1 MB. Při překročení limitu smaže rozepsaný soubor a vrátí 413.
  - `validate_import_archive` kontroluje počet položek, celkovou nekomprimovanou velikost a podezřelý poměr komprese (> 200 : 1 u položek ≥ 10 MB, zip bomb).
  - `is_within` ověřuje umístění po celých složkách.
- Výchozí limity jdou změnit proměnnými prostředí (v MB):

  | Limit | Proměnná | Výchozí |
  |---|---|---|
  | Upload jednoho souboru | `AIMEDSTUDIO_MAX_UPLOAD_MB` | 200 MB |
  | Balíček importu (komprimovaný) | `AIMEDSTUDIO_MAX_IMPORT_MB` | 2048 MB |
  | Balíček importu (rozbalený) | `AIMEDSTUDIO_MAX_IMPORT_UNCOMPRESSED_MB` | 4096 MB |
  | Počet položek v archivu | – | 20 000 |

  Proměnné doplní krok 1.11 do `.env.example`.
- `routers/projects.py`, import a inspect `.medproj`:
  - Archiv se nahrává s limitem a ověří se dřív, než se cokoli smaže nebo vytvoří.
  - Do `uploads/` se rozbalí jen `.pdf/.docx/.pptx/.txt` a `exam_planner.json`, ostatní se přeskočí a zaloguje.
  - Kontrola cílové cesty je `is_within` místo `startswith` bez oddělovače. Dřív šlo přes `uploads/../{projekt}2/…` zapsat do sousedního projektu (ověřeno testem před změnou).
  - Výstupy: poznámky jen `.md`, kartičky a testy jen `.json`, audio jen `.mp3/.mp4/.srt`. Název prochází `safe_filename` a cesta `safe_join`.
  - Zdrojové soubory se nepřejmenovávají, protože na jejich názvy odkazují importované vektory v ChromaDB.
- `routers/files.py`, upload: nejdřív se zkontrolují velikosti všech souborů v dávce, aby se při 413 neuložila jen část. Pak se kopíruje s limitem.
- `services/test_service.py`: `TestStorageManager._file_path` používá `safe_join`. Dřív `os.path.join` připouštěl `../` a absolutní cesty.

**Změna chování (záměrná):**
- Příliš velký upload nebo balíček vrátí 413, zip bomb vrátí 400.
- Import přeskočí soubory nepovolených typů (např. `.DS_Store`, `.html`, `.svg`).
- Výstupy s neobvyklými znaky v názvu se uloží pod sanitizovaným názvem. Názvy, které aplikace sama generuje, se nemění (ověřeno round-trip testem).
- Úložiště testů vrátí 400 pro cestu mimo svou složku.

**Testy:** nový `tests/test_import_upload.py` (12 testů).
- Před změnou prošly charakterizační testy: round-trip export → import s planner, poznámkou, sadou, testem a audiem, běžný upload a běžné použití úložiště testů.
- Před změnou selhalo všech 8 bezpečnostních testů: allowlist, únik do sousedního projektu, názvy výstupů, zip bomb, počet položek, velikost balíčku i inspect, velikost uploadu a traversal v úložišti testů.
- Po změně prochází vše, včetně nového testu na dávku s jedním příliš velkým souborem.

**Ověření vůči baseline:** 70/70 testů OK, `ruff check` beze změny (2× UP038), F401 130, `ruff format` OK, seznam OpenAPI cest identický.

**Zjištěné chyby (zapsáno, neopraveno):**
- Upload vytvoří složku projektu (`os.makedirs`) ještě před kontrolou souborů, takže při odmítnutí může zůstat prázdná složka nového projektu. Chyba existovala už dřív.
- Import dál načítá `chroma_vectors.json` a `database.json` celé do paměti. Strop teď dává jen limit rozbalené velikosti archivu.

## 1.8 ⚠ Pinnuté externí knihovny, SRI a CSP hlavička (nález F5)

Commit: `5858b6a` – `fix(security): Pin CDN assets with SRI and add Content-Security-Policy`

**Zabezpečeno:**
- `static/index.html`: všechny externí knihovny mají přesnou verzi a kde to jde, SRI (`sha384`) s `crossorigin="anonymous"`. Hash jsem pro každý soubor spočítal ze dvou nezávislých stažení.

  | Knihovna | Verze | SRI |
  |---|---|---|
  | `marked` | 15.0.12 | ano |
  | DOMPurify | 3.4.16 | ano (už z kroku 1.4) |
  | KaTeX CSS, JS a auto-render | 0.16.11 | ano |
  | Tailwind Play CDN | 3.4.17 | **ne** (viz níže) |

  Pinnuté verze jsou bajtově shodné s tím, co se dosud servírovalo bez verze, takže se chování nemění. Npm už má `marked` 18.1.1, ale upgrade je samostatné rozhodnutí.
- **Výjimka Tailwind:** `cdn.tailwindcss.com` neposílá CORS hlavičky. S `crossorigin` + `integrity` prohlížeč Tailwind nenačetl a aplikace byla bez stylů (zachyceno v prohlížeči). Tailwind má proto jen pinnutou verzi. Skutečné řešení je build Tailwindu nebo self-hosting souboru, což je změna závislostí a vyžaduje souhlas.
- `core/security.py` + `main.py`: middleware přidává `Content-Security-Policy` ke **HTML odpovědím** bez vlastní CSP:
  - `default-src 'self'`,
  - skripty jen z `'self'` a tří uvedených CDN,
  - `connect-src 'self'`,
  - `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'self'`,
  - obrázky `https:`/`data:`/`blob:`, média a iframy `'self'`/`blob:`.
- Tiskový náhled si nechává svou přísnější CSP z kroku 1.5. Soubory (PDF apod.) a JSON hlavičku nedostávají, aby se nerozbil vestavěný prohlížeč PDF.

**Omezení:** `script-src` musí obsahovat `'unsafe-inline'` kvůli ~480 inline handlerům (`onclick=…`). CSP proto nebrání vloženému inline skriptu. Omezuje hlavně původ externích skriptů, pluginy, `<base>`, cíle formulářů a vkládání do cizích rámců. Plná ochrana vyžaduje přechod na delegované listenery (kroky 3.5/4.8).

**Ověření v prohlížeči (dočasný server s testovacími daty):**
- Všechny knihovny se načetly. SRI prošlo u čtyř souborů, fonty KaTeX se načetly z jsdelivr.
- Vzorce se vykreslují. Fungují iframe s PDF, audio, SSE stream `/api/logs`, stažení přes blob a data obrázky.
- Přepnutí sekce přes inline `onclick` funguje.
- Událost `securitypolicyviolation` se nevyskytla ani jednou.

**Testy:** nový `tests/test_security_headers.py` (4 testy).
- Před změnou prošly charakterizační testy: tiskový náhled má vlastní CSP, `/health` a PDF hlavičku nemají.
- Před změnou selhaly: CSP na indexu a pinnutí/SRI u 5 externích zdrojů.
- Po změně prochází vše.

**Ověření vůči baseline:** 74/74 testů OK, `ruff check` beze změny (2× UP038), F401 130, `ruff format` OK, seznam OpenAPI cest identický.

**Neověřeno:** desktopová aplikace (pywebview). CSP se na ni vztahuje stejně, protože načítá stránku z lokálního serveru, ale v pywebview jsem ji nespouštěl.

## 1.9 ⚠ Omezení pokusů o přihlášení, atomický setup admina, důvěryhodné proxy (nálezy S8, S9, S10)

Commit: `10e6448` – `fix(security): Rate-limit logins, make admin setup atomic, restrict trusted proxies`

**Zabezpečeno:**
- Nový `core/rate_limit.py`: počítá neúspěšné pokusy v paměti, bez závislostí, v klouzavém okně 15 minut. Limity jsou 10 neúspěchů na dvojici IP + uživatel a 30 na IP. Blokace jen podle uživatelského jména záměrně chybí, aby útočník nemohl zamknout cizí účet z jiné adresy.
- `routers/auth.py`, `/api/auth/login`:
  - Při překročení limitu vrací `429` s `Retry-After`, a to i pro správné heslo.
  - Neúspěch se zapíše oběma čítačům.
  - Úspěch vynuluje čítač IP + uživatel.
- `main.py`, legacy Basic Auth (`APP_PASSWORD`): stejné omezení, 30 neúspěchů na IP.
- `services/auth_service.py`, `create_initial_admin`: kontrola „žádný uživatel“ a vložení admina proběhnou v jedné transakci `BEGIN IMMEDIATE`. Souběžné požadavky na `/api/auth/setup` už nevytvoří víc adminů.
- `Dockerfile`: odstraněno `--forwarded-allow-ips=*`. Nově `ENV FORWARDED_ALLOW_IPS=172.16.0.0/12`, tedy výchozí Docker sítě (NPM na `proxy_net`, cloudflared). Klienti z LAN už nemohou podvrhnout `X-Forwarded-For` a obejít tím omezení podle IP.
- `docker-compose.yml`: `FORWARDED_ALLOW_IPS` a adresa publikovaného portu `MEDSTUDIO_BIND_ADDRESS` jsou nastavitelné.

**Rozhodnutí uživatele (odchylka od plánu):** port `8000` zůstává ve výchozím stavu publikovaný na všech rozhraních (`0.0.0.0`), protože DOCKER_GUIDE a CLOUDFLARE_GUIDE počítají s přístupem z LAN, iPadu a Tailscale. `MEDSTUDIO_BIND_ADDRESS=127.0.0.1` (např. v `.env` vedle compose) ho omezí jen na server. Healthchecky v `deploy.sh`/`update.sh` běží přes `localhost` na Pi, takže fungují v obou variantách.

**Změna chování (záměrná):**
- Po 10 neúspěšných přihlášeních k jednomu účtu z jedné IP, nebo po 30 neúspěších z jedné IP, je přihlášení na 15 minut zablokováno (429).
- Za proxy mimo `172.16.0.0/12` uvicorn hlavičky `X-Forwarded-*` ignoruje. Pokud by proxy běžela v jiném rozsahu, je nutné nastavit `FORWARDED_ALLOW_IPS`.

**Testy:** nový `tests/test_auth_hardening.py` (9 testů).
- Před změnou prošly charakterizační testy: úspěšné a neúspěšné přihlášení, vynulování po úspěchu, odmítnutí druhého setupu.
- Před změnou selhaly: blokace IP + uživatel, blokace IP, vypršení okna, Basic Auth a atomický setup.
- Skutečný souběhový test (4 vlákna přes `Barrier`) s původním kódem 3× ze 3 vytvořil víc adminů, po změně vždy jen jednoho.
- Po změně prochází vše.

**Ověření vůči baseline:** 83/83 testů OK, `ruff check` beze změny (2× UP038), F401 130, `ruff format` OK, seznam OpenAPI cest identický. `docker compose config` je validní, výchozí port se rozbalí na `0.0.0.0`, s proměnnou na `127.0.0.1`. Ověřeno, že uvicorn 0.51 přijímá CIDR (`172.18.0.5` je důvěryhodná, `192.168.1.50` a `127.0.0.1` ne).

**Neověřeno:** sestavení Docker image (Docker daemon na tomto stroji neběží) a nasazení na Pi.

**Poznámky:**
- Limity jsou v paměti procesu. Po restartu se vynulují a nesdílí se mezi více workery. Aplikace dnes běží jako jeden proces uvicornu.
- Za zablokovaný pokus se počítá i správné heslo k účtu čekajícímu na schválení nebo zablokovanému účtu, protože `authenticate` vrací neúspěch.

## 1.10 ⚠ Allowlist modelů při sdílených klíčích, limit systémového promptu (nález S11)

Commit: `ef65f74` – `fix(security): Restrict model choice on shared API keys`

**Odchylka od plánu (schválena uživatelem po kroku 1.10):** plán zněl „allowlist `gemini_model` z konfigurace; `custom_system_prompt` jen pro admina, nebo ho jen připojovat“. Upravil jsem to podle zjištění v kódu:
- **Allowlist platí jen pro ne-adminy v režimu sdílených API klíčů.** Frontend má pole pro vlastní název modelu (`*ModelCustomInput`). Uživatel s vlastním klíčem (per-user BYOK) si model platí sám a funkce mu zůstává. Admin může zadat cokoli. Výchozí allowlist obsahuje přesně modely nabízené v UI (`gemini-3.6-flash`, `gemini-3.5-flash`, `gemini-3.8-flash`, `gemini-flash-latest`, `gemini-pro-latest`), takže výběr z menu funguje beze změny.
- **Vlastní systémový prompt zůstává, jen má limit 20 000 znaků.** Medulingo chat si systémový prompt skládá ve frontendu (`app.js`, funkce chatu Medulinga) a posílá ho jako `system_prompt`. Omezení na admina by Medulingo chat běžným uživatelům rozbilo a připojování by změnilo chování modelu. Nákladové riziko pokrývá allowlist modelů a „obejít grounding“ jde i obyčejným dotazem.

**Zabezpečeno:**
- `core/config.py`: `DEFAULT_GEMINI_MODEL`, `ALLOWED_GEMINI_MODELS` (lze přepsat proměnnou `AIMEDSTUDIO_ALLOWED_MODELS`, čárkami oddělený seznam) a `MAX_CUSTOM_SYSTEM_PROMPT_CHARS`.
- `core/clients.py`: `require_allowed_model(model)` vrací 400 s výčtem povolených modelů, pokud se platí sdíleným klíčem, uživatel není admin a model není v allowlistu.
- Kontrola je na všech 12 místech, kde klient volí model, a vždy před plánováním dávky nebo voláním AI. Jde o poznámky, kartičky, scénář podcastu, testy (2×), Medulingo pack, AI klasifikaci otázek, dávky (3×), chat a výukovou lekci.
- Chat (`/api/chat/completions`): `system_prompt` delší než limit vrací 400.

**Změna chování (záměrná):** v režimu sdílených klíčů běžný uživatel s vlastním modelem mimo allowlist dostane 400. Výběr z menu, admin a režim vlastních klíčů jsou beze změny.

**Testy:** nový `tests/test_model_policy.py` (5 testů, 10 endpointů).
- Před změnou prošly charakterizační testy: modely z UI pro uživatele, vlastní model pro admina a vlastní model s vlastním klíčem.
- Před změnou selhaly: zamítnutí vlastního modelu na všech 10 endpointech a limit systémového promptu.
- Po změně prochází vše.

**Ověření vůči baseline:** 88/88 testů OK, `ruff check` beze změny (2× UP038), F401 130, `ruff format` OK, seznam OpenAPI cest identický.

**Mimo rozsah:** endpoint `/api/settings/test-key` dál přijímá libovolný model (10 tokenů, jen test klíče). Vlastní šablony promptů u poznámek, kartiček a testů (`prompt`) zůstávají bez limitu. Jde o funkci aplikace, ne o tento nález.

## 1.11 Úplné `.env.example` (nález S16)

Commit: `832ece3` – `docs(config): Document all environment variables in .env.example`

- `.env.example` dokumentuje všech 14 proměnných, které čte aplikace (`core/`, `services/`, `routers/`, `main.py`, `desktop_app.py`) nebo `docker-compose.yml`. Jsou rozdělené do sekcí API klíče, server, limity, Docker/proxy a desktop.
- Aktivní (nezakomentované) zůstávají jen tři API klíče jako dosud, ostatní jsou zakomentované s výchozí hodnotou. Zkopírování `.env.example` do `.env` se tedy chová stejně jako dřív (ověřeno přes `dotenv_values`).
- Přidal jsem poznámku, že v Dockeru se do kontejneru dostanou jen proměnné z `environment` v compose, kdežto `.env` slouží compose pro dosazení `${...}`.
- Nový `tests/test_env_example.py` (2 testy) hledá v kódu `os.getenv`, `os.environ` a `_env_mb`, včetně víceřádkových volání, a `${…}` v compose. Ověří, že každá nalezená proměnná je v `.env.example`. Před změnou chybělo 11 proměnných.

**Ověření vůči baseline:** 90/90 testů OK, `ruff check` beze změny (2× UP038), `ruff format` OK. `docker compose --env-file .env.example config` je validní. Kód aplikace se nezměnil.

---

## Souhrn fáze 1 (bezpečnost) – kroky 1.1–1.11

| Krok | Commit | Nálezy |
|---|---|---|
| 1.1 autorizace projektů | `310d6b1` | S1, S6a |
| 1.2 statické soubory | `59ac8d8` | S2 |
| 1.3 izolace `/api/logs` | `01fd81a` | S3 |
| 1.4 DOMPurify pro markdown | `404b279` | F1, F4 |
| 1.5 tiskový náhled | `ed02958` | S4, S5 |
| 1.6 escapování handlerů a HTML | `527bec2` | F2, F3, F6 |
| 1.7 import/upload limity | `fa9894a` | S6b–d, S7, S15 |
| 1.8 SRI + CSP | `5858b6a` | F5 |
| 1.9 rate limit, setup, proxy | `10e6448` | S8, S9, S10 |
| 1.10 allowlist modelů | `ef65f74` | S11 |
| 1.11 `.env.example` | `832ece3` | S16 |

Testy: 18 → 90. Lint: beze změny proti baseline (2× UP038), F401 132 → 130. Seznam OpenAPI cest beze změny po celou fázi.

**Schválené odchylky od plánu:**
- 1.5: viewer smí tisknout.
- 1.6: escapování místo přepisu na `data-*`.
- 1.9: port zůstává na LAN, adresa je nastavitelná.
- 1.10: allowlist jen při sdílených klíčích, systémový prompt s limitem.

**Otevřené body z fáze 1 (zapsané u kroků):**
- Lekce bez vlastníka.
- Import nenastaví vlastníka projektu.
- Tailwind bez SRI (CDN bez CORS).
- `'unsafe-inline'` v CSP.
- `t()` bez escapování.
- KaTeX CSS chybí v tiskové šabloně.
- Hardcoded `localhost:8000` v odkazech kartiček.
- Prázdná složka po odmítnutém uploadu.
- Neověřený Docker build a desktop (pywebview).

---

# Fáze 2 – Charakterizační testy

## 2.1 Testovací infrastruktura: offline AI, embeddingy, blokace sítě

Commit: `135d320` – `test: Add offline AI test support and network guard`

Krok mění jen testy, kód aplikace beze změny.

- **`tests/support.py`** (nový):
  - `write_file`, `ensure_user`, `client_for_user`, `unique_name`: pomocníci přesunutí z `tests/test_project_authz.py`, kde zůstávají původní jména pro zpětnou kompatibilitu.
  - `FakeGeminiClient` napodobuje `google.genai.Client` v rozsahu, který aplikace používá:
    - `models.generate_content` vrací `.text` a `.candidates[0].finish_reason`,
    - `models.generate_content_stream` vrací chunky s `.text` a `.candidates[0].content.parts`,
    - odpovědi se berou z fronty nebo z funkce `responder`, výjimka simuluje chybu API,
    - všechna volání se zaznamenávají (`calls`, `system_instructions`, `prompt_text`).
  - `OfflineAITestCase`:
    - `install_fake_gemini()` nahradí klienta na všech čtyřech místech, kde si ho aplikace bere: `core.clients.get_gemini_client`, `services.ai_service.get_gemini_client`, `services.chat_service.get_ai_client` a `services.lesson_service.get_ai_client`.
    - Embeddingy ChromaDB (`DefaultEmbeddingFunction`) jsou po dobu testu deterministické, typu bag-of-words, bez ONNX modelu.
- **`tests/__init__.py`**: síťová pojistka. `socket.connect`, `connect_ex` a `getaddrinfo` mimo localhost/AF_UNIX vyhodí `NetworkAccessInTests`. Reaguje na incident z kroku 1.1, kdy testy omylem volaly skutečné API.
- **`tests/test_support.py`** (nový, 6 testů):
  - pojistka blokuje externí spojení a DNS, lokální spojení povolí,
  - fake Gemini přes `call_gemini_with_retries`: fronta odpovědí, chyba, responder,
  - charakterizace: k systémové instrukci se připojí česká jazyková direktiva,
  - offline RAG řetězec end-to-end: indexace `.txt` → `query_rag_context_with_sources` → `stream_grounded_chat` se streamovanou odpovědí z fake klienta a ověřením, že prompt obsahuje nalezený úryvek. Skutečný ONNX model je v testu zablokovaný, takže se prokazatelně nepoužije.

**Zjištění:**
- Výchozí embeddingová funkce ChromaDB potřebuje ONNX model `all-MiniLM-L6-v2` (~80 MB). Na tomto stroji je v `~/.cache/chroma` od července 2026, na čistém stroji (CI) by se stahoval z internetu. Testy na něm teď nezávisí.
- Telemetrie ChromaDB 1.5.9 (`Posthog.capture`) je no-op, takže žádný nález.

**Ověření vůči baseline:** 96/96 testů OK. Celá sada běží se zapnutou síťovou pojistkou bez jediného pokusu o síť. Původní testy z baseline (`test_api_integrity`, `test_security`, `test_services`) prochází (19 = 18 + 1 přidaný v kroku 1.1). `ruff check` beze změny (2× UP038), F401 130, `ruff format` OK.

## 2.2 Charakterizační testy CRUD endpointů

Commit: `90ed888` – `test: Add characterization tests for CRUD endpoints`

Krok mění jen testy, kód aplikace beze změny.

- Nový `tests/test_routers_crud.py` (13 testů). Očekávané hodnoty vycházejí ze sondy skutečných odpovědí na nezměněném kódu, ne z předpokladů.
  - **Projekty:** vytvoření se sanitizací názvu a vlastníkem, výpis. Přejmenování přesune složku, poznámky, kartičky, testy (vč. `project`/`filename` v JSON), audio, chat vlákna a plánovač. Okrajové případy přejmenování: beze změny, prázdné, existující, neexistující. Výběrové `clear-data` (chat, poznámky, otázky; ostatní zůstane, planner si nechá datum). Smazání s počty výstupů, odstraněním vláken a 404 při opakování.
  - **Soubory:** výpis jen povolených typů, `view` (obsah, content-type, disposition), `preview` (sekce, stránky) a smazání.
  - **Poznámky:** výpis s titulkem z METADATA a pořadím podle mtime, detail s/bez metadat, smazání.
  - **Kartičky:** výpis, detail s dořešenými zdroji, `export-all` (sloučení duplicitního líce, hlavička Anki TSV), smazání.
  - **Testy:** výpis, detail podle souboru i podle id, uložení výsledku, smazání. Audio: výpis a smazání. Statistiky a `export-info`.
  - **Plánovač a otázky:** výchozí plánovač, uložení (`revisionDays` "7" → 7), uložení otázek se zachováním ostatních polí.
  - **Chat vlákna:** vytvoření, zprávy se zdroji, výpis (`message_count`, `last_snippet`, `last_role`), fulltext `q`, detail, přejmenování, pin/unpin, export vlákna i projektu do Markdownu, smazání.
- **Mutační kontrola testů** (dočasné rozbití chování v paměti, bez změn na disku): rozbití přejmenování chat záznamů, pinu vláken, normalizace líce kartiček, názvu souboru plánovače, mazání a čištění chat historie i čtení METADATA poznámek testy zachytí, 8 z 8.
- **Postřeh pro fázi 3:** routery importují funkce služeb jménem a `projects.py`/`files.py` přes kořenový shim `chat_service`. Mock nebo patch tedy musí mířit na místo použití (např. `routers.chat_api.toggle_thread_pin`, `chat_service.clear_project_messages`). Platí to i pro rozdělení `chat_service` v kroku 3.1.

**Zjištěné chyby (zapsáno, neopraveno – charakterizační testy je zachycují, jak jsou):**
- **Smíšená časová pásma v chatu:** `chat_threads.created_at` se ukládá v místním čase (`datetime.now()`), `updated_at` a časy zpráv v UTC (`CURRENT_TIMESTAMP` SQLite). V Česku se tak liší o 1–2 hodiny.
- **Nekonzistentní výpis souborů:** `export-info` počítá všechny soubory složky projektu (včetně `.md`), kdežto `/api/files` jen povolené typy.
- **Dohledání testu podle id hledá podřetězec** v názvech souborů všech projektů a vrátí první shodu podle pořadí `os.listdir` (`TestStorageManager.get_test`). Krátké id (např. `t1`) může vrátit test jiného projektu. U cizího privátního projektu to po kroku 1.1 skončí 403.

**Ověření vůči baseline:** 109/109 testů OK ve dvou po sobě jdoucích bězích. `ruff check` beze změny (2× UP038), F401 130, `ruff format` OK.

## 2.3 Charakterizace čistých funkcí služeb (golden master)

Commit: `04eb7ba` – `test: Add golden-master characterization of service helpers`

Krok mění jen testy, kód aplikace beze změny.

- `tests/fixtures/service_cases.py`: sady vstupů a `compute_all()` pro 14 skupin funkcí:
  - 7 variant sanitizace a normalizace názvů na 16 vstupech (diakritika, traversal, emoji, uvozovky…),
  - obě mapy fallback modelů,
  - tři parsery výstupu AI (`clean_and_parse_json`, `parse_and_validate_test_json`, `extract_all_question_objects`) na 21 vzorcích. Vzorky pokrývají fence, text okolo, čárky navíc, useknutí a vnoření, u testových otázek i všechny tvary možností a správných odpovědí, typy `true_false`/`open_ended` a neznámý typ,
  - český FTS dotaz a stemmer, rozklad lístku na podotázky,
  - `chunk_text` a `chunk_sections_with_metadata` s výchozími i malými parametry,
  - `clean_leaked_thoughts`, kapitoly lekce, čištění skriptu pro TTS, opravy markdown tabulek, velikosti dávek testů, ikony kategorií.
- `tests/fixtures/services_golden.json`: zachycené výstupy (617+ řádků). Vygeneroval je `python -m tests.fixtures.generate_services_golden` na nezměněném kódu a generování je deterministické (dvakrát stejný výsledek). **Golden se mění jen záměrně**, např. když plán vědomě sjednotí chování (4.2, 4.4). Rozdíl v diffu golden souboru pak ukazuje přesnou změnu chování.
- `tests/test_services_characterization.py` (5 testů):
  - Explicitní testy rozdílů duplicitních implementací:
    - `sanitize_project_name` mění diakritiku na `_`, takže ID projektu v chatu, FTS a Chroma se liší od `uploads/`,
    - ořezávání okrajových `_` se v jednotlivých variantách liší,
    - `safe_filename` bere jen basename,
    - fallback mapy se liší pro neznámé modely a `gemini-2.5-pro`,
    - obecný parser JSON vyhazuje výjimku, testový vrací `[]`.
  - Porovnání všech skupin s golden souborem.
- **Mutační kontrola:** změna sanitizace, stemmeru (projeví se i na FTS dotazu), `chunk_text`, velikostí dávek, fallback mapy, čištění úvah a parseru JSON. Golden test zachytil 7 z 7.

**Zjištění (zapsáno, neopraveno):** neznámý typ testové otázky (např. `"open"` místo `"open_ended"`) se změní na `single_choice` a bez možností se tiše zahodí.

**Ověření vůči baseline:** 114/114 testů OK ve dvou bězích. `ruff check` beze změny (2× UP038), F401 130, `ruff format` OK.

## 2.4 Charakterizace opakování a záložního modelu Gemini

Commit: `285cfeb` – `test: Characterize Gemini retry and fallback behavior`

Krok mění jen testy, kód aplikace beze změny.

- Nový `tests/test_ai_resilience.py` (17 testů). `asyncio.sleep` nahrazuje záznamník, takže testy nečekají a zaznamenají plán čekání. Gemini nahrazuje `FakeGeminiClient` z kroku 2.1.
- **`call_gemini_with_retries` (`ai_service`):**
  - úspěch napoprvé, opakování po 503 s čekáním 8 a 16 s,
  - přepnutí na záložní model od 3. neúspěchu (čekání 4 s),
  - vyčerpání pokusů vyhodí `ValueError` se srozumitelnou hláškou a `(Detail: …)`. Fallback spotřebuje pokus, takže se čekání 30 s přeskočí: 8, 16, 4, 45, 60.
  - `enable_fallback=False`, neopakovatelná chyba se vyhodí hned,
  - `text=None` vrací `""`,
  - předání `temperature`/`max_output_tokens`/`response_mime_type`, jazyková direktiva podle `current_language_var`,
  - varianty `log_fn` (synchronní, padající) a výchozí logování do `send_log`.
- **Obě `call_gemini_with_resilience`** (`ai_service` – mrtvý kód, `lesson_service` – používaný):
  - vrací objekt odpovědi a konfiguraci předávají beze změny, bez jazykové direktivy,
  - plán čekání 6, 12, 4, 45, 60,
  - `report_fn(step, pct, zpráva)` s výchozím krokem `generating` vs. `generating_markdown`,
  - po vyčerpání znovu vyhodí **původní** výjimku, neopakovatelná chyba se vyhodí hned, `report_fn` je volitelné.
- **Rozdíly zdokumentované pro sloučení v kroku 4.2:**
  - neznámý model: `ai_service` přepne na `gemini-3.6-flash`, `lesson_service` nikdy nepřepne a čeká 6, 12, 25, 45, 60,
  - výsledek po vyčerpání pokusů: `retries` vyhodí přeložený `ValueError`, `resilience` původní výjimku,
  - jazykovou direktivu přidává jen `retries`.
- **Mutační kontrola:** detekce opakovatelné chyby, obě fallback mapy, srozumitelná hláška, jazyková direktiva a detail chyby. Zachyceno 6 z 6.

**Zjištěné chyby (zapsáno, neopraveno – testy je zachycují s komentářem „CHYBA“):**
- **`call_gemini_with_retries` může vrátit `None`.** Když přepnutí na záložní model padne na poslední pokus, `continue` ukončí smyčku a funkce skončí bez výjimky. S výchozími intervaly (6 pokusů, fallback na 3.) nenastává. S `wait_intervals` o 2 položkách ano. Žádný současný volající vlastní intervaly nepředává, chyba je tedy latentní. Stejná struktura je v obou `call_gemini_with_resilience`.
- **Duplicitní jazyková direktiva.** Když `system_instruction` začíná přímo direktivou (bez vlastního textu před ní), kontrola `lang_directive not in system_instruction` ji kvůli `.strip()` nenajde a doplní ji podruhé.

**Ověření vůči baseline:** 131/131 testů OK ve dvou bězích. `ruff check` beze změny (2× UP038), F401 130, `ruff format` OK.

---

## Souhrn fáze 2 (charakterizační testy) – kroky 2.1–2.4

| Krok | Commit | Obsah |
|---|---|---|
| 2.1 infrastruktura | `135d320` | fake Gemini, offline embeddingy, blokace sítě v testech |
| 2.2 CRUD endpointy | `90ed888` | 13 testů, mutace 8/8 |
| 2.3 čisté funkce služeb | `04eb7ba` | golden master 14 skupin, mutace 7/7 |
| 2.4 retry a fallback | `285cfeb` | 17 testů, mutace 6/6 |

Testy: 90 → 131, celá sada běží offline (síťová pojistka). Kód aplikace se ve fázi 2 neměnil. Nově zapsáno 6 chyb:
- smíšená časová pásma v chatu,
- nekonzistentní výpis souborů,
- hledání testu podřetězcem,
- tiše zahozený neznámý typ otázky,
- `None` z `call_gemini_with_retries`,
- duplicitní jazyková direktiva.

---

# Fáze 3 – Rozdělení god souborů

## 3.1 Rozdělení `services/chat_service.py` (1 641 ř.) do balíčku `services/chat/` (nález A1)

Commit: `7fd7022` – `refactor(chat): Split chat_service into services/chat package`

Čistý refaktoring, bez změny chování.

**Přesunuto:**

| Modul | Řádků | Obsah |
|---|---|---|
| `services/chat/storage.py` | 264 | datové cesty, `get_db_connection`, schéma + migrace (`init_db()` při importu), `get_chroma_client`, `get_gemini_api_key`, `get_ai_client`, `sanitize_project_name` |
| `services/chat/repository.py` | 677 | vlákna, zprávy, záznamy projektu (smazání, přejmenování, export/import SQLite, Markdown export), lekce |
| `services/chat/fts.py` | 283 | český stemmer, stop slova, FTS dotaz, indexace, mazání, synchronizace s ChromaDB |
| `services/chat/retrieval.py` | 171 | `retrieve_chat_context` (hybridní dense + BM25) |
| `services/chat/grounded_chat.py` | 272 | `clean_leaked_thoughts`, `stream_grounded_chat` |
| `services/chat_service.py` | 58 | **fasáda**, re-export všech veřejných jmen |

- **Odchylka od plánu:** přibyl pátý modul `storage.py`. Plán počítal se 4 moduly, ale infrastrukturu (DB, klienti, schéma) sdílí všechny, a v `repository` by vytvářela nesprávnou závislost `fts`/`retrieval` → `repository`. Graf závislostí je teď acyklický: `storage` ← `repository`/`fts` ← `retrieval` ← `grounded_chat`.
- Rozdělení provedl skript řezem přesně podle řádků z AST. **AST všech 48 funkcí, konstant a příkazů je identický s originálem.** Importy každého modulu jsou dopočítané z jmen, která blok skutečně používá (ruff: žádné F821/F401 v nových modulech).
- Fasáda nemá `__all__`, aby se star-import v kořenovém shimu `chat_service.py` (14 lokálních importů v routerech a službách, nález A7) choval stejně. Všechny importy `from services.chat_service import …` fungují beze změny.
- **Jediná nutná úprava kódu funkce:** záložní datová složka v `get_user_data_dir()`. Původně `dirname(__file__)` = `services/`, po přesunu by to bylo `services/chat/`. Upravil jsem ji na `dirname(dirname(__file__))`, takže dál vede do `services/` jako dosud (nález A8 zůstává otevřený).
- `tests/support.py`: cíl náhrady Gemini klienta pro chat je teď `services.chat.grounded_chat.get_ai_client`, tedy místo volání (viz postřeh u 2.2).

**Ověření:**
- 131/131 testů OK ve dvou bězích. Mezi nimi jsou charakterizace CRUD a chat vláken (2.2), golden master včetně `sanitize_project_name`, stemmeru a FTS dotazu (2.3) a offline RAG end-to-end s grounded chatem (2.1).
- Seznam OpenAPI cest je identický. `ruff check` beze změny (2× UP038), F401 130 → 127 (nepoužité importy původního modulu se nepřenesly), `ruff format` OK.
- Čistý interpret s 6 různými pořadími prvního importu (`services.chat_service`, shim `chat_service`, `services.chat.retrieval`, `rag_service`, `lesson_service`, `main`): pokaždé správná cesta k DB a fasáda vrací tytéž objekty jako implementace.

**Incident při ověřování:** kontrola záložní cesty běžela bez `AIMEDSTUDIO_DATA_DIR`, takže import `storage` přes `init_db()` vytvořil v pracovním stromu `services/chat_history.db` a prázdnou `services/chroma_db/`. Obojí jsem ověřil (jen prázdné schéma, 0 záznamů) a smazal. Tento vedlejší efekt importu existoval i před refaktoringem a je to přesně nález A8.

**Neověřeno:** PyInstaller build. Nový balíček `services.chat` by měla statická analýza najít přes importy fasády, ale `medstudio.spec` jsem nespouštěl.

## 3.2 Export/import projektu do `services/projects/transfer.py` (nález A3)

Commit: `057d593` – `refactor(projects): Move project export/import into services/projects`

Čistý refaktoring, bez změny chování.

**Nejdřív charakterizace:** nový `tests/test_project_transfer.py` (7 testů) prošel na původním kódu. Doplňuje round-trip a bezpečnostní testy z 1.7 o:
- obsah archivu a manifestu (statistiky, vektory s embeddingy, chat v `database.json`),
- přepínače exportu `include_audio`/`include_chat`/`include_outputs`/`include_progress` (reset průběhu v plánovači),
- `inspect` (navržený název `_2`, počty), neplatný soubor nebo ZIP (400), konflikt (409) a přepsání vlastního projektu,
- přenos vektorů ChromaDB, chat vláken a plánovače při importu kopie.

**Přesunuto** z `routers/projects.py` (1 021 → 554 ř.) do nového `services/projects/transfer.py` (579 ř.):
- `get_export_info`, `build_export_archive`, `inspect_archive`, `import_archive`,
- konstanty a pomocníci allowlistu importu, `max_import_bytes` (dříve `_max_import_bytes`), `cleanup_temp_file`.
- Bloky vyřízl skript podle řádků a jen je posunul v odsazení. **AST všech přesunutých těl i pomocníků je identický s originálem.** Jediná mechanická záměna je `chroma_client.X` → `get_chroma_client().X`, protože proxy `_ChromaClientProxy` v routeru dělala při každém přístupu totéž.
- V routeru zůstala HTTP vrstva: oprávnění a 404 u exportu, dočasný soubor, upload s limitem, kontrola a validace ZIP, `FileResponse` a logování a chyby exportu.
- `require_project_access` u importu zůstává uvnitř `import_archive`, protože cílový projekt vyplývá až z obsahu archivu. Pořadí kontrol se nezměnilo.
- Lokální importy přes kořenový shim `chat_service` jsou ponechané beze změny. Přesměruje je krok 4.5.
- V routeru zůstalo 5 nepoužitých importů, které tam byly už před krokem. Odstraní je krok 4.1, aby tento krok zůstal čistý.

**Ověření vůči baseline:** 138/138 testů OK ve dvou bězích, seznam OpenAPI cest identický. `ruff check` beze změny (2× UP038), F401 127 jako před krokem, `ruff format` OK.

**Zjištěná chyba – závažná (opravena v kroku 3.2a na pokyn uživatele):**
- **Import kopie projektu na stejný server poškodí původní projekt.** `import_project_sqlite_data` zachovává původní ID chat vláken a FTS chunků (`INSERT OR REPLACE INTO chat_threads (id, project_id, …)`, totéž u `project_chunks_meta`). Sondou ověřené dopady:
  - Vlákno se z původního projektu **přesune** do kopie. Původní projekt pak nemá žádné vlákno a jeho zpráva zůstane osiřelá. Kopie ukazuje ve vlákně zprávy obou projektů (`message_count` 2 místo 1).
  - Metadata FTS chunků původního projektu se přepíšou na kopii (`project_chunks_meta` původního projektu 1 → 0), což může zhoršit fulltextové vyhledávání v originálu.
  - Tento scénář aplikace sama nabízí: `inspect` navrhne název `{projekt}_2`.
- **Navrhuji opravit samostatným krokem** (mimo čistý refaktoring): při importu pod jiným názvem, než je v manifestu, generovat nová ID vláken a chunků a přemapovat na ně zprávy.

## 3.2a Oprava: import kopie projektu přebíral vlákna a FTS metadata originálu

Commit: `40bf6d2` – `fix(projects): Give copy imports their own thread and chunk IDs`

Samostatná oprava chyby z kroku 3.2 na pokyn uživatele. Není to refaktoring, chování se mění záměrně.

**Oprava:**
- `services/chat/repository.py`:
  - Nová funkce `imported_chunk_id(chunk_id, projekt)` vrací `"{projekt}::{chunk_id}"`.
  - `import_project_sqlite_data(..., new_ids=False)`: při `new_ids=True` dostanou vlákna nová ID (`generate_thread_id`) a zprávy se na ně přemapují. Chunky v `project_chunks_meta` i v `project_chunks_fts` dostanou ID z `imported_chunk_id`.
- `services/projects/transfer.py`: `import_archive` zapne `new_ids`, když se cílový název liší od názvu v balíčku (kopie, typicky na stejném serveru). Stejně přemapuje i ID vektorů při `upsert` do ChromaDB, takže hybridní vyhledávání (dense + FTS, párování přes ID) v kopii funguje.
- Import pod **stejným** názvem (jiný server, obnova po smazání, přepsání) ID zachovává, takže se chování nemění.
- `services/chat_service.py` (fasáda) re-exportuje `imported_chunk_id`.

**Testy** (`tests/test_project_transfer.py`):
- Test kopie už nečeká chybu: kopie má vlastní vlákno s jednou zprávou a originál si vlákno ponechá, s jiným ID.
- Nový test: import kopie metadata originálu **nezmění**. Chunky kopie mají předponu `{kopie}::`, ID v ChromaDB a v SQLite se shodují a RAG vyhledávání najde text v originálu i v kopii.
- Nový charakterizační test: import pod stejným názvem zachová ID vláken i chunků.
- Bez opravy (ověřeno přes `git stash`) selžou 2 ze 3 testů, s opravou prochází vše.

**Ověření:** 140/140 testů OK ve dvou bězích, seznam OpenAPI cest identický. `ruff check` beze změny (2× UP038), F401 127, `ruff format` OK.

**Nová související chyba (zapsáno, neopraveno, mimo rozsah zadání):**
- **Kolize metadat chunků mezi projekty se stejnojmenným souborem.** ID chunku `{soubor}_chunk_{i}` (`services/rag_service.py:197`) nezávisí na projektu a `project_chunks_meta.chunk_id` je globální primární klíč. `index_chunks_to_fts` při konfliktu (`ON CONFLICT(chunk_id) DO UPDATE SET source, page`) `project_id` nezmění, takže metadata patří **prvnímu** projektu, který daný název souboru zaindexoval. Druhý projekt má řádky FTS, ale žádná metadata. `sync_project_fts` pak pro něj chunky považuje za chybějící a při každé synchronizaci je maže a znovu vkládá do FTS.
- Přímý dopad na výsledky vyhledávání jsem nezjistil, protože FTS i dense hledání filtrují podle projektu. Jde o zbytečnou práci a nekonzistentní data.
- Správná oprava je primární klíč `(project_id, chunk_id)` s migrací tabulky. Navrhuji ji jako samostatný krok.

## 3.3 Rozdělení `services/test_service.py` (885 ř.) do balíčku `services/practice_tests/` (nález A4)

Commit: `b13f67c` – `refactor(tests): Split test_service into services/practice_tests package`

Čistý refaktoring, bez změny chování.

| Modul | Řádků | Obsah |
|---|---|---|
| `services/practice_tests/parsing.py` | 212 | `extract_all_question_objects`, `parse_and_validate_test_json` |
| `services/practice_tests/evaluation.py` | 91 | `normalize_text`, `evaluate_open_answer` |
| `services/practice_tests/storage.py` | 138 | `sanitize_name`, `TestStorageManager` |
| `services/practice_tests/generator.py` | 461 | `calculate_batch_sizes`, `generate_practice_test`, `generate_more_test_questions` |
| `services/test_service.py` | 23 | **fasáda**, re-export včetně `DEFAULT_TEST_PROMPT_SYSTEM` |

**Odchylky od plánu:**
- Balíček se jmenuje `practice_tests` místo `services/tests/`, aby se nepletl s testovací sadou `tests/`.
- Hodnocení otevřených odpovědí (`evaluation.py`) je samostatný čtvrtý modul. Plán počítal s parser/storage/generator, ale hodnocení nepatří ani do jednoho z nich.

Bloky rozřezal skript podle řádků, včetně komentářů nad definicemi. **AST všech 9 definic je identický s originálem.** Importy jsou dopočítané (ruff: žádné F821/F401). Zastaralý komentář `# Moved DEFAULT_TEST_PROMPT_SYSTEM to prompts.test` se nepřenesl.

**Ověření:** 140/140 testů OK ve dvou bězích, včetně golden masteru (parsery, normalizace, sanitizace a velikosti dávek přes fasádu) a CRUD testů úložiště testů. Seznam OpenAPI cest identický. `ruff check` beze změny (2× UP038), F401 127 → 123 (nepoužité `typing` importy původního modulu se nepřenesly), `ruff format` OK.

**Pokrytí:** `generate_practice_test` a `generate_more_test_questions` nemají vlastní charakterizační test. Zde stačí, že jsou AST-identické a všechna jména jsou definovaná (F821). Případný test generování s `FakeGeminiClient` patří do kroku 4.x (sloučení parserů JSON).

## 3.4 Společná kostra dávkového zpracování (nález A5)

Commit: `refactor(batch): Share one batch skeleton across podcast, notes and flashcards` (hash doplní další krok)

Čistý refaktoring, bez změny chování.

**Nejdřív charakterizace (golden master průběhu):**
- `tests/fixtures/batch_cases.py`: spouští každou dávkovou funkci routeru ve 3 režimech a 10 scénářích, celkem 28 průběhů. Scénáře:
  - úspěch,
  - selhání bez noční kontroly i s ní (doplnění se zdaří nebo ne),
  - zrušení během zpracování i během noční kontroly,
  - fatální chyba autorizace,
  - zrušení mezi scénářem a audiem podcastu,
  - chyba uvnitř dávky (`title=None`),
  - cizí `batch_id`.
- Zaznamenává se úplný průběh: všechny logy a dávkové události v pořadí (přes `core.logger.publish_event`), plán čekání, volání generátorů a úklid `active_batches`.
- `tests/fixtures/batch_golden.json` je vygenerovaný na původním kódu a deterministický. `tests/test_batch.py` (4 testy) ho porovnává a explicitně dokumentuje rozdíly mezi režimy:
  - chyba autorizace zastaví poznámky a kartičky, ne podcast,
  - zrušení mezi kroky podcastu označí otázku jako `question_failed` s chybou `"None"`,
  - úklid po chybě, cizí `batch_id` se ignoruje.

**Refaktoring:**
- Nový `services/batch.py` (202 ř.) obsahuje `run_question_batch`, tedy kostru: stav, 3 pokusy s čekáním 5/10 s, zrušení, dvě noční kola, události a bezpodmínečný úklid. Dále `BatchTexts` se šablonami všech logů režimu.
- `routers/batch.py` (634 → 272 ř.):
  - Tři `background_*` funkce mají stejné názvy a signatury. Dodají jen texty a `produce(batch, title, q_index)`: podcast má dva kroky a mezi nimi kontrolu zrušení (`False` = přerušeno), poznámky a kartičky jeden krok.
  - Fatální chybu autorizace řídí `stop_on_auth_error` (podcast `False`).
  - Zrušení uprostřed noční kontroly ukončí celé kolo stejně jako dřív (`break`, zbylé otázky se do `still_failed` nepřidají).
- Odstraněny jen importy, které přesun udělal nepotřebnými (`asyncio`, `send_batch_event`, `friendly_api_error`, `is_terminal_auth_error`). Nepoužité importy, které tam byly už dřív, zůstávají pro krok 4.1.

**Ověření:**
- Golden master prošel napoprvé: **všech 28 průběhů je identických**, tedy každý log, událost, čekání i volání.
- Mutační kontrola nové kostry: vypnutí detekce chyby autorizace, záměna textů režimu, změna jednoho textu noční kontroly a hlášky autorizace. Zachyceno 4 ze 4.
- 144/144 testů OK ve dvou bězích, seznam OpenAPI cest identický. `ruff check` beze změny (2× UP038), F401 123, `ruff format` OK.
