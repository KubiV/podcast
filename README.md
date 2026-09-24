# AI MedStudio & Podcast 🩺

Lokální desktopová a webová aplikace pro studenty a lékaře, která převádí rozsáhlé studijní materiály (PDF, DOCX, PPTX, TXT) na přehledné výukové podcasty, vysoce strukturované studijní texty (poznámky s citacemi v horním indexu), interaktivní Anki/Quizlet kartičky, didaktické přednášky od A do Z a adaptivní cvičné testy.

Aplikace běží **100% lokálně na počítači uživatele** na bázi modelu **BYOK (Bring Your Own Key)** – každý uživatel si v nastavení zadává své vlastní API klíče a veškerá data (materiály, audio nahrávky, vektorová databáze) zůstávají bezpečně uložena v jeho zařízení.

---

## 🌟 Hlavní funkce aplikace

- **🏠 Přehled projektu (Homescreen):** centrální dashboard se statistikami materiálů, otázek, audia, poznámek, kartiček a testů s rychlým rozcestníkem.
- **📅 Plánovač zkoušky & Centrální správce otázek:** 
  - Kompletní přehled a centrální správa zkouškových otázek sdílených napříč celým projektem.
  - Fulltextové vyhledávání a filtrování podle okruhů.
  - **Přepínač řazení naučených otázek:** Režim ON automaticky odsouvá projité otázky na konec seznamu.
  - Hromadný import otázek z CSV/TXT i prostého textu.
- **🎙️ Podcast Studio:** tvorba 10–15minutových výkladových audio/video podcastů s titulky SRT/MP4, možnost dávkového zpracování celých sad otázek na pozadí.
- **📝 Poznámky z materiálů:** generování vysoce strukturovaných medicínských textů bez "wall of text" (Otvírák, Definice, Klinický obraz, Diagnostika, Léčba, Chytáky a Red Flags) s **citacemi zdrojů v horním indexu (např. <sup>[1]</sup>)**, podpora dávkového generování pro více otázek současně, export do Markdownu a tisk/PDF.
- **🗂️ Kartičky (Anki / Quizlet):** generování sérií high-yield kartiček s volbou předvoleb i **zcela libovolného počtu unikátních otázek (až do 500 ks)**, automatické členění do klinických sérií bez halucinací a duplicit, 3D otáčení v prohlížeči, export pro Anki (`.txt`/`.tsv` s tabulátory a HTML) a 1-klik kopírováním pro Quizlet.
- **📋 Testové otázky (Procvičující testy):** 
  - Generování cvičných testů z vybraných otázek, témat z materiálů i vlastního zadání.
  - Podpora různých typů otázek s důrazem na **ABCD s jednou správnou odpovědí** i **více správnými odpověďmi**, **otevřené otázky** s automatickým hodnocením % shody a Anki active-recall sebehodnocením (Znovu / Těžké / Dobré / Snadné), **klinické kazuistiky** a **Pravda / Nepravda**.
  - Režim **Okamžitého vyhodnocení** (okamžitá zpětná vazba, vysvětlení a přesné citace zdrojů) i **Zkouškový mód** (čistý test s vyhodnocením na konci).
  - Po dokončení podrobný zpětný rozbor, režim **„Opakovat pouze chyby“**, export do Markdownu a **generování navazujících otázek** s volbou posunu obtížnosti (lehčí / stejná / těžší) a počtu otázek.
- **💬 Chat se zdroji (Source-Grounded Assistant):** interaktivní konverzační asistent přísně ukotvený v podkladech projektu s live streamováním tokenů (SSE), automatickými inline citacemi (`[Zdroj: název]`), rozbalovacím přehledem citovaných úryvků, exportem do Markdownu a perzistencí v SQLite. Nabízí **kompletní historii chatů s vlákny**, možnost **připnout oblíbené konverzace nahoru (📌)**, **full-textové vyhledávání v historii** (v názvech i obsahu zpráv), přejmenování a správu vláken.
- **🎓 Výuková lekce od A do Z:** autonomní tvorba kompletních studijních lekcí z multimodálních podkladů (nativní i naskenovaná PDF, cizojazyčné učebnice, obrázky, schémata). Založí nový izolovaný projekt, syntetizuje detailní studijní Markdown text (`lesson_material.md`) a vytvoří doplňující didaktickou přednášku profesora (`lecture_audio.mp3`) s interaktivními kapitolami a časovým scrubberem v duálním prohlížeči.
- **⚡ Dávkové zpracování & Noční režim (Overnight Mode):** nezávislé dávkové zpracování pro Podcasty, Poznámky i Kartičky s automatickým opakováním selhaných položek (až 3 pokusy), závěrečnou kontrolní sweep fází pro dočištění nehotových položek přes noc, a možností spustit dávku pouze pro dosud nehotové/chybějící otázky.
- **⚙️ Nastavení aplikace & Vlastní API klíče (BYOK):**
  - Správa klíčů přímo v grafickém rozhraní aplikace (Google Gemini, OpenAI, ElevenLabs).
  - Tlačítko pro testování platnosti klíčů v reálném čase.
  - Bezpečné ukládání do lokální konfigurace uživatele (`user_config.json`) s maskováním citlivých údajů.
