# AI MedStudio – Bezpečnostní model

Dokument popisuje, jak aplikace řeší přihlášení, role, oddělení dat a API klíče. Obsahuje také doporučené nastavení pro server dostupný z internetu a známá otevřená rizika. Popisuje **současný kód** (stav po auditu a refaktoringu v `docs/audit/`). Při změně chování jej aktualizujte.

> **Hlášení zranitelností:** nezakládejte veřejné issue. Kontaktujte správce repozitáře soukromě, například přes GitHub Security Advisory, pokud je u repozitáře zapnutý.

---

## 1. Režimy nasazení

| Režim | Výchozí síťová adresa | Kdo k aplikaci přistupuje |
|---|---|---|
| Desktop (`desktop_app.py`) | `127.0.0.1` (volný port od 8000) | jen místní uživatel |
| Vývojový server (`python main.py` / `uvicorn`) | `HOST`, výchozí `127.0.0.1` | místní uživatel, případně LAN podle `HOST` |
| Docker (`docker-compose.yml`) | `${MEDSTUDIO_BIND_ADDRESS:-0.0.0.0}:8000` – **celá LAN** | všichni v síti, přes Cloudflare Tunnel i z internetu |

V Dockeru uvicorn důvěřuje hlavičkám `X-Forwarded-*` jen od `FORWARDED_ALLOW_IPS` (výchozí Docker sítě `172.16.0.0/12`). Pokud je aplikace dostupná jen přes reverzní proxy, nastavte `MEDSTUDIO_BIND_ADDRESS=127.0.0.1`.

---

## 2. Přihlášení a relace

- **Účty:** uživatelské jméno 3–64 znaků `[\w.@-]`. Heslo se ukládá jako PBKDF2-HMAC-SHA256 (200 000 iterací, 16bajtová náhodná sůl).
- **Relace:** náhodný token (`secrets.token_urlsafe(48)`) v cookie `medstudio_session` (`HttpOnly`, `SameSite=Lax`, `Secure` na HTTPS). Lze ho poslat i jako `Authorization: Bearer`. Platnost je 30 dní se „Zůstat přihlášený“, jinak 1 den.
- **První admin:** `/api/auth/setup` je veřejný, dokud neexistuje žádný účet. Vytvoření je atomické (`BEGIN IMMEDIATE`). **Kdo čerstvou instanci otevře první, stane se adminem.** Admina proto založte dřív, než instanci zpřístupníte.
- **Registrace:** ve výchozím stavu zapnutá. Nový účet čeká ve stavu *pending*, dokud ho admin neschválí jako studenta nebo pozorovatele.
- **Omezení pokusů:** neúspěšná přihlášení se počítají v okně 15 minut. Limit je 10 pro kombinaci uživatel + IP a 30 pro IP, pak následuje `429` s `Retry-After`. Stejný limit podle IP platí pro legacy Basic Auth.
- **Legacy `APP_PASSWORD`:** pokud je nastavená, HTTP Basic Auth s tímto heslem přihlásí **jako administrátor** (`legacy_admin`). Je zastaralá, nepoužívejte ji.
- **Veřejné cesty bez přihlášení:**
  - `/`, `/index.html`, `/health`, `/manifest.json`, ikony;
  - `/css/*`, `/js/*`, `/static/*`;
  - `/api/auth/{status,setup,login,register,logout}`.
  - Vše ostatní vrátí `401`, pokud není zapnutý režim hosta.

---

## 3. Role a autorizace

| Role | Popis |
|---|---|
| `admin` | plný přístup ke všem projektům, správě uživatelů, přepínačům a centrálním klíčům |
| `user` (student) | tvorba obsahu; přístup k projektům podle režimu sdílení projektů |
| `viewer` (pozorovatel) | čtení a poslech; backend vrátí `403` na každý `POST`/`PUT`/`PATCH`/`DELETE` kromě `/api/auth/*`, `/api/print/prepare` a `/api/tests/evaluate-open-answer` (lokální hodnocení bez AI) |
| host | nepřihlášený návštěvník s rolí `viewer`, jen při zapnutém režimu hosta (výchozí: vypnuto) |

### 3.1 Režimy sdílení (přepínače admina v Nastavení ➔ Uživatelé & schvalování)

