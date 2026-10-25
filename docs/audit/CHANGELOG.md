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

Commit: `fix(security): Sanitize print preview HTML and harden print jobs` (hash doplní další krok)

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

**Odchylka od schváleného plánu:** bod „zakázat viewerům tisk“ jsem **neprovedl**. Middleware tisk pozorovatelům povoluje záměrně (`main.py`), protože jde o čtecí funkci. Se sanitizací na serveru a CSP už k zákazu není bezpečnostní důvod. Pokud ho chceš i tak, je to jednořádková změna v middleware.

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
