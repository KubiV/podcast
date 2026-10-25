// GLOBÁLNÍ STAV
        // HELPER PRO OPRAVU SAFARI BUGU S UNICODE NÁZVY SOUBORŮ PŘI UPLOADU
        function sanitizeFile(file) {
            if (!file || !file.name) return file;
            let safeName = file.name;
            try {
                safeName = file.name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x20-\x7E]/g, "_");
            } catch(e) {}
            if (safeName !== file.name) {
                return new File([file], safeName, { type: file.type });
            }
            return file;
        }

        let currentProject = "";
        let questions = [];
        let selectedQuestionIndex = null;
        let currentAbortController = null;
        let activeBatch = null;
        const finishedBatchIds = new Set();
        let currentTab = "home";
        let medulingoSortMode = "sequence"; // 'sequence' (po číslech) | 'category' (po okruzích)
        let qmInlineEditMode = false;
        let lessonCurrentFontSize = 16;
        // STAV UŽIVATELE A AUTENTIZACE
        let currentUser = null;
        let authRegistrationAllowed = true;
        let authGuestAllowed = false;

        // Pomocná funkce pro zjištění, zda je aktuální uživatel v roli pozorovatele (pouze ke čtení)
        function isViewerMode() {
            return !currentUser || currentUser.role === "viewer" || Boolean(currentUser.is_guest);
        }

        // STAV PLÁNOVAČE ZKOUŠKY
        let examPlanner = {
            examDate: "",
            startDate: "",
            revisionDays: 14,
            scheduleMode: "sequential", // 'sequential' (po číslech) | 'topics' (po okruzích) | 'priority' (slabá místa D/C) | 'interleaved' (mix témat)
            questions: [] // { id, topic, number, title, completedDate, grade, note }
        };
        let plannerImportFileData = null;
        let plannerCalendarSelectedDay = null; // dateStr nebo null (např. '2026-09-29')
        let currentWeekSchedule = []; // cache 7denního rozvrhu pro synchronizaci a filtrování tabulky

        // STAV KARTIČEK
        let currentDeck = {
            question: "",
            cards: [],
            sources: [],
            anki_tsv: "",
            quizlet_text: ""
        };
        let currentCardIndex = 0;
        let isCardFlipped = false;

        // STAV POZNÁMEK
        let currentNotesMarkdown = "";
        let currentNotesSources = [];
        let currentNotesFilename = "";

        const voicesData = {
            openai: [
                { id: "onyx", name: "Onyx (Mužský)" },
                { id: "alloy", name: "Alloy (Neutrální)" },
                { id: "shimmer", name: "Shimmer (Ženský)" }
            ],
            elevenlabs: [
                { id: "21m00Tcm4TlvDq8ikWAM", name: "Rachel (Čeština)" },
                { id: "AZnzlk1XvdvUeBnXmlld", name: "Domi" }
            ]
        };

        // VÝCHOZÍ ŠABLONY PROMPTŮ
        const DEFAULT_NOTES_PROMPT = `Jsi špičkový profesor vnitřního lékařství a zkušený, náročný, ale spravedlivý zkoušející. Tvým úkolem je připravit medika 5. ročníku na ústní zkoušku z interny. Na základě nahraných studijních materiálů v tomto notebooku vytvoř komplexní, vysoce strukturovaný a fakticky nabitý studijní text k této zkouškové otázce: {QUESTION}.

Dodrž tyto striktní instrukce:
1. CÍLOVKA A ÚROVEŇ ODBORNOSTI: Text je určen pro medika před zkouškou. Vynech základní omáčku a polopatické vysvětlování (žádné opakování bazální anatomie). Zaměř se striktně na "high-yield" informace, klasifikace, diagnostická kritéria, algoritmy léčby a klinická "buzzwords", která musí u zkoušky zaznít.
2. ABSOLUTNÍ ZÁKAZ "WALL OF TEXT": Mozek se učí vizuálně. Vyhni se dlouhým souvislým odstavcům. Text musí být scannovatelný. Piš heslovitě, maximálně využívej odrážky (bullet points) a u klasifikací nebo diferenciální diagnostiky neváhej použít Markdown tabulku, pokud to zvýší přehlednost.
3. ZVÝRAZNĚNÍ: Pomocí tučného písma systematicky zvýrazňuj klíčové pojmy, názvy syndromů, specifická diagnostická kritéria a hlavní skupiny léků.
4. ZKRATKY: Na rozdíl od audio-přehledů zde běžné klinické zkratky (EKG, CT, MR, JIP, ACEi, NYHA, CHSK atd.) NERozepisuj. Text musí být úderný a odpovídat běžnému lékařskému zápisu.
5. VÍCEJAZYČNOST A TERMINOLOGIE: Nahrané materiály mohou být v různých jazycích (např. anglické mezinárodní guidelines, české učebnice a skripta). Informace přirozeně integruj a sjednoť do přesné a standardní české lékařské terminologie.
6. ZDROJOVÁNÍ V HORNÍM INDEXU: Využij poskytnuté očíslované úryvky zdrojů označené jako [1], [2] atd. U každého klíčového faktu, kritéria či doporučení uveď referenci na daný zdroj formou horního indexu <sup>[1]</sup> nebo [1].
7. STRUKTURA VÝKLADU: Text musí striktně dodržet následující osnovu. Každý bod bude tvořit samostatnou sekci s nadpisem (použij H2 formátování - ##):
## Otvírák: (Jedna geniální, úderná věta, kterou student zkoušku začne, aby ukázal absolutní přehled.)
## Definice: (Krátká, úderná, přesná.)
## Epidemiologie: (Jen klíčová data – věk, pohlaví, incidence.)
## Etiologie a rizikové faktory:
## Patofyziologie: (Stručný a logický mechanismus.)
## Klinický obraz: (Typické příznaky, dělení, manifestace.)
## Diagnostika: (Laboratoř, zobrazovací metody, zlatý standard, diagnostická kritéria.)
## Diferenciální diagnostika: (Nejdůležitější jednotky a stručný klíč, jak je odlišit.)
## Léčba: (Konzervativní, farmakologická s konkrétními zástupci, intervenční/chirurgická.)
## Komplikace: (Akutní a chronické.)
## Prognóza a prevence:
## Chytáky a "Red Flags": (1-3 typické záludnosti, oblíbené dotazy zkoušejících nebo chyby, na kterých se vyhazuje.)
## Použité zdroje: (Očíslovaný seznam citovaných podkladů s přesnými názvy souborů)
8. ČISTÝ VÝSTUP: Vynech jakékoliv AI fráze typu "Zde je váš text", "Doufám, že to pomáže". Začni rovnou nadpisem první úrovně (# {QUESTION}) a skonči sekcí Použité zdroje. Vycházej primárně a pouze z nahraných zdrojů.`;

        const DEFAULT_CARDS_PROMPT = `Jsi špičkový profesor medicíny a expert na efektivní učení (spaced repetition). Tvým úkolem je na základě přiložených studijních materiálů vytvořit sérii přesně {COUNT} vysoce efektivních studijních kartiček (flashcards) pro Anki a Quizlet k této zkouškové otázce: {QUESTION}.

STRIKTNÍ PRAVIDLA PRO KARTIČKY:
1. CÍLOVÁ SKUPINA: Medik 5. ročníku před zkouškou z interny. Žádné triviální obecnosti. Kartičky musí testovat rozhodující diagnostická kritéria, léky první volby, patognomické nálezy, laboratorní odchylky, skórovací schémata a nebezpečné omyly (Red Flags).
2. FORMÁT KARTIČKY (Front & Back):
   - Líc (front): Přesná, jednoznačně položená klinická otázka, např. "Jaká je triáda příznaků u X?", "Lék 1. volby u těžké exacerbace Y?", "Jaká jsou diagnostická kritéria Z?".
   - Rub (back): Stručná, úderná a přesná odpověď. Používej odrážky, tučné zvýraznění klíčových léků/dávek a běžné klinické zkratky.
3. PŘESNÉ CITACE A ODKAZY NA STRÁNKU (STANDARD NOTEBOOKLM):
   Každá kartička MUSÍ být přesně ozdrojována z přiložených podkladů. V hlavičkách segmentů vidíš formát: '--- [ZDROJ X: soubor.pdf | Strana Y | Segment Z] ---'.
   Ve výstupu do pole "source_file" uveď přesný název souboru (např. 'Klener_Vnitrni_lekarstvi.pdf'), do "source_page" uveď číslo strany (např. '45' nebo '45–47') a do "source_quote" uveď krátkou doslovnou větu/údaj z textu. Do "source_ref" uveď souhrnnou citaci [X, s. Y].
4. DIVERZITA TYPŮ OTÁZEK:
   - Diagnostika & kritéria (např. Wells skóre, CURB-65, kritéria revmatoidní artritidy).
   - Terapie (iniciální management, lék volby, kontraindikace).
   - Diferenciální diagnostika (jak spolehlivě odlišit dvě podobné jednotky).
   - Red Flags a záludnosti zkoušejících.
5. UNIKÁTNOST OTÁZEK: Každá kartička musí mít ZCELA UNIKÁTNÍ otázku (lícovou stranu). Žádná otázka se nesmí opakovat, parafrázovat ani ptát na tutéž informaci. Každá kartička testuje odlišný specifický fakt, diferenciální kritérium, dávkování či komplikaci.
6. JAZYK A ZDROJE: Materiály mohou být v cizím jazyce (např. anglické guidelines). Kartičky formuluj v profesionální české lékařské terminologii. Vycházej z přiložených očíslovaných zdrojů.
7. FORMÁT VÝSTUPU:
   Vrať VÝHRADNĚ platný JSON formát bez jakéhokoliv doplňkového textu, vysvětlování či obalového markdownu (žádné \`\`\`json na začátku ani na konci).
   Výstupem musí být JSON pole objektů přesně v této struktuře:
   [
     {
       "id": 1,
       "front": "Otázka na lícové straně",
       "back": "Stručná odpověď s odrážkami či zvýrazněním",
       "source_file": "presny_nazev_souboru.pdf",
       "source_page": "45",
       "source_quote": "Doslovný fragment textu nebo kritérium",
       "source_ref": "[1, s. 45]"
     }
   ]`;

        const ADVANCED_ANKI_CARDS_PROMPT = `Jsi špičkový profesor medicíny, pedagog a mezinárodní expert na spaced repetition (Anki) podle metodických standardů Sorbonne Université, referenčního rámce francouzského Collège a Oleho Anki-konvence (Anki-Konvention).
Tvým úkolem je na základě přiložených studijních materiálů vytvořit sérii přesně {COUNT} vysoce pokročilých, atomických a kognitivně provázaných studijních kartiček k tématu/otázce: {QUESTION}.

ZÁVAZNÁ PRAVIDLA PRO POKROČILÉ ANKI KARTIČKY:

1. KOGNITIVNÍ ZÁKLAD – POROZUMĚNÍ PŘED MEMOROVÁNÍM (Pravidlo 21):
   Karty striktně děl do tří didaktických kategorií:
   a) ODVODITELNÁ KARTA (logique): Kde jeden mechanismus nese celou odpověď, PRINCIP JE HLAVNÍ VĚC a fakta jsou jeho přímým důsledkem.
      - Odpověď začíná principem: <b>Le principe</b> : ... (nebo česky <b>Princip</b> : ...).
      - Následují fakta jako logické důsledky principu (např. časové prahy, patofyziologický řetězec).
      - Dodatečné kauzální zdůvodnění patří do tlumeného řádku: <i>Pourquoi : …</i>
      - Nápověda na líci v závorce formuluje VÝCHOZÍ OTÁZKU/ÚVAHU, ze které odpověď plyne (např. "(3 composantes · 1 distinction — l'action est-elle planifiée ?)"). Nápověda jmenuje otázku k zamyšlení, NIKDY samotnou odpověď!
   b) NAPŮL ODVODITELNÁ KARTA: Pravidlo + výjimky. Pravidlo patří na kartu jako hlavní sdělení, výjimka je zřetelně označena (<i>Výjimka : ...</i> nebo <i>À l'inverse : ...</i>).
   c) ČISTÁ FAKTA: Kde žádný mechanismus není, nic se nevymýšlí (dávkování léků, zákonné lhůty, mezinárodní názvy DCI, diagnostické prahy skóre).
   ⚠️ PŘÍSNÝ ZÁKAZ VYMYŠLENÝCH MECHANISMŮ: Kde podklad kauzální vysvětlení nedává, karta zůstává striktně faktovou. Věrohodně znějící, ale nepodložené odvození se v testech a zkouškách stává systematickou chybou!

2. ANATOMIE KARTY:
   - LÍC (front):
     Vždy začíná čipem důležitosti: [Rang A] (základní povinné jádro zkoušky) nebo [Rang B] (prohlubující/specializační).
     Následuje přesná otázka.
     Otázka končí NÁPOVĚDOU V ZÁVORCE: např. <br><small style='color:#a8a29e;'><i>(Nápověda...)</i></small>.
   - RUB (back):
     Začíná principem (u odvoditelných).
     Obsahuje maximálně 1–3 hlavní body s tučně zvýrazněnými klíčovými pojmy, léky a čísly (<b>...</b>).
     Tlumené vedlejší řádky pro kontext (kurzívou):
       • <i>Pourquoi : …</i> (kauzální zdůvodnění ze zdroje)
       • <i>Aussi : …</i> (doplňující fakta pro úplnost, která se nemají aktivně zkoušet)
       • <i>Piège : …</i> (klinický chyták, diagnostická past, častá záměna, rozpor mezi zdroji)
       • <i>À l'inverse : …</i> (opačný pól, zrcadlový kontrast)
     Zakončeno sbaleným blokem ČESKÉ VRSTVY (<details>...</details>).

3. NÁPOVĚDA V ZÁVORCE (INDICE - Pravidlo 6, 7):
   - Nápověda POČÍTÁ a JMENUJE PŘIHRÁDKY/KATEGORIE, NIKDY samotné prvky!
     Např.: (4 catégories : iatrogénie · métabolique et endocrinien · neurologique · causes mécaniques) — ptá se, co do nich patří.
     U tabulky/srovnání: (tableau confusion ↔ démence · 4 lignes : installation, vigilance, réversibilité, signes).
   - VÝJIMKA: Pokud jsou samotné kategorie zkoušeným učivem (např. 8 sémiologických domén, 3 clustery osobnosti, 4 mechanismy), nápověda zůstává čistě početní: (3 clusters), aby neprozradila odpověď na líci!
   - Žádné vágní výrazy („stačí pár příkladů“, „a zbytek“). Příklady jmenované v nápovědě se v odpovědi zafixují a nezkracují.
   - Délka nápovědy: medián kolem 50 znaků, nikdy přes 100 znaků.

4. ATOMICITA A ROZSAH (Pravidla 1, 2, 11, 12, 14):
   - Nejvýše 1–3 hlavní body na kartu! Raději 1–3 body s naprostou jistotou než 5–8 bodů povrchně.
   - Kontrast místo paralelních karet (Pravidlo 12): Dva případy lišící se jedním parametrem či číslem se učí společně v kontrastu — srovnání je vlastní lekcí!
   - Otázka a odpověď míří stejným směrem (Pravidlo 1).
   - Příslovce zdroje se striktně přenášejí (Pravidlo 2): « n'entraîne jamais », « n'excède habituellement pas », « n'est pas systématique » (nikdy nevede k..., obvykle nepřekračuje..., není systematické) — zkouškové testy (EDN/QCM) stojí přesně na těchto nuancích!
   - Čísla jen tehdy, když nesou klinické rozhodnutí (Pravidlo 11): věk, lhůta, práh skóre, dávka. Běžnou incidenci a prevalenci netestovat v jádru otázky.

5. PŘEHLEDOVÉ SYNTETICKÉ KARTY (SYNTHÈSE - Pravidlo 18):
   Do sady přirozeně zařaď i typy přehledových karet (cca 1–2 karty na 10 položek):
   - Dělicí otázka: jedna otázka, na které se spolehlivě rozcházejí dvě diagnózy (např. „Mizí psychotické příznaky spolu s odezněním epizody nálady?“).
   - Srovnávací tabulka: 3–5 entit × 3–4 znaky.
   - Pojmový žebřík: stupně kontinua ve správném logickém a chronologickém pořadí (např. idée délirante → syndrome délirant → délire aigu → trouble délirant persistant).
   - Falešný přítel (faux-ami): termíny, které v češtině/laicky znamenají něco jiného (např. délire = blud, nikoli delirium; delirium = confusion mentale).

6. JAZYKOVÉ PRAVIDLO A ČESKÁ VRSTVA (Pravidla 22, 25, 26):
   - Pokud jsou podkladové materiály v cizím jazyce (např. francouzské Collège pro zkoušky EDN), otázka, nápověda i odpověď jsou v jazyce originálu pro nácvik zkouškových formulací. Pokud jsou podklady v češtině, jazykem je profesionální česká medicínská terminologie.
   - Každá karta MUSÍ mít na rubu sbalený blok ČESKÉ VRSTVY pro hluboké porozumění:
     <details style='margin-top:10px; padding:6px 10px; border-left:3px solid #3d7cc9; background:rgba(61,124,201,0.08); font-size:0.92em; border-radius:4px;'>
       <summary style='cursor:pointer; color:#38bdf8; font-weight:600;'>🇨🇿 Česky — překlad a pojmy</summary>
       <div style='margin-top:6px;'>
         <div><strong>Otázka:</strong> [Český překlad otázky a nápovědy, 1–2 věty]</div>
         <div style='margin-top:4px;'><strong>Odpověď:</strong> [Český překlad principu a hlavních bodů; vedlejší řádky jen stručně]</div>
         <div style='margin-top:6px; font-size:0.9em; border-top:1px dashed rgba(255,255,255,0.15); padding-top:4px;'>
           <strong>Pojmy (MKN-10 / Glosář):</strong><br>
           • <em>odborný termín</em>: české vysvětlení a oficiální český ekvivalent (MKN-10 / DSM-5); ⚠️ upozornění na falešné přátele a reálie.
         </div>
       </div>
     </details>
   - Česká vrstva POUZE překládá a vysvětluje to, co je na kartě – NEPŘIDÁVÁ žádná nová fakta, která nejsou v originálním jádru karty!

7. PŘESNÉ CITACE (NOTEBOOKLM STANDARD):
   Každá kartička musí obsahovat přesnou citaci z přiložených podkladů:
   "source_file": přesný název souboru (např. 'College_Psychiatrie_4e.pdf'),
   "source_page": číslo strany (např. '29' nebo '141–145'),
   "source_quote": doslovná citace ze zdroje,
   "source_ref": souhrnná reference [soubor, s. XY].

8. FORMÁT VÝSTUPU:
   Vrať VÝHRADNĚ platný JSON formát bez jakéhokoliv doplňkového textu či markdown obalu (žádné \`\`\`json na začátku ani na konci).
   Výstupem musí být JSON pole objektů přesně v této struktuře:
   [
     {
       "id": 1,
       "front": "[Rang A] Qu'est-ce que l'athymhormie, et en quoi l'aboulie diffère-t-elle de l'apragmatisme ?<br><small style='color:#a8a29e;'><i>(2 composantes · 1 distinction — l'action est-elle planifiée ?)</i></small>",
       "back": "<b>Le principe</b> : athymhormie = <b>athymie</b> + <b>aboulie</b><br>• <b>Aboulie</b> : difficulté à <b>initier</b> une action <b>pourtant planifiée</b><br>• <b>Apragmatisme</b> : difficulté à initier une action <b>par défaut de planification</b><br><br><small><i>Pourquoi : Déficit de l'élan vital et de la motivation globale.</i></small><br><br><details style='margin-top:10px; padding:6px 10px; border-left:3px solid #3d7cc9; background:rgba(61,124,201,0.08); font-size:0.92em; border-radius:4px;'><summary style='cursor:pointer; color:#38bdf8; font-weight:600;'>🇨🇿 Česky — překlad a pojmy</summary><div style='margin-top:6px;'><div><strong>Otázka:</strong> Co je athymhormie a čím se liší abulie od apragmatismu? (2 složky · 1 rozlišení — je akce naplánovaná?)</div><div style='margin-top:4px;'><strong>Odpověď:</strong> Princip: athymhormie = vymizení nálady (athymie) + abulie. Abulie: akce je naplánovaná, ale nedaří se ji spustit. Apragmatismus: akce se nespustí, protože chybí plán.</div><div style='margin-top:6px; font-size:0.9em; border-top:1px dashed rgba(255,255,255,0.15); padding-top:4px;'><strong>Pojmy:</strong><br>• <em>athymie</em>: vymizení nálady jako takové — ne smutek, ale nepřítomnost afektivního tónu.<br>• <em>aboulie</em>: porucha vůle a motivace (v češtině abulie).<br>• <em>apragmatisme</em>: porucha plánování a organizace činností.</div></div></details>",
       "rang": "A",
       "hint": "2 composantes · 1 distinction — l'action est-elle planifiée ?",
       "card_type": "logique",
       "source_file": "College_Psychiatrie.pdf",
       "source_page": "29",
       "source_quote": "L'athymhormie associe athymie et aboulie...",
       "source_ref": "[College_Psychiatrie.pdf, s. 29]"
     }
   ]`;

        const defaultCardsPrompts = {
            standard: DEFAULT_CARDS_PROMPT,
            advanced: ADVANCED_ANKI_CARDS_PROMPT
        };

        let savedPrompts = [];
        const defaultPodcastPrompts = [
            {
                name: "Strukturovaný podcast (nový)",
                text: "Jsi špičkový profesor vnitřního lékařství a zkušený zkoušející. Tvým úkolem je připravit medika 5. ročníku na náročnou ústní zkoušku z interny. Na základě přiložených studijních materiálů kompletně zpracuj zkouškovou otázku: [NÁZEV OTÁZKY].\nNapiš text jako vysoce koncentrovaný, plynulý audiosouhrn určený k HLASITÉMU POSLECHU. Zcela vynech klasickou \"podcastovou omáčku\" (absolutně žádné \"Vítejte\", \"Dnes se podíváme na...\", \"Dobrý den\" apod.). Text musí být vybalancovaný pro soustředěný poslech, ale maximálně nabitý fakty.\nDodrž tyto striktní instrukce:\n1. MAXIMÁLNÍ DÉLKA textu je absolutně omezena na {MAX_CHARS} znaků. Zaměř se striktně na \"high-yield\" informace a klíčová slova, která musí u zkoušky zaznít.\n2. STRUKTURA VÝKLADU: Začni rovnou jedinou údernou větou, která zkoušejícímu okamžitě ukáže, že přesně víš, o čem mluvíš (tzv. otvírák). Následně do plynulého monologu postupně a logicky zakomponuj těchto 10 bodů v přesném pořadí:\n Definice a dělení (také dle různých hledisek)\n Epidemiologie\n Etiologie a rizikové faktory\n Patofyziologie\n Klinický obraz\n Diagnostika\n Diferenciální diagnostika\n Léčba\n Komplikace\n Prognóza a prevence\n3. PLYNULOST A ZVUKOVÉ ZÁLOŽKY: Vždy těsně předtím, než začneš mluvit o dalším bodu osnovy, velmi stručně a přirozeně zmíníš jeho název, aby se posluchač mohl rychle zorientovat (např. \"K definici tohoto stavu...\", \"Pokud jde o epidemiologii...\", \"V rámci klinického obrazu dominují...\"). Vyhni se ale robotickému číslování typu \"Bod jedna, definice\". Přechody musí znít plynule a přirozeně jako výklad na přednášce.\n4. RYTMUS A DÉLKA VĚT: Striktně omez délku jednotlivých vět, aby mozek stíhal informace ukládat. Pokud musíš vyjmenovat více než tři symptomy, rizikové faktory nebo léky, rozděl výčet do dvou či více na sebe navazujících vět. Udržíš tím přirozené tempo mluveného slova.\n5. ZKRATKY A AKRONYMY: Klinické akronymy a zkratky vždy plynule rozepiš do textu celým slovem (například místo \"na EKG\" napiš \"na elektrokardiogramu\", místo \"IgG\" napiš \"imunoglobulin G\"), aby je hlasový syntetizátor nepřečetl jako nesmyslný shluk hlásek.\n6. ODBORNOST: Mluv výhradně spisovnou, ale přirozenou češtinou. Odborné termíny nevysvětluj polopaticky – mluvíš k budoucímu lékaři. Uváděj je rovnou v přesných klinických souvislostech.\n7. ZÁKAZ FORMÁTOVÁNÍ: Nepoužívej ŽÁDNÉ odrážky, seznamy, závorky ani tabulky. Text musí být čistě lineární a syntakticky plynulý, aby ho šlo přečíst bez zadrhávání TTS syntetizátoru.\n8. ČISTÝ TEXT: Výsledek nesmí obsahovat žádné režijní poznámky (např. pauza, nadechnutí). Výstupem bude pouze čistý mluvený text připravený pro převod na hlas."
            }
        ];

        // =========================================================================
        // IN-PAGE VYHLEDÁVACÍ ENGINE (NÁHRADA ZA CTRL+F S INTERAKTIVNÍM ZVÝRAZNĚNÍM)
        // =========================================================================
        class InPageSearcher {
            constructor(options) {
                this.containerId = options.containerId;
                this.inputId = options.inputId;
                this.countId = options.countId;
                this.prevBtnId = options.prevBtnId;
                this.nextBtnId = options.nextBtnId;
                this.clearBtnId = options.clearBtnId;

                this.matches = [];
                this.currentIndex = -1;
                this.lastQuery = "";

                this.setupEvents();
            }

            getContainer() {
                return document.getElementById(this.containerId);
            }
            getInput() {
                return document.getElementById(this.inputId);
            }
            getCountBadge() {
                return document.getElementById(this.countId);
            }

            setupEvents() {
                const input = this.getInput();
                if (input) {
                    input.addEventListener("input", () => this.search(input.value));
                    input.addEventListener("keydown", (e) => {
                        if (e.key === "Enter") {
                            e.preventDefault();
                            if (e.shiftKey) {
                                this.prev();
                            } else {
                                this.next();
                            }
                        } else if (e.key === "Escape") {
                            e.preventDefault();
                            this.clear();
                            input.blur();
                        }
                    });
                }

                const prevBtn = document.getElementById(this.prevBtnId);
                if (prevBtn) {
                    prevBtn.addEventListener("click", () => this.prev());
                }

                const nextBtn = document.getElementById(this.nextBtnId);
                if (nextBtn) {
                    nextBtn.addEventListener("click", () => this.next());
                }

                const clearBtn = document.getElementById(this.clearBtnId);
                if (clearBtn) {
                    clearBtn.addEventListener("click", () => {
                        this.clear();
                        if (input) input.focus();
                    });
                }
            }

            clearHighlights() {
                const container = this.getContainer();
                if (!container) return;
                const marks = container.querySelectorAll("mark.app-search-match");
                marks.forEach((mark) => {
                    const parent = mark.parentNode;
                    if (parent) {
                        while (mark.firstChild) {
                            parent.insertBefore(mark.firstChild, mark);
                        }
                        parent.removeChild(mark);
                    }
                });
                container.normalize();
                this.matches = [];
                this.currentIndex = -1;
            }

            updateBadge() {
                const badge = this.getCountBadge();
                if (!badge) return;
                if (!this.lastQuery.trim()) {
                    badge.textContent = "";
                    badge.classList.remove("text-rose-400");
                } else if (this.matches.length === 0) {
                    badge.textContent = "0";
                    badge.classList.add("text-rose-400");
                } else {
                    badge.textContent = `${this.currentIndex + 1}/${this.matches.length}`;
                    badge.classList.remove("text-rose-400");
                }
            }

            search(query) {
                this.clearHighlights();
                this.lastQuery = query || "";
                const cleanQuery = this.lastQuery.trim();

                if (!cleanQuery) {
                    this.updateBadge();
                    return;
                }

                const container = this.getContainer();
                if (!container) return;

                const walker = document.createTreeWalker(
                    container,
                    NodeFilter.SHOW_TEXT,
                    {
                        acceptNode: (node) => {
                            const parent = node.parentNode;
                            if (!parent) return NodeFilter.FILTER_REJECT;
                            const tag = parent.tagName;
                            if (tag === "SCRIPT" || tag === "STYLE" || tag === "TEXTAREA" || tag === "INPUT" || tag === "NOSCRIPT") {
                                return NodeFilter.FILTER_REJECT;
                            }
                            if (parent.closest(".inpage-search-bar") || parent.closest("button")) {
                                return NodeFilter.FILTER_REJECT;
                            }
                            return NodeFilter.FILTER_ACCEPT;
                        }
                    },
                    false
                );

                const textNodes = [];
                let currNode;
                while ((currNode = walker.nextNode())) {
                    textNodes.push(currNode);
                }

                const lowerQuery = cleanQuery.toLowerCase();
                const matches = [];

                textNodes.forEach((node) => {
                    const text = node.nodeValue;
                    const lowerText = text.toLowerCase();
                    let startIdx = 0;
                    let matchIdx = lowerText.indexOf(lowerQuery, startIdx);

                    if (matchIdx === -1) return;

                    const fragment = document.createDocumentFragment();

                    while (matchIdx !== -1) {
                        if (matchIdx > startIdx) {
                            fragment.appendChild(document.createTextNode(text.substring(startIdx, matchIdx)));
                        }

                        const mark = document.createElement("mark");
                        mark.className = "app-search-match";
                        mark.textContent = text.substring(matchIdx, matchIdx + cleanQuery.length);
                        fragment.appendChild(mark);
                        matches.push(mark);

                        startIdx = matchIdx + cleanQuery.length;
                        matchIdx = lowerText.indexOf(lowerQuery, startIdx);
                    }

                    if (startIdx < text.length) {
                        fragment.appendChild(document.createTextNode(text.substring(startIdx)));
                    }

                    if (node.parentNode) {
                        node.parentNode.replaceChild(fragment, node);
                    }
                });

                this.matches = matches;
                if (this.matches.length > 0) {
                    this.currentIndex = 0;
                    this.highlightCurrent(true);
                } else {
                    this.currentIndex = -1;
                    this.updateBadge();
                }
            }

            highlightCurrent(scroll = true) {
                this.matches.forEach((m, idx) => {
                    if (idx === this.currentIndex) {
                        m.classList.add("app-search-active");
                    } else {
                        m.classList.remove("app-search-active");
                    }
                });

                this.updateBadge();

                if (scroll && this.currentIndex >= 0 && this.matches[this.currentIndex]) {
                    const activeElem = this.matches[this.currentIndex];
                    activeElem.scrollIntoView({ behavior: "smooth", block: "center" });
                }
            }

            next() {
                if (this.matches.length === 0) {
                    const input = this.getInput();
                    if (input && input.value.trim()) this.search(input.value);
                    return;
                }
                this.currentIndex = (this.currentIndex + 1) % this.matches.length;
                this.highlightCurrent(true);
            }

            prev() {
                if (this.matches.length === 0) {
                    const input = this.getInput();
                    if (input && input.value.trim()) this.search(input.value);
                    return;
                }
                this.currentIndex = (this.currentIndex - 1 + this.matches.length) % this.matches.length;
                this.highlightCurrent(true);
            }

            clear() {
                this.clearHighlights();
                this.lastQuery = "";
                const input = this.getInput();
                if (input) input.value = "";
                this.updateBadge();
            }
        }

        // =========================================================================
        // RYCHLÉ FILTROVÁNÍ SEZNAMŮ A TABULEK (POZNÁMKY, KARTIČKY, PODCAST, SOUBORY)
        // =========================================================================
        function filterSavedNotesList(term) {
            const list = document.getElementById("savedNotesList");
            if (!list) return;
            const q = (term || "").toLowerCase().trim();
            Array.from(list.children).forEach(li => {
                if (!q) {
                    li.style.display = "";
                } else {
                    li.style.display = li.textContent.toLowerCase().includes(q) ? "" : "none";
                }
            });
        }

        function filterNotesBatchTable(term) {
            const tbody = document.getElementById("notesBatchTableBody");
            if (!tbody) return;
            const q = (term || "").toLowerCase().trim();
            Array.from(tbody.children).forEach(tr => {
                if (!q) {
                    tr.style.display = "";
                } else {
                    tr.style.display = tr.textContent.toLowerCase().includes(q) ? "" : "none";
                }
            });
        }

        function filterSavedDecksList(term) {
            const list = document.getElementById("savedDecksList");
            if (!list) return;
            const q = (term || "").toLowerCase().trim();
            Array.from(list.children).forEach(li => {
                if (!q) {
                    li.style.display = "";
                } else {
                    li.style.display = li.textContent.toLowerCase().includes(q) ? "" : "none";
                }
            });
        }

        function filterCardsBatchTable(term) {
            const tbody = document.getElementById("cardsBatchTableBody");
            if (!tbody) return;
            const q = (term || "").toLowerCase().trim();
            Array.from(tbody.children).forEach(tr => {
                if (!q) {
                    tr.style.display = "";
                } else {
                    tr.style.display = tr.textContent.toLowerCase().includes(q) ? "" : "none";
                }
            });
        }

        function filterDeckTable(term) {
            const tbody = document.getElementById("deckTableBody");
            if (!tbody) return;
            const q = (term || "").toLowerCase().trim();
            Array.from(tbody.children).forEach(tr => {
                if (!q) {
                    tr.style.display = "";
                } else {
                    tr.style.display = tr.textContent.toLowerCase().includes(q) ? "" : "none";
                }
            });
        }

        function filterPodcastQuestionsTable(term) {
            const tbody = document.getElementById("questionsTableBody");
            if (!tbody) return;
            const q = (term || "").toLowerCase().trim();
            Array.from(tbody.children).forEach(tr => {
                if (!q) {
                    tr.style.display = "";
                } else {
                    tr.style.display = tr.textContent.toLowerCase().includes(q) ? "" : "none";
                }
            });
        }

        function filterHomeFilesList(term) {
            const list = document.getElementById("homeFileList");
            if (!list) return;
            const q = (term || "").toLowerCase().trim();
            Array.from(list.children).forEach(li => {
                if (!q) {
                    li.style.display = "";
                } else {
                    li.style.display = li.textContent.toLowerCase().includes(q) ? "" : "none";
                }
            });
        }

        // =========================================================================
        // JEDNOTNÝ TISKOVÝ SERVIS (PRO DESKTOP I PROHLÍŽEČ)
        // =========================================================================
        async function executePrintDocument({ title, htmlContent, project }) {
            if (!htmlContent || !htmlContent.trim()) {
                alert(t("print.noContent", "Není k dispozici žádný obsah k vytištění."));
                return;
            }

            const isPywebview = Boolean(window.pywebview);

            try {
                const res = await fetch("/api/print/prepare", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        title: title || "Studijní dokument",
                        html: htmlContent,
                        project: project || currentProject || "",
                        auto_open_browser: isPywebview
                    })
                });

                if (!res.ok) {
                    throw new Error(`Server vrátil stav ${res.status}`);
                }

                const data = await res.json();

                if (isPywebview) {
                    console.log("🖨️ Tiskový náhled otevřen v systémovém prohlížeči:", data.url);
                } else {
                    const win = window.open(data.url, "_blank");
                    if (!win) {
                        const doOpen = confirm(t("print.popupBlocked", "Vyskakovací okno pro tisk bylo zablokováno. Přejete si otevřít tiskový náhled v této záložce?"));
                        if (doOpen) {
                            window.location.href = data.url;
                        }
                    }
                }
            } catch (err) {
                console.error("Chyba při přípravě tisku, přecházím na lokální tisk:", err);
                window.print();
            }
        }

        function printNotes() {
            const renderedArea = document.getElementById("notesRenderedArea");
            const rawArea = document.getElementById("notesRawArea");
            const isRaw = rawArea && !rawArea.classList.contains("hidden");

            let contentHtml = "";
            if (isRaw) {
                const rawText = rawArea.value || currentNotesMarkdown || "";
                contentHtml = renderMarkdownSafe(rawText);
            } else if (renderedArea) {
                if (renderedArea.querySelector(".text-3xl") && renderedArea.textContent.includes("Zde se zobrazí")) {
                    alert(t("print.selectNotesFirst", "Nejprve vyberte nebo vygenerujte studijní text k tisku."));
                    return;
                }
                contentHtml = renderedArea.innerHTML;
            }

            if (!contentHtml || !contentHtml.trim()) {
                alert(t("print.selectNotesFirst", "Nejprve vyberte nebo vygenerujte studijní text k tisku."));
                return;
            }

            const sourcesBar = document.getElementById("notesSourcesBar");
            const sourcesList = document.getElementById("notesSourcesList");
            if (sourcesBar && !sourcesBar.classList.contains("hidden") && sourcesList && sourcesList.children.length > 0) {
                const sourcesText = Array.from(sourcesList.children).map(c => `<li>${c.textContent.trim()}</li>`).join("");
                contentHtml += `<div style="margin-top: 32px; padding-top: 16px; border-top: 1px solid #cbd5e1;"><h3 style="font-size: 14px; font-weight: bold; margin-bottom: 8px;">Citované podklady:</h3><ul style="font-size: 11.5px; color: #475569; padding-left: 20px;">${sourcesText}</ul></div>`;
            }

            const titleElem = document.getElementById("notesResultTitle");
            const title = titleElem ? titleElem.textContent.trim() : (currentNotesFilename || "Studijní text");

            executePrintDocument({
                title: title || "Studijní text",
                htmlContent: contentHtml,
                project: currentProject || ""
            });
        }

        function printLesson() {
            if (!currentLessonData || !currentLessonData.markdown_content) {
                alert(t("print.selectLessonFirst", "Nejprve vyberte výukovou lekci k tisku."));
                return;
            }

            const renderedArea = document.getElementById("lessonMarkdownRendered");
            let contentHtml = "";
            if (renderedArea && !renderedArea.querySelector(".text-4xl")) {
                contentHtml = renderedArea.innerHTML;
            } else {
                contentHtml = renderMarkdownSafe(currentLessonData.markdown_content);
            }

            if (currentLessonData.lecture_script) {
                const safeScript = escapeHtml(currentLessonData.lecture_script);
                contentHtml += `<div style="margin-top: 40px; padding-top: 20px; border-top: 2px dashed #cbd5e1; page-break-before: always;"><h2 style="font-size: 18px; font-weight: bold; margin-bottom: 12px;">🎙️ Doslovný mluvený scénář přednášky</h2><div style="font-size: 13px; line-height: 1.6; white-space: pre-line; color: #334155;">${safeScript}</div></div>`;
            }

            const title = currentLessonData.title || (document.getElementById("lessonViewerHeaderTitle") ? document.getElementById("lessonViewerHeaderTitle").textContent.trim() : "Výuková lekce");

            executePrintDocument({
                title: title || "Výuková lekce",
                htmlContent: contentHtml,
                project: currentLessonData.project_id || currentProject || ""
            });
        }

        function printCurrentChat() {
            const list = document.getElementById("chatMessagesList");
            if (!list || list.children.length === 0) {
                alert(t("print.noChatMessages", "Aktuální konverzace neobsahuje žádné zprávy k tisku."));
                return;
            }

            if (window.chatSearcher) window.chatSearcher.clearHighlights();

            let contentHtml = `<div class="chat-print-transcript" style="display: flex; flex-direction: column; gap: 18px;">`;
            let hasAny = false;

            if (typeof chatMessages !== "undefined" && chatMessages && chatMessages.length > 0) {
                chatMessages.forEach((msg) => {
                    const isUser = msg.role === "user";
                    const roleLabel = isUser ? "Otázka studenta" : "Odpověď asistenta (AI MedStudio)";
                    const roleColor = isUser ? "#0284c7" : "#059669";
                    const bg = isUser ? "#f0f9ff" : "#f8fafc";
                    const border = isUser ? "#bae6fd" : "#e2e8f0";

                    let bodyHtml = "";
                    if (typeof marked !== "undefined" && marked.parse) {
                        bodyHtml = renderMarkdownSafe(msg.content || "");
                    } else {
                        bodyHtml = `<p>${escapeHtml(msg.content || "")}</p>`;
                    }

                    let sourcesHtml = "";
                    if (msg.sources && msg.sources.length > 0) {
                        const sList = msg.sources.map(s => `<li>${escapeHtml(s.filename || s.file || 'Dokument')} (s. ${escapeHtml(s.page || 'neuvedena')})</li>`).join("");
                        sourcesHtml = `<div style="margin-top: 10px; padding-top: 8px; border-top: 1px dashed #cbd5e1; font-size: 11px; color: #64748b;"><strong>Citované zdroje:</strong><ul style="margin: 4px 0 0 16px; padding: 0;">${sList}</ul></div>`;
                    }

                    contentHtml += `
                        <div style="background: ${bg}; border: 1px solid ${border}; border-radius: 8px; padding: 14px 18px; page-break-inside: avoid;">
                            <div style="font-weight: 800; font-size: 11px; color: ${roleColor}; text-transform: uppercase; margin-bottom: 6px; letter-spacing: 0.05em;">
                                ${roleLabel}
                            </div>
                            <div style="font-size: 13.5px; line-height: 1.6; color: #0f172a;">
                                ${bodyHtml}
                                ${sourcesHtml}
                            </div>
                        </div>
                    `;
                    hasAny = true;
                });
            } else {
                Array.from(list.children).forEach((node) => {
                    if (node.querySelector(".animate-spin") || node.textContent.includes("Načítám")) return;
                    const clone = node.cloneNode(true);
                    clone.querySelectorAll("button, .no-print, input, textarea").forEach(el => el.remove());
                    contentHtml += `
                        <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 14px 18px; page-break-inside: avoid;">
                            <div style="font-size: 13.5px; line-height: 1.6; color: #0f172a;">
                                ${clone.innerHTML}
                            </div>
                        </div>
                    `;
                    hasAny = true;
                });
            }

            contentHtml += `</div>`;

            if (!hasAny) {
                alert(t("print.noFoundMessages", "V konverzaci nebyly nalezeny žádné zprávy k tisku."));
                return;
            }

            const titleElem = document.getElementById("currentChatTitleLabel");
            const title = titleElem ? titleElem.textContent.trim() : "Chat se zdroji";

            executePrintDocument({
                title: `Konzultace: ${title}`,
                htmlContent: contentHtml,
                project: currentProject || ""
            });
        }

        // INICIALIZACE APLIKACE
        window.addEventListener("DOMContentLoaded", () => {
            initAuth();
            setupSSE();
            initPrompts();
            initNotesAndCardsPrompts();
            toggleVoices();
            loadProjects();
            loadAppSettings(true);

            updateCharLimitLabel();
            initConsoleResize();
            checkWelcomeOnStartup();
            if (typeof initPomodoro === "function") {
                initPomodoro();
            }

            // Inicializace vyhledávačů (In-Page Searchers)
            window.chatSearcher = new InPageSearcher({
                containerId: "chatMessagesList",
                inputId: "chatSearchInput",
                countId: "chatSearchCount",
                prevBtnId: "btnChatSearchPrev",
                nextBtnId: "btnChatSearchNext",
                clearBtnId: "btnChatSearchClear"
            });

            window.notesSearcher = new InPageSearcher({
                containerId: "notesRenderedArea",
                inputId: "notesSearchInput",
                countId: "notesSearchCount",
                prevBtnId: "btnNotesSearchPrev",
                nextBtnId: "btnNotesSearchNext",
                clearBtnId: "btnNotesSearchClear"
            });

            window.lessonSearcher = new InPageSearcher({
                containerId: "lessonMarkdownRendered",
                inputId: "lessonSearchInput",
                countId: "lessonSearchCount",
                prevBtnId: "btnLessonSearchPrev",
                nextBtnId: "btnLessonSearchNext",
                clearBtnId: "btnLessonSearchClear"
            });

            window.lessonScriptSearcher = new InPageSearcher({
                containerId: "lessonScriptText",
                inputId: "lessonScriptSearchInput",
                countId: "lessonScriptSearchCount",
                prevBtnId: "btnLessonScriptSearchPrev",
                nextBtnId: "btnLessonScriptSearchNext",
                clearBtnId: "btnLessonScriptSearchClear"
            });

            // Globální zachycení Ctrl+F / Cmd+F -> zaměření vyhledávače aktivní sekce
            window.addEventListener("keydown", (e) => {
                if ((e.ctrlKey || e.metaKey) && (e.key === "f" || e.key === "F")) {
                    e.preventDefault();
                    let targetInput = null;
                    const qmModal = document.getElementById("modalQuestionsManager");
                    if (qmModal && !qmModal.classList.contains("hidden")) {
                        targetInput = document.getElementById("qmSearchInput");
                    } else if (currentTab === "chat") {
                        targetInput = document.getElementById("chatSearchInput");
                    } else if (currentTab === "notes") {
                        targetInput = document.getElementById("notesSearchInput");
                    } else if (currentTab === "lesson") {
                        targetInput = document.getElementById("lessonSearchInput");
                    } else if (currentTab === "cards") {
                        targetInput = document.getElementById("deckSearchInput") || document.getElementById("cardsBatchFilterInput");
                    } else if (currentTab === "files") {
                        targetInput = document.getElementById("viewerFilesSearchInput") || document.getElementById("viewerTextSearchInput");
                    } else if (currentTab === "planner") {
                        targetInput = document.getElementById("plannerSearchInput");
                    } else if (currentTab === "podcast") {
                        targetInput = document.getElementById("podcastQuestionsSearchInput");
                    } else if (currentTab === "home") {
                        targetInput = document.getElementById("homeFilesSearchInput");
                    }

                    if (targetInput) {
                        targetInput.focus();
                        targetInput.select();
                    }
                }
            });

            document.getElementById("resultScriptTextarea").addEventListener("input", (e) => {
                document.getElementById("charCount").textContent = e.target.value.length;
            });

            // Klávesové zkratky pro flashcards (Mezerník = otočit, Šipky = navigace)
            window.addEventListener("keydown", (e) => {
                if (currentTab !== "cards") return;
                if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName)) return;

                if (e.code === "Space") {
                    e.preventDefault();
                    flipCurrentCard();
                } else if (e.code === "ArrowRight") {
                    e.preventDefault();
                    nextCard();
                } else if (e.code === "ArrowLeft") {
                    e.preventDefault();
                    prevCard();
                }
            });

            // Inicializace jazykového rozhraní
            if (typeof window.updateLangUI === "function") {
                window.updateLangUI();
            }

            // Inicializace výchozí záložky na Přehled projektu
            switchTab("home");
        });

        // --- PŘEPÍNÁNÍ ZÁLOŽEK ---
        function switchTab(tabId) {
            currentTab = tabId;
            const tabIds = ["home", "files", "planner", "medulingo", "pomodoro", "podcast", "notes", "cards", "tests", "chat", "lesson"];
            
            tabIds.forEach(id => {
                const view = document.getElementById(`view${id.charAt(0).toUpperCase() + id.slice(1)}`);
                const btn = document.getElementById(`tabBtn-${id}`);
                const sBtn = document.getElementById(`sidebarTabBtn-${id}`);
                
                if (id === tabId) {
                    if (view) view.classList.remove("hidden");
                    if (btn) btn.className = id === "files" 
                        ? "tab-btn px-4 py-2 rounded-lg flex items-center gap-2 transition bg-sky-900/60 text-sky-300 border border-sky-700/50 shadow-sm"
                        : "tab-btn px-4 py-2 rounded-lg flex items-center gap-2 transition bg-emerald-900/60 text-emerald-300 border border-emerald-700/50 shadow-sm";
                    if (sBtn) {
                        if (id === "files") {
                            sBtn.className = "w-full text-left px-3 py-2.5 rounded-xl flex items-center gap-3 bg-sky-950/80 text-sky-300 border border-sky-700/60 font-bold shadow-sm transition";
                        } else {
                            sBtn.className = "w-full text-left px-3 py-2.5 rounded-xl flex items-center gap-3 bg-emerald-950/80 text-emerald-300 border border-emerald-700/60 font-bold shadow-sm transition";
                        }
                    }
                } else {
                    if (view) view.classList.add("hidden");
                    if (btn) btn.className = "tab-btn px-4 py-2 rounded-lg flex items-center gap-2 transition text-slate-400 hover:text-slate-200 hover:bg-slate-800/60";
                    if (sBtn) {
                        if (id === "files") {
                            sBtn.className = "w-full text-left px-3 py-2.5 rounded-xl flex items-center gap-3 text-sky-300/90 hover:text-sky-200 hover:bg-slate-900 border border-sky-900/30 transition font-medium";
                        } else if (id === "medulingo") {
                            sBtn.className = "w-full text-left px-3 py-2.5 rounded-xl flex items-center gap-3 text-emerald-300/90 hover:text-emerald-200 hover:bg-slate-900 border border-emerald-800/40 transition font-semibold";
                        } else if (id === "pomodoro") {
                            sBtn.className = "w-full text-left px-3 py-2.5 rounded-xl flex items-center gap-3 text-rose-300/90 hover:text-rose-200 hover:bg-slate-900 border border-rose-900/30 transition font-medium";
                        } else {
                            sBtn.className = "w-full text-left px-3 py-2.5 rounded-xl flex items-center gap-3 text-slate-300 hover:text-white hover:bg-slate-900 border border-transparent transition font-medium";
                        }
                    }
                }
            });

            if (tabId === "home") {
                updateDashboardStats();
            } else if (tabId === "files") {
                loadViewerFileList();
            } else if (tabId === "planner") {
                renderExamPlanner();
            } else if (tabId === "medulingo") {
                loadMedulingo();
            } else if (tabId === "pomodoro") {
                renderPomodoroView();
                syncQuestionsDropdowns();
            } else if (tabId === "notes") {
                loadSavedNotesList();
                syncQuestionsDropdowns();
            } else if (tabId === "cards") {
                loadSavedFlashcardsList();
                syncQuestionsDropdowns();
            } else if (tabId === "tests") {
                loadTestsTab();
                syncQuestionsDropdowns();
            } else if (tabId === "podcast") {
                loadExplorer();
            } else if (tabId === "chat") {
                loadChatHistory();
            } else if (tabId === "lesson") {
                loadLessonsList();
            }

            if (typeof applyTranslations === "function") {
                applyTranslations(currentLanguage);
            }
        }

        // --- BOČNÍ MENU (PERSISTENTNÍ NA DESKTOPU, VYSOUVACÍ NA MOBILU / PŘI ŠKÁLOVÁNÍ) ---
        function toggleSidebarDrawer(force) {
            // Na běžném desktopu (>= 1024px) je menu trvale přítomné
            if (window.innerWidth >= 1024) return;
            const drawer = document.getElementById("sidebarDrawer");
            const backdrop = document.getElementById("sidebarBackdrop");
            if (!drawer) return;
            const isCurrentlyOpen = drawer.classList.contains("translate-x-0") && !drawer.classList.contains("-translate-x-full");
            const shouldOpen = typeof force === "boolean" ? force : !isCurrentlyOpen;

            if (shouldOpen) {
                drawer.classList.remove("-translate-x-full");
                drawer.classList.add("translate-x-0");
                if (backdrop) {
                    backdrop.classList.remove("opacity-0", "pointer-events-none");
                    backdrop.classList.add("opacity-100", "pointer-events-auto");
                }
            } else {
                drawer.classList.remove("translate-x-0");
                drawer.classList.add("-translate-x-full");
                if (backdrop) {
                    backdrop.classList.remove("opacity-100", "pointer-events-auto");
                    backdrop.classList.add("opacity-0", "pointer-events-none");
                }
            }
        }

        function sidebarSwitchTab(tabId) {
            if (window.innerWidth < 1024) {
                toggleSidebarDrawer(false);
            }
            switchTab(tabId);
        }

        window.addEventListener("resize", () => {
            if (window.innerWidth >= 1024) {
                const backdrop = document.getElementById("sidebarBackdrop");
                if (backdrop) {
                    backdrop.classList.remove("opacity-100", "pointer-events-auto");
                    backdrop.classList.add("opacity-0", "pointer-events-none");
                }
                const drawer = document.getElementById("sidebarDrawer");
                if (drawer) {
                    drawer.classList.remove("translate-x-0");
                    drawer.classList.add("-translate-x-full");
                }
            }
        });

        // --- KONZOLE VÝSUVNÝ PANEL & ŠKÁLOVÁNÍ ---
        function toggleConsoleDrawer() {
            const drawer = document.getElementById("consoleDrawer");
            if (drawer) drawer.classList.toggle("hidden");
        }

        function clearConsoleLog() {
            const term = document.getElementById("liveTerminal");
            if (term) term.innerHTML = `<div class="italic text-slate-600">${t("common.consoleCleared", "// Konzole vyčištěna.")}</div>`;
        }

        function setConsoleHeight(px) {
            const term = document.getElementById("liveTerminal");
            if (!term) return;
            term.style.height = `${px}px`;
            const drawer = document.getElementById("consoleDrawer");
            if (drawer && drawer.classList.contains("hidden")) {
                drawer.classList.remove("hidden");
            }
        }

        function initConsoleResize() {
            const handle = document.getElementById("consoleResizeHandle");
            const term = document.getElementById("liveTerminal");
            if (!handle || !term) return;

            let isResizing = false;
            let startY = 0;
            let startH = 0;

            handle.addEventListener("mousedown", (e) => {
                isResizing = true;
                startY = e.clientY;
                startH = term.offsetHeight;
                document.body.style.cursor = "ns-resize";
                document.body.style.userSelect = "none";
            });

            window.addEventListener("mousemove", (e) => {
                if (!isResizing) return;
                const delta = e.clientY - startY;
                const newH = Math.max(100, Math.min(window.innerHeight * 0.8, startH + delta));
                term.style.height = `${newH}px`;
            });

            window.addEventListener("mouseup", () => {
                if (isResizing) {
                    isResizing = false;
                    document.body.style.cursor = "";
                    document.body.style.userSelect = "";
                }
            });
        }

        // --- UVÍTACÍ PRŮVODCE (WELCOME MODAL) ---
        function openWelcomeModal() {
            const m = document.getElementById("modalWelcome");
            if (m) m.classList.remove("hidden");
        }

        function closeWelcomeModal() {
            const m = document.getElementById("modalWelcome");
            if (m) m.classList.add("hidden");
            const chk = document.getElementById("welcomeDoNotShowAgain");
            if (chk && chk.checked) {
                try {
                    localStorage.setItem("aiMedStudio_welcomed_v2", "true");
                } catch(e) {}
            }
        }

        function checkWelcomeOnStartup() {
            try {
                if (!localStorage.getItem("aiMedStudio_welcomed_v2")) {
                    openWelcomeModal();
                }
            } catch(e) {}
        }

        // --- ŠKÁLOVÁNÍ A ROZŠÍŘENÍ OKEN OBSAHU (ČTENÍ, SPRÁVCE, MEDULINGO) ---
        function toggleLessonFullWidth() {
            const left = document.getElementById("lessonLeftPanel");
            const right = document.getElementById("lessonRightPanel");
            const btnText = document.getElementById("btnLessonFullWidthText");
            if (!left) return;

            if (left.classList.contains("lg:col-span-12")) {
                left.classList.remove("lg:col-span-12");
                left.classList.add("lg:col-span-7");
                if (right) right.classList.remove("hidden");
                if (btnText) btnText.textContent = "Rozšířit";
            } else {
                left.classList.remove("lg:col-span-7");
                left.classList.add("lg:col-span-12");
                if (right) right.classList.add("hidden");
                if (btnText) btnText.textContent = "Zúžit";
            }
        }

        function setLessonFontSize(action) {
            const el = document.getElementById("lessonMarkdownRendered");
            if (!el) return;
            if (action === "inc") lessonCurrentFontSize = Math.min(26, lessonCurrentFontSize + 2);
            else if (action === "dec") lessonCurrentFontSize = Math.max(12, lessonCurrentFontSize - 2);
            else lessonCurrentFontSize = 16;
            el.style.fontSize = `${lessonCurrentFontSize}px`;
        }

        function setMedFontSize(action) {
            const el = document.getElementById("medSubtopicMarkdownBody");
            if (!el) return;
            if (action === "inc") medCurrentFontSize = Math.min(26, medCurrentFontSize + 2);
            else if (action === "dec") medCurrentFontSize = Math.max(12, medCurrentFontSize - 2);
            else medCurrentFontSize = 16;
            el.style.fontSize = `${medCurrentFontSize}px`;
        }

        function toggleQmMaximize() {
            const dialog = document.getElementById("modalQuestionsManagerDialog");
            const btn = document.getElementById("btnQmMaximize");
            if (!dialog) return;

            if (dialog.classList.contains("h-full")) {
                dialog.classList.remove("w-full", "h-full", "max-w-none", "rounded-none");
                dialog.classList.add("max-w-5xl", "h-[92vh]", "rounded-2xl");
                if (btn) btn.textContent = "⛶";
            } else {
                dialog.classList.remove("max-w-5xl", "h-[92vh]", "rounded-2xl");
                dialog.classList.add("w-full", "h-full", "max-w-none", "rounded-none");
                if (btn) btn.textContent = "🗗";
            }
        }

        function toggleMedulingoMaximize() {
            const modal = document.getElementById("medulingoPathModal");
            const dialog = modal ? modal.querySelector(".bg-slate-900") : null;
            const btn = document.getElementById("btnMedMaximize");
            if (!dialog) return;

            if (dialog.classList.contains("h-full")) {
                dialog.classList.remove("w-full", "h-full", "max-w-none", "rounded-none");
                dialog.classList.add("max-w-4xl", "h-[92vh]", "rounded-3xl");
                if (btn) btn.textContent = "⛶";
            } else {
                dialog.classList.remove("max-w-4xl", "h-[92vh]", "rounded-3xl");
                dialog.classList.add("w-full", "h-full", "max-w-none", "rounded-none");
                if (btn) btn.textContent = "🗗";
            }
        }

        // --- STATISTIKY DASHBOARDU ---
        async function updateDashboardStats() {
            const qCount = questions.length;
            const statQ = document.getElementById("statQuestions");
            if (statQ) statQ.textContent = qCount;
            const globalQBadge = document.getElementById("globalQuestionsBadge");
            if (globalQBadge) globalQBadge.textContent = qCount;
            const sidebarQBadge = document.getElementById("sidebarQuestionsBadge");
            if (sidebarQBadge) sidebarQBadge.textContent = qCount;
            const qmTotalBadge = document.getElementById("qmQuestionsTotalBadge");
            if (qmTotalBadge) qmTotalBadge.textContent = `${qCount} otázek`;

            if (!currentProject) {
                document.getElementById("statFiles").textContent = "0";
                document.getElementById("statMedia").textContent = "0";
                document.getElementById("statNotes").textContent = "0";
                document.getElementById("statCards").textContent = "0";
                const statT = document.getElementById("statTests");
                if (statT) statT.textContent = "0";
                const statL = document.getElementById("statLessons");
                if (statL) statL.textContent = "0";
                document.getElementById("homeProjectName").textContent = "--";
                return;
            }

            document.getElementById("homeProjectName").textContent = currentProject;

            try {
                const res = await fetch(`/api/stats?project=${encodeURIComponent(currentProject)}`);
                const data = await res.json();
                document.getElementById("statFiles").textContent = data.files_count || 0;
                document.getElementById("statMedia").textContent = data.media_count || 0;
                document.getElementById("statNotes").textContent = data.notes_count || 0;
                document.getElementById("statCards").textContent = data.flashcards_count || 0;
                const statT = document.getElementById("statTests");
                if (statT) statT.textContent = data.tests_count || 0;
                const statL = document.getElementById("statLessons");
                if (statL) statL.textContent = data.lessons_count || 0;
            } catch (e) {
                console.error("Chyba při načítání statistik:", e);
            }
        }

        // --- SPRÁVA PROJEKTŮ ---
        async function loadProjects() {
            const res = await fetch("/api/projects");
            const data = await res.json();
            const select = document.getElementById("projectSelect");
            select.innerHTML = '<option value="">-- Vyberte projekt --</option>';
            data.projects.forEach(p => {
                const opt = document.createElement("option");
                opt.value = p; opt.textContent = p;
                select.appendChild(opt);
            });
            
            let savedProj = localStorage.getItem("aiPodcastActiveProject");
            if (savedProj && (savedProj.startsWith("lekce_") || savedProj.startsWith("lesson_"))) {
                localStorage.removeItem("aiPodcastActiveProject");
                savedProj = null;
            }
            if(savedProj && data.projects.includes(savedProj)) {
                select.value = savedProj;
                onProjectChange();
            } else if (!data.projects.includes(currentProject)) {
                currentProject = "";
                select.value = "";
                onProjectChange();
            }
        }

        async function createNewProject() {
            const name = prompt(t("project.promptNewName", "Zadejte název nového projektu (např. Interna, ARO, Pediatrie):"));
            if (!name || name.trim() === "") return;
            const res = await fetch("/api/projects", {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({ name: name.trim() })
            });
            const data = await res.json();
            if (!res.ok) {
                alert(`Chyba při zakládání projektu: ${data.detail || "Neznámá chyba"}`);
                return;
            }
            await loadProjects();
            const safe = data.project || name.replace(/[^a-zA-Z0-9_-]/g, '_');
            document.getElementById("projectSelect").value = safe;
            await onProjectChange();
            const modal = document.getElementById("modalProjectManager");
            if (modal && !modal.classList.contains("hidden")) {
                openProjectManagerModal();
            }

            // Otevřeme přívětivou nabídku pro přidání otázek do nového projektu
            openNewProjectQuestionsOfferModal(safe);
        }

        function openNewProjectQuestionsOfferModal(projectName) {
            const modal = document.getElementById("modalNewProjectQuestionsOffer");
            if (!modal) return;
            const titleEl = document.getElementById("newProjectOfferTitle");
            if (titleEl) titleEl.textContent = `Projekt: ${projectName}`;
            modal.classList.remove("hidden");
        }

        function closeNewProjectQuestionsOfferModal() {
            const modal = document.getElementById("modalNewProjectQuestionsOffer");
            if (modal) modal.classList.add("hidden");
        }

        function chooseNewProjectAction(action) {
            closeNewProjectQuestionsOfferModal();
            if (action === 'import') {
                openPlannerImportModal();
            } else if (action === 'add_manual') {
                openPlannerAddQuestionModal();
            } else if (action === 'open_manager') {
                openQuestionsManagerModal();
            }
        }

        async function onProjectChange() {
            const requestedProject = document.getElementById("projectSelect").value;
            if (activeBatch && requestedProject !== activeBatch.project) {
                alert(t("project.batchRunningNoSwitch", "Během dávkového zpracování nelze změnit projekt. Nejprve vyčkejte na dokončení nebo použijte Storno."));
                document.getElementById("projectSelect").value = currentProject;
                return;
            }

            activeLessonChatContext = null;
            currentProject = requestedProject;
            localStorage.setItem("aiPodcastActiveProject", currentProject);

            // Okamžitý striktní reset stavu otázek v paměti pro nový projekt, aby nedošlo k jakémukoli prolínání
            questions = [];
            selectedQuestionIndex = null;
            examPlanner = { examDate: "", startDate: "", revisionDays: 14, questions: [] };
            renderQuestionsTable();
            renderExamPlanner();
            syncQuestionsDropdowns();
            renderQuestionsManagerTable();

            // Aktualizace tlačítek správy v horní liště
            const btnDelHeader = document.getElementById("btnHeaderDeleteProject");
            if (btnDelHeader) {
                btnDelHeader.disabled = !currentProject;
                btnDelHeader.title = currentProject ? `Smazat projekt '${currentProject}'` : "Vyberte projekt ke smazání";
            }
            
            const exProjLabel = document.getElementById("explorerProjName");
            if (exProjLabel) exProjLabel.textContent = currentProject || "Vše";

            const chatProjLabel = document.getElementById("chatCurrentProjectLabel");
            if (chatProjLabel) chatProjLabel.textContent = currentProject || "-- (Není vybrán)";

            const sideProjectLbl = document.getElementById("sidebarProjectLabel");
            if (sideProjectLbl) sideProjectLbl.textContent = currentProject || "--";

            if (currentProject) {
                loadFileList();
                loadViewerFileList();
                await loadProjectQuestionsAndPlanner();
                updateDashboardStats();
                loadSavedNotesList();
                loadSavedFlashcardsList();
                if (currentTab === "chat") loadChatHistory();
            } else {
                loadViewerFileList();
                updateDashboardStats();
                if (currentTab === "chat") loadChatHistory();
            }
            loadExplorer();
        }

        // --- SPRÁVCE PROJEKTŮ (MODAL A AKCE) ---
        async function openProjectManagerModal() {
            const modal = document.getElementById("modalProjectManager");
            if (!modal) return;
            modal.classList.remove("hidden");

            const badge = document.getElementById("pmActiveBadge");
            const titleDisp = document.getElementById("pmProjectTitleDisplay");
            const delFolder = document.getElementById("pmDeleteFolderName");
            const delBtnName = document.getElementById("pmDeleteBtnName");
            const currentProjSection = document.getElementById("pmCurrentProjectSection");
            const noProjNotice = document.getElementById("pmNoProjectNotice");

            if (currentProject) {
                if (badge) { badge.textContent = currentProject; badge.classList.remove("hidden"); }
                if (titleDisp) titleDisp.textContent = currentProject;
                if (delFolder) delFolder.textContent = `uploads/${currentProject}/`;
                if (delBtnName) delBtnName.textContent = currentProject;
                if (currentProjSection) currentProjSection.classList.remove("hidden");
                if (noProjNotice) noProjNotice.classList.add("hidden");

                // Načteme detailní statistiky
                try {
                    const res = await fetch(`/api/stats?project=${encodeURIComponent(currentProject)}`);
                    const stats = await res.json();
                    document.getElementById("pmStatFiles").textContent = stats.files_count || 0;
                    document.getElementById("pmStatQuestions").textContent = stats.questions_count || 0;
                    document.getElementById("pmStatNotes").textContent = stats.notes_count || 0;
                    document.getElementById("pmStatCards").textContent = stats.flashcards_count || 0;
                    document.getElementById("pmStatTests").textContent = stats.tests_count || 0;
                    document.getElementById("pmStatMedia").textContent = stats.media_count || 0;
                    document.getElementById("pmStatLessons").textContent = stats.lessons_count || 0;
                    document.getElementById("pmStatChat").textContent = stats.chat_count || 0;
                } catch (e) {
                    console.error("Chyba při načítání statistik projektu v modalu:", e);
                }
            } else {
                if (badge) badge.classList.add("hidden");
                if (currentProjSection) currentProjSection.classList.add("hidden");
                if (noProjNotice) noProjNotice.classList.remove("hidden");
            }

            // Načteme tabulku všech projektů
            await renderPmProjectsTable();
        }

        function closeProjectManagerModal() {
            const modal = document.getElementById("modalProjectManager");
            if (modal) modal.classList.add("hidden");
        }

        async function renderPmProjectsTable() {
            const tbody = document.getElementById("pmProjectsTableBody");
            if (!tbody) return;
            tbody.innerHTML = `<tr><td colspan="3" class="p-3 text-center text-slate-500">${t("project.loadingProjects", "Načítám projekty...")}</td></tr>`;

            try {
                const res = await fetch("/api/projects");
                const data = await res.json();
                const projects = data.projects || [];

                if (projects.length === 0) {
                    tbody.innerHTML = `<tr><td colspan="3" class="p-4 text-center text-slate-500">${t("project.noProjectsYet", "Zatím nebyly vytvořeny žádné projekty.")}</td></tr>`;
                    return;
                }

                let html = "";
                projects.forEach(p => {
                    const isActive = (p === currentProject);
                    html += `
                        <tr class="hover:bg-slate-900/60 transition ${isActive ? 'bg-emerald-950/20' : ''}">
                            <td class="py-2.5 px-3 font-semibold text-slate-200">
                                <div class="flex items-center gap-2">
                                    <span class="text-base">📁</span>
                                    <span class="font-mono text-xs sm:text-sm text-slate-100">${escapeHtml(p)}</span>
                                    ${isActive ? '<span class="text-[10px] bg-emerald-950 text-emerald-400 font-bold px-1.5 py-0.2 rounded border border-emerald-800">Aktivní</span>' : ''}
                                </div>
                            </td>
                            <td class="py-2.5 px-3 text-center">
                                ${isActive 
                                    ? '<span class="text-emerald-400 font-semibold text-[11px]">Vybrán</span>' 
                                    : `<button type="button" onclick="switchToProject('${escapeJsStringAttr(p)}')" class="text-[11px] bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white px-2.5 py-1 rounded border border-slate-700 transition">Aktivovat</button>`
                                }
                            </td>
                            <td class="py-2.5 px-3 text-right">
                                <div class="flex items-center justify-end gap-1.5">
                                    <button type="button" onclick="openProjectExportModal('${escapeJsStringAttr(p)}')" class="text-xs bg-slate-800 hover:bg-slate-700 text-emerald-400 hover:text-emerald-300 px-2 py-1 rounded border border-slate-700 transition" title="Exportovat a stáhnout balíček (.medproj) pro sdílení">
                                        📦
                                    </button>
                                    <button type="button" onclick="promptRenameProject('${escapeJsStringAttr(p)}')" class="text-xs bg-slate-800 hover:bg-slate-700 text-sky-400 hover:text-sky-300 px-2 py-1 rounded border border-slate-700 transition" title="Přejmenovat projekt">
                                        ✏️
                                    </button>
                                    <button type="button" onclick="confirmDeleteProjectByName('${escapeJsStringAttr(p)}')" class="text-xs bg-rose-950/50 hover:bg-rose-900 text-rose-300 hover:text-rose-100 px-2 py-1 rounded border border-rose-800/60 transition" title="Smazat projekt">
                                        🗑️
                                    </button>
                                </div>
                            </td>
                        </tr>
                    `;
                });
                tbody.innerHTML = html;
            } catch (e) {
                tbody.innerHTML = `<tr><td colspan="3" class="p-3 text-center text-rose-400">Chyba při načítání: ${escapeHtml(e.message)}</td></tr>`;
            }
        }

        function switchToProject(projName) {
            const select = document.getElementById("projectSelect");
            if (select) {
                select.value = projName;
                onProjectChange();
                openProjectManagerModal();
            }
        }

        async function confirmDeleteCurrentProject() {
            if (!currentProject) {
                alert(t("project.noActiveToDelete", "Není vybrán žádný aktivní projekt ke smazání."));
                return;
            }
            await confirmDeleteProjectByName(currentProject);
        }

        async function confirmDeleteProjectByName(projName) {
            if (!projName) return;

            const isCurrent = (projName === currentProject);
            const msg = `⚠️ OPRAVDU CHCETE TRVALE SMAZAT PROJEKT "${projName}"?\n\nTato operace nenávratně odstraní:\n` +
                        `• Složku projektu uploads/${projName}/ a všechny nahrané PDF/skripta\n` +
                        `• Vektorový index ChromaDB i FTS vyhledávání\n` +
                        `• Zkouškové otázky a plánovač zkoušky\n` +
                        `• Veškeré vygenerované poznámky, Anki kartičky, testy a podcasty\n` +
                        `• Kompletní historii chatu a výukové lekce projektu\n\n` +
                        `Přejete si projekt definitivně smazat?`;

            if (!confirm(msg)) return;

            const confirmName = prompt(`Pro potvrzení smazání zadejte přesný název projektu "${projName}":`);
            if (confirmName !== projName) {
                if (confirmName !== null) {
                    alert(t("project.deleteNameMismatch", "Zadaný název se neshoduje. Smazání projektu bylo zrušeno."));
                }
                return;
            }

            try {
                const res = await fetch(`/api/projects/${encodeURIComponent(projName)}`, {
                    method: "DELETE"
                });
                const data = await res.json();

                if (!res.ok) {
                    alert(`Chyba při mazání projektu: ${data.detail || "Neznámá chyba"}`);
                    return;
                }

                alert(`Projekt "${projName}" byl úspěšně a kompletně smazán.`);

                if (isCurrent) {
                    currentProject = "";
                    localStorage.removeItem("aiPodcastActiveProject");
                }

                await loadProjects();

                const select = document.getElementById("projectSelect");
                if (!currentProject && select && select.options.length > 1) {
                    select.selectedIndex = 1;
                    onProjectChange();
                } else {
                    onProjectChange();
                }

                const modal = document.getElementById("modalProjectManager");
                if (modal && !modal.classList.contains("hidden")) {
                    openProjectManagerModal();
                }
            } catch (e) {
                alert(`Chyba při mazání projektu: ${e.message}`);
            }
        }

        async function promptRenameProject(targetProject) {
            const projToRename = targetProject || currentProject;
            if (!projToRename) {
                alert(t("project.noProjectToRename", "Není vybrán žádný projekt k přejmenování."));
                return;
            }

            const newName = prompt(`Zadejte nový název pro projekt "${projToRename}":`, projToRename);
            if (!newName || newName.trim() === "" || newName.trim() === projToRename) return;

            try {
                const res = await fetch(`/api/projects/${encodeURIComponent(projToRename)}/rename`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ new_name: newName.trim() })
                });
                const data = await res.json();

                if (!res.ok) {
                    alert(`Chyba při přejmenování projektu: ${data.detail || "Neznámá chyba"}`);
                    return;
                }

                const finalName = data.new_project;
                alert(`Projekt byl úspěšně přejmenován na "${finalName}".`);

                if (currentProject === projToRename) {
                    currentProject = finalName;
                    localStorage.setItem("aiPodcastActiveProject", finalName);
                }

                await loadProjects();
                const select = document.getElementById("projectSelect");
                if (select) select.value = currentProject;
                onProjectChange();

                const modal = document.getElementById("modalProjectManager");
                if (modal && !modal.classList.contains("hidden")) {
                    openProjectManagerModal();
                }
            } catch (e) {
                alert(`Chyba při přejmenování: ${e.message}`);
            }
        }

        function togglePmClearOptions() {
            const container = document.getElementById("pmClearOptionsContainer");
            const btn = document.getElementById("btnPmToggleClear");
            if (!container) return;
            const isHidden = container.classList.contains("hidden");
            if (isHidden) {
                container.classList.remove("hidden");
                if (btn) btn.textContent = "Sbalit volby ▴";
            } else {
                container.classList.add("hidden");
                if (btn) btn.textContent = "Rozbalit volby ▾";
            }
        }

        async function executePmClearData() {
            if (!currentProject) {
                alert(t("common.selectProject", "Nejprve vyberte projekt."));
                return;
            }

            const clearChat = document.getElementById("chkClearChat")?.checked || false;
            const clearNotes = document.getElementById("chkClearNotes")?.checked || false;
            const clearFlashcards = document.getElementById("chkClearFlashcards")?.checked || false;
            const clearTests = document.getElementById("chkClearTests")?.checked || false;
            const clearAudio = document.getElementById("chkClearAudio")?.checked || false;

            if (!clearChat && !clearNotes && !clearFlashcards && !clearTests && !clearAudio) {
                alert(t("project.selectCategoriesToClear", "Vyberte alespoň jednu kategorii výstupů ke smazání."));
                return;
            }

            if (!confirm(`Opravdu si přejete smazat vybrané vygenerované výstupy pro projekt "${currentProject}"?\nZdrojové nahrané knihy a skripta zůstanou nedotčeny.`)) {
                return;
            }

            try {
                const res = await fetch(`/api/projects/${encodeURIComponent(currentProject)}/clear-data`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        clear_chat: clearChat,
                        clear_notes: clearNotes,
                        clear_flashcards: clearFlashcards,
                        clear_tests: clearTests,
                        clear_audio: clearAudio
                    })
                });
                const data = await res.json();
                if (!res.ok) {
                    alert(`Chyba při čištění: ${data.detail || "Neznámá chyba"}`);
                    return;
                }

                alert(`Vybrané výstupy byly úspěšně promazány: ${data.cleared_categories.join(', ')}`);
                
                // Reset checkboxů
                if (document.getElementById("chkClearChat")) document.getElementById("chkClearChat").checked = false;
                if (document.getElementById("chkClearNotes")) document.getElementById("chkClearNotes").checked = false;
                if (document.getElementById("chkClearFlashcards")) document.getElementById("chkClearFlashcards").checked = false;
                if (document.getElementById("chkClearTests")) document.getElementById("chkClearTests").checked = false;
                if (document.getElementById("chkClearAudio")) document.getElementById("chkClearAudio").checked = false;

                // Obnovení UI
                updateDashboardStats();
                loadSavedNotesList();
                loadSavedFlashcardsList();
                loadExplorer();
                if (currentTab === "chat") loadChatHistory();
                openProjectManagerModal();
            } catch (e) {
                alert(`Chyba: ${e.message}`);
            }
        }