| Přepínač | Výchozí | ON | OFF |
|---|---|---|---|
| Sdílené projekty (`shared_projects`) | **ON** | každý přihlášený čte a student i **mění a maže** všechny projekty | student pracuje jen s projekty, které vlastní, a s projekty bez vlastníka; admin vše; pozorovatel čte vše |
| Sdílené API klíče (`shared_api_keys`) | **ON** | generování všech platí klíče serveru | každý uživatel používá vlastní klíče (BYOK) |

### 3.2 Jak se přístup vynucuje (`core/authz.py`)
- **Projekty:** routery volají `require_project_access(projekt, write=…)`. Vlastník projektu se ukládá v `auth.db` (`project_ownership`) při založení.
- **Výstupy** (poznámky, kartičky, testy, audio) leží v plochých složkách s prefixem `{projekt}_`. Projekt se určí podle nejdelšího odpovídajícího názvu (`require_output_file_access`, `filter_accessible_output_files`).
- **Statické soubory:** `/uploads`, `/lessons-data`, `/audio` a `/notes-files` jdou přes `ProjectStaticFiles`, které kontroluje přístup ke každému souboru.
- **Chat:** vlákna se ověřují přes projekt vlákna (`require_thread_access`). Chat DB používá ASCII variantu názvu projektu, kterou authz mapuje zpět.
- **Živý log `/api/logs` (SSE):**
  - admin vidí vše;
  - události s projektem vidí ti, kdo smí projekt číst;
  - ostatní události vidí jen jejich původce.

---

## 4. API klíče a náklady

- **Výběr klíče** (`core/clients.py`), stejný pro všechna generování včetně chatu a lekcí:
  - sdílený režim: `user_config.json` → proměnná prostředí (`GEMINI_API_KEY` …);
  - per-user režim: vlastní klíč uživatele; admin bez klíče použije klíč serveru; ostatní bez klíče negenerují.
- **Ochrana sdíleného klíče:** běžný uživatel smí volit jen modely z `AIMEDSTUDIO_ALLOWED_MODELS` a vlastní systémový prompt chatu má limit 20 000 znaků.
- **Uložení:** centrální klíče jsou v `user_config.json`, per-user klíče v `auth.db`, obojí **v čitelné podobě** (viz otevřená rizika). API vrací klíče jen maskované.
- **Testy** běží s prázdnými klíči a zablokovanou sítí (`tests/__init__.py`).

---

## 5. Ochrana vstupů a výstupů

| Oblast | Opatření |
|---|---|
| Path traversal | `core/security.py` `safe_join` / `safe_filename` pro operace se soubory, úložiště testů přes `safe_join` |
| Upload a import | `core/uploads.py`: max. velikost souboru (`AIMEDSTUDIO_MAX_UPLOAD_MB`, výchozí 200 MB), archivu importu (`AIMEDSTUDIO_MAX_IMPORT_MB`, 2 048 MB), rozbaleného obsahu (`AIMEDSTUDIO_MAX_IMPORT_UNCOMPRESSED_MB`, 4 096 MB), max. 20 000 položek a kompresní poměr 200 (zip bomb). Import nepřepíše cizí projekt. |
| Těla požadavků | Pydantic modely v strict režimu (`core/request_models.py`), u hodnot špatného typu `422` |
| SQL | parametrizované dotazy, FTS dotaz se skládá funkcí `build_czech_fts_query` |
| XSS – AI výstup | markdown → `marked` → **DOMPurify** → `innerHTML`; bez DOMPurify se zobrazí jen text |
| XSS – hodnoty v HTML | `escapeHtml`, v inline handlerech `escapeJsStringAttr` |
| XSS – tisk | `/api/print/prepare` ukládá HTML až po allowlist sanitizaci (`core/html_sanitizer.py`). Úloh je nejvýše 200 (starší než 2 h se mažou). Prohlížeč na stroji serveru otevře jen požadavek z loopbacku bez `X-Forwarded-For`, tedy lokální desktopová aplikace. |
| Hlavičky | `Content-Security-Policy` pro HTML odpovědi (`core/security.py`: `default-src 'self'`, `object-src 'none'`, `frame-ancestors 'self'`, …); tiskový náhled má vlastní přísnější CSP. Další hlavičky (`X-Content-Type-Options`, `Referrer-Policy`) aplikace nenastavuje. |
| Knihovny z CDN | pinnuté verze, SRI u marked, DOMPurify a KaTeX |
| Docker image | `.dockerignore` vylučuje `.env*`, databáze, `user_config.json`, data a testy |

