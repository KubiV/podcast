# 🌐 Zpřístupnění AI MedStudio přes Cloudflare Tunnel na Raspberry Pi

Tento návod je přizpůsobený přesně pro vaši infrastrukturu na Raspberry Pi (`pi@malina:/srv/compose`).

Jelikož v `/srv/compose/cloudflared` již máte spuštěný **Cloudflare Tunnel**, stačí do něj aplikaci **AI MedStudio / Podcast** pouze nasměrovat.

---

## 🏗️ Jak to celé funguje

```
[ Internet (Mobil, iPad, Notebook kdekoli na světě) ]
                     │  (Zabezpečené HTTPS spojení)
                     ▼
             [ Cloudflare Edge ]
                     │  (Šifrovaný Cloudflare Tunnel)
                     ▼
┌─────────────────────────────────────────────────────────────┐
│ Raspberry Pi (malina)                                       │
│                                                             │
│  ┌─────────────────────────┐                                │
│  │ /srv/compose/cloudflared│                                │
│  │ Docker: cloudflared     │                                │
│  └────────────┬────────────┘                                │
│               │ směruje provoz na port 8000                  │
│               ▼                                             │
│  ┌─────────────────────────┐     ┌───────────────────────┐  │
│  │ /srv/compose/podcast    │────▶│ /srv/compose/podcast  │  │
│  │ Docker: aimedstudio     │     │ /data (nebo /srv/data)│  │
│  │ Port: 8000              │     └───────────────────────┘  │
│  └─────────────────────────┘                                │
└─────────────────────────────────────────────────────────────┘
```

---

## 🚀 Krok za krokem: Přidání do Cloudflare

Máte dvě možnosti podle toho, jak máte Cloudflare Tunnel nakonfigurovaný:

### Možnost A: Přes webové rozhraní Cloudflare Zero Trust (Doporučeno)

Pokud tunel spravujete přes webový dashboard Cloudflare:

