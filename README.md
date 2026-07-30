# AI Podcast Studio

Lokální webová aplikace pro převod studijních materiálů na stručné výukové podcasty. Uživatel nahraje podklady k jednomu studijnímu okruhu, aplikace v nich vyhledá relevantní pasáže, připraví z nich scénář pomocí Gemini a namluví jej přes OpenAI TTS nebo ElevenLabs. Výstupem je MP3 se souborem titulků SRT, případně jednoduché MP4 s titulky a názvem otázky.

Projekt je nyní zaměřený na přípravu k lékařským zkouškám, ale stejný postup lze použít pro libovolné studijní materiály.

## Co umí

- spravovat oddělené studijní projekty;
- přijímat materiály ve formátech PDF, DOCX, PPTX a TXT;
- vytěžit jejich text a uložit jej do perzistentní vektorové databáze ChromaDB;
- importovat otázky z CSV/TXT nebo je doplnit ručně;
- vytvářet scénáře s kontextem z nahraných materiálů (RAG);
- syntetizovat řeč přes OpenAI (`tts-1`) nebo ElevenLabs;
- zpracovat jednu otázku ve studiu i více otázek na pozadí;
- zobrazovat průběh v živé konzoli přes Server-Sent Events; při otevření se doplní i poslední provozní logy;
- spravovat vzniklé MP3, MP4 a SRT soubory v prohlížeči médií.

## Jak aplikace pracuje

1. Založíte projekt a nahrajete studijní materiály.
2. Backend z nich vytěží text, rozdělí jej na části po 1 500 znacích s přesahem 300 znaků a uloží je do samostatné ChromaDB kolekce projektu.
3. Vyberete otázku a prompt. Aplikace vyhledá až 25 nejbližších textových úryvků a pošle je spolu s otázkou modelu Gemini.
4. Vygenerovaný scénář můžete upravit přímo v prohlížeči.
5. Zvolený TTS poskytovatel scénář namluví. Delší text se dělí na části do přibližně 4 000 znaků.
6. K MP3 vznikne SRT se zhruba rozvrženými titulky; při volbě MP4 vytvoří FFmpeg video s tmavým pozadím, názvem tématu a titulky.

## Technologie

| Vrstva | Použití |
| --- | --- |
| Backend | Python, FastAPI, Uvicorn |
| Webové rozhraní | Jednostránkové HTML/JavaScript rozhraní s Tailwind CSS z CDN |
| Vyhledávání v materiálech | ChromaDB, `pdfplumber`, `python-docx`, `python-pptx` |
| Generování scénáře | Google Gemini API |
| Převod textu na řeč | OpenAI TTS nebo ElevenLabs API |
| Video a titulky | Mutagen, FFmpeg a `ffmpeg-python` |

## Požadavky

- Python 3.11 nebo novější (vývojové prostředí v tomto projektu používá Python 3.14).
- Nainstalovaný binární nástroj [FFmpeg](https://ffmpeg.org/) pro výstup MP4.
- Přístupové klíče alespoň pro Gemini a pro zvoleného TTS poskytovatele.

Na macOS lze FFmpeg nainstalovat například příkazem `brew install ffmpeg`.

## Instalace a spuštění

V kořeni projektu vytvořte a aktivujte virtuální prostředí, nainstalujte závislosti a spusťte server:

```bash
python3 -m venv venv
source venv/bin/activate
python -m pip install -r requirements.txt
python main.py
```

Alternativně lze server spustit přímo přes Uvicorn:

```bash
uvicorn main:app --host 127.0.0.1 --port 8000
```

Poté otevřete [http://127.0.0.1:8000](http://127.0.0.1:8000). Aplikace naslouchá pouze na lokálním rozhraní.

## Konfigurace API klíčů

Do souboru `.env` v kořeni projektu vložte klíče v tomto tvaru:

```dotenv
GEMINI_API_KEY=...
OPENAI_API_KEY=...
ELEVENLABS_API_KEY=...
```

`GEMINI_API_KEY` je potřeba pro generování scénářů. `OPENAI_API_KEY` je potřeba při volbě OpenAI TTS a `ELEVENLABS_API_KEY` při volbě ElevenLabs. Soubor `.env` je uvedený v `.gitignore`; klíče neukládejte do zdrojového kódu ani do verzovacího systému.

## Použití

1. V části **Výběr projektu** založte nebo vyberte studijní okruh.
2. Nahrajte zdrojové dokumenty a vyčkejte na dokončení indexace v živé konzoli.
3. Načtěte CSV/TXT s otázkami nebo přidejte otázky ručně. Každý neprázdný řádek importovaného souboru představuje jednu otázku.
4. Nastavte model pro tvorbu textu, poskytovatele a hlas TTS, výstupní formát a případně upravte prompt.
5. Pro ruční postup označte otázku, vytvořte scénář, zkontrolujte jej a spusťte syntézu. Pro více témat použijte dávkové zpracování.
6. Hotové soubory otevřete nebo smažte v **Průzkumníku médií**.

Šablony promptů, aktivní projekt a seznamy otázek ukládá prohlížeč do `localStorage`, takže jsou vázané na konkrétní prohlížeč a zařízení.

## Struktura projektu

```text
.
├── main.py              # aktuální FastAPI backend a logika RAG/TTS
├── main_v1.py           # starší verze backendu pro srovnání
├── static/
│   ├── index.html       # aktuální webové rozhraní
│   └── index_v1.html    # starší verze rozhraní
├── requirements.txt     # Python závislosti
├── otazky.csv           # ukázkový seznam zkouškových otázek
├── uploads/             # nahrané podklady rozdělené podle projektu
├── chroma_db/           # perzistentní vektorová databáze
├── generated_audio/     # vytvořená média (MP3, SRT, MP4)
└── .env                 # lokální API klíče, není verzován
```

## Backendové rozhraní

Uživatelské rozhraní volá JSON a multipart API pod `/api`:

| Oblast | Endpointy |
| --- | --- |
| Projekty | `GET/POST /api/projects` |
| Materiály | `GET /api/files`, `POST /api/files/upload`, `DELETE /api/files/{filename}` |
| Otázky | `POST /api/files/upload-csv` |
| Generování | `POST /api/generate-script`, `POST /api/generate-audio`, `POST /api/generate-subtitles` |
| Dávky | `POST /api/process-batch`, `POST /api/cancel-batch` |
| Média a logy | `GET /api/outputs`, `DELETE /api/outputs/{filename}`, `GET /api/logs` |

Média jsou veřejně dostupná aplikaci pod cestou `/audio/<soubor>`.

## Poznámky a omezení

- PDF musí obsahovat strojově čitelný text. Aplikace v současné podobě nepoužívá OCR pro naskenované dokumenty.
- Časování v SRT se odhaduje podle délky vět; nejde o zarovnání titulků přímo s řečí.
- Dávkové úlohy běží na pozadí v procesu FastAPI. Přerušení zastaví další kroky mezi otázkami, nikoli nutně již probíhající volání externího API. Při chybě API se dávka korektně ukončí, nehotové otázky se ve webu vrátí do stavu „Čeká“ a lze je spustit znovu bez restartu aplikace.
- Aplikace nemá přihlášení ani řízení přístupu. Je určena pro lokální použití, ne pro přímé vystavení do internetu.
- Používání API může být zpoplatněné podle nastavení účtů Google, OpenAI a ElevenLabs.

## Ověření

Zdrojové soubory `main.py` a `main_v1.py` prošly kontrolou syntaxe pomocí `python -m py_compile`. Plný běh vyžaduje platné API klíče a u MP4 dostupný FFmpeg.
