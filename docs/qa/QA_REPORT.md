# AI MedStudio – QA report (funkční a UI audit)

Datum: 2026-10-25 · větev `refactor/cleanup` · audit proběhl na `cf89893`. Během auditu jiná session commit přepsala na `f960c03` (mění jen `desktop_app.py` a test). Závěrečný běh testů je z `f960c03`.
Prostředí: macOS, Python 3.14.7 (venv), ffmpeg 7 (Homebrew), Node 20, Playwright Chromium, vestavěný prohlížeč Claude.
Kód aplikace se neměnil. Vznikl jen tento soubor.

---

## 1. Shrnutí

**Celkový stav.**
- Opravy z fáze 1 auditu (IDOR, statické mounty, sanitizace markdownu, tisk, rate limit, allowlist modelů, limity uploadu) se dynamicky potvrdily jako účinné.
- Našel jsem ale **2 kritické a 11 vysokých nových nálezů**.
- Nejzávažnější: **ID projektu `..` není ošetřené.**
  - Běžný student jediným `DELETE /api/projects/%2E%2E` smaže celou datovou složku. Ve vývojovém režimu je to **kořen repozitáře se skutečnými daty**.
  - Kdokoli se čtecím přístupem (pozorovatel, při zapnutém režimu hosta i anonym) si přes `GET /api/projects/%2E%2E/export` stáhne `auth.db`. S tokeny relací z ní převezme účet admina.
- Funkčně nejvíc bolí:
  - projekty s diakritikou v názvu se **nikdy nezaindexují**, takže RAG, poznámky, kartičky, testy ani chat nemají podklady;
  - nefunkční upload a mazání v Prohlížeči souborů;
  - tiché selhání chatu.

| Závažnost | Počet | ID |
|---|---|---|
| Kritická | 2 | QA-001, QA-002 (obě opraveny) |
| Vysoká | 11 | QA-003 – QA-013 |
| Střední | 27 | QA-014 – QA-040 |
| Nízká | 16 | QA-041 – QA-056 |
| Kosmetická | 3 | QA-057 – QA-059 |

Ke každému nálezu je uveden typ ověření:
- **D** = dynamicky reprodukováno (API nebo prohlížeč);
- **S** = statická analýza s dohledanou celou cestou kódu, nespuštěno.

Statické nálezy pocházejí z mé revize a ze čtyř paralelních read-only revizí po modulech. Nejdůležitější z nich jsem ověřil dynamicky a ty jsou označené D.

**Baseline.**
- `venv/bin/python -m unittest discover -s tests -t .`:
  - na `cf89893`: 178 testů, **2 selhání** v `tests.test_isolation`. Příčinou byl nový `tests/test_desktop_app.py`, jehož `desktop_app.py` se nekopíroval do sandboxu testu;
  - na `f960c03` (přepsaný commit): **178 OK, 6 skipped**. Šlo o přechodný stav souběžné práce, ne o nález.
- `ruff check .`: čisté. `ruff format --check`: 101 souborů OK.
- Frontend smoke (`AIMEDSTUDIO_FRONTEND_SMOKE=1 venv/bin/python -m unittest tests.test_frontend_smoke`): **6/6 OK**.
  - Pokrývá `handlers_check.js` (existence funkcí z inline handlerů) a `render_check.js` (sanitizace markdownu, XSS fixtures ze `seed_xss_data.py`).

**Co nebylo možné ověřit a proč.**
- **Skutečné AI generování.** Gemini, OpenAI ani ElevenLabs jsem nevolal. Testovací klíč nebyl k dispozici a lokální `.env` obsahuje reálné klíče, proto server běžel s explicitně prázdnými proměnnými klíčů.
  - Všechny AI toky jsem otestoval do bodu odeslání požadavku a ošetření chybějícího klíče.
  - Kvalitu a strukturu výstupů (citace, typy otázek, série kartiček bez duplicit, odmítnutí halucinace, TTS, SRT/MP4, lekce, generate-pack) vedu jako ⏭️.
  - Hotové výstupy (poznámka, balíček kartiček, test, MP3 + SRT) jsem pro testy UI vložil jako neškodné fixture soubory do izolovaného adresáře.
- Retry dávek po selhání AI, noční sweep a souběh s reálným generováním: ⏭️, vyžaduje funkční AI (kostru pokrývá `tests/test_batch.py`).
- Výpadek sítě a chybějící ffmpeg: ⏭️. Ověřeno jen staticky (fallback na MP3 existuje).
- Filtrování `/api/logs` mezi uživateli: ⏭️ dynamicky. Pokrývá ho `tests/test_log_stream.py`.

**Bezpečnost dat.**
- Všechny servery běžely s `AIMEDSTUDIO_DATA_DIR` v `mktemp -d`.
- Před každým destruktivním testem jsem ověřil, že `GET /api/settings → user_data_dir` míří do dočasného adresáře. Destruktivní testy běžely na samostatné jednorázové instanci (port 8766).
- `auth.db`, `chat_history.db` a `user_config.json` v kořeni repa mají na konci **stejný mtime, velikost i SHA-1** jako na začátku:

| Soubor | mtime | Velikost | SHA-1 (začátek = konec) |
|---|---|---|---|
| `auth.db` | 1792964668 | 126 976 | `e8206cdd…3c82` |
| `chat_history.db` | 1792959029 | 41 021 440 | `c44982e8…2774` |
| `user_config.json` | 1792958737 | 454 | `c2f1b7da…75f` |

---

## 2. Matice pokrytí

Legenda: ✅ OK · ❌ chyba · ⚠️ podezřelé · ⏭️ neověřeno.

Úplný seznam 212 automatizovaných kontrol je v **příloze B**, inventura 91 API operací v **příloze A**.

### 2.0 Fáze 0–1: baseline a inventura
| Prvek | Scénář | Výsledek | Nález |
|---|---|---|---|
| Unit testy | doporučený příkaz, 178 testů | ✅ (na `f960c03`), dočasně ❌ na `cf89893` | – |
| Ruff lint a formát | | ✅ | – |
| Frontend smoke (Playwright) | načtení, handlery, sekce, markdown, modaly | ✅ 6/6 | – |
| `/health` izolovaného serveru | | ✅ | – |
| Inventura API | 91 operací / 79 cest + `/api/logs`, 4 mounty | ✅ příloha A | – |
| Inline handlery → globální funkce | 567 handlerů (468 onclick, 62 onchange, 26 oninput, 3 onsubmit …) | ✅ žádný chybějící | – |
| `getElementById` → existující `id` | 1 095 referencí, 808 id v HTML, 0 duplicitních id | ⚠️ 5 mrtvých (ošetřené `if`) | QA-056 |
| Překlady cs/en/fr | 1 426 klíčů na jazyk, plná parita | ✅ | – |
| Duplicitní klíče | `settings.statusActive`, `statusBlocked`, `qm.allTopics`, `qm.questionsCount` | ⚠️ známé F10 | – |
| Chybějící klíče | `common.active`, `general`, `readOnly`, `viewerReadOnly` | ⚠️ známé F10 | – |
| Nepoužité klíče | 229 bez statické reference (např. `chat.btnSend`, `files.colName`) | ⚠️ známé F9 (P) | – |

### 2.1 Autentizace a admin
| Prvek / endpoint | Scénář | Výsledek | Nález |
|---|---|---|---|
| `GET /api/auth/status` | čerstvá instance, přihlášený, host | ✅ | – |
| `POST /api/auth/setup` | validace jména, hesla a znaků, úspěch, druhý setup | ✅ | – |
| `POST /api/auth/setup` | registrace cizího účtu **před** setupem | ❌ instance zablokována | QA-007 |
| `POST /api/auth/setup` a `login` | token relace v těle odpovědi | ⚠️ | QA-043 |
| `POST /api/auth/login` | správné a chybné heslo, neexistující uživatel, pending, rejected, disabled | ✅ | – |
| Rate limit | 10× uživatel+IP → 429 + Retry-After, jiná IP projde, 30× IP | ✅ | – |
| Cookie | HttpOnly, SameSite=Lax, Max-Age 30 d / 1 d, neplatná cookie → 401, Bearer | ✅ | – |
| `POST /api/auth/logout` | token zneplatněn na serveru | ✅ | – |
| `POST /api/auth/register` | pending, duplicita (i jiná velikost písmen), vypnuté registrace | ✅ | – |
| Admin: approve / reject | role user/viewer, neexistující id, zamítnutý se nepřihlásí | ✅ | – |
| Admin: change-role | vlastní role, neplatná role, okamžitý dopad na relaci | ✅ | – |
| Admin: toggle-status | blokace zneplatní relace, odblokování, sám sebe | ✅ | – |
| Admin: toggle-status | u pending/rejected účtu → approved | ❌ | QA-042 |
| Admin: delete user | relace zneplatněna, sám sebe nesmaže | ✅ | – |
| Přepínače registrace / host / sdílené projekty / sdílené klíče | dopad na status a API; UI přepínač → API | ✅ | – |
| Toggle modely | řetězec `"false"` místo bool přijat (není strict) | ⚠️ | QA-053 |
| Přihlášení v UI | chybné heslo → hláška, úspěch → welcome modal | ✅ | – |
| UI před přihlášením | nezachycené `TypeError` v `loadProjects` | ⚠️ | QA-052 |

### 2.2 Projekty
| Prvek / endpoint | Scénář | Výsledek | Nález |
|---|---|---|---|
| `POST /api/projects` | prázdné jméno, číslo → 422, `../evil` sanitizováno | ✅ | – |
| `POST /api/projects` | jen mezery → projekt `""`, 300 znaků → 500, `lekce_*` a `.x` nejsou ve výpisu | ❌ | QA-041 |
| `POST /api/projects` | existující název = tiché 200, v privátním režimu převzetí cizího projektu | ❌ | QA-005 |
| `POST /api/projects` | název s diakritikou → indexace všech souborů selže | ❌ | QA-004 |
| rename | existující cíl, neexistující zdroj, stejný název, prázdný název | ✅ | – |
| rename / delete / clear-data / výpis / stats | prefixová kolize `kardio` × `kardio_2`, `ab` × `ab_cd`, `Interna` × `Interna_kopie` | ❌ ztráta a míchání dat | QA-006 |
| clear-data | každý příznak maže správnou kategorii, neexistující → 404 | ✅ | – |
| reindex | spuštění | ✅ | – |
| export-info, export | obsah `.medproj` (materiály, plánovač, výstupy, vektory) | ✅ | – |
| export | `project_id=..` / `.` (viewer, anonymní host) | ❌ | QA-002 |
| delete | `project_id=..` (student) | ❌ smazána datová složka | QA-001 |
| import/inspect | poškozený a prázdný soubor → 400, návrh `_2` při kolizi | ✅ | – |
| import/inspect | cizí ZIP bez manifestu přijat | ⚠️ | QA-048 |
| import | kolize → 409, kopie, zip-slip `../` blokován | ✅ | – |
| import | `project_name=..` + overwrite (student) | ❌ smazána datová složka | QA-001 |
| Privátní režim | B nevidí A, 403 na čtení, přejmenování a smazání cizího | ✅ | – |
| Privátní režim | `DELETE /api/lessons/<projekt A>` od B | ❌ | QA-003 |
| `modalNewProjectQuestionsOffer` | | ⏭️ ověřeno jen existencí a zavíráním (smoke) | – |

### 2.3 Domů / dashboard
| Prvek | Scénář | Výsledek | Nález |
|---|---|---|---|
| `/api/stats` | `files_count` a `questions_count` odpovídají | ✅ | – |
| `/api/stats` a karty v UI | poznámky, kartičky, testy počítají i projekt se stejným prefixem (2 místo 1) | ❌ | QA-006 |
| `/api/stats` | `lessons_count` globální, `media_count` mp3 + mp4 | ⚠️ S | QA-047 |
| Prázdný stav bez projektu | žádné JS chyby | ✅ | – |
| Upload z Domů | povolený soubor ✅, nepovolený bez jakékoli zpětné vazby | ❌ | QA-035 |
| Počet volání API | 6–8× `/api/stats` při přepnutí projektu | ⚠️ | QA-051 |

### 2.4 Materiály a prohlížeč
| Prvek / endpoint | Scénář | Výsledek | Nález |
|---|---|---|---|
| `POST /api/files/upload` | txt, pdf (textový i sken), docx, pptx, diakritika v názvu, HTML znaky, traversal v názvu i projektu, 201 MB → 413 | ✅ | – |
| `POST /api/files/upload` | `.exe` / `.png` → tiché 200 `[]`, prázdný soubor přijat | ⚠️ | QA-035 |
| `POST /api/files/upload` | `a b.txt` + `a_b.txt` → tiché přepsání | ❌ | QA-031 |
| `GET view` / `preview` | všech 5 typů, neexistující → 404, traversal → 404 | ✅ | – |
| Sken PDF | preview bez textu a log „neobsahuje strojově čitelný text“ | ✅ (OCR není) | – |
| Mount `/uploads` | admin 200, anonym 401, `../auth.db` 404 | ✅ | – |
| Prohlížeč souborů: upload | `uploadDocsFromViewer` → `POST /api/upload` → 405 | ❌ | QA-008 |
| Prohlížeč souborů: mazání | `deleteFileFromViewer` → `DELETE /api/files/{p}/{f}` → 405 | ❌ | QA-008 |
| Fulltext v dokumentu | počítadlo „1 z 1“ při 2 výskytech | ⚠️ | QA-049 |
| Fulltext v dokumentu | speciální znaky `a(b` bez chyby, case-insensitive | ✅ | – |
| Velikost písma | +2 → 18 px, štítek aktualizován | ✅ | – |
| Zoom PDF | 150 + 25 = 175 → select prázdný | ⚠️ | QA-049 |
| Přepnutí TXT → PDF | režim „text“ zůstane, nativní iframe ukazuje předchozí soubor | ❌ | QA-019 |
| Citace a duální prohlížeč | | ⏭️ vyžaduje AI výstup s citacemi | – |

### 2.5 Plánovač a správce otázek
| Prvek / endpoint | Scénář | Výsledek | Nález |
|---|---|---|---|
| `POST`/`GET questions` | uložení a načtení, tělo není objekt → 422, `questions` není seznam → 400 | ✅ | – |
| `POST planner` | uložení, perzistence, viewer → 403 | ✅ | – |
| Filtr dne v kalendáři | `TypeError: Assignment to constant variable`, změna se neuloží na server | ❌ | QA-016 |
| Řazení naučených na konec | | ✅ S (stabilní řazení, localStorage) | – |
| `upload-csv` | UTF-8 BOM, hlavička, uvozovky, duplicity; cp1250 → 500 | ❌ | QA-022 |
| Import v plánovači (soubor, text, jiný projekt) | | ⚠️ S: jen UTF-8, CSV parser | QA-022 |
| Uložit plán | úspěch hlášen i při chybě, dvojí POST | ⚠️ S | QA-024 |
| `revisionDays = 0` | uloží se jako 14 | ⚠️ S | QA-055 |
| AI klasifikace | bez otázek → 400; s otázkami | ⏭️ vyžaduje klíč | – |
| Badge počtu otázek | `{count} otázek` po přepnutí jazyka nebo záložky | ❌ | QA-014 |

### 2.6 Medulingo
| Prvek / endpoint | Scénář | Výsledek | Nález |
|---|---|---|---|
| `GET overview` | metriky, pacing | ✅ | – |
| streak | API: `1 if completed_today else 0`, UI `m.streak \|\| 1` | ❌ D/S | QA-018 |
| Přepnutí projektu | pohled dál ukazuje „Projekt: Interna“ | ❌ | QA-018 |
| `POST complete` | dokončení OK, neexistující id → `success` | ⚠️ | QA-046 |
| `GET question/{id}` | číselné id z API → `200 {"error"}` | ⚠️ | QA-046 |
| Cizí obsah přes substring | | ⚠️ S | QA-013 |
| generate-pack | bez klíče: chyby po modulech v těle 200 | ✅ | – |
| Dvojklik na generování | | ⚠️ S | QA-030 |
| Integrace Pomodora | | ✅ S | – |