- **📊 Živá SSE konzole:** sledování průběhu chunkování, RAG vyhledávání a volání API v reálném čase.

---

## 🖥️ Možnosti spuštění aplikace

Aplikaci lze provozovat třemi různými způsoby podle vašich potřeb:

### 1. Nativní desktopové okno (Doporučeno pro uživatele)
Aplikace běží v samostatném čistém okně bez adresního řádku prohlížeče:
```bash
python desktop_app.py
```
*(Pokud systém nepodporuje grafické okno nebo je předán přepínač `--browser`, automaticky otevře výchozí webový prohlížeč).*

### 2. Klasický vývoj v prohlížeči s Hot-Reloadem
Ideální pro úpravu zdrojových kódů a šablon:
```bash
uvicorn main:app --reload --port 8000
```
Poté otevřete adresu [http://127.0.0.1:8000](http://127.0.0.1:8000).

### 3. Sestavení samostatné distribuce (PyInstaller)
Vytvoří spustitelnou desktopovou aplikaci pro distribuci koncovým uživatelům:
- **macOS / Linux:**
  ```bash
  ./scripts/build_desktop.sh
  ```
  *Výsledný balíček:* `dist/AIMedStudio.app` (macOS) nebo `dist/AIMedStudio/` (Linux).
- **Windows:**
  ```cmd
  scripts\build_desktop.bat
  ```
  *Výsledná aplikace:* `dist\AIMedStudio\AIMedStudio.exe`.

---

## 🔑 Konfigurace API klíčů (BYOK)

Aplikace funguje na principu **Bring Your Own Key** – uživatel má plnou kontrolu nad svým účtem i náklady:

1. Po spuštění klikněte v horní liště na tlačítko **`[⚙️ Nastavení]`** (nebo se otevře automaticky při prvním startu).
2. Zadejte potřebné klíče:
   - **Google Gemini API klíč** (*vyžadováno*): Pohání veškeré generování textů, RAG rešerše, kartičky i chat se zdroji. [Získat klíč zdarma ↗](https://aistudio.google.com/app/apikey)
   - **OpenAI API klíč** (*volitelné*): Pro přirozený hlasový přednes OpenAI TTS.
   - **ElevenLabs API klíč** (*volitelné*): Pro prémiové filmové hlasy.
3. Klikněte na tlačítko **„Ověřit“** u jednotlivých klíčů pro otestování spojení.
4. Klikněte na **„Uložit nastavení“**.

> **Poznámka:** Pro vývojáře je zachována i zpětná kompatibilita se souborem `.env` v kořeni projektu.

---

## 💾 Lokální úložiště dat

Veškerá data vytvořená uživatelem jsou izolována od kódu aplikace, což zajišťuje, že o své materiály nepřijdete ani při aktualizaci aplikace:
- **Umístění dat:** `~/Documents/AIMedStudio` (na Windows typicky `C:\Users\<Uživatel>\Dokumenty\AIMedStudio`).
- **Přenosný režim:** Pokud vedle aplikace vytvoříte složku `data/`, aplikace bude data ukládat do ní (vhodné pro USB flash disky).
- Ve složce Nastavení je k dispozici tlačítko **„📂 Otevřít“**, které tuto složku přímo otevře v systémovém průzkumníku souborů.

---

## 🛠️ Technologie

| Vrstva | Technologie |
| --- | --- |
| **Desktop Launcher** | Python, `pywebview` (macOS WebKit / Windows WebView2), `threading` |
| **Backend & Server** | Python 3.11+, FastAPI, Uvicorn |
| **Frontend** | Jednostránková aplikace (SPA), HTML5, JavaScript (ES6+), Tailwind CSS |
| **Vektorová databáze** | ChromaDB (RAG indexace a sémantické vyhledávání) |
| **Zpracování dokumentů** | `pdfplumber`, `python-docx`, `python-pptx`, `pypdf` |
| **Generativní AI** | Google Gemini API (`google-genai` SDK – Gemini 3.6 Flash, Pro) |
| **Hlasová syntéza (TTS)** | OpenAI TTS API (`alloy`, `echo`, `fable`, `onyx`, `nova`, `shimmer`), ElevenLabs API |
| **Audio a video** | FFmpeg, Mutagen, `ffmpeg-python` (automatická detekce lokální binárky) |
| **Distribuce** | PyInstaller (`medstudio.spec`) |

---

## 📂 Struktura projektu

```text
.
├── desktop_app.py           # Vstupní spouštěč desktopové aplikace (Uvicorn + pywebview)
├── main.py                  # FastAPI backend, logika RAG, generování a BYOK endpointy
├── medstudio.spec           # PyInstaller konfigurace pro sestavení desktopové aplikace
├── requirements.txt         # Seznam Python závislostí
├── static/
│   └── index.html           # Kompletní frontendové rozhraní (SPA)
├── scripts/
│   ├── build_desktop.sh     # Sestavovací skript pro macOS a Linux
│   └── build_desktop.bat    # Sestavovací skript pro Windows
├── chat_service.py          # Služba pro konverzační asistent s citacemi ze zdrojů
├── lesson_service.py        # Služba pro generování autonomních výukových lekcí
├── test_service.py          # Služba pro generování a vyhodnocování cvičných testových otázek
├── uploads/                 # Nahrané studijní materiály (ve vývoji)
├── chroma_db/               # Vektorová databáze ChromaDB (ve vývoji)
├── generated_audio/         # Vygenerované audio/video podcasty
├── generated_notes/         # Vygenerované strukturované studijní texty
├── generated_flashcards/    # Vygenerované kartičky pro Anki / Quizlet
└── generated_tests/         # Vygenerované testové sady a výsledky testů
```

---

## 🔌 Přehled API endpointů

| Oblast | Endpointy | Popis |
| --- | --- | --- |
| **Nastavení & BYOK** | `GET /api/settings`<br>`POST /api/settings`<br>`POST /api/settings/test-key`<br>`POST /api/settings/open-data-folder` | Správa a testování API klíčů, otevření složky dat |
| **Projekty** | `GET/POST /api/projects` | Výpis a tvorba studijních okruhů |
| **Materiály** | `GET /api/files`<br>`POST /api/files/upload`<br>`DELETE /api/files/{filename}`<br>`POST /api/projects/{id}/reindex` | Správa souborů a přeindexování |
| **Otázky & Plánovač** | `GET/POST /api/projects/{id}/questions`<br>`GET/POST /api/projects/{id}/planner`<br>`POST /api/files/upload-csv` | Správa a sdílení otázek napříč projektem |
| **Podcasty** | `POST /api/generate-script`<br>`POST /api/generate-audio`<br>`POST /api/generate-subtitles` | Tvorba scénářů, syntéza hlasu a renderování titulků/videa |
| **Dávkové úlohy** | `POST /api/process-batch`<br>`POST /api/cancel-batch` | Dávkové zpracování podcastů, poznámek i kartiček |
| **Studijní texty** | `POST /api/generate-notes`<br>`GET/DELETE /api/notes/{filename}` | Generování strukturovaných textů s citacemi v horním indexu |
| **Kartičky** | `POST /api/generate-flashcards`<br>`GET/DELETE /api/flashcards/{filename}`<br>`GET /api/flashcards/export-all` | Tvorba a export Anki/Quizlet kartiček |
| **Testové otázky** | `POST /api/tests/generate`<br>`POST /api/tests/generate-more`<br>`GET /api/tests`<br>`GET/DELETE /api/tests/{filename}`<br>`POST /api/tests/{filename}/result`<br>`POST /api/tests/evaluate-open-answer` | Generování procvičujících testů, navazující otázky, ukládání výsledků a Anki active-recall evaluace |
| **Chat se zdroji** | `POST /api/chat/completions`<br>`GET/POST /api/chat/threads`<br>`GET/PATCH/DELETE /api/chat/threads/{id}`<br>`POST /api/chat/threads/{id}/pin`<br>`GET /api/chat/threads/{id}/export`<br>`GET/DELETE /api/projects/{id}/messages` | SSE streamovaný chat, správa vláken, full-text vyhledávání, připínání a export |
| **Výuková lekce** | `POST /api/lessons/generate`<br>`GET/DELETE /api/lessons/{id}` | Komplexní tvorba studijní lekce a přednášky |
| **Systém & Konzole** | `GET /api/logs`<br>`GET /api/stats`<br>`GET/DELETE /api/outputs/{filename}` | SSE logování, statistiky a správa médií |