1. Otevřete [one.dash.cloudflare.com](https://one.dash.cloudflare.com) a přihlaste se.
2. V levém menu přejděte na **Networks** ➔ **Tunnels**.
3. Klikněte na svůj aktivní tunel pro Raspberry Pi a zvolte **Configure** (nebo přímo klikněte na jeho název).
4. Přejděte na záložku **Public Hostname** a klikněte na **Add a public hostname**.
5. Vyplňte formulář:
   - **Subdomain:** např. `podcast` nebo `medstudio`
   - **Domain:** vaše doména (např. `vasedomena.cz`)
   - **Type:** `HTTP`
   - **URL:** 
     - Pokud běží `cloudflared` v režimu host network: `localhost:8000`
     - Pokud běží `cloudflared` v klasickém Docker bridge: zadejte LAN IP vaší maliny, např. `192.168.1.50:8000` (případně `host.docker.internal:8000`)
     - Pokud sdílí Docker síť s podcastem: `aimedstudio:8000`
6. V záložce **Additional application settings**:
   - V sekci **HTTP Settings** můžete zapnout *HTTP2 Support*.
7. Klikněte na **Save hostname**.
8. Během několika sekund je aplikace dostupná na `https://podcast.vasedomena.cz`!

---

### Možnost B: Přes konfigurační soubor `config.yml` na Pi

Pokud máte tunel konfigurovaný lokálně v souboru (např. v `/srv/compose/cloudflared/config.yml`):

1. Připojte se na Pi a otevřete konfiguraci:
   ```bash
   ssh pi@malina
   sudo nano /srv/compose/cloudflared/config.yml
   ```
2. V sekci `ingress:` přidejte pravidlo před závěrečné catch-all pravidlo (`http_status:404`):
   ```yaml
   ingress:
     # Pravidlo pro AI MedStudio
     - hostname: podcast.vasedomena.cz
       service: http://localhost:8000

     # Ostatní vaše služby...
     # - hostname: homarr.vasedomena.cz
     #   service: http://...

     # Závěrečné pravidlo (musí být vždy poslední):
     - service: http_status:404
   ```
3. Uložte soubor (`Ctrl+O`, `Enter`, `Ctrl+X`) a restartujte cloudflared:
   ```bash
   cd /srv/compose/cloudflared
   docker compose restart
   ```

---

### Možnost C: Pokud používáte Nginx Proxy Manager (`/srv/compose/npm`)

Ve vaší složce `/srv/compose` máte také `npm` (Nginx Proxy Manager). Pokud máte Cloudflare nastavený tak, že veškerý provoz směřuje do NPM:

1. Otevřete webové rozhraní NPM (obvykle port 81, např. `http://malina.local:81`).
2. Klikněte na **Hosts** ➔ **Proxy Hosts** ➔ **Add Proxy Host**.
3. **Details:**
   - **Domain Names:** `podcast.vasedomena.cz`
   - **Scheme:** `http`
   - **Forward Hostname / IP:** IP adresa Raspberry Pi (nebo název kontejneru v docker síti)
   - **Forward Port:** `8000`
   - Zaškrtněte: **Block Common Exploits** a **Websockets Support** (důležité pro streaming odpovědí generátoru).
4. **SSL:**
   - Zvolte Cloudflare certifikát nebo nechte Let's Encrypt, zapněte *Force SSL*.
5. Uložte.

---

## 🔒 Důležité: Zabezpečení přístupu z internetu a správa rolí (Plná kontrola)

Aplikace přístupná přes Cloudflare je dostupná z celého internetu. Má zabudovaný systém účtů se třemi rolemi a schvalováním administrátorem. **Oddělení dat mezi studenty a to, kdo platí AI, ale určují režimy sdílení – ve výchozím stavu jsou projekty i API klíče sdílené (viz bod 1.2 níže).** Před zveřejněním je projděte.

### 1. Uživatelské role v systému 👥
* **👑 Administrátor (`admin`):**
  - Plná práva nad celou instancí: všechny projekty, nastavení serveru, centrální API klíče.
  - Schvalování a zamítání registrací, změna rolí, blokování a mazání účtů, přepínače hosta, registrací a režimů sdílení.
* **🎓 Student (`user`):**
  - Tvorba obsahu: nahrávání materiálů, podcasty, poznámky, kartičky, testy, chat a lekce.
  - Nemá přístup do administrace ani ke schvalování uživatelů.
  - **K jakým projektům má přístup, určuje režim sdílení projektů (viz 1.2) – ve výchozím stavu ke všem.**
* **👁️ Pozorovatel (`viewer`, i nepřihlášený host):**
  - Čtení a poslech hotových materiálů **ve všech projektech** (v obou režimech sdílení).
  - Backend mu odmítne (403) všechny požadavky `POST`/`PUT`/`PATCH`/`DELETE` s výjimkou přihlášení/odhlášení (`/api/auth/*`), přípravy tisku (`/api/print/prepare`) a lokálního vyhodnocení otevřené odpovědi v testu (`/api/tests/evaluate-open-answer`, bez volání AI). Nemůže tedy nic generovat, nahrávat, měnit ani mazat a nečerpá AI tokeny.

### 1.2 Režimy sdílení a výchozí nastavení ⚠️
Role samy o sobě **neoddělují data jednotlivých studentů**. O tom rozhodují dva přepínače v **Nastavení ➔ Uživatelé & schvalování** (jen admin):

| Přepínač | Výchozí | Zapnuto (ON) | Vypnuto (OFF) |
|---|---|---|---|
| **Sdílené projekty** | **ON** | Každý přihlášený student může číst, **měnit i mazat všechny projekty** (včetně projektů admina). | Student pracuje jen s projekty, které sám založil (a s projekty bez vlastníka). Admin vidí vše, pozorovatel čte vše. |
| **Sdílené (centrální) API klíče** | **ON** | Generování všech uživatelů platí **klíče serveru** (náklady nese admin). Běžný uživatel smí volit jen modely z povoleného seznamu (`AIMEDSTUDIO_ALLOWED_MODELS`). | Každý uživatel používá vlastní klíče (BYOK). Admin bez vlastního klíče použije klíč serveru, ostatní bez klíče nemohou generovat. |

Další výchozí hodnoty: **registrace přes web zapnuté** (nový účet čeká na schválení adminem), **režim hosta vypnutý**.

> **Doporučení pro server dostupný z internetu:** pokud nechcete, aby si studenti navzájem viděli a mazali projekty, vypněte *Sdílené projekty*. Pokud nechcete platit generování za ostatní, vypněte *Sdílené API klíče*. Registrace vypněte, když nové účty nečekáte. Proměnnou `APP_PASSWORD` nepoužívejte – je zastaralá a kdokoli se znalostí hesla se přes HTTP Basic Auth přihlásí **jako administrátor**.

---

> Úplný bezpečnostní model (autorizace, klíče, limity a známá otevřená rizika) popisuje [docs/SECURITY.md](../SECURITY.md).

### 2. Integrovaný systém účtů, schvalování a hosté 🛡️
* **První spuštění (Prvotní setup):**
  Při prvním otevření webu vás systém automaticky vyzve k vytvoření **hlavního administrátorského účtu**. Tento účet je okamžitě aktivován a má plná práva nad celou instancí.
* **Zůstat přihlášený (Remember Me):**
  Při přihlášení stačí zaškrtnout volbu *Zůstat přihlášený*. Systém vytvoří 30denní relaci (HttpOnly cookie), takže se nemusíte přihlašovat pokaždé znovu. Bez této volby platí relace 1 den.
* **Režim nepřihlášeného hosta (ON/OFF přepínač):**
  - **Vypnuto (OFF - výchozí stav):** Návštěvníci bez přihlášení nemají přístup k ničemu (blokováno přihlašovací obrazovkou a kódem 401).
  - **Zapnuto (ON):** Návštěvníci mohou vstoupit na web bez přihlašování a automaticky získají roli **Pozorovatel**. Mohou číst a poslouchat materiály **všech projektů**, ale nemohou čerpat vaše API tokeny ani nic generovat.
* **Schvalování žádostí o registraci:**
  Návštěvník může odeslat žádost o registraci. Účet čeká ve stavu *Pending*. Administrátor v **Nastavení ➔ Uživatelé & schvalování** může jedním klikem:
  - `[🎓 Student]` – schválit účet s plnými právy pro tvorbu.
  - `[👁️ Pozorovatel]` – schválit účet pouze pro čtení a poslech.
  - `[❌ Zamítnout]` – žádost smazat a odmítnout.
* **Změna rolí a blokování uživatelů:**
  Administrátor může u kteréhokoliv uživatele v seznamu kdykoliv změnit roli (např. ze studenta na pozorovatele a naopak) nebo účet dočasně zablokovat/smazat.
* **Vypnutí registrací (ON/OFF přepínač):**
  Registrace jsou **ve výchozím stavu zapnuté** (každý nový účet čeká na schválení). Pokud nechcete, aby se kdokoliv mohl vůbec registrovat, v Nastavení přepněte přepínač *Povolit registraci nových účtů přes web* na **OFF**. Formulář pro žádosti o registraci se okamžitě uzamkne.

---

### 3. Doplňková vrstva: Cloudflare Access (Zero Trust) 🔐
Pokud chcete ještě druhou úroveň ochrany před samotným webem (přihlašování přes Google, GitHub nebo e-mailový kód OTP):
1. V Cloudflare Zero Trust přejděte na **Access** ➔ **Applications**.
2. Klikněte na **Add an application** ➔ **Self-hosted**.
3. Zadejte název `AI MedStudio` a doménu `podcast.vasedomena.cz`.
4. Vytvořte pravidlo (Policy), které povolí přístup pouze vašemu e-mailu.
5. Uložte. Nyní se k serveru nikdo nepřipojí dříve, než se prokáže Cloudflaru.


---

## 💡 Tipy pro Cloudflare

1. **Limit velikosti nahrávaných souborů (Upload Limit):**
   - Cloudflare ve bezplatné verzi omezuje velikost jednoho HTTP požadavku na **100 MB**.
   - Pokud nahráváte velmi objemná skripta či PDF učebnice větší než 100 MB, nahrajte je buď v lokální síti (`http://malina.local:8000`), nebo soubor rozdělte.
2. **Streaming a timeouty:**
   - AI MedStudio generuje dlouhé odpovědi a audio streamy. Cloudflare Tunnel podporuje streaming i WebSockets automaticky bez nutnosti měnit HTTP timeouty.
3. **PWA na mobilu a iPadu:**
   - Po otevření `https://podcast.vasedomena.cz` na iPhonu/iPadu v Safari klikněte na **Sdílet** ➔ **Přidat na plochu**. Aplikace se chová jako plnohodnotná nativní aplikace.