### 2.7 Pomodoro
| Prvek | Scénář | Výsledek | Nález |
|---|---|---|---|
| Sekvence s přestávkami | W1→S, W2→S, W3→S, W4→Long, W1 | ✅ | – |
| „Začít další blok hned“ (bez přestávek) | cyklus stále 1, dlouhá pauza nikdy | ❌ | QA-017 |
| Mock `Date.now` (+8 h) | čas soustředění +28 800 s | ❌ | QA-017 |
| Start, pauza, reset, přeskočení, zvuk, mini-timer, reload | | ✅ S | – |
| Datum statistik | UTC místo lokálního, rollover jen při startu | ⚠️ S | QA-017 |
| Štítek „{count} bloků“ | surový placeholder | ❌ | QA-014 |

### 2.8 Podcast Studio
| Prvek | Scénář | Výsledek | Nález |
|---|---|---|---|
| `generate-script` | bez otázky → 400 | ✅ | – |
| `generate-audio` | bez TTS klíče → 500 s textem „400: …“ | ❌ | QA-021 |
| Výpis výstupů | fixture MP3 + SRT se zobrazí | ✅ | – |
| Přehrávač | play, délka 12 s, 3 titulky, klik na titulek → seek 4,16 s, aktivní titulek zvýrazněn | ✅ | – |
| Přehrávač | Esc nezavře, křížek bez přístupného názvu | ❌ | QA-038 |
| Vrácený název souboru ≠ uložený | | ⚠️ S | QA-032 |
| Skutečné TTS, SRT/MP4, ElevenLabs, výběr hlasu | | ⏭️ vyžaduje klíč | – |

### 2.9 Poznámky
| Prvek | Scénář | Výsledek | Nález |
|---|---|---|---|
| Výpis a otevření poznámky | render markdownu, KaTeX, citace `[1, s. 1]` | ✅ | – |
| Export do Markdownu | Blob `text/markdown`, název souboru | ✅ | – |
| Tisk | `/api/print/prepare` → náhled, sanitizace (`script`/`onerror`/`javascript:` odstraněny), vlastní CSP | ✅ | – |
| Tisk | vzorce 2× (chybí KaTeX CSS) | ❌ | QA-039 |
| Generování bez klíče | hláška OK, ale prefix „400:“ a podtitulek „Probíhá analýza…“ zůstane | ⚠️ | QA-050 |
| Titul ve výpisu | čte jen 1 024 B metadat | ⚠️ S | QA-030 |

### 2.10 Kartičky
| Prvek | Scénář | Výsledek | Nález |
|---|---|---|---|
| Výpis a otevření balíčku | | ✅ | – |
| Počet 1–3 u nové otázky | 500 „'NoneType' object is not a mapping“, loader visí | ❌ | QA-011 |
| Počet 0 / 10 000 | server ořízne na 1..500 | ✅ S | – |
| Export Anki (export-all) | zalomení v `hint` rozbije řádek TSV | ❌ | QA-023 |
| Přepnutí záložky | zobrazený balíček se přepíše na „Zvolte otázku…“ | ❌ | QA-014 |
| Viewer | tlačítko Generovat aktivní, po kliknutí 403 + visící loader | ❌ | QA-036 |
| Kolize prvních 40 znaků otázky | | ⚠️ S | QA-029 |
| 3D otočení, ←/→/mezerník, Quizlet, prompty | | ✅ S (Quizlet ⚠️ QA-056) | – |
| `/api/flashcards-prompts` | | ✅ | – |

### 2.11 Testy
| Prvek | Scénář | Výsledek | Nález |
|---|---|---|---|
| Výpis a načtení testu | | ✅ | – |
| Uložení výsledku | `POST result` a perzistence po reloadu | ✅ | – |
| Exam režim a skóre | 1 / 2 b = 50 %, rozpad správně/chybně | ✅ | – |
| Revize: otevřená odpověď s HTML | injektovaný element v DOM | ❌ | QA-010 |
| „Spustit znovu“ | `result.completed` zůstane `true` | ❌ | QA-020 |
| `evaluate-open-answer` | prázdné vstupy, `{}`, 100 % shoda, host smí | ✅ | – |
| `evaluate-open-answer` | substring shoda (`ACE` v „placebo“) | ⚠️ S | QA-033 |
| Skóre multi-choice | instant vs exam se liší | ⚠️ S | QA-020 |
| Generování, generate-more | bez klíče → 500 „400: …“ | ❌ | QA-021 |
| Všechny typy otázek z AI | | ⏭️ vyžaduje klíč | – |

### 2.12 Chat
| Prvek | Scénář | Výsledek | Nález |
|---|---|---|---|
| Vlákna | vytvoření, přejmenování, připnutí, výpis, export vlákna i projektu | ✅ | – |
| Fulltext historie | „Přejm“ najde, „PŘEJM“ ne | ⚠️ | QA-026 |
| Odeslání bez klíče / chyba před streamem | spojení se utrhne, v UI zpráva zmizí bez hlášky | ❌ | QA-012 |
| `last_snippet` s HTML | vykreslen jako HTML u jiného uživatele | ❌ | QA-009 |
| Streamování tokenů, citace, přerušení, odmítnutí mimo zdroje | | ⏭️ vyžaduje klíč (parser SSE ✅ S, ztráta při abortu ⚠️ S QA-025) | – |
| Citace a zdroje | | ⚠️ S | QA-027 |
| Hledání bez výsledků zahodí vlákno | | ⚠️ S | QA-026 |

### 2.13 Výuková lekce
| Prvek | Scénář | Výsledek | Nález |
|---|---|---|---|
| `POST lessons/generate` | bez klíče → 500 a osiřelá složka | ❌ | QA-045 |
| `POST lessons/generate` | chybí titul → 422 | ✅ | – |
| `GET lessons/{id}` | neexistující → 404 | ✅ | – |
| `DELETE lessons/{id}` | maže běžné projekty a cizí soubory s prefixem | ❌ | QA-003 |
| Kapitoly, scrubber, duální prohlížeč, `lesson_material.md`, `lecture_audio.mp3` | | ⏭️ vyžaduje klíč | – |

### 2.14 Dávky
| Prvek | Scénář | Výsledek | Nález |
|---|---|---|---|
| `process-notes-batch` | start | ✅ | – |
| Souběh na stejném projektu | 409 | ✅ | – |
| `cancel-batch` | `cancelling` | ✅ | – |
| `process-batch` | otázka bez title → 400 | ✅ | – |
| Průběh v UI | logy 2×, počitadlo dávky 2× | ❌ | QA-015 |
| Retry 3×, noční sweep, „jen nehotové“ | | ⏭️ vyžaduje AI (`tests/test_batch.py`) | – |

### 2.15 Nastavení
| Prvek | Scénář | Výsledek | Nález |
|---|---|---|---|
| Uložení klíče | API vrací jen maskovaný klíč, plný klíč v DOM není | ✅ | – |
| Maskovaná hodnota poslaná zpět | nepřepíše skutečný klíč | ✅ | – |
| Uživatel a centrální klíč | běžný user nepřepíše klíč serveru | ✅ | – |
| „Ověřit“ | prázdný a neplatný klíč → srozumitelná hláška (zmiňuje `.env`) | ✅ / ⚠️ | QA-057 |
| „Ověřit“ platný klíč | | ⏭️ | – |
| Allowlist modelů | user + sdílené klíče + cizí model → 400 | ✅ | – |
| „📂 Otevřít“ složku | desktop: `success`, cesta je izolovaná | ✅ | – |
| Jazyk CS/EN | ~44 viditelných českých textů v 9 pohledech | ❌ (známé) | QA-040 |
| `GET /api/settings` | vrací `user_data_dir` i hostovi | ⚠️ | QA-044 |

### 2.16 Fáze 3 – průřezové kontroly
| Oblast | Scénář | Výsledek | Nález |
|---|---|---|---|
| Role | anonym → 401 na všech 89 neveřejných operacích | ✅ | – |
| Role | viewer → 403 na všech zápisech mimo výjimky | ✅ | – |
| Role | host ON/OFF | ✅ | – |
| Role | admin endpointy pro user/viewer → 403 | ✅ | – |
| UI pozorovatele | 8 z 9 pohledů má aktivní zápisová tlačítka | ❌ | QA-036 |
| IDOR | privátní projekty přes API a `/uploads` | ✅ | – |
| IDOR | výjimky QA-001/002/003/005/013 | ❌ | |
| XSS | názvy souborů, projektů a vláken sanitizovány (backend + smoke) | ✅ | – |
| XSS | AI markdown přes DOMPurify (smoke) | ✅ | – |
| XSS | tisk | ✅ | – |
| XSS | `last_snippet`, otevřená odpověď | ❌ | QA-009, QA-010 |
| Hlavičky | CSP na HTML (s `unsafe-inline`, známé) | ⚠️ | – |
| Hlavičky | chybí `X-Content-Type-Options`, `Referrer-Policy` (známé, SECURITY.md) | ⚠️ | – |
| Hlavičky | `/docs` a `/openapi.json` za přihlášením | ✅ | – |
| Konzistence stavu | přepnutí projektu (Medulingo, test, balíček) | ❌ | QA-018, QA-028 |
| Konzistence stavu | přepnutí záložky | ❌ | QA-014 |
| Chybové stavy | AI chyba → 500 s „400:“ | ❌ | QA-021 |
| Chybové stavy | chat bez hlášky | ❌ | QA-012 |
| Chybové stavy | loadery visí | ❌ | QA-011, QA-050 |
| Responzivita | 375 px: scrollWidth 801; 768 px: 1012 (záhlaví) | ❌ | QA-037 |
| Responzivita | 1280 a 1920 px | ✅ | – |
| Modaly | Esc zavře 13 z 15 (`modalAuth` záměrně ne) | ✅ | – |
| Modaly | Esc nezavře přehrávač | ❌ | QA-038 |
| Modaly | žádný nemá `role=dialog`, `aria-modal` ani focus trap | ❌ | QA-038 |
| Popisky | 116 ze 173 polí bez labelu, 3 ikonová tlačítka bez názvu | ❌ | QA-038 |
| Konzole | 0 JS chyb ve všech 11 pohledech s projektem i bez | ✅ | – |
| Konzole | 1 nezachycená chyba na přihlašovací obrazovce | ⚠️ | QA-052 |
| Síť | žádné neočekávané 4xx/5xx v UI průchodu | ✅ | – |
| Desktop | `desktop_app.py --browser` s izolovaným adresářem: start, `/health`, setup, otevření datové složky | ✅ | – |

### 2.17 Stav známých nálezů z `docs/audit/AUDIT.md` a `SECURITY.md` §7
| Známý nález | Stav |
|---|---|
| S1 IDOR | ✅ opraveno (403 ověřeno). **Nové obchvaty:** QA-001/002/003/005/013 |
| S2 statické mounty | ✅ opraveno |
| S4/S5 tisk | ✅ sanitizace ověřena |
| S8 rate limit | ✅ |
| S9 setup | ✅ atomický, ale viz QA-007 |
| S11 allowlist | ✅ |
| S15 limit uploadu | ✅ |
| F1/F4 DOMPurify | ✅ (smoke) |
| F2/F3 escapování | ✅ (smoke), nové díry QA-009, QA-010 |
| Lekce bez vlastníka | platí a je horší, než se uvádí (QA-003) |
| Import nenastaví vlastníka | platí (nezkoumáno dál) |
| Pozorovatel čte vše | platí (ověřeno) |
| Klíče a tokeny v čitelné podobě (S12) | platí, prakticky zneužitelné přes QA-002 |
| `open-data-folder` na serveru (S14) | platí (v desktopu funguje správně) |
| CSP `unsafe-inline` | platí |
| `t()` neescapuje | platí (nezneužito) |
| `chat.js` escapuje jen `<` | platí (S) |
| Neověřená ID vláken | platí (smoke vede jako známé) |
| Kolize `chunk_id` | platí (nezkoušeno) |
| Odkazy na `localhost:8000` u kartiček | platí (S) |
| F9/F10 i18n | platí (viz 2.0, QA-040) |
| R1 dvojí ID projektu | platí; **konkrétní dopad je úplná nefunkčnost RAG, QA-004** |

---

## 3. Nálezy

Formát: **ID – název** · modul · `soubor:řádek` · ověření (D/S) · vztah ke známým nálezům.

V důkazech jsou tokeny relací a klíče odstraněné. Všechny testovací účty a hesla vznikly v izolovaném adresáři.

### Kritická

#### QA-001 – ID projektu `..` smaže celou datovou složku
- **Stav: OPRAVENO (2026-10-26), commit `fix(security): Reject dot-only project IDs on every project path`.** `validate_project_id` v `core/security.py` a jeho volání v `require_project_access`, create, delete, rename, importu a u lekcí. Regresní testy: `tests/test_project_id_validation.py`. Podrobnosti: `docs/audit/CHANGELOG.md`.
- **Modul:** projekty · `routers/projects.py:147` (delete), `services/projects/transfer.py:390-410` (import), `core/utils.py:4` (`sanitize_name` ponechává tečky)
- **Ověření:** D
- **Vztah ke známým:** nové. S20 tvrdí, že path traversal je ošetřený, ale tato cesta nepoužívá `safe_join`.

Kroky:
1. Přihlásit se jako běžný student (role `user`).
2. `DELETE /api/projects/%2E%2E`. Uvicorn dekóduje `%2E%2E` na `..` a route `{project_id}` ho přijme.
3. Případně `POST /api/projects/import` (multipart) s libovolným platným `.medproj`, `project_name=..` a `overwrite=true`.

Očekávané: 400 „Neplatný název projektu“.

Skutečné chování:
- Varianta 2: `os.path.join(UPLOAD_DIR, "..")` je `USER_DATA_DIR` a `shutil.rmtree` ho smaže. Ve vývojovém režimu je `USER_DATA_DIR` **kořen repozitáře**.
- Varianta 3: smaže datovou složku a obsah archivu rozbalí do kořene datové složky.
- `require_project_access("..")` projde, protože projekt `..` nemá vlastníka.

Důkaz (jednorázová instance s vlastním temp adresářem):
```
před: auth.db, chat_history.db, chroma_db, generated_*, lessons_data, uploads
DELETE /api/projects/%2E%2E  (student)  → 500 Internal Server Error
po:   chat_history.db, chat_history.db-shm, chat_history.db-wal   (auth.db, uploads, chroma_db… smazány)

POST /api/projects/import project_name=.. overwrite=true (student)
→ 200 {"status":"success","project":"..", "message":"Projekt '..' byl úspěšně importován."}
po:   a.txt, chat_history.db*, uploads    (auth.db a ostatní data smazány)
```

Návrh opravy:
- Jedna funkce `validate_project_id()`, která odmítne `""`, `.`, `..` a cokoli, co po `sanitize_name` nesplňuje `^[\w][\w.-]*$`.
- Všechny cesty projektu skládat přes `safe_join(UPLOAD_DIR, p)` s kontrolou `target != base`.
- Použít v create, delete, rename, clear-data, export, import, lessons, files a medulingo.
- Regresní test v `tests/test_security.py`.

#### QA-002 – Pozorovatel nebo anonymní host stáhne `auth.db` a převezme relaci admina
- **Stav: OPRAVENO (2026-10-26), commit `fix(security): Reject dot-only project IDs on every project path`.** `validate_project_id` v `core/security.py` a jeho volání v `require_project_access`, create, delete, rename, importu a u lekcí. Regresní testy: `tests/test_project_id_validation.py`. Podrobnosti: `docs/audit/CHANGELOG.md`.
- **Modul:** projekty / export · `routers/projects.py:401-419`, `services/projects/transfer.py:56` a `:146`
- **Ověření:** D
- **Vztah ke známým:** nové. Kombinuje S12 (tokeny v čitelné podobě) s chybějící validací ID.

