# 📖 AI MedStudio & Podcast – Kompletní dokumentace pro server a Raspberry Pi (Docker)

AI MedStudio podporuje **dva rovnocenné režimy provozu**:
1. **Desktopová aplikace (Lokální standalone režim):** Spouští se lokálně na PC nebo Macu (`python desktop_app.py` nebo zabalená `.app`/`.exe`). Data zůstávají v počítači uživatele.
2. **Server / Self-hosted režim (Docker):** Běží nepřetržitě (24/7) na domácím serveru, Raspberry Pi nebo Synology NAS. Poskytuje centralizovaný přístup ze všech vašich zařízení (notebook, iPad, iPhone, Android) v síti i na cestách.

---

## 📑 Obsah
1. [Architektura a ukládání dat](#1-architektura-a-ukládání-dat)
2. [Nasazení na Raspberry Pi (Krok za krokem)](#2-nasazení-na-raspberry-pi-krok-za-krokem)
3. [Nasazení na Synology NAS](#3-nasazení-na-synology-nas)
4. [Aktualizace aplikace (SSH Deploy z Macu & Skript na Pi)](#4-aktualizace-aplikace-ssh-deploy-z-macu--skript-na-pi)
5. [Přístup z iPadu, tabletu a mobilu (PWA)](#5-přístup-z-ipadu-tabletu-a-mobilu-pwa)
6. [Vzdálený přístup přes Cloudflare Tunnel & Tailscale](#6-vzdálený-přístup-přes-cloudflare-tunnel--tailscale)
7. [Zabezpečení přístupu heslem](#7-zabezpečení-přístupu-heslem)
8. [Zálohování a obnova dat](#8-zálohování-a-obnova-dat)
9. [Řešení potíží (Troubleshooting)](#9-řešení-potíží-troubleshooting)


---

## 1. Architektura a ukládání dat

V Docker režimu je aplikace kompletně kontejnerizována. Všechny proměnné a perzistentní soubory jsou odděleny od systémového jádra:

```
[ Klientská zařízení ]
  ├── 💻 Notebook / PC (prohlížeč nebo desktop_app.py --server)
  ├── 📱 Mobilní telefon (PWA aplikace s ikonou)
  └── 📟 iPad / Tablet (PWA celoobrazovkový režim)
            │
            ▼  (HTTP :8000 přes Wi-Fi nebo Tailscale VPN)
┌─────────────────────────────────────────────────────────────┐
│ Raspberry Pi / Synology NAS                                 │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ Docker Kontejner (aimedstudio)                        │  │
│  │  • FastAPI Backend + Uvicorn                          │  │
│  │  • FFmpeg (zpracování a střih audia)                  │  │
│  │  • Multi-device SQLite (WAL režim)                    │  │
│  │  • ChromaDB (lokální RAG vektorová paměť)             │  │
│  └──────────────────────────┬────────────────────────────┘  │
│                             │ mapování svazku               │
│                             ▼                               │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ Hostitelský adresář: ./data                           │  │
│  │  ├── 📂 uploads/             (nahrávaná skripta, PDF) │  │
│  │  ├── 📂 generated_audio/     (MP3 podcasty a přednášky)│ │
│  │  ├── 📂 generated_notes/     (strukturované poznámky) │  │
│  │  ├── 📂 generated_flashcards/(kartičky Medulingo)     │  │
│  │  ├── 📂 generated_tests/     (cvičné testy a otázky)  │  │
│  │  ├── 📂 chroma_db/           (vektorové indexy)       │  │
│  │  ├── 📄 chat_history.db      (SQLite historie chatu)  │  │
│  │  └── 📄 user_config.json     (API klíče a konfigurace)│  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. Nasazení na Raspberry Pi (Krok za krokem)

Doporučený hardware: **Raspberry Pi 4 (4GB/8GB) nebo Raspberry Pi 5** s 64-bitovým Raspberry Pi OS (Debian Bookworm/Bullseye).

### Krok 2.1: Připojení přes SSH
Otevřete Terminál na svém Macu/PC a připojte se k Raspberry Pi:
```bash
ssh pi@raspberrypi.local
# Nebo zadejte IP adresu: ssh pi@192.168.1.50
```

### Krok 2.2: Instalace Dockeru a Docker Compose
Pokud ještě na Pi nemáte Docker, nainstalujte jej oficiálním skriptem:
```bash
# Stažení a instalace Docker engine
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh

# Povolení správy Dockeru pro běžného uživatele bez nutnosti 'sudo'
sudo usermod -aG docker $USER

# Načtení nové skupiny do stávající relace
newgrp docker
```
Ověřte instalaci příkazem:
```bash
docker compose version
```

### Krok 2.3: Umístění do složky serveru (/srv/compose)
Na vašem Raspberry Pi umístěte aplikaci do standardní složky `/srv/compose/podcast`:
```bash
cd /srv/compose
sudo git clone https://github.com/KubiV/podcast.git
sudo chown -R pi:pi podcast
cd podcast
```
*(Tip: Pokud jste na Macu, můžete celou instalaci provést na dálku jediným příkazem: `./deploy.sh --setup`!)*

### Krok 2.4: První sestavení a spuštění
Ve složce `/srv/compose/podcast` spusťte:
```bash
docker compose up -d --build
```
Docker stáhne base image pro architekturu ARM64, doinstaluje `ffmpeg`, knihovny a aplikaci spustí na pozadí.


### Krok 2.5: Otevření aplikace
Z libovolného zařízení na stejné Wi-Fi otevřete prohlížeč a přejděte na:
👉 **`http://raspberrypi.local:8000`** *(případně `http://<IP_ADRESA_PI>:8000`)*

---

## 3. Nasazení na Synology NAS

### Možnost A: Přes terminál (SSH)
1. V DSM povolte SSH: **Ovládací panel** > **Terminál a SNMP** > **Povolit službu SSH**.
2. Přihlaste se přes terminál: `ssh admin@ip-vaseho-nasu`.
3. Přejděte do složky Dockeru:
   ```bash
   cd /volume1/docker
   git clone https://github.com/KubiV/podcast.git medstudio
   cd medstudio
   docker compose up -d --build
   ```

### Možnost B: Přes grafické rozhraní Container Manager
1. Otevřete aplikaci **Container Manager** na Synology.
2. Vytvořte složku projektu v File Station: např. `/docker/medstudio`.
3. Nakopírujte soubory repozitáře do této složky.
4. V Container Manageru klikněte na **Projekt** > **Vytvořit**.
5. Zadejte název `medstudio`, jako cestu vyberte `/docker/medstudio`.
6. Dokončete průvodce. Kontejner se sestaví a spustí na portu `8000`.

---

## 4. Aktualizace aplikace (SSH Deploy z Macu & Skript na Pi)

Máte k dispozici dvě pohodlné cesty aktualizace:

### 4.1 Rychlé nasazení přímo z Macu přes SSH (`./deploy.sh`) ⚡
Při vývoji na Macu nemusíte každý drobný kód commitovat a pushovat na GitHub. V kořenovém adresáři na Macu spusťte:

```bash
# 1. Rychlá aktualizace (synchronizuje změněné soubory přes rsync a sestaví kontejner na Pi):
./deploy.sh

# 2. Aktualizace přes Git pull na Raspberry Pi:
./deploy.sh --git

# 3. Zobrazení živých logů z Dockeru na Raspberry Pi:
./deploy.sh --logs

# 4. Rychlý restart kontejneru bez rebuildu:
./deploy.sh --restart

# 5. Kontrola stavu a healthchecku na serveru:
./deploy.sh --status
```
*Výchozí konfigurace cílí na `pi@malina:/srv/compose/podcast`. Pokud potřebujete změnit IP adresu nebo port, můžete vytvořit soubor `.deploy.env` (podle vzoru `.deploy.env.example`) nebo zadat např. `PI_HOST=192.168.1.50 ./deploy.sh`.*

---

### 4.2 Aktualizace přímo na Raspberry Pi (`./update.sh`)

Přímo na Raspberry Pi v adresáři `/srv/compose/podcast` můžete použít skript **`update.sh`**:
1. Zkontroluje vzdálený GitHub repozitář, zda neobsahuje nové commity.
2. Pokud jsou k dispozici novinky, bezpečně stáhne nejnovější kód (`git pull`).
3. Bezvýpadkově znovu sestaví a restartuje Docker kontejner (`docker compose up -d --build`).
4. Ověří zdraví aplikace přes endpoint `/health`.
5. Automaticky vyčistí staré neaktivní Docker vrstvy (`docker image prune -f`), aby se neplnila SD karta.

```bash
# Ruční kontrola a aktualizace:
./update.sh

# Vynucení přebudování (i bez nových commitů):
./update.sh --force

# Nastavení automatických nočních aktualizací v cronu (každý den ve 3:00 ráno):
./update.sh --install-cron
```
Veškeré záznamy o průběhu nočních kontrol se ukládají do souboru `update.log`.


---

## 5. Přístup z iPadu, tabletu a mobilu (PWA)

Aplikace je plně responzivní a podporuje technologii **PWA (Progressive Web App)**:

### Na zařízeních Apple (iOS / iPadOS):
1. V prohlížeči **Safari** otevřete adresu vašeho serveru (`http://raspberrypi.local:8000`).
2. Klikněte na ikonu **Sdílet** (čtvereček se šipkou nahoru).
3. Vyberte možnost **Přidat na plochu** (Add to Home Screen).
4. Na ploše se vytvoří samostatná ikona s lékařským symbolem.
5. Po otevření se aplikace spustí na celou obrazovku bez ovládacích prvků prohlížeče.

### Na zařízeních s Androidem:
1. V prohlížeči **Google Chrome** otevřete adresu serveru.
2. V pravém horním rohu klepněte na tři tečky.
3. Zvolte **Nainstalovat aplikaci** nebo **Přidat na domovskou obrazovku**.

---

## 6. Vzdálený přístup přes Cloudflare Tunnel & Tailscale

Chcete mít ke svým studijním materiálům, podcastům a chatu přístup z nemocnice, školy, vlaku nebo kavárny, aniž byste museli otevírat porty na domácím routeru?

### 6.1 Cloudflare Tunnel (Doporučeno pro webový přístup a vlastní doménu) 🌐
Jelikož na vašem Raspberry Pi v `/srv/compose/cloudflared` již běží služba **cloudflared**, můžete aplikaci snadno zpřístupnit na vlastní zabezpečené HTTPS doméně (např. `https://podcast.vasedomena.cz`):
- Není potřeba otevírat žádné porty na routeru ani mít veřejnou IP adresu.
- Automatický SSL/TLS certifikát a DDoS ochrana.
- Možnost dodatečného zabezpečení přes Cloudflare Zero Trust Access.

👉 **Kompletní návod k nastavení naleznete v [CLOUDFLARE_GUIDE.md](CLOUDFLARE_GUIDE.md).**

---

### 6.2 Tailscale VPN (Alternativa pro privátní mesh síť) 🔒
Pokud preferujete čistě privátní síť bez vystavení domény do internetu:
1. Vytvořte si bezplatný účet na [tailscale.com](https://tailscale.com).
2. Nainstalujte Tailscale na Raspberry Pi:
   ```bash
   curl -fsSL https://tailscale.com/install.sh | sh
   sudo tailscale up
   ```
3. Nainstalujte aplikaci Tailscale na svůj mobil, iPad nebo notebook a přihlaste se stejným účtem.
4. Vaše Raspberry Pi získá privátní zabezpečenou adresu (např. `100.x.y.z` nebo `http://raspberrypi:8000`), přes kterou se k aplikaci bezpečně připojíte odkudkoliv na světě.


---

## 7. Správa uživatelských účtů, rolí a zabezpečení

Aplikace obsahuje integrovaný autentizační systém s **třemi rolemi** a **režimem hosta**:

### 7.1 Uživatelské role
* **👑 Administrátor (`admin`):**
  - Plná kontrola nad serverem, konfigurací a API klíči.
  - Generování veškerého obsahu (podcasty, zápisky, kartičky, testy).
  - Schvalování nových uživatelů, změna rolí a správa přístupů.
* **🎓 Student (`user`):**
  - Plná tvorba a studium (generování podcastů, nahrávání studijních materiálů, poznámky, testy).
  - Nemá přístup do administrátorských nastavení serveru.
* **👁️ Pozorovatel (`viewer`):**
  - **Pouze pro čtení a poslech hotových materiálů.**
  - Může si neomezeně procházet projekty, poslouchat podcasty, číst zápisky a zkoušet testy.
  - **Nemůže nic generovat**, nahrávat soubory ani upravovat/mazat data (veškeré mutační požadavky backend blokuje s chybou 403 Forbidden).

### 7.2 Režim nepřihlášeného hosta (ON/OFF)
* **Vypnuto (OFF - výchozí stav):** Návštěvníci bez přihlášení jsou zablokováni přihlašovací obrazovkou (kód 401).
* **Zapnuto (ON):** Návštěvníci mohou otevřít aplikaci bez zadávání hesla v roli **Pozorovatel**. Mohou studovat hotové materiály, ale nečerpají vaše AI tokeny ani nemění vaše data.

### 7.3 První spuštění a schvalování
1. **Prvotní setup:** Při prvním spuštění si vytvoříte hlavní administrátorský účet.
2. **Schvalování žádostí:** V **Nastavení ➔ Uživatelé & schvalování** vidíte žádosti o registraci a schválíte je buď jako **Student**, nebo **Pozorovatel**, případně zamítnete.
3. **Zůstat přihlášený:** Volba *Zůstat přihlášený* vytvoří bezpečnou relaci na 30 dní.

---

## 8. Zálohování a obnova dat

Všechna vaše data (databáze, nahrané učebnice, MP3 nahrávky, kartičky i vygenerované testy) jsou uložena výhradně ve složce `./data`.

### Zálohování celého studia:
```bash
tar -czvf zaloha_medstudio_$(date +%Y%m%d).tar.gz ./data
```
Výsledný archív si můžete stáhnout do počítače nebo uložit na externí disk.

### Obnova ze zálohy:
```bash
docker compose down
tar -xzvf zaloha_medstudio_20260928.tar.gz
docker compose up -d
```

---

## 9. Řešení potíží (Troubleshooting)

### Zobrazení živých logů běžícího serveru:
```bash
docker compose logs -f
```

### Kontejner se nechce spustit / Port 8000 je obsazen:
Pokud na portu 8000 již běží jiná služba, upravte v `docker-compose.yml` mapování portů, např.:
```yaml
ports:
  - "8080:8000"
```
Aplikace bude následně dostupná na portu `8080`.

### Nedostatek místa na SD kartě Raspberry Pi:
Pro jednorázové uvolnění starých mezipamětí Dockeru spusťte:
```bash
docker system prune -a --volumes
```
*(Pozor: Složky `./data` se to netýká, vaše data zůstanou v bezpečí).*