---

## 6. Doporučené nastavení pro server dostupný z internetu

1. Založte admina **před** zveřejněním (Cloudflare Tunnel, port forwarding).
2. Zvažte **Cloudflare Access** (Zero Trust) jako druhou vrstvu před aplikací ([návod](deployment/CLOUDFLARE_GUIDE.md)).
3. Pokud studenti nemají vidět a mazat projekty ostatních, vypněte **Sdílené projekty**.
4. Pokud nechcete platit generování za ostatní, vypněte **Sdílené API klíče**. Jinak zúžte `AIMEDSTUDIO_ALLOWED_MODELS`.
5. Když nečekáte nové účty, vypněte **registrace**. Režim hosta nechte vypnutý.
6. Nenastavujte `APP_PASSWORD`.
7. Za reverzní proxy nastavte `MEDSTUDIO_BIND_ADDRESS=127.0.0.1` a `FORWARDED_ALLOW_IPS` jen na adresu proxy.
8. Zálohujte `./data` (obsahuje databáze i klíče) a chraňte ji jako tajemství.

---

## 7. Známá otevřená rizika

Zdroj: [audit/AUDIT.md](audit/AUDIT.md) a [audit/CHANGELOG.md](audit/CHANGELOG.md). Opravy, které mění chování, čekají na rozhodnutí vlastníka.

| Riziko | Dopad |
|---|---|
| **Výchozí sdílené projekty a klíče, zapnuté registrace** | Nová instance bez úprav nastavení neodděluje data studentů a generování platí admin (viz 3.1) |
| **Výukové lekce bez vlastníka** | `GET/DELETE /api/lessons/{id}` nekontrolují vlastnictví: každý přihlášený lekce čte a student je smí smazat |
| **Import nenastaví vlastníka projektu** | V privátním režimu je importovaný projekt „bez vlastníka“, tedy přístupný všem studentům |
| **Pozorovatel čte všechny projekty** i v privátním režimu | Záměr návrhu, ale pozorovatel/host tak vidí materiály všech |
| **Klíče a tokeny relací v čitelné podobě** (S12) | Kdo získá `auth.db` nebo `user_config.json`, získá API klíče a platné relace |
| **`/api/settings/open-data-folder`** (S14) | Spustí `open`/`xdg-open` na **serveru** pro kteroukoli roli kromě pozorovatele |
| **Pomodoro nastavení v globálním `user_config.json`** (S13) | Uživatelé si navzájem přepisují nastavení |
| **CSP s `'unsafe-inline'`**, Tailwind Play CDN bez SRI | Inline handlery (~313) zatím brání přísnější CSP; Tailwind CDN nepodporuje CORS, a tedy ani SRI |
| **`t()` neescapuje parametry překladů** | Při vložení uživatelské hodnoty do překladu přes `innerHTML` hrozí XSS (žádné zneužitelné místo nebylo potvrzeno) |
| **Prohlížeč dokumentu v `chat.js`** escapuje jen `<` | Text s `"` rozbije atributy `data-*` (useknuté vyhledávání a kopírování). Jde o chybu zobrazení, ne o potvrzené XSS |
| **ID chat vláken nejsou validovaná** | ID s `/` rozbije URL `/api/chat/threads/{id}` (404) |
| **Kolize `chunk_id` mezi projekty** | ID chunku `{soubor}_chunk_{i}` nezávisí na projektu a je globálním klíčem `project_chunks_meta`. Při stejnojmenném souboru ve dvou projektech patří metadata prvnímu projektu a FTS druhého se při každé synchronizaci znovu přepisuje. Oprava vyžaduje migraci na klíč `(project_id, chunk_id)` |
| **`entrypoint.sh` fallback `chmod -R 777 /app/data`** (S17) | Když selže `chown`, data jsou čitelná pro všechny v kontejneru i na hostiteli |
| **Závislosti neprověřené na CVE** (S18) | `pip-audit` zatím nebyl spuštěn |