Kroky:
1. Admin zapne režim hosta. Bez něj stačí účet pozorovatele.
2. Bez přihlášení `GET /api/projects/%2E%2E/export`.
3. Z archivu vzít `uploads/auth.db` a přečíst `sessions.token` uživatele s rolí admin.
4. Poslat cookie `medstudio_session=<token>` na `GET /api/auth/admin/users`.

Očekávané: 400 nebo 404.

Skutečné: ZIP s celou datovou složkou.
- Obsahuje `auth.db` (hashe, plaintext tokeny relací, per-user API klíče), `chat_history.db`, všechny `generated_*` a `user_config.json` s centrálními klíči, pokud existuje.
- `GET /api/projects/%2E/export` přibalí materiály **všech** projektů.

Důkaz:
```
GET /api/projects/%2E%2E/export (anonym, host ON) → 200, 297 188 B
položky: uploads/chat_history.db, uploads/auth.db, uploads/auth.db-wal, uploads/generated_flashcards/…
admin tokenů v exportu: 10 · GET /api/auth/admin/users s ukradeným tokenem → 200
```

Návrh opravy:
- Stejný validátor jako u QA-001.
- Export a export-info navíc jen pro existující složku projektu v `UPLOAD_DIR`.
- Dlouhodobě hashovat tokeny relací v DB (S12).

### Vysoká

#### QA-003 – `DELETE /api/lessons/{id}` smaže libovolný (i cizí privátní) projekt
- **Modul:** lekce · `routers/chat_api.py:555-590`
- **Ověření:** D
- **Vztah ke známým:** rozšiřuje „Lekce bez vlastníka“ (SECURITY.md §7). Dopad je obejití autorizace projektů, ne jen lekcí.

Kroky:
1. Vypnout sdílené projekty.
2. Student A založí `ProjStud` a nahraje soubor.
3. Student B pošle `DELETE /api/projects/ProjStud` → 403 (správně).
4. Student B pošle `DELETE /api/lessons/ProjStud` → **200**.

Důkaz: `DELETE /api/lessons: 200 {"status":"success","project":"ProjStud"} | složka existuje: False`

Další problémy stejného endpointu:
- Výstupy maže podle `startswith(f"{safe_id}_")`, takže smazání lekce „Sepse“ smaže i audio a poznámky lekce „Sepse u dětí“ (S).
- Řádek `project_ownership` zůstane.

Návrh opravy:
- Povolit jen ID `lekce_*`/`lesson_*` existující v tabulce lekcí.
- Nikdy nemazat `UPLOAD_DIR/<id>`.
- Mazat jen přesné názvy souborů lekce.
- Zavést vlastníka lekce.

#### QA-004 – Projekt s diakritikou v názvu nikdy nezaindexuje žádný materiál
- **Modul:** materiály / RAG · `services/rag_service.py:192` (`proj_{sanitize_name(...)}`), vs. `services/chat/retrieval.py:14` a `fts.py:236` (ASCII `sanitize_project_name`)
- **Ověření:** D
- **Vztah ke známým:** R1 (zná rozdílná ID). Úplnou nefunkčnost audit nepopsal.

Kroky:
1. Založit projekt „Kardiologie č. 1“ (UI to nabízí, aplikace je česká).
2. Nahrát TXT, PDF, DOCX nebo PPTX.
3. Vygenerovat poznámky.

Očekávané: soubory se zaindexují a generování najde podklady.

Skutečné: ChromaDB odmítne název kolekce a indexace **každého** souboru selže. Generování pak hlásí „V materiálech nebyly nalezeny žádné podklady“, nebo vrací 500.

Důkaz (log serveru):
```
❌ Selhalo indexování souboru kardio.txt: Validation error: name: Expected a name containing 3-512 characters
   from [a-zA-Z0-9._-] … Got: proj_Kardiologie_č._1
POST /api/generate-notes {"project":"Kardiologie_č._1"} → 500 "V materiálech nebyly nalezeny žádné podklady k této otázce."
```
Stejné soubory v projektu `Interna` se zaindexovaly: „1 sémantických chunků … uloženo“.

Totéž platí pro `../../outside`: „name … two consecutive periods“.

Návrh opravy:
- Název kolekce Chroma vždy odvozovat z `sanitize_project_name` (ASCII), stejně jako retrieval.
- Případně ASCII-fold s hashem.
- Pro existující projekty spustit reindex. Uživateli zobrazit chybu indexace v UI, ne jen v logu.

#### QA-005 – Převzetí cizího privátního projektu založením projektu se stejným názvem
- **Modul:** projekty · `routers/projects.py:129-141`, `services/auth_service.py:274-287` (`ON CONFLICT DO UPDATE SET owner_id`)
- **Ověření:** D
- **Vztah ke známým:** nové

Kroky: sdílené projekty OFF; A založí `privA`; B pošle `POST /api/projects {"name":"privA"}`.

Očekávané: 409.

Skutečné: `200 {"project":"privA","owner_id":3}`. B má přístup (`GET /api/files?project=privA → 200`), vlastník A dostane **403** na vlastní projekt.

Ve sdíleném režimu „Vytvořit“ existující projekt tiše uspěje (UI ukáže nabídku nového projektu nad existujícími daty).

Návrh opravy: 409, pokud složka nebo řádek vlastnictví existuje; obyčejný `INSERT` místo upsertu.

#### QA-006 – Prefixová kolize názvů projektů maže, přesouvá a míchá výstupy jiného projektu
- **Modul:** projekty, výstupy:
  - `routers/projects.py:184-214` (delete), `:285-310` (rename), `:343-377` (clear-data), `:520-541` (stats)
  - `routers/notes.py:63-66`, `routers/flashcards.py:93-95, 133-135`, `routers/podcast.py:57-59`
  - `services/practice_tests/storage.py:80-82`, `services/projects/transfer.py:92-111, 263-294`
- **Ověření:** D
- **Vztah ke známým:** CHANGELOG 1.1 zmiňuje prefix jen u autorizace. Ztráta dat je nová.

Kroky a výsledky (výstupy mají tvar `{projekt}_{otázka}.ext`):
1. Projekty `ab` a `ab_cd`, každý s poznámkou. `DELETE /api/projects/ab` → `deleted_outputs.notes: 2`. **Poznámka projektu `ab_cd` je smazaná.**
2. `kardio` a `kardio_2`. Přejmenování `kardio` → `kardio_new` přejmenuje i `kardio_2_Fibrilace.md` na `kardio_new_2_Fibrilace.md`. Ten pak patří projektu `kardio_new`.
3. `GET /api/notes?project=kardio` vrací i poznámky projektu `kardio_2`. `/api/stats` je počítá dvakrát.
4. V UI: po importu kopie `Interna_kopie` ukazuje dashboard `Interna` 2 poznámky, 2 sady kartiček a 2 testy místo 1.

Scénář je v praxi častý: import sám navrhuje název `X_2` a „Fyziologie 2“ se uloží jako `Fyziologie_2`.

Návrh opravy: všude filtrovat `project_of_output_file(f) == safe_proj` (z `core/authz.py`), nebo přejít na podsložky podle projektu.

#### QA-007 – Registrace kohokoli před založením admina trvale zablokuje čerstvou instanci
- **Modul:** auth · `services/auth_service.py:152-154` (`needs_setup = user_count == 0`), `:401-406` (registrace povolena výchozím nastavením)
- **Ověření:** D
- **Vztah ke známým:** souvisí se S9 (atomický setup je opravený, tohle ne)

Kroky: na čerstvé instanci anonymně `POST /api/auth/register {"username":"early",…}` → 200 pending. Pak `POST /api/auth/setup`.

Očekávané: setup se povede (pending účty se nepočítají), nebo registrace před setupem vrátí 403.

Skutečné: `400 "Administrátorský účet již byl vytvořen."`, `needs_setup:false`. Neexistuje admin, který by schválil pending účet, a obnova vyžaduje ruční zásah do `auth.db`.

Dopad: na Cloudflare tunelu stačí jeden požadavek kohokoli. Snadné je to i nechtěně, například přes registrační formulář na úvodní obrazovce.

Návrh opravy: `needs_setup` = žádný **schválený admin**; `register` při `needs_setup()` vrátí 403.

#### QA-008 – Upload a mazání v „Prohlížeči souborů“ nefungují
- **Modul:** materiály · `static/js/viewer-navigation.js:311-322`, `:337`
- **Ověření:** D
- **Vztah ke známým:** nové

Kroky: Prohlížeč souborů → nahrát soubor, nebo 🗑️ u souboru.

Důkaz (prohlížeč):
```
POST /api/upload?project=Interna → 405   toast: "❌ Chyba: Method Not Allowed"
DELETE /api/files/Interna/kardio.txt → 405  toast: "❌ Chyba při mazání: Method Not Allowed"  (soubor zůstal)
```

Návrh opravy:
- Upload: `POST /api/files/upload` s `formData.append("project", currentProject)` a čtením `data.filenames`.
- Mazání: `DELETE /api/files/${encodeURIComponent(fn)}?project=${encodeURIComponent(currentProject)}`.
- Přidat smoke test.

#### QA-009 – Stored XSS přes náhled poslední zprávy vlákna v historii chatu
- **Modul:** chat · `static/js/chat.js:224` (`${t.last_snippet}` bez `escapeHtml`), zdroj `services/chat/repository.py:136`
- **Ověření:** D (neškodný marker)
- **Vztah ke známým:** nové; F3/F6 byly opravené jinde

Kroky:
1. Zpráva chatu s HTML. Bez klíče jsem ji vložil importem `.medproj`, v provozu stačí ji napsat.
2. Jiný uživatel (pozorovatel) otevře Chat.

Důkaz: `<b id="qa_snip">` se vykreslil jako element v `thread-item-thread_… > .truncate` u uživatele `viewer1`. Se sdílenými projekty (výchozí) se to týká všech.

Návrh opravy: `escapeHtml(t.last_snippet)`. Totéž pro `s.snippet` (`viewer-navigation.js:706`, S) a dotaz hledání (`chat.js:110`).

#### QA-010 – Stored XSS přes otevřenou odpověď v testu (režim revize)
- **Modul:** testy · `static/js/practice-tests.js:785` (`${uAns.open_answer}` uvnitř `<textarea>`)
- **Ověření:** D (marker)
- **Vztah ke známým:** nové

Kroky: v testu napsat do otevřené odpovědi `</textarea><b id="qa_marker">MARK</b>`, dokončit test a spustit revizi.

Důkaz: `document.getElementById('qa_marker')` existuje. Výsledek se ukládá na server (`POST /api/tests/{f}/result`) a revizi otevře každý, kdo test načte.

Neescapované jsou také (S):
- `matched/missing_key_points` a `feedback` (`practice-tests.js:902-911`);
- `source_quote` (`:824`);
- `srcLabel` (`flashcards.js:494`).

Návrh opravy: `escapeHtml` u všech, nebo nastavovat `textarea.value` přes DOM.

#### QA-011 – Kartičky: počet 1–3 u nové otázky vždy selže s 500
- **Modul:** kartičky · `services/flashcards_service.py:214-221`, `routers/flashcards.py:76`
- **Ověření:** D
- **Vztah ke známým:** nové

Příčina:
- `tolerance = max(3, …)`, takže pro `count ≤ 3` platí `existing_count (0) >= target_count - tolerance (≤ 0)`.
- Služba „přeskočí generování“ a vrátí `existing_data = None`. Router pak dělá `{**None}`.
- Děje se to **před** voláním AI, tedy i s platným klíčem. Vlastní pole UI povoluje 1–500.

Důkaz:
- log: `⏩ Otázka 'Fibrilace síní' již má 0 hotových kartiček (požadováno: 3). Přeskakuji generování.`
- `500 {"detail":"'NoneType' object is not a mapping"}`;
- UI: alert se stejným textem, karta zůstane na „Profesor připravuje 3 high-yield kartiček…“.

Návrh opravy: přeskakovat jen při `existing_data and existing_count >= …`; v UI po chybě obnovit kartu (`displayCurrentCard()`).

#### QA-012 – Chat: při chybějícím klíči (nebo jiné chybě před streamem) zpráva beze stopy zmizí
- **Modul:** chat · `services/chat/grounded_chat.py:58` (`get_ai_client()` mimo `try` uvnitř generátoru SSE), `static/js/viewer-navigation.js:905-913`
- **Ověření:** D
- **Vztah ke známým:** nové

Kroky: bez Gemini klíče napsat dotaz do Chatu a stisknout Enter.

Očekávané: událost `error` a hláška „Není nastaven Gemini API klíč…“.

Skutečné:
- Server vyhodí `ValueError` uprostřed `StreamingResponse`: 200 s prázdným tělem, nebo reset spojení.
- UI v `finally` znovu načte vlákna. Uživatelova zpráva zmizí, žádná chyba se nezobrazí.

Důkaz: síť `POST /api/chat/completions → 200` (prázdné tělo). Konzole bez chyb. Obrazovka zpět na „Zahajte konverzaci…“.

Návrh opravy: v `stream_grounded_chat` obalit celé tělo do `try` a vždy poslat `event: error`; na klientu ošetřit prázdnou odpověď bez `done`.

#### QA-013 – Medulingo zobrazuje poznámky, kartičky a testy jiných projektů (substring shoda)
- **Modul:** Medulingo · `services/medulingo_service.py:102, 111, 128, 138, 258-261`
- **Ověření:** S (nereprodukováno, vyžaduje více uživatelů s výstupy)
- **Vztah ke známým:** nové

Popis:
- `normalize_name(project) in normalize_name(f)` je substring, takže projekt `a` „vlastní“ téměř všechny soubory.
- `get_question_path_content` výsledky nefiltruje přes `filter_accessible_output_files`.
- `test_file` z plánovače se skládá přes `os.path.join` bez `safe_join` (čtení libovolného JSON).

Návrh opravy: `project_of_output_file(f) == safe_proj`, `safe_join` a kontrola přístupu k výstupu.

### Střední

| ID | Modul | Místo | Ověření | Popis a reprodukce | Návrh |
|---|---|---|---|---|---|
| QA-014 | UI / i18n | `static/js/app.js:961` (`applyTranslations` při každém `switchTab`); prvky s `data-i18n` plněné z JS: `index.html:280` (`sidebarUserRoleBadge`), `:2490` (`cardFrontText`), `:3204`, `:3491`, `qmQuestionsTotalBadge` aj. | D | Přepnutí záložky přepíše dynamický obsah statickým překladem. **(a)** Otevřený balíček kartiček „Fibrilace síní, 2 kartiček“ se po Domů → Kartičky změní na „Zvolte otázku a vygenerujte kartičky / 0 kartiček“, data přitom zůstávají. **(b)** Odznak role u admina se změní na „Uživatel“. **(c)** Zobrazí se surové šablony „{count} bloků“, „{count} zpráv“, „{count} otázek“ (s `qm.questionsCount` to po přepnutí jazyka potvrdil i agent). Podle statické revize se stejně chovají `testsCountLabel` (ukáže 10 místo zvolených 30) a `testRunnerModeBadge` (ukáže „Okamžité“ u zkouškového režimu). | Odstranit `data-i18n` z prvků vlastněných JS (nebo překládat jen vnořený `<span>`); po `applyTranslations` znovu vykreslit aktivní pohled |
| QA-015 | SSE / dávky | `static/js/app.js:779` + `static/js/auth.js:74, 92, 289, 331, 380` | D | Po načtení jsou otevřená 2 spojení `/api/logs`, takže každá událost je v konzoli 2× (ověřeno markerem). Podle kódu se 2× započítá i `question_completed` (`podcast.js:116`), takže průběh přestřelí („Dokončeno 4 z 2“, S). | Jediný `window._sse`, před otevřením zavřít starý; odstranit volání v `app.js:779` |
| QA-016 | Plánovač | `static/js/planner.js:1241` (`const filtered`) vs. `:1268` | D | Klik na „Filtrovat“ u dne v kalendáři vyhodí `TypeError: Assignment to constant variable`. Pokud je filtr aktivní, `saveProjectQuestions` spadne v `renderPlannerTable` (ř. 547) ještě před POST. Změny (naučeno, známka, poznámka) se zapíšou jen do localStorage a po reloadu je přepíše verze ze serveru. Ověřeno: 0 POST požadavků, localStorage zapsán. | `let filtered`; v `saveProjectQuestions` uložit před renderem |
| QA-017 | Pomodoro | `static/js/pomodoro.js:321-357`, `:833-836`, `:233-238`, `:301-309`, `:39`, `:140` | D/S | **(a)** „Začít další blok hned“ cyklus nikdy nezvýší. Ověřeno: 5 bloků za sebou = „W1 W1 W1 W1 W1“, dlouhá pauza nenastane. S přestávkami je sekvence správná (W1…W4 → dlouhá). **(b)** Posun `Date.now` o 8 h (spánek nebo zavřený notebook) připíše 28 800 s soustředění (D). **(c)** Datum statistik se počítá v UTC a rollover probíhá jen při startu (S). | Inkrementovat cyklus po dokončení práce; omezit `delta` na `timeLeft`; použít lokální datum a kontrolu dne v `tick` |
| QA-018 | Medulingo | `static/js/app.js:1277-1327` (`onProjectChange` nevolá `loadMedulingo`), `services/medulingo_service.py:469`, `static/js/medulingo.js:60` | D | Po přepnutí projektu v záhlaví Medulingo dál ukazuje „Projekt: Interna“ a jeho mapu; klik na uzel vede na „Nelze načíst otázku“ (S). Denní série je stub: `streak = 1 if completed_today else 0` a UI zobrazí `m.streak \|\| 1`, tedy vždy aspoň „1 dní“. | Reset `medulingoActiveCategory` a `medulingoData` a reload při změně projektu; počítat sérii z historie `completedDate` |
| QA-019 | Prohlížeč | `static/js/chat.js:1094-1114`, `:1291` | D | Po otevření TXT a výběru PDF zůstane `viewerActiveTabMode="text"` a nativní iframe ukazuje `kardio.txt`, zatímco titulek hlásí `kardio_text.pdf`. Přepnutí na „Nativní“ ukáže jiný dokument. | Vynucený textový režim evidovat zvlášť; v `selectViewerDocument` vždy aktualizovat `frame.src` |
| QA-020 | Testy | `static/js/practice-tests.js:1374-1377` (retake), `:1065` vs `:1188` (skóre) | D/S | „Spustit znovu celý test“ nechá `activeTest.result.completed = true` (D), takže v exam režimu jsou možnosti zamčené a ukazují správné odpovědi (S). Multi-choice se boduje v instant režimu částečně a v exam režimu 0/1 (S). Sebehodnocení Znovu/Těžké/Dobré/Snadné nepřepočítá ani neuloží výsledek (S, `:943-959`). | Klonovat test s čistým `result`; jedna bodovací funkce; po sebehodnocení přepočítat a uložit |
| QA-021 | AI endpointy | `routers/flashcards.py:84`, `routers/podcast.py:97, 118`, `routers/tests_api.py:108, 142`, `routers/chat_api.py:294, 357`, lekce | D | `except Exception` zabalí `HTTPException(400)` do 500 s textem `"400: Není nastaven Google Gemini API klíč…"`. Frontend tak zobrazí technickou předponu a monitoring vidí 5xx. | `except HTTPException: raise` před obecným `except` |
| QA-022 | Import otázek | `routers/files.py:262` (`decode("utf-8")`), `static/js/planner.js:1726` (`readAsText(…, "UTF-8")`), `:155-166` | D/S | `upload-csv`: cp1250 → **500** `UnicodeDecodeError`; BOM zůstane v první otázce (`"﻿Otázka;Okruh"`); hlavička se importuje jako otázka; `Fibrilace síní;Kardiologie` je jedna otázka i s okruhem; duplicity zůstávají; mažou se všechny uvozovky („Crohn's“ → „Crohns“). Import v plánovači čte jen UTF-8, cp1250 export z Excelu rozbije diakritiku (S). | `utf-8-sig` → fallback `cp1250`; `csv.Sniffer`; detekce hlavičky; deduplikace |
| QA-023 | Kartičky / export | `services/flashcards_service.py:80-138`, `routers/flashcards.py:185-253` | D | Zalomení řádku v `hint` (a podle kódu i v `cz.q`, `cz.a`, `pojmy`, `src_ref`) rozdělí kartu na 2 řádky Anki TSV. Důkaz: 2 karty → 3 řádky s počty tabulátorů `[0, 1, 1]`. `\r` se neodstraňuje nikde. | Normalizovat `\r\n\t` ve všech polích (`<br>`) |
| QA-024 | Plánovač | `static/js/planner.js:553-569` | S | „Uložit plán“ ukáže úspěch i při 4xx/5xx (`sendJson` nevyhazuje) a posílá 2 POST požadavky. | Kontrolovat `res.ok`; jeden zápis |
| QA-025 | Chat | `services/chat/grounded_chat.py:251`, `static/js/viewer-navigation.js:911` | S | Po „Stop“ se částečná odpověď neuloží a `finally` ji přenačtením vlákna z obrazovky smaže; vlákno serveru dál volá Gemini. | Uložit částečný text s příznakem `aborted`; po abortu vlákno nepřenačítat |
| QA-026 | Chat / historie | `static/js/chat.js:85-88`, `services/chat/repository.py:121` | D/S | Hledání „PŘEJM“ nenajde vlákno „Přejmenováno“, protože SQLite `LIKE` porovnává bez ohledu na velikost písmen jen ASCII (D). Hledání bez výsledků zavolá `createNewChatThread(false)` a zahodí otevřenou konverzaci (S). | `lower()` v Pythonu / FTS; nový vlákno jen při prázdném dotazu |
| QA-027 | Citace | `static/js/viewer-navigation.js:459-487`, `:555-566`, `:697`, `:758-768` | S | Klik na `[1]` v chatu nejdřív hledá ve `window.currentNotesSources` (poslední otevřená poznámka) a teprve pak v chatu; `chatSources` přepíše každá nová zpráva. Starší odpovědi a vlákna z jiného projektu („Všechny projekty“) tak otevírají špatný zdroj nebo projekt. | Uložit zdroje a projekt na odznak citace nebo zprávu |
| QA-028 | Stav aplikace | `static/js/app.js:1277-1328`, `static/js/auth.js:445-464` | S | Přepnutí projektu nevynuluje `activeTest`, `currentDeck` ani časovač testu: navazující otázky z testu projektu A se generují z materiálů B a zapíšou do vlákna A. Odhlášení nechá v paměti stav předchozího uživatele. | Reset stavu, po odhlášení `location.reload()` |
| QA-029 | Kartičky / poznámky | `services/flashcards_service.py:175-177, 182-221`, `services/notes_service.py:17-19` | S | Název souboru je z prvních 40 znaků otázky, takže 2 otázky se stejným začátkem sdílí soubor. Otázka B dostane balíček A, nebo ho přepíše. Jde o stejnou třídu chyby jako `d3814f0`. | Hash plného znění v názvu |
| QA-030 | Medulingo / poznámky | `static/js/medulingo.js:1329-1336`, `:658`, `:1056`, `:1449-1465`; `routers/notes.py:73-79` | S | Inline tlačítka „Vygenerovat studijní text“ a „Vygenerovat test“ nejsou během běhu zakázaná, takže dvojklik spustí 2× `generate-pack`. „Připravit 3 dopředu“ nemá guard ani `res.ok`. Výpis poznámek čte jen 1 024 B metadat, takže u ≥ 4 zdrojů je titul z názvu souboru a stav „Hotovo“ se nenastaví. | In-flight příznak podle otázky; číst metadata do `-->` |
| QA-031 | Upload / index | `routers/files.py:63-69`, `services/rag_service.py:193-199`, `services/chat/fts.py:177-196` | D/S | `a b.txt` a `a_b.txt` se uloží pod stejný název a druhý tiše přepíše první (D). Při novém nahrání menší verze zůstanou staré chunky v FTS/Chroma (S). | Odmítnout nebo přejmenovat kolizi; před indexací smazat podle `source` |
| QA-032 | Podcast | `services/podcast_service.py:183-194, 270-276` | S | Uloží se `safe_filename(name)`, ale vrátí se nesanitizovaný název: „Astma / CHOPN“ → odkaz `Astma__CHOPN.mp3` vede na 404. | Vracet uložený název |
| QA-033 | Testy | `services/practice_tests/evaluation.py:44-49` | S | Hodnocení otevřené odpovědi hledá podřetězce (klíčový bod „ACE“ najde v „placebo“), prázdný klíčový bod se vždy počítá jako splněný a jiné než řetězcové `key_points` vrátí 500 (endpoint smí volat i host). | Porovnávat slova; `str()`; přeskočit prázdné |
| QA-034 | Lekce | `routers/chat_api.py:577-590`, `:497-512` | S | Smazání lekce maže prefixem i soubory jiných lekcí; stejný název lekce přepíše existující složku; upload lekce nemá limit velikosti. | Přesné názvy; kontrola kolize; `copy_with_limit` |
| QA-035 | Upload v UI | `static/js/materials.js:141-167, 172` | D | Upload z Domů nekontroluje `res.ok`; `.exe` nebo 413 nevyvolá žádnou hlášku, štítek se jen vrátí. Server nepovolené soubory tiše přeskočí (`200 {"filenames": []}`) a přijme prázdný soubor. `deleteFile` a výpisy nekódují `project`/`filename` v URL. | Chyba 400 pro nepodporovaný typ; toast v UI; `encodeURIComponent` |
| QA-036 | Role v UI | více pohledů | D | Pozorovatel vidí aktivní zápisová tlačítka v 8 z 9 pohledů (Generovat, Smazat, Přidat otázku, Importovat, Uložit). Server správně vrátí 403 a UI ukáže toast, ale např. kartička zůstane na „Profesor připravuje 10 … kartiček“. | Skrýt/zakázat podle `isViewerMode()` (vzor: plánovač a správce otázek) |
| QA-037 | Responzivita | záhlaví (`div.flex … justify-end flex-nowrap`) | D | Při 375 px je `scrollWidth` 801 px a při 768 px 1 012 px ve všech pohledech, protože pravá část záhlaví (Pomodoro, uživatel, jazyk, nastavení, konzole) se nezalomí. Při 1280 a 1920 px je vše OK. | `flex-wrap` nebo menu pod hamburgerem |
| QA-038 | Přístupnost | všechny modaly; `modalPodcastPlayer` | D | Žádný z 15 modalů nemá `role="dialog"` ani `aria-modal` a focus se nepřesune dovnitř (žádný focus trap). Přehrávač podcastu nejde zavřít Esc a jeho křížek nemá přístupný název (stejně `btnViewerFilesSearchClear` a vymazání hledání v textu). 116 ze 173 polí formulářů nemá label, `aria-label` ani `title` (např. `projectSelect`, `viewerTextSearchInput`, `medChatInput`). Esc zavírá 13 modalů správně. | Společný helper modalu (role, focus, Esc, návrat focusu); `aria-label` |
| QA-039 | Tisk | `routers/print.py` (šablona náhledu) | D | Tiskový náhled nenačítá KaTeX CSS, takže `.katex-mathml` není skrytý a vzorec se vypíše 2× („x²x2“, ověřeno screenshotem). | Přidat pinnutý KaTeX CSS se SRI do šablony a CSP |
| QA-040 | i18n | `static/js/*.js` | D | Po přepnutí na EN zůstalo česky ~44 viditelných textů v 9 pohledech mimo uživatelská data: Testy 10 (např. „0/2 zodpovězeno“, „▼ náhled“), Kartičky 8 („Vygenerovat kartičky“, „Série 3 unikátních kartiček:“), Medulingo 7, Chat 4 („Zatím žádné konverzace.“), Plánovač 4 („Cíl: 2 ot./den“, „Vysvětlit“), Podcast 4 („Čeká“), Lekce 3, Poznámky 3, Pomodoro 1. | Známé (F10, ~600 ř.); prioritně texty vykreslované JS |

### Nízká

| ID | Modul | Místo | Ověření | Popis | Návrh |
|---|---|---|---|---|---|
| QA-041 | Projekty | `routers/projects.py:129-141`, `:85-100` | D | Název „   “ (nebo „!!!“) vytvoří projekt `""` (zapíše se do `UPLOAD_DIR` a řádek vlastnictví `""`). 300 znaků → **500** `File name too long`. `lekce_x` a `.x` se vytvoří, ale ve výpisu chybí. | Validace délky a zakázaných prefixů (QA-001) |
| QA-042 | Admin | `services/auth_service.py:660-681` | D | `toggle-status` u čekajícího nebo zamítnutého účtu nastaví `approved` s výchozí rolí `user`, čímž obejde volbu role při schválení. | Přepínat jen `approved` ↔ `disabled` |
| QA-043 | Auth | `routers/auth.py:111, 136` | D | `setup` i `login` vrací `token` relace v JSON, takže HttpOnly cookie ztrácí smysl (při XSS lze token exfiltrovat). Frontend ho nepoužívá. | Odstranit z odpovědi (Bearer jen pro desktop, pokud je potřeba) |
| QA-044 | Nastavení | `routers/settings.py:87` | D | `GET /api/settings` vrací absolutní `user_data_dir` serveru i hostovi a pozorovateli. | Jen pro admina / desktop |
| QA-045 | Lekce | `routers/chat_api.py:497-512` | D | Neúspěšné generování (bez klíče → 500, „Zkontrolujte soubor .env“) nechá osiřelou složku `lessons_data/lekce_Sepse_QA`, která se nikde nezobrazí. | Úklid v `except`; 400 pro chybějící klíč |
| QA-046 | Medulingo | `services/medulingo_service.py:503-510`, `:641+` | D | `complete` s neexistujícím `question_id` vrátí `success`. `question/{id}` vrací `200 {"error": …}` místo 404 a s číselnými ID (z API nebo starých dat) otázku nenajde (`1 != "1"`). | 404; porovnávat `str(qid)` |
| QA-047 | Statistiky | `routers/projects.py:549-552` | S | `lessons_count` je globální a nezávisí na projektu, `media_count` počítá MP3 i MP4 jednoho podcastu, `chat_count` má strop 1 000. | Filtrovat podle projektu; počítat podcasty |
| QA-048 | Import | `services/projects/transfer.py:302` | D | `inspect` přijme libovolný ZIP bez `manifest.json` (`foreign.zip` → 200) a import pak vytvoří prázdný projekt. | Vyžadovat manifest |
| QA-049 | Prohlížeč | `static/js/viewer-navigation.js:226-268`, `:90-108`, `index.html:809` | D/S | Počítadlo „N nálezů“ počítá sekce, ne výskyty (2 výskyty → „1 z 1“), a hledaný výraz se nezvýrazní. Zoom 150 + 25 = 175 není v `<select>`, takže ten zůstane prázdný. Štítek velikosti písma je po načtení natvrdo „16px“ (S). | Počítat výskyty; zoom jen po hodnotách selectu |
| QA-050 | Loadery | `static/js/notes.js:486-488`, `static/js/flashcards.js:331` | D | Po chybě generování poznámek zůstane podtitulek „Probíhá analýza…“ (v síťovém `catch` i celý loader, S). Po chybě kartiček zůstane text „Profesor připravuje N kartiček…“. | Chybový stav ve všech větvích |
| QA-051 | Výkon | `app.js` `onProjectChange` / `updateDashboardStats` | D | Jedno přepnutí projektu vyvolá 6–8× `/api/stats`, 2× `/api/files`, 2× `planner` a 2× `/api/logs`. Každé uložení v plánovači navíc spustí `loadMedulingo` (S). | Debounce / jedno načtení |
| QA-052 | Konzole | `static/js/app.js:1211` | D | Na přihlašovací obrazovce: `Uncaught (in promise) TypeError: Cannot read properties of undefined (reading 'forEach') at loadProjects` (401 bez `projects`). | Kontrola `res.ok` |
| QA-053 | API modely | `routers/auth.py` (toggle modely) | D | `{"allow_registration": "false"}` → 200 a hodnota `false` (pydantic lax), přestože ARCHITECTURE.md uvádí strict modely. | Dědit z `RequestModel` |
| QA-054 | Pozorovatel / host | – | D | `GET /api/settings/open-data-folder` správně vrátí hostovi 403; u přihlášeného studenta na serveru spustí `open` (známé S14). | Známé |
| QA-055 | Plánovač | `routers/chat_api.py:280`, `services/medulingo_service.py:336` | S | `revisionDays = 0` se uloží jako 14 (`or 14`). | `14 if v in (None, "") else int(v)` |
| QA-056 | Drobnosti (S) | různé | S/D | (a) 5 mrtvých `getElementById` (`globalQuestionsBadge` 2×, `btnHeaderDeleteProject`, `medManualGradeSelect` 2×), všechny ošetřené. (b) Hromadné „Označit zobrazené jako hotové“ přepíše starší `completedDate` (`planner.js:1551`). (c) `&bull;` v `textContent` (`planner.js:744`). (d) Pomodoro štítky „(5 min)“, „25 minut“, „/ 4“ se nezmění po úpravě délek. (e) Quizlet kopie obsahuje HTML a per-deck kopie nečeká na clipboard. (f) Rychlý start testu ignoruje výběr. (g) Chyba exportu zůstane v modalu. (h) Přepínač registrace/hosta se po chybě nevrátí. (i) Uložený klíč nelze smazat prázdným polem. (j) `/api/outputs` vrací 200 `[]` při výjimce, takže podcast resetuje stav „Hotovo“. (k) `count: null` → 500. (l) Otázka bez `title` v dávce vyhodí `TypeError`. (m) Smazání uživatele s id 1 rozbije `ensure_existing_projects_owned` (FK). | Viz popis |

### Kosmetická

| ID | Místo | Popis |
|---|---|---|
| QA-057 | `routers/settings.py` (test-key) | Hláška „Zkontrolujte soubor .env“ i u klíče zadaného v UI |
| QA-058 | `index.html` (Nastavení) | Dvojité emoji „👥 👥 Uživatelé & schvalování“; štítek dlaždice „MATERIÁLY“ se na 800 px ořízne |
| QA-059 | `modalWelcome` | Text „Vaše API klíče … uloženy výhradně ve vašem lokálním počítači“ neplatí v serverovém režimu (klíče jsou na serveru) |

---

## 4. Návrh automatizace

| Priorita | Scénář | Typ | Jak |
|---|---|---|---|
| P0 | QA-001/002/003: `..`, `.`, `%2E%2E` ve všech cestách s projektem (delete, export, export-info, import `project_name`, lessons, files, medulingo) | unittest (`TestClient`) | Parametrizovaný test nad seznamem rout z `app.openapi()`. Očekávat 400/404 a nezměněný obsah `USER_DATA_DIR` (snapshot `os.listdir`). Běží v izolovaném adresáři z `tests/__init__.py` |
| P0 | QA-005, QA-003 privátní režim | unittest | Rozšířit `tests/test_project_authz.py`: B nesmí `POST /api/projects` existující název ani `DELETE /api/lessons/<projekt A>` |
| P0 | QA-007 registrace před setupem | unittest | `register` → `setup` musí projít, nebo `register` vrátí 403 |
| P1 | QA-006 prefixová kolize | unittest | Fixture projektů `a` a `a_b` s výstupy; delete, rename, clear-data, export, stats a výpisy smí sahat jen na `a` |
| P1 | QA-004 diakritika | unittest s offline embeddingy (`OfflineAITestCase`) | Projekt „Kardiologie č. 1“: upload → indexace → `query_rag_context_with_sources` vrátí chunk |
| P1 | QA-011 kartičky 1–3 | unittest | `internal_generate_flashcards(count=1..3)` s falešným Gemini vrátí balíček |
| P1 | QA-012/021 chyby AI | unittest | Bez klíče: endpointy vrací 4xx (ne 500 „400:“); chat stream obsahuje `event: error` |
| P1 | QA-008, QA-016, QA-014, QA-015 | Playwright (`tests/test_frontend_smoke.py`) | (a) upload a mazání z Prohlížeče souborů přes `setInputFiles`; (b) klik na filtr dne v kalendáři a zachycení `pageerror`; (c) otevřít balíček → přepnout záložku → `#cardFrontText` se nezmění; po přepnutí nesmí nikde zůstat `{count}`; (d) počet requestů `/api/logs` == 1 |
| P1 | QA-009/010 XSS | Playwright + `seed_xss_data.py` | Doplnit seed o chat zprávu (přes import `database.json`) a otevřenou odpověď testu s markerem. Ověřit, že `#qa_marker` neexistuje a `window.__xss == 0` |
| P2 | QA-022 import CSV | unittest | Soubory UTF-8, UTF-8 BOM, cp1250, `;`/`,`/`\t`, hlavička, duplicity |
| P2 | QA-023 Anki | unittest | Karty s `\n`/`\t`/`\r` ve všech polích → každý řádek TSV má právě 1 tabulátor |
| P2 | QA-017 Pomodoro | Playwright s `page.clock` | Rychlé přetočení 4 bloků bez přestávek → dlouhá pauza; skok o 8 h → čas soustředění ≤ délka bloku |
| P2 | QA-037/038 | Playwright | `setViewportSize` 375/768: `scrollWidth <= innerWidth`; každý modal: Esc zavře, focus uvnitř, `role=dialog`. Volitelně `axe-core` (nová dev závislost, se souhlasem) |
| P2 | Role matice | unittest | Zrcadlo skriptu `t12_rolematrix`: všechny operace z OpenAPI, anonym → 401, viewer → 403 na zápis kromě výjimek (zachytí každý nový endpoint) |
| P3 | QA-040 i18n | node skript v CI | Po `setAppLanguage('en')` projít pohledy a hlásit textové uzly s diakritikou (allowlist pro uživatelská data) |

---

## Příloha A – Inventura API (91 operací)

Role:
- „přihlášený / host (čtení)“ = libovolná přihlášená role, při zapnutém režimu hosta i anonym;
- zápisové endpointy vrací pozorovateli a hostovi 403 (ověřeno role-maticí pro všechny);
- „✅“ = funkčně testováno nad rámec role-matice.

Statické mounty (`ProjectStaticFiles`): `/uploads`, `/lessons-data`, `/audio`, `/notes-files`. Dále `GET /api/logs` (SSE) a `/` (SPA). `/docs` a `/openapi.json` vyžadují přihlášení.

**UI inventura:**
- `index.html`: 808 `id`, 11 pohledů (`viewHome`, `viewFiles`, `viewMedulingo`, `viewPlanner`, `viewPodcast`, `viewNotes`, `viewCards`, `viewTests`, `viewChat`, `viewLesson`, `viewPomodoro`);
- 15 modalů;
- 542 ovládacích prvků (`button`/`input`/`select`/`textarea`/`a`);
- 567 inline handlerů (468 `onclick`, 62 `onchange`, 26 `oninput`, 3 `onkeydown`, 3 `onsubmit`, 5 ostatních);
- 22 `addEventListener`;
- 1 095 referencí `getElementById`/`querySelector('#…')`;
- překlady: 1 426 klíčů × 3 jazyky, 1 181 použitých.

| # | Metoda | Cesta | Role | Vstupní model | Funkčně testováno |
|---|---|---|---|---|---|
| 1 | GET | `/api/logs` | přihlášený / host (čtení) | – | ✅ |
| 2 | GET | `/health` | veřejné | – | ✅ |
| 3 | GET | `/api/auth/status` | veřejné | – | ✅ |
| 4 | POST | `/api/auth/setup` | veřejné | SetupRequest | ✅ |
| 5 | POST | `/api/auth/login` | veřejné | LoginRequest | ✅ |
| 6 | POST | `/api/auth/register` | veřejné | RegisterRequest | ✅ |
| 7 | POST | `/api/auth/logout` | veřejné | – | ✅ |
| 8 | GET | `/api/auth/admin/users` | admin | – | ✅ |
| 9 | GET | `/api/auth/admin/pending` | admin | – | ✅ |
| 10 | POST | `/api/auth/admin/approve/{user_id}` | admin | – | ✅ |
| 11 | POST | `/api/auth/admin/change-role/{user_id}` | admin | RoleChangeRequest | ✅ |
| 12 | POST | `/api/auth/admin/reject/{user_id}` | admin | – | ✅ |
| 13 | POST | `/api/auth/admin/toggle-status/{user_id}` | admin | – | ✅ |
| 14 | DELETE | `/api/auth/admin/users/{user_id}` | admin | – | ✅ |
| 15 | POST | `/api/auth/admin/registration-toggle` | admin | RegistrationToggleRequest | ✅ |
| 16 | POST | `/api/auth/admin/guest-toggle` | admin | GuestToggleRequest | ✅ |
| 17 | POST | `/api/auth/admin/shared-api-keys-toggle` | admin | SharedApiKeysToggleRequest | ✅ (role-matice + UI síť) |
| 18 | POST | `/api/auth/admin/shared-projects-toggle` | admin | SharedProjectsToggleRequest | ✅ |
| 19 | GET | `/api/settings` | přihlášený / host (čtení) | – | ✅ |
| 20 | POST | `/api/settings` | admin, user (viewer → 403) | object | ✅ |
| 21 | POST | `/api/settings/test-key` | admin, user (viewer → 403) | ApiKeyTestRequest | ✅ |
| 22 | POST | `/api/settings/open-data-folder` | admin, user (viewer → 403) | – | ✅ |
| 23 | GET | `/api/projects` | přihlášený / host (čtení) | – | ✅ |
| 24 | POST | `/api/projects` | admin, user (viewer → 403) | ProjectCreateRequest | ✅ |
| 25 | DELETE | `/api/projects/{project_id}` | admin, user (viewer → 403) | – | ✅ |
| 26 | POST | `/api/projects/{project_id}/rename` | admin, user (viewer → 403) | ProjectRenameRequest | ✅ |
| 27 | POST | `/api/projects/{project_id}/clear-data` | admin, user (viewer → 403) | ProjectClearDataRequest | ✅ |
| 28 | GET | `/api/projects/{project_id}/export-info` | přihlášený / host (čtení) | – | ✅ |
| 29 | GET | `/api/projects/{project_id}/export` | přihlášený / host (čtení) | – | ✅ |
| 30 | POST | `/api/projects/import/inspect` | admin, user (viewer → 403) | form inspect_project_import | ✅ |
| 31 | POST | `/api/projects/import` | admin, user (viewer → 403) | form import_project | ✅ |
| 32 | GET | `/api/stats` | přihlášený / host (čtení) | – | ✅ |
| 33 | GET | `/api/files` | přihlášený / host (čtení) | – | ✅ |
| 34 | POST | `/api/files/upload` | admin, user (viewer → 403) | form upload_files | ✅ |
| 35 | DELETE | `/api/files/{filename}` | admin, user (viewer → 403) | – | ✅ |
| 36 | GET | `/api/files/{project}/{filename}/view` | přihlášený / host (čtení) | – | ✅ |
| 37 | GET | `/api/files/{project}/{filename}/preview` | přihlášený / host (čtení) | – | ✅ |
| 38 | POST | `/api/projects/{project}/reindex` | admin, user (viewer → 403) | – | ✅ |
| 39 | POST | `/api/files/upload-csv` | admin, user (viewer → 403) | form upload_csv | ✅ |
| 40 | GET | `/api/outputs` | přihlášený / host (čtení) | – | ✅ (role-matice + UI síť) |
| 41 | DELETE | `/api/outputs/{filename}` | admin, user (viewer → 403) | – | ✅ (role-matice + UI síť) |
| 42 | POST | `/api/generate-script` | admin, user (viewer → 403) | GenerateScriptRequest | ✅ |
| 43 | POST | `/api/generate-audio` | admin, user (viewer → 403) | GenerateAudioRequest | ✅ |
| 44 | POST | `/api/generate-subtitles` | admin, user (viewer → 403) | GenerateSubtitlesRequest | ✅ (role-matice + UI síť) |
| 45 | POST | `/api/generate-notes` | admin, user (viewer → 403) | GenerateNotesRequest | ✅ |
| 46 | GET | `/api/notes` | přihlášený / host (čtení) | – | ✅ |
| 47 | GET | `/api/notes/{filename}` | přihlášený / host (čtení) | – | ✅ |
| 48 | DELETE | `/api/notes/{filename}` | admin, user (viewer → 403) | – | ✅ |
| 49 | GET | `/api/flashcards-prompts` | přihlášený / host (čtení) | – | ✅ |
| 50 | POST | `/api/generate-flashcards` | admin, user (viewer → 403) | GenerateFlashcardsRequest | ✅ |
| 51 | GET | `/api/flashcards` | přihlášený / host (čtení) | – | ✅ |
| 52 | GET | `/api/flashcards/export-all` | přihlášený / host (čtení) | – | ✅ |
| 53 | GET | `/api/flashcards/{filename}` | přihlášený / host (čtení) | – | ✅ |
| 54 | DELETE | `/api/flashcards/{filename}` | admin, user (viewer → 403) | – | ✅ |
| 55 | POST | `/api/cancel-batch` | admin, user (viewer → 403) | CancelBatchRequest | ✅ |
| 56 | POST | `/api/process-batch` | admin, user (viewer → 403) | PodcastBatchRequest | ✅ |
| 57 | POST | `/api/process-notes-batch` | admin, user (viewer → 403) | NotesBatchRequest | ✅ |
| 58 | POST | `/api/process-flashcards-batch` | admin, user (viewer → 403) | FlashcardsBatchRequest | ✅ |
| 59 | POST | `/api/tests/generate` | admin, user (viewer → 403) | GenerateTestRequest | ✅ |
| 60 | POST | `/api/tests/generate-more` | admin, user (viewer → 403) | GenerateMoreTestsRequest | ✅ |
| 61 | GET | `/api/tests` | přihlášený / host (čtení) | – | ✅ |
| 62 | GET | `/api/tests/{filename}` | přihlášený / host (čtení) | – | ✅ |
| 63 | DELETE | `/api/tests/{filename}` | admin, user (viewer → 403) | – | ✅ |
| 64 | POST | `/api/tests/{filename}/result` | admin, user (viewer → 403) | object | ✅ |
| 65 | POST | `/api/tests/evaluate-open-answer` | kdokoli přihlášený vč. viewer/host | EvaluateOpenAnswerRequest | ✅ |
| 66 | GET | `/api/medulingo/overview` | přihlášený / host (čtení) | – | ✅ |
| 67 | GET | `/api/medulingo/question/{question_id}` | přihlášený / host (čtení) | – | ✅ |
| 68 | POST | `/api/medulingo/generate-pack` | admin, user (viewer → 403) | MedulingoGeneratePackRequest | ✅ |
| 69 | POST | `/api/medulingo/complete` | admin, user (viewer → 403) | MedulingoCompleteRequest | ✅ |
| 70 | POST | `/api/chat/completions` | admin, user (viewer → 403) | ChatCompletionRequest | ✅ |
| 71 | GET | `/api/chat/threads` | přihlášený / host (čtení) | – | ✅ |
| 72 | POST | `/api/chat/threads` | admin, user (viewer → 403) | ChatThreadCreateRequest | ✅ |
| 73 | GET | `/api/chat/threads/{thread_id}` | přihlášený / host (čtení) | – | ✅ |
| 74 | PATCH | `/api/chat/threads/{thread_id}` | admin, user (viewer → 403) | ChatThreadUpdateRequest | ✅ |
| 75 | DELETE | `/api/chat/threads/{thread_id}` | admin, user (viewer → 403) | – | ✅ |
| 76 | POST | `/api/chat/threads/{thread_id}/pin` | admin, user (viewer → 403) | – | ✅ |
| 77 | GET | `/api/chat/threads/{thread_id}/export` | přihlášený / host (čtení) | – | ✅ |
| 78 | GET | `/api/projects/{project_id}/messages` | přihlášený / host (čtení) | – | ✅ |
| 79 | DELETE | `/api/projects/{project_id}/messages` | admin, user (viewer → 403) | – | ✅ |
| 80 | GET | `/api/projects/{project_id}/chat/export` | přihlášený / host (čtení) | – | ✅ |
| 81 | GET | `/api/projects/{project_id}/planner` | přihlášený / host (čtení) | – | ✅ |
| 82 | POST | `/api/projects/{project_id}/planner` | admin, user (viewer → 403) | object | ✅ |
| 83 | GET | `/api/projects/{project_id}/questions` | přihlášený / host (čtení) | – | ✅ |
| 84 | POST | `/api/projects/{project_id}/questions` | admin, user (viewer → 403) | object | ✅ |
| 85 | POST | `/api/projects/{project_id}/ai-classify-questions` | admin, user (viewer → 403) | – | ✅ |
| 86 | POST | `/api/lessons/generate` | admin, user (viewer → 403) | form generate_lesson_endpoint | ✅ |
| 87 | GET | `/api/lessons` | přihlášený / host (čtení) | – | ✅ |
| 88 | GET | `/api/lessons/{project_id}` | přihlášený / host (čtení) | – | ✅ |
| 89 | DELETE | `/api/lessons/{project_id}` | admin, user (viewer → 403) | – | ✅ |
| 90 | POST | `/api/print/prepare` | kdokoli přihlášený vč. viewer/host | PrintPrepareRequest | ✅ |
| 91 | GET | `/print_preview/{doc_id}` | přihlášený / host (čtení) | – | ✅ |

## Příloha B – Automatizované kontroly (212, surový výstup skriptů)

Kontroly běžely proti izolovanému serveru. Tokeny relací a cesty k dočasnému adresáři jsou redigované. ✅ 165 · ❌ 38 · ⚠️ 9. Jeden scénář může patřit k více nálezům. Některé ❌ jsou očekávané chování, které test zkoumal (např. tiché přijetí nepovoleného souboru).

| Modul | Prvek / endpoint | Scénář | Výsledek | Důkaz (zkráceno) |
|---|---|---|---|---|
| auth | GET /api/auth/status | čerstvá instance → needs_setup | ✅ | 200 {"authenticated": false, "is_guest": false, "needs_setup": true, "allow_registration": true, "allow_guest": false, "shared_api_keys": true, "shared_projects": true, "user": null} |
| auth | middleware | API bez přihlášení při needs_setup → 401 needs_setup | ✅ | 401 {"detail": "Systém vyžaduje prvotní nastavení administrátora.", "needs_setup": true} |
| auth | POST /api/auth/setup | krátké jméno (2 znaky) → 400 | ✅ | 400 {"detail": "Uživatelské jméno musí mít alespoň 3 znaky."} |
| auth | POST /api/auth/setup | slabé/krátké heslo → 400 | ✅ | 400 {"detail": "Heslo musí mít alespoň 6 znaků."} |
| auth | POST /api/auth/setup | nepovolené znaky v username → 400 | ✅ | 400 {"detail": "Uživatelské jméno smí obsahovat jen písmena, číslice a znaky _ . - @ (nejvýše 64 znaků)."} |
| auth | POST /api/auth/setup | platný setup → 200 + cookie | ✅ | 200 {"status": "ok", "user": {"id": 1, "username": "qaadmin", "email": "a@b.cz", "role": "admin", "status": "approved", "created_at": "2026-10-25T22:58:04.180326"}, "token": "‹redigováno›"} |
| auth | POST /api/auth/setup | odpověď nevrací session token v těle (HttpOnly cookie) | ⚠️ | tělo obsahuje klíč token |
| auth | POST /api/auth/setup | druhý setup po existenci admina → odmítnut | ✅ | 400 {"detail": "Administrátorský účet již byl vytvořen. Další registrace podléhají běžnému schválení."} |
| auth | POST /api/auth/login | správné heslo → 200 | ✅ | 200 {"status": "ok", "user": {"id": 1, "username": "qaadmin", "email": "a@b.cz", "role": "admin", "status": "approved", "created_at": "2026-10-25T22:58:04.180326", "last_login": "2026-10-25T22:58:04.230017"}, "token": "t |
| auth | POST /api/auth/login | chybné heslo → 401 | ✅ | 401 {"detail": "Nesprávné uživatelské jméno nebo heslo."} |
| auth | POST /api/auth/login | neexistující uživatel → 401 (stejná hláška) | ✅ | 401 {"detail": "Nesprávné uživatelské jméno nebo heslo."} |
| auth | GET /api/auth/status | přihlášený admin | ✅ | 200 {"authenticated": true, "is_guest": false, "needs_setup": false, "allow_registration": true, "allow_guest": false, "shared_api_keys": true, "shared_projects": true, "user": {"id": 1, "username": "qaadmin", "email": " |
| auth | POST /api/auth/register | registrace usera → pending | ✅ | 200 {"status": "pending", "message": "Vaše žádost o registraci byla úspěšně odeslána. Účet musí před prvním přihlášením schválit administrátor serveru."} |
| auth | POST /api/auth/register | registrace userb → pending | ✅ | 200 {"status": "pending", "message": "Vaše žádost o registraci byla úspěšně odeslána. Účet musí před prvním přihlášením schválit administrátor serveru."} |
| auth | POST /api/auth/register | registrace viewer1 → pending | ✅ | 200 {"status": "pending", "message": "Vaše žádost o registraci byla úspěšně odeslána. Účet musí před prvním přihlášením schválit administrátor serveru."} |
| auth | POST /api/auth/register | registrace pend1 → pending | ✅ | 200 {"status": "pending", "message": "Vaše žádost o registraci byla úspěšně odeslána. Účet musí před prvním přihlášením schválit administrátor serveru."} |
| auth | POST /api/auth/register | registrace blk1 → pending | ✅ | 200 {"status": "pending", "message": "Vaše žádost o registraci byla úspěšně odeslána. Účet musí před prvním přihlášením schválit administrátor serveru."} |
| auth | POST /api/auth/register | duplicitní username → 400 | ✅ | 400 {"detail": "Uživatel se jménem 'usera' již existuje. Zvolte prosím jiné jméno."} |
| auth | POST /api/auth/register | username lišící se jen velikostí písmen | ✅ | 400 {"detail": "Uživatel se jménem 'UserA' již existuje. Zvolte prosím jiné jméno."} |
| auth | POST /api/auth/login | pending uživatel se nepřihlásí | ✅ | 401 {"detail": "Váš účet čeká na schválení administrátorem serveru. Jakmile bude schválen, budete se moci přihlásit."} |
| admin | GET /api/auth/admin/pending | výpis čekajících | ✅ | 200 {"pending": [{"id": 2, "username": "usera", "email": "usera@x.cz", "role": "user", "status": "pending", "created_at": "2026-10-25T22:58:04.317813"}, {"id": 3, "username": "userb", "email": "userb@x.cz", "role": "user |
| admin | POST approve | schválení usera jako user | ✅ | 200 {"status": "ok", "message": "Účet byl úspěšně schválen s rolí: Uživatel.", "role": "user"} |
| admin | POST approve | schválení userb jako user | ✅ | 200 {"status": "ok", "message": "Účet byl úspěšně schválen s rolí: Uživatel.", "role": "user"} |
| admin | POST approve | schválení viewer1 jako viewer | ✅ | 200 {"status": "ok", "message": "Účet byl úspěšně schválen s rolí: Pozorovatel.", "role": "viewer"} |
| admin | POST approve | schválení blk1 jako user | ✅ | 200 {"status": "ok", "message": "Účet byl úspěšně schválen s rolí: Uživatel.", "role": "user"} |
| admin | POST approve | schválení s rolí admin přes query (nečekaná role) | ✅ | 200 {"status": "ok", "message": "Účet byl úspěšně schválen s rolí: admin.", "role": "admin"} |
| admin | POST approve | neplatná role superuser → 400 | ✅ | 404 {"detail": "Čekající uživatel nebyl nalezen."} |
| admin | POST approve | neexistující id → 404 | ✅ | 404 {"detail": "Čekající uživatel nebyl nalezen."} |
| admin | POST reject | zamítnutí už schváleného uživatele → 404 | ✅ | 404 {"detail": "Čekající uživatel nebyl nalezen."} |
| auth | POST /api/auth/login | schválený user/viewer se přihlásí | ✅ |  |
| admin | GET /api/auth/admin/users | běžný user → 403 | ✅ | 403 {"detail": "Tato akce vyžaduje administrátorská oprávnění."} |
| admin | POST approve | viewer volá admin endpoint (výjimka /api/auth/*) → 403 z require_admin | ✅ | 403 {"detail": "Tato akce vyžaduje administrátorská oprávnění."} |
| admin | POST change-role | admin si nemůže odebrat roli | ✅ | 400 {"detail": "Nemůžete odebrat roli administrátora svému vlastnímu účtu."} |
| admin | POST change-role | neplatná role → 400 | ✅ | 400 {"detail": "Neplatná uživatelská role."} |
| admin | POST change-role | user → viewer | ✅ | 200 {"status": "ok", "message": "Role byla úspěšně změněna na: Pozorovatel", "role": "viewer"} |
| roles | viewer zápis | po změně role na viewer → zápis 403 | ✅ | 403 {"detail": "Režim pozorovatele: Nemáte oprávnění generovat nový obsah, nahrávat ani mazat data. Můžete pouze procházet a studovat již vytvořené materiály.", "role": "viewer"} |
| roles | změna role | změna role se projeví okamžitě v existující relaci | ✅ | 200 {"project": "blkproj", "owner_id": 6} |
| admin | POST change-role | neexistující uživatel → 400/404 | ✅ | 400 {"detail": "Uživatel nebyl nalezen."} |
| admin | POST toggle-status | zablokování | ✅ | 200 {"status": "ok", "message": "Účet uživatele byl úspěšně zablokován.", "new_status": "disabled"} |
| admin | POST toggle-status | zablokovaný uživatel: existující relace zneplatněna | ✅ | 401 {"detail": "Přístup vyžaduje přihlášení.", "authenticated": false} |
| admin | POST toggle-status | zablokovaný se nepřihlásí | ✅ | 401 {"detail": "Váš účet byl zablokován. Kontaktujte administrátora."} |
| admin | POST toggle-status | odblokování | ✅ | 200 {"status": "ok", "message": "Účet uživatele byl úspěšně odblokován.", "new_status": "approved"} |
| admin | POST toggle-status | po odblokování přihlášení OK | ✅ | 200 {"status": "ok", "user": {"id": 6, "username": "blk1", "email": "blk1@x.cz", "role": "user", "status": "approved", "created_at": "2026-10-25T22:58:04.454798", "last_login": "2026-10-25T22:58:45.318896"}, "token": "J6 |
| admin | POST toggle-status | admin nezablokuje sám sebe | ✅ | 400 {"detail": "Nemůžete zablokovat svůj vlastní administrátorský účet."} |
| admin | POST toggle-status | toggle u čekajícího (pending) účtu nesmí obejít schválení | ❌ | 200 {"status": "ok", "message": "Účet uživatele byl úspěšně odblokován.", "new_status": "approved"} |
| admin | POST reject | zamítnutí čekajícího | ✅ | 200 {"status": "ok", "message": "Žádost byla zamítnuta."} |
| admin | POST reject | zamítnutý se nepřihlásí | ✅ | 401 {"detail": "Vaše žádost o registraci byla administrátorem zamítnuta."} |
| admin | POST reject | zamítnutý se může znovu zaregistrovat stejným jménem? | ⚠️ | 400 {"detail": "Uživatel se jménem 'rej1' již existuje. Zvolte prosím jiné jméno."} |
| admin | DELETE users/{id} | smazání uživatele | ✅ | 200 {"status": "ok", "message": "Uživatel byl úspěšně smazán."} |
| admin | DELETE users/{id} | relace smazaného uživatele neplatná | ✅ | 401 {"detail": "Přístup vyžaduje přihlášení.", "authenticated": false} |
| admin | DELETE users/{id} | admin nesmaže sám sebe | ✅ | 400 {"detail": "Nemůžete smazat svůj vlastní administrátorský účet."} |
| admin | DELETE users/{id} | neexistující → 400/404 | ✅ | 400 {"detail": "Uživatel nebyl nalezen."} |
| auth | POST /api/auth/logout | odhlášení | ✅ | 200 {"status": "ok"} |
| auth | POST /api/auth/logout | token po odhlášení neplatný (server-side) | ✅ | 401 {"detail": "Přístup vyžaduje přihlášení.", "authenticated": false} |
| auth | cookie | neplatná cookie → 401 | ✅ | 401 {"detail": "Přístup vyžaduje přihlášení.", "authenticated": false} |
| auth | Bearer | Authorization: Bearer funguje | ✅ | 200 {"projects": ["blkproj", "del1proj"], "shared_projects": true, "is_admin": true} |
| auth | rate limit | 10 chybných pokusů user+IP → 11. je 429 | ✅ | [401, 401, 401, 401, 401, 401, 401, 401, 401, 401, 429] |
| auth | rate limit | během blokace ani správné heslo neprojde (429 + Retry-After) | ✅ | 429 {"detail": "Příliš mnoho neúspěšných pokusů o přihlášení. Zkuste to znovu za 15 min."} RA=900 |
| auth | rate limit | z jiné IP se uživatel přihlásí (blokace není per-username) | ✅ | 200 {"status": "ok", "user": {"id": 3, "username": "userb", "email": "userb@x.cz", "role": "user", "status": "approved", "created_at": "2026-10-25T22:58:04.352398", "last_login": "2026-10-25T22:59:16.309196"}, "token": " |
| auth | rate limit | 30 chybných pokusů z IP na různé účty → 31. je 429 | ✅ | [401, 401, 429] |
| auth | rate limit | IP blokace platí i pro správné heslo jiného účtu | ✅ | 429 {"detail": "Příliš mnoho neúspěšných pokusů o přihlášení. Zkuste to znovu za 15 min."} |
| admin | registration-toggle | vypnutí registrací | ✅ | 200 {"status": "ok", "allow_registration": false} |
| admin | registration-toggle | registrace při vypnutí → 400/403 | ✅ | 400 {"detail": "Registrace nových účtů je v současnosti administrátorem vypnuta."} |
| admin | registration-toggle | /api/auth/status odráží allow_registration=false | ✅ |  |
| admin | registration-toggle | řetězec místo bool → 422 (strict) | ❌ | 200 {"status": "ok", "allow_registration": false} |
| roles | host vypnutý | bez přihlášení /api/projects → 401 | ✅ |  |
| roles | host zapnutý | status: is_guest a role viewer | ✅ | {"authenticated": false, "is_guest": true, "needs_setup": false, "allow_registration": false, "allow_guest": true, "shared_api_keys": true, "shared_projects": true, "user": {"id": -1, "username": "hos |
| roles | host zapnutý | host čte seznam projektů | ✅ | 200 {"projects": ["blkproj", "del1proj"], "shared_projects": true, "is_admin": false} |
| roles | host zapnutý | host nesmí zapisovat (403) | ✅ | 403 {"detail": "Režim pozorovatele: Nemáte oprávnění generovat nový obsah, nahrávat ani mazat data. Můžete pouze procházet a studovat již vytvořené materiály.", "role": "viewer"} |
| roles | host zapnutý | host smí /api/print/prepare (výjimka dle SECURITY.md) | ✅ | 200 {"status": "ok", "doc_id": "0aa588e8ce", "url": "http://127.0.0.1:8765/print_preview/0aa588e8ce"} |
| roles | host zapnutý | host smí evaluate-open-answer | ✅ | 200 {"match_percentage": 18, "matched_key_points": [], "missing_key_points": ["arytmie"], "grade": "again", "feedback": "Odpověď nepokrývá většinu požadovaných klinických kritérií. Doporučeno zopakovat."} |
| roles | host zapnutý | host nesmí open-data-folder | ✅ | 403 {"detail": "Režim pozorovatele: Nemáte oprávnění generovat nový obsah, nahrávat ani mazat data. Můžete pouze procházet a studovat již vytvořené materiály.", "role": "viewer"} |
| roles | host zapnutý | GET /api/settings pro hosta (bez klíčů) | ✅ | 200 {"gemini_configured": false, "gemini_masked": "", "openai_configured": false, "openai_masked": "", "elevenlabs_configured": false, "elevenlabs_masked": "", "user_data_dir": "‹tmp›/qa-data", "i |
| roles | host zapnutý | host nesmí admin výpis | ✅ | 403 {"detail": "Tato akce vyžaduje administrátorská oprávnění."} |
| roles | host vypnutý znovu | po vypnutí host 401 | ✅ |  |
| admin | shared_api_keys-toggle | přepnutí na OFF se projeví ve status | ✅ | 200 {"status": "ok", "shared_api_keys": false} |
| admin | shared_projects-toggle | přepnutí na OFF se projeví ve status | ✅ | 200 {"status": "ok", "shared_projects": false} |
| admin | guest-toggle | běžný user nesmí přepínat → 403 | ✅ | 403 {"detail": "Tato akce vyžaduje administrátorská oprávnění."} |
| projekty | POST /api/projects | prázdný název → 400 | ✅ | 400 {"detail": "Název projektu je prázdný."} |
| projekty | POST /api/projects | jen mezery → 400 | ❌ | 200 {"project": "", "owner_id": 1} |
| projekty | POST /api/projects | path traversal v názvu sanitizován | ✅ | 200 {"project": ".._evil", "owner_id": 1} |
| projekty | POST /api/projects | 300znakový název → odmítnout nebo zkrátit (limit FS 255 B) | ❌ | 500 Internal Server Error |
| projekty | POST /api/projects | projekt s prefixem lekce_ se vytvoří, ale ve výpisu chybí | ❌ | 200 {"project": "lekce_skryty", "owner_id": 1} \| v seznamu: False |
| projekty | POST /api/projects | projekt začínající tečkou se vytvoří, ale ve výpisu chybí | ❌ | 200 {"project": ".hidden", "owner_id": 1} \| v seznamu: False |
| projekty | POST /api/projects | číslo místo řetězce → 422 | ✅ | 422 {"detail": [{"type": "string_type", "loc": ["body", "name"], "msg": "Input should be a valid string", "input": 123}]} |
| projekty | POST /api/projects | duplicitní název → konflikt (409/400) | ⚠️ | 200 {"project": "kardio", "owner_id": 1} |
| projekty | GET /api/notes?project= | výpis poznámek projektu 'kardio' neobsahuje poznámky 'kardio_2' | ❌ | {"notes": [{"filename": "kardio_2_Fibrilace.md", "title": "kardio_2_Fibrilace", "mtime": 1792965607.9195936, "size": 16}, {"filename": "kardio_Fibrilace.md", "title": "kardio_Fibrilace", "mtime": 1792 |
| projekty | POST rename | přejmenování 'kardio' nepřejmenuje výstupy projektu 'kardio_2' | ❌ | ['kardio_new_2_Fibrilace.md', 'kardio_new_Fibrilace.md'] |
| projekty | POST rename | přejmenování na existující název → 400 | ✅ | 400 {"detail": "Projekt s názvem 'kardio_2' již existuje."} |
| projekty | POST rename | neexistující projekt → 404 | ✅ | 404 {"detail": "Původní projekt 'neexistuje' nebyl nalezen."} |
| projekty | POST rename | stejný název → unchanged | ✅ | 200 {"status": "unchanged", "project": "kardio_new"} |
| projekty | POST rename | prázdný nový název → 400 | ✅ | 400 {"detail": "Nový název projektu nesmí být prázdný."} |
| projekty | POST rename | chybějící new_name → 400 (ne 'None') | ✅ | 400 {"detail": "Nový název projektu nesmí být prázdný."} |
| projekty | DELETE /api/projects/{id} | smazání 'ab' nesmaže výstupy projektu 'ab_cd' | ❌ | 200 {"status": "deleted", "project": "ab", "deleted_outputs": {"notes": 2, "flashcards": 0, "tests": 0, "audio": 0}} \| zbylo: ['kardio_new_2_Fibrilace.md', 'kardio_new_Fibrilace.md', 'kardio_new_X.md'] |
| projekty | DELETE /api/projects/{id} | neexistující → 404 | ✅ | 404 {"detail": "Projekt nebyl nalezen."} |
| projekty | POST clear-data | clear_notes smaže jen poznámky | ✅ |  |
| projekty | POST clear-data | clear_audio/tests/flashcards smažou příslušné soubory | ✅ |  |
| projekty | POST clear-data | neexistující projekt → 404 | ✅ | 404 {"detail": "Projekt nebyl nalezen."} |
| roles | privátní režim | user A vytvoří privA (vlastník A) | ✅ | 200 {"project": "privA", "owner_id": 2} |
| roles | privátní režim | user B nevidí privA ve výpisu | ✅ |  |
| roles | privátní režim IDOR | B: GET /api/files?project=privA → 403 | ✅ | 403 {"detail": "Nemáte oprávnění pracovat s cizím privátním projektem."} |
| roles | privátní režim IDOR | B nepřejmenuje privA | ✅ | 403 {"detail": "Nemáte oprávnění přejmenovat cizí privátní projekt."} |
| roles | privátní režim IDOR | B nesmaže privA | ✅ | 403 {"detail": "Nemáte oprávnění smazat cizí privátní projekt."} |
| roles | privátní režim IDOR | B nesmí převzít privA založením projektu se stejným názvem | ❌ | create: 200 {"project": "privA", "owner_id": 3} \| B files: 200 \| A files: 403 |
| roles | privátní režim | viewer vidí všechny projekty (dle SECURITY.md) | ✅ |  |
| roles | smazaný uživatel | projekt smazaného uživatele v privátním režimu není přístupný ostatním studentům | ✅ | B files del1proj: 403, v seznamu B: False |
| materiály | POST /api/files/upload | upload 6 povolených typů najednou | ✅ | 200 {"filenames": ["kardio.txt", "kardio_text.pdf", "sken.pdf", "nefro.docx", "pneumo.pptx", "Kardiologie_přehled_č._1.txt"]} |
| materiály | POST /api/files/upload | nepovolená přípona → srozumitelná chyba (4xx), ne tiché 200 s [] | ⚠️ | 200 {"filenames": []} |
| materiály | POST /api/files/upload | obrázek PNG (nepodporovaný) → chyba | ⚠️ | 200 {"filenames": []} |
| materiály | POST /api/files/upload | prázdný soubor → odmítnout nebo varovat | ⚠️ | 200 {"filenames": ["prazdny.txt"]} |
| materiály | POST /api/files/upload | název s HTML znaky sanitizován | ✅ | 200 {"filenames": ["xss_img_src_x_onerror_alert_1_.txt"]} |
| materiály | POST /api/files/upload | 201 MB > limit 200 MB → 413 | ✅ | 413 {"detail": "Soubor velky.txt překračuje povolenou velikost 200 MB."} (0.6s) |
| materiály | POST /api/files/upload | filename ../../evil.txt nezapíše mimo projekt | ✅ | 200 {"filenames": ["evil.txt"]} |
| materiály | POST /api/files/upload | project=../../outside nezapíše mimo uploads | ✅ | 200 {"filenames": ["a.txt"]} |
| materiály | POST /api/files/upload | upload do neexistujícího projektu | ✅ | 200 {"filenames": ["a.txt"]} \| vznikl projekt: True |
| materiály | POST /api/files/upload | dva různé názvy mapované na stejný bezpečný název se nepřepíšou potichu | ⚠️ | 200 {"filenames": ["a_b.txt", "a_b.txt"]} |
| materiály | GET /api/files | výpis obsahuje nahrané soubory | ✅ | ['kardio_text.pdf', 'Kardiologie_přehled_č._1.txt', 'xss_img_src_x_onerror_alert_1_.txt', 'a_b.txt', 'pneumo.pptx', 'prazdny.txt', 'kardio.txt', 'sken.pdf', 'nefro.docx', 'evil.txt'] |
| domů | GET /api/stats | files_count odpovídá počtu souborů | ✅ | 10 vs 10 |
| prohlížeč | GET view/preview | kardio.txt: view 200 text/plain; charset=utf-8, preview 200 | ✅ | {"filename": "kardio.txt", "project": "Kardiologie_č._1", "extension": "txt", "size_bytes": 442, "total_pages": 1, "sections_count": 1, "sections": [{"text": "K |
| prohlížeč | GET view/preview | kardio_text.pdf: view 200 application/pdf, preview 200 | ✅ | {"filename": "kardio_text.pdf", "project": "Kardiologie_č._1", "extension": "pdf", "size_bytes": 23185, "total_pages": 1, "sections_count": 1, "sections": [{"te |
| prohlížeč | GET view/preview | sken.pdf: view 200 application/pdf, preview 200 | ✅ | {"filename": "sken.pdf", "project": "Kardiologie_č._1", "extension": "pdf", "size_bytes": 25340, "total_pages": 1, "sections_count": 0, "sections": [], "raw_tex |
| prohlížeč | GET view/preview | nefro.docx: view 200 application/vnd.openxmlformats, preview 200 | ✅ | {"filename": "nefro.docx", "project": "Kardiologie_č._1", "extension": "docx", "size_bytes": 36701, "total_pages": 1, "sections_count": 1, "sections": [{"text": |
| prohlížeč | GET view/preview | pneumo.pptx: view 200 application/vnd.openxmlformats, preview 200 | ✅ | {"filename": "pneumo.pptx", "project": "Kardiologie_č._1", "extension": "pptx", "size_bytes": 28308, "total_pages": 1, "sections_count": 1, "sections": [{"text" |
| prohlížeč | GET view/preview | Kardiologie_přehled_č._1.txt: view 200 text/plain; charset=utf-8, preview 200 | ✅ | {"filename": "Kardiologie_přehled_č._1.txt", "project": "Kardiologie_č._1", "extension": "txt", "size_bytes": 442, "total_pages": 1, "sections_count": 1, "secti |
| prohlížeč | GET view | neexistující → 404 | ✅ | 404 {"detail": "Soubor nenalezen."} |
| prohlížeč | GET view | path traversal ..%2F → 404/400 | ✅ | 404 {"detail": "Not Found"} |
| materiály | mount /uploads | statický soubor dostupný adminovi | ✅ | 200 |
| materiály | mount /uploads | bez přihlášení 401 | ✅ | 401 |
| materiály | mount /uploads | /uploads/../auth.db nedostupné | ✅ | 404 |
| materiály | POST reindex | reindex projektu | ✅ | 200 {"status": "reindexing_started", "project": "Kardiologie_č._1", "files_count": 10} |
| materiály | DELETE /api/files/{fn} | smazání souboru | ✅ | 200 {"status": "success"} |
| materiály | DELETE /api/files/{fn} | opakované smazání → 404 | ✅ | 404 {"detail": "Soubor nenalezen."} |
| plánovač | POST questions | uložení otázek | ✅ | 200 {"status": "success", "project": "Kardiologie_č._1", "questions": [{"id": 1, "title": "Fibrilace síní", "topic": "Kardiologie"}, {"id": 2, "title": "Srdeční selhání <b>x</b>", "topic": "Kardiologie"}]} |
| plánovač | GET questions | načtení otázek po uložení | ✅ | 200 {"project": "Kardiologie_č._1", "questions": [{"id": 1, "title": "Fibrilace síní", "topic": "Kardiologie"}, {"id": 2, "title": "Srdeční selhání <b>x</b>", "topic": "Kardiologie"}]} |
| plánovač | POST questions | tělo není objekt → 4xx | ✅ | 422 {"detail": [{"type": "dict_type", "loc": ["body"], "msg": "Input should be a valid dictionary", "input": [1, 2]}]} |
| plánovač | POST questions | questions není seznam → 4xx | ✅ | 400 {"detail": "Otázky musí být seznam."} |
| plánovač | POST planner | uložení plánu | ✅ | 200 {"status": "success", "project": "Kardiologie_č._1", "planner": {"examDate": "", "startDate": "", "revisionDays": 14, "scheduleMode": "sequential", "questions": []}} |
| plánovač | GET planner | plán po uložení | ❌ | 200 {"project": "Kardiologie_č._1", "planner": {"examDate": "", "startDate": "", "revisionDays": 14, "scheduleMode": "sequential", "questions": []}} |
| roles | viewer | viewer nesmí uložit plán | ✅ | 403 {"detail": "Režim pozorovatele: Nemáte oprávnění generovat nový obsah, nahrávat ani mazat data. Můžete pouze procházet a studovat již vytvořené materiály.", "role": "viewer"} |
| domů | GET /api/stats | questions_count po uložení 2 otázek | ❌ | 200 {"project": "Kardiologie_č._1", "files_count": 9, "media_count": 0, "notes_count": 0, "flashcards_count": 0, "tests_count": 0, "lessons_count": 0, "chat_count": 0, "questions_count": 0} |
| plánovač | POST ai-classify-questions | bez Gemini klíče → srozumitelná chyba 4xx | ✅ | 400 {"detail": "Projekt neobsahuje žádné otázky ke klasifikaci."} |
| AI bez klíče | /api/generate-notes | chybí klíč → srozumitelná chyba (0.0s) | ❌ | 500 {"detail": "V materiálech nebyly nalezeny žádné podklady k této otázce."} |
| AI bez klíče | /api/generate-flashcards | chybí klíč → srozumitelná chyba (0.0s) | ❌ | 500 {"detail": "'NoneType' object is not a mapping"} |
| AI bez klíče | /api/generate-script | chybí klíč → srozumitelná chyba (0.0s) | ✅ | 400 {"detail": "Chybí parametry dotazu."} |
| AI bez klíče | /api/generate-audio | chybí klíč → srozumitelná chyba (0.0s) | ❌ | 500 {"detail": "400: Není nastaven OpenAI API klíč. Přejděte v horní liště do 'Nastavení ⚙️' a zadejte svůj API klíč."} |
| AI bez klíče | /api/tests/generate | chybí klíč → srozumitelná chyba (0.0s) | ❌ | 500 {"detail": "400: Není nastaven Google Gemini API klíč. Přejděte v horní liště do 'Nastavení ⚙️' a vložte svůj API klíč."} |
| AI bez klíče | /api/medulingo/generate-pack | chybí klíč → srozumitelná chyba (0.0s) | ✅ | 200 {"status": "success", "results": {"notes": {"status": "error", "error": "V materiálech nebyly nalezeny žádné podklady k této otázce."}, "cards": {"status": "error", "error": "V materiálech nebyly nalezeny žádné podkl |
| AI bez klíče | /api/settings/test-key | chybí klíč → srozumitelná chyba (0.0s) | ✅ | 200 {"valid": false, "message": "Klíč pro GEMINI není zadán."} |
| AI bez klíče | /api/settings/test-key | chybí klíč → srozumitelná chyba (0.2s) | ✅ | 200 {"valid": false, "message": "Gemini: neplatný nebo chybějící API klíč. Zkontrolujte soubor .env."} |
| kartičky | POST generate-flashcards | count=0 → 422/400 | ❌ | 500 {"detail": "'NoneType' object is not a mapping"} |
| kartičky | POST generate-flashcards | count=501 → 422/400 | ❌ | 500 {"detail": "V materiálech nebyly nalezeny žádné podklady k této otázce."} |
| AI | model allowlist | user + sdílené klíče + model mimo allowlist → 400 | ✅ | 400 {"detail": "Model 'gpt-9' není na tomto serveru povolen. Povolené modely: gemini-3.6-flash, gemini-3.5-flash, gemini-3.8-flash, gemini-flash-latest, gemini-pro-latest."} |
| kartičky | GET flashcards-prompts | seznam promptů | ✅ | 200 {"presets": [{"id": "standard", "name": "Standardní medicínské kartičky", "description": "Základní klinické kartičky pro internu a medicínské zkou |
| testy | evaluate-open-answer | okraj {"user_answer": "", "model_answer": "abc", "key_points": []} | ✅ | 200 {"match_percentage": 0, "matched_key_points": [], "missing_key_points": [], "grade": "again", "feedback": "Byla odevzdána prázdná odpověď."} |
| testy | evaluate-open-answer | okraj {"user_answer": "abc", "model_answer": "", "key_points": []} | ✅ | 200 {"match_percentage": 0, "matched_key_points": [], "missing_key_points": [], "grade": "again", "feedback": "Odpověď nepokrývá většinu požadovaných klinických kritérií. Doporučeno zopakovat."} |
| testy | evaluate-open-answer | okraj {"user_answer": "Fibrilace síní je arytmie", "model_answer": | ✅ | 200 {"match_percentage": 100, "matched_key_points": ["arytmie"], "missing_key_points": [], "grade": "easy", "feedback": "Výborná odpověď! Zahrnuje všechny klíčové body a medicínská kritéria."} |
| testy | evaluate-open-answer | okraj {} | ✅ | 200 {"match_percentage": 0, "matched_key_points": [], "missing_key_points": [], "grade": "again", "feedback": "Byla odevzdána prázdná odpověď."} |
| chat | POST threads | nové vlákno | ✅ | 200 {"status": "success", "thread": {"id": "thread_5056f3457b3d", "project_id": "Kardiologie____1", "title": "Vlákno <img src=x onerror=1>", "is_pinned": false, "created_at": "2026-10-25 23:01:55", "updated_at": "2026-10 |
| chat | PATCH threads | přejmenování | ✅ | 200 {"status": "success", "thread": {"id": "thread_5056f3457b3d", "project_id": "Kardiologie____1", "title": "Přejmenováno", "is_pinned": false, "created_at": "2026-10-25 23:01:55", "updated_at": "2026-10-25 22:01:55", " |
| chat | POST pin | připnutí | ✅ | 200 {"status": "success", "thread": {"id": "thread_5056f3457b3d", "project_id": "Kardiologie____1", "title": "Přejmenováno", "is_pinned": true, "created_at": "2026-10-25 23:01:55", "updated_at": "2026-10-25 22:01:55", "m |
| chat | GET threads | výpis obsahuje vlákno se změnami (název, pinned) | ✅ | [{"id": "thread_5056f3457b3d", "project_id": "Kardiologie____1", "title": "Přejmenováno", "is_pinned": true, "created_at": "2026-10-25 23:01:55", "updated_at": "2026-10-25 22:01:55", "message_count":  |
| chat | GET threads?q | fulltext v názvu | ✅ | 200 {"threads": [{"id": "thread_5056f3457b3d", "project_id": "Kardiologie____1", "title": "Přejmenováno", "is_pinned": true, "created_at": "2026-10-25 |
| chat | GET threads?q | fulltext case-insensitive s diakritikou (PŘEJM) | ⚠️ | 200 {"threads": []} |
| chat | GET thread export | export vlákna | ✅ | text/markdown; charset=utf-8 |
| chat | GET project chat export | export projektu | ❌ | text/plain; charset=utf-8 |
| chat | POST completions | bez klíče → SSE event error / 4xx | ❌ |  |
| domů | GET /api/stats | questions_count po uložení 2 otázek | ✅ | 200 {"project": "Interna", "files_count": 5, "media_count": 0, "notes_count": 0, "flashcards_count": 0, "tests_count": 0, "lessons_count": 0, "chat_count": 0, "questions_count": 2} |
| AI bez klíče | /api/generate-notes | ASCII projekt s indexem, chybí klíč → 4xx se srozumitelnou hláškou | ❌ | 500 {"detail": "400: Není nastaven Google Gemini API klíč. Přejděte v horní liště do 'Nastavení ⚙️' a vložte svůj API klíč."} |
| AI bez klíče | /api/generate-flashcards | ASCII projekt s indexem, chybí klíč → 4xx se srozumitelnou hláškou | ❌ | 500 {"detail": "'NoneType' object is not a mapping"} |
| AI bez klíče | /api/generate-script | ASCII projekt s indexem, chybí klíč → 4xx se srozumitelnou hláškou | ✅ | 400 {"detail": "Chybí parametry dotazu."} |
| AI bez klíče | /api/tests/generate | ASCII projekt s indexem, chybí klíč → 4xx se srozumitelnou hláškou | ❌ | 500 {"detail": "400: Není nastaven Google Gemini API klíč. Přejděte v horní liště do 'Nastavení ⚙️' a vložte svůj API klíč."} |
| kartičky | POST generate-flashcards | count=0 → 422/400 před voláním AI | ❌ | 500 {"detail": "'NoneType' object is not a mapping"} |
| kartičky | POST generate-flashcards | count=10000 → 422/400 před voláním AI | ❌ | 500 {"detail": "Nepodařilo se vytvořit žádné kartičky. Zkontrolujte spojení nebo opakujte dotaz."} |
| chat | POST completions | ASCII projekt bez klíče → SSE 'error' událost | ❌ | 200 |
| bezpečnost | GET /api/projects/{id}/export | viewer: project_id='..' nesmí exportovat celou datovou složku (auth.db, user_config.json) | ❌ | 200 296675 B, položky: ['uploads/chat_history.db', 'uploads/chat_history.db-shm', 'uploads/chat_history.db-wal', 'uploads/auth.db-wal', 'uploads/auth.db-shm', 'uploads/auth.db', 'uploads/generated_flashcards/kardio_new_F |
| bezpečnost | GET /api/projects/{id}/export | viewer: project_id='.' (všechny projekty v uploads) | ❌ | 200 položky: ['uploads/Interna/kardio_text.pdf', 'uploads/Interna/exam_planner.json', 'uploads/Interna/pneumo.pptx', 'uploads/Interna/kardio.txt', 'uploads/Interna/sken.pdf', 'uploads/Interna/nefro.docx', 'uploads/novy_p |
| bezpečnost | GET /api/projects/%2E%2E/export | anonymní host stáhne auth.db a převezme relaci admina | ❌ | export 200, 297188 B; admin tokenů v exportu: 10; GET admin/users s ukradeným tokenem: 200 |
| bezpečnost | DELETE /api/projects/{id} | student: DELETE /api/projects/%2E%2E nesmí smazat datovou složku | ❌ | 500 Internal Server Error \| po: ['chat_history.db', 'chat_history.db-shm', 'chat_history.db-wal'] |
| bezpečnost | POST /api/projects/import | student: project_name='..' + overwrite nesmí smazat datovou složku | ❌ | 200 {"status": "success", "project": "..", "source_files": ["a.txt"], "source_files_count": 1, "chunks_count": 0, "outputs": {"notes": 0, "flashcards": 0, "tests": 0, "audio": 0}, "message": "Projekt '..' byl úspěšně imp |
| bezpečnost | DELETE /api/lessons/{id} | student B nesmí přes /api/lessons smazat privátní projekt studenta A | ❌ | DELETE /api/projects: 403; DELETE /api/lessons: 200 {"status": "success", "project": "ProjStud"} \| složka existuje: False |
| role | všechny endpointy | anonym bez hosta → 401 (89 operací) | ✅ | [] |
| role | všechny zápisové endpointy | viewer → 403 (mimo výjimky SECURITY.md) | ✅ | [] |
| bezpečnost | /docs, /openapi.json | bez přihlášení nedostupné | ✅ | 401 401 |
| kartičky | GET /api/flashcards | výpis balíčků | ✅ | 200 {"decks": [{"filename": "Interna_Fibrilace_síní.json", "question": "Fibrilace síní", "count": 2, "mtime": 1792966115.8007555}]} |
| kartičky | GET /api/flashcards/{fn} | načtení balíčku | ✅ | 200 {"question": "Fibrilace síní", "project": "Interna", "cards": [{"front": "Lék volby\tpro FS?", "back": "Betablokátor\nnebo digoxin", "hint": "frek |
| kartičky | GET export-all | Anki TSV: každá karta = 1 řádek se 2 sloupci (tab uvnitř textu escapován) | ❌ | [0] |
| poznámky | GET /api/notes | výpis poznámek s titulem z METADATA | ✅ | 200 {"notes": [{"filename": "Interna_Fibrilace_síní.md", "title": "Interna_Fibrilace_síní", "mtime": 1792966115.800922, "size": 162}]} |
| poznámky | GET /api/notes/{fn} | načtení poznámky | ✅ | 200 {"filename": "Interna_Fibrilace_síní.md", "markdown": "# Fibrilace síní\n\nNepravidelný rytmus [1, s. 1]. $x^2$\n", "raw": "<!-- METADATA: {\"ques |
| testy | GET /api/tests | výpis testů | ✅ | 200 {"tests": [{"filename": "Interna_t1.json", "id": "Interna_t1", "title": "Test FS", "project": "Interna", "created_at": "", "updated_at": "", "diff |
| testy | POST result | uložení výsledku | ✅ | 200 {"status": "success", "test": {"id": "Interna_t1", "filename": "Interna_t1.json", "title": "Test FS", "project": "Interna", "mode": "instant", "questions": [{"id": 1, "type": "single_choice", "que |
| testy | GET test | výsledek po reloadu | ✅ | {"completed": true, "score": 1, "percentage": 50, "user_answers": {"1": ["A"]}} |
| testy | POST generate-more | bez klíče → 4xx | ❌ | 500 {"detail": "400: Není nastaven Google Gemini API klíč. Přejděte v horní liště do 'Nastavení ⚙️' a vložte svůj API klíč."} |
| medulingo | GET overview | přehled | ✅ | {"project": "Interna", "metrics": {"today_str": "2026-10-25", "exam_date": "", "study_days_remaining": 0, "net_study_days": 0, "total_questions": 2, "completed_questions": 0, "completed_today": 0, "questions_per_day": 2, |
| medulingo | GET question/{id} | detail otázky najde poznámky a kartičky | ❌ | {"error": "Otázka nenalezena v plánovači."} |
| medulingo | POST complete | dokončení otázky | ✅ | 200 {"status": "success", "is_completed": true, "completedDate": "2026-10-25", "grade": "A", "next_question_id": 2} |
| medulingo | POST complete | neexistující question_id → 404 | ⚠️ | 200 {"status": "success", "is_completed": true, "completedDate": "2026-10-25", "grade": "A", "next_question_id": null} |
| medulingo | GET question/{id} | neexistující → 404 | ❌ | 200 {"error": "Otázka nenalezena v plánovači."} |
| dávky | souběh | druhá dávka na stejném projektu za běhu → odmítnuta (409) | ✅ | 409 {"detail": "Pro tento projekt už běží dávka. Vyčkejte na její dokončení nebo ji nejprve zrušte."} |
| dávky | POST cancel-batch | zrušení | ✅ | 200 {"status": "cancelling", "batch_id": "d2eceff5-11ca-4a71-8a33-2687928adf4f"} |
| dávky | POST process-batch | otázka bez title nespadne celou dávkou (odmítnout nebo přeskočit) | ✅ | 400 {"detail": "Chybí otázky, prompt nebo projekt."} |
| projekty | GET export-info | info o exportu | ✅ | 200 {"project": "Interna", "source_files": [{"name": "kardio_text.pdf", "size": 23185}, {"name": "pneumo.pptx", "size": 28308}, {"name": "kardio.txt", "size": 442}, {"name": "sken.pdf", "size": 25340}, {"name": "nefro.do |
| projekty | GET export | balíček .medproj obsahuje materiály, plánovač a výstupy | ✅ | ['uploads/kardio_text.pdf', 'uploads/exam_planner.json', 'uploads/pneumo.pptx', 'uploads/kardio.txt', 'uploads/sken.pdf', 'uploads/nefro.docx', 'chroma_vectors.json', 'database.json', 'generated/notes/Interna_Fibrilace_s |
| projekty | POST import/inspect | inspect validního balíčku navrhne nový název při kolizi | ✅ | 200 {"status": "ok", "filename": "Interna.medproj", "project_name": "Interna", "suggested_name": "Interna_2", "exists": true, "has_vectors": true, "chunks_count": 4, "source_files": ["kardio_text.pdf", "pneumo.pptx", "ka |
| projekty | POST import | kolize názvu bez overwrite → 409 | ✅ | 409 {"detail": "Projekt 'Interna' již existuje. Zvolte jiný název nebo zaškrtněte možnost přepsat existující projekt."} |
| projekty | POST import | import jako kopie | ✅ | 200 {"status": "success", "project": "Interna_kopie", "source_files": ["kardio_text.pdf", "pneumo.pptx", "kardio.txt", "nefro.docx", "sken.pdf"], "source_files_count": 5, "chunks_count": 4, "outputs": {"notes": 1, "flash |
| projekty | POST import/inspect | corrupt.medproj → 400 se srozumitelnou hláškou | ✅ | 400 {"detail": "Nahraný soubor není platný archiv ZIP / .medproj."} |
| projekty | POST import/inspect | foreign.zip → 400 se srozumitelnou hláškou | ❌ | 200 {"status": "ok", "filename": "foreign.zip", "project_name": "foreign", "suggested_name": "foreign", "exists": false, "has_vectors": false, "chunks_count": 0, "source_files": [], "source_files_coun |
| projekty | POST import/inspect | empty.medproj → 400 se srozumitelnou hláškou | ✅ | 400 {"detail": "Nahraný soubor není platný archiv ZIP / .medproj."} |
| projekty | POST import | zip-slip položky (../) se nezapíší mimo projekt | ✅ | 200 {"status": "success", "project": "EvilTrav", "source_files": [], "source_files_count": 0, "chunks_count": 0, "outputs": {"notes": 0, "flashcards": 0, "tests": 0, "audio": 0}, "message": "Projekt ' |
| lekce | POST /api/lessons/generate | bez klíče → srozumitelná chyba (0.4s) | ❌ | 500 {"detail": "Gemini: neplatný nebo chybějící API klíč. Zkontrolujte soubor .env."} |
| lekce | POST /api/lessons/generate | prázdný titul → 400/422 | ✅ | 422 {"detail": [{"type": "missing", "loc": ["body", "title"], "msg": "Field required", "input": null}]} |
| lekce | GET /api/lessons/{id} | neexistující → 404 | ✅ | 404 {"detail": "Výuková lekce nenalezena."} |