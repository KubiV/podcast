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
                if (typeof marked !== "undefined" && marked.parse) {
                    contentHtml = marked.parse(rawText);
                } else {
                    contentHtml = `<pre>${rawText}</pre>`;
                }
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
            } else if (typeof marked !== "undefined" && marked.parse) {
                contentHtml = marked.parse(currentLessonData.markdown_content);
            } else {
                contentHtml = `<pre>${currentLessonData.markdown_content}</pre>`;
            }

            if (currentLessonData.lecture_script) {
                const safeScript = currentLessonData.lecture_script
                    .replace(/&/g, "&amp;")
                    .replace(/</g, "&lt;")
                    .replace(/>/g, "&gt;");
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
                        bodyHtml = marked.parse(msg.content || "");
                    } else {
                        bodyHtml = `<p>${(msg.content || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</p>`;
                    }

                    let sourcesHtml = "";
                    if (msg.sources && msg.sources.length > 0) {
                        const sList = msg.sources.map(s => `<li>${s.filename || s.file || 'Dokument'} (s. ${s.page || 'neuvedena'})</li>`).join("");
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
                                    : `<button type="button" onclick="switchToProject('${escapeQuotes(p)}')" class="text-[11px] bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white px-2.5 py-1 rounded border border-slate-700 transition">Aktivovat</button>`
                                }
                            </td>
                            <td class="py-2.5 px-3 text-right">
                                <div class="flex items-center justify-end gap-1.5">
                                    <button type="button" onclick="openProjectExportModal('${escapeQuotes(p)}')" class="text-xs bg-slate-800 hover:bg-slate-700 text-emerald-400 hover:text-emerald-300 px-2 py-1 rounded border border-slate-700 transition" title="Exportovat a stáhnout balíček (.medproj) pro sdílení">
                                        📦
                                    </button>
                                    <button type="button" onclick="promptRenameProject('${escapeQuotes(p)}')" class="text-xs bg-slate-800 hover:bg-slate-700 text-sky-400 hover:text-sky-300 px-2 py-1 rounded border border-slate-700 transition" title="Přejmenovat projekt">
                                        ✏️
                                    </button>
                                    <button type="button" onclick="confirmDeleteProjectByName('${escapeQuotes(p)}')" class="text-xs bg-rose-950/50 hover:bg-rose-900 text-rose-300 hover:text-rose-100 px-2 py-1 rounded border border-rose-800/60 transition" title="Smazat projekt">
                                        🗑️
                                    </button>
                                </div>
                            </td>
                        </tr>
                    `;
                });
                tbody.innerHTML = html;
            } catch (e) {
                tbody.innerHTML = `<tr><td colspan="3" class="p-3 text-center text-rose-400">Chyba při načítání: ${e.message}</td></tr>`;
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

        // =========================================================================
        // SDÍLENÍ PROJEKTŮ: EXPORT A IMPORT SOUBORŮ .MEDPROJ / .ZIP
        // =========================================================================

        let currentExportTargetProject = "";
        let currentImportFile = null;
        let currentImportInspectData = null;

        async function openProjectExportModal(projectName) {
            const target = projectName || currentProject;
            if (!target) {
                alert(t("project.export.selectFirst", "Nejprve vyberte projekt k exportu."));
                return;
            }

            currentExportTargetProject = target;
            const modal = document.getElementById("modalProjectExport");
            if (!modal) return;

            modal.classList.remove("hidden");
            const badge = document.getElementById("exportProjectBadge");
            if (badge) badge.textContent = target;

            const loadingState = document.getElementById("exportLoadingState");
            const contentState = document.getElementById("exportContentState");
            if (loadingState) loadingState.classList.remove("hidden");
            if (contentState) contentState.classList.add("hidden");

            const btn = document.getElementById("btnExecuteProjectExport");
            const btnIcon = document.getElementById("btnExecuteExportIcon");
            const btnText = document.getElementById("btnExecuteExportText");
            if (btn) btn.disabled = false;
            if (btnIcon) btnIcon.textContent = "📦";
            if (btnText) btnText.textContent = "Stáhnout balíček projektu (.medproj)";

            try {
                const res = await fetch(`/api/projects/${encodeURIComponent(target)}/export-info`);
                if (!res.ok) throw new Error("Nepodařilo se načíst informace o projektu.");
                const info = await res.json();

                if (document.getElementById("exportStatFiles")) {
                    document.getElementById("exportStatFiles").textContent = info.source_files_count || 0;
                }
                if (document.getElementById("exportStatFilesSize")) {
                    const mb = ((info.source_bytes || 0) / (1024 * 1024)).toFixed(1);
                    document.getElementById("exportStatFilesSize").textContent = `${mb} MB podkladů`;
                }
                if (document.getElementById("exportStatChunks")) {
                    document.getElementById("exportStatChunks").textContent = (info.chunks_count || 0).toLocaleString();
                }
                if (document.getElementById("exportStatQuestions")) {
                    document.getElementById("exportStatQuestions").textContent = info.questions_count || 0;
                }
                if (document.getElementById("exportStatOutputs")) {
                    const totalOut = (info.notes_count || 0) + (info.flashcards_count || 0) + (info.tests_count || 0);
                    document.getElementById("exportStatOutputs").textContent = totalOut;
                }

                const chkAudio = document.getElementById("chkExportAudio");
                const hintAudio = document.getElementById("exportAudioSizeHint");
                if (chkAudio && hintAudio) {
                    if (info.audio_count > 0) {
                        const aMb = ((info.audio_bytes || 0) / (1024 * 1024)).toFixed(1);
                        hintAudio.textContent = `(${info.audio_count} souborů, ${aMb} MB)`;
                        chkAudio.disabled = false;
                        chkAudio.checked = false; // standardně vypnuto, aby byl export bleskově malý
                    } else {
                        hintAudio.textContent = "(Žádné audiosoubory)";
                        chkAudio.checked = false;
                        chkAudio.disabled = true;
                    }
                }

                if (loadingState) loadingState.classList.add("hidden");
                if (contentState) contentState.classList.remove("hidden");
            } catch (e) {
                if (loadingState) {
                    loadingState.innerHTML = `<div class="text-rose-400">Chyba při přípravě exportu: ${escapeHtml(e.message)}</div>`;
                }
            }
        }

        function closeProjectExportModal() {
            const modal = document.getElementById("modalProjectExport");
            if (modal) modal.classList.add("hidden");
        }

        async function executeProjectExport() {
            const target = currentExportTargetProject;
            if (!target) return;

            const chkAudio = document.getElementById("chkExportAudio");
            const chkChat = document.getElementById("chkExportChat");
            const chkOutputs = document.getElementById("chkExportOutputs");
            const chkProgress = document.getElementById("chkExportProgress");

            const includeAudio = chkAudio ? chkAudio.checked : false;
            const includeChat = chkChat ? chkChat.checked : true;
            const includeOutputs = chkOutputs ? chkOutputs.checked : true;
            const includeProgress = chkProgress ? chkProgress.checked : true;

            const btn = document.getElementById("btnExecuteProjectExport");
            const btnIcon = document.getElementById("btnExecuteExportIcon");
            const btnText = document.getElementById("btnExecuteExportText");

            if (btn) btn.disabled = true;
            if (btnIcon) btnIcon.textContent = "⏳";
            if (btnText) btnText.textContent = "Generuji a balím .medproj...";

            try {
                const params = new URLSearchParams({
                    include_audio: includeAudio ? "true" : "false",
                    include_chat: includeChat ? "true" : "false",
                    include_outputs: includeOutputs ? "true" : "false",
                    include_progress: includeProgress ? "true" : "false"
                });

                const downloadUrl = `/api/projects/${encodeURIComponent(target)}/export?${params.toString()}`;
                
                const a = document.createElement("a");
                a.href = downloadUrl;
                a.download = `${target}.medproj`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);

                if (btnIcon) btnIcon.textContent = "✅";
                if (btnText) btnText.textContent = "Export zahájen!";

                setTimeout(() => {
                    closeProjectExportModal();
                }, 1200);
            } catch (e) {
                alert(`Chyba při exportu: ${e.message}`);
                if (btn) btn.disabled = false;
                if (btnIcon) btnIcon.textContent = "📦";
                if (btnText) btnText.textContent = "Stáhnout balíček projektu (.medproj)";
            }
        }

        function openProjectImportModal() {
            const modal = document.getElementById("modalProjectImport");
            if (!modal) return;
            modal.classList.remove("hidden");
            resetImportModalStep();
        }

        function closeProjectImportModal() {
            const modal = document.getElementById("modalProjectImport");
            if (modal) modal.classList.add("hidden");
            currentImportFile = null;
            currentImportInspectData = null;
        }

        function resetImportModalStep() {
            const step1 = document.getElementById("importStep1");
            const step2 = document.getElementById("importStep2");
            const loading = document.getElementById("importLoadingState");
            const progress = document.getElementById("importProgressState");
            const success = document.getElementById("importSuccessState");
            const btnBack = document.getElementById("btnImportBack");
            const btnExec = document.getElementById("btnExecuteProjectImport");
            const fileInput = document.getElementById("importFileInput");

            if (fileInput) fileInput.value = "";
            if (step1) step1.classList.remove("hidden");
            if (step2) step2.classList.add("hidden");
            if (loading) loading.classList.add("hidden");
            if (progress) progress.classList.add("hidden");
            if (success) success.classList.add("hidden");
            if (btnBack) btnBack.classList.add("hidden");
            if (btnExec) btnExec.classList.add("hidden");
            currentImportFile = null;
            currentImportInspectData = null;
        }

        function handleProjectImportDrop(e) {
            const dt = e.dataTransfer;
            if (dt && dt.files && dt.files.length > 0) {
                handleProjectImportFile(dt.files[0]);
            }
        }

        function handleProjectImportFileSelect(e) {
            if (e.target && e.target.files && e.target.files.length > 0) {
                handleProjectImportFile(e.target.files[0]);
            }
        }

        async function handleProjectImportFile(file) {
            if (!file) return;
            const fname = file.name.toLowerCase();
            if (!fname.endsWith(".medproj") && !fname.endsWith(".zip")) {
                alert(t("project.import.extError", "Vybraný soubor musí mít příponu .medproj nebo .zip."));
                return;
            }

            currentImportFile = file;
            const step1 = document.getElementById("importStep1");
            const step2 = document.getElementById("importStep2");
            const loading = document.getElementById("importLoadingState");
            const loadText = document.getElementById("importLoadingText");
            const btnBack = document.getElementById("btnImportBack");
            const btnExec = document.getElementById("btnExecuteProjectImport");

            if (step1) step1.classList.add("hidden");
            if (step2) step2.classList.add("hidden");
            if (loading) loading.classList.remove("hidden");
            if (loadText) loadText.textContent = `Analyzuji balíček ${file.name}...`;

            try {
                const formData = new FormData();
                formData.append("file", sanitizeFile(file));

                const res = await fetch("/api/projects/import/inspect", {
                    method: "POST",
                    body: formData
                });

                if (!res.ok) {
                    const err = await res.json().catch(() => ({}));
                    throw new Error(err.detail || "Chyba při analýze balíčku projektu.");
                }

                const data = await res.json();
                currentImportInspectData = data;

                // Vyplnění dat v Kroku 2
                if (document.getElementById("importInspectFiles")) {
                    document.getElementById("importInspectFiles").textContent = data.source_files_count || 0;
                }
                if (document.getElementById("importInspectChunks")) {
                    document.getElementById("importInspectChunks").textContent = (data.chunks_count || 0).toLocaleString();
                }
                if (document.getElementById("importInspectQuestions")) {
                    document.getElementById("importInspectQuestions").textContent = data.questions_count || 0;
                }
                if (document.getElementById("importInspectOutputs")) {
                    const totalOut = (data.notes_count || 0) + (data.flashcards_count || 0) + (data.tests_count || 0);
                    document.getElementById("importInspectOutputs").textContent = totalOut;
                }

                if (document.getElementById("importInspectionDate")) {
                    if (data.exported_at) {
                        try {
                            const d = new Date(data.exported_at);
                            document.getElementById("importInspectionDate").textContent = `Exportováno: ${d.toLocaleString('cs-CZ')}`;
                        } catch {
                            document.getElementById("importInspectionDate").textContent = "";
                        }
                    } else {
                        document.getElementById("importInspectionDate").textContent = "";
                    }
                }

                // Seznam souborů
                const listEl = document.getElementById("importInspectFilesList");
                if (listEl) {
                    const sfiles = data.source_files || [];
                    if (sfiles.length === 0) {
                        listEl.innerHTML = `<span class="text-slate-500 italic">Žádné samostatné soubory v uploads</span>`;
                    } else {
                        listEl.innerHTML = sfiles.map(sf => `<div class="truncate">📄 ${escapeHtml(sf)}</div>`).join("");
                    }
                }

                // Cílový název a řešení konfliktů
                const nameInput = document.getElementById("importTargetProjectName");
                const conflictBox = document.getElementById("importConflictWarning");
                const conflictMsg = document.getElementById("importConflictMessage");

                if (data.exists) {
                    if (conflictBox) conflictBox.classList.remove("hidden");
                    if (conflictMsg) conflictMsg.textContent = `Projekt s názvem '${data.project_name}' již na tomto počítači existuje!`;
                    if (nameInput) nameInput.value = data.suggested_name || `${data.project_name}_import`;
                    
                    const radios = document.getElementsByName("importConflictMode");
                    for (const r of radios) {
                        if (r.value === "rename") r.checked = true;
                    }
                } else {
                    if (conflictBox) conflictBox.classList.add("hidden");
                    if (nameInput) nameInput.value = data.project_name || "Novy_projekt";
                }

                if (loading) loading.classList.add("hidden");
                if (step2) step2.classList.remove("hidden");
                if (btnBack) btnBack.classList.remove("hidden");
                if (btnExec) btnExec.classList.remove("hidden");

            } catch (e) {
                alert(`Chyba při čtení balíčku projektu: ${e.message}`);
                resetImportModalStep();
            }
        }

        function onImportConflictModeChange() {
            if (!currentImportInspectData) return;
            const radios = document.getElementsByName("importConflictMode");
            let mode = "rename";
            for (const r of radios) {
                if (r.checked) mode = r.value;
            }

            const nameInput = document.getElementById("importTargetProjectName");
            if (nameInput) {
                if (mode === "overwrite") {
                    nameInput.value = currentImportInspectData.project_name;
                } else {
                    nameInput.value = currentImportInspectData.suggested_name || `${currentImportInspectData.project_name}_import`;
                }
            }
        }

        async function executeProjectImport() {
            if (!currentImportFile) {
                alert(t("project.import.noFile", "Není vybrán žádný soubor k importu."));
                return;
            }

            const nameInput = document.getElementById("importTargetProjectName");
            const targetName = (nameInput ? nameInput.value : "").trim();
            if (!targetName) {
                alert(t("project.import.invalidTargetName", "Zadejte prosím platný název pro cílový projekt."));
                return;
            }

            let overwrite = false;
            if (currentImportInspectData && currentImportInspectData.exists) {
                const radios = document.getElementsByName("importConflictMode");
                for (const r of radios) {
                    if (r.checked && r.value === "overwrite") overwrite = true;
                }
            }

            const chkOutputs = document.getElementById("chkImportOutputs");
            const chkChat = document.getElementById("chkImportChat");
            const chkAudio = document.getElementById("chkImportAudio");

            const step2 = document.getElementById("importStep2");
            const progress = document.getElementById("importProgressState");
            const success = document.getElementById("importSuccessState");
            const btnBack = document.getElementById("btnImportBack");
            const btnExec = document.getElementById("btnExecuteProjectImport");

            if (step2) step2.classList.add("hidden");
            if (btnBack) btnBack.classList.add("hidden");
            if (btnExec) btnExec.classList.add("hidden");
            if (progress) progress.classList.remove("hidden");

            try {
                const formData = new FormData();
                formData.append("file", sanitizeFile(currentImportFile));
                formData.append("project_name", targetName);
                formData.append("overwrite", overwrite ? "true" : "false");
                formData.append("include_outputs", (chkOutputs && chkOutputs.checked) ? "true" : "false");
                formData.append("include_chat", (chkChat && chkChat.checked) ? "true" : "false");
                formData.append("include_audio", (chkAudio && chkAudio.checked) ? "true" : "false");

                const res = await fetch("/api/projects/import", {
                    method: "POST",
                    body: formData
                });

                if (!res.ok) {
                    const err = await res.json().catch(() => ({}));
                    throw new Error(err.detail || "Chyba při importu projektu.");
                }

                const result = await res.json();
                const importedProject = result.project || targetName;

                if (progress) progress.classList.add("hidden");
                if (success) {
                    success.classList.remove("hidden");
                    const title = document.getElementById("importSuccessTitle");
                    const msg = document.getElementById("importSuccessMessage");
                    if (title) title.textContent = `Projekt '${importedProject}' byl úspěšně importován!`;
                    if (msg) msg.textContent = `Nahráno ${result.source_files_count || 0} podkladů a ${result.chunks_count || 0} předpočítaných vektorů ChromaDB.`;
                }

                // Automaticky načteme seznam projektů a aktivujeme importovaný projekt
                await loadProjects();
                const select = document.getElementById("projectSelect");
                if (select) {
                    select.value = importedProject;
                }
                localStorage.setItem("aiPodcastActiveProject", importedProject);
                await onProjectChange();

                const pmModal = document.getElementById("modalProjectManager");
                if (pmModal && !pmModal.classList.contains("hidden")) {
                    openProjectManagerModal();
                }

                setTimeout(() => {
                    closeProjectImportModal();
                }, 1500);

            } catch (e) {
                alert(`Chyba při importu: ${e.message}`);
                if (progress) progress.classList.add("hidden");
                if (step2) step2.classList.remove("hidden");
                if (btnBack) btnBack.classList.remove("hidden");
                if (btnExec) btnExec.classList.remove("hidden");
            }
        }

        // =========================================================================
        // LOGIKA PRO ZÁLOŽKU: 📅 PLÁNOVAČ ZKOUŠKY (EXAM PLANNER & METRICS)
        // =========================================================================

        function getLocalDateString(date = new Date()) {
            const y = date.getFullYear();
            const m = String(date.getMonth() + 1).padStart(2, '0');
            const d = String(date.getDate()).padStart(2, '0');
            return `${y}-${m}-${d}`;
        }

        function parseDateOnly(str) {
            if (!str) return null;
            const parts = String(str).trim().split('-');
            if (parts.length !== 3) return null;
            return new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
        }

        function daysBetween(targetDateStr, baseDateStr) {
            const target = parseDateOnly(targetDateStr);
            const base = parseDateOnly(baseDateStr);
            if (!target || !base) return 0;
            const msDiff = target.getTime() - base.getTime();
            return Math.round(msDiff / (1000 * 60 * 60 * 24));
        }

        function escapeHtml(str) {
            if (!str) return "";
            return String(str)
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/"/g, "&quot;")
                .replace(/'/g, "&#039;");
        }

        function escapeQuotes(str) {
            if (!str) return "";
            return String(str).replace(/'/g, "\\'").replace(/"/g, "&quot;").replace(/\n/g, " ");
        }

        function calculatePlannerMetrics() {
            const todayStr = getLocalDateString();
            const examDate = examPlanner.examDate || "";
            const startDate = examPlanner.startDate || "";
            const revisionDays = parseInt(examPlanner.revisionDays) || 0;
            const qList = examPlanner.questions || [];

            // 1. Dny na učení (studyDaysRemaining)
            // - Pokud je startDate >= today, celkový interval: daysBetween(examDate, startDate).
            // - Pokud učení již běží (startDate < today): zbývající dny daysBetween(examDate, today). Pokud je po zkoušce, vrátí 0.
            let studyDaysRemaining = 0;
            if (examDate) {
                if (startDate && startDate >= todayStr) {
                    studyDaysRemaining = Math.max(0, daysBetween(examDate, startDate));
                } else {
                    studyDaysRemaining = Math.max(0, daysBetween(examDate, todayStr));
                }
            }

            // 2. Čisté dny na učení: netStudyDays = max(0, studyDaysRemaining - revisionDays)
            const netStudyDays = Math.max(0, studyDaysRemaining - revisionDays);

            // 3. Celkový počet otázek: totalQuestions = počet všech otázek v seznamu
            const totalQuestions = qList.length;

            // 4. Zodpovězené otázky: completedQuestions = počet otázek s vyplněným completedDate
            const completedQuestions = qList.filter(q => q.completedDate).length;

            // 5. Otázky splněné dnes: completedToday = počet otázek, kde completedDate == today
            const completedToday = qList.filter(q => q.completedDate === todayStr).length;

            // 6. Doporučený denní cíl (questionsPerDay):
            // - Zbývající otázky k dnešnímu ránu: remaining = totalQuestions - (completedQuestions - completedToday).
            // - Pokud studyDaysRemaining == 0 -> vrátí zbývající otázky.
            // - Pokud jsou všechny hotové -> 0.
            // - Jinak: roundUp(remaining / netStudyDays).
            const remaining = totalQuestions - (completedQuestions - completedToday);
            let questionsPerDay = 0;
            if (totalQuestions > 0 && completedQuestions === totalQuestions) {
                questionsPerDay = 0;
            } else if (studyDaysRemaining === 0 || netStudyDays === 0) {
                questionsPerDay = Math.max(0, remaining);
            } else {
                questionsPerDay = Math.ceil(Math.max(0, remaining) / netStudyDays);
            }

            // 7. Celkový progres: (completedQuestions / totalQuestions) * 100
            const progressPct = totalQuestions > 0 ? Math.round((completedQuestions / totalQuestions) * 100) : 0;

            // 8. Distribuce známek
            let countA = 0, countB = 0, countC = 0, countD = 0, countNone = 0;
            qList.forEach(q => {
                if (q.grade === "A") countA++;
                else if (q.grade === "B") countB++;
                else if (q.grade === "C") countC++;
                else if (q.grade === "D") countD++;
                else countNone++;
            });

            return {
                todayStr,
                studyDaysRemaining,
                netStudyDays,
                totalQuestions,
                completedQuestions,
                completedToday,
                remaining,
                questionsPerDay,
                progressPct,
                countA,
                countB,
                countC,
                countD,
                countNone,
                ratedCount: countA + countB + countC + countD
            };
        }

        function parseQuestionString(rawString, fallbackIndex = 1) {
            let line = String(rawString || '').trim().replace(/^["']|["']$/g, '');
            if (!line) return null;

            // Zkusíme formát se středníky: Téma;Číslo;Znění
            if (line.includes(";")) {
                const parts = line.split(";").map(s => s.trim());
                if (parts.length >= 3) {
                    return {
                        id: `pq_${Date.now()}_${fallbackIndex}_${Math.random().toString(36).substr(2, 4)}`,
                        topic: parts[0] || "Všeobecné",
                        number: parts[1] || String(fallbackIndex),
                        title: parts.slice(2).join("; "),
                        completedDate: null,
                        grade: null,
                        note: ""
                    };
                } else if (parts.length === 2) {
                    return {
                        id: `pq_${Date.now()}_${fallbackIndex}_${Math.random().toString(36).substr(2, 4)}`,
                        topic: parts[0] || "Všeobecné",
                        number: String(fallbackIndex),
                        title: parts[1],
                        completedDate: null,
                        grade: null,
                        note: ""
                    };
                }
            }

            // Zkusíme formát: "Lístek X: a) Otázka 1, b) Otázka 2" nebo "Kardio - 1. Otázka"
            let topic = "Všeobecné";
            let number = String(fallbackIndex);
            let title = line;

            const listekMatch = line.match(/^Lístek\s*(\d+)[:\s]*(.*)$/i);
            if (listekMatch) {
                const ticketNum = listekMatch[1];
                topic = `Lístek ${ticketNum}`;
                title = listekMatch[2];
                number = ticketNum;
            } else {
                const prefixMatch = line.match(/^([A-Za-zěščřžýáíéóúůďťňĚŠČŘŽÝÁÍÉÓÚŮĎŤŇ\s]+)\s*[-–]\s*(\d+)[\.\s]+(.*)$/);
                if (prefixMatch) {
                    topic = prefixMatch[1].trim();
                    number = prefixMatch[2].trim();
                    title = prefixMatch[3].trim();
                } else {
                    const numMatch = line.match(/^(\d+)[\.\)]\s*(.*)$/);
                    if (numMatch) {
                        number = numMatch[1];
                        title = numMatch[2].trim();
                    }
                }
            }

            // Heuristické přiřazení lékařského oboru / kategorie
            const lower = (title + " " + line).toLowerCase();
            let detectedTopic = null;
            if (lower.includes("hypertenz") || lower.includes("srdeč") || lower.includes("infarkt") || lower.includes("koronár") || lower.includes("kardiomyop") || lower.includes("chlopeň") || lower.includes("arytm") || lower.includes("aort") || lower.includes("endokard") || lower.includes("kardio")) {
                detectedTopic = "Kardiologie";
            } else if (lower.includes("astma") || lower.includes("chopn") || lower.includes("pneumon") || lower.includes("plic") || lower.includes("tuberkul") || lower.includes("dušnost") || lower.includes("karcinom plic") || lower.includes("respirač")) {
                detectedTopic = "Pneumologie";
            } else if (lower.includes("leukem") || lower.includes("anemie") || lower.includes("lymfom") || lower.includes("trombof") || lower.includes("trombocyto") || lower.includes("krváciv") || lower.includes("myelom") || lower.includes("hemato") || lower.includes("koagul")) {
                detectedTopic = "Hematologie";
            } else if (lower.includes("ledvin") || lower.includes("glomerul") || lower.includes("nefrit") || lower.includes("renáln") || lower.includes("dialýz") || lower.includes("nefro")) {
                detectedTopic = "Nefrologie";
            } else if (lower.includes("žalud") || lower.includes("jater") || lower.includes("střev") || lower.includes("slinivk") || lower.includes("hepatit") || lower.includes("cirhóz") || lower.includes("git") || lower.includes("kolorekt") || lower.includes("gastro") || lower.includes("pankreat")) {
                detectedTopic = "Gastroenterologie";
            } else if (lower.includes("diabet") || lower.includes("štítn") || lower.includes("hypofýz") || lower.includes("nadledvin") || lower.includes("obezit") || lower.includes("dyslipid") || lower.includes("endokrin")) {
                detectedTopic = "Endokrinologie";
            } else if (lower.includes("artritid") || lower.includes("lupus") || lower.includes("dna") || lower.includes("vaskulit") || lower.includes("spondyl") || lower.includes("osteoporóz") || lower.includes("revmat")) {
                detectedTopic = "Revmatologie";
            } else if (lower.includes("infekc") || lower.includes("seps") || lower.includes("antibiot") || lower.includes("meningit") || lower.includes("hiv") || lower.includes("virov") || lower.includes("bakteri")) {
                detectedTopic = "Infektologie";
            } else if (lower.includes("neurol") || lower.includes("cévní mozkov") || lower.includes("cmp") || lower.includes("epileps") || lower.includes("roztroušen") || lower.includes("parkinson") || lower.includes("cefalea")) {
                detectedTopic = "Neurologie";
            }

            if (topic === "Všeobecné" || topic.startsWith("Lístek") || !topic) {
                topic = detectedTopic || (topic.startsWith("Lístek") ? "Všeobecné" : (topic || "Všeobecné"));
            }

            return {
                id: `pq_${Date.now()}_${fallbackIndex}_${Math.random().toString(36).substr(2, 4)}`,
                topic,
                number,
                title,
                completedDate: null,
                grade: null,
                note: ""
            };
        }

        function normalizeQuestion(item, fallbackIndex = 1) {
            if (!item) return null;

            let base = {};
            if (typeof item === "string") {
                const parsed = parseQuestionString(item, fallbackIndex);
                base = parsed || {
                    id: `pq_${Date.now()}_${fallbackIndex}_${Math.random().toString(36).substr(2, 4)}`,
                    topic: "Všeobecné",
                    number: String(fallbackIndex),
                    title: item.trim(),
                    completedDate: null,
                    grade: null,
                    note: ""
                };
            } else if (typeof item === "object") {
                const title = String(item.title || "").trim();
                if (!title) return null;

                let parsed = null;
                if (!item.topic || item.topic === "Všeobecné" || item.topic.startsWith("Lístek") || !item.number) {
                    parsed = parseQuestionString(title, fallbackIndex);
                }

                base = {
                    id: item.id || (parsed ? parsed.id : `pq_${Date.now()}_${fallbackIndex}_${Math.random().toString(36).substr(2, 4)}`),
                    topic: (item.topic && item.topic !== "Všeobecné" && !item.topic.startsWith("Lístek")) ? item.topic : (parsed ? parsed.topic : (item.topic || "Všeobecné")),
                    number: item.number ? String(item.number) : (parsed ? parsed.number : String(fallbackIndex)),
                    title: title,
                    completedDate: item.completedDate || null,
                    grade: item.grade || null,
                    note: item.note || "",
                    status: item.status || "Ready",
                    selected: Boolean(item.selected),
                    q_index: item.q_index || fallbackIndex,
                    notesSelected: item.notesSelected !== undefined ? Boolean(item.notesSelected) : true,
                    notesStatus: item.notesStatus || null,
                    cardsSelected: item.cardsSelected !== undefined ? Boolean(item.cardsSelected) : true,
                    cardsStatus: item.cardsStatus || null
                };
            }

            if (!base.id) base.id = `pq_${Date.now()}_${fallbackIndex}_${Math.random().toString(36).substr(2, 4)}`;
            if (!base.status) base.status = "Ready";
            if (base.selected === undefined) base.selected = false;
            base.q_index = fallbackIndex;
            if (base.notesSelected === undefined) base.notesSelected = true;
            if (base.cardsSelected === undefined) base.cardsSelected = true;

            return base;
        }

        // Automatická sanitace: Zákaz kategorií s jedinou otázkou a lístků
        function sanitizeProjectCategories(targetQuestions = questions) {
            if (!targetQuestions || targetQuestions.length === 0) return false;

            const counts = {};
            targetQuestions.forEach(q => {
                const cat = (q.topic || "Všeobecné").trim();
                counts[cat] = (counts[cat] || 0) + 1;
            });

            let modified = false;
            targetQuestions.forEach(q => {
                let cat = (q.topic || "Všeobecné").trim();
                if (cat.startsWith("Lístek") || counts[cat] === 1) {
                    const parsed = parseQuestionString(q.title);
                    if (parsed && parsed.topic && parsed.topic !== "Všeobecné" && !parsed.topic.startsWith("Lístek")) {
                        q.topic = parsed.topic;
                    } else {
                        q.topic = "Všeobecné";
                    }
                    modified = true;
                }
            });

            const secondCounts = {};
            targetQuestions.forEach(q => {
                const cat = (q.topic || "Všeobecné").trim();
                secondCounts[cat] = (secondCounts[cat] || 0) + 1;
            });

            targetQuestions.forEach(q => {
                const cat = (q.topic || "Všeobecné").trim();
                if (cat !== "Všeobecné" && secondCounts[cat] === 1) {
                    q.topic = "Všeobecné";
                    modified = true;
                }
            });

            return modified;
        }

        function reclusterProjectCategories() {
            if (isViewerMode()) {
                showGlobalToast(t("toast.viewerRestrictedQuestion", "Režim pozorovatele: Nemáte oprávnění měnit zkouškové otázky."), "warning");
                return;
            }
            if (!questions || questions.length === 0) {
                alert(t("planner.noQuestionsToGroup", "V projektu nejsou žádné otázky k seskupení."));
                return;
            }
            sanitizeProjectCategories(questions);
            saveProjectQuestions(false);
            renderQuestionsManagerTable();
            syncQuestionsDropdowns();
            if (typeof loadMedulingo === 'function') loadMedulingo(false);
            alert(t("planner.reorganizedSuccess", "Kategorie byly úspěšně zreorganizovány: jedno-otázkové kategorie a lístky byly sjednoceny do odborných celků."));
        }

        async function aiReclassifyQuestions() {
            if (isViewerMode()) {
                showGlobalToast(t("toast.viewerRestrictedQuestion", "Režim pozorovatele: Nemáte oprávnění měnit zkouškové otázky."), "warning");
                return;
            }
            if (!currentProject) {
                alert(t("common.selectProject", "Nejprve vyberte projekt v horní liště."));
                return;
            }
            if (!questions || questions.length === 0) {
                alert(t("planner.noQuestionsToClassify", "V projektu nejsou žádné otázky k roztřídění."));
                return;
            }

            const conf = confirm(
                `Chcete spustit inteligentní roztřídění všech ${questions.length} otázek do lékařských oborů pomocí AI?\n\n` +
                `• Akce probíhá VÝHRADNĚ NA VYŽÁDÁNÍ (šetří tokeny).\n` +
                `• Všechny otázky se pošlou v jediném rychlém a úsporném požadavku.\n` +
                `• Otázky budou didakticky zařazeny do zavedených oborů (Kardiologie, Pneumologie, Gastroenterologie, Hematologie, Nefrologie atd.).`
            );
            if (!conf) return;

            const btnAi = document.getElementById("btnAiClassifyQuestions");
            const btnAiTxt = document.getElementById("aiClassifyBtnText");
            const originalHtml = btnAi ? btnAi.innerHTML : "";
            if (btnAi) {
                btnAi.disabled = true;
                if (btnAiTxt) btnAiTxt.textContent = "AI analyzuje a třídí...";
            }

            appendConsoleLog(`🤖 Spouštím AI překategorizování ${questions.length} otázek pro projekt '${currentProject}'...`);

            try {
                const res = await fetch(`/api/projects/${encodeURIComponent(currentProject)}/ai-classify-questions`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        gemini_model: "gemini-3.6-flash"
                    })
                });

                const data = await res.json();
                if (!res.ok) {
                    throw new Error(data.detail || "Chyba při komunikaci s AI.");
                }

                if (Array.isArray(data.questions) && data.questions.length > 0) {
                    questions = data.questions.map((q, i) => normalizeQuestion(q, i + 1)).filter(Boolean);
                    examPlanner.questions = questions;
                    await saveProjectQuestions(false);

                    appendConsoleLog(`✅ AI úspěšně překategorizovala ${data.updated_count || questions.length} otázek do ${data.categories?.length || 0} oborů.`);
                    alert(`✅ AI úspěšně roztřídila ${data.updated_count || questions.length} otázek do ${data.categories?.length || 0} lékařských oborů:\n\n${(data.categories || []).join(', ')}`);
                }
            } catch (err) {
                console.error("Chyba při AI klasifikaci:", err);
                appendConsoleLog(`❌ Chyba při AI klasifikaci: ${err.message}`);
                alert(`Chyba při AI klasifikaci otázek: ${err.message}`);
            } finally {
                if (btnAi) {
                    btnAi.disabled = false;
                    btnAi.innerHTML = originalHtml;
                }
            }
        }

        async function loadProjectQuestionsAndPlanner() {
            // Vždy okamžitě vyčistíme stav v paměti pro nový projekt, aby se nepřenesla žádná data z předchozího projektu
            questions = [];
            selectedQuestionIndex = null;
            plannerCalendarSelectedDay = null;
            examPlanner = {
                examDate: "",
                startDate: "",
                revisionDays: 14,
                scheduleMode: "sequential",
                questions: []
            };

            if (!currentProject) {
                renderQuestionsTable();
                renderExamPlanner();
                syncQuestionsDropdowns();
                updateDashboardStats();
                renderQuestionsManagerTable();
                return;
            }

            // 1. Zkusíme rychlé načtení z localStorage specifické pro TENTO projekt
            let localQuestions = [];
            const localPlannerRaw = localStorage.getItem(`aiPodcastExamPlanner_${currentProject}`);
            const localStudioQRaw = localStorage.getItem(`aiPodcastQ_${currentProject}`);

            if (localPlannerRaw) {
                try {
                    const parsedPlanner = JSON.parse(localPlannerRaw);
                    examPlanner.examDate = parsedPlanner.examDate || "";
                    examPlanner.startDate = parsedPlanner.startDate || "";
                    examPlanner.revisionDays = parsedPlanner.revisionDays !== undefined ? parsedPlanner.revisionDays : 14;
                    examPlanner.scheduleMode = parsedPlanner.scheduleMode || "sequential";
                    if (Array.isArray(parsedPlanner.questions) && parsedPlanner.questions.length > 0) {
                        localQuestions = parsedPlanner.questions;
                    }
                } catch (e) {
                    console.error("Chyba parsování lokálního plánovače:", e);
                }
            }

            if (localQuestions.length === 0 && localStudioQRaw) {
                try {
                    const parsedStudio = JSON.parse(localStudioQRaw);
                    if (Array.isArray(parsedStudio) && parsedStudio.length > 0) {
                        localQuestions = parsedStudio;
                    }
                } catch (e) {
                    console.error("Chyba parsování lokálních otázek:", e);
                }
            }

            if (localQuestions.length > 0) {
                questions = localQuestions.map((q, idx) => normalizeQuestion(q, idx + 1)).filter(Boolean);
                examPlanner.questions = questions;
            }

            // Prvotní vykreslení
            renderQuestionsTable();
            renderExamPlanner();
            syncQuestionsDropdowns();
            updateDashboardStats();
            renderQuestionsManagerTable();

            // 2. Načteme autoritativní data ze serveru pro aktuální projekt
            try {
                const res = await fetch(`/api/projects/${encodeURIComponent(currentProject)}/planner`);
                if (res.ok) {
                    const data = await res.json();
                    if (data.planner) {
                        examPlanner.examDate = data.planner.examDate || "";
                        examPlanner.startDate = data.planner.startDate || "";
                        examPlanner.revisionDays = data.planner.revisionDays !== undefined ? data.planner.revisionDays : 14;
                        examPlanner.scheduleMode = data.planner.scheduleMode || "sequential";

                        // Server je autoritou pro otázky daného projektu (i když je prázdný [])
                        if (Array.isArray(data.planner.questions)) {
                            questions = data.planner.questions.map((q, idx) => normalizeQuestion(q, idx + 1)).filter(Boolean);
                            examPlanner.questions = questions;
                        }
                    }
                }
            } catch (e) {
                console.warn("Nepodařilo se načíst data plánovače ze serveru, použito lokální úložiště:", e);
            }

            // Uložíme aktuální autoritativní stav do localStorage a překreslíme
            examPlanner.questions = questions;
            localStorage.setItem(`aiPodcastQ_${currentProject}`, JSON.stringify(questions));
            localStorage.setItem(`aiPodcastExamPlanner_${currentProject}`, JSON.stringify(examPlanner));

            renderQuestionsTable();
            renderExamPlanner();
            syncQuestionsDropdowns();
            updateDashboardStats();
            renderQuestionsManagerTable();
        }

        async function saveProjectQuestions(showToast = false) {
            if (!currentProject) return;
            if (isViewerMode()) {
                console.warn("Režim pozorovatele: Ukládání otázek je zablokováno.");
                if (showToast) {
                    showGlobalToast(t("toast.viewerRestrictedQuestion", "Režim pozorovatele: Nemáte oprávnění měnit zkouškové otázky."), "warning");
                }
                return;
            }

            // Ujistíme se o správném číslování a zachováme veškeré manuálně nastavené kategorie
            questions.forEach((q, idx) => {
                q.q_index = idx + 1;
                if (!q.number) q.number = String(idx + 1);
                if (!q.topic) q.topic = "Všeobecné";
            });
            examPlanner.questions = questions;

            // Uložíme do localStorage pro okamžitou odezvu
            localStorage.setItem(`aiPodcastQ_${currentProject}`, JSON.stringify(questions));
            localStorage.setItem(`aiPodcastExamPlanner_${currentProject}`, JSON.stringify(examPlanner));

            // Synchronní překreslení všech zobrazení otázek v UI
            renderQuestionsTable();
            renderPlannerMetrics();
            if (typeof renderPlannerCalendarStrip === "function") {
                renderPlannerCalendarStrip();
            }
            renderPlannerTable();
            syncQuestionsDropdowns();
            updateDashboardStats();
            renderQuestionsManagerTable();

            // Uložíme autoritativně na server
            try {
                const res = await fetch(`/api/projects/${encodeURIComponent(currentProject)}/planner`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ planner: examPlanner })
                });

                // Teprve po úspěšném uložení na server zaktualizujeme Medulingo, aby načetlo čerstvá data z disku
                if (res.ok && typeof loadMedulingo === 'function') {
                    await loadMedulingo(false);
                }

                if (showToast) {
                    appendConsoleLog(`💾 Seznam ${questions.length} otázek a plánovač pro projekt '${currentProject}' úspěšně uložen na server.`);
                    alert(`Otázky a nastavení pro projekt '${currentProject}' byly úspěšně uloženy.`);
                }
            } catch (e) {
                console.error("Chyba ukládání otázek na server:", e);
                if (showToast) {
                    alert("Otázky uloženy lokálně v prohlížeči (chyba serveru: " + e.message + ")");
                }
            }
        }

        function saveQuestionsToStorage() {
            saveProjectQuestions(false);
        }

        async function saveExamPlanner(showToast = false) {
            await saveProjectQuestions(showToast);
        }

        function loadQuestionsFromStorage() {
            loadProjectQuestionsAndPlanner();
        }

        function loadExamPlanner() {
            loadProjectQuestionsAndPlanner();
        }

        function onPlannerConfigChange() {
            if (isViewerMode()) return;
            const examInput = document.getElementById("plannerExamDate");
            const startInput = document.getElementById("plannerStartDate");
            const revInput = document.getElementById("plannerRevisionDays");

            if (examInput) examPlanner.examDate = examInput.value;
            if (startInput) examPlanner.startDate = startInput.value;
            if (revInput) examPlanner.revisionDays = parseInt(revInput.value) || 0;

            saveProjectQuestions(false);
        }

        function savePlannerConfig(explicitClick = true) {
            if (isViewerMode()) {
                showGlobalToast(t("toast.viewerRestrictedQuestion", "Režim pozorovatele: Nemáte oprávnění měnit nastavení plánovače."), "warning");
                return;
            }
            onPlannerConfigChange();
            if (explicitClick) {
                saveProjectQuestions(true);
            }
        }

        function renderExamPlanner() {
            const projectLabel = document.getElementById("plannerCurrentProjectLabel");
            if (projectLabel) projectLabel.textContent = currentProject || "-- (Není vybrán)";

            const examInput = document.getElementById("plannerExamDate");
            const startInput = document.getElementById("plannerStartDate");
            const revInput = document.getElementById("plannerRevisionDays");
            const btnSave = document.getElementById("btnSavePlannerConfig");
            const viewer = isViewerMode();

            if (examInput) {
                examInput.value = examPlanner.examDate || "";
                examInput.disabled = viewer;
                if (viewer) examInput.classList.add("opacity-60", "cursor-not-allowed");
                else examInput.classList.remove("opacity-60", "cursor-not-allowed");
            }
            if (startInput) {
                startInput.value = examPlanner.startDate || "";
                startInput.disabled = viewer;
                if (viewer) startInput.classList.add("opacity-60", "cursor-not-allowed");
                else startInput.classList.remove("opacity-60", "cursor-not-allowed");
            }
            if (revInput) {
                revInput.value = examPlanner.revisionDays !== undefined ? examPlanner.revisionDays : 14;
                revInput.disabled = viewer;
                if (viewer) revInput.classList.add("opacity-60", "cursor-not-allowed");
                else revInput.classList.remove("opacity-60", "cursor-not-allowed");
            }
            if (btnSave) {
                btnSave.disabled = viewer;
                if (viewer) {
                    btnSave.classList.add("opacity-50", "cursor-not-allowed");
                    btnSave.title = "Režim pozorovatele: Pouze ke čtení";
                } else {
                    btnSave.classList.remove("opacity-50", "cursor-not-allowed");
                    btnSave.title = "";
                }
            }

            updatePlannerCalendarModeButtons(examPlanner.scheduleMode || "sequential");
            renderPlannerMetrics();
            renderPlannerCalendarStrip();
            renderPlannerTable();
        }

        function renderPlannerMetrics() {
            const m = calculatePlannerMetrics();

            // Metriky v horní liště
            const elStudyDays = document.getElementById("plannerStatStudyDays");
            if (elStudyDays) elStudyDays.textContent = m.studyDaysRemaining;

            const elStudyDaysLabel = document.getElementById("plannerStatStudyDaysLabel");
            if (elStudyDaysLabel) {
                if (!examPlanner.examDate) {
                    elStudyDaysLabel.textContent = t("planner.setExamDateNotice", "Nastavte termín zkoušky");
                } else if (m.studyDaysRemaining === 0) {
                    elStudyDaysLabel.textContent = t("planner.examDatePassed", "Termín zkoušky již uplynul");
                } else if (examPlanner.startDate && examPlanner.startDate > m.todayStr) {
                    elStudyDaysLabel.textContent = `Od začátku (${examPlanner.startDate})`;
                } else {
                    elStudyDaysLabel.textContent = t("planner.daysRemainingLabel", "Zbývá do termínu zkoušky");
                }
            }

            const elNetDays = document.getElementById("plannerStatNetDays");
            if (elNetDays) elNetDays.textContent = m.netStudyDays;

            const elCompletedQ = document.getElementById("plannerStatCompletedQuestions");
            if (elCompletedQ) elCompletedQ.textContent = m.completedQuestions;

            const elTotalQ = document.getElementById("plannerStatTotalQuestions");
            if (elTotalQ) elTotalQ.textContent = m.totalQuestions;

            const elCompletedPct = document.getElementById("plannerStatCompletedPctLabel");
            if (elCompletedPct) elCompletedPct.textContent = `${m.progressPct}% celkově splněno`;

            const elCompletedToday = document.getElementById("plannerStatCompletedToday");
            if (elCompletedToday) elCompletedToday.textContent = m.completedToday;

            const elDailyTarget = document.getElementById("plannerStatDailyTarget");
            if (elDailyTarget) elDailyTarget.textContent = m.questionsPerDay;

            // Celkový progress bar
            const elProgressBar = document.getElementById("plannerOverallProgressBar");
            if (elProgressBar) elProgressBar.style.width = `${m.progressPct}%`;

            const elProgressPct = document.getElementById("plannerOverallProgressPct");
            if (elProgressPct) elProgressPct.textContent = `${m.progressPct}%`;

            const elRemainingInfo = document.getElementById("plannerRemainingInfo");
            if (elRemainingInfo) elRemainingInfo.textContent = `Zbývá ${Math.max(0, m.totalQuestions - m.completedQuestions)} z ${m.totalQuestions} otázek k projití`;

            const elSpeedInfo = document.getElementById("plannerSpeedInfo");
            if (elSpeedInfo) {
                elSpeedInfo.textContent = m.questionsPerDay > 0 ? `Cíl: ${m.questionsPerDay} ot./den` : (m.totalQuestions > 0 && m.completedQuestions === m.totalQuestions ? "Vše splněno! 🎉" : "--");
            }

            // Distribuce známek
            const tot = m.totalQuestions > 0 ? m.totalQuestions : 1;
            const pctA = m.totalQuestions > 0 ? (m.countA / tot) * 100 : 0;
            const pctB = m.totalQuestions > 0 ? (m.countB / tot) * 100 : 0;
            const pctC = m.totalQuestions > 0 ? (m.countC / tot) * 100 : 0;
            const pctD = m.totalQuestions > 0 ? (m.countD / tot) * 100 : 0;
            const pctNone = m.totalQuestions > 0 ? (m.countNone / tot) * 100 : 100;

            const bA = document.getElementById("plannerGradeBarA");
            const bB = document.getElementById("plannerGradeBarB");
            const bC = document.getElementById("plannerGradeBarC");
            const bD = document.getElementById("plannerGradeBarD");
            const bNone = document.getElementById("plannerGradeBarNone");

            if (bA) bA.style.width = `${pctA}%`;
            if (bB) bB.style.width = `${pctB}%`;
            if (bC) bC.style.width = `${pctC}%`;
            if (bD) bD.style.width = `${pctD}%`;
            if (bNone) bNone.style.width = `${pctNone}%`;

            const cA = document.getElementById("plannerCountA");
            const cB = document.getElementById("plannerCountB");
            const cC = document.getElementById("plannerCountC");
            const cD = document.getElementById("plannerCountD");
            const cNone = document.getElementById("plannerCountNone");

            if (cA) cA.textContent = `${m.countA} (${Math.round(pctA)}%)`;
            if (cB) cB.textContent = `${m.countB} (${Math.round(pctB)}%)`;
            if (cC) cC.textContent = `${m.countC} (${Math.round(pctC)}%)`;
            if (cD) cD.textContent = `${m.countD} (${Math.round(pctD)}%)`;
            if (cNone) cNone.textContent = `${m.countNone}`;

            const ratedCountEl = document.getElementById("plannerRatedCount");
            if (ratedCountEl) ratedCountEl.textContent = `${m.ratedCount} / ${m.totalQuestions} ohodnoceno`;

            // Aktualizace statusu na domovské obrazovce
            const homeStatus = document.getElementById("homePlannerCardStatus");
            if (homeStatus) {
                if (!currentProject) {
                    homeStatus.textContent = "Vyberte projekt";
                } else if (!examPlanner.examDate) {
                    homeStatus.textContent = `${m.totalQuestions} otázek &bull; Nastavit termín`;
                } else {
                    homeStatus.textContent = `Zbývá ${m.studyDaysRemaining} dní &bull; ${m.progressPct}% hotovo (${m.questionsPerDay} ot/den)`;
                }
            }
        }

        function getTopicBadgeClass(topic = "") {
            const t = (topic || "").toLowerCase();
            if (t.includes("kardio")) return "bg-rose-950/80 text-rose-300 border-rose-800";
            if (t.includes("pneumo")) return "bg-sky-950/80 text-sky-300 border-sky-800";
            if (t.includes("hemato")) return "bg-red-950/80 text-red-300 border-red-800";
            if (t.includes("nefro")) return "bg-indigo-950/80 text-indigo-300 border-indigo-800";
            if (t.includes("gastro") || t.includes("git")) return "bg-amber-950/80 text-amber-300 border-amber-800";
            if (t.includes("endo") || t.includes("diabet")) return "bg-emerald-950/80 text-emerald-300 border-emerald-800";
            if (t.includes("revma")) return "bg-purple-950/80 text-purple-300 border-purple-800";
            if (t.includes("infekc") || t.includes("tbc")) return "bg-teal-950/80 text-teal-300 border-teal-800";
            if (t.includes("aro") || t.includes("urgent")) return "bg-orange-950/80 text-orange-300 border-orange-800";
            return "bg-slate-800 text-slate-300 border-slate-700";
        }

        function getGradeBadgeClass(grade) {
            if (grade === "A") return "bg-emerald-600 text-white font-bold";
            if (grade === "B") return "bg-amber-500 text-black font-bold";
            if (grade === "C") return "bg-orange-500 text-white font-bold";
            if (grade === "D") return "bg-rose-600 text-white font-bold";
            return "bg-slate-700 text-slate-300 font-medium";
        }

        const CZECH_DAYS_LONG = ["Neděle", "Pondělí", "Úterý", "Středa", "Čtvrtek", "Pátek", "Sobota"];
        const CZECH_DAYS_SHORT = ["Ne", "Po", "Út", "St", "Čt", "Pá", "So"];

        function setPlannerCalendarMode(mode) {
            if (!["sequential", "topics", "priority", "interleaved"].includes(mode)) return;
            examPlanner.scheduleMode = mode;
            saveProjectQuestions(false);
            updatePlannerCalendarModeButtons(mode);
            renderPlannerCalendarStrip();
            if (plannerCalendarSelectedDay) {
                renderPlannerTable();
            }
        }

        function updatePlannerCalendarModeButtons(activeMode = "sequential") {
            const modes = [
                { id: "btnCalModeSequential", key: "sequential" },
                { id: "btnCalModeTopics", key: "topics" },
                { id: "btnCalModePriority", key: "priority" },
                { id: "btnCalModeInterleaved", key: "interleaved" }
            ];
            modes.forEach(m => {
                const btn = document.getElementById(m.id);
                if (btn) {
                    if (m.key === activeMode) {
                        btn.className = "px-2.5 py-1 rounded-lg font-semibold text-xs transition flex items-center gap-1 shadow-sm bg-rose-600 text-white";
                    } else {
                        btn.className = "px-2.5 py-1 rounded-lg font-semibold text-xs transition flex items-center gap-1 text-slate-400 hover:text-white hover:bg-slate-800";
                    }
                }
            });
        }

        function calculatePlannerWeekSchedule() {
            const todayStr = getLocalDateString();
            const questions = examPlanner.questions || [];
            const metrics = calculatePlannerMetrics();
            const mode = examPlanner.scheduleMode || "sequential";

            const uncompleted = questions.filter(q => !q.completedDate);
            const isAllCompleted = (uncompleted.length === 0 && questions.length > 0);

            // Výpočet denního cíle
            let dailyTarget = metrics.questionsPerDay;
            if (dailyTarget <= 0) {
                if (uncompleted.length > 0) {
                    dailyTarget = Math.max(1, Math.min(10, Math.ceil(uncompleted.length / 7)));
                } else if (questions.length > 0) {
                    dailyTarget = Math.max(1, Math.ceil(questions.length / 7));
                } else {
                    dailyTarget = 0;
                }
            }

            // Příprava fondu otázek pro rozdělení podle zvoleného studijního režimu
            let pool = isAllCompleted ? [...questions] : [...uncompleted];

            if (mode === "topics") {
                // Po okruzích (abecedně podle lékařských oborů/témat, v rámci okruhu podle čísel)
                pool.sort((a, b) => {
                    const topA = a.topic || "Všeobecné";
                    const topB = b.topic || "Všeobecné";
                    const cTop = topA.localeCompare(topB, "cs", { sensitivity: "base" });
                    if (cTop !== 0) return cTop;
                    const numA = parseFloat(String(a.number || '').replace(/[^\d.]/g, ''));
                    const numB = parseFloat(String(b.number || '').replace(/[^\d.]/g, ''));
                    if (!isNaN(numA) && !isNaN(numB) && numA !== numB) return numA - numB;
                    return (a.q_index || 0) - (b.q_index || 0);
                });
            } else if (mode === "priority") {
                // Podle priorit: Nejdříve horší známky D, C, poté neohodnocené, pak B, A
                const gradeWeight = { "D": 1, "C": 2, "": 3, "null": 3, "undefined": 3, "B": 4, "A": 5 };
                pool.sort((a, b) => {
                    const wA = gradeWeight[a.grade || ""] || 3;
                    const wB = gradeWeight[b.grade || ""] || 3;
                    if (wA !== wB) return wA - wB;
                    const numA = parseFloat(String(a.number || '').replace(/[^\d.]/g, ''));
                    const numB = parseFloat(String(b.number || '').replace(/[^\d.]/g, ''));
                    if (!isNaN(numA) && !isNaN(numB) && numA !== numB) return numA - numB;
                    return (a.q_index || 0) - (b.q_index || 0);
                });
            } else if (mode === "interleaved") {
                // Mix témat: rovnoměrné střídání různých oborů (round-robin)
                const topicMap = {};
                pool.forEach(q => {
                    const t = q.topic || "Všeobecné";
                    if (!topicMap[t]) topicMap[t] = [];
                    topicMap[t].push(q);
                });
                Object.values(topicMap).forEach(list => {
                    list.sort((a, b) => {
                        const numA = parseFloat(String(a.number || '').replace(/[^\d.]/g, ''));
                        const numB = parseFloat(String(b.number || '').replace(/[^\d.]/g, ''));
                        if (!isNaN(numA) && !isNaN(numB) && numA !== numB) return numA - numB;
                        return (a.q_index || 0) - (b.q_index || 0);
                    });
                });
                const topicKeys = Object.keys(topicMap).sort();
                const mixed = [];
                let hasMore = true;
                let idx = 0;
                while (hasMore) {
                    hasMore = false;
                    for (const t of topicKeys) {
                        if (idx < topicMap[t].length) {
                            mixed.push(topicMap[t][idx]);
                            hasMore = true;
                        }
                    }
                    idx++;
                }
                pool = mixed;
            } else {
                // sequential (po číslech otázek 1, 2, 3...)
                pool.sort((a, b) => {
                    const numA = parseFloat(String(a.number || '').replace(/[^\d.]/g, ''));
                    const numB = parseFloat(String(b.number || '').replace(/[^\d.]/g, ''));
                    if (!isNaN(numA) && !isNaN(numB) && numA !== numB) return numA - numB;
                    return (a.q_index || 0) - (b.q_index || 0);
                });
            }

            // Generování 7 po sobě jdoucích dní (dnešek + dalších 6 dní)
            const now = new Date();
            const baseToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            const schedule = [];
            let poolCursor = 0;

            for (let i = 0; i < 7; i++) {
                const d = new Date(baseToday.getFullYear(), baseToday.getMonth(), baseToday.getDate() + i);
                const dateStr = getLocalDateString(d);
                const isToday = (i === 0);
                const isExamDay = Boolean(examPlanner.examDate && dateStr === examPlanner.examDate);
                const isPostExam = Boolean(examPlanner.examDate && dateStr > examPlanner.examDate);

                const dayItems = [];
                const seenIds = new Set();

                // 1. Otázky dokončené v tento den
                const doneOnDate = questions.filter(q => q.completedDate === dateStr);
                doneOnDate.forEach(q => {
                    dayItems.push({
                        question: q,
                        isCompleted: true,
                        isCompletedToday: isToday,
                        isRevision: isAllCompleted
                    });
                    seenIds.add(q.id);
                });

                // 2. Počet otázek k projití pro naplnění denního cíle
                let needed = dailyTarget;
                if (isToday) {
                    needed = Math.max(0, dailyTarget - doneOnDate.length);
                }

                // 3. Přiřazení z připraveného fondu otázek
                while (needed > 0 && poolCursor < pool.length) {
                    const candidate = pool[poolCursor++];
                    if (!seenIds.has(candidate.id)) {
                        dayItems.push({
                            question: candidate,
                            isCompleted: Boolean(candidate.completedDate),
                            isCompletedToday: candidate.completedDate === todayStr,
                            isRevision: isAllCompleted
                        });
                        seenIds.add(candidate.id);
                        needed--;
                    }
                }

                const activeLang = (typeof currentLanguage !== "undefined" && ["cs", "en", "fr"].includes(currentLanguage)) ? currentLanguage : (localStorage.getItem("medstudio_lang") || "cs");
                const dateLocale = (activeLang === "en") ? "en-US" : (activeLang === "fr" ? "fr-FR" : "cs-CZ");
                const rawDayLong = d.toLocaleDateString(dateLocale, { weekday: "long" });
                const rawDayShort = d.toLocaleDateString(dateLocale, { weekday: "short" });
                const dayNameLong = rawDayLong.charAt(0).toUpperCase() + rawDayLong.slice(1);
                const dayNameShort = rawDayShort.charAt(0).toUpperCase() + rawDayShort.slice(1);
                const dateFormatted = d.toLocaleDateString(dateLocale, { day: "numeric", month: "numeric" });

                let relativeLabel = "";
                if (i === 0) relativeLabel = t("planner.calToday", "Dnes");
                else if (i === 1) relativeLabel = t("planner.calTomorrow", "Zítra");
                else relativeLabel = t("planner.calPlusDays", `+${i} dní`, { count: i });

                schedule.push({
                    dayIndex: i,
                    date: d,
                    dateStr: dateStr,
                    isToday: isToday,
                    isExamDay: isExamDay,
                    isPostExam: isPostExam,
                    relativeLabel: relativeLabel,
                    dayNameLong: dayNameLong,
                    dayNameShort: dayNameShort,
                    dateFormatted: dateFormatted,
                    items: dayItems,
                    targetCount: dailyTarget,
                    doneCount: doneOnDate.length,
                    isAllCompleted: isAllCompleted
                });
            }

            currentWeekSchedule = schedule;
            return schedule;
        }

        function renderPlannerCalendarStrip() {
            const container = document.getElementById("plannerCalendarDaysContainer");
            if (!container) return;

            const questions = examPlanner.questions || [];
            if (questions.length === 0) {
                container.innerHTML = `
                    <div class="col-span-full bg-slate-900/80 border border-slate-700/80 rounded-xl p-6 text-center text-slate-400 text-xs italic flex flex-col items-center justify-center gap-2">
                        <span class="text-2xl">📋</span>
                        <span class="font-medium text-slate-300">${t("planner.calEmptyTitle", "V plánovači projektu zatím nejsou žádné otázky.")}</span>
                        <span class="text-slate-500">${t("planner.calEmptyDesc", "Naimportujte otázky nebo je synchronizujte z projektu pro zobrazení týdenního harmonogramu.")}</span>
                    </div>
                `;
                return;
            }

            const schedule = calculatePlannerWeekSchedule();
            container.innerHTML = "";

            schedule.forEach(day => {
                const isSelected = (plannerCalendarSelectedDay === day.dateStr);
                const card = document.createElement("div");

                // Vizuální odlišení: dnešek je prominentně zvýrazněn, další dny následují
                let cardBaseClass = "rounded-xl p-3 sm:p-3.5 transition-all flex flex-col justify-between select-none relative overflow-hidden ";
                if (day.isToday) {
                    cardBaseClass += isSelected 
                        ? "border-2 border-emerald-400 ring-2 ring-emerald-400/50 bg-gradient-to-b from-rose-950/60 via-slate-900 to-slate-950 shadow-2xl shadow-rose-950/50"
                        : "border-2 border-rose-500 shadow-xl shadow-rose-950/40 bg-gradient-to-b from-rose-950/50 via-slate-900 to-slate-950";
                } else {
                    cardBaseClass += isSelected
                        ? "border-2 border-emerald-400 ring-2 ring-emerald-400/40 bg-slate-900 shadow-lg"
                        : (day.isExamDay 
                            ? "border border-amber-500/80 bg-amber-950/20 hover:border-amber-400"
                            : "border border-slate-700/80 bg-slate-900/80 hover:border-slate-500");
                }
                card.className = cardBaseClass;

                // Odznak dne (Dnes, Zítra, +X dní, Zkouška)
                let topBadgeHtml = "";
                if (day.isToday) {
                    topBadgeHtml = `<span class="bg-rose-600 text-white font-black text-[10px] px-2 py-0.5 rounded-full uppercase tracking-wider shadow">${t("planner.calBadgeToday", "🌟 Dnes")}</span>`;
                } else if (day.isExamDay) {
                    topBadgeHtml = `<span class="bg-amber-500 text-black font-extrabold text-[10px] px-1.5 py-0.5 rounded shadow">${t("planner.calBadgeExam", "🎯 Zkouška")}</span>`;
                } else if (day.isPostExam) {
                    topBadgeHtml = `<span class="bg-slate-800 text-slate-500 text-[10px] px-1.5 py-0.5 rounded">${t("planner.calBadgePostExam", "Po zkoušce")}</span>`;
                } else {
                    topBadgeHtml = `<span class="bg-slate-800 text-slate-300 font-semibold text-[10px] px-1.5 py-0.5 rounded border border-slate-700">${day.relativeLabel}</span>`;
                }

                const dayTitleCls = day.isToday ? "text-rose-200 font-extrabold text-sm sm:text-base tracking-tight" : "text-slate-200 font-bold text-sm";
                const dateCls = day.isToday ? "text-rose-300 font-mono text-xs font-semibold" : "text-slate-400 font-mono text-xs";

                // Status splnění
                let dayStatusHtml = "";
                if (day.isToday) {
                    if (day.targetCount > 0 && day.doneCount >= day.targetCount) {
                        dayStatusHtml = `<span class="text-[10px] text-emerald-400 font-bold flex items-center gap-1">${t("planner.calDoneAll", "🎉 Hotovo ({done}/{target})", { done: day.doneCount, target: day.targetCount })}</span>`;
                    } else {
                        dayStatusHtml = `<span class="text-[10px] text-rose-300 font-semibold">${t("planner.calDoneRatio", "✅ {done}/{target} splněno", { done: day.doneCount, target: day.targetCount })}</span>`;
                    }
                } else {
                    dayStatusHtml = `<span class="text-[10px] text-slate-400">${t("planner.calPlanCount", "🎯 Plán: {count} ot.", { count: day.items.length })}</span>`;
                }

                // Seznam otázek
                let itemsHtml = "";
                if (day.items.length === 0) {
                    itemsHtml = `
                        <div class="py-5 px-2 text-center text-slate-500 text-[11px] italic bg-slate-950/40 rounded-lg border border-slate-800/60 my-auto">
                            ${day.isAllCompleted ? t("planner.calAllCompleted", "🎉 Vše hotovo") : t("planner.calNoQuestions", "💤 Žádné otázky")}
                        </div>
                    `;
                } else {
                    const listRows = day.items.map(item => {
                        const q = item.question;
                        const isDone = item.isCompleted;
                        const topicBadge = getTopicBadgeClass(q.topic);
                        const gradeBadge = q.grade ? getGradeBadgeClass(q.grade) : "";
                        const viewer = isViewerMode();

                        const checkboxHtml = viewer
                            ? `<input type="checkbox" ${isDone ? 'checked' : ''} disabled
                                    class="mt-0.5 accent-emerald-500 w-3.5 h-3.5 cursor-not-allowed opacity-60 shrink-0"
                                    title="${t("common.viewerReadOnly", "Režim pozorovatele: Pouze ke čtení")}">`
                            : `<input type="checkbox" ${isDone ? 'checked' : ''}
                                    onchange="event.stopPropagation(); togglePlannerQuestionCompleted('${q.id}')"
                                    class="mt-0.5 accent-emerald-500 w-3.5 h-3.5 cursor-pointer shrink-0"
                                    title="${isDone ? t("planner.calUnmarkDone", "Splněno ({date}) - klikněte pro zrušení", { date: q.completedDate || '' }) : t("planner.calMarkDoneToday", "Označit otázku jako hotovou dnes")}">`;

                        const topicDisplay = escapeHtml(q.topic || t("common.general", "Všeobecné"));
                        const editTitle = viewer ? escapeHtml(q.title) : t("planner.calEditQuestionTitle", "Klikněte pro úpravu otázky");

                        return `
                            <div class="p-1.5 sm:p-2 rounded-lg ${isDone ? 'bg-emerald-950/20 border-emerald-900/60' : 'bg-slate-950/80 border-slate-800'} border hover:border-slate-600 transition flex items-start gap-1.5 group text-left">
                                ${checkboxHtml}
                                
                                <div class="flex-1 min-w-0 ${viewer ? 'cursor-default' : 'cursor-pointer'}" ${viewer ? '' : `onclick="openPlannerEditQuestionModal('${q.id}')"`} title="${editTitle}">
                                    <div class="flex items-center gap-1 mb-0.5 flex-wrap">
                                        <span class="font-mono text-[9px] text-slate-400 font-bold">#${q.number || ''}</span>
                                        <span class="inline-block px-1 py-0.2 rounded text-[8.5px] font-semibold border ${topicBadge} truncate max-w-[80px]" title="${topicDisplay}">
                                            ${topicDisplay}
                                        </span>
                                        ${q.grade ? `<span class="px-1 rounded text-[8.5px] ${gradeBadge}">${q.grade}</span>` : ''}
                                    </div>
                                    <p class="text-[11px] leading-snug text-slate-200 group-hover:text-emerald-300 transition line-clamp-2" title="${escapeHtml(q.title)}">
                                        ${escapeHtml(q.title)}
                                    </p>
                                </div>

                                <button type="button" onclick="event.stopPropagation(); explainExamQuestion('${escapeQuotes(q.title)}')"
                                    class="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-sky-300 text-xs transition shrink-0 p-0.5"
                                    title="${t("planner.explainInNotes", "Vysvětlit v poznámkách")}">
                                    💡
                                </button>
                            </div>
                        `;
                    }).join("");

                    itemsHtml = `
                        <div class="max-h-52 overflow-y-auto space-y-1.5 custom-scrollbar pr-0.5 py-1">
                            ${listRows}
                        </div>
                    `;
                }

                // Tlačítko filtru tabulky pro daný den
                let filterBtnHtml = "";
                if (isSelected) {
                    filterBtnHtml = `
                        <button type="button" onclick="togglePlannerCalendarDayFilter('${day.dateStr}')"
                            class="w-full text-center py-1.5 px-2 text-[10px] font-bold text-emerald-300 bg-emerald-950/70 hover:bg-emerald-900/80 rounded-lg border border-emerald-700/80 transition flex items-center justify-center gap-1 shadow-sm">
                            <span>✕</span> <span>${t("planner.calClearFilter", "Zrušit filtr")}</span>
                        </button>
                    `;
                } else {
                    filterBtnHtml = `
                        <button type="button" onclick="togglePlannerCalendarDayFilter('${day.dateStr}')"
                            class="w-full text-center py-1.5 px-2 text-[10px] font-semibold text-slate-400 hover:text-white bg-slate-950/70 hover:bg-slate-800 rounded-lg border border-slate-800 transition flex items-center justify-center gap-1"
                            title="${t("planner.calFilterTitle", "Vyfiltrovat tabulku níže pouze na otázky tohoto dne")}">
                            <span>🔍</span> <span>${t("planner.calFilterBtn", "Filtrovat ({count})", { count: day.items.length })}</span>
                        </button>
                    `;
                }

                card.innerHTML = `
                    <div>
                        <!-- Horní lišta karty -->
                        <div class="flex items-center justify-between gap-1 pb-1.5 mb-1.5 border-b ${day.isToday ? 'border-rose-900/60' : 'border-slate-800'}">
                            ${topBadgeHtml}
                            ${dayStatusHtml}
                        </div>

                        <!-- Den a datum -->
                        <div class="flex items-baseline justify-between mb-2">
                            <span class="${dayTitleCls}">${day.dayNameLong}</span>
                            <span class="${dateCls}">${day.dateFormatted}</span>
                        </div>

                        <!-- Seznam otázek -->
                        ${itemsHtml}
                    </div>

                    <!-- Spodní akce: tlačítko filtru -->
                    <div class="pt-2 mt-2 border-t ${day.isToday ? 'border-rose-900/40' : 'border-slate-800/80'}">
                        ${filterBtnHtml}
                    </div>
                `;

                container.appendChild(card);
            });
        }

        function togglePlannerCalendarDayFilter(dateStr) {
            if (plannerCalendarSelectedDay === dateStr) {
                plannerCalendarSelectedDay = null;
            } else {
                plannerCalendarSelectedDay = dateStr;
            }
            renderPlannerCalendarStrip();
            renderPlannerTable();
        }

        function clearPlannerCalendarDayFilter() {
            plannerCalendarSelectedDay = null;
            renderPlannerCalendarStrip();
            renderPlannerTable();
        }

        let plannerSortInitialized = false;

        function initPlannerSortToggle() {
            const saved = localStorage.getItem("aiPodcastPlannerSortCompletedEnd");
            const toggle = document.getElementById("plannerSortCompletedEnd");
            if (toggle && saved !== null) {
                toggle.checked = saved === "1";
            }
            if (toggle) {
                updatePlannerSortToggleUI(toggle.checked);
            }
        }

        function onPlannerSortToggleChange() {
            const toggle = document.getElementById("plannerSortCompletedEnd");
            const isChecked = toggle ? toggle.checked : false;
            localStorage.setItem("aiPodcastPlannerSortCompletedEnd", isChecked ? "1" : "0");
            updatePlannerSortToggleUI(isChecked);
            renderPlannerTable();
        }

        function updatePlannerSortToggleUI(isChecked) {
            const statusEl = document.getElementById("plannerSortCompletedEndStatus");
            if (statusEl) {
                statusEl.textContent = isChecked ? "ON" : "OFF";
                statusEl.className = isChecked ? "font-bold text-[11px] text-emerald-400 font-mono" : "font-bold text-[11px] text-slate-400 font-mono";
            }
            const labelEl = document.getElementById("plannerSortCompletedEndLabel");
            if (labelEl) {
                if (isChecked) {
                    labelEl.classList.add("border-emerald-600/50", "bg-emerald-950/30", "text-emerald-300");
                    labelEl.classList.remove("border-slate-700", "bg-slate-900", "text-slate-300");
                } else {
                    labelEl.classList.remove("border-emerald-600/50", "bg-emerald-950/30", "text-emerald-300");
                    labelEl.classList.add("border-slate-700", "bg-slate-900", "text-slate-300");
                }
            }
        }

        function renderPlannerTable() {
            const tbody = document.getElementById("plannerTableBody");
            if (!tbody) return;

            if (!plannerSortInitialized) {
                initPlannerSortToggle();
                plannerSortInitialized = true;
            }

            const searchTerm = (document.getElementById("plannerSearchInput")?.value || "").toLowerCase().trim();
            const filterTopic = document.getElementById("plannerFilterTopic")?.value || "";
            const filterStatus = document.getElementById("plannerFilterStatus")?.value || "";
            const filterGrade = document.getElementById("plannerFilterGrade")?.value || "";

            const qList = examPlanner.questions || [];

            // Aktualizace výběru témat v dropdownu filtru
            const topicSelect = document.getElementById("plannerFilterTopic");
            if (topicSelect) {
                const currentVal = topicSelect.value;
                const uniqueTopics = Array.from(new Set(qList.map(q => q.topic).filter(Boolean))).sort();
                topicSelect.innerHTML = '<option value="">Všechna témata</option>';
                uniqueTopics.forEach(top => {
                    const opt = document.createElement("option");
                    opt.value = top;
                    opt.textContent = top;
                    if (top === currentVal) opt.selected = true;
                    topicSelect.appendChild(opt);
                });
            }

            const todayStr = getLocalDateString();

            // Filtrace otázek
            const filtered = qList.filter(q => {
                if (searchTerm) {
                    const titleMatch = (q.title || "").toLowerCase().includes(searchTerm);
                    const topicMatch = (q.topic || "").toLowerCase().includes(searchTerm);
                    const noteMatch = (q.note || "").toLowerCase().includes(searchTerm);
                    const numMatch = String(q.number || "").toLowerCase().includes(searchTerm);
                    if (!titleMatch && !topicMatch && !noteMatch && !numMatch) return false;
                }

                if (filterTopic && q.topic !== filterTopic) return false;

                if (filterStatus === "completed" && !q.completedDate) return false;
                if (filterStatus === "incomplete" && q.completedDate) return false;
                if (filterStatus === "today" && q.completedDate !== todayStr) return false;

                if (filterGrade === "none" && q.grade) return false;
                if (filterGrade && filterGrade !== "none" && q.grade !== filterGrade) return false;

                return true;
            });

            // Filtrování podle dne vybraného v kalendáři
            let activeCalDayName = "";
            if (plannerCalendarSelectedDay && Array.isArray(currentWeekSchedule)) {
                const dayObj = currentWeekSchedule.find(d => d.dateStr === plannerCalendarSelectedDay);
                if (dayObj) {
                    const allowedIds = new Set(dayObj.items.map(item => item.question.id));
                    filtered = filtered.filter(q => allowedIds.has(q.id));
                    activeCalDayName = `${dayObj.dayNameLong} ${dayObj.dateFormatted} (${dayObj.relativeLabel})`;
                }
            }

            const activeDayBanner = document.getElementById("plannerCalendarActiveDayBanner");
            const activeDayText = document.getElementById("plannerCalendarActiveDayText");
            if (activeDayBanner && activeDayText) {
                if (plannerCalendarSelectedDay && activeCalDayName) {
                    activeDayBanner.classList.remove("hidden");
                    activeDayText.textContent = `${activeCalDayName} • ${filtered.length} otázek`;
                } else {
                    activeDayBanner.classList.add("hidden");
                }
            }

            // Řazení: pokud je aktivní přepínač 'Naučené na konec', projité/naučené otázky přesuneme na konec seznamu
            const sortCompletedEnd = document.getElementById("plannerSortCompletedEnd")?.checked || false;
            if (sortCompletedEnd) {
                filtered.sort((a, b) => {
                    const aDone = Boolean(a.completedDate);
                    const bDone = Boolean(b.completedDate);
                    if (aDone === bDone) return 0;
                    return aDone ? 1 : -1;
                });
            }

            const countLabel = document.getElementById("plannerFilteredCountLabel");
            if (countLabel) {
                if (plannerCalendarSelectedDay && activeCalDayName) {
                    countLabel.textContent = `Zobrazeno ${filtered.length} otázek (filtr kalendáře pro ${activeCalDayName})`;
                } else {
                    countLabel.textContent = `Zobrazeno ${filtered.length} z ${qList.length} otázek`;
                }
            }

            if (filtered.length === 0) {
                tbody.innerHTML = `
                    <tr>
                        <td colspan="7" class="p-8 text-center text-slate-500 italic">
                            ${qList.length === 0 
                                ? 'Zatím žádné otázky v plánovači. Použijte tlačítko „Importovat otázky“ nebo „Sync z projektu“.' 
                                : 'Žádná otázka neodpovídá zvoleným filtrům.'}
                        </td>
                    </tr>
                `;
                return;
            }

            tbody.innerHTML = "";
            let renderedDivider = false;
            filtered.forEach((q, idx) => {
                if (sortCompletedEnd && !renderedDivider && q.completedDate && idx > 0) {
                    const divTr = document.createElement("tr");
                    divTr.className = "bg-slate-950/90 border-y border-emerald-900/60";
                    divTr.innerHTML = `
                        <td colspan="7" class="py-1.5 px-3 text-[10px] uppercase font-bold tracking-wider text-emerald-400 bg-emerald-950/30">
                            <div class="flex items-center gap-1.5">
                                <span>✅</span>
                                <span>Naučené a projité otázky (${filtered.filter(item => item.completedDate).length})</span>
                            </div>
                        </td>
                    `;
                    tbody.appendChild(divTr);
                    renderedDivider = true;
                }

                const tr = document.createElement("tr");
                tr.className = `border-b border-slate-800/80 hover:bg-slate-850/80 transition ${q.completedDate ? 'bg-slate-900/30' : ''}`;

                const badgeClass = getTopicBadgeClass(q.topic);
                const isCompleted = Boolean(q.completedDate);
                const isDoneToday = q.completedDate === todayStr;
                const viewer = isViewerMode();

                // Tlačítka známek A, B, C, D
                const grades = ["A", "B", "C", "D"];
                const gradeButtons = grades.map(g => {
                    const isSelected = q.grade === g;
                    let activeColor = "";
                    if (g === "A") activeColor = "bg-emerald-600 text-white font-black shadow-md border-emerald-500";
                    else if (g === "B") activeColor = "bg-amber-500 text-black font-black shadow-md border-amber-400";
                    else if (g === "C") activeColor = "bg-orange-500 text-white font-black shadow-md border-orange-400";
                    else if (g === "D") activeColor = "bg-rose-600 text-white font-black shadow-md border-rose-500";

                    if (viewer) {
                        const cls = isSelected 
                            ? `${activeColor} px-2 py-0.5 rounded text-xs border font-bold opacity-80 cursor-default` 
                            : "bg-slate-950 text-slate-600 px-1.5 py-0.5 rounded text-xs border border-slate-900 opacity-40 cursor-default";
                        return `<span class="${cls}">${g}</span>`;
                    }

                    const cls = isSelected 
                        ? `${activeColor} px-2 py-0.5 rounded text-xs border font-bold scale-105 transition` 
                        : "bg-slate-950 text-slate-400 hover:text-white hover:bg-slate-800 px-1.5 py-0.5 rounded text-xs border border-slate-800 transition";

                    return `<button onclick="setPlannerQuestionGrade('${q.id}', '${g}')" class="${cls}" title="Nastavit známku ${g}">${g}</button>`;
                }).join(" ");

                const dateDisplay = q.completedDate 
                    ? `<span class="font-mono text-[10px] text-slate-300 bg-slate-950 px-1.5 py-0.5 rounded border border-slate-800 ${viewer ? 'cursor-default' : 'cursor-pointer'}" ${viewer ? '' : `onclick="editPlannerQuestionDate('${q.id}')"`} title="${viewer ? `Datum splnění: ${q.completedDate}` : 'Klikněte pro změnu data'}">${isDoneToday ? '🌟 Dnes' : q.completedDate}</span>` 
                    : `<span class="text-[10px] text-slate-500 italic">Neprojito</span>`;

                const checkboxHtml = viewer
                    ? `<input type="checkbox" ${isCompleted ? 'checked' : ''} disabled class="accent-emerald-500 w-4 h-4 cursor-not-allowed opacity-60" title="Režim pozorovatele: Pouze ke čtení">`
                    : `<input type="checkbox" ${isCompleted ? 'checked' : ''} onchange="togglePlannerQuestionCompleted('${q.id}')" class="accent-emerald-500 w-4 h-4 cursor-pointer" title="${isCompleted ? 'Kliknutím zrušíte splnění' : 'Označit jako hotové dnes'}">`;

                const titleActionHtml = viewer
                    ? `<span class="text-slate-100 font-medium leading-snug ${isCompleted ? 'text-slate-300' : ''}">${escapeHtml(q.title)}</span>`
                    : `<span class="text-slate-100 font-medium leading-snug cursor-pointer hover:text-emerald-300 transition ${isCompleted ? 'text-slate-300' : ''}" onclick="openPlannerEditQuestionModal('${q.id}')" title="Klikněte pro úpravu otázky">
                           ${escapeHtml(q.title)}
                       </span>
                       <button onclick="openPlannerEditQuestionModal('${q.id}')" class="opacity-0 group-hover:opacity-100 text-slate-500 hover:text-white text-xs transition" title="Upravit otázku">✏️</button>`;

                const noteInputHtml = viewer
                    ? `<input type="text" value="${escapeHtml(q.note || '')}" placeholder="" readonly disabled class="w-full bg-slate-950/80 border border-slate-800 rounded px-2 py-1 text-slate-400 placeholder-slate-600 focus:outline-none cursor-default opacity-80 transition text-xs" title="Režim pozorovatele: Pouze ke čtení">`
                    : `<input type="text" value="${escapeHtml(q.note || '')}" placeholder="Přidat poznámku..." onchange="updatePlannerQuestionNote('${q.id}', this.value)" class="w-full bg-slate-950/80 border border-slate-800 rounded px-2 py-1 text-slate-300 placeholder-slate-600 focus:outline-none focus:border-rose-500/80 transition text-xs">`;

                const deleteBtnHtml = viewer
                    ? ""
                    : `<button onclick="deletePlannerQuestion('${q.id}')" class="text-slate-500 hover:text-red-400 px-1 py-1 font-bold text-xs transition" title="Smazat otázku">✕</button>`;

                tr.innerHTML = `
                    <td class="p-3">
                        <span class="inline-block px-2 py-0.5 rounded text-[11px] font-semibold border ${badgeClass}">
                            ${escapeHtml(q.topic || 'Všeobecné')}
                        </span>
                    </td>
                    <td class="p-3 text-center font-mono text-slate-400 text-xs font-semibold">
                        ${q.number || (idx + 1)}
                    </td>
                    <td class="p-3">
                        <div class="flex items-start justify-between gap-2 group">
                            ${titleActionHtml}
                        </div>
                    </td>
                    <td class="p-3 text-center">
                        <div class="flex items-center justify-center gap-2">
                            ${checkboxHtml}
                            ${dateDisplay}
                        </div>
                    </td>
                    <td class="p-3 text-center">
                        <div class="flex items-center justify-center gap-1">
                            ${gradeButtons}
                            ${q.grade && !viewer ? `<button onclick="setPlannerQuestionGrade('${q.id}', null)" class="text-slate-500 hover:text-red-400 text-[10px] px-1" title="Zrušit známku">✕</button>` : ''}
                        </div>
                    </td>
                    <td class="p-3">
                        ${noteInputHtml}
                    </td>
                    <td class="p-3 text-center">
                        <div class="flex items-center justify-center gap-1.5">
                            <button onclick="explainExamQuestion('${escapeQuotes(q.title)}')" class="bg-gradient-to-r from-sky-600 to-indigo-600 hover:from-sky-500 hover:to-indigo-500 text-white font-semibold px-2.5 py-1.5 rounded-lg transition shadow flex items-center gap-1 text-[11px]" title="Sestaví expertní prompt a vygeneruje studijní text v záložce Poznámky">
                                <span>💡</span> <span>Vysvětlit</span>
                            </button>
                            ${deleteBtnHtml}
                        </div>
                    </td>
                `;

                tbody.appendChild(tr);
            });
        }

        function togglePlannerQuestionCompleted(id) {
            if (isViewerMode()) {
                showGlobalToast(t("toast.viewerRestrictedQuestion", "Režim pozorovatele: Nemáte oprávnění měnit stav zkouškových otázek."), "warning");
                return;
            }
            const q = (examPlanner.questions || []).find(item => item.id === id);
            if (!q) return;

            if (q.completedDate) {
                q.completedDate = null;
            } else {
                q.completedDate = getLocalDateString();
            }

            saveExamPlanner();
            renderPlannerMetrics();
            renderPlannerCalendarStrip();
            renderPlannerTable();
        }

        function editPlannerQuestionDate(id) {
            if (isViewerMode()) {
                showGlobalToast(t("toast.viewerRestrictedQuestion", "Režim pozorovatele: Nemáte oprávnění měnit datum splnění."), "warning");
                return;
            }
            const q = (examPlanner.questions || []).find(item => item.id === id);
            if (!q) return;

            const newDate = prompt("Zadejte datum splnění (YYYY-MM-DD) nebo nechte prázdné pro zrušení:", q.completedDate || getLocalDateString());
            if (newDate === null) return; // Storno

            if (newDate.trim() === "") {
                q.completedDate = null;
            } else {
                q.completedDate = newDate.trim();
            }

            saveExamPlanner();
            renderPlannerMetrics();
            renderPlannerCalendarStrip();
            renderPlannerTable();
        }

        function setPlannerQuestionGrade(id, grade) {
            if (isViewerMode()) {
                showGlobalToast(t("toast.viewerRestrictedQuestion", "Režim pozorovatele: Nemáte oprávnění hodnotit zkouškové otázky."), "warning");
                return;
            }
            const q = (examPlanner.questions || []).find(item => item.id === id);
            if (!q) return;

            if (q.grade === grade) {
                q.grade = null; // Toggle off
            } else {
                q.grade = grade;
            }

            saveExamPlanner();
            renderPlannerMetrics();
            renderPlannerCalendarStrip();
            renderPlannerTable();
        }

        function updatePlannerQuestionNote(id, note) {
            if (isViewerMode()) return;
            const q = (examPlanner.questions || []).find(item => item.id === id);
            if (!q) return;
            q.note = note.trim();
            saveExamPlanner();
        }

        function deletePlannerQuestion(id) {
            if (isViewerMode()) {
                showGlobalToast(t("toast.viewerRestrictedQuestion", "Režim pozorovatele: Nemáte oprávnění mazat otázky."), "warning");
                return;
            }
            const qIndex = questions.findIndex(item => item.id === id);
            if (qIndex === -1) return;

            const title = questions[qIndex].title;
            if (confirm(`Opravdu smazat otázku: "${title}" z projektu i plánovače?`)) {
                questions.splice(qIndex, 1);
                questions.forEach((q, i) => q.q_index = i + 1);
                examPlanner.questions = questions;
                if (selectedQuestionIndex === qIndex) resetWorkspace();
                else if (selectedQuestionIndex > qIndex) selectedQuestionIndex--;
                saveProjectQuestions(false);
            }
        }

        function resetPlannerFilters() {
            const search = document.getElementById("plannerSearchInput");
            const topic = document.getElementById("plannerFilterTopic");
            const status = document.getElementById("plannerFilterStatus");
            const grade = document.getElementById("plannerFilterGrade");

            if (search) search.value = "";
            if (topic) topic.value = "";
            if (status) status.value = "";
            if (grade) grade.value = "";

            plannerCalendarSelectedDay = null;
            renderPlannerCalendarStrip();
            renderPlannerTable();
        }

        function markAllFilteredToday() {
            if (isViewerMode()) {
                showGlobalToast(t("toast.viewerRestrictedQuestion", "Režim pozorovatele: Nemáte oprávnění měnit stav zkouškových otázek."), "warning");
                return;
            }
            const searchTerm = (document.getElementById("plannerSearchInput")?.value || "").toLowerCase().trim();
            const filterTopic = document.getElementById("plannerFilterTopic")?.value || "";
            const filterStatus = document.getElementById("plannerFilterStatus")?.value || "";
            const filterGrade = document.getElementById("plannerFilterGrade")?.value || "";
            const todayStr = getLocalDateString();

            let count = 0;
            (examPlanner.questions || []).forEach(q => {
                if (searchTerm) {
                    const match = (q.title || "").toLowerCase().includes(searchTerm) || (q.topic || "").toLowerCase().includes(searchTerm) || (q.note || "").toLowerCase().includes(searchTerm);
                    if (!match) return;
                }
                if (filterTopic && q.topic !== filterTopic) return;
                if (filterStatus === "completed" && !q.completedDate) return;
                if (filterStatus === "incomplete" && q.completedDate) return;
                if (filterStatus === "today" && q.completedDate !== todayStr) return;
                if (filterGrade === "none" && q.grade) return;
                if (filterGrade && filterGrade !== "none" && q.grade !== filterGrade) return;

                if (plannerCalendarSelectedDay && Array.isArray(currentWeekSchedule)) {
                    const dayObj = currentWeekSchedule.find(d => d.dateStr === plannerCalendarSelectedDay);
                    if (dayObj) {
                        const allowedIds = new Set(dayObj.items.map(item => item.question.id));
                        if (!allowedIds.has(q.id)) return;
                    }
                }

                q.completedDate = todayStr;
                count++;
            });

            if (count > 0) {
                saveProjectQuestions(false);
                appendConsoleLog(`✅ Označeno ${count} otázek jako hotové dnes.`);
            }
        }

        function clearAllQuestionsConfirm() {
            if (isViewerMode()) {
                showGlobalToast(t("toast.viewerRestrictedQuestion", "Režim pozorovatele: Nemáte oprávnění mazat otázky."), "warning");
                return;
            }
            if (!questions || questions.length === 0) return;
            if (confirm(`Opravdu vymazat všech ${questions.length} otázek z projektu i plánovače '${currentProject}'?`)) {
                questions = [];
                examPlanner.questions = [];
                resetWorkspace();
                saveProjectQuestions(false);
            }
        }

        async function syncQuestionsFromProject() {
            if (isViewerMode()) {
                showGlobalToast(t("toast.viewerRestrictedQuestion", "Režim pozorovatele: Nemáte oprávnění měnit otázky projektu."), "warning");
                return;
            }
            if (!currentProject) {
                alert(t("common.selectProject", "Nejprve vyberte projekt v horní liště."));
                return;
            }
            questions.forEach((q, idx) => {
                questions[idx] = normalizeQuestion(q, idx + 1);
            });
            examPlanner.questions = questions;
            await saveProjectQuestions(false);
            appendConsoleLog(`🔄 Seznam ${questions.length} otázek projektu '${currentProject}' je plně synchronizován a uložen.`);
            alert(`Seznam otázek (${questions.length}) je plně sdílen napříč celým projektem i plánovačem.`);
        }

        let currentPlannerImportTab = "file";

        async function openPlannerImportModal() {
            if (isViewerMode()) {
                showGlobalToast(t("toast.viewerRestrictedQuestion", "Režim pozorovatele: Nemáte oprávnění importovat zkouškové otázky."), "warning");
                return;
            }
            if (!currentProject) {
                alert(t("common.selectProject", "Nejprve vyberte projekt."));
                return;
            }

            const modal = document.getElementById("modalPlannerImport");
            if (!modal) return;

            document.getElementById("importProjectNameLabel").textContent = currentProject;
            document.getElementById("importProjectQuestionsCount").textContent = questions.length;

            // Naplníme výběr ostatních existujících projektů pro případné zkopírování
            const srcSelect = document.getElementById("importSourceProjectSelect");
            if (srcSelect) {
                srcSelect.innerHTML = `<option value="">${t("planner.selectSourceProjPlaceholder", "-- Vyberte zdrojový projekt --")}</option>`;
                const allProjectsSelect = document.getElementById("projectSelect");
                if (allProjectsSelect) {
                    Array.from(allProjectsSelect.options).forEach(opt => {
                        if (opt.value && opt.value !== currentProject) {
                            const o = document.createElement("option");
                            o.value = opt.value;
                            o.textContent = opt.textContent;
                            srcSelect.appendChild(o);
                        }
                    });
                }
            }
            const srcInfo = document.getElementById("importSourceProjectInfo");
            if (srcInfo) srcInfo.textContent = "";

            plannerImportFileData = null;
            document.getElementById("plannerImportFileInput").value = "";
            document.getElementById("plannerImportFileLabel").textContent = "Vyberte soubor .csv nebo .txt";
            document.getElementById("plannerImportTextarea").value = "";

            setPlannerImportTab("file");
            modal.classList.remove("hidden");
        }

        async function onImportSourceProjectChange() {
            const srcSelect = document.getElementById("importSourceProjectSelect");
            const srcInfo = document.getElementById("importSourceProjectInfo");
            if (!srcSelect || !srcInfo) return;
            const val = srcSelect.value;
            if (!val) {
                srcInfo.textContent = "";
                return;
            }
            srcInfo.textContent = t("planner.checkingQuestionCount", "Zjišťuji počet otázek...");
            try {
                const res = await fetch(`/api/projects/${encodeURIComponent(val)}/questions`);
                if (res.ok) {
                    const data = await res.json();
                    const count = Array.isArray(data.questions) ? data.questions.length : 0;
                    srcInfo.textContent = `Projekt '${val}' obsahuje ${count} zkouškových otázek.`;
                } else {
                    srcInfo.textContent = `Nelze načíst otázky projektu '${val}'.`;
                }
            } catch (e) {
                srcInfo.textContent = "Chyba při komunikaci se serverem: " + e.message;
            }
        }

        function closePlannerImportModal() {
            const modal = document.getElementById("modalPlannerImport");
            if (modal) modal.classList.add("hidden");
        }

        function setPlannerImportTab(tab) {
            currentPlannerImportTab = tab;
            const btnP = document.getElementById("tabBtnImportProject");
            const btnF = document.getElementById("tabBtnImportFile");
            const btnT = document.getElementById("tabBtnImportText");

            const tabP = document.getElementById("importTabProject");
            const tabF = document.getElementById("importTabFile");
            const tabT = document.getElementById("importTabText");

            [btnP, btnF, btnT].forEach(b => {
                if (b) b.className = "flex-1 py-1.5 rounded-md text-slate-400 hover:text-slate-200 transition text-center";
            });
            [tabP, tabF, tabT].forEach(t => {
                if (t) t.classList.add("hidden");
            });

            if (tab === "project") {
                if (btnP) btnP.className = "flex-1 py-1.5 rounded-md bg-indigo-900/70 text-indigo-200 transition text-center font-bold shadow-sm";
                if (tabP) tabP.classList.remove("hidden");
            } else if (tab === "file") {
                if (btnF) btnF.className = "flex-1 py-1.5 rounded-md bg-indigo-900/70 text-indigo-200 transition text-center font-bold shadow-sm";
                if (tabF) tabF.classList.remove("hidden");
            } else if (tab === "text") {
                if (btnT) btnT.className = "flex-1 py-1.5 rounded-md bg-indigo-900/70 text-indigo-200 transition text-center font-bold shadow-sm";
                if (tabT) tabT.classList.remove("hidden");
            }
        }

        function onPlannerImportFileSelected(event) {
            const file = event.target.files[0];
            if (!file) return;

            document.getElementById("plannerImportFileLabel").textContent = `${file.name} (${Math.round(file.size / 1024)} KB)`;

            const reader = new FileReader();
            reader.onload = (e) => {
                plannerImportFileData = e.target.result;
            };
            reader.readAsText(file, "UTF-8");
        }

        async function executePlannerImport() {
            if (isViewerMode()) {
                showGlobalToast(t("toast.viewerRestrictedQuestion", "Režim pozorovatele: Nemáte oprávnění importovat zkouškové otázky."), "warning");
                return;
            }
            const mode = document.querySelector('input[name="plannerImportMode"]:checked')?.value || "append";
            const parsedQuestions = [];

            if (currentPlannerImportTab === "project") {
                const srcProj = document.getElementById("importSourceProjectSelect")?.value;
                if (!srcProj) {
                    alert(t("planner.selectSourceProj", "Vyberte prosím projekt, ze kterého chcete otázky zkopírovat."));
                    return;
                }
                try {
                    const res = await fetch(`/api/projects/${encodeURIComponent(srcProj)}/questions`);
                    const data = await res.json();
                    if (!Array.isArray(data.questions) || data.questions.length === 0) {
                        alert(`Projekt '${srcProj}' neobsahuje žádné otázky ke zkopírování.`);
                        return;
                    }
                    data.questions.forEach((q, idx) => {
                        const newQ = {
                            ...q,
                            id: `pq_${Date.now()}_${idx + 1}_${Math.random().toString(36).substr(2, 4)}`,
                            completedDate: null,
                            grade: null,
                            selected: false
                        };
                        parsedQuestions.push(newQ);
                    });
                } catch (e) {
                    alert("Chyba při stahování otázek z vybraného projektu: " + e.message);
                    return;
                }
            } else {
                let rawLines = [];
                if (currentPlannerImportTab === "file") {
                    if (!plannerImportFileData) {
                        alert(t("planner.selectCsvTxtFile", "Vyberte prosím soubor .csv nebo .txt."));
                        return;
                    }
                    rawLines = plannerImportFileData.split(/\r?\n/);
                } else if (currentPlannerImportTab === "text") {
                    const text = document.getElementById("plannerImportTextarea").value;
                    if (!text.trim()) {
                        alert(t("planner.enterQuestionsText", "Zadejte nebo vložte text otázek."));
                        return;
                    }
                    rawLines = text.split(/\r?\n/);
                }

                rawLines.forEach((line) => {
                    const trimmed = line.trim();
                    if (trimmed) {
                        const item = normalizeQuestion(trimmed, parsedQuestions.length + 1);
                        if (item) parsedQuestions.push(item);
                    }
                });
            }

            if (parsedQuestions.length === 0) {
                alert(t("planner.noValidQuestionsFound", "Nebyly nalezeny žádné platné otázky k importu."));
                return;
            }

            if (mode === "replace") {
                questions = parsedQuestions;
            } else {
                questions = [...questions, ...parsedQuestions];
            }
            questions.forEach((q, i) => q.q_index = i + 1);
            examPlanner.questions = questions;

            await saveProjectQuestions(false);
            closePlannerImportModal();
            appendConsoleLog(`📋 Úspěšně naimportováno ${parsedQuestions.length} otázek do projektu '${currentProject}'.`);
            alert(`Úspěšně naimportováno ${parsedQuestions.length} otázek do projektu '${currentProject}'.`);
        }

        function openPlannerAddQuestionModal(editId = null) {
            if (isViewerMode()) {
                showGlobalToast(t("toast.viewerRestrictedQuestion", "Režim pozorovatele: Nemáte oprávnění přidávat ani upravovat zkouškové otázky."), "warning");
                return;
            }
            const modal = document.getElementById("modalPlannerAddQuestion");
            if (!modal) return;

            const modalTitle = document.getElementById("addQuestionModalTitle");
            const modalIcon = document.getElementById("addQuestionModalIcon");
            const hiddenId = document.getElementById("plannerEditQuestionId");
            const inputTopic = document.getElementById("plannerInputTopic");
            const inputNumber = document.getElementById("plannerInputNumber");
            const inputTitle = document.getElementById("plannerInputTitle");
            const inputDate = document.getElementById("plannerInputCompletedDate");
            const inputGrade = document.getElementById("plannerInputGrade");
            const inputNote = document.getElementById("plannerInputNote");

            if (editId) {
                const q = questions.find(item => item.id === editId);
                if (!q) return;

                modalTitle.textContent = t("planner.editModalTitle", "Upravit zkouškovou otázku");
                modalIcon.textContent = "✏️";
                hiddenId.value = q.id;
                inputTopic.value = q.topic || "";
                inputNumber.value = q.number || "";
                inputTitle.value = q.title || "";
                inputDate.value = q.completedDate || "";
                inputGrade.value = q.grade || "";
                inputNote.value = q.note || "";
            } else {
                modalTitle.textContent = t("planner.addModalTitle", "Přidat zkouškovou otázku");
                modalIcon.textContent = "➕";
                hiddenId.value = "";
                inputTopic.value = "";
                inputNumber.value = String(questions.length + 1);
                inputTitle.value = "";
                inputDate.value = "";
                inputGrade.value = "";
                inputNote.value = "";
            }

            modal.classList.remove("hidden");
        }

        function openPlannerEditQuestionModal(id) {
            openPlannerAddQuestionModal(id);
        }

        function closePlannerAddQuestionModal() {
            const modal = document.getElementById("modalPlannerAddQuestion");
            if (modal) modal.classList.add("hidden");
        }

        function savePlannerQuestionFromModal() {
            if (isViewerMode()) {
                showGlobalToast(t("toast.viewerRestrictedQuestion", "Režim pozorovatele: Nemáte oprávnění ukládat zkouškové otázky."), "warning");
                return;
            }
            const hiddenId = document.getElementById("plannerEditQuestionId").value;
            const topic = document.getElementById("plannerInputTopic").value.trim() || "Všeobecné";
            const number = document.getElementById("plannerInputNumber").value.trim();
            const title = document.getElementById("plannerInputTitle").value.trim();
            const completedDate = document.getElementById("plannerInputCompletedDate").value || null;
            const grade = document.getElementById("plannerInputGrade").value || null;
            const note = document.getElementById("plannerInputNote").value.trim();

            if (!title) {
                alert(t("planner.enterQuestionTitle", "Zadejte znění zkouškové otázky."));
                return;
            }

            if (hiddenId) {
                // Editace
                const q = questions.find(item => item.id === hiddenId);
                if (q) {
                    q.topic = topic;
                    q.number = number;
                    q.title = title;
                    q.completedDate = completedDate;
                    q.grade = grade;
                    q.note = note;
                }
            } else {
                // Přidání nové
                const newQ = normalizeQuestion({
                    id: `pq_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
                    topic,
                    number: number || String(questions.length + 1),
                    title,
                    completedDate,
                    grade,
                    note,
                    status: "Ready",
                    selected: false,
                    q_index: questions.length + 1
                }, questions.length + 1);
                questions.push(newQ);
                examPlanner.questions = questions;
            }

            saveProjectQuestions(false);
            closePlannerAddQuestionModal();
        }

        // =========================================================================
        // CENTRÁLNÍ SPRÁVCE OTÁZEK PROJEKTU (QUESTION MANAGER)
        // =========================================================================
        function openQuestionsManagerModal() {
            const modal = document.getElementById("modalQuestionsManager");
            if (!modal) return;
            if (typeof applyTranslations === "function") {
                const activeLang = (typeof currentLanguage !== "undefined" && ["cs", "en", "fr"].includes(currentLanguage)) ? currentLanguage : (localStorage.getItem("medstudio_lang") || "cs");
                applyTranslations(activeLang, modal);
            }
            modal.classList.remove("hidden");
            renderQuestionsManagerTable();
        }

        function closeQuestionsManagerModal() {
            const modal = document.getElementById("modalQuestionsManager");
            if (modal) modal.classList.add("hidden");
        }

        function editQuestionById(id) {
            if (isViewerMode()) {
                showGlobalToast(t("toast.viewerRestrictedQuestion", "👁️ Režim pozorovatele: Nemáte oprávnění měnit stav ani obsah zkouškových otázek."), "warning");
                return;
            }
            openPlannerAddQuestionModal(id);
        }

        function moveQuestionUp(idx) {
            if (isViewerMode()) return;
            if (idx <= 0 || idx >= questions.length) return;
            const temp = questions[idx];
            questions[idx] = questions[idx - 1];
            questions[idx - 1] = temp;
            questions.forEach((q, i) => q.q_index = i + 1);
            saveProjectQuestions(false);
            renderQuestionsManagerTable();
        }

        function moveQuestionDown(idx) {
            if (isViewerMode()) return;
            if (idx < 0 || idx >= questions.length - 1) return;
            const temp = questions[idx];
            questions[idx] = questions[idx + 1];
            questions[idx + 1] = temp;
            questions.forEach((q, i) => q.q_index = i + 1);
            saveProjectQuestions(false);
            renderQuestionsManagerTable();
        }

        function editSelectedQuestionFromNotes() {
            const sel = document.getElementById("notesQuestionSelect");
            const val = (sel ? sel.value : "").trim();
            if (!val) {
                openQuestionsManagerModal();
                return;
            }
            const q = questions.find(item => item.title === val || item.id === val);
            if (q) {
                openPlannerAddQuestionModal(q.id);
            } else {
                openQuestionsManagerModal();
            }
        }

        function editSelectedQuestionFromCards() {
            const sel = document.getElementById("cardsQuestionSelect");
            const val = (sel ? sel.value : "").trim();
            if (!val) {
                openQuestionsManagerModal();
                return;
            }
            const q = questions.find(item => item.title === val || item.id === val);
            if (q) {
                openPlannerAddQuestionModal(q.id);
            } else {
                openQuestionsManagerModal();
            }
        }

        function editSelectedQuestionFromTests() {
            const sel = document.getElementById("testsQuestionSelect");
            const val = (sel ? sel.value : "").trim();
            if (!val) {
                openQuestionsManagerModal();
                return;
            }
            const q = questions.find(item => item.title === val || item.id === val);
            if (q) {
                openPlannerAddQuestionModal(q.id);
            } else {
                openQuestionsManagerModal();
            }
        }

        function editSelectedQuestionFromPodcast() {
            const sel = document.getElementById("podcastQuestionSelect");
            const val = (sel ? sel.value : "").trim();
            if (!val) {
                openQuestionsManagerModal();
                return;
            }
            const q = questions.find(item => item.title === val || item.id === val);
            if (q) {
                openPlannerAddQuestionModal(q.id);
            } else {
                openQuestionsManagerModal();
            }
        }

        function editSelectedQuestionFromNewLesson() {
            const sel = document.getElementById("newLessonQuestionSelect");
            const val = (sel ? sel.value : "").trim();
            if (!val) {
                openQuestionsManagerModal();
                return;
            }
            const q = questions.find(item => item.title === val || item.id === val);
            if (q) {
                openPlannerAddQuestionModal(q.id);
            } else {
                openQuestionsManagerModal();
            }
        }

        function onPodcastQuestionSelectChange() {
            const sel = document.getElementById("podcastQuestionSelect");
            const val = (sel ? sel.value : "").trim();
            const badge = document.getElementById("podcastActiveQuestionBadge");
            if (!val) {
                if (badge) badge.textContent = t("common.noneSelected", "Žádná vybraná");
                return;
            }
            const idx = questions.findIndex(q => q.title === val || q.id === val);
            if (idx !== -1) {
                selectQuestion(idx);
                if (badge) badge.textContent = `Otázka ${idx + 1}`;
            }
        }

        function onNewLessonQuestionSelectChange() {
            const sel = document.getElementById("newLessonQuestionSelect");
            const val = (sel ? sel.value : "").trim();
            const titleInput = document.getElementById("newLessonTitle");
            if (val && titleInput) {
                titleInput.value = val;
            }
        }

        // --- PŘÍMÁ EDITACE OTÁZEK V CENTRÁLNÍM SPRÁVCI ---
        function toggleQmInlineEdit() {
            if (isViewerMode()) {
                showGlobalToast(t("toast.viewerRestrictedQuestion", "👁️ Režim pozorovatele: Nemáte oprávnění měnit stav ani obsah zkouškových otázek."), "warning");
                return;
            }
            qmInlineEditMode = !qmInlineEditMode;
            const btn = document.getElementById("btnQmToggleInlineEdit");
            const txt = document.getElementById("qmInlineEditBtnText");
            if (btn) {
                if (qmInlineEditMode) {
                    btn.className = "bg-emerald-800 text-emerald-100 border border-emerald-600 text-xs px-3 py-2 rounded-lg font-bold transition flex items-center gap-1.5 shadow";
                    if (txt) txt.textContent = "Uložit úpravy ✓";
                } else {
                    btn.className = "bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs px-3 py-2 rounded-lg font-semibold transition flex items-center gap-1.5 shadow";
                    if (txt) txt.textContent = "Režim přímé editace";
                    saveProjectQuestions(false);
                }
            }
            renderQuestionsManagerTable();
        }

        function updateQuestionInlineField(qId, field, val) {
            if (isViewerMode()) return;
            const q = questions.find(item => item.id === qId);
            if (!q) return;
            const clean = String(val || "").trim();
            if (field === 'title' && !clean) return;
            q[field] = clean;
            saveProjectQuestions(false);
        }

        function makeQmTitleEditable(event, qId) {
            if (isViewerMode() || qmInlineEditMode) return;
            const el = event.currentTarget;
            if (el.querySelector('input')) return;
            const q = questions.find(item => item.id === qId);
            if (!q) return;

            const currentText = q.title;
            const input = document.createElement('input');
            input.type = 'text';
            input.value = currentText;
            input.className = 'w-full bg-slate-950 text-white font-medium text-xs p-1.5 rounded-lg border border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-400 shadow-inner';
            el.innerHTML = '';
            el.appendChild(input);
            input.focus();
            input.select();

            let committed = false;
            const commit = () => {
                if (committed) return;
                committed = true;
                const newText = input.value.trim();
                if (newText && newText !== currentText) {
                    q.title = newText;
                    saveProjectQuestions(false);
                }
                renderQuestionsManagerTable();
            };

            input.addEventListener('blur', commit);
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    commit();
                } else if (e.key === 'Escape') {
                    committed = true;
                    renderQuestionsManagerTable();
                }
            });
        }

        function renderQuestionsManagerTable() {
            const tbody = document.getElementById("qmTableBody");
            if (!tbody) return;

            const viewer = isViewerMode();
            if (viewer) {
                qmInlineEditMode = false;
            }

            // Ovládací prvky v liště pro režim pozorovatele
            const btnInline = document.getElementById("btnQmToggleInlineEdit");
            if (btnInline) {
                if (viewer) btnInline.classList.add("hidden");
                else btnInline.classList.remove("hidden");
            }
            const btnAi = document.getElementById("btnAiClassifyQuestions");
            if (btnAi) {
                if (viewer) btnAi.classList.add("hidden");
                else btnAi.classList.remove("hidden");
            }
            const btnRecluster = document.getElementById("btnQmRecluster");
            if (btnRecluster) {
                if (viewer) btnRecluster.classList.add("hidden");
                else btnRecluster.classList.remove("hidden");
            }
            const btnAddQ = document.getElementById("btnQmAddQuestion");
            if (btnAddQ) {
                if (viewer) btnAddQ.classList.add("hidden");
                else btnAddQ.classList.remove("hidden");
            }
            const btnImport = document.getElementById("btnQmImport");
            if (btnImport) {
                if (viewer) btnImport.classList.add("hidden");
                else btnImport.classList.remove("hidden");
            }
            const btnClearAll = document.getElementById("btnQmClearAll");
            if (btnClearAll) {
                if (viewer) btnClearAll.classList.add("hidden");
                else btnClearAll.classList.remove("hidden");
            }

            const totalBadge = document.getElementById("qmQuestionsTotalBadge");
            if (totalBadge) totalBadge.textContent = t("qm.questionsCount", "{count} questions", { count: questions.length });

            const globalBadge = document.getElementById("globalQuestionsBadge");
            if (globalBadge) globalBadge.textContent = questions.length;
            const sidebarBadge = document.getElementById("sidebarQuestionsBadge");
            if (sidebarBadge) sidebarBadge.textContent = questions.length;

            const projBadge = document.getElementById("qmCurrentProjectBadge");
            if (projBadge) {
                projBadge.textContent = currentProject ? t("qm.projectBadge", "Projekt: {name}", { name: currentProject }) : t("qm.noProject", "Není vybrán projekt");
            }

            // Naplníme výběr okruhů
            const topicSelect = document.getElementById("qmFilterTopic");
            if (topicSelect) {
                const currentFilter = topicSelect.value;
                const topics = [...new Set(questions.map(q => q.topic || t("common.general", "Všeobecné")))].sort();
                
                let optsHtml = `<option value="">${t("qm.allTopics", "Všechny okruhy")}</option>`;
                topics.forEach(tName => {
                    optsHtml += `<option value="${escapeHtml(tName)}"${currentFilter === tName ? ' selected' : ''}>${escapeHtml(tName)}</option>`;
                });
                topicSelect.innerHTML = optsHtml;
            }

            const searchInput = document.getElementById("qmSearchInput");
            const query = (searchInput ? searchInput.value : "").toLowerCase().trim();
            const filterTopic = topicSelect ? topicSelect.value : "";

            // Filtrování
            const filtered = questions.filter(q => {
                if (filterTopic && (q.topic || t("common.general", "Všeobecné")) !== filterTopic) return false;
                if (query) {
                    const matchTitle = (q.title || "").toLowerCase().includes(query);
                    const matchTopic = (q.topic || "").toLowerCase().includes(query);
                    const matchNumber = (q.number || "").toLowerCase().includes(query);
                    const matchNote = (q.note || "").toLowerCase().includes(query);
                    if (!matchTitle && !matchTopic && !matchNumber && !matchNote) return false;
                }
                return true;
            });

            // Čítač v patičce
            const countInfo = document.getElementById("qmTableCountInfo");
            if (countInfo) {
                countInfo.textContent = t("qm.showingOfTotal", "Zobrazeno {shown} z {total} otázek", { shown: filtered.length, total: questions.length });
            }

            if (!currentProject) {
                tbody.innerHTML = `
                    <tr>
                        <td colspan="7" class="p-8 text-center text-slate-500">
                            <div class="text-3xl mb-2">⚠️</div>
                            <div class="font-bold text-amber-400 text-sm mb-1">${t("qm.noProjectSelected", "Není vybrán žádný projekt")}</div>
                            <div class="text-xs text-slate-500 mb-4">${t("qm.selectProjectHint", "Vyberte projekt v horní liště nebo vytvořte nový pomocí tlačítka ➕.")}</div>
                        </td>
                    </tr>
                `;
                return;
            }

            if (questions.length === 0) {
                tbody.innerHTML = `
                    <tr>
                        <td colspan="7" class="p-8 text-center text-slate-500">
                            <div class="text-3xl mb-2">📋</div>
                            <div class="font-bold text-slate-200 text-sm mb-1">${t("qm.emptyProjectQuestions", "V projektu {name} zatím nejsou žádné otázky", { name: escapeHtml(currentProject) })}</div>
                            <div class="text-xs text-slate-400 mb-4 max-w-md mx-auto">${t("qm.emptyProjectDesc", "Každý projekt má svůj vlastní nezávislý seznam. Otázky můžete nahrát z CSV souboru, textového seznamu, zkopírovat z jiného projektu nebo zadat ručně.")}</div>
                            ${viewer ? `<div class="text-xs text-slate-500 italic">${t("qm.viewerCannotAdd", "V režimu pozorovatele nelze vkládat ani importovat otázky.")}</div>` : `
                            <div class="flex justify-center gap-3">
                                <button onclick="openPlannerAddQuestionModal()" class="bg-emerald-700 hover:bg-emerald-600 text-white text-xs px-3.5 py-2 rounded-lg transition font-semibold shadow flex items-center gap-1.5">
                                    <span>➕</span> ${t("planner.btnAddQuestion", "Přidat otázku ručně")}
                                </button>
                                <button onclick="openPlannerImportModal()" class="bg-indigo-700 hover:bg-indigo-600 text-white text-xs px-3.5 py-2 rounded-lg transition font-semibold shadow flex items-center gap-1.5">
                                    <span>📂</span> ${t("common.import", "Importovat otázky")}
                                </button>
                            </div>
                            `}
                        </td>
                    </tr>
                `;
                return;
            }

            if (filtered.length === 0) {
                tbody.innerHTML = `
                    <tr>
                        <td colspan="7" class="p-6 text-center text-slate-500 italic">
                            ${t("qm.noFilterMatch", "Žádné otázky neodpovídají zadanému filtru nebo hledání.")}
                        </td>
                    </tr>
                `;
                return;
            }

            tbody.innerHTML = "";
            filtered.forEach((q) => {
                const originalIndex = questions.indexOf(q);

                let badge = `<span class="bg-slate-800 text-slate-400 px-2 py-0.5 rounded border border-slate-700 text-[10px]">${t("qm.statusWaiting", "Čeká")}</span>`;
                if (q.status === "Done") badge = `<span class="bg-emerald-950 text-emerald-400 px-2 py-0.5 rounded border border-emerald-800 text-[10px] font-bold">${t("qm.statusAudioOk", "Audio OK")}</span>`;
                else if (q.status === "In Progress") badge = `<span class="bg-amber-950 text-amber-400 px-2 py-0.5 rounded border border-amber-800 text-[10px]">${t("qm.statusTextOk", "Text OK")}</span>`;
                else if (q.status === "Processing") badge = `<span class="bg-blue-950 text-blue-400 px-2 py-0.5 rounded border border-blue-800 text-[10px] animate-pulse">${t("qm.statusProcessing", "Zpracovávám")}</span>`;
                else if (q.status === "Error") badge = `<span class="bg-red-950 text-red-400 px-2 py-0.5 rounded border border-red-800 text-[10px] font-bold">${t("qm.statusError", "Chyba")}</span>`;

                let gradeBadge = "";
                if (q.grade === "A") gradeBadge = `<span class="ml-1 px-1.5 py-0.5 rounded bg-emerald-950 text-emerald-400 border border-emerald-700 font-bold font-mono text-[10px]">A</span>`;
                else if (q.grade === "B") gradeBadge = `<span class="ml-1 px-1.5 py-0.5 rounded bg-amber-950 text-amber-400 border border-amber-700 font-bold font-mono text-[10px]">B</span>`;
                else if (q.grade === "C") gradeBadge = `<span class="ml-1 px-1.5 py-0.5 rounded bg-orange-950 text-orange-400 border border-orange-700 font-bold font-mono text-[10px]">C</span>`;
                else if (q.grade === "D") gradeBadge = `<span class="ml-1 px-1.5 py-0.5 rounded bg-rose-950 text-rose-400 border border-rose-700 font-bold font-mono text-[10px]">D</span>`;

                const noteHtml = q.note ? `<div class="text-[11px] text-slate-400 italic mt-0.5 flex items-center gap-1"><span>📌</span><span>${escapeHtml(q.note)}</span></div>` : "";

                const fallbackTopic = t("common.general", "Všeobecné");
                let topicCellHtml = `
                    <span class="inline-block px-2 py-0.5 rounded text-[11px] font-medium bg-slate-800 text-emerald-300 border border-slate-700">
                        ${escapeHtml(q.topic || fallbackTopic)}
                    </span>
                `;
                let numberCellHtml = `${escapeHtml(q.number || String(originalIndex + 1))}`;
                let titleCellHtml = viewer ? `
                    <div class="font-medium text-slate-200 select-text leading-snug p-1">
                        ${escapeHtml(q.title)}
                    </div>
                    ${noteHtml}
                ` : `
                    <div onclick="makeQmTitleEditable(event, '${q.id}')" class="font-medium text-slate-200 hover:text-emerald-300 cursor-pointer select-text leading-snug p-1 rounded hover:bg-slate-900 border border-transparent hover:border-emerald-500/40 transition" title="${t("qm.clickToEditTitle", "Klikněte pro přímou úpravu textu otázky")}">
                        ${escapeHtml(q.title)}
                    </div>
                    ${noteHtml}
                `;

                if (!viewer && qmInlineEditMode) {
                    topicCellHtml = `
                        <input type="text" value="${escapeHtml(q.topic || fallbackTopic)}" onchange="updateQuestionInlineField('${q.id}', 'topic', this.value)" class="w-full bg-slate-950 text-emerald-300 border border-slate-700 rounded px-2 py-1 text-xs focus:border-emerald-500 focus:outline-none">
                    `;
                    numberCellHtml = `
                        <input type="text" value="${escapeHtml(q.number || String(originalIndex + 1))}" onchange="updateQuestionInlineField('${q.id}', 'number', this.value)" class="w-12 text-center bg-slate-950 text-white font-mono border border-slate-700 rounded px-1 py-1 text-xs focus:border-emerald-500 focus:outline-none">
                    `;
                    titleCellHtml = `
                        <input type="text" value="${escapeHtml(q.title)}" onchange="updateQuestionInlineField('${q.id}', 'title', this.value)" class="w-full bg-slate-950 text-white font-medium border border-emerald-500/80 rounded px-2 py-1 text-xs focus:ring-1 focus:ring-emerald-400 focus:outline-none shadow-inner">
                        ${noteHtml}
                    `;
                }

                const orderCellHtml = viewer ? `
                    <span class="text-slate-600 font-mono text-xs">-</span>
                ` : `
                    <div class="inline-flex items-center gap-1">
                        <button onclick="moveQuestionUp(${originalIndex})" ${originalIndex === 0 ? 'disabled class="opacity-20 cursor-not-allowed"' : 'class="text-slate-400 hover:text-white"'} title="${t("qm.moveUp", "Posunout nahoru")}">⬆️</button>
                        <button onclick="moveQuestionDown(${originalIndex})" ${originalIndex === questions.length - 1 ? 'disabled class="opacity-20 cursor-not-allowed"' : 'class="text-slate-400 hover:text-white"'} title="${t("qm.moveDown", "Posunout dolů")}">⬇️</button>
                    </div>
                `;

                const actionsCellHtml = viewer ? `
                    <span class="text-[11px] text-slate-500 italic">${t("common.readOnly", "Pouze ke čtení")}</span>
                ` : `
                    <div class="inline-flex items-center gap-1">
                        <button onclick="editQuestionById('${q.id}')" class="p-1.5 rounded hover:bg-slate-800 text-slate-400 hover:text-emerald-400 transition" title="${t("qm.editInDialog", "Upravit otázku v dialogovém okně")}">✏️</button>
                        <button onclick="removeQuestion(${originalIndex})" class="p-1.5 rounded hover:bg-slate-800 text-slate-500 hover:text-red-400 transition" title="${t("qm.deleteQuestion", "Smazat otázku")}">🗑️</button>
                    </div>
                `;

                const tr = document.createElement("tr");
                tr.className = "hover:bg-slate-900/80 transition border-b border-slate-800/60";
                tr.innerHTML = `
                    <td class="p-2.5 text-center text-slate-500 font-mono">${originalIndex + 1}</td>
                    <td class="p-2.5 text-center">${orderCellHtml}</td>
                    <td class="p-2.5">${topicCellHtml}</td>
                    <td class="p-2.5 text-center font-mono font-bold text-slate-300">${numberCellHtml}</td>
                    <td class="p-2.5">${titleCellHtml}</td>
                    <td class="p-2.5 text-center whitespace-nowrap">${badge}${gradeBadge}</td>
                    <td class="p-2.5 text-center">${actionsCellHtml}</td>
                `;
                tbody.appendChild(tr);
            });
        }

        // =========================================================================
        // PROPOJENÍ S TABEM „POZNÁMKY Z MATERIÁLŮ“ (CROSS-FEATURE INTEGRACE)
        // =========================================================================
        function explainExamQuestion(questionTitle) {
            if (!questionTitle || !questionTitle.trim()) {
                alert("Chybí název otázky.");
                return;
            }

            const cleanTitle = questionTitle.trim();

            // 1. Automaticky sestav strukturovaný systémový prompt se zněním otázky
            const finalPrompt = DEFAULT_NOTES_PROMPT.replace(/{QUESTION}/g, cleanTitle);

            // 2. Přepnout uživatele do záložky „Poznámky z materiálů“
            switchTab('notes');
            setNotesMode('single');

            // 3. Do vstupního pole pro generování vložit připravený prompt a znění otázky
            const customInput = document.getElementById("notesCustomQuestionInput");
            if (customInput) customInput.value = cleanTitle;

            const qSelect = document.getElementById("notesQuestionSelect");
            if (qSelect) qSelect.value = "";

            const promptInput = document.getElementById("notesPromptInput");
            if (promptInput) {
                promptInput.value = finalPrompt;
                // Rozbalit detaily promptu pro přehled uživatele
                const details = promptInput.closest("details");
                if (details) details.open = true;
                updateNotesPromptStatusBadge();
            }

            appendConsoleLog(`💡 Spouštím generování expertního vysvětlení pro: "${cleanTitle.substring(0, 45)}..."`);

            // 4. Automatické spuštění generování nad materiály
            runNotesGeneration();
        }

        // --- MATERIÁLY (PODKLADY) ---
        async function loadFileList() {
            if (!currentProject) return;
            const res = await fetch(`/api/files?project=${currentProject}`);
            const data = await res.json();
            
            const homeFileList = document.getElementById("homeFileList");
            if (homeFileList) {
                homeFileList.innerHTML = data.files.length === 0 ? `<li class="text-slate-500 italic text-center py-2">Zatím žádné podklady. Nahrajte PDF/DOCX/PPTX.</li>` : "";
                data.files.forEach(f => {
                    const ext = f.split('.').pop().toLowerCase();
                    let icon = "📄";
                    let extBadge = "PDF";
                    let badgeColor = "bg-red-950/70 text-red-300 border-red-800/60";
                    if (ext === "pptx" || ext === "ppt") {
                        icon = "📊";
                        extBadge = "PPTX";
                        badgeColor = "bg-amber-950/70 text-amber-300 border-amber-800/60";
                    } else if (ext === "docx" || ext === "doc") {
                        icon = "📝";
                        extBadge = "DOCX";
                        badgeColor = "bg-blue-950/70 text-blue-300 border-blue-800/60";
                    } else if (ext === "txt" || ext === "md") {
                        icon = "📋";
                        extBadge = ext.toUpperCase();
                        badgeColor = "bg-emerald-950/70 text-emerald-300 border-emerald-800/60";
                    } else if (["png", "jpg", "jpeg", "webp"].includes(ext)) {
                        icon = "🖼️";
                        extBadge = ext.toUpperCase();
                        badgeColor = "bg-purple-950/70 text-purple-300 border-purple-800/60";
                    }

                    const safeNameAttr = f.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
                    const safeNameArg = encodeURIComponent(f);
                    const safeProjArg = encodeURIComponent(currentProject);
                    
                    const li = document.createElement("li");
                    li.className = "flex justify-between items-center bg-slate-900/90 hover:bg-slate-850 p-2 rounded-lg border border-slate-700/80 hover:border-slate-600 transition group";
                    li.innerHTML = `
                        <div class="flex items-center gap-2 truncate pr-2 min-w-0 flex-1 cursor-pointer" onclick="openDocumentViewer(decodeURIComponent('${safeNameArg}'), '', currentProject)" title="Klikněte pro zobrazení náhledu souboru">
                            <span class="text-sm shrink-0">${icon}</span>
                            <span class="text-[9px] font-mono px-1 py-0.5 rounded border uppercase shrink-0 ${badgeColor}">${extBadge}</span>
                            <span class="truncate text-slate-300 group-hover:text-emerald-300 text-xs font-medium transition">${safeNameAttr}</span>
                        </div>
                        <div class="flex items-center gap-1 shrink-0">
                            <button onclick="openDocumentViewer(decodeURIComponent('${safeNameArg}'), '', currentProject)" class="text-slate-400 hover:text-emerald-400 p-1.5 rounded hover:bg-slate-800 transition outline-none" title="Prohlédnout materiál">
                                👁️
                            </button>
                            <a href="/api/files/${safeProjArg}/${safeNameArg}/view" target="_blank" rel="noopener noreferrer" class="text-slate-400 hover:text-sky-400 p-1.5 rounded hover:bg-slate-800 transition outline-none inline-flex items-center" title="Otevřít v nové záložce">
                                ↗
                            </a>
                            <button onclick="deleteFile(decodeURIComponent('${safeNameArg}'))" class="text-red-400/60 hover:text-red-400 font-bold p-1.5 rounded hover:bg-slate-800 transition outline-none" title="Smazat soubor">
                                ✕
                            </button>
                        </div>
                    `;
                    homeFileList.appendChild(li);
                });

                const homeSearch = document.getElementById("homeFilesSearchInput");
                if (homeSearch && homeSearch.value.trim()) {
                    filterHomeFilesList(homeSearch.value);
                }
            }

            const sideFilesBadge = document.getElementById("sidebarFilesBadge");
            if (sideFilesBadge && data && data.files) {
                sideFilesBadge.textContent = data.files.length;
                sideFilesBadge.classList.toggle("hidden", data.files.length === 0);
            }

            updateDashboardStats();
        }

        async function reindexCurrentProject() {
            if (!currentProject) {
                alert(t("common.selectProject", "Nejprve vyberte projekt v horní liště."));
                return;
            }
            if (!confirm(`Opravdu chcete přeindexovat všechny materiály v projektu '${currentProject}' novým sémantickým chunkingem a analýzou čísel stran?`)) {
                return;
            }
            try {
                const res = await fetch(`/api/projects/${encodeURIComponent(currentProject)}/reindex`, { method: "POST" });
                const data = await res.json();
                if (res.ok) {
                    alert(`✅ Spuštěno hloubkové přeindexování ${data.files_count} souborů v projektu '${data.project}'. Průběh můžete sledovat v Live Konzoli.`);
                } else {
                    alert("Chyba při přeindexování: " + (data.detail || "Neznámá chyba"));
                }
            } catch (err) {
                alert("Nelze se spojit se serverem: " + err.message);
            }
        }

        async function uploadDocsFromHome() {
            const input = document.getElementById("homeDocsUploadInput");
            if(!input.files.length || !currentProject) {
                if(!currentProject) alert("Nejprve vyberte nebo založte projekt.");
                return;
            }
            
            const labelText = document.getElementById("homeUploadLabelText");
            const originalText = labelText.innerText;
            labelText.innerText = "⏳ Nahrávám a vektorizuji...";
            
            const formData = new FormData();
            for(let i = 0; i < input.files.length; i++) {
                formData.append("files", sanitizeFile(input.files[i]));
            }
            formData.append("project", currentProject);
            
            try {
                await fetch("/api/files/upload", { method: "POST", body: formData });
            } catch(e) {
                alert("Chyba při nahrávání materiálů.");
            }
            
            input.value = "";
            labelText.innerText = originalText;
            await loadFileList();
        }

        async function deleteFile(filename) {
            if (!currentProject) return;
            if (confirm(`Opravdu smazat ${filename} a jeho vektory z databáze?`)) {
                await fetch(`/api/files/${filename}?project=${currentProject}`, { method: "DELETE" });
                await loadFileList();
            }
        }

        // --- OTÁZKY (CSV & UI) ---
        async function uploadCSVFile() {
            const input = document.getElementById("csvFileInput");
            if(!input.files.length) return;
            
            const formData = new FormData();
            formData.append("file", sanitizeFile(input.files[0]));
            
            const res = await fetch("/api/files/upload-csv", { method: "POST", body: formData });
            const data = await res.json();
            
            if(res.ok) {
                const newQ = data.questions.map((q, i) => normalizeQuestion(q, questions.length + i + 1)).filter(Boolean);
                questions = [...questions, ...newQ];
                questions.forEach((q, i) => q.q_index = i + 1);
                examPlanner.questions = questions;
                saveProjectQuestions(false);
                appendConsoleLog(`📋 Naimportováno ${newQ.length} otázek z CSV do projektu a plánovače.`);
            }
            input.value = "";
        }

        function addManualQuestion() {
            if (isViewerMode()) {
                showGlobalToast(t("toast.viewerRestrictedQuestion", "👁️ Režim pozorovatele: Nemáte oprávnění měnit stav ani obsah zkouškových otázek."), "warning");
                return;
            }
            const q = prompt("Zadejte znění zkouškové otázky (např. 'Lístek 1: a) ...' nebo 'Kardiologie;1;Arteriální hypertenze'):");
            if(q && q.trim()) {
                const item = normalizeQuestion(q.trim(), questions.length + 1);
                questions.push(item);
                examPlanner.questions = questions;
                saveProjectQuestions(false);
            }
        }

        function updateQuestionTitle(idx) {
            if (isViewerMode()) {
                showGlobalToast(t("toast.viewerRestrictedQuestion", "👁️ Režim pozorovatele: Nemáte oprávnění měnit stav ani obsah zkouškových otázek."), "warning");
                return;
            }
            const newTitle = prompt("Upravit znění otázky:", questions[idx].title);
            if(newTitle && newTitle.trim()) {
                questions[idx].title = newTitle.trim();
                if (!questions[idx].topic || questions[idx].topic === "Všeobecné") {
                    const parsed = parseQuestionString(questions[idx].title, idx + 1);
                    if (parsed && parsed.topic !== "Všeobecné") questions[idx].topic = parsed.topic;
                    if (parsed && parsed.number) questions[idx].number = parsed.number;
                }
                saveProjectQuestions(false);
                if(selectedQuestionIndex === idx) {
                    document.getElementById("activeQuestionTitle").textContent = questions[idx].title;
                }
            }
        }

        function removeQuestion(idx) {
            if (isViewerMode()) {
                showGlobalToast(t("toast.viewerRestrictedQuestion", "👁️ Režim pozorovatele: Nemáte oprávnění měnit stav ani obsah zkouškových otázek."), "warning");
                return;
            }
            questions.splice(idx, 1);
            questions.forEach((q, i) => q.q_index = i + 1);
            examPlanner.questions = questions;
            if(selectedQuestionIndex === idx) resetWorkspace();
            else if(selectedQuestionIndex > idx) selectedQuestionIndex--;
            saveProjectQuestions(false);
        }

        function clearQuestions() {
            if (isViewerMode()) {
                showGlobalToast(t("toast.viewerRestrictedQuestion", "👁️ Režim pozorovatele: Nemáte oprávnění měnit stav ani obsah zkouškových otázek."), "warning");
                return;
            }
            if(confirm(t("planner.confirmClearAllQuestions", "Vymazat celý seznam otázek z projektu (včetně plánovače zkoušky)?"))) {
                questions = []; 
                examPlanner.questions = [];
                resetWorkspace();
                saveProjectQuestions(false); 
            }
        }

        function toggleAllQuestions(isChecked) {
            questions.forEach(q => q.selected = isChecked);
            renderQuestionsTable();
        }

        function toggleQuestion(idx, isChecked) {
            questions[idx].selected = isChecked;
            document.getElementById("selectAllCheckbox").checked = questions.length > 0 && questions.every(q => q.selected);
        }

        function renderQuestionsTable() {
            const tbody = document.getElementById("questionsTableBody");
            if(questions.length === 0) {
                tbody.innerHTML = `<tr><td colspan="5" class="p-4 text-center text-slate-500 italic">Zatím žádné otázky v projektu. Nahrajte CSV nebo je přidejte ručně.</td></tr>`;
                return;
            }

            const viewer = isViewerMode();
            tbody.innerHTML = "";
            questions.forEach((q, idx) => {
                if (!q.q_index) q.q_index = idx + 1;

                const tr = document.createElement("tr");
                tr.className = `border-b border-slate-800/80 hover:bg-slate-800 transition ${selectedQuestionIndex === idx ? 'bg-slate-700/80' : ''}`;
                
                let badge = `<span class="text-slate-500 text-[10px] md:text-xs">Čeká</span>`;
                if(q.status === "Done") badge = `<span class="bg-emerald-950 text-emerald-400 px-2 py-0.5 rounded border border-emerald-800 text-[10px] md:text-xs">Audio OK</span>`;
                if(q.status === "In Progress") badge = `<span class="bg-amber-950 text-amber-400 px-2 py-0.5 rounded border border-amber-800 text-[10px] md:text-xs">Text OK</span>`;
                if(q.status === "Processing") badge = `<span class="bg-blue-950 text-blue-400 px-2 py-0.5 rounded border border-blue-800 text-[10px] md:text-xs animate-pulse">Zpracovávám</span>`;
                if(q.status === "Error") badge = `<span class="bg-red-950 text-red-400 px-2 py-0.5 rounded border border-red-800 text-[10px] md:text-xs font-bold">Chyba</span>`;

                const topicBadge = (q.topic && q.topic !== "Všeobecné")
                    ? `<span class="inline-block px-1.5 py-0.2 rounded text-[10px] bg-slate-800 text-slate-400 border border-slate-700 mr-1.5 shrink-0">${escapeHtml(q.topic)}</span>`
                    : "";

                const editBtnHtml = viewer ? "" : `<button onclick="event.stopPropagation(); editQuestionById('${q.id}')" class="text-slate-500 hover:text-emerald-400 flex-shrink-0 transition text-xs md:text-sm px-1 outline-none" title="Upravit otázku (okruh, číslo, znění, poznámka)">✏️</button>`;
                const deleteBtnHtml = viewer ? `<span class="text-slate-600">-</span>` : `<button onclick="removeQuestion(${idx})" class="text-red-500 hover:text-red-400 font-bold px-1 text-sm outline-none" title="Smazat otázku">✕</button>`;

                tr.innerHTML = `
                    <td class="p-2 text-center">
                        <input type="checkbox" ${q.selected ? 'checked' : ''} onchange="toggleQuestion(${idx}, this.checked)" class="accent-emerald-500 cursor-pointer w-4 h-4">
                    </td>
                    <td class="p-2 text-center text-slate-400 font-mono text-xs md:text-sm" title="Vnitřní ID: ${q.q_index}">${idx + 1}</td>
                    <td class="p-2">
                        <div class="flex items-center justify-between gap-2">
                            <span class="text-slate-200 cursor-pointer hover:text-emerald-300 truncate flex-1 min-w-0 font-medium" onclick="selectQuestion(${idx})" title="${escapeHtml(q.title)}">
                                ${topicBadge}${escapeHtml(q.title)}
                            </span>
                            ${editBtnHtml}
                        </div>
                    </td>
                    <td class="p-2 text-center">${badge}</td>
                    <td class="p-2 text-center">
                        ${deleteBtnHtml}
                    </td>
                `;
                tbody.appendChild(tr);
            });

            const qSearchVal = document.getElementById("podcastQuestionsSearchInput")?.value;
            if (qSearchVal) {
                filterPodcastQuestionsTable(qSearchVal);
            }
        }

        function selectQuestion(idx) {
            selectedQuestionIndex = idx;
            renderQuestionsTable();
            document.getElementById("activeQuestionTitle").textContent = questions[idx].title;
            const pSel = document.getElementById("podcastQuestionSelect");
            if (pSel) pSel.value = questions[idx].title;
            const pBadge = document.getElementById("podcastActiveQuestionBadge");
            if (pBadge) pBadge.textContent = `Otázka ${idx + 1}`;

            document.getElementById("btnGenScript").disabled = false;
            document.getElementById("resultScriptTextarea").value = "";
            document.getElementById("contextTextarea").value = "";
            document.getElementById("charCount").textContent = "0";
            document.getElementById("btnGenAudio").disabled = true;
            document.getElementById("audioOutputBox").classList.add("hidden");
            document.getElementById("audioOutputBox").classList.remove("flex");
        }

        function resetWorkspace() {
            selectedQuestionIndex = null;
            document.getElementById("activeQuestionTitle").textContent = t("planner.selectQuestionPrompt", "Vyberte otázku z tabulky ↑");
            const pSel = document.getElementById("podcastQuestionSelect");
            if (pSel) pSel.value = "";
            const pBadge = document.getElementById("podcastActiveQuestionBadge");
            if (pBadge) pBadge.textContent = t("common.noneSelected", "Žádná vybraná");

            document.getElementById("btnGenScript").disabled = true;
            document.getElementById("btnGenAudio").disabled = true;
            document.getElementById("resultScriptTextarea").value = "";
            document.getElementById("contextTextarea").value = "";
            document.getElementById("charCount").textContent = "0";
            document.getElementById("audioOutputBox").classList.add("hidden");
            document.getElementById("audioOutputBox").classList.remove("flex");
        }

        // --- MODEL HELPERS ---
        function onModelSelectChange(selectId, customInputId) {
            const sel = document.getElementById(selectId);
            const customInput = document.getElementById(customInputId);
            if (!sel || !customInput) return;
            if (sel.value === "custom") {
                customInput.classList.remove("hidden");
                customInput.focus();
            } else {
                customInput.classList.add("hidden");
            }
        }

        function getSelectedModel(selectId, customInputId) {
            const sel = document.getElementById(selectId);
            if (!sel) return "gemini-3.6-flash";
            if (sel.value === "custom") {
                const customVal = (document.getElementById(customInputId)?.value || "").trim();
                return customVal || "gemini-3.6-flash";
            }
            return sel.value;
        }

        function syncQuestionsDropdowns() {
            const notesSelect = document.getElementById("notesQuestionSelect");
            const cardsSelect = document.getElementById("cardsQuestionSelect");
            const testsSelect = document.getElementById("testsQuestionSelect");
            const podcastSelect = document.getElementById("podcastQuestionSelect");
            const newLessonSelect = document.getElementById("newLessonQuestionSelect");
            const pomodoroSelect = document.getElementById("pomodoroQuestionSelect");

            // 1. Aktualizace aktivní vybrané otázky v Podcast Studiu (pokud je vybrána)
            if (selectedQuestionIndex !== null && questions[selectedQuestionIndex]) {
                const activeQ = questions[selectedQuestionIndex];
                const activeTitleEl = document.getElementById("activeQuestionTitle");
                if (activeTitleEl) activeTitleEl.textContent = activeQ.title;
                const activeBadgeEl = document.getElementById("podcastActiveQuestionBadge");
                if (activeBadgeEl) activeBadgeEl.textContent = `Otázka ${selectedQuestionIndex + 1}`;
            }

            // 2. Naplnění všech výběrových polí napříč aplikací
            [notesSelect, cardsSelect, testsSelect, podcastSelect, newLessonSelect, pomodoroSelect].forEach(select => {
                if (!select) return;
                const currentVal = select.value;
                select.innerHTML = `<option value="">${t("planner.selectQuestionDropdown", "-- Vyberte ze seznamu otázek --")}</option>`;
                questions.forEach((q, idx) => {
                    const opt = document.createElement("option");
                    opt.value = q.title;
                    const topicPrefix = (q.topic && q.topic !== "Všeobecné") ? `[${q.topic}] ` : "";
                    opt.textContent = `${idx + 1}. ${topicPrefix}${q.title}`;
                    select.appendChild(opt);
                });
                if (currentVal && questions.some(q => q.title === currentVal)) {
                    select.value = currentVal;
                } else if (select === podcastSelect && selectedQuestionIndex !== null && questions[selectedQuestionIndex]) {
                    select.value = questions[selectedQuestionIndex].title;
                }
            });

            renderNotesBatchTable();
            renderCardsBatchTable();
            if (typeof renderTestsBatchTable === "function") {
                renderTestsBatchTable();
            }
            if (typeof renderTestsCategoriesList === "function") {
                renderTestsCategoriesList();
            }
        }

        // =========================================================================
        // LOGIKA PRO ZÁLOŽKU 3: STUDIJNÍ POZNÁMKY (NOTES)
        // =========================================================================
        let currentNotesMode = 'single'; // 'single' | 'batch'

        function setNotesMode(mode) {
            currentNotesMode = mode;
            const btnSingle = document.getElementById("btnNotesModeSingle");
            const btnBatch = document.getElementById("btnNotesModeBatch");
            const singleBox = document.getElementById("notesSingleContainer");
            const batchBox = document.getElementById("notesBatchContainer");
            const singleBtn = document.getElementById("btnGenerateNotes");
            const batchBtns = document.getElementById("notesBatchActionButtons");

            if (mode === 'single') {
                if (btnSingle) btnSingle.className = "flex-1 py-1.5 rounded-md bg-sky-900/70 text-sky-200 transition text-center shadow-sm";
                if (btnBatch) btnBatch.className = "flex-1 py-1.5 rounded-md text-slate-400 hover:text-slate-200 transition text-center";
                if (singleBox) singleBox.classList.remove("hidden");
                if (batchBox) batchBox.classList.add("hidden");
                if (singleBtn) singleBtn.classList.remove("hidden");
                if (batchBtns) batchBtns.classList.add("hidden");
            } else {
                if (btnBatch) btnBatch.className = "flex-1 py-1.5 rounded-md bg-sky-900/70 text-sky-200 transition text-center shadow-sm";
                if (btnSingle) btnSingle.className = "flex-1 py-1.5 rounded-md text-slate-400 hover:text-slate-200 transition text-center";
                if (singleBox) singleBox.classList.add("hidden");
                if (batchBox) batchBox.classList.remove("hidden");
                if (singleBtn) singleBtn.classList.add("hidden");
                if (batchBtns) batchBtns.classList.remove("hidden");
                renderNotesBatchTable();
            }
        }

        function renderNotesBatchTable() {
            const tbody = document.getElementById("notesBatchTableBody");
            const countLabel = document.getElementById("notesBatchSelectedCount");
            if (!tbody) return;

            if (!questions || questions.length === 0) {
                tbody.innerHTML = `<tr><td class="p-3 text-center text-slate-500 italic text-xs">V projektu zatím nejsou žádné otázky.</td></tr>`;
                if (countLabel) countLabel.textContent = "0 vybráno";
                return;
            }

            let selectedCount = 0;
            tbody.innerHTML = "";
            questions.forEach((q, idx) => {
                if (q.notesSelected === undefined) q.notesSelected = true;
                if (q.notesSelected) selectedCount++;

                const tr = document.createElement("tr");
                tr.className = "border-b border-slate-800 hover:bg-slate-850 transition";

                let badge = `<span class="text-slate-500 text-[10px]">Čeká</span>`;
                if (q.notesStatus === "Done") badge = `<span class="bg-emerald-950 text-emerald-400 px-1.5 py-0.5 rounded border border-emerald-800 text-[10px] font-bold">Text OK</span>`;
                else if (q.notesStatus === "Processing") badge = `<span class="bg-sky-950 text-sky-400 px-1.5 py-0.5 rounded border border-sky-800 text-[10px] animate-pulse font-bold">Generuji</span>`;
                else if (q.notesStatus === "Error") badge = `<span class="bg-red-950 text-red-400 px-1.5 py-0.5 rounded border border-red-800 text-[10px] font-bold">Chyba</span>`;

                tr.innerHTML = `
                    <td class="p-2 text-center w-8">
                        <input type="checkbox" ${q.notesSelected ? 'checked' : ''} onchange="toggleNotesQuestion(${idx}, this.checked)" class="accent-sky-500 cursor-pointer w-3.5 h-3.5">
                    </td>
                    <td class="p-2 text-slate-200 text-xs font-medium truncate max-w-[200px]" title="${q.title}">
                        <span class="text-slate-400 font-mono text-[10px] mr-1">${idx + 1}.</span>${q.title}
                    </td>
                    <td class="p-2 text-center w-20">${badge}</td>
                `;
                tbody.appendChild(tr);
            });

            if (countLabel) countLabel.textContent = `${selectedCount} vybráno`;

            const notesBatchVal = document.getElementById("notesBatchFilterInput")?.value;
            if (notesBatchVal) {
                filterNotesBatchTable(notesBatchVal);
            }
        }

        function toggleNotesQuestion(idx, isChecked) {
            if (questions[idx]) {
                questions[idx].notesSelected = isChecked;
                renderNotesBatchTable();
            }
        }

        function selectAllNotesQuestions(selectAll) {
            questions.forEach(q => q.notesSelected = selectAll);
            renderNotesBatchTable();
        }

        function setNotesBatchControls(isRunning) {
            const btnSel = document.getElementById("btnNotesBatchSelected");
            const btnMiss = document.getElementById("btnNotesBatchMissing");
            const btnAll = document.getElementById("btnNotesBatchAll");
            const progressBox = document.getElementById("notesBatchProgressBox");
            if (btnSel) btnSel.disabled = isRunning;
            if (btnMiss) btnMiss.disabled = isRunning;
            if (btnAll) btnAll.disabled = isRunning;
            if (progressBox && isRunning) {
                progressBox.classList.remove("hidden");
            }
        }

        function updateNotesQuestionsStatus(questionIndexes, status) {
            const targetIndexes = new Set(questionIndexes || []);
            if (targetIndexes.size === 0) return;
            questions.forEach(q => {
                if (targetIndexes.has(q.q_index)) {
                    q.notesStatus = status;
                }
            });
            renderNotesBatchTable();
        }

        function updateNotesBatchProgress(completed, total, statusText, isDone = false) {
            const box = document.getElementById("notesBatchProgressBox");
            const bar = document.getElementById("notesBatchProgressBar");
            const label = document.getElementById("notesBatchProgressStatus");
            const pct = document.getElementById("notesBatchProgressPercent");
            if (!box || !bar) return;

            box.classList.remove("hidden");
            const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
            bar.style.width = `${percent}%`;
            if (pct) pct.textContent = `${percent}%`;
            if (label) label.textContent = statusText || `Zpracováno ${completed} / ${total}`;

            if (isDone) {
                setTimeout(() => {
                    if (!activeBatch || activeBatch.mode !== "notes") {
                        box.classList.add("hidden");
                    }
                }, 5000);
            }
        }

        async function runNotesBatchProcessing(mode) {
            if (activeBatch) {
                alert(t("notes.batchAlreadyRunning", "Dávkové zpracování již běží. Vyčkejte na dokončení nebo použijte Storno."));
                return;
            }
            if (!currentProject) {
                alert(t("common.selectProject", "Nejprve vyberte projekt."));
                return;
            }

            let target;
            if (mode === 'all') {
                target = questions.slice();
            } else if (mode === 'missing') {
                target = questions.filter(q => q.notesStatus !== 'Done');
                if (target.length === 0) {
                    alert(t("notes.allQuestionsHaveNotes", "Všechny otázky již mají vygenerovaný studijní text! Žádné nehotové nezbývají."));
                    return;
                }
            } else {
                target = questions.filter(q => q.notesSelected);
            }

            if (target.length === 0) {
                alert(t("notes.noQuestionsSelectedBatch", "Nebyly vybrány žádné otázky pro dávku studijních textů."));
                return;
            }

            target.forEach(q => q.notesStatus = "Processing");
            renderNotesBatchTable();
            setNotesBatchControls(true);
            updateNotesBatchProgress(0, target.length, `Spouštím dávku pro ${target.length} otázek...`);

            const modelName = getSelectedModel("notesModelSelect", "notesModelCustomInput");
            const isOvernight = document.getElementById("notesOvernightMode")?.checked ?? true;

            try {
                const res = await fetch("/api/process-notes-batch", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        questions: target.map(q => ({ title: q.title, q_index: q.q_index })),
                        prompt: document.getElementById("notesPromptInput").value,
                        project: currentProject,
                        gemini_model: modelName,
                        overnight_mode: isOvernight
                    })
                });
                const data = await res.json();
                if (!res.ok) {
                    throw new Error(data.detail || "Dávku textů se nepodařilo spustit.");
                }

                activeBatch = {
                    batchId: data.batch_id,
                    project: currentProject,
                    mode: "notes",
                    questionIndexes: target.map(q => q.q_index),
                    total: target.length,
                    completed: 0
                };
                appendConsoleLog(`🚀 Dávka studijních textů pro ${target.length} otázek spuštěna (noční režim: ${isOvernight ? 'zapnut' : 'vypnut'}).`);
            } catch (e) {
                target.forEach(q => q.notesStatus = "Ready");
                renderNotesBatchTable();
                setNotesBatchControls(false);
                alert("Chyba spuštění dávky: " + e.message);
            }
        }

        function updateNotesPromptStatusBadge() {
            const badge = document.getElementById("notesCustomPromptBadge");
            const npInput = document.getElementById("notesPromptInput");
            const btnRevert = document.getElementById("btnRevertSavedNotesPrompt");
            if (!badge || !npInput) return;

            const saved = localStorage.getItem("aiNotesPrompt");
            const current = npInput.value;

            if (saved !== null) {
                if (current !== saved) {
                    badge.classList.remove("hidden");
                    badge.textContent = "Neuložené změny";
                    badge.className = "text-[9px] bg-amber-950/80 text-amber-300 border border-amber-800/80 px-1.5 py-0.5 rounded font-medium";
                    if (btnRevert) btnRevert.classList.remove("hidden");
                } else {
                    badge.classList.remove("hidden");
                    badge.textContent = "Uložený vlastní";
                    badge.className = "text-[9px] bg-sky-950 text-sky-300 border border-sky-800/80 px-1.5 py-0.5 rounded font-medium";
                    if (btnRevert) btnRevert.classList.add("hidden");
                }
            } else {
                if (current !== DEFAULT_NOTES_PROMPT) {
                    badge.classList.remove("hidden");
                    badge.textContent = "Neuložené změny";
                    badge.className = "text-[9px] bg-amber-950/80 text-amber-300 border border-amber-800/80 px-1.5 py-0.5 rounded font-medium";
                    if (btnRevert) btnRevert.classList.add("hidden");
                } else {
                    badge.classList.add("hidden");
                    if (btnRevert) btnRevert.classList.add("hidden");
                }
            }
        }

        function onNotesPromptInputChanged() {
            updateNotesPromptStatusBadge();
        }

        let notesFeedbackTimeout = null;
        function showNotesPromptFeedback(text, isSuccess = true) {
            const feedback = document.getElementById("notesPromptSavedFeedback");
            const btn = document.getElementById("btnSaveNotesPrompt");
            if (!feedback) return;
            feedback.innerHTML = isSuccess ? `<span>✓</span> ${text}` : `<span>ℹ️</span> ${text}`;
            feedback.className = `text-[11px] ${isSuccess ? 'text-emerald-400' : 'text-sky-300'} font-medium transition-opacity duration-300 opacity-100 flex items-center gap-1`;

            if (btn && isSuccess) {
                btn.classList.add("bg-emerald-600", "hover:bg-emerald-500");
                btn.classList.remove("bg-sky-600", "hover:bg-sky-500");
                setTimeout(() => {
                    btn.classList.remove("bg-emerald-600", "hover:bg-emerald-500");
                    btn.classList.add("bg-sky-600", "hover:bg-sky-500");
                }, 1500);
            }

            if (notesFeedbackTimeout) clearTimeout(notesFeedbackTimeout);
            notesFeedbackTimeout = setTimeout(() => {
                feedback.classList.remove("opacity-100");
                feedback.classList.add("opacity-0");
            }, 3000);
        }

        function saveNotesPrompt() {
            const npInput = document.getElementById("notesPromptInput");
            if (!npInput) return;
            const val = npInput.value.trim();
            if (!val) {
                alert(t("notes.promptCannotBeEmpty", "Prompt nesmí být prázdný."));
                return;
            }
            localStorage.setItem("aiNotesPrompt", npInput.value);
            updateNotesPromptStatusBadge();
            showNotesPromptFeedback("Prompt úspěšně uložen!", true);
            appendConsoleLog("💾 Upravený prompt pro studijní texty byl úspěšně uložen do paměti prohlížeče.");
        }

        function revertToSavedNotesPrompt() {
            const saved = localStorage.getItem("aiNotesPrompt");
            const npInput = document.getElementById("notesPromptInput");
            if (saved !== null && npInput) {
                npInput.value = saved;
                updateNotesPromptStatusBadge();
                showNotesPromptFeedback("Vrácen uložený prompt", false);
            }
        }

        function resetNotesPromptToDefault() {
            const hasSaved = localStorage.getItem("aiNotesPrompt") !== null;
            if (hasSaved) {
                if (!confirm(t("notes.confirmResetPrompt", "Opravdu si přejete smazat uložený vlastní prompt a vrátit původní výchozí medicínský prompt?"))) {
                    return;
                }
                localStorage.removeItem("aiNotesPrompt");
            }
            const npInput = document.getElementById("notesPromptInput");
            if (npInput) npInput.value = DEFAULT_NOTES_PROMPT;
            updateNotesPromptStatusBadge();
            showNotesPromptFeedback("Výchozí prompt obnoven", false);
            appendConsoleLog("🔄 Výchozí medicínský prompt pro studijní texty byl obnoven.");
        }

        function initNotesAndCardsPrompts() {
            const npInput = document.getElementById("notesPromptInput");
            if (npInput) {
                const savedNotesPrompt = localStorage.getItem("aiNotesPrompt");
                if (savedNotesPrompt !== null && savedNotesPrompt.trim()) {
                    npInput.value = savedNotesPrompt;
                } else {
                    npInput.value = DEFAULT_NOTES_PROMPT;
                }
            }

            initCardsPrompt();
            updateNotesPromptStatusBadge();
        }

        function initCardsPrompt() {
            const cpInput = document.getElementById("cardsPromptInput");
            const presetSelect = document.getElementById("cardsPromptPresetSelect");
            if (!cpInput) return;

            const savedPreset = localStorage.getItem("aiCardsPromptPreset") || "standard";
            if (presetSelect) presetSelect.value = savedPreset;

            const savedCustom = localStorage.getItem("aiCardsCustomPrompt_" + savedPreset);
            if (savedCustom !== null && savedCustom.trim()) {
                cpInput.value = savedCustom;
            } else {
                cpInput.value = defaultCardsPrompts[savedPreset] || DEFAULT_CARDS_PROMPT;
            }
            updateCardsPromptBadge();
        }

        function onCardsPromptPresetChange() {
            const presetSelect = document.getElementById("cardsPromptPresetSelect");
            const cpInput = document.getElementById("cardsPromptInput");
            if (!presetSelect || !cpInput) return;

            const presetId = presetSelect.value;
            localStorage.setItem("aiCardsPromptPreset", presetId);

            const savedCustom = localStorage.getItem("aiCardsCustomPrompt_" + presetId);
            if (savedCustom !== null && savedCustom.trim()) {
                cpInput.value = savedCustom;
            } else {
                cpInput.value = defaultCardsPrompts[presetId] || DEFAULT_CARDS_PROMPT;
            }
            updateCardsPromptBadge();
            const presetName = presetId === "advanced" ? "Pokročilé Anki Kartičky (Sorbonne/Collège)" : "Standardní medicínské kartičky";
            appendConsoleLog(`🔄 Zvolena šablona pro kartičky: "${presetName}".`);
        }

        function onCardsPromptInputChanged() {
            updateCardsPromptBadge();
        }

        function updateCardsPromptBadge() {
            const badge = document.getElementById("cardsCustomPromptBadge");
            const cpInput = document.getElementById("cardsPromptInput");
            const presetSelect = document.getElementById("cardsPromptPresetSelect");
            if (!badge || !cpInput || !presetSelect) return;

            const presetId = presetSelect.value;
            const defText = defaultCardsPrompts[presetId] || DEFAULT_CARDS_PROMPT;
            const isChanged = cpInput.value.trim() !== defText.trim();

            if (isChanged) {
                badge.classList.remove("hidden");
                badge.textContent = "Upraveno";
            } else {
                badge.classList.add("hidden");
            }
        }

        function saveCustomCardsPrompt() {
            const cpInput = document.getElementById("cardsPromptInput");
            const presetSelect = document.getElementById("cardsPromptPresetSelect");
            const feedback = document.getElementById("cardsPromptSavedFeedback");
            if (!cpInput || !presetSelect) return;

            const presetId = presetSelect.value;
            localStorage.setItem("aiCardsCustomPrompt_" + presetId, cpInput.value);
            updateCardsPromptBadge();

            if (feedback) {
                feedback.classList.remove("opacity-0");
                feedback.classList.add("opacity-100");
                setTimeout(() => {
                    feedback.classList.remove("opacity-100");
                    feedback.classList.add("opacity-0");
                }, 2500);
            }
            appendConsoleLog("💾 Vlastní znění promptu pro kartičky bylo uloženo do prohlížeče.");
        }

        function resetCardsPromptToDefault() {
            const presetSelect = document.getElementById("cardsPromptPresetSelect");
            const cpInput = document.getElementById("cardsPromptInput");
            if (!cpInput) return;

            const presetId = presetSelect ? presetSelect.value : "standard";
            localStorage.removeItem("aiCardsCustomPrompt_" + presetId);
            cpInput.value = defaultCardsPrompts[presetId] || DEFAULT_CARDS_PROMPT;
            updateCardsPromptBadge();

            const feedback = document.getElementById("cardsPromptSavedFeedback");
            if (feedback) {
                feedback.textContent = "✓ Obnoveno";
                feedback.classList.remove("opacity-0");
                feedback.classList.add("opacity-100");
                setTimeout(() => {
                    feedback.classList.remove("opacity-100");
                    feedback.classList.add("opacity-0");
                    feedback.textContent = "✓ Uloženo";
                }, 2500);
            }
            appendConsoleLog("🔄 Šablona promptu pro kartičky byla obnovena na původní výchozí znění.");
        }

        function onNotesQuestionSelectChange() {
            const sel = document.getElementById("notesQuestionSelect");
            const custom = document.getElementById("notesCustomQuestionInput");
            if (sel.value) {
                custom.value = "";
            }
        }

        async function runNotesGeneration() {
            if (!currentProject) {
                alert(t("common.selectProject", "Nejprve vyberte projekt."));
                return;
            }

            const sel = document.getElementById("notesQuestionSelect").value;
            const custom = document.getElementById("notesCustomQuestionInput").value;
            const question = custom.trim() || sel.trim();

            if (!question) {
                alert(t("notes.selectQuestionOrTheme", "Vyberte otázku ze seznamu nebo zadejte vlastní téma."));
                return;
            }

            const btn = document.getElementById("btnGenerateNotes");
            btn.disabled = true;
            btn.innerHTML = `<span>⏳</span> Generuji text & citace...`;

            document.getElementById("notesResultTitle").textContent = question;
            document.getElementById("notesResultSub").textContent = t("notes.analyzingAndGenerating", "Probíhá analýza materiálů a generování...");
            document.getElementById("notesRenderedArea").innerHTML = `
                <div class="h-full flex flex-col items-center justify-center text-sky-400 animate-pulse space-y-3">
                    <span class="text-4xl">🤖</span>
                    <p class="font-semibold text-sm">Profesor analyzuje materiály a připravuje strukturovaný text...</p>
                    <p class="text-xs text-slate-400">Průběh můžete sledovat v Live Konzoli v horní liště.</p>
                </div>
            `;

            const modelName = getSelectedModel("notesModelSelect", "notesModelCustomInput");

            try {
                const res = await fetch("/api/generate-notes", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        question,
                        project: currentProject,
                        prompt: document.getElementById("notesPromptInput").value,
                        gemini_model: modelName
                    })
                });

                const data = await res.json();
                if (res.ok) {
                    currentNotesMarkdown = data.markdown;
                    currentNotesSources = data.sources || [];
                    currentNotesFilename = data.filename;

                    renderNotesResult(data.markdown, data.sources);
                    loadSavedNotesList();
                    updateDashboardStats();
                } else {
                    alert("Chyba při generování: " + (data.detail || "Neznámá chyba"));
                    document.getElementById("notesRenderedArea").innerHTML = `<div class="p-4 text-red-400">Generování selhalo: ${data.detail || 'Chyba serveru'}</div>`;
                }
            } catch (e) {
                alert("Nelze se spojit se serverem: " + e.message);
            } finally {
                btn.disabled = false;
                btn.innerHTML = `<span>✨</span> Vygenerovat studijní text`;
            }
        }

        function sanitizeMarkdownForRendering(markdown) {
            if (!markdown) return "";
            let text = markdown;
            // 0. Odstranění interních úvah modelu (Chain-of-Thought / Scratchpad)
            text = text.replace(/<(thought|think)>[\s\S]*?<\/\1>/gi, '');
            text = text.replace(/<(thought|think)>[\s\S]*?$/gi, '');
            text = text.replace(/^\s*\/\*[\s\S]*?\*\/\s*/g, '');
            let prevText = null;
            const thoughtPrefixPattern = /^\s*(?:\/|\/\*)?(?:\*?\*?(?:Strict grounding|Refine Citations|Check carefully|Chain of thought|Thinking process|Grounding check)[^\n]*[\s\S]*?(?:\n\n|\Z))/i;
            while (prevText !== text) {
                prevText = text;
                text = text.replace(thoughtPrefixPattern, '');
            }
            // 0b. Odstranění zpětných apostrofů okolo citací: `[1, s. 286]` -> [1, s. 286] a osiřelých `[1, s. -> [1, s.
            text = text.replace(/`(\[(?:Zdroj\s*)?\d+(?:,\s*s(?:tr)?\.?\s*[^\]]+)?\])`/gi, '$1');
            text = text.replace(/`(\[(?:Zdroj\s*)?\d+)/gi, '$1');

            // 1. Odstranění interního METADATA bloku pro vizuální zobrazení
            text = text.replace(/<!--\s*METADATA[\s\S]*?-->/gi, '').trim();
            // 2. Normalizace surového \\n na skutečné nové řádky
            if (text.includes("\\n") && !text.includes("\n\n")) {
                text = text.replace(/\\n/g, "\n");
            }
            // 3. Oprava případného slití řádků tabulky na jednom řádku: | a | b | | c | d |
            text = text.replace(/(\|\s*)\|\s*([^\s|])/g, "$1\n| $2");
            // 4. Odstranění prázdných řádků MEZI řádky tabulky (řádky začínající a končící |)
            while (/(\|[^\n\r]+\|)\s*\n\s*\n+(\s*\|)/.test(text)) {
                text = text.replace(/(\|[^\n\r]+\|)\s*\n\s*\n+(\s*\|)/g, "$1\n$2");
            }
            // 5. Zajištění prázdného řádku před tabulkou (řádek před nesmí být řádek tabulky, tj. [^\n\r|])
            text = text.replace(/([^\n\r|])\r?\n(\s*\|[^\n\r]+\|)/g, "$1\n\n$2");
            // 6. Zajištění prázdného řádku za tabulkou
            text = text.replace(/(\|[^\n\r]+\|)\r?\n([^\n\r|\s])/g, "$1\n\n$2");
            return text;
        }

        function renderMarkdownWithKaTeX(markdown) {
            if (!markdown) return "";

            // 1. Záchrana a normalizace markdownu (tabulky, \n, myšlenkové procesy, odstranění meta komentáře)
            const cleanMarkdown = sanitizeMarkdownForRendering(markdown);

            // 2. Ochrana kódových bloků (``` a `) před záměnou za matematiku
            const codeBlocks = [];
            let text = cleanMarkdown.replace(/(```[\s\S]*?```)/g, (match) => {
                const id = codeBlocks.length;
                codeBlocks.push(match);
                return `%%%CODEBLOCK_${id}_TOKEN%%%`;
            });
            text = text.replace(/(`[^`\n\r]+`)/g, (match) => {
                const id = codeBlocks.length;
                codeBlocks.push(match);
                return `%%%CODEBLOCK_${id}_TOKEN%%%`;
            });

            // 3. Extrakce matematických bloků před marked.parse
            const mathMap = [];

            // Bloková matematika: $$...$$ nebo \[...\]
            text = text.replace(/\$\$([\s\S]*?)\$\$/g, (match, tex) => {
                const idx = mathMap.length;
                mathMap.push({ tex: tex.trim(), display: true });
                return `%%%KATEXBLOCK_${idx}_TOKEN%%%`;
            });
            text = text.replace(/\\\[([\s\S]*?)\\\]/g, (match, tex) => {
                const idx = mathMap.length;
                mathMap.push({ tex: tex.trim(), display: true });
                return `%%%KATEXBLOCK_${idx}_TOKEN%%%`;
            });

            // Inline matematika: \(...\) nebo $...$
            text = text.replace(/\\\(([\s\S]*?)\\\)/g, (match, tex) => {
                const idx = mathMap.length;
                mathMap.push({ tex: tex.trim(), display: false });
                return `%%%KATEXINLINE_${idx}_TOKEN%%%`;
            });
            text = text.replace(/(?<!\\)\$([^\s$](?:[^$\n\r]*?[^\s$])?)\$/g, (match, tex) => {
                const idx = mathMap.length;
                mathMap.push({ tex: tex.trim(), display: false });
                return `%%%KATEXINLINE_${idx}_TOKEN%%%`;
            });

            // 4. Obnovení kódových bloků pro marked.parse
            text = text.replace(/%%%CODEBLOCK_(\d+)_TOKEN%%%/g, (m, id) => codeBlocks[parseInt(id, 10)] || m);

            // 5. Parsování Markdownu přes marked
            let html = "";
            try {
                html = marked.parse(text);
            } catch (err) {
                console.warn("marked.parse error:", err);
                html = text;
            }

            // 6. Formátování citací
            try {
                html = formatInlineCitations(html);
            } catch (citErr) {
                console.warn("formatInlineCitations error:", citErr);
            }

            // 7. Dosazení zrenderovaného KaTeX HTML na místo tokenů
            html = html.replace(/%%%KATEX(BLOCK|INLINE)_(\d+)_TOKEN%%%/g, (match, type, idx) => {
                const item = mathMap[parseInt(idx, 10)];
                if (!item) return match;
                try {
                    if (typeof katex !== "undefined" && katex && katex.renderToString) {
                        return katex.renderToString(item.tex, {
                            displayMode: item.display,
                            throwOnError: false
                        });
                    }
                } catch (e) {
                    console.warn("KaTeX renderToString error:", e);
                }
                return item.display ? `$$${item.tex}$$` : `$${item.tex}$`;
            });

            return html;
        }

        function renderNotesResult(markdown, sources) {
            document.getElementById("notesRawArea").value = markdown;

            // 1. Záchrana, Markdown, Citace a KaTeX vzorce
            const renderedHtml = renderMarkdownWithKaTeX(markdown);

            const areaEl = document.getElementById("notesRenderedArea");
            areaEl.innerHTML = renderedHtml;

            // 4. Správa zobrazení citovaných zdrojů (včetně zpětného načtení z METADATA)
            let activeSources = sources;
            if ((!activeSources || activeSources.length === 0) && markdown.includes("<!-- METADATA")) {
                try {
                    const metaMatch = markdown.match(/<!--\s*METADATA\s*([\s\S]*?)\s*-->/);
                    if (metaMatch && metaMatch[1]) {
                        const parsedMeta = JSON.parse(metaMatch[1]);
                        if (parsedMeta.sources && parsedMeta.sources.length > 0) {
                            activeSources = parsedMeta.sources;
                        }
                    }
                } catch(e) {}
            }

            currentNotesSources = activeSources || [];
            window.currentNotesSources = currentNotesSources;
            if (activeSources && activeSources.length > 0) {
                registerProjectSources(window.currentNotesProject || currentProject, activeSources);
            }

            const sourcesBar = document.getElementById("notesSourcesBar");
            const sourcesList = document.getElementById("notesSourcesList");
            if (activeSources && activeSources.length > 0) {
                sourcesBar.classList.remove("hidden");
                sourcesList.innerHTML = "";
                activeSources.forEach(s => {
                    const span = document.createElement("span");
                    span.id = `source-item-${s.id}`;
                    span.className = "bg-slate-800 hover:bg-slate-700 text-emerald-400 border border-slate-700 px-2 py-0.5 rounded text-[11px] font-mono flex items-center gap-1.5 transition-all cursor-pointer group shadow-sm";
                    span.title = `Kliknutím otevřít ${s.filename} v prohlížeči`;
                    span.onclick = () => openDocumentViewer(s.filename, "", window.currentNotesProject || currentProject);
                    span.innerHTML = `<strong>[${s.id}]</strong> <span class="truncate max-w-[200px] text-slate-200 group-hover:text-sky-300">${s.filename}</span> <span class="text-[10px] text-sky-400 font-bold ml-0.5 opacity-70 group-hover:opacity-100">↗</span>`;
                    sourcesList.appendChild(span);
                });
            } else {
                sourcesBar.classList.add("hidden");
            }

            document.getElementById("notesResultSub").textContent = `Hotovo (${markdown.length} znaků) • Uloženo`;

            if (window.notesSearcher) {
                const inputVal = document.getElementById("notesSearchInput")?.value?.trim();
                if (inputVal) {
                    window.notesSearcher.search(inputVal);
                } else {
                    window.notesSearcher.clearHighlights();
                }
            }
        }

        function toggleNotesView(mode) {
            const renderedArea = document.getElementById("notesRenderedArea");
            const rawArea = document.getElementById("notesRawArea");
            const btnR = document.getElementById("btnViewRendered");
            const btnRaw = document.getElementById("btnViewRaw");

            if (mode === 'rendered') {
                const currentRaw = rawArea.value;
                if (currentRaw) {
                    renderNotesResult(currentRaw, currentNotesSources);
                }
                renderedArea.classList.remove("hidden");
                rawArea.classList.add("hidden");
                btnR.className = "px-2.5 py-1 rounded-md font-semibold bg-sky-900/60 text-sky-300";
                btnRaw.className = "px-2.5 py-1 rounded-md font-semibold text-slate-400 hover:text-slate-200";
            } else {
                renderedArea.classList.add("hidden");
                rawArea.classList.remove("hidden");
                btnRaw.className = "px-2.5 py-1 rounded-md font-semibold bg-sky-900/60 text-sky-300";
                btnR.className = "px-2.5 py-1 rounded-md font-semibold text-slate-400 hover:text-slate-200";
            }
        }

        function copyNotesMarkdown() {
            const text = document.getElementById("notesRawArea").value || currentNotesMarkdown;
            if (!text) return;
            navigator.clipboard.writeText(text);
            alert(t("notes.markdownCopied", "Markdown studijního textu byl zkopírován do schránky!"));
        }

        function downloadNotesMarkdown() {
            const text = document.getElementById("notesRawArea").value || currentNotesMarkdown;
            if (!text) return;
            const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = currentNotesFilename || `${currentProject}_studijni_text.md`;
            a.click();
            URL.revokeObjectURL(url);
        }

        async function loadSavedNotesList() {
            if (!currentProject) return;
            const res = await fetch(`/api/notes?project=${currentProject}`);
            const data = await res.json();
            const list = document.getElementById("savedNotesList");
            list.innerHTML = "";

            if (!data.notes || data.notes.length === 0) {
                list.innerHTML = `<li class="text-slate-500 italic text-center py-2">${t("notes.noSavedNotes", "Žádné uložené texty")}</li>`;
                return;
            }

            if (questions && questions.length > 0) {
                const noteTitles = new Set(data.notes.map(n => (n.title || "").toLowerCase().trim()));
                questions.forEach(q => {
                    if (q.notesStatus !== "Processing" && noteTitles.has((q.title || "").toLowerCase().trim())) {
                        q.notesStatus = "Done";
                    }
                });
                renderNotesBatchTable();
            }

            data.notes.forEach(note => {
                const li = document.createElement("li");
                li.className = "flex justify-between items-center bg-slate-900/80 p-2 rounded-lg border border-slate-700/60 group hover:border-sky-500/50 transition cursor-pointer";
                li.innerHTML = `
                    <div class="flex-1 min-w-0 pr-2" onclick="openSavedNote('${note.filename}')">
                        <p class="text-xs font-semibold text-slate-200 truncate group-hover:text-sky-300" title="${note.title}">${note.title}</p>
                        <p class="text-[10px] text-slate-500">${(note.size / 1024).toFixed(1)} KB</p>
                    </div>
                    <button onclick="deleteSavedNote('${note.filename}')" class="text-red-400 hover:text-red-300 font-bold px-1.5 opacity-50 group-hover:opacity-100 transition" title="Smazat">✕</button>
                `;
                list.appendChild(li);
            });

            const savedNotesSearchVal = document.getElementById("savedNotesSearchInput")?.value;
            if (savedNotesSearchVal) {
                filterSavedNotesList(savedNotesSearchVal);
            }
        }

        async function openSavedNote(filename) {
            const res = await fetch(`/api/notes/${filename}`);
            if (res.ok) {
                const data = await res.json();
                currentNotesMarkdown = data.markdown;
                currentNotesFilename = filename;
                if (data.project) {
                    window.currentNotesProject = data.project;
                }
                const noteSources = data.sources || [];
                if (noteSources.length > 0) {
                    registerProjectSources(data.project || currentProject, noteSources);
                }
                document.getElementById("notesResultTitle").textContent = filename;
                renderNotesResult(data.markdown, noteSources);
                toggleNotesView('rendered');
            }
        }

        async function deleteSavedNote(filename) {
            if (confirm(`Opravdu smazat poznámky ${filename}?`)) {
                await fetch(`/api/notes/${filename}`, { method: "DELETE" });
                loadSavedNotesList();
                updateDashboardStats();
            }
        }

        // =========================================================================
        // LOGIKA PRO ZÁLOŽKU 4: KARTIČKY (ANKI / QUIZLET)
        // =========================================================================
        let currentCardsMode = 'single'; // 'single' | 'batch'

        function setCardsMode(mode) {
            currentCardsMode = mode;
            const btnSingle = document.getElementById("btnCardsModeSingle");
            const btnBatch = document.getElementById("btnCardsModeBatch");
            const singleBox = document.getElementById("cardsSingleContainer");
            const batchBox = document.getElementById("cardsBatchContainer");
            const singleBtn = document.getElementById("btnGenerateCards");
            const batchBtns = document.getElementById("cardsBatchActionButtons");

            if (mode === 'single') {
                if (btnSingle) btnSingle.className = "flex-1 py-1.5 rounded-md bg-amber-900/70 text-amber-200 transition text-center shadow-sm";
                if (btnBatch) btnBatch.className = "flex-1 py-1.5 rounded-md text-slate-400 hover:text-slate-200 transition text-center";
                if (singleBox) singleBox.classList.remove("hidden");
                if (batchBox) batchBox.classList.add("hidden");
                if (singleBtn) singleBtn.classList.remove("hidden");
                if (batchBtns) batchBtns.classList.add("hidden");
            } else {
                if (btnBatch) btnBatch.className = "flex-1 py-1.5 rounded-md bg-amber-900/70 text-amber-200 transition text-center shadow-sm";
                if (btnSingle) btnSingle.className = "flex-1 py-1.5 rounded-md text-slate-400 hover:text-slate-200 transition text-center";
                if (singleBox) singleBox.classList.add("hidden");
                if (batchBox) batchBox.classList.remove("hidden");
                if (singleBtn) singleBtn.classList.add("hidden");
                if (batchBtns) batchBtns.classList.remove("hidden");
                renderCardsBatchTable();
            }
        }

        function renderCardsBatchTable() {
            const tbody = document.getElementById("cardsBatchTableBody");
            const countLabel = document.getElementById("cardsBatchSelectedCount");
            if (!tbody) return;

            if (!questions || questions.length === 0) {
                tbody.innerHTML = `<tr><td class="p-3 text-center text-slate-500 italic text-xs">V projektu zatím nejsou žádné otázky.</td></tr>`;
                if (countLabel) countLabel.textContent = "0 vybráno";
                return;
            }

            let selectedCount = 0;
            tbody.innerHTML = "";
            questions.forEach((q, idx) => {
                if (q.cardsSelected === undefined) q.cardsSelected = true;
                if (q.cardsSelected) selectedCount++;

                const tr = document.createElement("tr");
                tr.className = "border-b border-slate-800 hover:bg-slate-850 transition";

                let badge = `<span class="text-slate-500 text-[10px]">Čeká</span>`;
                if (q.cardsStatus === "Done") {
                    const countInfo = q.cardsCount ? ` (${q.cardsCount} ks)` : '';
                    badge = `<span class="bg-amber-950 text-amber-400 px-1.5 py-0.5 rounded border border-amber-800 text-[10px] font-bold" title="Hotovo: ${q.cardsCount || '?'} kartiček">Karty OK${countInfo}</span>`;
                }
                else if (q.cardsStatus === "Processing") badge = `<span class="bg-sky-950 text-sky-400 px-1.5 py-0.5 rounded border border-sky-800 text-[10px] animate-pulse font-bold">Generuji</span>`;
                else if (q.cardsStatus === "Error") badge = `<span class="bg-red-950 text-red-400 px-1.5 py-0.5 rounded border border-red-800 text-[10px] font-bold">Chyba</span>`;

                tr.innerHTML = `
                    <td class="p-2 text-center w-8">
                        <input type="checkbox" ${q.cardsSelected ? 'checked' : ''} onchange="toggleCardsQuestion(${idx}, this.checked)" class="accent-amber-500 cursor-pointer w-3.5 h-3.5">
                    </td>
                    <td class="p-2 text-slate-200 text-xs font-medium truncate max-w-[200px]" title="${q.title}">
                        <span class="text-slate-400 font-mono text-[10px] mr-1">${idx + 1}.</span>${q.title}
                    </td>
                    <td class="p-2 text-center w-20">${badge}</td>
                `;
                tbody.appendChild(tr);
            });

            if (countLabel) countLabel.textContent = `${selectedCount} vybráno`;

            const cardsBatchVal = document.getElementById("cardsBatchFilterInput")?.value;
            if (cardsBatchVal) {
                filterCardsBatchTable(cardsBatchVal);
            }
        }

        function toggleCardsQuestion(idx, isChecked) {
            if (questions[idx]) {
                questions[idx].cardsSelected = isChecked;
                renderCardsBatchTable();
            }
        }

        function selectAllCardsQuestions(selectAll) {
            questions.forEach(q => q.cardsSelected = selectAll);
            renderCardsBatchTable();
        }

        function setCardsBatchControls(isRunning) {
            const btnSel = document.getElementById("btnCardsBatchSelected");
            const btnMiss = document.getElementById("btnCardsBatchMissing");
            const btnAll = document.getElementById("btnCardsBatchAll");
            const progressBox = document.getElementById("cardsBatchProgressBox");
            if (btnSel) btnSel.disabled = isRunning;
            if (btnMiss) btnMiss.disabled = isRunning;
            if (btnAll) btnAll.disabled = isRunning;
            if (progressBox && isRunning) {
                progressBox.classList.remove("hidden");
            }
        }

        function updateCardsQuestionsStatus(questionIndexes, status) {
            const targetIndexes = new Set(questionIndexes || []);
            if (targetIndexes.size === 0) return;
            questions.forEach(q => {
                if (targetIndexes.has(q.q_index)) {
                    q.cardsStatus = status;
                }
            });
            renderCardsBatchTable();
        }

        function updateCardsBatchProgress(completed, total, statusText, isDone = false) {
            const box = document.getElementById("cardsBatchProgressBox");
            const bar = document.getElementById("cardsBatchProgressBar");
            const label = document.getElementById("cardsBatchProgressStatus");
            const pct = document.getElementById("cardsBatchProgressPercent");
            if (!box || !bar) return;

            box.classList.remove("hidden");
            const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
            bar.style.width = `${percent}%`;
            if (pct) pct.textContent = `${percent}%`;
            if (label) label.textContent = statusText || `Zpracováno ${completed} / ${total}`;

            if (isDone) {
                setTimeout(() => {
                    if (!activeBatch || activeBatch.mode !== "flashcards") {
                        box.classList.add("hidden");
                    }
                }, 5000);
            }
        }

        async function runCardsBatchProcessing(mode) {
            if (activeBatch) {
                alert(t("notes.batchAlreadyRunning", "Dávkové zpracování již běží. Vyčkejte na dokončení nebo použijte Storno."));
                return;
            }
            if (!currentProject) {
                alert(t("common.selectProject", "Nejprve vyberte projekt."));
                return;
            }

            const count = parseInt(document.getElementById("cardsCountInput").value || "10", 10);
            const tolerance = Math.max(3, Math.floor(count * 0.15));

            let target;
            if (mode === 'all') {
                target = questions.slice();
            } else if (mode === 'missing') {
                target = questions.filter(q => q.cardsStatus !== 'Done' || (q.cardsCount !== undefined && q.cardsCount < (count - tolerance)));
                if (target.length === 0) {
                    alert(`Všechny otázky již mají hotový dostatečný počet kartiček (alespoň ${count - tolerance} ks)! Žádné k dogenerování nezbývají.`);
                    return;
                }
            } else {
                target = questions.filter(q => q.cardsSelected);
            }

            if (target.length === 0) {
                alert(t("cards.noQuestionsSelectedBatch", "Nebyly vybrány žádné otázky pro dávku kartiček."));
                return;
            }

            target.forEach(q => q.cardsStatus = "Processing");
            renderCardsBatchTable();
            setCardsBatchControls(true);
            updateCardsBatchProgress(0, target.length, `Spouštím dávku (${count} ks/otázka) pro ${target.length} otázek...`);

            const modelName = getSelectedModel("cardsModelSelect", "cardsModelCustomInput");
            const isOvernight = document.getElementById("cardsOvernightMode")?.checked ?? true;

            try {
                const res = await fetch("/api/process-flashcards-batch", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        questions: target.map(q => ({ title: q.title, q_index: q.q_index })),
                        count: count,
                        prompt: document.getElementById("cardsPromptInput").value,
                        project: currentProject,
                        gemini_model: modelName,
                        overnight_mode: isOvernight
                    })
                });
                const data = await res.json();
                if (!res.ok) {
                    throw new Error(data.detail || "Dávku kartiček se nepodařilo spustit.");
                }

                activeBatch = {
                    batchId: data.batch_id,
                    project: currentProject,
                    mode: "flashcards",
                    questionIndexes: target.map(q => q.q_index),
                    total: target.length,
                    completed: 0
                };
                appendConsoleLog(`🚀 Dávka kartiček (${count} ks/otázka) pro ${target.length} otázek spuštěna (noční režim: ${isOvernight ? 'zapnut' : 'vypnut'}).`);
            } catch (e) {
                target.forEach(q => q.cardsStatus = "Ready");
                renderCardsBatchTable();
                setCardsBatchControls(false);
                alert("Chyba spuštění dávky: " + e.message);
            }
        }

        const PRESET_CARDS_COUNTS = [10, 25, 50, 100, 150, 200];

        function setCardsCount(num, isCustomToggle = false) {
            let val = parseInt(num, 10);
            if (isNaN(val) || val < 1) val = 10;
            val = Math.max(1, Math.min(500, val));

            const input = document.getElementById("cardsCountInput");
            const range = document.getElementById("cardsCountRange");
            const label = document.getElementById("cardsCountLabel");
            const customBox = document.getElementById("cardsCustomCountBox");
            const customDirectInput = document.getElementById("cardsCustomDirectInput");
            const customBtn = document.getElementById("cardsCountCustomBtn");

            const isPreset = PRESET_CARDS_COUNTS.includes(val);
            const isCustom = !isPreset || isCustomToggle;

            if (input) input.value = val;
            if (customDirectInput) customDirectInput.value = val;

            if (range) {
                range.max = Math.max(200, val);
                range.value = val;
            }

            if (label) {
                if (isCustom && !isPreset) {
                    label.innerHTML = `✨ ${val} unikátních kartiček <span class="text-[10px] text-amber-300 font-normal">(vlastní číslo)</span>`;
                } else {
                    label.textContent = `${val} kartiček`;
                }
            }

            const buttons = document.querySelectorAll(".card-count-btn");
            buttons.forEach(btn => {
                if (btn.id === "cardsCountCustomBtn") {
                    if (isCustom) {
                        btn.className = "card-count-btn py-1 text-xs font-bold rounded bg-amber-600 text-white border border-amber-500 transition shadow";
                    } else {
                        btn.className = "card-count-btn py-1 text-xs font-bold rounded bg-slate-900 border border-slate-700 hover:bg-slate-700 transition text-amber-300";
                    }
                } else {
                    if (!isCustom && btn.textContent.trim() === String(val)) {
                        btn.className = "card-count-btn py-1 text-xs font-bold rounded bg-amber-600 text-white border border-amber-500 transition";
                    } else {
                        btn.className = "card-count-btn py-1 text-xs font-bold rounded bg-slate-900 border border-slate-700 hover:bg-slate-700 transition";
                    }
                }
            });

            if (customBox) {
                if (isCustom) {
                    customBox.classList.remove("hidden");
                } else {
                    customBox.classList.add("hidden");
                }
            }

            const info = document.getElementById("cardsBatchModeInfo");
            if (info) {
                if (val >= 50) {
                    info.innerHTML = `⚡ <strong>Velká sada (${val} ks):</strong> Každá otázka je 100% unikátní. Systém generuje karty v tematických sériích (diagnostika, terapie, dif. dg., komplikace, Red Flags, chytáky) s automatickou eliminací duplicit.`;
                    info.className = "text-[10px] text-amber-400/90 leading-tight";
                } else {
                    info.innerHTML = `✨ <strong>Série ${val} unikátních kartiček:</strong> Testuje high-yield diagnostická kritéria, léky volby a Red Flags bez opakování otázek.`;
                    info.className = "text-[10px] text-slate-400 leading-tight";
                }
            }
        }

        function toggleCustomCardsCount() {
            const customBox = document.getElementById("cardsCustomCountBox");
            const customDirectInput = document.getElementById("cardsCustomDirectInput");
            const isCurrentlyHidden = customBox ? customBox.classList.contains("hidden") : true;

            if (isCurrentlyHidden) {
                const currentVal = parseInt(document.getElementById("cardsCountInput")?.value || "30", 10);
                setCardsCount(currentVal, true);
                if (customDirectInput) {
                    customDirectInput.focus();
                    customDirectInput.select();
                }
            } else {
                setCardsCount(10, false);
            }
        }



        function onCardsQuestionSelectChange() {
            const sel = document.getElementById("cardsQuestionSelect");
            const custom = document.getElementById("cardsCustomQuestionInput");
            if (sel.value) {
                custom.value = "";
            }
        }

        async function runFlashcardsGeneration() {
            if (!currentProject) {
                alert(t("common.selectProject", "Nejprve vyberte projekt."));
                return;
            }

            const sel = document.getElementById("cardsQuestionSelect").value;
            const custom = document.getElementById("cardsCustomQuestionInput").value;
            const question = custom.trim() || sel.trim();

            if (!question) {
                alert(t("notes.selectQuestionOrTheme", "Vyberte otázku ze seznamu nebo zadejte vlastní téma."));
                return;
            }

            const count = parseInt(document.getElementById("cardsCountInput").value || "10", 10);
            const btn = document.getElementById("btnGenerateCards");
            btn.disabled = true;
            btn.innerHTML = `<span>⏳</span> Generuji ${count} kartiček...`;

            document.getElementById("cardFrontText").textContent = `Profesor připravuje ${count} high-yield kartiček...`;
            document.getElementById("cardBackText").textContent = "";

            const modelName = getSelectedModel("cardsModelSelect", "cardsModelCustomInput");
            const forceRegen = document.getElementById("cardsForceRegenerate")?.checked ?? false;

            try {
                const res = await fetch("/api/generate-flashcards", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        question,
                        project: currentProject,
                        count,
                        prompt: document.getElementById("cardsPromptInput").value,
                        gemini_model: modelName,
                        force_regenerate: forceRegen
                    })
                });

                const data = await res.json();
                if (res.ok) {
                    currentDeck = data;
                    currentCardIndex = 0;
                    isCardFlipped = false;
                    displayCurrentCard();
                    renderDeckTable();
                    loadSavedFlashcardsList();
                    updateDashboardStats();
                } else {
                    alert("Chyba při generování kartiček: " + (data.detail || "Neznámá chyba"));
                }
            } catch (e) {
                alert("Nelze navázat spojení se serverem: " + e.message);
            } finally {
                btn.disabled = false;
                btn.innerHTML = `<span>🗂️</span> Vygenerovat kartičky`;
            }
        }

        function flipCurrentCard() {
            if (!currentDeck.cards || currentDeck.cards.length === 0) return;
            const inner = document.getElementById("flashcardInner");
            isCardFlipped = !isCardFlipped;
            if (isCardFlipped) {
                inner.classList.add("rotate-y-180");
            } else {
                inner.classList.remove("rotate-y-180");
            }
        }

        function displayCurrentCard() {
            const inner = document.getElementById("flashcardInner");
            isCardFlipped = false;
            inner.classList.remove("rotate-y-180");

            const cards = currentDeck.cards || [];
            const total = cards.length;

            if (total === 0) {
                document.getElementById("cardFrontText").textContent = t("cards.selectPrompt", "Zvolte otázku a vygenerujte kartičky");
                document.getElementById("cardBackText").textContent = "";
                document.getElementById("cardCounterFront").textContent = "0 / 0";
                document.getElementById("cardSourceRefBadge").textContent = "";
                document.getElementById("btnPrevCard").disabled = true;
                document.getElementById("btnNextCard").disabled = true;
                document.getElementById("btnFlipCard").disabled = true;
                document.getElementById("btnExportAnki").disabled = true;
                document.getElementById("btnCopyQuizlet").disabled = true;
                document.getElementById("currentDeckCountBadge").textContent = t("cards.zeroAvailable", "0 kartiček k dispozici");
                return;
            }

            const c = cards[currentCardIndex];
            document.getElementById("cardFrontText").innerHTML = renderMarkdownWithKaTeX(c.front || "");
            
            const backFormatted = renderMarkdownWithKaTeX(c.back || "");
            document.getElementById("cardBackText").innerHTML = backFormatted;

            document.getElementById("cardCounterFront").textContent = `${currentCardIndex + 1} / ${total}`;
            
            // Zpracování zdroje a prokliku na PDF
            const badgeEl = document.getElementById("cardSourceRefBadge");
            const resolved = resolveCardSourceClient(c, currentDeck.sources || []);
            if (resolved.source_file || resolved.source_ref) {
                const label = resolved.source_file 
                    ? `${resolved.source_file}${resolved.source_page ? ` (s. ${resolved.source_page})` : ''}`
                    : resolved.source_ref;
                badgeEl.innerHTML = `📖 <span class="hover:underline">${label}</span> <span class="text-[10px] text-sky-400 font-bold">↗</span>`;
                badgeEl.className = "text-[11px] bg-sky-950/90 hover:bg-sky-900 text-sky-300 border border-sky-700/80 font-mono font-bold px-2.5 py-1 rounded-lg cursor-pointer transition flex items-center gap-1.5 shadow-sm";
                badgeEl.title = resolved.source_file ? `Kliknutím otevřít ${resolved.source_file} (s. ${resolved.source_page || 1})` : "Zdroj kartičky";
                badgeEl.onclick = (e) => {
                    e.stopPropagation();
                    if (resolved.source_file) {
                        openDocumentViewer(resolved.source_file, resolved.clean_page, currentProject);
                    } else if (resolved.source_id) {
                        handleCitationClick(e, resolved.source_id, resolved.clean_page);
                    }
                };
                badgeEl.style.display = "inline-flex";
            } else {
                badgeEl.textContent = "";
                badgeEl.style.display = "none";
            }

            document.getElementById("currentDeckTitle").textContent = currentDeck.question;
            document.getElementById("currentDeckCountBadge").textContent = `${total} kartiček • Aktivní #${currentCardIndex + 1}`;

            document.getElementById("btnPrevCard").disabled = currentCardIndex === 0;
            document.getElementById("btnNextCard").disabled = currentCardIndex === total - 1;
            document.getElementById("btnFlipCard").disabled = false;
            document.getElementById("btnExportAnki").disabled = false;
            document.getElementById("btnCopyQuizlet").disabled = false;

            highlightDeckTableRow(currentCardIndex);
        }

        function nextCard() {
            if (currentCardIndex < (currentDeck.cards.length - 1)) {
                currentCardIndex++;
                displayCurrentCard();
            }
        }

        function prevCard() {
            if (currentCardIndex > 0) {
                currentCardIndex--;
                displayCurrentCard();
            }
        }

        function selectCardFromTable(idx) {
            currentCardIndex = idx;
            displayCurrentCard();
        }

        function renderDeckTable() {
            const tbody = document.getElementById("deckTableBody");
            const cards = currentDeck.cards || [];

            if (cards.length === 0) {
                tbody.innerHTML = `<tr><td colspan="4" class="p-3 text-center text-slate-500 italic">Zatím žádná data.</td></tr>`;
                return;
            }

            tbody.innerHTML = "";
            cards.forEach((c, idx) => {
                const tr = document.createElement("tr");
                tr.id = `deckRow-${idx}`;
                tr.className = `border-b border-slate-800/80 hover:bg-slate-800 transition cursor-pointer ${idx === currentCardIndex ? 'bg-amber-950/40 border-amber-800/60' : ''}`;
                tr.onclick = () => selectCardFromTable(idx);

                const resolved = resolveCardSourceClient(c, currentDeck.sources || []);
                const srcLabel = resolved.source_file 
                    ? `${resolved.source_file.substring(0, 16)}...${resolved.source_page ? ` (s. ${resolved.source_page})` : ''}`
                    : (resolved.source_ref || '-');
                const srcTitle = resolved.source_file 
                    ? `${resolved.source_file} (s. ${resolved.source_page || 1}) - Kliknutím otevřít` 
                    : (resolved.source_ref || '');

                const cleanFront = (c.front || '').replace(/<[^>]*>?/gm, ' ').replace(/\s+/g, ' ').trim();
                const cleanBack = (c.back || '').replace(/<[^>]*>?/gm, ' ').replace(/\s+/g, ' ').trim();

                tr.innerHTML = `
                    <td class="p-2 text-center text-slate-400 font-mono">${idx + 1}</td>
                    <td class="p-2 truncate font-semibold text-slate-200" title="${cleanFront}">${cleanFront}</td>
                    <td class="p-2 truncate text-slate-400" title="${cleanBack}">${cleanBack}</td>
                    <td class="p-2 text-center text-sky-400 font-mono text-[10px] cursor-pointer hover:underline truncate" title="${srcTitle}" onclick="event.stopPropagation(); if ('${resolved.source_file}') openDocumentViewer('${resolved.source_file}', '${resolved.clean_page}', currentProject); else selectCardFromTable(${idx});">${srcLabel}</td>
                `;
                tbody.appendChild(tr);
            });

            const deckSearchVal = document.getElementById("deckSearchInput")?.value;
            if (deckSearchVal) {
                filterDeckTable(deckSearchVal);
            }
        }

        function highlightDeckTableRow(targetIdx) {
            const cards = currentDeck.cards || [];
            cards.forEach((_, idx) => {
                const row = document.getElementById(`deckRow-${idx}`);
                if (row) {
                    if (idx === targetIdx) {
                        row.className = "border-b border-amber-800/60 bg-amber-950/40 hover:bg-amber-900/40 transition cursor-pointer";
                    } else {
                        row.className = "border-b border-slate-800/80 hover:bg-slate-800 transition cursor-pointer";
                    }
                }
            });
        }

        function downloadAnkiTsv() {
            if (!currentDeck.anki_tsv) return;
            const blob = new Blob([currentDeck.anki_tsv], { type: "text/tab-separated-values;charset=utf-8" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            const safeName = (currentDeck.question || "karticky").substring(0, 30).replace(/[^a-zA-Z0-9_-]/g, '_');
            a.download = `Anki_${currentProject}_${safeName}.txt`;
            a.click();
            URL.revokeObjectURL(url);
        }

        function copyQuizletText() {
            if (!currentDeck.quizlet_text) return;
            navigator.clipboard.writeText(currentDeck.quizlet_text);
            alert("Formát pro Quizlet byl zkopírován do schránky!\n\nPostup v Quizletu:\n1. Klikněte na 'Vytvořit studijní sadu'\n2. Klikněte na tlačítko 'Importovat'\n3. Vložte stisknutím Ctrl+V a potvrďte.");
        }

        async function loadSavedFlashcardsList() {
            if (!currentProject) return;
            const res = await fetch(`/api/flashcards?project=${currentProject}`);
            const data = await res.json();
            const list = document.getElementById("savedDecksList");
            const bulkBadge = document.getElementById("bulkCardsCountBadge");
            const btnBulkAnki = document.getElementById("btnBulkExportAnki");
            const btnBulkQuizlet = document.getElementById("btnBulkExportQuizlet");
            list.innerHTML = "";

            if (!data.decks || data.decks.length === 0) {
                list.innerHTML = `<li class="text-slate-500 italic text-center py-2">${t("cards.noSavedDecks", "Žádné uložené sady")}</li>`;
                if (bulkBadge) bulkBadge.textContent = "0 sad / 0 karet";
                if (btnBulkAnki) btnBulkAnki.disabled = true;
                if (btnBulkQuizlet) btnBulkQuizlet.disabled = true;
                return;
            }

            const totalCards = (data.decks || []).reduce((acc, d) => acc + (d.count || 0), 0);
            if (bulkBadge) bulkBadge.textContent = `${data.decks.length} sad / ${totalCards} karet`;
            if (btnBulkAnki) btnBulkAnki.disabled = totalCards === 0;
            if (btnBulkQuizlet) btnBulkQuizlet.disabled = totalCards === 0;

            if (questions && questions.length > 0) {
                const deckMap = new Map();
                (data.decks || []).forEach(d => {
                    deckMap.set((d.question || "").toLowerCase().trim(), d.count || 0);
                });
                questions.forEach(q => {
                    const normTitle = (q.title || "").toLowerCase().trim();
                    if (q.cardsStatus !== "Processing" && deckMap.has(normTitle)) {
                        q.cardsCount = deckMap.get(normTitle);
                        q.cardsStatus = "Done";
                    }
                });
                renderCardsBatchTable();
            }

            data.decks.forEach(deck => {
                const li = document.createElement("li");
                li.className = "flex justify-between items-center bg-slate-900/80 p-2 rounded-lg border border-slate-700/60 group hover:border-amber-500/50 transition cursor-pointer";
                li.innerHTML = `
                    <div class="flex-1 min-w-0 pr-2" onclick="openSavedDeck('${deck.filename}')">
                        <p class="text-xs font-semibold text-slate-200 truncate group-hover:text-amber-300" title="${deck.question}">${deck.question}</p>
                        <p class="text-[10px] text-amber-400 font-bold">${deck.count} kartiček</p>
                    </div>
                    <button onclick="deleteSavedDeck('${deck.filename}')" class="text-red-400 hover:text-red-300 font-bold px-1.5 opacity-50 group-hover:opacity-100 transition" title="Smazat">✕</button>
                `;
                list.appendChild(li);
            });

            const savedDecksSearchVal = document.getElementById("savedDecksSearchInput")?.value;
            if (savedDecksSearchVal) {
                filterSavedDecksList(savedDecksSearchVal);
            }
        }

        async function downloadAllFlashcardsAnki() {
            if (!currentProject) {
                alert(t("common.selectProject", "Nejprve vyberte projekt."));
                return;
            }
            const btn = document.getElementById("btnBulkExportAnki");
            if (btn) btn.disabled = true;
            try {
                const res = await fetch(`/api/flashcards/export-all?project=${encodeURIComponent(currentProject)}`);
                if (!res.ok) {
                    const err = await res.json();
                    throw new Error(err.detail || "Chyba při exportu.");
                }
                const data = await res.json();
                if (!data.total_cards || data.total_cards === 0) {
                    alert(t("cards.noCardsToExport", "Pro tento projekt zatím nebyly vygenerovány žádné kartičky k exportu."));
                    return;
                }
                const blob = new Blob([data.anki_tsv], { type: "text/tab-separated-values;charset=utf-8" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `Anki_${currentProject}_vsechny_karticky.txt`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
                appendConsoleLog(`📥 Staženo všech ${data.total_cards} kartiček ze všech ${data.total_decks} otázek v jednom souboru pro Anki.`);
            } catch (e) {
                alert("Export se nezdařil: " + e.message);
            } finally {
                if (btn) btn.disabled = false;
            }
        }

        async function copyAllFlashcardsQuizlet() {
            if (!currentProject) {
                alert(t("common.selectProject", "Nejprve vyberte projekt."));
                return;
            }
            const btn = document.getElementById("btnBulkExportQuizlet");
            if (btn) btn.disabled = true;
            try {
                const res = await fetch(`/api/flashcards/export-all?project=${encodeURIComponent(currentProject)}`);
                if (!res.ok) {
                    const err = await res.json();
                    throw new Error(err.detail || "Chyba při exportu.");
                }
                const data = await res.json();
                if (!data.total_cards || data.total_cards === 0) {
                    alert(t("cards.noCardsToExport", "Pro tento projekt zatím nebyly vygenerovány žádné kartičky k exportu."));
                    return;
                }
                await navigator.clipboard.writeText(data.quizlet_text);
                appendConsoleLog(`📋 Zkopírováno všech ${data.total_cards} kartiček ze všech ${data.total_decks} otázek pro Quizlet import.`);
                alert(`Všech ${data.total_cards} kartiček napříč ${data.total_decks} otázkami projektu bylo zkopírováno do schránky!\n\nPostup v Quizletu:\n1. Klikněte na 'Vytvořit studijní sadu'\n2. Klikněte na 'Importovat'\n3. Vložte stisknutím Ctrl+V a potvrďte.`);
            } catch (e) {
                alert("Kopírování se nezdařilo: " + e.message);
            } finally {
                if (btn) btn.disabled = false;
            }
        }

        async function openSavedDeck(filename) {
            const res = await fetch(`/api/flashcards/${filename}`);
            if (res.ok) {
                const data = await res.json();
                currentDeck = data;
                currentCardIndex = 0;
                isCardFlipped = false;
                displayCurrentCard();
                renderDeckTable();
            }
        }

        async function deleteSavedDeck(filename) {
            if (confirm(`Opravdu smazat sadu kartiček ${filename}?`)) {
                await fetch(`/api/flashcards/${filename}`, { method: "DELETE" });
                loadSavedFlashcardsList();
                updateDashboardStats();
            }
        }

        // =========================================================================
        // =========================================================================
        // LOGIKA PRO ZÁLOŽKU: 📋 TESTOVÉ OTÁZKY (PRACTICE TESTS & ANKI MATCH)
        // =========================================================================
        let currentTestsMode = 'category'; // 'single' | 'category' | 'batch'
        let currentTestCount = 10;
        let currentTestDifficulty = 'normal'; // 'easy' | 'normal' | 'hard'
        let currentTestMode = 'instant'; // 'instant' | 'exam'
        let selectedTestCategories = new Set();
        let expandedTestCategory = null;
        let testsCategoriesInitializedForProject = null;
        let activeTest = null;
        let currentQuestionIndex = 0;
        let userAnswers = {}; // { [qid]: { selected_options: [], open_answer: "", open_eval: null, is_submitted: false, is_correct: false, score: 0 } }
        let testTimerInterval = null;
        let testTimerSeconds = 0;
        let isReviewMode = false;
        let followupDifficultyShift = 'same';
        let followupQuestionsCount = 5;

        function loadTestsTab() {
            syncQuestionsDropdowns();
            renderTestsCategoriesList();
            renderTestsBatchTable();
            loadSavedTestsList();
        }

        function setTestsMode(mode) {
            currentTestsMode = mode;
            const btnSingle = document.getElementById("btnTestsModeSingle");
            const btnCategory = document.getElementById("btnTestsModeCategory");
            const btnBatch = document.getElementById("btnTestsModeBatch");
            const singleBox = document.getElementById("testsSingleContainer");
            const categoryBox = document.getElementById("testsCategoryContainer");
            const batchBox = document.getElementById("testsBatchContainer");

            const activeClass = "py-1.5 rounded-md bg-purple-900/70 text-purple-200 transition text-center shadow-sm font-bold";
            const inactiveClass = "py-1.5 rounded-md text-slate-400 hover:text-slate-200 transition text-center";

            if (btnSingle) btnSingle.className = mode === 'single' ? activeClass : inactiveClass;
            if (btnCategory) btnCategory.className = mode === 'category' ? activeClass : inactiveClass;
            if (btnBatch) btnBatch.className = mode === 'batch' ? activeClass : inactiveClass;

            if (singleBox) singleBox.classList.toggle("hidden", mode !== 'single');
            if (categoryBox) categoryBox.classList.toggle("hidden", mode !== 'category');
            if (batchBox) batchBox.classList.toggle("hidden", mode !== 'batch');

            if (mode === 'category') {
                renderTestsCategoriesList();
            } else if (mode === 'batch') {
                renderTestsBatchTable();
            }
        }

        function onTestsQuestionSelectChange() {
            const sel = document.getElementById("testsQuestionSelect");
            const input = document.getElementById("testsCustomQuestionInput");
            if (sel && sel.value && input) {
                input.value = sel.value;
            }
        }

        // --- PRÁCE S KATEGORIEMI PRO TESTOVÉ OTÁZKY ---
        function getAvailableCategoriesWithQuestions() {
            const map = {};
            if (!questions || questions.length === 0) return map;
            questions.forEach(q => {
                const cat = (q.topic || "Všeobecné").trim();
                if (!map[cat]) map[cat] = [];
                map[cat].push(q);
            });
            return map;
        }

        function renderTestsCategoriesList() {
            const container = document.getElementById("testsCategoriesList");
            const countBadge = document.getElementById("testsCategorySelectedCount");
            const summaryCatCount = document.getElementById("testsCatCountBadge");
            const summaryQCount = document.getElementById("testsCatQuestionsCountBadge");
            const syncBtn = document.getElementById("btnSyncTestCountToCategories");
            const searchInput = document.getElementById("testsCategorySearchInput");
            if (!container) return;

            const catMap = getAvailableCategoriesWithQuestions();
            const categories = Object.keys(catMap).sort();

            if (categories.length === 0) {
                container.innerHTML = `
                    <div class="p-4 text-center text-slate-500 italic text-xs">
                        <div>📋 V projektu zatím nejsou žádné otázky ani okruhy.</div>
                        <div class="mt-1 text-[11px] text-slate-600">Přidejte nebo naimportujte otázky v záložce Plánovač zkoušky.</div>
                    </div>
                `;
                if (countBadge) countBadge.textContent = "0 vybráno";
                if (summaryCatCount) summaryCatCount.textContent = "0";
                if (summaryQCount) summaryQCount.textContent = "0";
                if (syncBtn) syncBtn.classList.add("hidden");
                return;
            }

            // Předvybereme všechny dostupné kategorie POUZE při prvním načtení daného projektu
            if (testsCategoriesInitializedForProject !== currentProject) {
                selectedTestCategories.clear();
                categories.forEach(c => selectedTestCategories.add(c));
                testsCategoriesInitializedForProject = currentProject;
            }

            const filterText = (searchInput?.value || "").toLowerCase().trim();
            const filteredCategories = categories.filter(c => !filterText || c.toLowerCase().includes(filterText));

            container.innerHTML = "";
            let totalSelectedQuestions = 0;
            let selectedCatCount = 0;

            categories.forEach(c => {
                if (selectedTestCategories.has(c)) {
                    selectedCatCount++;
                    totalSelectedQuestions += (catMap[c] || []).length;
                }
            });

            if (filteredCategories.length === 0) {
                container.innerHTML = `<div class="p-3 text-center text-slate-500 italic text-xs">Žádná kategorie neodpovídá filtru.</div>`;
            } else {
                filteredCategories.forEach(cat => {
                    const isChecked = selectedTestCategories.has(cat);
                    const qList = catMap[cat] || [];
                    const isExpanded = expandedTestCategory === cat;

                    const div = document.createElement("div");
                    div.className = `p-2.5 transition hover:bg-slate-800/70 ${isChecked ? 'bg-purple-950/20' : 'bg-transparent'}`;

                    let questionsPreviewHtml = "";
                    if (isExpanded) {
                        questionsPreviewHtml = `
                            <div class="mt-2 pl-6 pr-2 pt-2 border-t border-slate-800/70 text-[11px] space-y-1">
                                <div class="text-[10px] text-slate-400 font-semibold uppercase tracking-wider mb-1">Zkouškové otázky v okruhu (${qList.length}):</div>
                                ${qList.map((q, qIdx) => `
                                    <div class="text-slate-300 flex items-start gap-1.5 py-0.5">
                                        <span class="text-purple-400 font-mono text-[10px] shrink-0">${qIdx + 1}.</span>
                                        <span class="leading-tight">${escapeHtml(q.title)}</span>
                                    </div>
                                `).join("")}
                            </div>
                        `;
                    }

                    div.innerHTML = `
                        <div class="flex items-center justify-between gap-2">
                            <label class="flex items-center gap-2 flex-1 cursor-pointer select-none">
                                <input type="checkbox" ${isChecked ? 'checked' : ''} onchange="toggleTestsCategory('${escapeHtml(cat)}', this.checked)" class="accent-purple-500 cursor-pointer w-4 h-4 rounded">
                                <div class="flex items-center gap-1.5 flex-wrap">
                                    <span class="font-semibold text-slate-100 text-xs">${escapeHtml(cat)}</span>
                                    <span class="text-[10px] bg-slate-800 text-purple-300 px-1.5 py-0.5 rounded border border-slate-700 font-mono font-medium">${qList.length} ${qList.length === 1 ? 'otázka' : (qList.length < 5 ? 'otázky' : 'otázek')}</span>
                                </div>
                            </label>
                            <button type="button" onclick="toggleExpandTestsCategory('${escapeHtml(cat)}')" class="text-slate-400 hover:text-purple-300 text-xs px-1.5 py-0.5 rounded transition" title="Zobrazit otázky v kategorii">
                                ${isExpanded ? '▲ skrýt' : '▼ náhled'}
                            </button>
                        </div>
                        ${questionsPreviewHtml}
                    `;
                    container.appendChild(div);
                });
            }

            if (countBadge) countBadge.textContent = `${selectedCatCount} vybráno`;
            if (summaryCatCount) summaryCatCount.textContent = `${selectedCatCount}`;
            if (summaryQCount) summaryQCount.textContent = `${totalSelectedQuestions}`;

            if (syncBtn) {
                if (totalSelectedQuestions > 0) {
                    syncBtn.classList.remove("hidden");
                    const targetNum = Math.min(50, totalSelectedQuestions);
                    syncBtn.textContent = `Nastavit počet na ${targetNum}`;
                    syncBtn.onclick = () => setTestsCount(targetNum);
                } else {
                    syncBtn.classList.add("hidden");
                }
            }
        }

        function toggleTestsCategory(cat, isChecked) {
            testsCategoriesInitializedForProject = currentProject;
            if (isChecked) {
                selectedTestCategories.add(cat);
            } else {
                selectedTestCategories.delete(cat);
            }
            renderTestsCategoriesList();
        }

        function selectAllTestsCategories(selectAll) {
            const catMap = getAvailableCategoriesWithQuestions();
            const categories = Object.keys(catMap);
            testsCategoriesInitializedForProject = currentProject;
            if (selectAll) {
                categories.forEach(c => selectedTestCategories.add(c));
            } else {
                selectedTestCategories.clear();
            }
            renderTestsCategoriesList();
        }

        function toggleExpandTestsCategory(cat) {
            expandedTestCategory = (expandedTestCategory === cat) ? null : cat;
            renderTestsCategoriesList();
        }

        function syncTestCountToSelectedCategories() {
            const catMap = getAvailableCategoriesWithQuestions();
            let total = 0;
            selectedTestCategories.forEach(c => {
                total += (catMap[c] || []).length;
            });
            if (total > 0) {
                setTestsCount(Math.min(50, total));
            }
        }

        function renderTestsBatchTable() {
            const tbody = document.getElementById("testsBatchTableBody");
            const countLabel = document.getElementById("testsBatchSelectedCount");
            const searchInput = document.getElementById("testsBatchSearchInput");
            const topicFilter = document.getElementById("testsBatchTopicFilter");
            if (!tbody) return;

            if (topicFilter) {
                const curVal = topicFilter.value;
                const topics = [...new Set(questions.map(q => q.topic || "Všeobecné"))].sort();
                let optsHtml = '<option value="">Všechny okruhy</option>';
                topics.forEach(t => {
                    optsHtml += `<option value="${escapeHtml(t)}"${curVal === t ? ' selected' : ''}>${escapeHtml(t)}</option>`;
                });
                topicFilter.innerHTML = optsHtml;
            }

            if (!questions || questions.length === 0) {
                tbody.innerHTML = `<tr><td class="p-3 text-center text-slate-500 italic text-xs">V projektu zatím nejsou žádné otázky.</td></tr>`;
                if (countLabel) countLabel.textContent = "0 vybráno";
                return;
            }

            const filterText = (searchInput?.value || "").toLowerCase().trim();
            const filterTopic = topicFilter ? topicFilter.value : "";
            let selectedCount = 0;
            tbody.innerHTML = "";

            questions.forEach((q, idx) => {
                if (q.testsSelected === undefined) q.testsSelected = true;
                if (q.testsSelected) selectedCount++;

                if (filterTopic && (q.topic || "Všeobecné") !== filterTopic) {
                    return;
                }

                const fullTitle = `${idx + 1}. ${q.topic || ''} ${q.title}`.toLowerCase();
                if (filterText && !fullTitle.includes(filterText)) {
                    return;
                }

                const tr = document.createElement("tr");
                tr.className = "border-b border-slate-800 hover:bg-slate-850 transition cursor-pointer";
                tr.onclick = (e) => {
                    if (e.target.tagName !== "INPUT") {
                        toggleTestsQuestion(idx, !q.testsSelected);
                    }
                };

                const topicBadge = q.topic ? `<span class="text-[10px] bg-slate-800 text-purple-300 px-1.5 py-0.5 rounded border border-slate-700 mr-1 font-normal">${escapeHtml(q.topic)}</span>` : "";

                tr.innerHTML = `
                    <td class="p-2 text-center w-8" onclick="event.stopPropagation()">
                        <input type="checkbox" ${q.testsSelected ? 'checked' : ''} onchange="toggleTestsQuestion(${idx}, this.checked)" class="accent-purple-500 cursor-pointer w-3.5 h-3.5">
                    </td>
                    <td class="p-2 text-slate-200 text-xs font-medium">
                        <span class="text-slate-500 font-mono text-[10px] mr-1.5">${idx + 1}.</span>
                        ${topicBadge}
                        <span class="text-slate-200">${escapeHtml(q.title)}</span>
                    </td>
                `;
                tbody.appendChild(tr);
            });

            if (countLabel) countLabel.textContent = `${selectedCount} vybráno`;
        }

        function toggleTestsQuestion(idx, isChecked) {
            if (questions[idx]) {
                questions[idx].testsSelected = isChecked;
                renderTestsBatchTable();
            }
        }

        function selectAllTestsQuestions(selectAll) {
            questions.forEach(q => q.testsSelected = selectAll);
            renderTestsBatchTable();
        }

        function setTestsCount(val) {
            let num = parseInt(val);
            if (isNaN(num) || num < 1) num = 1;
            if (num > 50) num = 50;
            currentTestCount = num;

            const label = document.getElementById("testsCountLabel");
            const range = document.getElementById("testsCountRange");
            const input = document.getElementById("testsCountInput");
            if (label) label.textContent = `${num} otázek`;
            if (range) range.value = num;
            if (input) input.value = num;

            document.querySelectorAll(".test-count-btn").forEach(btn => {
                const bVal = parseInt(btn.textContent);
                if (bVal === num) {
                    btn.className = "test-count-btn py-1 text-xs font-bold rounded bg-purple-600 text-white border border-purple-500 transition";
                } else {
                    btn.className = "test-count-btn py-1 text-xs font-bold rounded bg-slate-900 border border-slate-700 hover:bg-slate-700 transition text-slate-300";
                }
            });
        }

        function setQuestionTypePreset(preset) {
            const s = document.getElementById("qTypeSingle");
            const m = document.getElementById("qTypeMulti");
            const o = document.getElementById("qTypeOpen");
            const c = document.getElementById("qTypeCase");
            const t = document.getElementById("qTypeTrueFalse");

            if (preset === 'abcd_only') {
                if (s) s.checked = true;
                if (m) m.checked = true;
                if (o) o.checked = false;
                if (c) c.checked = false;
                if (t) t.checked = false;
            } else if (preset === 'all') {
                if (s) s.checked = true;
                if (m) m.checked = true;
                if (o) o.checked = true;
                if (c) c.checked = true;
                if (t) t.checked = true;
            }
        }

        function setTestDifficulty(diff) {
            currentTestDifficulty = diff;
            const btnEasy = document.getElementById("btnDiffEasy");
            const btnNormal = document.getElementById("btnDiffNormal");
            const btnHard = document.getElementById("btnDiffHard");

            const activeClass = "py-1.5 rounded-md bg-purple-900/70 text-purple-200 transition text-center border border-purple-600 shadow-sm";
            const inactiveClass = "py-1.5 rounded-md text-slate-400 hover:text-slate-200 transition text-center bg-slate-900 border border-slate-700";

            if (btnEasy) btnEasy.className = diff === 'easy' ? activeClass : inactiveClass;
            if (btnNormal) btnNormal.className = diff === 'normal' ? activeClass : inactiveClass;
            if (btnHard) btnHard.className = diff === 'hard' ? activeClass : inactiveClass;
        }

        function setTestMode(mode) {
            currentTestMode = mode;
            const btnInstant = document.getElementById("btnModeInstant");
            const btnExam = document.getElementById("btnModeExam");

            const activeClass = "py-1.5 rounded-md bg-purple-900/70 text-purple-200 transition text-center border border-purple-600 shadow-sm";
            const inactiveClass = "py-1.5 rounded-md text-slate-400 hover:text-slate-200 transition text-center bg-slate-900 border border-slate-700";

            if (btnInstant) btnInstant.className = mode === 'instant' ? activeClass : inactiveClass;
            if (btnExam) btnExam.className = mode === 'exam' ? activeClass : inactiveClass;
        }

        function quickStartDefaultTest() {
            if (!questions || questions.length === 0) {
                alert(t("tests.noQuestionsInProject", "Projekt neobsahuje žádné otázky. Přidejte otázky v záložce Plánovač zkoušky."));
                return;
            }
            questions.forEach((q, i) => q.testsSelected = i < 10);
            renderTestsBatchTable();
            setTestsCount(Math.min(10, questions.length));
            startGenerateTest();
        }

        // --- GENERATÍVNÍ VOLÁNÍ TESTU ---
        async function startGenerateTest() {
            if (!currentProject) {
                alert(t("common.selectOrCreateProject", "Nejprve vyberte nebo založte studijní projekt."));
                return;
            }

            let selectedQuestionTitles = [];
            let selectedCategories = [];
            let categoriesMap = {};

            if (currentTestsMode === 'category') {
                selectedCategories = Array.from(selectedTestCategories);
                if (selectedCategories.length === 0) {
                    alert(t("tests.selectCategoryFirst", "Vyberte alespoň jednu kategorii / okruh pro test."));
                    return;
                }
                const catMap = getAvailableCategoriesWithQuestions();
                selectedCategories.forEach(cat => {
                    const qList = (catMap[cat] || []).map(q => q.title);
                    categoriesMap[cat] = qList;
                    selectedQuestionTitles = selectedQuestionTitles.concat(qList);
                });
            } else if (currentTestsMode === 'batch') {
                selectedQuestionTitles = questions.filter(q => q.testsSelected).map(q => q.title);
                if (selectedQuestionTitles.length === 0) {
                    alert(t("tests.selectQuestionFirst", "Vyberte alespoň jednu otázku ze seznamu."));
                    return;
                }
            } else {
                const customVal = document.getElementById("testsCustomQuestionInput")?.value?.trim();
                const selVal = document.getElementById("testsQuestionSelect")?.value?.trim();
                const chosen = customVal || selVal;
                if (!chosen) {
                    alert(t("tests.enterQuestionOrTopic", "Zadejte znění otázky nebo vyberte téma ze seznamu."));
                    return;
                }
                selectedQuestionTitles = [chosen];
            }

            const qTypes = [];
            if (document.getElementById("qTypeSingle")?.checked) qTypes.push("single_choice");
            if (document.getElementById("qTypeMulti")?.checked) qTypes.push("multi_choice");
            if (document.getElementById("qTypeOpen")?.checked) qTypes.push("open_ended");
            if (document.getElementById("qTypeCase")?.checked) qTypes.push("case_study");
            if (document.getElementById("qTypeTrueFalse")?.checked) qTypes.push("true_false");

            if (qTypes.length === 0) {
                qTypes.push("single_choice", "multi_choice");
            }

            const modelName = getSelectedModel("testsModelSelect", "testsModelCustomInput");
            const btn = document.getElementById("btnGenerateTest");
            if (btn) {
                btn.disabled = true;
                btn.innerHTML = `<span class="animate-spin">⏳</span> Generuji procvičující test (${currentTestCount} otázek)...`;
            }

            try {
                const res = await fetch("/api/tests/generate", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        project: currentProject,
                        questions: selectedQuestionTitles,
                        categories: selectedCategories,
                        categories_map: categoriesMap,
                        count: currentTestCount,
                        question_types: qTypes,
                        difficulty: currentTestDifficulty,
                        mode: currentTestMode,
                        gemini_model: modelName
                    })
                });

                const data = await res.json();
                if (res.ok) {
                    initActiveTest(data);
                    loadSavedTestsList();
                    updateDashboardStats();
                } else {
                    alert("Chyba při generování testu: " + (data.detail || "Neznámá chyba"));
                }
            } catch (err) {
                alert("Nelze navázat spojení se serverem: " + err.message);
            } finally {
                if (btn) {
                    btn.disabled = false;
                    btn.innerHTML = `<span>🚀</span> Vygenerovat procvičující test`;
                }
            }
        }

        function updateActiveThreadBanner() {
            const banner = document.getElementById("testActiveThreadIndicator");
            const titleEl = document.getElementById("activeThreadTitleText");
            const metaEl = document.getElementById("activeThreadMetaText");
            if (!banner) return;

            if (!activeTest) {
                banner.classList.add("hidden");
                return;
            }

            banner.classList.remove("hidden");
            if (titleEl) titleEl.textContent = activeTest.title || "Testové vlákno";

            if (metaEl) {
                const totalQ = activeTest.questions?.length || 0;
                const rounds = activeTest.rounds || 1;
                const cats = activeTest.categories?.length ? `${activeTest.categories.length} kat.` : "";
                let submittedCount = 0;
                Object.values(userAnswers || {}).forEach(ans => {
                    if (ans && ans.is_submitted) submittedCount++;
                });

                metaEl.innerHTML = `
                    <span>📊 ${totalQ} otázek</span>
                    <span>•</span>
                    <span>Kolo ${rounds}</span>
                    <span>•</span>
                    <span>${submittedCount}/${totalQ} zodpovězeno</span>
                    ${cats ? `<span>•</span> <span>🏷️ ${cats}</span>` : ''}
                `;
            }
        }

        function createNewTestThread() {
            activeTest = null;
            stopTestTimer();
            const emptyBox = document.getElementById("testEmptyStateBox");
            const runnerBox = document.getElementById("testRunnerBox");
            const resultsBox = document.getElementById("testResultsBox");
            const banner = document.getElementById("testActiveThreadIndicator");

            if (emptyBox) emptyBox.classList.remove("hidden");
            if (runnerBox) runnerBox.classList.add("hidden");
            if (resultsBox) resultsBox.classList.add("hidden");
            if (banner) banner.classList.add("hidden");

            setTestsCount(10);
            renderTestsCategoriesList();
            loadSavedTestsList();
        }

        function initActiveTest(testPayload, restoreAnswers = false) {
            const previousAnswers = (restoreAnswers && (testPayload?.result?.user_answers || activeTest?.result?.user_answers || userAnswers)) 
                ? { ...(testPayload?.result?.user_answers || activeTest?.result?.user_answers || userAnswers) } 
                : null;
            activeTest = testPayload;
            isReviewMode = false;

            if (!restoreAnswers || !previousAnswers || Object.keys(previousAnswers).length === 0) {
                userAnswers = {};
                (activeTest.questions || []).forEach(q => {
                    userAnswers[q.id] = {
                        selected_options: [],
                        open_answer: "",
                        open_eval: null,
                        is_submitted: false,
                        is_correct: false,
                        score: 0,
                        user_grade: ""
                    };
                });
                currentQuestionIndex = 0;
            } else {
                userAnswers = previousAnswers;
                // Ujistíme se, že všechny otázky (včetně nově dogenerovaných) mají záznam
                (activeTest.questions || []).forEach(q => {
                    if (!userAnswers[q.id]) {
                        userAnswers[q.id] = {
                            selected_options: [],
                            open_answer: "",
                            open_eval: null,
                            is_submitted: false,
                            is_correct: false,
                            score: 0,
                            user_grade: ""
                        };
                    }
                });

                // Posun na první nezodpovězenou otázku
                const firstUnanswered = (activeTest.questions || []).findIndex(q => {
                    const u = userAnswers[q.id];
                    return !u || !u.is_submitted;
                });
                currentQuestionIndex = firstUnanswered !== -1 ? firstUnanswered : 0;
            }

            startTestTimer(activeTest.result?.time_spent_seconds || 0);

            // Zobrazení Test Runneru
            const emptyBox = document.getElementById("testEmptyStateBox");
            const runnerBox = document.getElementById("testRunnerBox");
            const resultsBox = document.getElementById("testResultsBox");

            if (emptyBox) emptyBox.classList.add("hidden");
            if (resultsBox) resultsBox.classList.add("hidden");
            if (runnerBox) runnerBox.classList.remove("hidden");

            // Záhlaví testu
            const titleEl = document.getElementById("testRunnerTitleText");
            if (titleEl) titleEl.textContent = activeTest.title || "Procvičovací test";

            const diffBadge = document.getElementById("testRunnerDifficultyBadge");
            if (diffBadge) {
                const diffNames = { easy: "Lehčí", normal: "Standard", hard: "Těžší" };
                diffBadge.textContent = diffNames[activeTest.difficulty] || "Standard";
            }

            const modeBadge = document.getElementById("testRunnerModeBadge");
            if (modeBadge) {
                modeBadge.textContent = activeTest.mode === 'exam' ? t('tests.modeExam', 'Zkouškový mód') : t('tests.modeInstant', 'Okamžité vyhodnocení');
            }

            updateActiveThreadBanner();
            renderCurrentQuestion();
            renderQuestionsPalette();
        }

        // --- ČASOVAČ TESTU ---
        function startTestTimer(initialSeconds = 0) {
            stopTestTimer();
            testTimerSeconds = initialSeconds;
            updateTimerDisplay();
            testTimerInterval = setInterval(() => {
                testTimerSeconds++;
                updateTimerDisplay();
            }, 1000);
        }

        function stopTestTimer() {
            if (testTimerInterval) {
                clearInterval(testTimerInterval);
                testTimerInterval = null;
            }
        }

        function updateTimerDisplay() {
            const el = document.getElementById("testTimerText");
            if (el) el.textContent = formatSeconds(testTimerSeconds);
        }

        function formatSeconds(totalSec) {
            const m = Math.floor(totalSec / 60);
            const s = totalSec % 60;
            return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
        }

        // --- VYKRESLENÍ OTÁZKY V TEST RUNNERU ---
        function renderCurrentQuestion() {
            if (!activeTest || !activeTest.questions || activeTest.questions.length === 0) return;

            const q = activeTest.questions[currentQuestionIndex];
            const total = activeTest.questions.length;
            const uAns = userAnswers[q.id] || { selected_options: [], is_submitted: false };

            // Čítače nahoře
            const qCountEl = document.getElementById("testProgressCounterText");
            const qTotalEl = document.getElementById("testProgressTotalText");
            const qPercEl = document.getElementById("testProgressPercentageText");
            const barFill = document.getElementById("testProgressBarFill");

            if (qCountEl) qCountEl.textContent = currentQuestionIndex + 1;
            if (qTotalEl) qTotalEl.textContent = total;
            const perc = Math.round(((currentQuestionIndex + 1) / total) * 100);
            if (qPercEl) qPercEl.textContent = `${perc}%`;
            if (barFill) barFill.style.width = `${perc}%`;

            // Skóre průběžné
            updateRunnerScoreBadges();

            // Typ otázky a téma
            const typeBadge = document.getElementById("currentQuestionTypeBadge");
            const topicBadge = document.getElementById("testRunnerTopicBadge");
            if (topicBadge) topicBadge.textContent = q.topic || "--";

            const typeNames = {
                single_choice: "🔘 ABCD – Jedna správná",
                multi_choice: "☑️ ABCD – Jedna nebo více správných",
                open_ended: "📝 Otevřená otázka (Anki % shoda)",
                case_study: "🩺 Klinická kazuistika",
                true_false: "⚖️ Pravda / Nepravda"
            };
            if (typeBadge) typeBadge.innerHTML = typeNames[q.type] || "Otázka";

            // Kazuistika
            const scenarioBox = document.getElementById("currentScenarioContainer");
            const scenarioText = document.getElementById("currentScenarioText");
            if (q.scenario && q.scenario.trim()) {
                if (scenarioBox) scenarioBox.classList.remove("hidden");
                if (scenarioText) scenarioText.innerHTML = renderMarkdownWithKaTeX(q.scenario);
            } else {
                if (scenarioBox) scenarioBox.classList.add("hidden");
            }

            // Znění otázky
            const qTextEl = document.getElementById("currentQuestionText");
            if (qTextEl) qTextEl.innerHTML = renderMarkdownWithKaTeX(q.question);

            // Odpovědi kontejner
            const answersBox = document.getElementById("currentAnswersContainer");
            const openEvalBox = document.getElementById("openAnswerEvaluationBox");
            if (openEvalBox) openEvalBox.classList.add("hidden");

            const isSubmitted = uAns.is_submitted || isReviewMode || (activeTest.mode === 'exam' && activeTest.result?.completed);

            if (answersBox) {
                answersBox.innerHTML = "";

                if (q.type === 'single_choice' || q.type === 'case_study' || q.type === 'true_false') {
                    const opts = q.options || [];
                    opts.forEach(opt => {
                        const isSelected = uAns.selected_options.includes(opt.id);
                        const isCorrectOpt = (q.correct_answers || []).includes(opt.id);

                        let cardStyle = "bg-slate-900 border-slate-700 hover:border-purple-500 hover:bg-slate-850 text-slate-200";
                        let badgeStyle = "bg-slate-800 text-purple-300 border-slate-700";

                        if (isSelected && !isSubmitted) {
                            cardStyle = "bg-purple-950/70 border-purple-500 text-white shadow-sm";
                            badgeStyle = "bg-purple-600 text-white border-purple-400";
                        } else if (isSubmitted) {
                            if (isCorrectOpt) {
                                cardStyle = "bg-emerald-950/60 border-emerald-500 text-emerald-200 font-semibold";
                                badgeStyle = "bg-emerald-600 text-white border-emerald-400";
                            } else if (isSelected && !isCorrectOpt) {
                                cardStyle = "bg-red-950/60 border-red-500 text-red-200 line-through opacity-80";
                                badgeStyle = "bg-red-600 text-white border-red-400";
                            } else {
                                cardStyle = "bg-slate-900/60 border-slate-800 text-slate-400 opacity-60";
                            }
                        }

                        const optDiv = document.createElement("div");
                        optDiv.className = `p-3 rounded-xl border flex items-center gap-3 transition cursor-pointer ${cardStyle}`;
                        if (!isSubmitted) {
                            optDiv.onclick = () => selectSingleChoiceOption(opt.id);
                        }

                        optDiv.innerHTML = `
                            <span class="w-6 h-6 rounded-lg font-mono font-bold text-xs flex items-center justify-center border shrink-0 ${badgeStyle}">${opt.id}</span>
                            <span class="text-xs leading-relaxed flex-1">${renderMarkdownWithKaTeX(opt.text)}</span>
                            ${isSubmitted && isCorrectOpt ? '<span class="text-emerald-400 font-bold text-xs">✓ Správně</span>' : ''}
                            ${isSubmitted && isSelected && !isCorrectOpt ? '<span class="text-red-400 font-bold text-xs">✕ Vaše volba</span>' : ''}
                        `;
                        answersBox.appendChild(optDiv);
                    });

                } else if (q.type === 'multi_choice') {
                    const hintDiv = document.createElement("div");
                    hintDiv.className = "text-[11px] text-purple-300 bg-purple-950/40 p-2 rounded-lg border border-purple-800/40 mb-2 flex items-center gap-1.5";
                    hintDiv.innerHTML = `<span>ℹ️</span> <strong>Více správných možností:</strong> Může být správná 1, 2, 3 nebo i všechny volby.`;
                    answersBox.appendChild(hintDiv);

                    const opts = q.options || [];
                    opts.forEach(opt => {
                        const isSelected = uAns.selected_options.includes(opt.id);
                        const isCorrectOpt = (q.correct_answers || []).includes(opt.id);

                        let cardStyle = "bg-slate-900 border-slate-700 hover:border-purple-500 hover:bg-slate-850 text-slate-200";
                        let checkboxStyle = "accent-purple-500";

                        if (isSelected && !isSubmitted) {
                            cardStyle = "bg-purple-950/70 border-purple-500 text-white shadow-sm";
                        } else if (isSubmitted) {
                            if (isCorrectOpt && isSelected) {
                                cardStyle = "bg-emerald-950/60 border-emerald-500 text-emerald-200 font-semibold";
                            } else if (isCorrectOpt && !isSelected) {
                                cardStyle = "bg-emerald-950/30 border-dashed border-emerald-500 text-emerald-300";
                            } else if (!isCorrectOpt && isSelected) {
                                cardStyle = "bg-red-950/60 border-red-500 text-red-200 line-through opacity-80";
                            } else {
                                cardStyle = "bg-slate-900/60 border-slate-800 text-slate-400 opacity-60";
                            }
                        }

                        const optDiv = document.createElement("div");
                        optDiv.className = `p-3 rounded-xl border flex items-center gap-3 transition cursor-pointer ${cardStyle}`;
                        if (!isSubmitted) {
                            optDiv.onclick = () => toggleMultiChoiceOption(opt.id);
                        }

                        optDiv.innerHTML = `
                            <input type="checkbox" ${isSelected ? 'checked' : ''} ${isSubmitted ? 'disabled' : ''} class="w-4 h-4 cursor-pointer shrink-0 ${checkboxStyle}">
                            <span class="w-5 h-5 rounded font-mono font-bold text-[11px] flex items-center justify-center bg-slate-800 text-purple-300 shrink-0 border border-slate-700">${opt.id}</span>
                            <span class="text-xs leading-relaxed flex-1">${renderMarkdownWithKaTeX(opt.text)}</span>
                            ${isSubmitted && isCorrectOpt ? '<span class="text-emerald-400 font-bold text-xs">✓ Správná</span>' : ''}
                            ${isSubmitted && !isCorrectOpt && isSelected ? '<span class="text-red-400 font-bold text-xs">✕ Chybná volba</span>' : ''}
                        `;
                        answersBox.appendChild(optDiv);
                    });

                } else if (q.type === 'open_ended') {
                    const textContainer = document.createElement("div");
                    textContainer.className = "space-y-3";
                    textContainer.innerHTML = `
                        <div class="space-y-1">
                            <label class="text-xs text-slate-300 font-semibold flex items-center gap-1.5">
                                <span>✍️</span> Vaše odpověď:
                            </label>
                            <textarea id="openAnswerInput" rows="3" ${isSubmitted ? 'disabled' : ''} placeholder="Napište svou odpověď, klíčová kritéria, lék volby, diagnostiku..." class="w-full p-3 bg-slate-950 border border-slate-700 rounded-xl text-xs text-white focus:outline-none focus:border-purple-500 leading-relaxed font-sans">${uAns.open_answer || ""}</textarea>
                        </div>
                    `;
                    answersBox.appendChild(textContainer);

                    if (!isSubmitted) {
                        const directInput = textContainer.querySelector("#openAnswerInput");
                        if (directInput) {
                            directInput.oninput = (e) => {
                                uAns.open_answer = e.target.value;
                            };
                        }
                    }

                    if (isSubmitted && uAns.open_eval) {
                        renderOpenEvaluationDetails(uAns.open_eval, q);
                    }
                }
            }

            // Vysvětlení a citace
            const explContainer = document.getElementById("currentExplanationContainer");
            const explText = document.getElementById("currentExplanationText");
            const quoteBox = document.getElementById("currentExplanationQuoteBox");
            const srcBadge = document.getElementById("currentExplanationSourceBadge");

            if (isSubmitted && (activeTest.mode === 'instant' || isReviewMode || activeTest.result?.completed)) {
                if (explContainer) explContainer.classList.remove("hidden");
                if (explText) explText.innerHTML = renderMarkdownWithKaTeX(q.explanation || "Vysvětlení není k dispozici.");

                if (q.source_ref || q.source_file) {
                    if (srcBadge) srcBadge.textContent = `${q.source_ref || ''} ${q.source_file ? '(' + q.source_file + ')' : ''}`;
                } else if (srcBadge) {
                    srcBadge.textContent = "";
                }

                if (q.source_quote && q.source_quote.trim()) {
                    if (quoteBox) {
                        quoteBox.classList.remove("hidden");
                        quoteBox.innerHTML = `💬 <em>„${q.source_quote}“</em>`;
                    }
                } else if (quoteBox) {
                    quoteBox.classList.add("hidden");
                }
            } else {
                if (explContainer) explContainer.classList.add("hidden");
            }

            // Tlačítka dole
            const btnPrev = document.getElementById("btnTestPrev");
            const btnNext = document.getElementById("btnTestNext");
            const btnSubmit = document.getElementById("btnTestSubmitAnswer");
            const btnFinish = document.getElementById("btnTestFinish");

            if (btnPrev) btnPrev.disabled = currentQuestionIndex === 0;

            const isLast = currentQuestionIndex === total - 1;

            if (activeTest.mode === 'instant' && !isReviewMode) {
                if (!uAns.is_submitted) {
                    if (btnSubmit) btnSubmit.classList.remove("hidden");
                    if (btnNext) btnNext.classList.add("hidden");
                    if (btnFinish) btnFinish.classList.add("hidden");
                } else {
                    if (btnSubmit) btnSubmit.classList.add("hidden");
                    if (isLast) {
                        if (btnNext) btnNext.classList.add("hidden");
                        if (btnFinish) btnFinish.classList.remove("hidden");
                    } else {
                        if (btnNext) btnNext.classList.remove("hidden");
                        if (btnFinish) btnFinish.classList.add("hidden");
                    }
                }
            } else if (activeTest.mode === 'exam' && !isReviewMode) {
                if (btnSubmit) btnSubmit.classList.add("hidden");
                if (isLast) {
                    if (btnNext) btnNext.classList.add("hidden");
                    if (btnFinish) btnFinish.classList.remove("hidden");
                } else {
                    if (btnNext) btnNext.classList.remove("hidden");
                    if (btnFinish) btnFinish.classList.add("hidden");
                }
            } else if (isReviewMode) {
                if (btnSubmit) btnSubmit.classList.add("hidden");
                if (isLast) {
                    if (btnNext) btnNext.classList.add("hidden");
                    if (btnFinish) {
                        btnFinish.classList.remove("hidden");
                        btnFinish.innerHTML = `<span>📊</span> Zpět k výsledkům`;
                    }
                } else {
                    if (btnNext) btnNext.classList.remove("hidden");
                    if (btnFinish) btnFinish.classList.add("hidden");
                }
            }

            renderQuestionsPalette();
        }

        function renderOpenEvaluationDetails(ev, q) {
            const openEvalBox = document.getElementById("openAnswerEvaluationBox");
            if (!openEvalBox) return;

            openEvalBox.classList.remove("hidden");

            let gradeBorder = "border-emerald-500 bg-emerald-950/30";
            let gradeColor = "text-emerald-400";
            if (ev.match_percentage < 50) {
                gradeBorder = "border-red-500 bg-red-950/30";
                gradeColor = "text-red-400";
            } else if (ev.match_percentage < 80) {
                gradeBorder = "border-amber-500 bg-amber-950/30";
                gradeColor = "text-amber-400";
            }

            openEvalBox.className = `p-4 rounded-xl border space-y-3 ${gradeBorder}`;

            let matchedTags = (ev.matched_key_points || []).map(kp => `<span class="bg-emerald-900/60 text-emerald-300 text-[11px] px-2 py-0.5 rounded border border-emerald-700">✓ ${kp}</span>`).join(" ");
            let missingTags = (ev.missing_key_points || []).map(kp => `<span class="bg-red-900/60 text-red-300 text-[11px] px-2 py-0.5 rounded border border-red-700">✕ ${kp}</span>`).join(" ");

            openEvalBox.innerHTML = `
                <div class="flex items-center justify-between border-b border-slate-700/60 pb-2">
                    <div class="flex items-center gap-2">
                        <span class="text-xs font-bold uppercase tracking-wider text-slate-300">Anki hodnocení shody:</span>
                        <span class="text-base font-extrabold font-mono ${gradeColor}">${ev.match_percentage} % shoda</span>
                    </div>
                    <span class="text-xs font-semibold ${gradeColor}">${ev.feedback || ''}</span>
                </div>

                ${(matchedTags || missingTags) ? `
                <div class="space-y-1 text-xs">
                    <span class="text-slate-400 text-[11px] font-bold block uppercase">Klíčové koncepty:</span>
                    <div class="flex flex-wrap gap-1.5 pt-0.5">
                        ${matchedTags}
                        ${missingTags}
                    </div>
                </div>` : ''}

                <div class="p-2.5 bg-slate-950/80 rounded-lg border border-slate-800 text-xs space-y-1">
                    <span class="text-[11px] font-bold text-amber-400 block uppercase">Vzorová odpověď:</span>
                    <p class="text-slate-200 leading-relaxed">${renderMarkdownWithKaTeX(q.model_answer || q.explanation || "Není k dispozici.")}</p>
                </div>

                <!-- Anki tlačítka pro sebereflexi -->
                <div class="pt-2 border-t border-slate-700/60 space-y-1.5">
                    <div class="flex justify-between items-center text-[11px] text-slate-400">
                        <span>Upravit známku podle pocitu (Anki Spaced Repetition):</span>
                    </div>
                    <div class="grid grid-cols-4 gap-2 text-xs font-bold">
                        <button type="button" onclick="rateOpenAnswerAnki('again', 0)" class="py-1.5 rounded-lg bg-red-950 hover:bg-red-900 text-red-300 border border-red-800 transition">🔴 Znovu (0%)</button>
                        <button type="button" onclick="rateOpenAnswerAnki('hard', 50)" class="py-1.5 rounded-lg bg-amber-950 hover:bg-amber-900 text-amber-300 border border-amber-800 transition">🟠 Těžké (50%)</button>
                        <button type="button" onclick="rateOpenAnswerAnki('good', 80)" class="py-1.5 rounded-lg bg-emerald-950 hover:bg-emerald-900 text-emerald-300 border border-emerald-800 transition">🟢 Dobré (80%)</button>
                        <button type="button" onclick="rateOpenAnswerAnki('easy', 100)" class="py-1.5 rounded-lg bg-sky-950 hover:bg-sky-900 text-sky-300 border border-sky-800 transition">🔵 Snadné (100%)</button>
                    </div>
                </div>
            `;
        }

        function rateOpenAnswerAnki(grade, scorePercent) {
            if (!activeTest) return;
            const q = activeTest.questions[currentQuestionIndex];
            const uAns = userAnswers[q.id];
            if (!uAns) return;

            uAns.user_grade = grade;
            uAns.score = scorePercent / 100;
            uAns.is_correct = scorePercent >= 70;
            if (uAns.open_eval) {
                uAns.open_eval.match_percentage = scorePercent;
                uAns.open_eval.grade = grade;
            }
            renderOpenEvaluationDetails(uAns.open_eval, q);
            updateRunnerScoreBadges();
            renderQuestionsPalette();
        }

        // --- MAPA OTÁZEK PALETA ---
        function renderQuestionsPalette() {
            const palette = document.getElementById("testQuestionsPalette");
            if (!palette || !activeTest) return;

            palette.innerHTML = "";
            (activeTest.questions || []).forEach((q, idx) => {
                const uAns = userAnswers[q.id] || {};
                const isCurrent = idx === currentQuestionIndex;

                let pillColor = "bg-slate-900 text-slate-400 border-slate-700";

                if (uAns.is_submitted || (activeTest.mode === 'exam' && uAns.selected_options?.length > 0)) {
                    if (activeTest.mode === 'exam' && !activeTest.result?.completed) {
                        pillColor = "bg-purple-900/60 text-purple-200 border-purple-600";
                    } else if (uAns.is_correct) {
                        pillColor = "bg-emerald-950 text-emerald-300 border-emerald-700";
                    } else if (uAns.score > 0 && uAns.score < 1) {
                        pillColor = "bg-amber-950 text-amber-300 border-amber-700";
                    } else {
                        pillColor = "bg-red-950 text-red-300 border-red-700";
                    }
                }

                if (isCurrent) {
                    pillColor += " ring-2 ring-purple-400 font-extrabold scale-110";
                }

                const btn = document.createElement("button");
                btn.type = "button";
                btn.className = `w-7 h-7 rounded-lg text-xs font-mono font-bold flex items-center justify-center border transition ${pillColor}`;
                btn.textContent = idx + 1;
                btn.onclick = () => jumpToQuestion(idx);
                palette.appendChild(btn);
            });
        }

        function updateRunnerScoreBadges() {
            let correct = 0;
            let wrong = 0;
            Object.values(userAnswers).forEach(a => {
                if (a.is_submitted || activeTest.result?.completed) {
                    if (a.is_correct) correct++;
                    else wrong++;
                }
            });
            const cEl = document.getElementById("testScoreCorrect");
            const wEl = document.getElementById("testScoreWrong");
            if (cEl) cEl.textContent = `✅ ${correct}`;
            if (wEl) wEl.textContent = `❌ ${wrong}`;
        }

        function selectSingleChoiceOption(optId) {
            if (!activeTest) return;
            const q = activeTest.questions[currentQuestionIndex];
            if (!userAnswers[q.id]) userAnswers[q.id] = { selected_options: [], is_submitted: false };

            userAnswers[q.id].selected_options = [optId];
            renderCurrentQuestion();
        }

        function toggleMultiChoiceOption(optId) {
            if (!activeTest) return;
            const q = activeTest.questions[currentQuestionIndex];
            if (!userAnswers[q.id]) userAnswers[q.id] = { selected_options: [], is_submitted: false };

            const list = userAnswers[q.id].selected_options;
            const pos = list.indexOf(optId);
            if (pos >= 0) list.splice(pos, 1);
            else list.push(optId);

            renderCurrentQuestion();
        }

        // --- SUBMIT JEDNÉ ODPOVĚDI ---
        async function submitCurrentAnswer() {
            if (!activeTest) return;
            const q = activeTest.questions[currentQuestionIndex];
            const uAns = userAnswers[q.id];

            if (q.type === 'single_choice' || q.type === 'case_study' || q.type === 'true_false') {
                if (!uAns.selected_options || uAns.selected_options.length === 0) {
                    alert(t("tests.selectSingleChoice", "Zvolte prosím jednu z nabízených odpovědí."));
                    return;
                }
                const correct = (q.correct_answers || [])[0];
                uAns.is_correct = (uAns.selected_options[0] === correct);
                uAns.score = uAns.is_correct ? 1 : 0;
                uAns.is_submitted = true;

            } else if (q.type === 'multi_choice') {
                if (!uAns.selected_options || uAns.selected_options.length === 0) {
                    alert(t("tests.selectMultipleChoice", "Vyberte alespoň jednu možnost."));
                    return;
                }
                const expected = new Set(q.correct_answers || []);
                const given = new Set(uAns.selected_options);

                // Shoda množin
                const isExact = expected.size === given.size && [...expected].every(x => given.has(x));
                const correctPicks = [...given].filter(x => expected.has(x)).length;
                const falsePicks = [...given].filter(x => !expected.has(x)).length;

                uAns.is_correct = isExact;
                uAns.score = Math.max(0, (correctPicks - falsePicks) / Math.max(1, expected.size));
                uAns.is_submitted = true;

            } else if (q.type === 'open_ended') {
                const textarea = document.getElementById("openAnswerInput");
                const text = textarea ? textarea.value.trim() : (uAns.open_answer || "").trim();
                if (!text) {
                    alert(t("tests.typeWrittenAnswer", "Napište prosím svou odpověď do textového pole."));
                    return;
                }
                uAns.open_answer = text;

                // Client-side vyhodnocení shody podle klíčových bodů
                const ev = evaluateOpenAnswerClient(text, q.model_answer || q.explanation, q.key_points || []);
                uAns.open_eval = ev;
                uAns.score = ev.match_percentage / 100;
                uAns.is_correct = ev.match_percentage >= 70;
                uAns.is_submitted = true;
            }

            renderCurrentQuestion();
        }

        // --- KLIENTSKÝ ALGORITMUS HODNOCENÍ ANKI % SHODY ---
        function evaluateOpenAnswerClient(userText, modelAnswer, keyPoints) {
            if (!userText || !userText.trim()) {
                return {
                    match_percentage: 0,
                    matched_key_points: [],
                    missing_key_points: keyPoints || [],
                    grade: "again",
                    feedback: "Byla odevzdána prázdná odpověď."
                };
            }

            const cleanStr = (s) => (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
            const normUser = cleanStr(userText);
            const userWords = new Set(normUser.split(" "));

            const matchedKp = [];
            const missingKp = [];

            (keyPoints || []).forEach(kp => {
                const normKp = cleanStr(kp);
                const kpWords = normKp.split(" ").filter(w => w.length > 2);

                if (normUser.includes(normKp)) {
                    matchedKp.append ? matchedKp.append(kp) : matchedKp.push(kp);
                } else if (kpWords.length > 0 && kpWords.every(w => normUser.includes(w))) {
                    matchedKp.push(kp);
                } else if (kpWords.length > 0 && kpWords.filter(w => userWords.has(w)).length >= Math.ceil(kpWords.length * 0.6)) {
                    matchedKp.push(kp);
                } else {
                    missingKp.push(kp);
                }
            });

            const kpScore = keyPoints && keyPoints.length > 0 ? (matchedKp.length / keyPoints.length) : 0;

            const normModel = cleanStr(modelAnswer);
            const modelWords = normModel.split(" ").filter(w => w.length > 2);
            let overlapCount = 0;
            modelWords.forEach(w => { if (userWords.has(w)) overlapCount++; });
            const modelOverlap = modelWords.length > 0 ? (overlapCount / modelWords.length) : 0;

            let finalRatio = keyPoints && keyPoints.length > 0 ? (kpScore * 0.65 + modelOverlap * 0.35) : modelOverlap;
            const percentage = Math.min(100, Math.max(0, Math.round(finalRatio * 100)));

            let grade = "again";
            let feedback = "Vyžaduje zopakování.";
            if (percentage >= 80) { grade = "easy"; feedback = "Výborná odpověď! Zahrnuje medicínská kritéria."; }
            else if (percentage >= 60) { grade = "good"; feedback = "Dobrá odpověď. Základní koncepty jsou správné."; }
            else if (percentage >= 40) { grade = "hard"; feedback = "Částečně správná odpověď."; }

            return {
                match_percentage: percentage,
                matched_key_points: matchedKp,
                missing_key_points: missingKp,
                grade,
                feedback
            };
        }

        function goToPrevQuestion() {
            if (currentQuestionIndex > 0) {
                currentQuestionIndex--;
                renderCurrentQuestion();
            }
        }

        function goToNextQuestion() {
            if (!activeTest || !activeTest.questions) return;
            if (currentQuestionIndex < activeTest.questions.length - 1) {
                currentQuestionIndex++;
                renderCurrentQuestion();
            }
        }

        function jumpToQuestion(idx) {
            if (!activeTest || !activeTest.questions) return;
            if (idx >= 0 && idx < activeTest.questions.length) {
                currentQuestionIndex = idx;
                renderCurrentQuestion();
            }
        }

        // --- DOKONČENÍ TESTU A ULOŽENÍ VÝSLEDKŮ ---
        async function finishCurrentTest() {
            stopTestTimer();
            if (!activeTest || !activeTest.questions) return;

            // U zkouškového módu zkontrolujeme/vyhodnotíme nezodpovězené
            activeTest.questions.forEach(q => {
                const uAns = userAnswers[q.id];
                if (!uAns.is_submitted) {
                    if (q.type === 'single_choice' || q.type === 'case_study' || q.type === 'true_false') {
                        const correct = (q.correct_answers || [])[0];
                        uAns.is_correct = uAns.selected_options && (uAns.selected_options[0] === correct);
                        uAns.score = uAns.is_correct ? 1 : 0;
                    } else if (q.type === 'multi_choice') {
                        const expected = new Set(q.correct_answers || []);
                        const given = new Set(uAns.selected_options || []);
                        uAns.is_correct = expected.size === given.size && [...expected].every(x => given.has(x));
                        uAns.score = uAns.is_correct ? 1 : 0;
                    } else if (q.type === 'open_ended') {
                        if (!uAns.open_eval) {
                            uAns.open_eval = evaluateOpenAnswerClient(uAns.open_answer || "", q.model_answer || q.explanation, q.key_points || []);
                            uAns.score = uAns.open_eval.match_percentage / 100;
                            uAns.is_correct = uAns.open_eval.match_percentage >= 70;
                        }
                    }
                    uAns.is_submitted = true;
                }
            });

            // Spočtení celkových bodů
            const total = activeTest.questions.length;
            let sumScore = 0;
            let correctCount = 0;
            let partialCount = 0;
            let wrongCount = 0;

            activeTest.questions.forEach(q => {
                const uAns = userAnswers[q.id];
                sumScore += (uAns.score || 0);
                if (uAns.is_correct) correctCount++;
                else if (uAns.score > 0) partialCount++;
                else wrongCount++;
            });

            const percentage = Math.round((sumScore / total) * 100);

            const resultPayload = {
                completed: true,
                score: Math.round(sumScore * 10) / 10,
                max_score: total,
                percentage: percentage,
                correct_count: correctCount,
                partial_count: partialCount,
                wrong_count: wrongCount,
                time_spent_seconds: testTimerSeconds,
                user_answers: userAnswers
            };

            activeTest.result = resultPayload;

            // Uložíme na server
            if (activeTest.filename) {
                try {
                    await fetch(`/api/tests/${encodeURIComponent(activeTest.filename)}/result`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(resultPayload)
                    });
                } catch (e) {
                    console.warn("Nepodařilo se uložit výsledek testu:", e);
                }
            }

            renderTestResults();
            loadSavedTestsList();
            updateDashboardStats();
        }

        // --- ZOBRAZENÍ VÝSLEDKŮ TESTU ---
        function renderTestResults() {
            const runnerBox = document.getElementById("testRunnerBox");
            const resultsBox = document.getElementById("testResultsBox");
            if (runnerBox) runnerBox.classList.add("hidden");
            if (resultsBox) resultsBox.classList.remove("hidden");

            const res = activeTest.result || {};
            const perc = res.percentage !== undefined ? res.percentage : 0;

            const percEl = document.getElementById("testResultsPercentage");
            const ptsEl = document.getElementById("testResultsPoints");
            const circleEl = document.getElementById("testResultsScoreCircle");
            const titleEl = document.getElementById("testResultsGradeTitle");
            const descEl = document.getElementById("testResultsGradeDesc");

            if (percEl) percEl.textContent = `${perc}%`;
            if (ptsEl) ptsEl.textContent = `${res.score || 0} / ${res.max_score || activeTest.questions.length} b`;

            if (circleEl) {
                if (perc >= 80) circleEl.className = "w-24 h-24 rounded-full border-4 border-emerald-500 flex flex-col items-center justify-center mx-auto shadow-lg bg-slate-900";
                else if (perc >= 60) circleEl.className = "w-24 h-24 rounded-full border-4 border-amber-500 flex flex-col items-center justify-center mx-auto shadow-lg bg-slate-900";
                else circleEl.className = "w-24 h-24 rounded-full border-4 border-rose-500 flex flex-col items-center justify-center mx-auto shadow-lg bg-slate-900";
            }

            if (titleEl && descEl) {
                if (perc >= 90) {
                    titleEl.textContent = "Vynikající výkon! 🌟";
                    descEl.textContent = "Otázky máte skvěle zvládnuté. Témata jsou pevně uložena pro zkoušku.";
                } else if (perc >= 75) {
                    titleEl.textContent = "Úspěšně splněno! 🎉";
                    descEl.textContent = "Pevný základ pro zkoušku. Doporučujeme krátký zpětný průchod chyb.";
                } else if (perc >= 50) {
                    titleEl.textContent = "Částečně splněno ⚠️";
                    descEl.textContent = "Některá kritéria a chytáky vám ještě unikají. Využijte tlačítko 'Procvičit pouze chybné otázky'.";
                } else {
                    titleEl.textContent = "Vyžaduje zopakování 📚";
                    descEl.textContent = "Doporučujeme projít podrobné vysvětlení a zopakovat procvičování látky.";
                }
            }

            // Metriky
            const corrEl = document.getElementById("testResCorrectCount");
            const partEl = document.getElementById("testResPartialCount");
            const wrongEl = document.getElementById("testResWrongCount");
            const timeEl = document.getElementById("testResTimeCount");

            if (corrEl) corrEl.textContent = res.correct_count || 0;
            if (partEl) partEl.textContent = res.partial_count || 0;
            if (wrongEl) wrongEl.textContent = res.wrong_count || 0;
            if (timeEl) timeEl.textContent = formatSeconds(res.time_spent_seconds || 0);

            // Tlačítko 'Procvičit pouze chyby' viditelnost
            const btnMistakes = document.getElementById("btnRepeatMistakes");
            if (btnMistakes) {
                btnMistakes.style.display = (res.wrong_count > 0 || res.partial_count > 0) ? "inline-flex" : "none";
            }

            // Paleta otázek ve výsledcích
            const palette = document.getElementById("testResultsPalette");
            if (palette) {
                palette.innerHTML = "";
                activeTest.questions.forEach((q, idx) => {
                    const uAns = userAnswers[q.id] || {};
                    let pillColor = "bg-slate-900 text-slate-400 border-slate-700";

                    if (uAns.is_correct) pillColor = "bg-emerald-950 text-emerald-300 border-emerald-600 hover:bg-emerald-900";
                    else if (uAns.score > 0) pillColor = "bg-amber-950 text-amber-300 border-amber-600 hover:bg-amber-900";
                    else pillColor = "bg-rose-950 text-rose-300 border-rose-600 hover:bg-rose-900";

                    const btn = document.createElement("button");
                    btn.type = "button";
                    btn.className = `p-2 px-3 rounded-lg text-xs font-mono font-bold flex items-center gap-1.5 border transition cursor-pointer ${pillColor}`;
                    btn.innerHTML = `<span>#${idx + 1}</span> <span>${uAns.is_correct ? '✓' : (uAns.score > 0 ? '~' : '✕')}</span>`;
                    btn.onclick = () => {
                        startTestReviewMode();
                        jumpToQuestion(idx);
                    };
                    palette.appendChild(btn);
                });
            }
        }

        // --- ZPĚTNÝ PRŮCHOD OTÁZKAMI (REVIEW MODE) ---
        function startTestReviewMode() {
            if (!activeTest) return;
            isReviewMode = true;
            stopTestTimer();

            const runnerBox = document.getElementById("testRunnerBox");
            const resultsBox = document.getElementById("testResultsBox");
            if (resultsBox) resultsBox.classList.add("hidden");
            if (runnerBox) runnerBox.classList.remove("hidden");

            currentQuestionIndex = 0;
            renderCurrentQuestion();
        }

        // --- OPAKOVÁNÍ POUZE CHYBNÝCH OTÁZEK ---
        function repeatMistakesTest() {
            if (!activeTest || !activeTest.questions) return;

            const mistakenQuestions = activeTest.questions.filter(q => {
                const uAns = userAnswers[q.id];
                return !uAns || !uAns.is_correct;
            });

            if (mistakenQuestions.length === 0) {
                alert(t("tests.noErrorsCelebrate", "V tomto testu jste neměli žádné chyby! Skvělá práce."));
                return;
            }

            const subPayload = {
                id: `test_mistakes_${Date.now()}`,
                project: activeTest.project,
                title: `${activeTest.title} (Opakování chyb - ${mistakenQuestions.length} ks)`,
                difficulty: activeTest.difficulty,
                mode: 'instant',
                question_types: activeTest.question_types,
                topics: activeTest.topics,
                sources: activeTest.sources,
                questions: mistakenQuestions.map((q, i) => ({ ...q, id: i + 1 })),
                result: { completed: false, score: 0, max_score: mistakenQuestions.length, percentage: 0, user_answers: {}, time_spent_seconds: 0 }
            };

            initActiveTest(subPayload, false);
        }

        // --- ZNOVU SPUSTIT CELÝ TEST ---
        function retakeCurrentTest() {
            if (!activeTest) return;
            initActiveTest(activeTest, false);
        }

        // --- DOGENEROVÁNÍ DALŠÍCH OTÁZEK ---
        function setFollowupDifficulty(diff) {
            followupDifficultyShift = diff;
            const bEasier = document.getElementById("btnFollowupDiffEasier");
            const bSame = document.getElementById("btnFollowupDiffSame");
            const bHarder = document.getElementById("btnFollowupDiffHarder");

            const activeClass = "py-1 rounded bg-purple-900/70 border border-purple-600 text-purple-200 transition text-center text-[11px] shadow-sm";
            const inactiveClass = "py-1 rounded bg-slate-900 border border-slate-700 text-slate-400 hover:text-white transition text-center text-[11px]";

            if (bEasier) bEasier.className = diff === 'easier' ? activeClass : inactiveClass;
            if (bSame) bSame.className = diff === 'same' ? activeClass : inactiveClass;
            if (bHarder) bHarder.className = diff === 'harder' ? activeClass : inactiveClass;
        }

        function setFollowupCount(cnt) {
            let num = parseInt(cnt);
            if (isNaN(num) || num < 1) num = 1;
            if (num > 30) num = 30;
            followupQuestionsCount = num;

            const lbl = document.getElementById("followupCountLabel");
            const inp = document.getElementById("followupCountInput");
            if (lbl) lbl.textContent = `${num} ks`;
            if (inp) inp.value = num;

            document.querySelectorAll(".followup-cnt-btn").forEach(btn => {
                const bVal = parseInt(btn.textContent);
                if (bVal === num) btn.className = "followup-cnt-btn flex-1 py-1 rounded bg-purple-600 text-white font-bold text-[11px] border border-purple-500";
                else btn.className = "followup-cnt-btn flex-1 py-1 rounded bg-slate-900 text-slate-400 hover:text-white font-bold text-[11px] border border-slate-700";
            });
        }

        async function generateMoreQuestionsFollowup() {
            if (!activeTest || !activeTest.filename) {
                alert(t("tests.noActiveTestToContinue", "Není aktivní žádný test pro navázání."));
                return;
            }

            const focusMistakes = document.getElementById("followupFocusMistakes")?.checked ?? true;
            const modelName = getSelectedModel("testsModelSelect", "testsModelCustomInput");
            const btn = document.getElementById("btnGenerateMoreFollowup");

            if (btn) {
                btn.disabled = true;
                btn.innerHTML = `<span class="animate-spin">⏳</span> Dogenerovávám ${followupQuestionsCount} nových otázek (${followupDifficultyShift})...`;
            }

            const oldQuestionCount = activeTest.questions?.length || 0;

            try {
                const res = await fetch("/api/tests/generate-more", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        previous_test_id: activeTest.filename,
                        project: currentProject,
                        count: followupQuestionsCount,
                        difficulty_shift: followupDifficultyShift,
                        focus_mistakes: focusMistakes,
                        gemini_model: modelName
                    })
                });

                const data = await res.json();
                if (res.ok) {
                    initActiveTest(data, true);
                    if (data.questions && data.questions.length > oldQuestionCount) {
                        currentQuestionIndex = oldQuestionCount;
                    }
                    renderCurrentQuestion();
                    renderQuestionsPalette();
                    updateActiveThreadBanner();
                    loadSavedTestsList();
                    updateDashboardStats();
                } else {
                    alert("Chyba při dogenerování otázek: " + (data.detail || "Neznámá chyba"));
                }
            } catch (err) {
                alert("Nelze navázat spojení se serverem: " + err.message);
            } finally {
                if (btn) {
                    btn.disabled = false;
                    btn.innerHTML = `<span>🚀</span> Vygenerovat další otázky a pokračovat`;
                }
            }
        }

        // --- SPRÁVA A HISTORIE ULOŽENÝCH TESTŮ ---
        async function loadSavedTestsList() {
            const container = document.getElementById("savedTestsListContainer");
            const countBadge = document.getElementById("savedTestsCountBadge");
            if (!container) return;

            try {
                const res = await fetch(`/api/tests?project=${encodeURIComponent(currentProject || '')}`);
                const data = await res.json();
                const tests = data.tests || [];

                if (countBadge) countBadge.textContent = tests.length;

                if (tests.length === 0) {
                    container.innerHTML = `<div class="text-[11px] text-slate-500 italic p-2 text-center">V tomto projektu zatím nejsou žádné uložené testy.</div>`;
                    return;
                }

                container.innerHTML = "";
                tests.forEach(t => {
                    const isActive = activeTest && activeTest.filename === t.filename;
                    const item = document.createElement("div");
                    item.className = isActive 
                        ? "p-2 bg-purple-950/40 hover:bg-purple-900/40 rounded-lg border-2 border-purple-500 flex flex-wrap items-center justify-between gap-2 transition shadow-sm shadow-purple-900/30"
                        : "p-2 bg-slate-900/80 hover:bg-slate-850 rounded-lg border border-slate-700/80 flex flex-wrap items-center justify-between gap-2 transition";

                    let scorePill = `<span class="text-[10px] text-slate-500 font-mono whitespace-nowrap">Nespuštěno</span>`;
                    if (t.result && t.result.completed) {
                        const p = t.result.percentage || 0;
                        const col = p >= 80 ? "text-emerald-400 bg-emerald-950/70 border-emerald-700" : (p >= 60 ? "text-amber-400 bg-amber-950/70 border-amber-700" : "text-rose-400 bg-rose-950/70 border-rose-700");
                        scorePill = `<span class="text-[10px] font-bold font-mono px-1.5 py-0.5 rounded border ${col} whitespace-nowrap">${p}%</span>`;
                    } else if (t.result && !t.result.completed && t.result.user_answers) {
                        const answeredCount = Object.values(t.result.user_answers).filter(a => a && a.is_submitted).length;
                        scorePill = `<span class="text-[10px] text-amber-300 font-mono bg-amber-950/60 px-1.5 py-0.5 rounded border border-amber-800/80 whitespace-nowrap">Rozpracováno (${answeredCount}/${t.count})</span>`;
                    }

                    const dateStr = t.updated_at 
                        ? new Date(t.updated_at).toLocaleDateString("cs-CZ", { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" }) 
                        : (t.created_at ? new Date(t.created_at).toLocaleDateString("cs-CZ", { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" }) : "");
                    
                    let catPills = "";
                    if (t.categories && t.categories.length > 0) {
                        catPills = t.categories.map(c => `<span class="text-[9px] bg-purple-950/80 text-purple-300 px-1.5 py-0.2 rounded border border-purple-800 font-medium">${escapeHtml(c)}</span>`).join(" ");
                    }

                    const roundsBadge = (t.rounds && t.rounds > 1) 
                        ? `<span class="text-[9px] bg-indigo-950/90 text-indigo-300 font-semibold px-1.5 py-0.2 rounded border border-indigo-800 whitespace-nowrap">Kolo ${t.rounds}</span>` 
                        : '';

                    item.innerHTML = `
                        <div class="min-w-0 flex-1 cursor-pointer" onclick="loadSavedTest('${t.filename}')">
                            <div class="flex items-center gap-1.5 flex-wrap">
                                <span class="text-xs font-semibold text-slate-200 truncate" title="${escapeHtml(t.title)}">${escapeHtml(t.title)}</span>
                                ${isActive ? '<span class="text-[9px] bg-purple-600 text-white font-bold px-1.5 py-0.2 rounded shadow-sm whitespace-nowrap">🟢 Aktivní</span>' : ''}
                                ${roundsBadge}
                            </div>
                            <div class="text-[10px] text-slate-400 flex items-center gap-2 mt-0.5 flex-wrap">
                                <span class="whitespace-nowrap">${t.count} otázek</span>
                                <span>•</span>
                                <span class="whitespace-nowrap">${dateStr}</span>
                                ${catPills ? `<span>•</span> ${catPills}` : ''}
                            </div>
                        </div>
                        <div class="flex flex-wrap items-center gap-1.5 shrink-0">
                            ${scorePill}
                            <button onclick="loadSavedTest('${t.filename}')" class="p-1 hover:bg-slate-750 text-slate-300 hover:text-white rounded text-xs transition" title="Spustit / Prohlédnout test">▶️</button>
                            <button onclick="deleteSavedTest('${t.filename}')" class="p-1 hover:bg-slate-750 text-slate-500 hover:text-rose-400 rounded text-xs transition" title="Smazat test">🗑️</button>
                        </div>
                    `;
                    container.appendChild(item);
                });

            } catch (err) {
                console.warn("Chyba při načítání testů:", err);
            }
        }

        async function loadSavedTest(filename) {
            try {
                const res = await fetch(`/api/tests/${encodeURIComponent(filename)}`);
                if (res.ok) {
                    const data = await res.json();
                    initActiveTest(data, true);
                    if (data.result?.completed) {
                        renderTestResults();
                    }
                    updateActiveThreadBanner();
                    loadSavedTestsList();
                } else {
                    alert(t("tests.loadError", "Test se nepodařilo načíst."));
                }
            } catch (err) {
                alert("Chyba spojení: " + err.message);
            }
        }

        async function deleteSavedTest(filename) {
            if (!confirm(`Opravdu chcete smazat test '${filename}'?`)) return;
            try {
                const res = await fetch(`/api/tests/${encodeURIComponent(filename)}`, { method: "DELETE" });
                if (res.ok) {
                    if (activeTest && activeTest.filename === filename) {
                        createNewTestThread();
                    } else {
                        loadSavedTestsList();
                        updateDashboardStats();
                    }
                } else {
                    alert(t("tests.deleteFailed", "Nepodařilo se smazat test."));
                }
            } catch (err) {
                alert("Chyba při mazání testu: " + err.message);
            }
        }

        function exportTestMarkdown() {
            if (!activeTest || !activeTest.questions) return;

            let md = `# ${activeTest.title || 'Procvičovací test'}\n\n`;
            md += `**Projekt:** ${activeTest.project || ''}  \n`;
            md += `**Datum:** ${new Date().toLocaleDateString('cs-CZ')}  \n`;
            md += `**Obtížnost:** ${activeTest.difficulty || 'normal'}  \n`;
            md += `**Celkem otázek:** ${activeTest.questions.length}  \n\n---\n\n`;

            activeTest.questions.forEach((q, idx) => {
                md += `### ${idx + 1}. ${q.question}\n\n`;
                if (q.scenario) {
                    md += `> **Klinický případ:** ${q.scenario}\n\n`;
                }

                if (q.options && q.options.length > 0) {
                    q.options.forEach(opt => {
                        const isCorrect = (q.correct_answers || []).includes(opt.id);
                        md += `- **[${opt.id}]** ${opt.text} ${isCorrect ? '✅ *(Správná odpověď)*' : ''}\n`;
                    });
                    md += `\n`;
                }

                if (q.model_answer) {
                    md += `**Vzorová odpověď:** ${q.model_answer}\n\n`;
                }
                if (q.key_points && q.key_points.length > 0) {
                    md += `**Klíčové body:** ${q.key_points.join(', ')}\n\n`;
                }
                if (q.explanation) {
                    md += `**Vysvětlení:** ${q.explanation}\n\n`;
                }
                if (q.source_ref || q.source_file) {
                    md += `*Zdroj: ${q.source_ref || ''} (${q.source_file || ''})*\n\n`;
                }
                md += `---\n\n`;
            });

            const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `${activeTest.filename ? activeTest.filename.replace('.json', '') : 'test'}.md`;
            a.click();
            URL.revokeObjectURL(url);
        }

        // =========================================================================
        // NOVÝ MODUL: PROJEKTOVÝ GROUNDED CHAT S HISTORIÍ VLÁKEN
        // =========================================================================
        let chatThreads = [];
        let currentChatThreadId = null;
        let currentChatThreadData = null;
        let chatMessages = [];
        let chatAbortController = null;
        let isChatStreaming = false;
        let chatHistorySearchDebounce = null;
        let isChatSidebarOpenOnMobile = false;

        function toggleChatHistorySidebar() {
            const sidebar = document.getElementById("chatHistorySidebar");
            const textEl = document.getElementById("btnToggleChatSidebarText");
            if (!sidebar) return;
            isChatSidebarOpenOnMobile = !isChatSidebarOpenOnMobile;
            if (isChatSidebarOpenOnMobile) {
                sidebar.classList.remove("hidden");
                sidebar.classList.add("flex");
                if (textEl) textEl.textContent = "Zavřít";
            } else {
                sidebar.classList.add("hidden");
                sidebar.classList.remove("flex");
                if (textEl) textEl.textContent = "Historie";
            }
        }

        let activeLessonChatContext = null;

        async function loadChatHistory(keepSelectedThreadId = null) {
            const projLabel = document.getElementById("chatCurrentProjectLabel");
            if (activeLessonChatContext) {
                if (projLabel) projLabel.textContent = `🎓 Lekce: ${activeLessonChatContext.title}`;
            } else {
                if (projLabel) projLabel.textContent = currentProject || "-- (Není vybrán)";
            }
            await loadChatThreads(keepSelectedThreadId);
        }

        async function loadChatThreads(keepSelectedThreadId = null) {
            const container = document.getElementById("chatThreadsListContainer");
            const countBadge = document.getElementById("chatThreadsCountBadge");
            const searchInput = document.getElementById("chatHistorySearchInput");
            const filterAllCheckbox = document.getElementById("chatFilterAllProjects");
            const filterInfo = document.getElementById("chatHistoryFilterInfo");

            const query = (searchInput ? searchInput.value : "").trim();
            const isAll = filterAllCheckbox ? filterAllCheckbox.checked : false;
            let targetProj = isAll ? "__all__" : (currentProject || "");
            if (!isAll && activeLessonChatContext) {
                targetProj = activeLessonChatContext.id;
            }

            if (filterInfo) {
                filterInfo.textContent = isAll ? "Všechny projekty" : (activeLessonChatContext ? `🎓 ${activeLessonChatContext.title}` : (currentProject || "Bez výběru"));
            }

            if (!container) return;

            try {
                let url = `/api/chat/threads?`;
                const params = new URLSearchParams();
                if (targetProj) params.set("project_id", targetProj);
                if (query) params.set("q", query);
                url += params.toString();

                const res = await fetch(url);
                const data = await res.json();
                chatThreads = data.threads || [];

                if (countBadge) countBadge.textContent = chatThreads.length;

                renderChatThreadsList();

                // Určení, které vlákno vybrat
                const targetId = keepSelectedThreadId || currentChatThreadId;
                if (targetId && chatThreads.some(t => t.id === targetId)) {
                    await selectChatThread(targetId, false);
                } else if (chatThreads.length > 0 && !query) {
                    await selectChatThread(chatThreads[0].id, false);
                } else if (chatThreads.length === 0) {
                    createNewChatThread(false);
                }
            } catch (err) {
                console.error("Chyba při načítání vláken chatu:", err);
                if (container) {
                    container.innerHTML = `<div class="p-3 text-xs text-red-400 bg-red-950/40 rounded-lg border border-red-800">Chyba při načítání historie: ${err.message}</div>`;
                }
            }
        }

        function renderChatThreadsList() {
            const container = document.getElementById("chatThreadsListContainer");
            const searchInput = document.getElementById("chatHistorySearchInput");
            const query = (searchInput ? searchInput.value : "").trim();

            if (!container) return;

            if (!chatThreads || chatThreads.length === 0) {
                if (query) {
                    container.innerHTML = `
                        <div class="p-6 text-center text-slate-500 space-y-2">
                            <span class="text-2xl block">🔍</span>
                            <p class="text-xs">Žádné konverzace neodpovídají dotazu <span class="text-indigo-300 font-semibold">"${query}"</span></p>
                            <button onclick="clearChatHistorySearch()" class="text-[11px] text-indigo-400 hover:text-indigo-300 underline font-medium">Vymazat filtr</button>
                        </div>
                    `;
                } else {
                    container.innerHTML = `
                        <div class="p-6 text-center text-slate-500 space-y-2">
                            <span class="text-2xl block">💬</span>
                            <p class="text-xs">Zatím žádné konverzace.</p>
                            <button onclick="createNewChatThread()" class="text-[11px] bg-indigo-700/80 hover:bg-indigo-600 text-white px-2.5 py-1 rounded transition font-medium">Zahájit nový chat</button>
                        </div>
                    `;
                }
                return;
            }

            const pinned = chatThreads.filter(t => t.is_pinned);
            const unpinned = chatThreads.filter(t => !t.is_pinned);

            let html = "";

            // 1. Připnuté oblíbené konverzace
            if (pinned.length > 0) {
                html += `
                    <div class="space-y-1">
                        <div class="flex items-center gap-1.5 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-amber-400/90 select-none">
                            <span>📌</span>
                            <span>Připnuté (${pinned.length})</span>
                        </div>
                        <div class="space-y-1">
                            ${pinned.map(t => renderThreadItemHtml(t)).join("")}
                        </div>
                    </div>
                `;
            }

            // 2. Ostatní / Všechny konverzace
            if (unpinned.length > 0) {
                html += `
                    <div class="space-y-1 ${pinned.length > 0 ? "mt-3 pt-2 border-t border-slate-700/50" : ""}">
                        <div class="flex items-center gap-1.5 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-slate-400 select-none">
                            <span>🕒</span>
                            <span>${pinned.length > 0 ? "Ostatní konverzace" : "Konverzace"} (${unpinned.length})</span>
                        </div>
                        <div class="space-y-1">
                            ${unpinned.map(t => renderThreadItemHtml(t)).join("")}
                        </div>
                    </div>
                `;
            }

            container.innerHTML = html;
        }

        function renderThreadItemHtml(t) {
            const isActive = t.id === currentChatThreadId;
            const isPinned = t.is_pinned;

            let dateStr = "";
            if (t.updated_at) {
                try {
                    const d = new Date(t.updated_at.replace(" ", "T"));
                    const today = new Date();
                    const isToday = d.toDateString() === today.toDateString();
                    if (isToday) {
                        dateStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    } else {
                        dateStr = `${d.getDate()}. ${d.getMonth() + 1}.`;
                    }
                } catch (e) {
                    dateStr = t.updated_at.split(" ")[0];
                }
            }

            const safeTitle = (t.title || "Nová konverzace").replace(/"/g, "&quot;");
            const projBadge = (t.project_id && (!currentProject || t.project_id !== currentProject)) 
                ? `<span class="text-[9px] bg-slate-900 text-emerald-400 px-1 py-0.5 rounded border border-slate-700 truncate max-w-[80px]" title="Projekt: ${t.project_id}">${t.project_id}</span>` 
                : "";

            return `
                <div id="thread-item-${t.id}" onclick="selectChatThread('${t.id}')" class="group relative p-2.5 rounded-xl border transition-all cursor-pointer flex flex-col gap-1 ${
                    isActive 
                        ? "bg-indigo-950/80 border-indigo-500 shadow-md text-white" 
                        : "bg-slate-900/70 hover:bg-slate-800/80 border-slate-800/80 hover:border-slate-700 text-slate-300"
                }">
                    <div class="flex items-center justify-between gap-1.5 min-w-0">
                        <div class="flex items-center gap-1.5 min-w-0 flex-1">
                            ${isPinned ? '<span class="text-xs text-amber-400 shrink-0" title="Připnutá konverzace">📌</span>' : ''}
                            <h4 class="text-xs font-semibold truncate ${isActive ? 'text-white' : 'group-hover:text-white'}" title="${safeTitle}">
                                ${safeTitle}
                            </h4>
                        </div>

                        <!-- Tlačítka rychlých akcí -->
                        <div class="flex items-center gap-0.5 shrink-0 opacity-80 group-hover:opacity-100 transition">
                            <!-- Pin button -->
                            <button onclick="togglePinThread('${t.id}', event)" class="p-1 rounded hover:bg-slate-700/80 text-[11px] ${isPinned ? 'text-amber-400' : 'text-slate-500 hover:text-amber-300'}" title="${isPinned ? 'Odepnout z oblíbených' : 'Připnout do oblíbených'}">
                                ${isPinned ? '📌' : '📍'}
                            </button>
                            <!-- Rename button -->
                            <button onclick="renameChatThread('${t.id}', event)" class="p-1 rounded hover:bg-slate-700/80 text-[11px] text-slate-500 hover:text-indigo-300" title="Přejmenovat">
                                ✏️
                            </button>
                            <!-- Delete button -->
                            <button onclick="deleteChatThread('${t.id}', event)" class="p-1 rounded hover:bg-slate-700/80 text-[11px] text-slate-500 hover:text-red-400" title="Smazat">
                                🗑️
                            </button>
                        </div>
                    </div>

                    <!-- Podtitul: snippet, datum, počet zpráv, projekt -->
                    <div class="flex items-center justify-between gap-2 text-[10px] text-slate-400">
                        <div class="flex items-center gap-1.5 truncate flex-1">
                            ${projBadge}
                            ${t.last_snippet ? `<span class="truncate italic text-slate-400/90">${t.last_snippet}</span>` : `<span class="italic text-slate-500">Zatím bez zpráv</span>`}
                        </div>
                        <div class="flex items-center gap-1.5 shrink-0 text-slate-400 font-mono">
                            <span>${dateStr}</span>
                            <span class="bg-slate-800 text-slate-400 px-1 rounded border border-slate-700">${t.message_count || 0}</span>
                        </div>
                    </div>
                </div>
            `;
        }

        async function selectChatThread(threadId, shouldCloseMobile = true) {
            if (isChatStreaming) return;
            currentChatThreadId = threadId;

            // Vizuální výběr
            document.querySelectorAll("[id^='thread-item-']").forEach(el => {
                el.classList.remove("bg-indigo-950/80", "border-indigo-500", "shadow-md", "text-white");
                el.classList.add("bg-slate-900/70", "border-slate-800/80", "text-slate-300");
            });
            const selectedEl = document.getElementById(`thread-item-${threadId}`);
            if (selectedEl) {
                selectedEl.classList.remove("bg-slate-900/70", "border-slate-800/80", "text-slate-300");
                selectedEl.classList.add("bg-indigo-950/80", "border-indigo-500", "shadow-md", "text-white");
            }

            if (shouldCloseMobile && window.innerWidth < 1024 && isChatSidebarOpenOnMobile) {
                toggleChatHistorySidebar();
            }

            const titleLabel = document.getElementById("currentChatTitleLabel");
            const pinBtn = document.getElementById("btnCurrentChatPin");
            const pinIcon = document.getElementById("currentChatPinIcon");
            const metaBadge = document.getElementById("currentChatMetaBadge");
            const listEl = document.getElementById("chatMessagesList");

            if (!listEl) return;

            listEl.innerHTML = `
                <div class="flex items-center justify-center h-48 text-slate-500 text-xs">
                    <span class="inline-block w-4 h-4 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin mr-2"></span>
                    Načítám konverzaci...
                </div>
            `;

            try {
                const res = await fetch(`/api/chat/threads/${encodeURIComponent(threadId)}`);
                if (!res.ok) throw new Error("Chyba při načítání vlákna");
                const data = await res.json();
                currentChatThreadData = data.thread;
                chatMessages = data.messages || [];

                if (titleLabel) titleLabel.textContent = currentChatThreadData.title || "Nová konverzace";
                if (metaBadge) metaBadge.textContent = `${chatMessages.length} zpráv`;

                if (pinBtn && pinIcon) {
                    if (currentChatThreadData.is_pinned) {
                        pinBtn.className = "p-1.5 rounded-lg border border-amber-600 bg-amber-950/60 text-amber-300 transition shrink-0";
                        pinIcon.textContent = "📌";
                    } else {
                        pinBtn.className = "p-1.5 rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-amber-300 transition shrink-0";
                        pinIcon.textContent = "📍";
                    }
                }

                renderAllChatMessages();
            } catch (err) {
                console.error("Chyba selectChatThread:", err);
                listEl.innerHTML = `<div class="p-4 text-xs text-red-400 bg-red-950/40 rounded-xl border border-red-800">Chyba při načítání zpráv konverzace: ${err.message}</div>`;
            }
        }

        function createNewChatThread(focusInput = true) {
            if (isChatStreaming) return;
            currentChatThreadId = null;
            currentChatThreadData = null;
            chatMessages = [];

            // Vizuálně odznačit všechna vlákna v sidebaru
            document.querySelectorAll("[id^='thread-item-']").forEach(el => {
                el.classList.remove("bg-indigo-950/80", "border-indigo-500", "shadow-md", "text-white");
                el.classList.add("bg-slate-900/70", "border-slate-800/80", "text-slate-300");
            });

            const titleLabel = document.getElementById("currentChatTitleLabel");
            if (titleLabel) titleLabel.textContent = t("chat.newConversationTitle", "Nová konverzace");

            const metaBadge = document.getElementById("currentChatMetaBadge");
            if (metaBadge) metaBadge.textContent = "0 zpráv";

            const pinBtn = document.getElementById("btnCurrentChatPin");
            const pinIcon = document.getElementById("currentChatPinIcon");
            if (pinBtn && pinIcon) {
                pinBtn.className = "p-1.5 rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-amber-300 transition shrink-0";
                pinIcon.textContent = "📍";
            }

            renderAllChatMessages();

            if (window.innerWidth < 1024 && isChatSidebarOpenOnMobile) {
                toggleChatHistorySidebar();
            }

            if (focusInput) {
                const inp = document.getElementById("chatInputText");
                if (inp) inp.focus();
            }
        }

        async function togglePinThread(threadId, e) {
            if (e) e.stopPropagation();
            try {
                const res = await fetch(`/api/chat/threads/${encodeURIComponent(threadId)}/pin`, { method: "POST" });
                if (!res.ok) throw new Error("Chyba při změně připnutí");
                const data = await res.json();

                await loadChatThreads(currentChatThreadId);

                if (threadId === currentChatThreadId && currentChatThreadData) {
                    currentChatThreadData.is_pinned = data.thread.is_pinned;
                    const pinBtn = document.getElementById("btnCurrentChatPin");
                    const pinIcon = document.getElementById("currentChatPinIcon");
                    if (pinBtn && pinIcon) {
                        if (currentChatThreadData.is_pinned) {
                            pinBtn.className = "p-1.5 rounded-lg border border-amber-600 bg-amber-950/60 text-amber-300 transition shrink-0";
                            pinIcon.textContent = "📌";
                        } else {
                            pinBtn.className = "p-1.5 rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-amber-300 transition shrink-0";
                            pinIcon.textContent = "📍";
                        }
                    }
                }
            } catch (err) {
                alert(`Chyba při připnutí konverzace: ${err.message}`);
            }
        }

        function togglePinCurrentThread() {
            if (!currentChatThreadId) {
                alert(t("chat.startConversationFirst", "Nejprve zahajte konverzaci odesláním dotazu."));
                return;
            }
            togglePinThread(currentChatThreadId);
        }

        async function renameChatThread(threadId, e) {
            if (e) e.stopPropagation();
            const thread = chatThreads.find(t => t.id === threadId) || (currentChatThreadData && currentChatThreadData.id === threadId ? currentChatThreadData : null);
            const oldTitle = thread ? thread.title : "";
            const newTitle = prompt("Zadejte nový název této konverzace:", oldTitle);
            if (!newTitle || newTitle.trim() === oldTitle || !newTitle.trim()) return;

            try {
                const res = await fetch(`/api/chat/threads/${encodeURIComponent(threadId)}`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ title: newTitle.trim() }),
                });
                if (!res.ok) throw new Error("Chyba při přejmenování");
                await loadChatThreads(currentChatThreadId);
                if (threadId === currentChatThreadId) {
                    const titleLabel = document.getElementById("currentChatTitleLabel");
                    if (titleLabel) titleLabel.textContent = newTitle.trim();
                }
            } catch (err) {
                alert(`Chyba při přejmenování konverzace: ${err.message}`);
            }
        }

        function renameCurrentThread() {
            if (!currentChatThreadId) {
                alert(t("chat.startConversationFirst", "Nejprve zahajte konverzaci odesláním dotazu."));
                return;
            }
            renameChatThread(currentChatThreadId);
        }

        async function deleteChatThread(threadId, e) {
            if (e) e.stopPropagation();
            const thread = chatThreads.find(t => t.id === threadId);
            const name = thread ? `"${thread.title}"` : "tuto konverzaci";
            if (!confirm(`Opravdu chcete smazat konverzaci ${name}?`)) return;

            try {
                const res = await fetch(`/api/chat/threads/${encodeURIComponent(threadId)}`, { method: "DELETE" });
                if (!res.ok) throw new Error("Chyba při mazání");
                if (currentChatThreadId === threadId) {
                    currentChatThreadId = null;
                    currentChatThreadData = null;
                }
                await loadChatThreads();
            } catch (err) {
                alert(`Chyba při mazání konverzace: ${err.message}`);
            }
        }

        function deleteCurrentChatThread() {
            if (!currentChatThreadId) {
                chatMessages = [];
                renderAllChatMessages();
                return;
            }
            deleteChatThread(currentChatThreadId);
        }

        function handleChatHistorySearchInput(e) {
            const val = (e.target.value || "").trim();
            const clearBtn = document.getElementById("btnClearChatHistorySearch");
            if (clearBtn) clearBtn.classList.toggle("hidden", !val);

            clearTimeout(chatHistorySearchDebounce);
            chatHistorySearchDebounce = setTimeout(() => {
                loadChatThreads(currentChatThreadId);
            }, 250);
        }

        function clearChatHistorySearch() {
            const input = document.getElementById("chatHistorySearchInput");
            const clearBtn = document.getElementById("btnClearChatHistorySearch");
            if (input) input.value = "";
            if (clearBtn) clearBtn.classList.add("hidden");
            loadChatThreads(currentChatThreadId);
        }

        function renderAllChatMessages() {
            const listEl = document.getElementById("chatMessagesList");
            const suggestions = document.getElementById("chatSuggestionsBar");
            if (!listEl) return;

            if (!chatMessages || chatMessages.length === 0) {
                if (suggestions) suggestions.classList.remove("hidden");
                listEl.innerHTML = `
                    <div class="flex flex-col items-center justify-center h-full text-center text-slate-500 p-8 space-y-3">
                        <span class="text-4xl">💬</span>
                        <h4 class="text-base font-bold text-slate-300">Zahajte konverzaci se zdroji projektu</h4>
                        <p class="text-xs max-w-md text-slate-400">
                            Položte libovolný dotaz. Asistent vyhledá relevantní pasáže v nahraných materiálech projektu, přesně ocituje zdroje a odpoví bez halucinací.
                        </p>
                    </div>
                `;
                return;
            }

            if (suggestions) suggestions.classList.add("hidden");
            listEl.innerHTML = "";
            chatMessages.forEach(msg => {
                appendChatMessageToUI(msg);
            });
            listEl.scrollTop = listEl.scrollHeight;

            if (window.chatSearcher) {
                const q = document.getElementById("chatSearchInput")?.value?.trim();
                if (q) window.chatSearcher.search(q);
                else window.chatSearcher.clearHighlights();
            }
        }

        function resolveCardSourceClient(card, sourcesList = []) {
            let source_file = String(card.source_file || "").trim();
            let source_page = String(card.source_page || card.page || "").trim();
            let source_ref = String(card.source_ref || "").trim();
            let source_id = "";

            // Mapa ID -> filename
            const idMap = {};
            (sourcesList || []).forEach(s => {
                if (s && s.id !== undefined && s.filename) idMap[String(s.id)] = s.filename;
            });

            if (!source_file && source_ref) {
                const m = source_ref.match(/\[(?:Zdroj\s*)?(\d+)(?:,\s*s(?:tr)?\.?\s*([^\]]+))?\]/i);
                if (m) {
                    source_id = m[1];
                    if (!source_page && m[2]) source_page = m[2].trim();
                    if (idMap[source_id]) source_file = idMap[source_id];
                } else {
                    const mDir = source_ref.match(/\[Zdroj:\s*([^,\]]+)(?:,\s*s(?:tr)?\.?\s*([^\]]+))?\]/i);
                    if (mDir) {
                        source_file = mDir[1].trim();
                        if (!source_page && mDir[2]) source_page = mDir[2].trim();
                    }
                }
            }

            if (!source_file && /^\d+$/.test(source_file) && idMap[source_file]) {
                source_file = idMap[source_file];
            }

            if (!source_page && source_ref) {
                const mp = source_ref.match(/s(?:tr)?\.?\s*([0-9]+(?:\s*[-–]\s*[0-9]+)?)/i);
                if (mp) source_page = mp[1].trim();
            }

            if (!source_file && sourcesList && sourcesList.length === 1 && sourcesList[0].filename) {
                source_file = sourcesList[0].filename;
            }

            let clean_page = "";
            if (source_page) {
                const md = source_page.match(/\d+/);
                if (md) clean_page = md[0];
            }

            return {
                source_file,
                source_page,
                source_ref,
                source_id,
                clean_page
            };
        }

        let docViewerCurrentData = null;
        let docViewerCurrentTab = "native";

        async function openDocumentViewer(filename, page = "", project = "") {
            if (!filename) return;
            const proj = project || currentProject;
            const modal = document.getElementById("modalDocumentViewer");
            const frame = document.getElementById("docViewerFrame");
            const titleEl = document.getElementById("docViewerTitle");
            const pageBadge = document.getElementById("docViewerPageBadge");
            const sizeBadge = document.getElementById("docViewerSizeBadge");
            const subEl = document.getElementById("docViewerSubtitle");
            const linkEl = document.getElementById("docViewerExternalLink");
            const downloadEl = document.getElementById("docViewerDownloadLink");
            const officeDownloadBtn = document.getElementById("docViewerOfficeDownloadBtn");
            const officeNotice = document.getElementById("docViewerOfficeNotice");
            const iconEl = document.getElementById("docViewerIcon");
            const loader = document.getElementById("docViewerLoading");
            const loaderText = document.getElementById("docViewerLoadingText");

            let cleanPage = "";
            if (page) {
                const m = String(page).match(/\d+/);
                if (m) cleanPage = m[0];
            }

            const safeProj = encodeURIComponent(proj);
            const safeFile = encodeURIComponent(filename);
            const viewUrl = `/api/files/${safeProj}/${safeFile}/view${cleanPage ? `#page=${cleanPage}` : ''}`;
            const ext = filename.split('.').pop().toLowerCase();

            // Ikona podle formátu
            let icon = "📄";
            if (ext === "pptx" || ext === "ppt") icon = "📊";
            else if (ext === "docx" || ext === "doc") icon = "📝";
            else if (ext === "txt" || ext === "md") icon = "📋";
            else if (["png", "jpg", "jpeg", "webp"].includes(ext)) icon = "🖼️";
            if (iconEl) iconEl.textContent = icon;

            if (titleEl) {
                titleEl.textContent = filename;
                titleEl.title = filename;
            }
            if (pageBadge) {
                pageBadge.textContent = page ? `Strana: ${page}` : (ext === "pptx" ? "Snímky" : (ext === "docx" ? "Dokument" : "Začátek"));
                pageBadge.className = cleanPage 
                    ? "text-[11px] bg-sky-900/60 text-sky-300 font-mono px-2 py-0.5 rounded border border-sky-700 font-bold" 
                    : "text-[11px] bg-slate-800 text-slate-400 font-mono px-2 py-0.5 rounded border border-slate-700";
            }
            if (sizeBadge) {
                sizeBadge.textContent = "-- KB";
            }
            if (subEl) {
                subEl.textContent = `Projekt: ${proj || 'Neznámý'}`;
            }
            if (linkEl) {
                linkEl.href = viewUrl;
            }
            if (downloadEl) {
                downloadEl.href = `/api/files/${safeProj}/${safeFile}/view`;
                downloadEl.setAttribute("download", filename);
            }
            if (officeDownloadBtn) {
                officeDownloadBtn.href = `/api/files/${safeProj}/${safeFile}/view`;
                officeDownloadBtn.setAttribute("download", filename);
            }
            const footerLabel = document.getElementById("docViewerFooterLabel");
            if (footerLabel) {
                footerLabel.textContent = `${filename}${cleanPage ? ` (s. ${cleanPage})` : ''} • Projekt: ${proj || 'Aktuální'}`;
            }
            const footerLinkEl = document.getElementById("docViewerFooterExternalLink");
            if (footerLinkEl) {
                footerLinkEl.href = viewUrl;
            }
            const footerDownloadEl = document.getElementById("docViewerFooterDownloadLink");
            if (footerDownloadEl) {
                footerDownloadEl.href = `/api/files/${safeProj}/${safeFile}/view`;
                footerDownloadEl.setAttribute("download", filename);
            }

            // Reset a zobrazení modalu
            docViewerCurrentData = null;
            if (modal) modal.classList.remove("hidden");

            // Rozhodnutí o výchozím zobrazení
            const isOffice = ["docx", "doc", "pptx", "ppt"].includes(ext);
            if (officeNotice) {
                officeNotice.classList.toggle("hidden", !isOffice);
            }

            if (isOffice) {
                // Office formáty přepneme rovnou na extrahovaný text (RAG náhled)
                setDocViewerTab('text');
                if (frame) frame.src = "about:blank";
            } else {
                setDocViewerTab('native');
                if (loader) {
                    if (loaderText) loaderText.textContent = t("viewer.loadingFile", "Načítám soubor...");
                    loader.classList.remove("hidden");
                }
                if (frame) {
                    if (frame.src && frame.src.includes(safeFile)) {
                        frame.src = "about:blank";
                        setTimeout(() => { frame.src = viewUrl; }, 20);
                    } else {
                        frame.src = viewUrl;
                    }
                    frame.onload = () => {
                        if (loader) loader.classList.add("hidden");
                    };
                }
            }

            // Asynchronně načíst strukturovaný náhled z /api/files/.../preview
            fetchDocViewerPreview(proj, filename, cleanPage);
        }

        async function fetchDocViewerPreview(project, filename, targetPage = "") {
            const safeProj = encodeURIComponent(project);
            const safeFile = encodeURIComponent(filename);
            const sizeBadge = document.getElementById("docViewerSizeBadge");
            const textContent = document.getElementById("docViewerTextContent");
            const sectionsCountEl = document.getElementById("docViewerSectionsCount");
            const searchInput = document.getElementById("docViewerTextSearch");
            if (searchInput) searchInput.value = "";

            try {
                const res = await fetch(`/api/files/${safeProj}/${safeFile}/preview`);
                if (!res.ok) throw new Error("Chyba při načítání náhledu.");
                const data = await res.json();
                docViewerCurrentData = data;

                if (sizeBadge && data.size_bytes) {
                    const kb = (data.size_bytes / 1024).toFixed(1);
                    const mb = (data.size_bytes / (1024 * 1024)).toFixed(2);
                    sizeBadge.textContent = data.size_bytes > 1024 * 1024 ? `${mb} MB` : `${kb} KB`;
                }

                renderDocViewerSections(data.sections, targetPage);
            } catch (err) {
                if (textContent) {
                    textContent.innerHTML = `<div class="p-4 bg-red-950/40 border border-red-800 rounded-lg text-red-300">Nelze načíst textový náhled: ${err.message}</div>`;
                }
            }
        }

        function renderDocViewerSections(sections, targetPage = "") {
            const textContent = document.getElementById("docViewerTextContent");
            const sectionsCountEl = document.getElementById("docViewerSectionsCount");
            if (!textContent) return;

            if (!sections || sections.length === 0) {
                textContent.innerHTML = `<div class="p-8 text-center text-slate-500 italic">${t("viewer.noTextFound", "V tomto dokumentu nebyl nalezen žádný strojově čitelný text.")}</div>`;
                if (sectionsCountEl) sectionsCountEl.textContent = "0 sekcí";
                return;
            }

            if (sectionsCountEl) {
                sectionsCountEl.textContent = `${sections.length} ${sections.length === 1 ? 'sekce' : (sections.length < 5 ? 'sekce' : 'sekcí')}`;
            }

            let html = "";
            sections.forEach((sec, idx) => {
                const isTarget = targetPage && String(sec.page).includes(targetPage);
                const safePage = (sec.page || `Sekce ${idx + 1}`).toString().replace(/</g, "&lt;");
                const safeText = (sec.text || "").replace(/</g, "&lt;");
                
                html += `
                    <div class="doc-viewer-section bg-slate-900 border ${isTarget ? 'border-sky-500 ring-2 ring-sky-500/30' : 'border-slate-800'} rounded-xl p-4 transition" data-text="${safeText.toLowerCase()}">
                        <div class="flex items-center justify-between pb-2 mb-3 border-b border-slate-800 text-xs">
                            <span class="font-mono font-bold ${isTarget ? 'text-sky-300' : 'text-slate-300'} flex items-center gap-1.5">
                                <span>📌</span> ${safePage}
                            </span>
                            <button onclick="copySnippetText(this)" data-content="${safeText.replace(/"/g, '&quot;')}" class="text-[11px] text-slate-400 hover:text-slate-200 bg-slate-800 hover:bg-slate-700 px-2 py-0.5 rounded border border-slate-700 transition">
                                📋 Kopírovat pasáž
                            </button>
                        </div>
                        <div class="text-slate-200 whitespace-pre-wrap font-sans text-xs leading-relaxed select-text">${safeText}</div>
                    </div>
                `;
            });

            textContent.innerHTML = html;

            // Pokud máme targetPage, zaskrollujeme k němu
            if (targetPage) {
                setTimeout(() => {
                    const targetEl = textContent.querySelector(".ring-2");
                    if (targetEl) targetEl.scrollIntoView({ behavior: "smooth", block: "center" });
                }, 100);
            }
        }

        function setDocViewerTab(tab) {
            docViewerCurrentTab = tab;
            const nativePane = document.getElementById("docViewerNativePane");
            const textPane = document.getElementById("docViewerTextPane");
            const btnNative = document.getElementById("docViewerTabNative");
            const btnText = document.getElementById("docViewerTabText");

            if (tab === "native") {
                if (nativePane) nativePane.classList.remove("hidden");
                if (textPane) textPane.classList.add("hidden");
                if (btnNative) {
                    btnNative.className = "px-2.5 py-1 rounded-md font-semibold text-slate-200 bg-sky-900/60 border border-sky-700 flex items-center gap-1.5 transition";
                }
                if (btnText) {
                    btnText.className = "px-2.5 py-1 rounded-md font-semibold text-slate-400 hover:text-slate-200 flex items-center gap-1.5 transition";
                }
            } else {
                if (nativePane) nativePane.classList.add("hidden");
                if (textPane) textPane.classList.remove("hidden");
                if (btnNative) {
                    btnNative.className = "px-2.5 py-1 rounded-md font-semibold text-slate-400 hover:text-slate-200 flex items-center gap-1.5 transition";
                }
                if (btnText) {
                    btnText.className = "px-2.5 py-1 rounded-md font-semibold text-slate-200 bg-sky-900/60 border border-sky-700 flex items-center gap-1.5 transition";
                }
            }
        }

        function toggleDocViewerFullscreen() {
            const box = document.getElementById("modalDocumentViewerBox");
            const btn = document.getElementById("docViewerBtnFullscreen");
            if (!box) return;

            const isFull = box.classList.contains("max-w-none");
            if (isFull) {
                box.classList.remove("max-w-none", "h-[98vh]", "w-[98vw]");
                box.classList.add("max-w-6xl", "h-[92vh]", "w-full");
                if (btn) btn.innerHTML = "⛶";
            } else {
                box.classList.remove("max-w-6xl", "h-[92vh]", "w-full");
                box.classList.add("max-w-none", "h-[98vh]", "w-[98vw]");
                if (btn) btn.innerHTML = "🗗";
            }
        }

        function filterDocViewerText() {
            const input = document.getElementById("docViewerTextSearch");
            const q = (input ? input.value : "").trim().toLowerCase();
            const sections = document.querySelectorAll(".doc-viewer-section");
            let visibleCount = 0;

            sections.forEach(sec => {
                const text = sec.getAttribute("data-text") || "";
                const matches = !q || text.includes(q);
                sec.style.display = matches ? "" : "none";
                if (matches) visibleCount++;
            });

            const sectionsCountEl = document.getElementById("docViewerSectionsCount");
            if (sectionsCountEl) {
                sectionsCountEl.textContent = q ? `Nalezeno ${visibleCount} z ${sections.length}` : `${sections.length} sekcí`;
            }
        }

        function copySnippetText(btn) {
            const content = btn.getAttribute("data-content") || "";
            navigator.clipboard.writeText(content);
            const origText = btn.innerHTML;
            btn.innerHTML = t("viewer.copiedBtn", "✅ Zkopírováno!");
            setTimeout(() => { btn.innerHTML = origText; }, 1500);
        }

        function copyDocViewerFullText() {
            if (!docViewerCurrentData || !docViewerCurrentData.sections) return;
            const full = docViewerCurrentData.sections.map(s => `--- ${s.page || 'Sekce'} ---\n${s.text}`).join("\n\n");
            navigator.clipboard.writeText(full);
            alert(t("chat.textCopied", "✅ Celý extrahovaný text dokumentu byl zkopírován do schránky."));
        }

        function closeDocumentViewer() {
            const modal = document.getElementById("modalDocumentViewer");
            const frame = document.getElementById("docViewerFrame");
            const box = document.getElementById("modalDocumentViewerBox");
            if (box && box.classList.contains("max-w-none")) {
                toggleDocViewerFullscreen(); // reset full screen
            }
            if (frame) frame.src = "about:blank";
            if (modal) modal.classList.add("hidden");
        }

        let viewerFilesCache = [];
        let viewerActiveFilename = "";
        let viewerActiveTabMode = "native"; // 'native' | 'text'
        let viewerCurrentExtFilter = "all";
        let isViewerFullScreen = false;
        let viewerCurrentPreviewData = null;

        // Čtecí a navigační stav
        let viewerCurrentPage = 1;
        let viewerTotalPages = 1;
        let viewerTextFontSize = parseInt(localStorage.getItem("medstudio_viewer_fontsize") || "16", 10);
        let viewerReadingTheme = localStorage.getItem("medstudio_viewer_theme") || "dark";
        let viewerPdfZoom = "page-width";
        let isViewerSidebarCollapsed = false;
        let viewerSearchMatches = [];
        let viewerSearchMatchIndex = -1;

        async function loadViewerFileList(force = false) {
            const label = document.getElementById("viewerProjectLabel");
            if (label) label.textContent = currentProject || "--";

            const badge = document.getElementById("sidebarFilesBadge");
            const countBadge = document.getElementById("viewerFileCountBadge");
            const list = document.getElementById("viewerFileList");

            if (!currentProject) {
                if (list) list.innerHTML = `<li class="text-slate-500 italic text-center py-8">Vyberte nebo vytvořte projekt.</li>`;
                if (countBadge) countBadge.textContent = "0";
                if (badge) badge.classList.add("hidden");
                resetViewerReaderState();
                return;
            }

            try {
                const res = await fetch(`/api/files?project=${encodeURIComponent(currentProject)}`);
                if (!res.ok) throw new Error("Chyba při stahování souborů");
                const data = await res.json();
                viewerFilesCache = data.files || [];

                if (countBadge) countBadge.textContent = viewerFilesCache.length;
                if (badge) {
                    badge.textContent = viewerFilesCache.length;
                    badge.classList.toggle("hidden", viewerFilesCache.length === 0);
                }

                renderViewerFilesList();

                // Automatický výběr prvního dokumentu, pokud dosud žádný není vybrán nebo byl smazán
                if (viewerFilesCache.length > 0) {
                    if (!viewerActiveFilename || !viewerFilesCache.includes(viewerActiveFilename)) {
                        selectViewerDocument(viewerFilesCache[0]);
                    }
                } else {
                    resetViewerReaderState();
                }
            } catch (err) {
                if (list) list.innerHTML = `<li class="text-red-400 text-center py-6">Chyba načítání: ${err.message}</li>`;
            }
        }

        function resetViewerReaderState() {
            viewerActiveFilename = "";
            viewerCurrentPage = 1;
            viewerTotalPages = 1;
            viewerCurrentPreviewData = null;

            const emptyState = document.getElementById("viewerEmptyState");
            const frame = document.getElementById("viewerNativeFrame");
            const textContent = document.getElementById("viewerTextContent");
            const activeTitle = document.getElementById("viewerActiveTitle");
            const activeExt = document.getElementById("viewerActiveExtBadge");
            const activeSize = document.getElementById("viewerActiveSizeBadge");
            const activeSec = document.getElementById("viewerActiveSectionsBadge");
            const textSearch = document.getElementById("viewerTextSearchBar");
            const pageInput = document.getElementById("viewerPageJumpInput");
            const totalDisplay = document.getElementById("viewerTotalPagesDisplay");
            const dropdown = document.getElementById("viewerChaptersDropdown");

            if (emptyState) emptyState.classList.remove("hidden");
            if (frame) { frame.classList.add("hidden"); frame.src = "about:blank"; }
            if (textContent) { textContent.classList.add("hidden"); textContent.innerHTML = ""; }
            if (activeTitle) activeTitle.textContent = "Vyberte dokument ze seznamu vlevo";
            if (activeExt) activeExt.classList.add("hidden");
            if (activeSize) activeSize.classList.add("hidden");
            if (activeSec) activeSec.classList.add("hidden");
            if (textSearch) textSearch.classList.add("hidden");
            if (pageInput) { pageInput.value = "1"; pageInput.max = "1"; }
            if (totalDisplay) totalDisplay.textContent = "--";
            if (dropdown) dropdown.innerHTML = `<option value="">${t("viewer.jumpToChapter", "-- Přejít na kapitolu / stranu --")}</option>`;
        }

        function toggleViewerSidebar(force) {
            const sidebar = document.getElementById("viewerSidebarPanel");
            const container = document.getElementById("viewerReaderContainer");
            const icon = document.getElementById("btnViewerToggleSidebarIcon");
            const txt = document.getElementById("btnViewerToggleSidebarText");
            if (!sidebar || !container) return;

            if (force !== undefined) {
                isViewerSidebarCollapsed = !force;
            } else {
                isViewerSidebarCollapsed = !isViewerSidebarCollapsed;
            }

            if (isViewerSidebarCollapsed) {
                sidebar.classList.add("hidden");
                container.classList.remove("lg:col-span-8", "xl:col-span-8.5");
                container.classList.add("col-span-12");
                if (icon) icon.textContent = "▶";
                if (txt) txt.textContent = "Podklady";
            } else {
                sidebar.classList.remove("hidden");
                container.classList.remove("col-span-12");
                container.classList.add("lg:col-span-8", "xl:col-span-8.5");
                if (icon) icon.textContent = "◀";
                if (txt) txt.textContent = "Podklady";
            }
        }

        function filterViewerByExtension(ext) {
            viewerCurrentExtFilter = ext;
            ["all", "pdf", "docx", "pptx", "txt"].forEach(t => {
                const btn = document.getElementById(`btnFilterExt-${t}`);
                if (btn) {
                    if (t === ext) {
                        btn.className = "px-2.5 py-1 rounded-lg bg-sky-900/80 text-sky-200 font-bold border border-sky-700 shrink-0 transition";
                    } else {
                        btn.className = "px-2.5 py-1 rounded-lg bg-slate-800 text-slate-400 hover:text-white border border-slate-700 shrink-0 transition";
                    }
                }
            });
            renderViewerFilesList();
        }

        function filterViewerFiles(term) {
            const clearBtn = document.getElementById("btnViewerFilesSearchClear");
            if (clearBtn) clearBtn.classList.toggle("hidden", !term || term.trim() === "");
            renderViewerFilesList();
        }

        function clearViewerFilesSearch() {
            const input = document.getElementById("viewerFilesSearchInput");
            const clearBtn = document.getElementById("btnViewerFilesSearchClear");
            if (input) input.value = "";
            if (clearBtn) clearBtn.classList.add("hidden");
            renderViewerFilesList();
        }

        function renderViewerFilesList() {
            const list = document.getElementById("viewerFileList");
            if (!list) return;

            const searchInput = document.getElementById("viewerFilesSearchInput");
            const query = (searchInput ? searchInput.value : "").trim().toLowerCase();

            let filtered = viewerFilesCache;
            if (viewerCurrentExtFilter !== "all") {
                filtered = filtered.filter(f => {
                    const ext = f.split('.').pop().toLowerCase();
                    if (viewerCurrentExtFilter === "pdf") return ext === "pdf";
                    if (viewerCurrentExtFilter === "docx") return ext === "docx" || ext === "doc";
                    if (viewerCurrentExtFilter === "pptx") return ext === "pptx" || ext === "ppt";
                    if (viewerCurrentExtFilter === "txt") return ext === "txt" || ext === "md";
                    return true;
                });
            }
            if (query) {
                filtered = filtered.filter(f => f.toLowerCase().includes(query));
            }

            if (filtered.length === 0) {
                list.innerHTML = `<li class="text-slate-500 italic text-center py-8">Nenalezeny žádné odpovídající soubory.</li>`;
                return;
            }

            let html = "";
            filtered.forEach(filename => {
                const ext = filename.split('.').pop().toLowerCase();
                let icon = "📄";
                let extBadge = ext.toUpperCase();
                let badgeColor = "bg-red-950/70 text-red-300 border-red-800/60";
                if (ext === "pptx" || ext === "ppt") {
                    icon = "📊"; extBadge = "PPTX"; badgeColor = "bg-amber-950/70 text-amber-300 border-amber-800/60";
                } else if (ext === "docx" || ext === "doc") {
                    icon = "📝"; extBadge = "DOCX"; badgeColor = "bg-blue-950/70 text-blue-300 border-blue-800/60";
                } else if (ext === "txt" || ext === "md") {
                    icon = "📋"; extBadge = ext.toUpperCase(); badgeColor = "bg-emerald-950/70 text-emerald-300 border-emerald-800/60";
                } else if (["png", "jpg", "jpeg", "webp"].includes(ext)) {
                    icon = "🖼️"; extBadge = ext.toUpperCase(); badgeColor = "bg-purple-950/70 text-purple-300 border-purple-800/60";
                }

                const isActive = filename === viewerActiveFilename;
                const safeNameAttr = filename.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
                const safeNameArg = encodeURIComponent(filename);
                const safeProjArg = encodeURIComponent(currentProject);

                html += `
                    <li class="flex items-center justify-between p-2 sm:p-2.5 rounded-xl border transition group cursor-pointer ${
                        isActive
                            ? 'bg-sky-950/70 border-sky-500 shadow-md ring-1 ring-sky-500/40'
                            : 'bg-slate-950/70 border-slate-800/80 hover:bg-slate-850 hover:border-slate-700'
                    }">
                        <div class="flex items-start gap-2.5 pr-2 min-w-0 flex-1" onclick="selectViewerDocument(decodeURIComponent('${safeNameArg}'))" title="${safeNameAttr}">
                            <span class="text-base shrink-0 mt-0.5">${icon}</span>
                            <div class="min-w-0 flex-1">
                                <div class="text-xs font-semibold leading-snug line-clamp-2 break-words ${isActive ? 'text-sky-200 font-bold' : 'text-slate-300 group-hover:text-white'} transition">
                                    ${safeNameAttr}
                                </div>
                                <div class="flex items-center gap-1.5 mt-1 text-[9px] text-slate-500 font-mono">
                                    <span class="px-1.5 py-0.2 rounded border uppercase font-bold ${badgeColor}">${extBadge}</span>
                                </div>
                            </div>
                        </div>
                        <div class="flex items-center gap-1 shrink-0">
                            <a href="/api/files/${safeProjArg}/${safeNameArg}/view" target="_blank" rel="noopener noreferrer" class="text-slate-400 hover:text-sky-300 p-1.5 rounded-lg hover:bg-slate-800 text-xs transition inline-flex items-center" title="Otevřít originál v nové záložce">
                                ↗
                            </a>
                            <button type="button" onclick="deleteFileFromViewer(decodeURIComponent('${safeNameArg}'))" class="text-slate-500 hover:text-red-400 p-1.5 rounded-lg hover:bg-slate-800 text-xs transition" title="Smazat soubor">
                                🗑️
                            </button>
                        </div>
                    </li>
                `;
            });
            list.innerHTML = html;
        }

        async function selectViewerDocument(filename, page = 1) {
            if (!filename || !currentProject) return;
            viewerActiveFilename = filename;
            viewerCurrentPage = parseInt(page, 10) || 1;
            renderViewerFilesList();

            const ext = filename.split('.').pop().toLowerCase();
            const safeProj = encodeURIComponent(currentProject);
            const safeFile = encodeURIComponent(filename);
            const zoomParam = viewerPdfZoom ? `&zoom=${viewerPdfZoom}` : '';
            const viewUrl = `/api/files/${safeProj}/${safeFile}/view#page=${viewerCurrentPage}${zoomParam}`;

            // Update header
            const emptyState = document.getElementById("viewerEmptyState");
            const iconEl = document.getElementById("viewerActiveIcon");
            const titleEl = document.getElementById("viewerActiveTitle");
            const extBadge = document.getElementById("viewerActiveExtBadge");
            const extBtn = document.getElementById("btnViewerExternal");
            const dlBtn = document.getElementById("btnViewerDownload");
            const frame = document.getElementById("viewerNativeFrame");
            const loader = document.getElementById("viewerLoadingSpinner");
            const loaderText = document.getElementById("viewerLoadingText");
            const pageInput = document.getElementById("viewerPageJumpInput");

            if (emptyState) emptyState.classList.add("hidden");

            let icon = "📄";
            if (ext === "pptx" || ext === "ppt") icon = "📊";
            else if (ext === "docx" || ext === "doc") icon = "📝";
            else if (ext === "txt" || ext === "md") icon = "📋";
            else if (["png", "jpg", "jpeg", "webp"].includes(ext)) icon = "🖼️";

            if (iconEl) iconEl.textContent = icon;
            if (titleEl) {
                titleEl.textContent = filename;
                titleEl.title = filename;
            }
            if (extBadge) {
                extBadge.textContent = ext.toUpperCase();
                extBadge.classList.remove("hidden");
            }
            if (extBtn) extBtn.href = viewUrl;
            if (dlBtn) {
                dlBtn.href = `/api/files/${safeProj}/${safeFile}/view`;
                dlBtn.setAttribute("download", filename);
            }
            if (pageInput) pageInput.value = viewerCurrentPage;

            const isOffice = ["docx", "doc", "pptx", "ppt"].includes(ext);

            if (isOffice) {
                // Office soubory neumí prohlížeč vykreslit nativně v iframe -> přepnout na extrahovaný text (RAG)
                setSectionViewerTab("text");
                if (frame) frame.src = "about:blank";
            } else {
                if (viewerActiveTabMode !== "text") {
                    setSectionViewerTab("native");
                } else {
                    setSectionViewerTab("text");
                }

                if (viewerActiveTabMode === "native") {
                    if (loader) {
                        if (loaderText) loaderText.textContent = t("viewer.loadingFile", "Načítám soubor do čtečky...");
                        loader.classList.remove("hidden");
                    }
                    if (frame) {
                        frame.onload = () => {
                            if (loader) loader.classList.add("hidden");
                        };
                        frame.src = viewUrl;
                    }
                }
            }

            // Asynchronně načíst strukturovaný náhled a metadata stran
            await fetchViewerDocumentPreview(currentProject, filename, viewerCurrentPage);
        }

        async function fetchViewerDocumentPreview(project, filename, targetPage = 1) {
            const safeProj = encodeURIComponent(project);
            const safeFile = encodeURIComponent(filename);
            const sizeBadge = document.getElementById("viewerActiveSizeBadge");
            const sectionsBadge = document.getElementById("viewerActiveSectionsBadge");
            const textContent = document.getElementById("viewerTextContent");
            const totalDisplay = document.getElementById("viewerTotalPagesDisplay");
            const pageInput = document.getElementById("viewerPageJumpInput");
            const dropdown = document.getElementById("viewerChaptersDropdown");
            const searchInput = document.getElementById("viewerTextSearchInput");
            if (searchInput) searchInput.value = "";

            try {
                const res = await fetch(`/api/files/${safeProj}/${safeFile}/preview`);
                if (!res.ok) throw new Error("Nelze načíst textový náhled.");
                const data = await res.json();
                viewerCurrentPreviewData = data;

                // Celkový počet stran
                viewerTotalPages = Math.max(data.total_pages || 1, (data.sections && data.sections.length) || 1);
                if (totalDisplay) totalDisplay.textContent = viewerTotalPages;
                if (pageInput) {
                    pageInput.max = viewerTotalPages;
                    pageInput.value = viewerCurrentPage;
                }

                if (sizeBadge && data.size_bytes) {
                    const kb = (data.size_bytes / 1024).toFixed(1);
                    const mb = (data.size_bytes / (1024 * 1024)).toFixed(2);
                    sizeBadge.textContent = data.size_bytes > 1024 * 1024 ? `${mb} MB` : `${kb} KB`;
                    sizeBadge.classList.remove("hidden");
                }

                if (sectionsBadge && data.sections) {
                    const cnt = data.sections.length;
                    sectionsBadge.textContent = `${viewerTotalPages} ${viewerTotalPages === 1 ? 'strana' : (viewerTotalPages < 5 ? 'strany' : 'stran')} (${cnt} ${cnt === 1 ? 'sekce' : (cnt < 5 ? 'sekce' : 'sekcí')})`;
                    sectionsBadge.classList.remove("hidden");
                }

                // Naplnit dropdown osnovy kapitol / stran
                if (dropdown) {
                    dropdown.innerHTML = `<option value="">${t("viewer.jumpToChapter", "-- Přejít na kapitolu / stranu --")}</option>`;
                    if (data.sections && data.sections.length > 0) {
                        data.sections.forEach((sec, idx) => {
                            const pNum = sec.page_number || (idx + 1);
                            const pLabel = sec.page || `Strana ${pNum}`;
                            let snippet = (sec.text || "").replace(/\s+/g, " ").trim();
                            if (snippet.length > 40) snippet = snippet.slice(0, 40) + "...";
                            const opt = document.createElement("option");
                            opt.value = pNum;
                            opt.textContent = `${pLabel}: ${snippet || 'Sekce ' + (idx + 1)}`;
                            dropdown.appendChild(opt);
                        });
                    } else if (viewerTotalPages > 1) {
                        for (let i = 1; i <= Math.min(viewerTotalPages, 200); i++) {
                            const opt = document.createElement("option");
                            opt.value = i;
                            opt.textContent = `Strana ${i} z ${viewerTotalPages}`;
                            dropdown.appendChild(opt);
                        }
                    }
                }

                renderViewerSections(data.sections, targetPage);
            } catch (err) {
                if (textContent) {
                    textContent.innerHTML = `<div class="p-4 bg-red-950/40 border border-red-800 rounded-xl text-red-300 text-xs">Nelze načíst strukturovaný náhled: ${err.message}</div>`;
                }
            }
        }

        function renderViewerSections(sections, targetPage = 1) {
            const textContent = document.getElementById("viewerTextContent");
            if (!textContent) return;

            if (!sections || sections.length === 0) {
                textContent.innerHTML = `<div class="p-8 text-center text-slate-500 italic">${t("viewer.noTextFound", "V tomto dokumentu nebyl nalezen žádný strojově čitelný text.")}</div>`;
                return;
            }

            let html = "";
            sections.forEach((sec, idx) => {
                const pageNum = sec.page_number || (idx + 1);
                const isTarget = targetPage && (String(pageNum) === String(targetPage) || String(sec.page).includes(String(targetPage)));
                const safePage = (sec.page || `Strana ${pageNum}`).toString().replace(/</g, "&lt;");
                const safeText = (sec.text || "").replace(/</g, "&lt;");

                html += `
                    <div class="viewer-section-card bg-slate-900 border ${isTarget ? 'border-sky-500 ring-2 ring-sky-500/40' : 'border-slate-800'} rounded-xl p-4 transition" data-text="${safeText.toLowerCase()}" data-page-num="${pageNum}" data-page="${safePage}">
                        <div class="flex items-center justify-between pb-2 mb-3 border-b border-slate-800 text-xs flex-wrap gap-2">
                            <span class="font-mono font-bold ${isTarget ? 'text-sky-300' : 'text-slate-300'} flex items-center gap-1.5 cursor-pointer hover:text-sky-300 transition" onclick="jumpToViewerPage(${pageNum})" title="Přejít na stranu ${pageNum}">
                                <span>📌</span> ${safePage}
                            </span>
                            <div class="flex items-center gap-1.5">
                                <button type="button" onclick="jumpToViewerPage(${pageNum})" class="text-[11px] text-slate-400 hover:text-sky-300 bg-slate-800 hover:bg-slate-700 px-2 py-0.5 rounded border border-slate-700 transition" title="Označit tuto stranu jako aktuální">
                                    Strana ${pageNum}
                                </button>
                                <button type="button" onclick="copySnippetText(this)" data-content="${safeText.replace(/"/g, '&quot;')}" class="text-[11px] text-slate-400 hover:text-slate-200 bg-slate-800 hover:bg-slate-700 px-2 py-0.5 rounded border border-slate-700 transition">
                                    📋 Kopírovat pasáž
                                </button>
                            </div>
                        </div>
                        <div class="viewer-card-body text-slate-200 whitespace-pre-wrap font-sans leading-relaxed select-text" style="font-size: ${viewerTextFontSize}px; line-height: ${viewerTextFontSize * 1.6}px;">${safeText}</div>
                    </div>
                `;
            });

            textContent.innerHTML = html;

            // Uplatnit čtecí téma a velikost písma
            setViewerReadingTheme(viewerReadingTheme);

            if (targetPage) {
                setTimeout(() => {
                    const targetEl = textContent.querySelector(`[data-page-num="${targetPage}"]`) || textContent.querySelector(".ring-2");
                    if (targetEl) targetEl.scrollIntoView({ behavior: "smooth", block: "start" });
                }, 100);
            }
        }

        function setSectionViewerTab(tab) {
            viewerActiveTabMode = tab;
            const nativePane = document.getElementById("viewerNativeFrame");
            const textPane = document.getElementById("viewerTextContent");
            const textSearchBar = document.getElementById("viewerTextSearchBar");
            const btnNative = document.getElementById("btnViewerTabNative");
            const btnText = document.getElementById("btnViewerTabText");
            const emptyState = document.getElementById("viewerEmptyState");
            const pdfTools = document.getElementById("viewerPdfTools");
            const textTools = document.getElementById("viewerTextTools");
            const themeTools = document.getElementById("viewerThemeTools");

            if (!viewerActiveFilename) return;
            if (emptyState) emptyState.classList.add("hidden");

            const ext = viewerActiveFilename.split('.').pop().toLowerCase();
            const isPdf = ext === "pdf";

            if (tab === "native") {
                if (nativePane) nativePane.classList.remove("hidden");
                if (textPane) textPane.classList.add("hidden");
                if (textSearchBar) textSearchBar.classList.add("hidden");

                if (btnNative) {
                    btnNative.className = "px-2.5 py-1 rounded-lg text-xs font-bold bg-sky-900/80 text-sky-200 border border-sky-700 transition flex items-center gap-1";
                }
                if (btnText) {
                    btnText.className = "px-2.5 py-1 rounded-lg text-xs font-semibold text-slate-400 hover:text-white transition flex items-center gap-1";
                }

                // Zobrazit PDF nástroje, skrýt textové
                if (pdfTools) {
                    if (isPdf) {
                        pdfTools.classList.remove("hidden");
                        pdfTools.classList.add("flex");
                    } else {
                        pdfTools.classList.add("hidden");
                        pdfTools.classList.remove("flex");
                    }
                }
                if (textTools) {
                    textTools.classList.add("hidden");
                    textTools.classList.remove("flex");
                }
                if (themeTools) {
                    themeTools.classList.add("hidden");
                    themeTools.classList.remove("flex");
                }

                // Pokud je iframe prázdný, nastavíme URL s aktuální stranou a zoomem
                if (nativePane && (!nativePane.src || nativePane.src.includes("about:blank"))) {
                    const safeProj = encodeURIComponent(currentProject);
                    const safeFile = encodeURIComponent(viewerActiveFilename);
                    const zoomParam = viewerPdfZoom ? `&zoom=${viewerPdfZoom}` : '';
                    nativePane.src = `/api/files/${safeProj}/${safeFile}/view#page=${viewerCurrentPage}${zoomParam}`;
                }
            } else {
                if (nativePane) nativePane.classList.add("hidden");
                if (textPane) textPane.classList.remove("hidden");
                if (textSearchBar) textSearchBar.classList.remove("hidden");

                if (btnNative) {
                    btnNative.className = "px-2.5 py-1 rounded-lg text-xs font-semibold text-slate-400 hover:text-white transition flex items-center gap-1";
                }
                if (btnText) {
                    btnText.className = "px-2.5 py-1 rounded-lg text-xs font-bold bg-sky-900/80 text-sky-200 border border-sky-700 transition flex items-center gap-1";
                }

                // Skrýt PDF nástroje, zobrazit textové nástroje a témata
                if (pdfTools) {
                    pdfTools.classList.add("hidden");
                    pdfTools.classList.remove("flex");
                }
                if (textTools) {
                    textTools.classList.remove("hidden");
                    textTools.classList.add("flex");
                }
                if (themeTools) {
                    themeTools.classList.remove("hidden");
                    themeTools.classList.add("flex");
                }
            }
        }

        // =========================================================================
        // NAVIGACE MEZI STRANAMI, SKOKY, ZOOM A ČTECÍ NÁSTROJE
        // =========================================================================

        function jumpToViewerPage(targetPage) {
            let p = parseInt(targetPage, 10);
            if (isNaN(p) || p < 1) p = 1;
            if (viewerTotalPages > 0 && p > viewerTotalPages) p = viewerTotalPages;

            viewerCurrentPage = p;

            const pageInput = document.getElementById("viewerPageJumpInput");
            if (pageInput) pageInput.value = p;

            const dropdown = document.getElementById("viewerChaptersDropdown");
            if (dropdown) dropdown.value = p;

            // 1. PDF / Nativní iframe zobrazení
            if (viewerActiveTabMode === "native") {
                const frame = document.getElementById("viewerNativeFrame");
                if (frame && viewerActiveFilename) {
                    const safeProj = encodeURIComponent(currentProject);
                    const safeFile = encodeURIComponent(viewerActiveFilename);
                    const zoomParam = viewerPdfZoom ? `&zoom=${viewerPdfZoom}` : "";
                    const targetUrl = `/api/files/${safeProj}/${safeFile}/view#page=${p}${zoomParam}`;

                    if (frame.src && frame.src.split('#')[0].includes(safeFile)) {
                        try {
                            frame.contentWindow.location.replace(targetUrl);
                        } catch (e) {
                            frame.src = targetUrl;
                        }
                    } else {
                        frame.src = targetUrl;
                    }
                }
            }

            // 2. Textové RAG zobrazení
            const textContent = document.getElementById("viewerTextContent");
            if (textContent) {
                // Odznačit dřívější zvýraznění
                textContent.querySelectorAll(".viewer-section-card").forEach(el => {
                    el.classList.remove("ring-4", "ring-sky-400", "border-sky-500", "bg-sky-950/40");
                });

                // Hledat kartu s odpovídajícím číslem strany
                let targetCard = textContent.querySelector(`.viewer-section-card[data-page-num="${p}"]`);
                if (!targetCard) {
                    const cards = Array.from(textContent.querySelectorAll(".viewer-section-card"));
                    for (let i = cards.length - 1; i >= 0; i--) {
                        const num = parseInt(cards[i].getAttribute("data-page-num"), 10);
                        if (!isNaN(num) && num <= p) {
                            targetCard = cards[i];
                            break;
                        }
                    }
                    if (!targetCard && cards.length > 0) {
                        targetCard = cards[Math.min(p - 1, cards.length - 1)];
                    }
                }

                if (targetCard) {
                    targetCard.classList.add("ring-4", "ring-sky-400", "border-sky-500", "bg-sky-950/40");
                    targetCard.scrollIntoView({ behavior: "smooth", block: "start" });
                }
            }
        }

        function stepViewerPage(delta) {
            jumpToViewerPage(viewerCurrentPage + delta);
        }

        function jumpToViewerLastPage() {
            jumpToViewerPage(viewerTotalPages);
        }

        function handleViewerPageKey(event) {
            if (event.key === "Enter") {
                event.preventDefault();
                jumpToViewerPage(event.target.value);
            }
        }

        function changeViewerPdfZoom(zoom) {
            viewerPdfZoom = zoom;
            const select = document.getElementById("viewerPdfZoomSelect");
            if (select) select.value = zoom;
            jumpToViewerPage(viewerCurrentPage);
        }

        function adjustViewerPdfZoom(delta) {
            let current = parseInt(viewerPdfZoom, 10);
            if (isNaN(current)) current = 100;
            let next = Math.max(50, Math.min(300, current + delta));
            viewerPdfZoom = String(next);
            const select = document.getElementById("viewerPdfZoomSelect");
            if (select) {
                select.value = viewerPdfZoom;
            }
            jumpToViewerPage(viewerCurrentPage);
        }

        function adjustViewerTextFontSize(delta) {
            viewerTextFontSize = Math.max(12, Math.min(32, viewerTextFontSize + delta));
            try { localStorage.setItem("medstudio_viewer_fontsize", viewerTextFontSize); } catch (e) {}

            const label = document.getElementById("viewerFontSizeLabel");
            if (label) label.textContent = `${viewerTextFontSize}px`;

            const textContent = document.getElementById("viewerTextContent");
            if (textContent) {
                textContent.querySelectorAll(".viewer-section-card .viewer-card-body").forEach(el => {
                    el.style.fontSize = `${viewerTextFontSize}px`;
                    el.style.lineHeight = `${viewerTextFontSize * 1.6}px`;
                });
            }
        }

        function setViewerReadingTheme(theme) {
            viewerReadingTheme = theme;
            try { localStorage.setItem("medstudio_viewer_theme", theme); } catch (e) {}

            const textContent = document.getElementById("viewerTextContent");
            const btnDark = document.getElementById("btnTheme-dark");
            const btnSepia = document.getElementById("btnTheme-sepia");
            const btnLight = document.getElementById("btnTheme-light");

            [btnDark, btnSepia, btnLight].forEach(b => {
                if (b) b.classList.remove("ring-2", "ring-sky-400", "ring-amber-400", "bg-slate-700", "bg-amber-900/60", "bg-slate-300");
            });

            if (theme === "sepia") {
                if (btnSepia) btnSepia.classList.add("ring-2", "ring-amber-400", "bg-amber-900/60");
                if (textContent) {
                    textContent.style.backgroundColor = "#f7f1e3";
                    textContent.style.color = "#38281d";
                    textContent.querySelectorAll(".viewer-section-card").forEach(c => {
                        c.style.backgroundColor = "#ede5cf";
                        c.style.borderColor = "#dacbb0";
                        c.style.color = "#38281d";
                        const body = c.querySelector(".viewer-card-body");
                        if (body) body.style.color = "#38281d";
                    });
                }
            } else if (theme === "light") {
                if (btnLight) btnLight.classList.add("ring-2", "ring-sky-400", "bg-slate-300");
                if (textContent) {
                    textContent.style.backgroundColor = "#f8fafc";
                    textContent.style.color = "#0f172a";
                    textContent.querySelectorAll(".viewer-section-card").forEach(c => {
                        c.style.backgroundColor = "#ffffff";
                        c.style.borderColor = "#cbd5e1";
                        c.style.color = "#0f172a";
                        const body = c.querySelector(".viewer-card-body");
                        if (body) body.style.color = "#0f172a";
                    });
                }
            } else {
                // dark (výchozí)
                if (btnDark) btnDark.classList.add("ring-2", "ring-sky-400", "bg-slate-800");
                if (textContent) {
                    textContent.style.backgroundColor = "";
                    textContent.style.color = "";
                    textContent.querySelectorAll(".viewer-section-card").forEach(c => {
                        c.style.backgroundColor = "";
                        c.style.borderColor = "";
                        c.style.color = "";
                        const body = c.querySelector(".viewer-card-body");
                        if (body) body.style.color = "";
                    });
                }
            }
        }

        function copyViewerCitation() {
            if (!viewerActiveFilename) {
                showGlobalToast(t("toast.selectDocFirst", "Nejprve vyberte dokument pro citaci."), "warning");
                return;
            }
            const citation = `[Zdroj: ${viewerActiveFilename}, s. ${viewerCurrentPage}]`;
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(citation).then(() => {
                    showGlobalToast(`📋 Citace zkopírována: ${citation}`, "success");
                }).catch(() => {
                    prompt(t("viewer.copyCitationPrompt", "Zkopírujte citaci:"), citation);
                });
            } else {
                prompt(t("viewer.copyCitationPrompt", "Zkopírujte citaci:"), citation);
            }
        }

        function toggleViewerTextSearch(force) {
            const searchBar = document.getElementById("viewerTextSearchBar");
            const btn = document.getElementById("btnViewerToggleSearch");
            if (!searchBar) return;

            const shouldOpen = force !== undefined ? force : searchBar.classList.contains("hidden");
            if (shouldOpen) {
                searchBar.classList.remove("hidden");
                if (btn) btn.classList.add("bg-sky-900/80", "border-sky-700", "text-sky-200");
                setSectionViewerTab("text");
                const input = document.getElementById("viewerTextSearchInput");
                if (input) {
                    input.focus();
                    if (input.value) searchInsideViewerDocument(input.value);
                }
            } else {
                searchBar.classList.add("hidden");
                if (btn) btn.classList.remove("bg-sky-900/80", "border-sky-700", "text-sky-200");
                clearViewerTextSearch();
            }
        }

        function clearViewerTextSearch() {
            const input = document.getElementById("viewerTextSearchInput");
            if (input) input.value = "";
            searchInsideViewerDocument("");
        }

        function searchInsideViewerDocument(query) {
            const q = (query || "").trim().toLowerCase();
            const sections = Array.from(document.querySelectorAll(".viewer-section-card"));
            const countBadge = document.getElementById("viewerSearchCountBadge");
            viewerSearchMatches = [];
            viewerSearchMatchIndex = -1;

            sections.forEach(sec => {
                const text = sec.getAttribute("data-text") || "";
                const match = !q || text.includes(q);
                sec.style.display = match ? "" : "none";
                if (q && match) {
                    viewerSearchMatches.push(sec);
                }
            });

            if (countBadge) {
                if (q) {
                    countBadge.textContent = `${viewerSearchMatches.length} ${viewerSearchMatches.length === 1 ? 'nález' : (viewerSearchMatches.length < 5 ? 'nálezy' : 'nálezů')}`;
                    countBadge.classList.remove("hidden");
                } else {
                    countBadge.classList.add("hidden");
                }
            }

            if (viewerSearchMatches.length > 0) {
                navigateViewerSearchMatch(1);
            }
        }

        function navigateViewerSearchMatch(direction) {
            if (!viewerSearchMatches || viewerSearchMatches.length === 0) return;
            viewerSearchMatchIndex = (viewerSearchMatchIndex + direction + viewerSearchMatches.length) % viewerSearchMatches.length;
            const target = viewerSearchMatches[viewerSearchMatchIndex];
            if (target) {
                document.querySelectorAll(".viewer-section-card").forEach(c => c.classList.remove("ring-4", "ring-emerald-400"));
                target.classList.add("ring-4", "ring-emerald-400");
                target.scrollIntoView({ behavior: "smooth", block: "center" });

                const countBadge = document.getElementById("viewerSearchCountBadge");
                if (countBadge) {
                    countBadge.textContent = `${viewerSearchMatchIndex + 1} z ${viewerSearchMatches.length} nálezů`;
                }
            }
        }

        function toggleViewerFullScreen() {
            const container = document.getElementById("viewerReaderContainer");
            const btn = document.getElementById("btnViewerFullScreen");
            if (!container) return;

            isViewerFullScreen = !isViewerFullScreen;

            if (isViewerFullScreen) {
                container.classList.add("fixed", "inset-0", "z-[9999]", "p-4", "sm:p-6", "bg-slate-950", "rounded-none", "border-0");
                container.classList.remove("lg:col-span-8", "xl:col-span-8.5", "col-span-12", "rounded-2xl");
                if (btn) btn.innerHTML = `<span>🗗</span> <span class="hidden md:inline">${t("viewer.exitReadingMode", "Ukončit čtení")}</span>`;
            } else {
                container.classList.remove("fixed", "inset-0", "z-[9999]", "p-4", "sm:p-6", "bg-slate-950", "rounded-none", "border-0");
                if (isViewerSidebarCollapsed) {
                    container.classList.add("col-span-12", "rounded-2xl");
                } else {
                    container.classList.add("lg:col-span-8", "xl:col-span-8.5", "rounded-2xl");
                }
                if (btn) btn.innerHTML = `<span>⛶</span> <span class="hidden md:inline">${t("viewer.enterReadingMode", "Čtecí režim")}</span>`;
            }
        }

        async function uploadDocsFromViewer() {
            const input = document.getElementById("viewerDocsUploadInput");
            if (!input || !input.files || input.files.length === 0) return;
            if (!currentProject) {
                alert(t("common.selectOrCreateProject", "Nejprve vyberte nebo vytvořte projekt."));
                input.value = "";
                return;
            }

            const formData = new FormData();
            for (let i = 0; i < input.files.length; i++) {
                formData.append("files", sanitizeFile(input.files[i]));
            }

            showGlobalToast(t("toast.uploadingFiles", "⏳ Nahrávám soubory..."), "info");

            try {
                const res = await fetch(`/api/upload?project=${encodeURIComponent(currentProject)}`, {
                    method: "POST",
                    body: formData
                });
                const data = await res.json();
                if (res.ok) {
                    showGlobalToast(`✅ Úspěšně nahráno: ${data.uploaded.length} souborů`, "success");
                    input.value = "";
                    await loadViewerFileList(true);
                    if (data.uploaded.length > 0) {
                        selectViewerDocument(data.uploaded[0]);
                    }
                    loadFileList();
                } else {
                    showGlobalToast(`❌ Chyba: ${data.detail || 'Nelze nahrát'}`, "error");
                }
            } catch (err) {
                showGlobalToast(`❌ Chyba nahrávání: ${err.message}`, "error");
            }
        }

        async function deleteFileFromViewer(filename) {
            if (!filename || !currentProject) return;
            if (!confirm(`Opravdu chcete smazat soubor '${filename}'?`)) return;

            try {
                const res = await fetch(`/api/files/${encodeURIComponent(currentProject)}/${encodeURIComponent(filename)}`, {
                    method: "DELETE"
                });
                if (res.ok) {
                    showGlobalToast(`🗑️ Soubor '${filename}' byl smazán`, "success");
                    if (viewerActiveFilename === filename) {
                        viewerActiveFilename = "";
                    }
                    await loadViewerFileList(true);
                    loadFileList();
                } else {
                    const err = await res.json();
                    showGlobalToast(`❌ Chyba při mazání: ${err.detail || 'Neznámá chyba'}`, "error");
                }
            } catch (err) {
                showGlobalToast(`❌ Chyba sítě: ${err.message}`, "error");
            }
        }

        // Klávesa Escape pro zavření prohlížeče a modalů v pořadí z-indexu
        window.addEventListener("keydown", (e) => {
            if (e.key === "Escape") {
                // 0. Celoobrazovkový čtecí režim v Prohlížeči souborů
                if (isViewerFullScreen) {
                    toggleViewerFullScreen();
                    return;
                }
                // 1. Prohlížeč dokumentů a PDF (z-[100])
                const docModal = document.getElementById("modalDocumentViewer");
                if (docModal && !docModal.classList.contains("hidden")) {
                    closeDocumentViewer();
                    return;
                }
                // 2. Nabídka otázek pro nový projekt (z-[70])
                const offerModal = document.getElementById("modalNewProjectQuestionsOffer");
                if (offerModal && !offerModal.classList.contains("hidden")) {
                    closeNewProjectQuestionsOfferModal();
                    return;
                }
                // 3. Import do plánovače (z-[60])
                const importModal = document.getElementById("modalPlannerImport");
                if (importModal && !importModal.classList.contains("hidden")) {
                    closePlannerImportModal();
                    return;
                }
                // 4. Přidat / upravit otázku do plánovače (z-[60])
                const addQModal = document.getElementById("modalPlannerAddQuestion");
                if (addQModal && !addQModal.classList.contains("hidden")) {
                    closePlannerAddQuestionModal();
                    return;
                }
                // 5. Centrální správce otázek (z-50)
                const qmModal = document.getElementById("modalQuestionsManager");
                if (qmModal && !qmModal.classList.contains("hidden")) {
                    closeQuestionsManagerModal();
                    return;
                }
                // 6. Medulingo studijní průvodce (z-50)
                const medModal = document.getElementById("medulingoPathModal");
                if (medModal && !medModal.classList.contains("hidden")) {
                    closeMedulingoModal();
                    return;
                }
                // 7. Export / Import projektů (z-50)
                const expModal = document.getElementById("modalProjectExport");
                if (expModal && !expModal.classList.contains("hidden")) {
                    closeProjectExportModal();
                    return;
                }
                const impModal = document.getElementById("modalProjectImport");
                if (impModal && !impModal.classList.contains("hidden")) {
                    closeProjectImportModal();
                    return;
                }
                // 8. Správa projektů (z-50)
                const pmModal = document.getElementById("modalProjectManager");
                if (pmModal && !pmModal.classList.contains("hidden")) {
                    closeProjectManagerModal();
                    return;
                }
                // 8. Nastavení aplikace & klíče (z-50)
                const setModal = document.getElementById("modalSettings");
                if (setModal && !setModal.classList.contains("hidden")) {
                    closeSettingsModal();
                    return;
                }
                // 9. Nová lekce (z-50)
                const lessonModal = document.getElementById("modalNewLesson");
                if (lessonModal && !lessonModal.classList.contains("hidden")) {
                    closeNewLessonModal();
                    return;
                }
                // 10. Pomodoro dokončení (z-50)
                const pomoModal = document.getElementById("modalPomodoroComplete");
                if (pomoModal && !pomoModal.classList.contains("hidden")) {
                    closePomodoroCompleteModal();
                    return;
                }
                // 11. Uvítací průvodce (z-50)
                const welcomeModal = document.getElementById("modalWelcome");
                if (welcomeModal && !welcomeModal.classList.contains("hidden")) {
                    closeWelcomeModal();
                    return;
                }
            }
        });

        function registerProjectSources(proj, sources) {
            if (!proj || !sources || !Array.isArray(sources)) return;
            window.projectSourcesCache = window.projectSourcesCache || {};
            window.projectSourcesCache[proj] = window.projectSourcesCache[proj] || {};
            sources.forEach(s => {
                if (s && s.id !== undefined && s.filename) {
                    window.projectSourcesCache[proj][String(s.id)] = s.filename;
                }
            });
        }

        async function handleCitationClick(event, id, page = "", project = "") {
            if (event) event.stopPropagation();
            highlightSourceCard(id);

            const proj = project || (activeMedQuestion && activeMedQuestion.project) || window.currentNotesProject || currentProject;
            let filename = "";

            // 1. Zkontrolujeme, zda 'id' už není přímo název souboru
            if (typeof id === "string" && (id.endsWith(".pdf") || id.endsWith(".docx") || id.endsWith(".pptx") || id.endsWith(".txt") || id.endsWith(".md"))) {
                filename = id;
            }

            // 2. Medulingo zdroje
            if (!filename && window.currentMedulingoSources && window.currentMedulingoSources.length > 0) {
                const s = window.currentMedulingoSources.find(x => String(x.id) === String(id));
                if (s) filename = s.filename;
            }
            if (!filename && activeMedQuestion && activeMedQuestion.sources && activeMedQuestion.sources.length > 0) {
                const s = activeMedQuestion.sources.find(x => String(x.id) === String(id));
                if (s) filename = s.filename;
            }

            // 3. Studijní texty / poznámky zdroje
            if (!filename && window.currentNotesSources && window.currentNotesSources.length > 0) {
                const s = window.currentNotesSources.find(x => String(x.id) === String(id));
                if (s) filename = s.filename;
            }

            // 4. Chat zdroje
            if (!filename && window.chatSources && window.chatSources.length > 0) {
                const s = window.chatSources.find(x => String(x.id) === String(id));
                if (s) filename = s.filename;
            }

            // 5. Kartičky (Deck) zdroje
            if (!filename && window.currentDeck && window.currentDeck.sources && window.currentDeck.sources.length > 0) {
                const s = window.currentDeck.sources.find(x => String(x.id) === String(id));
                if (s) filename = s.filename;
            }

            // 6. Lekce zdroje
            if (!filename && window.currentLessonSources && window.currentLessonSources.length > 0) {
                const s = window.currentLessonSources.find(x => String(x.id) === String(id));
                if (s) filename = s.filename;
            }

            // 7. Globální cache zdrojů pro daný projekt
            if (!filename && window.projectSourcesCache && proj && window.projectSourcesCache[proj]) {
                const cached = window.projectSourcesCache[proj];
                if (cached[String(id)]) filename = cached[String(id)];
            }

            // 8. Pokud stále nemáme soubor, zkusíme načíst soubory projektu ze serveru
            if (!filename && proj) {
                try {
                    const res = await fetch(`/api/files?project=${encodeURIComponent(proj)}`);
                    if (res.ok) {
                        const data = await res.json();
                        const files = data.files || [];
                        const num = parseInt(id, 10);
                        if (!isNaN(num) && num >= 1 && num <= files.length) {
                            filename = files[num - 1];
                        } else if (files.length === 1) {
                            filename = files[0];
                        }
                    }
                } catch (e) {
                    console.warn("Chyba při dotazu na soubory projektu:", e);
                }
            }

            if (filename) {
                openDocumentViewer(filename, page, proj);
            } else {
                appendConsoleLog(`⚠️ Zdroj #${id} nebyl nalezen mezi podklady projektu '${proj}'.`);
                alert(`Zdroj #${id} nebyl nalezen v podkladech projektu "${proj}". Zkontrolujte nahrané soubory.`);
            }
        }

        function handleDirectCitationClick(event, filename, page = "", project = "") {
            if (event) event.stopPropagation();
            const proj = project || (activeMedQuestion && activeMedQuestion.project) || window.currentNotesProject || currentProject;
            openDocumentViewer(filename, page, proj);
        }

        function createCitationBadge(idOrFile, page = "", isDirect = false) {
            const cleanPage = page ? String(page).trim() : "";
            const pageLabel = cleanPage ? `, s. ${cleanPage}` : "";
            if (isDirect) {
                const cleanFile = String(idOrFile).trim();
                const safeFile = cleanFile.replace(/'/g, "\\'");
                const safePage = cleanPage.replace(/'/g, "\\'");
                return `<span class="inline-citation cursor-pointer hover:bg-sky-950/80 hover:border-sky-500 transition" onclick="handleDirectCitationClick(event, '${safeFile}', '${safePage}')" title="Kliknutím otevřít ${cleanFile}${pageLabel}"><sup>📖 ${cleanFile}${pageLabel}</sup></span>`;
            } else {
                const cleanId = String(idOrFile).trim();
                const safeId = cleanId.replace(/'/g, "\\'");
                const safePage = cleanPage.replace(/'/g, "\\'");
                let knownFile = "";
                const proj = (activeMedQuestion && activeMedQuestion.project) || window.currentNotesProject || currentProject;
                if (window.currentMedulingoSources) {
                    const s = window.currentMedulingoSources.find(x => String(x.id) === String(cleanId));
                    if (s) knownFile = s.filename;
                }
                if (!knownFile && window.currentNotesSources) {
                    const s = window.currentNotesSources.find(x => String(x.id) === String(cleanId));
                    if (s) knownFile = s.filename;
                }
                if (!knownFile && window.projectSourcesCache && proj && window.projectSourcesCache[proj]) {
                    if (window.projectSourcesCache[proj][cleanId]) knownFile = window.projectSourcesCache[proj][cleanId];
                }
                const tooltip = knownFile 
                    ? `Kliknutím otevřít ${knownFile}${pageLabel}` 
                    : `Kliknutím otevřít zdroj #${cleanId}${pageLabel}`;
                return `<span class="inline-citation cursor-pointer hover:bg-sky-950/80 hover:border-sky-500 transition" data-src-id="${safeId}" onclick="handleCitationClick(event, '${safeId}', '${safePage}')" title="${tooltip}"><sup>[${cleanId}${pageLabel}]</sup></span>`;
            }
        }

        function parseCitationBracketContent(content) {
            if (!content) return null;
            const trimmed = content.trim();

            // Formát přímého odkazu na soubor: [Zdroj: soubor.pdf, s. 45]
            const directMatch = trimmed.match(/^(?:Zdroj:\s*)?([^,\]]+\.(?:pdf|docx|pptx|txt|md))(?:,\s*s(?:tr)?\.?\s*([^\]]+))?$/i);
            if (directMatch) {
                return createCitationBadge(directMatch[1].trim(), directMatch[2] ? directMatch[2].trim() : "", true);
            }

            // Sekvence citací: [1, s. 434], [1, s. 434; 3, s. 359], [1, s. 434 3, s. 359], [1, 2, 3], [1]
            const pat = /^(?:Zdroj\s*)?(\d+)(?:,\s*s(?:tr)?\.?\s*([0-9–\-]+(?:,\s*(?!\d+,\s*s(?:tr)?\.)[0-9–\-]+)*))?/i;
            
            let remainder = trimmed;
            const badges = [];
            
            while (remainder.length > 0) {
                remainder = remainder.replace(/^[\s;,]+/, "");
                if (!remainder) break;
                
                const m = pat.exec(remainder);
                if (!m || !m[1]) {
                    return null; // Není to rozpoznaná citace
                }
                
                const srcId = m[1];
                const srcPage = m[2] ? m[2].trim() : "";
                badges.push(createCitationBadge(srcId, srcPage));
                remainder = remainder.substring(m[0].length);
            }
            
            return badges.length > 0 ? badges.join(" ") : null;
        }

        function formatInlineCitations(text) {
            if (!text) return "";
            // 0. Odstranění nechtěných zpětných apostrofů okolo citací
            text = text.replace(/`(\[(?:Zdroj\s*)?\d+[^\]]*\])`/g, "$1");
            text = text.replace(/`(\[(?:Zdroj\s*)?\d+)/g, "$1");

            // Rozdělení textu podle HTML tagů, abychom NIKDY nenahrazovali uvnitř tagů či atributů (např. title="", onclick="")
            const tagRegex = /(<[^>]+>)/g;
            const tokens = text.split(tagRegex);
            let citationDepth = 0;

            for (let i = 0; i < tokens.length; i++) {
                let tok = tokens[i];
                if (i % 2 === 1) {
                    // HTML tag
                    if (/class=[\"'][^\"']*inline-citation[^\"']*[\"']/i.test(tok)) {
                        citationDepth++;
                    } else if (tok === "</span>" && citationDepth > 0) {
                        citationDepth--;
                    }
                } else {
                    // Text mimo HTML tagy
                    if (citationDepth > 0) {
                        continue;
                    }

                    // 1. Již zabalené v <sup>...</sup> (např. <sup>[1, s. 434]</sup> nebo <sup>1, s. 434</sup>)
                    tok = tok.replace(/<sup>(.*?)<\/sup>/gi, (m, inner) => {
                        const cleanInner = inner.replace(/^\[|\]$/g, '').trim();
                        const res = parseCitationBracketContent(cleanInner);
                        return res !== null ? res : m;
                    });

                    // 2. Formát [Zdroj: název_souboru, s. X] nebo [Zdroj: název_souboru]
                    tok = tok.replace(/\[Zdroj:\s*([^,\]]+)(?:,\s*s(?:tr)?\.?\s*([^\]]+))?\]/gi, (m, fn, pg) => {
                        return createCitationBadge(fn, pg, true);
                    });

                    // 3. Citace v hranatých závorkách: [1, s. 434], [1, s. 434; 3, s. 359], [1, s. 434 3, s. 359], [1, 2, 3] atd.
                    tok = tok.replace(/\[((?:Zdroj\s*)?\d+[^\]]*)\]/gi, (m, inner) => {
                        const res = parseCitationBracketContent(inner.trim());
                        return res !== null ? res : m;
                    });

                    // 4. Citace v textu bez hranatých závorek: např. "1, s. 434" nebo "1, s. 434 3, s. 359"
                    const unbracketedPat = /(?:(?<=\s)|(?<=\()|^)(?:Zdroj\s*)?(\d+),\s*s(?:tr)?\.?\s*([0-9–\-]+(?:,\s*(?!\d+,\s*s(?:tr)?\.)[0-9–\-]+)*)(?=[.,;:\s\)]|$)/gi;
                    tok = tok.replace(unbracketedPat, (m, srcId, srcPage) => {
                        return createCitationBadge(srcId, srcPage);
                    });

                    tokens[i] = tok;
                }
            }
            return tokens.join("");
        }

        function highlightSourceCard(id) {
            const el = document.getElementById(`source-item-${id}`);
            if (el) {
                el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                el.classList.add('ring-2', 'ring-emerald-400', 'bg-emerald-950/80');
                setTimeout(() => {
                    el.classList.remove('ring-2', 'ring-emerald-400', 'bg-emerald-950/80');
                }, 2500);
            }
        }

        function appendChatMessageToUI(msg, isStreaming = false) {
            const listEl = document.getElementById("chatMessagesList");
            if (!listEl) return null;
            const isUser = msg.role === "user";

            const msgWrapper = document.createElement("div");
            msgWrapper.id = `chatMsg-${msg.id || Date.now()}`;
            msgWrapper.className = `flex gap-3 ${isUser ? "justify-end" : "justify-start"} items-start`;

            const avatarHtml = isUser
                ? `<div class="w-8 h-8 rounded-full bg-slate-700 border border-slate-600 flex items-center justify-center text-xs shrink-0 order-2">👤</div>`
                : `<div class="w-8 h-8 rounded-full bg-indigo-950 border border-indigo-700 flex items-center justify-center text-xs shrink-0">🤖</div>`;

            let parsedContent = "";
            try {
                parsedContent = renderMarkdownWithKaTeX(msg.content || "");
            } catch (e) {
                parsedContent = msg.content || "";
            }

            let sourcesHtml = "";
            if (msg.sources && msg.sources.length > 0) {
                window.chatSources = msg.sources;
                const srcCards = msg.sources.map(s => `
                    <div id="source-item-${s.id || ''}" class="p-2 bg-slate-950/80 hover:bg-slate-900 rounded border border-slate-800 hover:border-sky-500/60 text-[11px] space-y-1 transition-all cursor-pointer group" onclick="openDocumentViewer('${s.filename || ''}', '${s.page || ''}', currentProject)" title="Kliknutím otevřít ${s.filename || ''}">
                        <div class="font-bold text-emerald-400 group-hover:text-sky-300 flex items-center justify-between">
                            <span class="flex items-center gap-1.5 truncate">
                                <span>📄</span> [Zdroj ${s.id || '?'}] ${s.filename || 'Dokument'}
                            </span>
                            <span class="text-[10px] text-sky-400 font-mono font-bold">↗</span>
                        </div>
                        ${s.snippet ? `<div class="text-slate-400 italic text-[10px] line-clamp-2">${s.snippet}</div>` : ""}
                    </div>
                `).join("");

                sourcesHtml = `
                    <div class="mt-3 pt-2 border-t border-indigo-900/40">
                        <details class="text-[11px]">
                            <summary class="cursor-pointer text-indigo-400 hover:text-indigo-300 font-bold select-none flex items-center gap-1">
                                <span>📚</span> Citované zdroje v odpovědi (${msg.sources.length})
                            </summary>
                            <div class="mt-2 space-y-1.5 pl-2 border-l border-indigo-800/60">
                                ${srcCards}
                            </div>
                        </details>
                    </div>
                `;
            }

            let statusHtml = "";
            if (msg.error) {
                statusHtml = `<div class="mt-2 p-2 rounded bg-red-950/60 border border-red-800 text-xs text-red-300 font-semibold flex items-center gap-1.5"><span>⚠️</span> Chyba: ${escapeHtml(msg.error)}</div>`;
            } else if (msg.aborted) {
                statusHtml = `<div class="mt-1 text-[11px] text-amber-400 italic font-mono">// Generování zastaveno uživatelem.</div>`;
            }

            const bubbleHtml = `
                <div class="max-w-2xl rounded-2xl p-4 text-xs sm:text-sm leading-relaxed shadow-md ${
                    isUser
                        ? "bg-slate-800 text-slate-100 rounded-tr-none border border-slate-700 order-1"
                        : "bg-slate-900/95 text-slate-100 rounded-tl-none border border-indigo-700/50 markdown-content"
                }">
                    <div class="flex items-center justify-between gap-4 mb-1.5 text-[10px] text-slate-400 border-b ${isUser ? "border-slate-700" : "border-indigo-900/60"} pb-1">
                        <span class="font-bold uppercase tracking-wider ${isUser ? "text-slate-400" : "text-indigo-300"}">
                            ${isUser ? "Vy" : "Asistent (Grounded)"}
                        </span>
                        <span class="font-mono text-slate-500">${msg.created_at || new Date().toLocaleTimeString()}</span>
                    </div>
                    <div class="chat-bubble-body">${parsedContent}${isStreaming ? '<span class="inline-block w-1.5 h-3.5 bg-indigo-400 ml-1 animate-pulse align-middle"></span>' : ''}</div>
                    ${sourcesHtml}
                    ${statusHtml}
                </div>
            `;

            msgWrapper.innerHTML = isUser ? `${bubbleHtml}${avatarHtml}` : `${avatarHtml}${bubbleHtml}`;
            listEl.appendChild(msgWrapper);


            listEl.scrollTop = listEl.scrollHeight;
            return msgWrapper;
        }

        async function sendChatMessage() {
            let activeProj = currentProject;
            if (activeLessonChatContext) {
                activeProj = activeLessonChatContext.id;
            } else if (!activeProj && currentChatThreadData && currentChatThreadData.project_id) {
                activeProj = currentChatThreadData.project_id;
                if (!activeProj.startsWith("lekce_") && !activeProj.startsWith("lesson_")) {
                    currentProject = activeProj;
                    const pSelect = document.getElementById("projectSelect");
                    if (pSelect) pSelect.value = activeProj;
                }
            }

            if (!activeProj) {
                alert("Nejprve vyberte projekt v horní liště nebo otevřete výukovou lekci.");
                return;
            }
            if (isChatStreaming) return;

            const inputEl = document.getElementById("chatInputText");
            const text = (inputEl.value || "").trim();
            if (!text) return;

            inputEl.value = "";
            inputEl.style.height = "auto";

            const suggestions = document.getElementById("chatSuggestionsBar");
            if (suggestions) suggestions.classList.add("hidden");

            const userMsg = {
                id: `user-${Date.now()}`,
                role: "user",
                content: text,
                created_at: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            };
            chatMessages.push(userMsg);
            appendChatMessageToUI(userMsg);

            const btnSend = document.getElementById("btnChatSend");
            const btnStop = document.getElementById("btnChatStop");
            if (btnSend) btnSend.classList.add("hidden");
            if (btnStop) btnStop.classList.remove("hidden");
            isChatStreaming = true;

            const assistantMsg = {
                id: `asst-${Date.now()}`,
                role: "assistant",
                content: "",
                sources: [],
                created_at: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            };
            const assistantBubbleWrapper = appendChatMessageToUI(assistantMsg, true);
            const contentContainer = assistantBubbleWrapper.querySelector(".chat-bubble-body");

            chatAbortController = new AbortController();
            const model = document.getElementById("chatModelSelect") ? document.getElementById("chatModelSelect").value : "gemini-3.6-flash";

            try {
                const response = await fetch("/api/chat/completions", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        project: activeProj,
                        message: text,
                        model: model,
                        thread_id: currentChatThreadId,
                    }),
                    signal: chatAbortController.signal,
                });

                if (!response.ok) {
                    const errText = await response.text();
                    throw new Error(errText || "Chyba při komunikaci se serverem.");
                }

                const reader = response.body.getReader();
                const decoder = new TextDecoder("utf-8");
                let buffer = "";

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split("\n\n");
                    buffer = lines.pop();

                    for (const block of lines) {
                        if (!block.trim()) continue;
                        const eventMatch = block.match(/^event:\s*(\w+)/m);
                        const dataMatch = block.match(/^data:\s*(.+)$/m);

                        if (!dataMatch) continue;
                        const eventType = eventMatch ? eventMatch[1] : "message";
                        let dataObj;
                        try {
                            dataObj = JSON.parse(dataMatch[1]);
                        } catch (e) {
                            dataObj = { raw: dataMatch[1] };
                        }

                        if (dataObj && dataObj.thread_id && !currentChatThreadId) {
                            currentChatThreadId = dataObj.thread_id;
                        }

                        if (eventType === "sources") {
                            assistantMsg.sources = dataObj.sources || [];
                        } else if (eventType === "token") {
                            assistantMsg.content += dataObj.delta || "";
                            try {
                                contentContainer.innerHTML = renderMarkdownWithKaTeX(assistantMsg.content) + '<span class="inline-block w-1.5 h-3.5 bg-indigo-400 ml-1 animate-pulse align-middle"></span>';
                            } catch (e) {
                                contentContainer.textContent = assistantMsg.content;
                            }
                            const listEl = document.getElementById("chatMessagesList");
                            if (listEl) listEl.scrollTop = listEl.scrollHeight;
                        } else if (eventType === "done") {
                            assistantMsg.id = dataObj.message_id || assistantMsg.id;
                            assistantMsg.content = dataObj.full_text || assistantMsg.content;
                            assistantMsg.sources = dataObj.sources || assistantMsg.sources;
                            if (dataObj.thread_id) currentChatThreadId = dataObj.thread_id;
                            try {
                                contentContainer.innerHTML = renderMarkdownWithKaTeX(assistantMsg.content);
                            } catch (renderErr) {
                                console.warn("Final chat render error:", renderErr);
                            }
                        } else if (eventType === "error") {
                            assistantMsg.error = dataObj.error || "Neznámá chyba při streamování";
                            contentContainer.innerHTML += `<div class="mt-2 text-xs text-red-400 font-semibold p-2 bg-red-950/60 rounded border border-red-800">⚠️ Chyba: ${escapeHtml(assistantMsg.error)}</div>`;
                        }
                    }
                }

                if (!chatMessages.some(m => m.id === assistantMsg.id)) {
                    chatMessages.push(assistantMsg);
                }
            } catch (err) {
                if (err.name === "AbortError") {
                    assistantMsg.aborted = true;
                    contentContainer.innerHTML += `<div class="mt-1 text-[11px] text-amber-400 italic font-mono">${t("chat.stoppedByUser", "// Generování zastaveno uživatelem.")}</div>`;
                } else {
                    assistantMsg.error = err.message || "Chyba při komunikaci";
                    contentContainer.innerHTML += `<div class="mt-2 text-xs text-red-400 font-semibold p-2 bg-red-950/60 rounded border border-red-800">❌ Chyba: ${escapeHtml(assistantMsg.error)}</div>`;
                }
                if (!chatMessages.some(m => m.id === assistantMsg.id)) {
                    chatMessages.push(assistantMsg);
                }
            } finally {
                isChatStreaming = false;
                if (btnSend) btnSend.classList.remove("hidden");
                if (btnStop) btnStop.classList.add("hidden");
                chatAbortController = null;
                renderAllChatMessages();
                // Obnovíme vlákna v historii, aby se projevil nový název a čas aktivity
                loadChatThreads(currentChatThreadId);
            }
        }

        function stopChatStream() {
            if (chatAbortController) {
                chatAbortController.abort();
            }
        }

        function sendSuggestedQuery(keyOrText, fallback) {
            const input = document.getElementById("chatInputText");
            if (input) {
                input.value = typeof t === "function" ? t(keyOrText, fallback || keyOrText) : (fallback || keyOrText);
                sendChatMessage();
            }
        }

        function handleChatInputKey(e) {
            if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendChatMessage();
            }
        }

        async function clearCurrentChatHistory() {
            deleteCurrentChatThread();
        }

        function exportCurrentChatHistory() {
            if (currentChatThreadId) {
                window.location.href = `/api/chat/threads/${encodeURIComponent(currentChatThreadId)}/export`;
                return;
            }
            if (!currentProject) {
                alert("Nejprve vyberte projekt nebo otevřete konverzaci.");
                return;
            }
            window.location.href = `/api/projects/${encodeURIComponent(currentProject)}/chat/export`;
        }

        // =========================================================================
        // NOVÝ MODUL: VÝUKOVÁ LEKCE OD A DO Z (EDUCATIONAL LECTURE)
        // =========================================================================
        let selectedLessonFiles = [];
        let allLessonsList = [];
        let currentLessonData = null;

        function openNewLessonModal() {
            const modal = document.getElementById("modalNewLesson");
            if (!modal) return;
            modal.classList.remove("hidden");
            document.getElementById("newLessonProgressPanel").classList.add("hidden");
            document.getElementById("btnSubmitNewLesson").disabled = false;
            document.getElementById("btnCancelLessonModal").disabled = false;
            selectedLessonFiles = [];
            renderSelectedLessonFilesPreview();
            document.getElementById("newLessonTitle").value = "";
            document.getElementById("newLessonTitle").placeholder = typeof t === "function" ? t("modal.newLesson.topicPlaceholder", "Zadejte téma výukové lekce (např. Cévní mozková příhoda, Sepse)...") : "Zadejte téma výukové lekce (např. Cévní mozková příhoda, Sepse)...";
            
            const lessonLangMap = { cs: "Čeština", en: "English", fr: "Français" };
            const lessonLangSelect = document.getElementById("newLessonLanguage");
            if (lessonLangSelect && lessonLangMap[currentLanguage]) {
                lessonLangSelect.value = lessonLangMap[currentLanguage];
            }

            if (typeof syncQuestionsDropdowns === "function") {
                syncQuestionsDropdowns();
            }
        }

        function closeNewLessonModal() {
            const modal = document.getElementById("modalNewLesson");
            if (modal) modal.classList.add("hidden");
        }

        function onNewLessonTTSProviderChange() {
            const provider = document.getElementById("newLessonTTSProvider").value;
            const voiceSelect = document.getElementById("newLessonTTSVoice");
            if (!voiceSelect) return;
            if (provider === "elevenlabs") {
                voiceSelect.innerHTML = `
                    <option value="21m00Tcm4TlvDq8ikWAM" selected>Rachel (Přirozená, expresivní přednášející)</option>
                    <option value="AZnzlk1XvdvUeBnXmlld">Domi (Mladá, energická pedagožka)</option>
                    <option value="EXAVITQu4vr4xnSDxMaL">Bella (Kultivovaný akademický projev)</option>
                    <option value="ErXwobaYiN019PkySvjV">Antoni (Klidný a vyrovnaný profesor)</option>
                    <option value="MF3mGyEYCl7XYWbV9V6O">Elli (Čistý a jasný ženský hlas)</option>
                    <option value="TxGEqnHWrfWFTfGW9XjX">Josh (Hluboký, poutavý přednášející)</option>
                    <option value="VR6AewLTigWG4xSOukaG">Arnold (Autoritativní starší profesor)</option>
                `;
            } else {
                voiceSelect.innerHTML = `
                    <option value="onyx" selected>Onyx (Hluboký, autoritativní profesor)</option>
                    <option value="echo">Echo (Vyrovnaný, energický přednášející)</option>
                    <option value="alloy">Alloy (Neutrální, jasný akademický tón)</option>
                    <option value="fable">Fable (Poutavý britský tón)</option>
                    <option value="nova">Nova (Kultivovaný ženský přednáškový hlas)</option>
                    <option value="shimmer">Shimmer (Jasný, expresivní ženský hlas)</option>
                `;
            }
        }

        function onNewLessonFilesSelected(e) {
            const files = e.target.files;
            if (!files || files.length === 0) return;
            for (let i = 0; i < files.length; i++) {
                selectedLessonFiles.push(files[i]);
            }
            renderSelectedLessonFilesPreview();
            e.target.value = "";
        }

        function removeSelectedLessonFile(index) {
            selectedLessonFiles.splice(index, 1);
            renderSelectedLessonFilesPreview();
        }

        function renderSelectedLessonFilesPreview() {
            const container = document.getElementById("newLessonFilesPreviewList");
            if (!container) return;
            if (!selectedLessonFiles || selectedLessonFiles.length === 0) {
                container.innerHTML = "";
                return;
            }

            container.innerHTML = selectedLessonFiles.map((f, idx) => {
                const sizeKb = (f.size / 1024).toFixed(0);
                const ext = f.name.split('.').pop().toUpperCase();
                return `
                    <div class="flex justify-between items-center bg-slate-900 px-3 py-1.5 rounded-lg border border-slate-800 text-xs">
                        <div class="flex items-center gap-2 truncate">
                            <span class="text-[10px] font-bold bg-slate-800 text-teal-300 px-1.5 py-0.5 rounded border border-slate-700">${ext}</span>
                            <span class="text-slate-200 truncate font-medium">${f.name}</span>
                            <span class="text-slate-500 text-[10px]">(${sizeKb} KB)</span>
                        </div>
                        <button onclick="removeSelectedLessonFile(${idx})" class="text-slate-400 hover:text-red-400 px-1 font-bold">✕</button>
                    </div>
                `;
            }).join("");
        }

        async function submitGenerateLesson() {
            const title = (document.getElementById("newLessonTitle").value || "").trim();
            if (!title) {
                alert(t("lesson.fillTopic", "Vyplňte prosím téma nebo název výukové lekce."));
                return;
            }
            if (!selectedLessonFiles || selectedLessonFiles.length === 0) {
                alert(t("lesson.uploadSourceFirst", "Nahrajte alespoň jeden soubor s podklady (PDF, sken, obrázek)."));
                return;
            }

            const targetLang = document.getElementById("newLessonLanguage").value;
            const model = document.getElementById("newLessonModel").value;
            const ttsProvider = document.getElementById("newLessonTTSProvider").value;
            const ttsVoice = document.getElementById("newLessonTTSVoice").value;

            const progressPanel = document.getElementById("newLessonProgressPanel");
            progressPanel.classList.remove("hidden");
            document.getElementById("btnSubmitNewLesson").disabled = true;
            document.getElementById("btnCancelLessonModal").disabled = true;

            const progressBar = document.getElementById("newLessonProgressBar");
            const stageLabel = document.getElementById("newLessonProgressStageLabel");
            const pctLabel = document.getElementById("newLessonProgressPctLabel");
            const statusText = document.getElementById("newLessonProgressStatusText");

            progressBar.style.width = "10%";
            stageLabel.textContent = t("lesson.sendingFiles", "Odesílám soubory...");
            pctLabel.textContent = "10%";
            statusText.textContent = t("lesson.uploadingToServer", "Nahrávám podklady na server...");

            const formData = new FormData();
            formData.append("title", title);
            formData.append("target_language", targetLang);
            formData.append("gemini_model", model);
            formData.append("tts_provider", ttsProvider);
            formData.append("tts_voice", ttsVoice);
            selectedLessonFiles.forEach(f => {
                formData.append("files", sanitizeFile(f));
            });

            try {
                const res = await fetch("/api/lessons/generate", {
                    method: "POST",
                    body: formData,
                });

                if (!res.ok) {
                    let errDetail = `Chyba serveru (${res.status})`;
                    try {
                        const err = await res.json();
                        errDetail = err.detail || "Chyba při generování lekce.";
                    } catch (e) {
                        // Někdy může server vrátit HTML (např. 413 Payload Too Large)
                    }
                    throw new Error(errDetail);
                }

                const data = await res.json();
                progressBar.style.width = "100%";
                stageLabel.textContent = t("lesson.completedTitle", "Dokončeno! 🎉");
                pctLabel.textContent = "100%";
                statusText.textContent = "Lekce úspěšně vytvořena. Otevírám prohlížeč lekce...";

                setTimeout(async () => {
                    closeNewLessonModal();
                    switchTab("lesson");
                    await loadLessonsList(data.project_id);
                }, 1200);

            } catch (err) {
                progressBar.classList.add("bg-red-500");
                stageLabel.textContent = t("lesson.errorProcessing", "Chyba při zpracování ❌");
                statusText.textContent = err.message;
                document.getElementById("btnSubmitNewLesson").disabled = false;
                document.getElementById("btnCancelLessonModal").disabled = false;
            }
        }

        function handleLessonProgressEvent(data) {
            const progressBar = document.getElementById("newLessonProgressBar");
            const stageLabel = document.getElementById("newLessonProgressStageLabel");
            const pctLabel = document.getElementById("newLessonProgressPctLabel");
            const statusText = document.getElementById("newLessonProgressStatusText");

            if (!progressBar) return;
            const pct = data.percentage || 0;
            progressBar.style.width = `${pct}%`;
            if (pctLabel) pctLabel.textContent = `${pct}%`;
            if (statusText && data.message) statusText.textContent = data.message;

            const stageNames = {
                "extracting": "1/4 Ingesce & Multimodální OCR",
                "generating_markdown": "2/4 Generování studijního textu (Markdown)",
                "generating_lecture": "3/4 Tvorba scénáře přednášky",
                "synthesizing_audio": "4/4 Syntéza mluveného audia (TTS)",
                "finalizing": "Dokončuji kapitoly a ukládám...",
                "complete": "Hotovo!",
            };
            if (stageLabel && data.step && stageNames[data.step]) {
                stageLabel.textContent = stageNames[data.step];
            }
        }

        async function loadLessonsList(autoSelectProjectId = null) {
            try {
                const res = await fetch("/api/lessons");
                const data = await res.json();
                allLessonsList = data.lessons || [];

                const sel = document.getElementById("lessonSelect");
                if (!sel) return;
                sel.innerHTML = '<option value="">-- Vyberte lekci --</option>';

                allLessonsList.forEach(l => {
                    const opt = document.createElement("option");
                    opt.value = l.project_id;
                    opt.textContent = `${l.title} (${l.target_language || 'CZ'})`;
                    sel.appendChild(opt);
                });

                const targetProj = autoSelectProjectId || (allLessonsList.length > 0 ? allLessonsList[0].project_id : null);
                if (targetProj) {
                    sel.value = targetProj;
                    await onLessonSelectChange();
                } else {
                    renderEmptyLessonViewer();
                }
            } catch (err) {
                console.error("Chyba při načítání lekcí:", err);
            }
        }

        async function onLessonSelectChange() {
            const sel = document.getElementById("lessonSelect");
            const projId = sel ? sel.value : "";
            if (!projId) {
                renderEmptyLessonViewer();
                return;
            }

            try {
                const res = await fetch(`/api/lessons/${encodeURIComponent(projId)}`);
                if (!res.ok) throw new Error("Lekce nenalezena.");
                const data = await res.json();
                currentLessonData = data.lesson;
                renderLessonDetails(currentLessonData);
            } catch (err) {
                alert(`Chyba při načítání detailu lekce: ${err.message}`);
            }
        }

        function renderLessonDetails(lesson) {
            if (!lesson) return;

            document.getElementById("lessonViewerHeaderTitle").textContent = lesson.title || "Výuková lekce";
            document.getElementById("lessonLanguageBadge").textContent = lesson.target_language || "Čeština";

            const mdContainer = document.getElementById("lessonMarkdownRendered");
            try {
                mdContainer.innerHTML = renderMarkdownWithKaTeX(lesson.markdown_content || "");
            } catch (e) {
                mdContainer.textContent = lesson.markdown_content || "";
            }

            const audioPlayer = document.getElementById("lessonAudioPlayer");
            audioPlayer.src = lesson.audio_url || "";
            document.getElementById("btnLessonPlayPause").disabled = !lesson.audio_url;
            document.getElementById("lessonAudioScrubber").disabled = !lesson.audio_url;
            document.getElementById("btnDownloadLessonMd").disabled = false;
            document.getElementById("btnAskChatLesson").disabled = false;
            document.getElementById("btnDeleteLesson").disabled = false;

            renderLessonChapters(lesson.chapters || []);

            const scriptText = document.getElementById("lessonScriptText") || document.getElementById("lessonScriptBody");
            if (scriptText) scriptText.textContent = lesson.lecture_script || "Scénář není k dispozici.";

            if (window.lessonSearcher) {
                const q = document.getElementById("lessonSearchInput")?.value?.trim();
                if (q) window.lessonSearcher.search(q);
                else window.lessonSearcher.clearHighlights();
            }
            if (window.lessonScriptSearcher) {
                const sq = document.getElementById("lessonScriptSearchInput")?.value?.trim();
                if (sq) window.lessonScriptSearcher.search(sq);
                else window.lessonScriptSearcher.clearHighlights();
            }
        }

        function renderLessonChapters(chapters) {
            const container = document.getElementById("lessonChaptersList");
            const countLabel = document.getElementById("lessonChaptersCountLabel");
            if (countLabel) countLabel.textContent = `${chapters.length} kapitol`;

            if (!chapters || chapters.length === 0) {
                container.innerHTML = '<div class="p-3 text-center text-xs text-slate-500 italic bg-slate-900/60 rounded-lg border border-slate-800">Žádné kapitoly k zobrazení.</div>';
                return;
            }

            container.innerHTML = chapters.map((ch, idx) => `
                <div onclick="playLessonChapter(${ch.seconds})" id="chapterItem-${idx}" class="chapter-item cursor-pointer p-2 rounded-lg bg-slate-900/80 hover:bg-slate-750 border border-slate-800 hover:border-teal-500/50 flex items-center justify-between transition group">
                    <div class="flex items-center gap-2 truncate">
                        <span class="text-xs font-mono font-bold bg-slate-800 group-hover:bg-teal-900 group-hover:text-teal-300 text-teal-400 px-2 py-0.5 rounded border border-slate-700 transition">
                            ${ch.time || '00:00'}
                        </span>
                        <span class="text-xs font-medium text-slate-200 group-hover:text-white truncate">
                            ${ch.title || `Kapitola ${idx + 1}`}
                        </span>
                    </div>
                    <span class="text-xs text-slate-500 group-hover:text-teal-400 shrink-0 ml-2">▶</span>
                </div>
            `).join("");
        }

        function renderEmptyLessonViewer() {
            document.getElementById("lessonViewerHeaderTitle").textContent = t("lesson.defaultTitle", "Výuková lekce od A do Z");
            document.getElementById("lessonMarkdownRendered").innerHTML = `
                <div class="flex flex-col items-center justify-center h-64 text-center text-slate-500">
                    <span class="text-4xl mb-2">🎓</span>
                    <p class="text-sm font-semibold">Žádná lekce není vybrána.</p>
                    <p class="text-xs text-slate-400 mt-1">Zvolte lekci ze seznamu nebo vytvořte novou kliknutím na "➕ Nová lekce".</p>
                </div>
            `;
            document.getElementById("btnLessonPlayPause").disabled = true;
            document.getElementById("lessonAudioScrubber").disabled = true;
            document.getElementById("btnDownloadLessonMd").disabled = true;
            document.getElementById("btnAskChatLesson").disabled = true;
            document.getElementById("btnDeleteLesson").disabled = true;
            document.getElementById("lessonChaptersList").innerHTML = '<div class="p-3 text-center text-xs text-slate-500 italic bg-slate-900/60 rounded-lg border border-slate-800">Žádné kapitoly k zobrazení.</div>';

            if (window.lessonSearcher) window.lessonSearcher.clearHighlights();
            if (window.lessonScriptSearcher) window.lessonScriptSearcher.clearHighlights();
        }

        function toggleLessonAudioPlay() {
            const player = document.getElementById("lessonAudioPlayer");
            const icon = document.getElementById("lessonPlayIcon");
            if (player.paused) {
                player.play();
                icon.textContent = "⏸";
            } else {
                player.pause();
                icon.textContent = "▶";
            }
        }

        function onLessonAudioTimeUpdate() {
            const player = document.getElementById("lessonAudioPlayer");
            const scrubber = document.getElementById("lessonAudioScrubber");
            const curDisplay = document.getElementById("lessonCurrentTimeDisplay");
            const totDisplay = document.getElementById("lessonTotalTimeDisplay");
            const durBadge = document.getElementById("lessonAudioDurationBadge");

            if (!player.duration || isNaN(player.duration)) return;

            const pct = (player.currentTime / player.duration) * 100;
            scrubber.value = pct;

            const curMin = Math.floor(player.currentTime / 60);
            const curSec = Math.floor(player.currentTime % 60);
            const totMin = Math.floor(player.duration / 60);
            const totSec = Math.floor(player.duration % 60);

            const curFormatted = `${String(curMin).padStart(2, '0')}:${String(curSec).padStart(2, '0')}`;
            const totFormatted = `${String(totMin).padStart(2, '0')}:${String(totSec).padStart(2, '0')}`;

            curDisplay.textContent = curFormatted;
            totDisplay.textContent = totFormatted;
            if (durBadge) durBadge.textContent = totFormatted;

            if (currentLessonData && currentLessonData.chapters) {
                const chapters = currentLessonData.chapters;
                let activeIdx = 0;
                for (let i = 0; i < chapters.length; i++) {
                    if (player.currentTime >= chapters[i].seconds) {
                        activeIdx = i;
                    }
                }
                chapters.forEach((_, idx) => {
                    const el = document.getElementById(`chapterItem-${idx}`);
                    if (el) {
                        if (idx === activeIdx) {
                            el.classList.add("border-teal-400", "bg-teal-950/30");
                        } else {
                            el.classList.remove("border-teal-400", "bg-teal-950/30");
                        }
                    }
                });
            }
        }

        function onLessonScrubberInput() {
            const player = document.getElementById("lessonAudioPlayer");
            const scrubber = document.getElementById("lessonAudioScrubber");
            if (player.duration) {
                player.currentTime = (scrubber.value / 100) * player.duration;
            }
        }

        function onLessonAudioEnded() {
            const icon = document.getElementById("lessonPlayIcon");
            if (icon) icon.textContent = "▶";
        }

        function playLessonChapter(seconds) {
            const player = document.getElementById("lessonAudioPlayer");
            const icon = document.getElementById("lessonPlayIcon");
            player.currentTime = seconds;
            player.play();
            if (icon) icon.textContent = "⏸";
        }

        function setLessonPlaybackRate(rate) {
            const player = document.getElementById("lessonAudioPlayer");
            player.playbackRate = rate;
            const buttons = document.querySelectorAll(".lesson-rate-btn");
            buttons.forEach(b => {
                if (b.textContent.includes(`${rate}x`)) {
                    b.className = "lesson-rate-btn text-[10px] px-2 py-0.5 rounded bg-teal-900 text-teal-300 font-mono font-bold transition border border-teal-700";
                } else {
                    b.className = "lesson-rate-btn text-[10px] px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 font-mono transition";
                }
            });
        }

        function toggleLessonScript() {
            const body = document.getElementById("lessonScriptBody");
            const arrow = document.getElementById("lessonScriptToggleArrow");
            body.classList.toggle("hidden");
            if (body.classList.contains("hidden")) {
                arrow.textContent = "▼";
            } else {
                arrow.textContent = "▲";
            }
        }

        function downloadLessonMarkdown() {
            if (!currentLessonData || !currentLessonData.markdown_content) return;
            const blob = new Blob([currentLessonData.markdown_content], { type: "text/markdown;charset=utf-8" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `lekce_${currentLessonData.project_id || 'material'}.md`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }

        function openChatForCurrentLesson() {
            if (!currentLessonData || !currentLessonData.project_id) return;
            activeLessonChatContext = {
                id: currentLessonData.project_id,
                title: currentLessonData.title || "Výuková lekce"
            };
            switchTab("chat");
        }

        async function deleteSelectedLesson() {
            if (!currentLessonData || !currentLessonData.project_id) return;
            const projId = currentLessonData.project_id;
            if (!confirm(`Opravdu chcete smazat výukovou lekci "${currentLessonData.title}"?`)) return;

            try {
                await fetch(`/api/lessons/${encodeURIComponent(projId)}`, { method: "DELETE" });
                if (activeLessonChatContext && activeLessonChatContext.id === projId) {
                    activeLessonChatContext = null;
                }
                currentLessonData = null;
                await loadLessonsList();
            } catch (err) {
                alert(`Chyba při mazání lekce: ${err.message}`);
            }
        }

        // =========================================================================
        // PŮVODNÍ INFRASTRUKTURA A FUNKCE PODCAST STUDIA
        // =========================================================================
        function updateCharLimitLabel() {
            const val = document.getElementById("charLimitInput").value;
            const mins = val / 800;
            document.getElementById("charLimitLabel").textContent = `${val} (~${mins} min)`;
        }

        function setupSSE() {
            const eventSource = new EventSource("/api/logs");
            eventSource.addEventListener("log", (event) => {
                try {
                    appendConsoleLog(JSON.parse(event.data).message);
                } catch (e) {
                    appendConsoleLog(event.data);
                }
            });
            eventSource.addEventListener("batch", (event) => {
                try {
                    handleBatchEvent(JSON.parse(event.data));
                } catch (e) {
                    appendConsoleLog("⚠️ Nepodařilo se zpracovat aktualizaci stavu dávky.");
                }
            });
            eventSource.addEventListener("lesson_progress", (event) => {
                try {
                    handleLessonProgressEvent(JSON.parse(event.data));
                } catch (e) {
                    console.error("Chyba při parsování lesson_progress události:", e);
                }
            });
        }

        function appendConsoleLog(message) {
            const terminal = document.getElementById("liveTerminal");
            const autoScroll = document.getElementById("autoScrollToggle");
            const logDiv = document.createElement("div");
            const isError = String(message).startsWith("❌");
            const isWarning = String(message).startsWith("⚠️") || String(message).startsWith("🛑");
            logDiv.className = `border-l pl-2 py-0.5 break-words ${isError ? "border-red-700 text-red-300" : isWarning ? "border-amber-700 text-amber-300" : "border-slate-700"}`;
            logDiv.textContent = `> ${message}`;
            terminal.appendChild(logDiv);

            while (terminal.children.length > 250) {
                terminal.removeChild(terminal.firstChild);
            }
            if (autoScroll && autoScroll.checked) {
                terminal.scrollTop = terminal.scrollHeight;
            }
        }

        function showStatus(message, type = "info") {
            const icon = type === "success" ? "✅" : type === "error" ? "❌" : "ℹ️";
            appendConsoleLog(`${icon} ${message}`);
        }

        function setBatchControls(isRunning) {
            const btnSel = document.getElementById("btnBatchSelected");
            const btnMiss = document.getElementById("btnBatchMissing");
            const btnAll = document.getElementById("btnBatchAll");
            if (btnSel) btnSel.disabled = isRunning;
            if (btnMiss) btnMiss.disabled = isRunning;
            if (btnAll) btnAll.disabled = isRunning;
        }

        function updateQuestionsByIndexes(questionIndexes, status) {
            const targetIndexes = new Set(questionIndexes || []);
            if (targetIndexes.size === 0) return;

            let changed = false;
            questions.forEach(question => {
                if (targetIndexes.has(question.q_index) && question.status !== status) {
                    question.status = status;
                    changed = true;
                }
            });
            if (changed) {
                saveQuestionsToStorage();
                renderQuestionsTable();
            }
        }

        function handleBatchEvent(event) {
            if (event.project !== currentProject) return;
            const mode = event.mode || "podcast";

            if (event.type === "started") {
                const qIndexes = event.question_indexes || [];
                activeBatch = {
                    batchId: event.batch_id,
                    project: event.project,
                    mode: mode,
                    questionIndexes: qIndexes,
                    total: qIndexes.length,
                    completed: 0
                };

                if (mode === "notes") {
                    setNotesBatchControls(true);
                    updateNotesQuestionsStatus(qIndexes, "Processing");
                    updateNotesBatchProgress(0, qIndexes.length, `Spuštěna dávka textů (0 / ${qIndexes.length})...`);
                } else if (mode === "flashcards") {
                    setCardsBatchControls(true);
                    updateCardsQuestionsStatus(qIndexes, "Processing");
                    updateCardsBatchProgress(0, qIndexes.length, `Spuštěna dávka kartiček (0 / ${qIndexes.length})...`);
                } else {
                    setBatchControls(true);
                    updateQuestionsByIndexes(qIndexes, "Processing");
                }
                return;
            }

            if (event.type === "question_completed") {
                if (activeBatch && event.batch_id === activeBatch.batchId) {
                    activeBatch.completed = (activeBatch.completed || 0) + 1;
                }

                if (mode === "notes") {
                    updateNotesQuestionsStatus([event.question_index], "Done");
                    if (activeBatch) {
                        updateNotesBatchProgress(activeBatch.completed, activeBatch.total, `Dokončeno ${activeBatch.completed} z ${activeBatch.total} textů`);
                    }
                    loadSavedNotesList();
                    updateDashboardStats();
                } else if (mode === "flashcards") {
                    updateCardsQuestionsStatus([event.question_index], "Done");
                    if (activeBatch) {
                        updateCardsBatchProgress(activeBatch.completed, activeBatch.total, `Dokončeno ${activeBatch.completed} z ${activeBatch.total} sad kartiček`);
                    }
                    loadSavedFlashcardsList();
                    updateDashboardStats();
                } else {
                    updateQuestionsByIndexes([event.question_index], "Done");
                }
                return;
            }

            if (event.type === "question_failed") {
                if (mode === "notes") {
                    updateNotesQuestionsStatus([event.question_index], "Error");
                } else if (mode === "flashcards") {
                    updateCardsQuestionsStatus([event.question_index], "Error");
                } else {
                    updateQuestionsByIndexes([event.question_index], "Error");
                }
                return;
            }

            if (event.type === "finished") {
                finishedBatchIds.add(event.batch_id);
                const failedStatus = event.outcome === "cancelled" ? "Ready" : "Error";

                if (mode === "notes") {
                    updateNotesQuestionsStatus(event.completed_question_indexes, "Done");
                    updateNotesQuestionsStatus(event.pending_question_indexes, failedStatus);
                    setNotesBatchControls(false);
                    const doneCount = (event.completed_question_indexes || []).length;
                    const totalCount = doneCount + (event.pending_question_indexes || []).length;
                    let outcomeText = "✅ Dávka studijních textů dokončena!";
                    if (event.outcome === "cancelled") outcomeText = "🛑 Dávka textů byla zrušena.";
                    else if (event.outcome === "failed") outcomeText = "❌ Dávka selhala: " + (event.error || "");
                    else if (event.outcome === "completed_with_errors") outcomeText = `⚠️ Dokončeno ${doneCount}/${totalCount} textů. Chybějící lze dopracovat tlačítkem 'Spustit jen nehotové'.`;
                    updateNotesBatchProgress(doneCount, totalCount, outcomeText, true);
                    loadSavedNotesList();
                    updateDashboardStats();
                } else if (mode === "flashcards") {
                    updateCardsQuestionsStatus(event.completed_question_indexes, "Done");
                    updateCardsQuestionsStatus(event.pending_question_indexes, failedStatus);
                    setCardsBatchControls(false);
                    const doneCount = (event.completed_question_indexes || []).length;
                    const totalCount = doneCount + (event.pending_question_indexes || []).length;
                    let outcomeText = "✅ Dávka kartiček dokončena!";
                    if (event.outcome === "cancelled") outcomeText = "🛑 Dávka kartiček byla zrušena.";
                    else if (event.outcome === "failed") outcomeText = "❌ Dávka selhala: " + (event.error || "");
                    else if (event.outcome === "completed_with_errors") outcomeText = `⚠️ Dokončeno ${doneCount}/${totalCount} sad kartiček. Chybějící lze dopracovat tlačítkem 'Spustit jen nehotové'.`;
                    updateCardsBatchProgress(doneCount, totalCount, outcomeText, true);
                    loadSavedFlashcardsList();
                    updateDashboardStats();
                } else {
                    updateQuestionsByIndexes(event.completed_question_indexes, "Done");
                    updateQuestionsByIndexes(event.pending_question_indexes, failedStatus);
                    setBatchControls(false);
                    loadExplorer();
                    updateDashboardStats();
                }

                if (activeBatch && event.batch_id === activeBatch.batchId) {
                    activeBatch = null;
                }
                return;
            }
        }

        function toggleVoices() {
            const provider = document.getElementById("ttsProviderSelect").value;
            const voiceSelect = document.getElementById("ttsVoiceSelect");
            voiceSelect.innerHTML = "";
            voicesData[provider].forEach(v => {
                const opt = document.createElement("option");
                opt.value = v.id; opt.textContent = v.name;
                voiceSelect.appendChild(opt);
            });
        }

        function initPrompts() {
            const stored = localStorage.getItem("aiPodcastPrompts");
            if (stored) {
                try {
                    savedPrompts = JSON.parse(stored);
                    const defIdx = savedPrompts.findIndex(p => p.name === "Strukturovaný podcast (nový)");
                    if (defIdx !== -1) {
                        savedPrompts[defIdx].text = defaultPodcastPrompts[0].text;
                    }
                } catch(e) {
                    savedPrompts = [...defaultPodcastPrompts];
                }
            } else {
                savedPrompts = [...defaultPodcastPrompts];
            }
            renderPromptDropdown();
        }

        function resetPodcastPrompt() {
            const select = document.getElementById("promptSelect");
            const idx = select ? select.value : 0;
            if (confirm(t("podcast.confirmRestoreTemplate", "Opravdu chcete obnovit tuto šablonu promptu na výchozí hodnotu?"))) {
                savedPrompts[idx] = { ...defaultPodcastPrompts[0] };
                localStorage.setItem("aiPodcastPrompts", JSON.stringify(savedPrompts));
                loadSelectedPrompt();
                appendConsoleLog("🔄 Výchozí prompt pro podcast byl obnoven.");
            }
        }

        function renderPromptDropdown() {
            const select = document.getElementById("promptSelect");
            select.innerHTML = "";
            savedPrompts.forEach((p, idx) => {
                const opt = document.createElement("option");
                opt.value = idx; opt.textContent = p.name;
                select.appendChild(opt);
            });
            loadSelectedPrompt();
        }

        function loadSelectedPrompt() {
            const select = document.getElementById("promptSelect");
            if (savedPrompts[select.value]) {
                document.getElementById("systemPromptInput").value = savedPrompts[select.value].text;
            }
        }

        function addPrompt() {
            const currentText = document.getElementById("systemPromptInput").value;
            const name = prompt(t("podcast.templateNamePrompt", "Název šablony:"));
            if (name) {
                savedPrompts.push({ name: name.trim(), text: currentText });
                localStorage.setItem("aiPodcastPrompts", JSON.stringify(savedPrompts));
                renderPromptDropdown();
                document.getElementById("promptSelect").value = savedPrompts.length - 1;
            }
        }

        function savePrompt() {
            const idx = document.getElementById("promptSelect").value;
            if (savedPrompts[idx]) {
                savedPrompts[idx].text = document.getElementById("systemPromptInput").value;
                localStorage.setItem("aiPodcastPrompts", JSON.stringify(savedPrompts));
                alert(t("podcast.templateSaved", "Šablona uložena."));
            }
        }

        function getDynamicPrompt() {
            let prompt = document.getElementById("systemPromptInput").value;
            const limit = document.getElementById("charLimitInput").value;
            return prompt.replace(/{MAX_CHARS}/g, limit);
        }

        async function cancelProcessing() {
            if (currentAbortController) {
                currentAbortController.abort();
                currentAbortController = null;
            }

            if (activeBatch && activeBatch.project === currentProject) {
                try {
                    const res = await fetch("/api/cancel-batch", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ project: currentProject })
                    });
                    const data = await res.json();
                    if (res.ok && data.status === "cancelling") {
                        appendConsoleLog("🛑 Storno dávky odesláno. Dokončí se probíhající volání, další se nespustí.");
                        return;
                    }
                    activeBatch = null;
                    setBatchControls(false);
                    setNotesBatchControls(false);
                    setCardsBatchControls(false);
                } catch(e) {
                    appendConsoleLog("❌ Storno se nepodařilo odeslat.");
                    return;
                }
            }

            const btnS = document.getElementById("btnGenScript");
            if(btnS) { btnS.disabled = false; btnS.textContent = "1. Vygenerovat scénář"; }
            const btnA = document.getElementById("btnGenAudio");
            if(btnA) { btnA.disabled = false; btnA.textContent = "2. Syntetizovat nahrávku"; }

            let changed = false;
            questions.forEach(q => {
                if(q.status === "Processing") {
                    q.status = "Ready";
                    changed = true;
                }
                if(q.notesStatus === "Processing") {
                    q.notesStatus = "Ready";
                }
                if(q.cardsStatus === "Processing") {
                    q.cardsStatus = "Ready";
                }
            });
            if(changed) {
                saveQuestionsToStorage();
                renderQuestionsTable();
            }
            renderNotesBatchTable();
            renderCardsBatchTable();
            setBatchControls(false);
            setNotesBatchControls(false);
            setCardsBatchControls(false);
            loadExplorer();
        }

        async function runScriptGeneration() {
            if (activeBatch) {
                alert(t("podcast.noManualGenDuringBatch", "Během dávkového zpracování nelze spustit ruční generování."));
                return;
            }
            if(selectedQuestionIndex === null) return;
            const question = questions[selectedQuestionIndex].title;
            
            const btn = document.getElementById("btnGenScript");
            btn.disabled = true;
            btn.textContent = t("podcast.analyzingAndGenerating", "⏳ Analyzuji kontext a generuji scénář...");

            currentAbortController = new AbortController();

            const modelName = getSelectedModel("geminiModelSelect", "geminiModelCustomInput");

            try {
                const res = await fetch("/api/generate-script", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ 
                        question, 
                        prompt: getDynamicPrompt(), 
                        project: currentProject,
                        gemini_model: modelName
                    }),
                    signal: currentAbortController.signal
                });
                const data = await res.json();
                if(res.ok) {
                    document.getElementById("resultScriptTextarea").value = data.script;
                    document.getElementById("contextTextarea").value = data.context; 
                    document.getElementById("charCount").textContent = data.script.length;
                    document.getElementById("btnGenAudio").disabled = false;
                    
                    questions[selectedQuestionIndex].status = "In Progress";
                    saveQuestionsToStorage();
                    renderQuestionsTable();
                } else {
                    alert("Chyba při zpracování: " + data.detail);
                }
            } catch(e) {
                if (e.name !== 'AbortError') alert("Nelze navázat spojení se serverem.");
            } finally {
                currentAbortController = null;
                btn.disabled = false;
                btn.textContent = "1. Vygenerovat scénář";
            }
        }

        async function runAudioGeneration() {
            if (activeBatch) {
                alert(t("podcast.noManualSynthDuringBatch", "Během dávkového zpracování nelze spustit ruční syntézu."));
                return;
            }
            const script = document.getElementById("resultScriptTextarea").value;
            if(!script.trim() || selectedQuestionIndex === null) return;

            const btn = document.getElementById("btnGenAudio");
            btn.disabled = true;
            btn.textContent = "⏳ Generuji zvuk/video...";

            currentAbortController = new AbortController();
            const q = questions[selectedQuestionIndex];

            try {
                const res = await fetch("/api/generate-audio", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ 
                        script, 
                        filename: `${currentProject}_Q${q.q_index}_${q.title.substring(0, 15)}`,
                        question_title: q.title,
                        provider: document.getElementById("ttsProviderSelect").value,
                        voice: document.getElementById("ttsVoiceSelect").value,
                        format: document.getElementById("outputFormatSelect").value
                    }),
                    signal: currentAbortController.signal
                });
                const data = await res.json();
                if(res.ok) {
                    const outBox = document.getElementById("audioOutputBox");
                    outBox.classList.remove("hidden");
                    outBox.classList.add("flex");
                    document.getElementById("outputFilenameLabel").textContent = data.filename;
                    
                    const container = document.getElementById("mediaContainer");
                    container.innerHTML = "";
                    
                    if (data.format === "mp4") {
                        const video = document.createElement("video");
                        video.controls = true;
                        video.className = "w-full outline-none bg-black";
                        video.src = data.audio_url;
                        container.appendChild(video);
                    } else {
                        const audio = document.createElement("audio");
                        audio.controls = true;
                        audio.className = "w-full outline-none";
                        audio.src = data.audio_url;
                        container.appendChild(audio);
                        
                        const btn = document.createElement("button");
                        btn.className = "w-full mt-2 bg-emerald-700 hover:bg-emerald-600 text-white text-xs font-bold py-2 rounded transition";
                        btn.innerText = "▶ Přehrát se synchronizovaným textem";
                        btn.onclick = () => openPodcastPlayer(data.filename);
                        container.appendChild(btn);
                    }
                    
                    questions[selectedQuestionIndex].status = "Done";
                    saveQuestionsToStorage();
                    renderQuestionsTable();
                    loadExplorer();
                    updateDashboardStats();
                } else {
                    alert("Chyba syntézy: " + data.detail);
                }
            } catch(e) {
                if (e.name !== 'AbortError') alert("Chyba přenosu.");
            } finally {
                currentAbortController = null;
                btn.disabled = false;
                btn.textContent = "2. Syntetizovat nahrávku";
            }
        }

        async function runBatchProcessing(mode) {
            if (activeBatch) {
                alert(t("podcast.batchAlreadyRunning", "Dávka už běží. Vyčkejte na dokončení nebo použijte Storno."));
                return;
            }

            let target;
            if (mode === 'all') {
                target = questions.map(q => q);
            } else if (mode === 'missing') {
                target = questions.filter(q => q.status !== 'Done');
                if (target.length === 0) {
                    alert(t("podcast.allAudioReady", "Všechny otázky v podcast studiu již mají hotové audio (status 'Audio OK')! Žádné nehotové nezbývají."));
                    return;
                }
            } else {
                target = questions.filter(q => q.selected);
            }

            if (target.length === 0) {
                alert(t("podcast.noQuestionsSelectedBatch", "Nebyly vybrány žádné otázky pro dávkové zpracování."));
                return;
            }

            target.forEach(q => q.status = "Processing");
            saveQuestionsToStorage();
            renderQuestionsTable();
            setBatchControls(true);

            const modelName = getSelectedModel("geminiModelSelect", "geminiModelCustomInput");
            const isOvernight = document.getElementById("podcastOvernightMode")?.checked ?? true;

            try {
                const res = await fetch("/api/process-batch", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ 
                        questions: target.map(q => ({title: q.title, q_index: q.q_index})), 
                        prompt: getDynamicPrompt(),
                        provider: document.getElementById("ttsProviderSelect").value,
                        voice: document.getElementById("ttsVoiceSelect").value,
                        format: document.getElementById("outputFormatSelect").value,
                        project: currentProject,
                        gemini_model: modelName,
                        overnight_mode: isOvernight
                    })
                });
                const data = await res.json();
                if (!res.ok) {
                    throw new Error(data.detail || "Dávku se nepodařilo spustit.");
                }

                if (!finishedBatchIds.has(data.batch_id)) {
                    activeBatch = {
                        batchId: data.batch_id,
                        project: currentProject,
                        mode: "podcast",
                        questionIndexes: target.map(q => q.q_index),
                        total: target.length,
                        completed: 0
                    };
                } else {
                    setBatchControls(false);
                }
                appendConsoleLog(`🚀 Dávka podcastů pro ${target.length} otázek byla spuštěna (noční režim: ${isOvernight ? 'zapnut' : 'vypnut'}).`);
            } catch(e) {
                updateQuestionsByIndexes(target.map(q => q.q_index), "Ready");
                setBatchControls(false);
                alert("Dávku se nepodařilo spustit: " + e.message);
            }
        }

        // --- PRŮZKUMNÍK SOUBORŮ ---
        let explorerFilesCache = [];

        async function loadExplorer() {
            if (!currentProject) {
                document.getElementById("explorerGrid").innerHTML = "";
                return;
            }

            const res = await fetch(`/api/outputs?project=${currentProject}`);
            const data = await res.json();
            const grid = document.getElementById("explorerGrid");
            grid.innerHTML = "";
            
            explorerFilesCache = data.files || [];
            
            if (explorerFilesCache.length === 0) {
                grid.innerHTML = `<div class="col-span-full text-center text-slate-500 italic py-4">Pro tento projekt zatím nejsou žádné výstupní mediální soubory.</div>`;
            } else {
                explorerFilesCache.forEach(f => {
                    const isVideo = f.endsWith(".mp4");
                    const isAudio = f.endsWith(".mp3");
                    
                    let icon = isVideo ? "🎬" : isAudio ? "🎧" : "📄";
                    let typeColor = isVideo ? "text-purple-400" : isAudio ? "text-blue-400" : "text-amber-400";
                    
                    const card = document.createElement("div");
                    card.className = "bg-slate-900 border border-slate-700 p-3 rounded-lg flex flex-col gap-2 group hover:border-slate-500 transition shadow";
                    card.innerHTML = `
                        <div class="flex items-start gap-2">
                            <div class="text-2xl mt-1">${icon}</div>
                            <div class="flex-1 min-w-0">
                                <p class="text-xs text-slate-200 font-mono font-bold truncate" title="${f}">${f}</p>
                                <p class="text-[10px] ${typeColor} uppercase font-bold mt-1">${f.split('.').pop()}</p>
                            </div>
                        </div>
                        <div class="flex flex-wrap justify-between items-center mt-2 border-t border-slate-800 pt-2 gap-2">
                            ${isAudio ? `<button onclick="openPodcastPlayer('${f}')" class="text-[11px] bg-emerald-900/50 hover:bg-emerald-800 text-emerald-400 px-2 py-1 rounded transition font-bold text-center border border-emerald-700/50 whitespace-nowrap">▶ Přehrát s textem</button>` : `<a href="/audio/${f}" target="_blank" class="text-xs bg-emerald-900/50 hover:bg-emerald-800 text-emerald-400 px-2 py-1 rounded transition">Otevřít</a>`}
                            <button onclick="deleteExplorerFile('${f}')" class="text-xs text-red-500 hover:text-red-400 font-bold px-2 py-1 rounded transition opacity-50 group-hover:opacity-100">Smazat</button>
                        </div>
                    `;
                    grid.appendChild(card);
                });
            }

            syncStatusWithExplorer();
            updateDashboardStats();
        }

        async function deleteExplorerFile(filename) {
            if(confirm(`Opravdu smazat ${filename}?`)) {
                await fetch(`/api/outputs/${filename}`, { method: "DELETE" });
                loadExplorer();
            }
        }

        function syncStatusWithExplorer() {
            let changed = false;
            questions.forEach(q => {
                const expectedPrefix = `${currentProject}_Q${q.q_index}_`;
                const hasMedia = explorerFilesCache.some(f => f.startsWith(expectedPrefix) && (f.endsWith('.mp3') || f.endsWith('.mp4')));

                if (hasMedia && q.status !== "Done") {
                    q.status = "Done";
                    changed = true;
                } else if (!hasMedia && q.status === "Done") {
                    q.status = "Ready"; 
                    changed = true;
                }
            });

            if (changed) {
                saveQuestionsToStorage();
                renderQuestionsTable();
            }
        }

        // =========================================================================
        // NASTAVENÍ APLIKACE A VLASTNÍCH API KLÍČŮ (BYOK)
        // =========================================================================
        let appSettingsCache = null;

        async function loadAppSettings(showModalIfMissing = false) {
            try {
                const res = await fetch("/api/settings");
                if (!res.ok) return;
                const data = await res.json();
                appSettingsCache = data;

                // Indikace tlačítka nastavení v horní liště (zelená tečka odstraněna, tlačítko má čistý standardní vzhled)
                const dot = document.getElementById("globalSettingsDot");
                const btnSettings = document.getElementById("btnGlobalSettings");
                if (data.gemini_configured) {
                    // Klíč je nakonfigurován – žádnou zelenou tečku nezobrazujeme
                    if (dot) {
                        dot.className = "hidden";
                    }
                    if (btnSettings) {
                        btnSettings.classList.remove("border-amber-500/80", "text-amber-300");
                        btnSettings.title = "Nastavení aplikace a API klíčů (BYOK)";
                    }
                } else {
                    // Varování: Klíč chybí – decentní jantarové varování
                    if (dot) {
                        dot.className = "absolute top-1 right-1 w-2 h-2 rounded-full bg-amber-500 animate-pulse";
                        dot.title = "Pozor: Gemini API klíč není nastaven!";
                    }
                    if (btnSettings) {
                        btnSettings.classList.add("border-amber-500/80");
                        btnSettings.title = "Pozor: Gemini API klíč není nastaven! Otevřete nastavení.";
                    }
                }

                // Stavové odznaky pro jednotlivé poskytovatele přímo v okně nastavení
                const geminiBadge = document.getElementById("settingsGeminiConfigBadge");
                if (geminiBadge) {
                    if (data.gemini_configured) {
                        geminiBadge.className = "text-[10px] bg-emerald-950/80 text-emerald-400 font-bold px-2 py-0.5 rounded border border-emerald-700/60 inline-flex items-center gap-1";
                        geminiBadge.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span> ${t("common.active", "Aktivní")}`;
                    } else {
                        geminiBadge.className = "text-[10px] bg-amber-950/80 text-amber-300 font-bold px-2 py-0.5 rounded border border-amber-700/60 inline-flex items-center gap-1";
                        geminiBadge.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse"></span> ${t("settings.missingKey", "Chybí klíč")}`;
                    }
                }

                const openaiBadge = document.getElementById("settingsOpenaiConfigBadge");
                if (openaiBadge) {
                    if (data.openai_configured) {
                        openaiBadge.className = "text-[10px] bg-emerald-950/80 text-emerald-400 font-bold px-2 py-0.5 rounded border border-emerald-700/60 inline-flex items-center gap-1";
                        openaiBadge.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span> ${t("common.active", "Aktivní")}`;
                    } else {
                        openaiBadge.className = "text-[10px] bg-slate-900 text-slate-500 font-medium px-2 py-0.5 rounded border border-slate-800";
                        openaiBadge.textContent = t("settings.notConfigured", "Nenastaveno");
                    }
                }

                const elevenBadge = document.getElementById("settingsElevenlabsConfigBadge");
                if (elevenBadge) {
                    if (data.elevenlabs_configured) {
                        elevenBadge.className = "text-[10px] bg-emerald-950/80 text-emerald-400 font-bold px-2 py-0.5 rounded border border-emerald-700/60 inline-flex items-center gap-1";
                        elevenBadge.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span> ${t("common.active", "Aktivní")}`;
                    } else {
                        elevenBadge.className = "text-[10px] bg-slate-900 text-slate-500 font-medium px-2 py-0.5 rounded border border-slate-800";
                        elevenBadge.textContent = t("settings.notConfigured", "Nenastaveno");
                    }
                }

                // Cesta k lokálnímu adresáři
                const pathEl = document.getElementById("settingsUserDataPath");
                if (pathEl && data.user_data_dir) {
                    pathEl.value = data.user_data_dir;
                }

                // Placeholder / hodnoty pro vstupy
                const geminiInput = document.getElementById("inputSettingsGeminiKey");
                const openaiInput = document.getElementById("inputSettingsOpenaiKey");
                const elevenlabsInput = document.getElementById("inputSettingsElevenlabsKey");

                // Politika správy API klíčů (sdílené vs individuální per-user)
                const policyBanner = document.getElementById("settingsApiKeyPolicyBanner");
                const policyIcon = document.getElementById("settingsApiKeyPolicyIcon");
                const policyText = document.getElementById("settingsApiKeyPolicyText");
                const btnSave = document.getElementById("btnSaveSettings");

                const isShared = data.shared_api_keys !== false;
                const isAdmin = data.is_admin === true || (currentUser && currentUser.role === "admin");
                const isViewer = data.is_viewer === true || (currentUser && currentUser.role === "viewer");

                if (policyBanner && policyText) {
                    policyBanner.classList.remove("hidden");
                    if (isShared) {
                        if (isAdmin) {
                            policyBanner.className = "p-3 rounded-xl border border-sky-800/60 bg-sky-950/40 text-sky-200 text-xs flex items-center gap-2.5";
                            if (policyIcon) policyIcon.textContent = "👑";
                            policyText.innerHTML = `<strong>${t("settings.apiPolicySharedAdminTitle", "Centrální režim API klíčů (Administrátor):")}</strong> ${t("settings.apiPolicySharedAdminDesc", "Tyto klíče jsou centrálně sdíleny všemi uživateli aplikace.")}`;
                            if (geminiInput) geminiInput.disabled = false;
                            if (openaiInput) openaiInput.disabled = false;
                            if (elevenlabsInput) elevenlabsInput.disabled = false;
                            if (btnSave) btnSave.disabled = false;
                        } else {
                            policyBanner.className = "p-3 rounded-xl border border-emerald-800/60 bg-emerald-950/40 text-emerald-200 text-xs flex items-center gap-2.5";
                            if (policyIcon) policyIcon.textContent = "🛡️";
                            policyText.innerHTML = `<strong>${t("settings.apiPolicySharedUserTitle", "Centrální API klíče:")}</strong> ${t("settings.apiPolicySharedUserDesc", "Aplikace využívá centrální klíče nastavené administrátorem. Vlastní klíče není nutné zadávat.")}`;
                            if (geminiInput) { geminiInput.disabled = true; geminiInput.placeholder = t("settings.apiPlaceholderManaged", "Spravováno administrátorem (sdílené klíče)"); }
                            if (openaiInput) { openaiInput.disabled = true; openaiInput.placeholder = t("settings.apiPlaceholderManaged", "Spravováno administrátorem (sdílené klíče)"); }
                            if (elevenlabsInput) { elevenlabsInput.disabled = true; elevenlabsInput.placeholder = t("settings.apiPlaceholderManaged", "Spravováno administrátorem (sdílené klíče)"); }
                            if (btnSave) btnSave.disabled = false;
                        }
                    } else {
                        if (isViewer) {
                            policyBanner.className = "p-3 rounded-xl border border-purple-800/60 bg-purple-950/40 text-purple-200 text-xs flex items-center gap-2.5";
                            if (policyIcon) policyIcon.textContent = "👁️";
                            policyText.innerHTML = `<strong>${t("settings.apiPolicyViewerTitle", "Režim pozorovatele:")}</strong> ${t("settings.apiPolicyViewerDesc", "Účet pozorovatele je pouze ke čtení a nemůže nastavovat API klíče.")}`;
                            if (geminiInput) { geminiInput.disabled = true; geminiInput.placeholder = t("settings.apiPlaceholderViewer", "Pozorovatelé nemohou nastavovat klíče"); }
                            if (openaiInput) { openaiInput.disabled = true; openaiInput.placeholder = t("settings.apiPlaceholderViewer", "Pozorovatelé nemohou nastavovat klíče"); }
                            if (elevenlabsInput) { elevenlabsInput.disabled = true; elevenlabsInput.placeholder = t("settings.apiPlaceholderViewer", "Pozorovatelé nemohou nastavovat klíče"); }
                            if (btnSave) btnSave.disabled = true;
                        } else {
                            policyBanner.className = "p-3 rounded-xl border border-indigo-800/60 bg-indigo-950/40 text-indigo-200 text-xs flex items-center gap-2.5";
                            if (policyIcon) policyIcon.textContent = "👤";
                            policyText.innerHTML = `<strong>${t("settings.apiPolicyByokTitle", "Osobní API klíče (BYOK):")}</strong> ${t("settings.apiPolicyByokDesc", "Zde zadané klíče budou bezpečně uloženy pro váš osobní účet.")}`;
                            if (geminiInput) geminiInput.disabled = false;
                            if (openaiInput) openaiInput.disabled = false;
                            if (elevenlabsInput) elevenlabsInput.disabled = false;
                            if (btnSave) btnSave.disabled = false;
                        }
                    }
                }

                if (geminiInput && !geminiInput.disabled) {
                    geminiInput.placeholder = data.gemini_configured ? t("settings.apiPlaceholderActive", "Aktivní ({masked}) - ponechte prázdné pro zachování", { masked: data.gemini_masked }) : t("settings.apiPlaceholderGemini", "Vložte AIzaSy...");
                }
                if (openaiInput && !openaiInput.disabled) {
                    openaiInput.placeholder = data.openai_configured ? t("settings.apiPlaceholderActive", "Aktivní ({masked}) - ponechte prázdné pro zachování", { masked: data.openai_masked }) : t("settings.apiPlaceholderOpenai", "Vložte sk-...");
                }
                if (elevenlabsInput && !elevenlabsInput.disabled) {
                    elevenlabsInput.placeholder = data.elevenlabs_configured ? t("settings.apiPlaceholderActive", "Aktivní ({masked}) - ponechte prázdné pro zachování", { masked: data.elevenlabs_masked }) : t("settings.apiPlaceholderEleven", "Vložte klíč...");
                }

                // Alert v modalu
                const alertEl = document.getElementById("settingsGeminiMissingAlert");
                if (alertEl) {
                    if (!data.gemini_configured) {
                        alertEl.classList.remove("hidden");
                    } else {
                        alertEl.classList.add("hidden");
                    }
                }

                // Pomodoro nastavení v modalu
                if (typeof syncPomodoroSettingsToModal === "function") {
                    syncPomodoroSettingsToModal(data.pomodoro_settings);
                }

                // Pokud je klíč nepřítomen při startu, automaticky otevřeme dialog
                if (showModalIfMissing && !data.gemini_configured) {
                    openSettingsModal();
                }
            } catch (err) {
                console.warn("Nelze načíst nastavení:", err);
            }
        }

        // =========================================================================
        // JAZYKOVÉ ROZHRANÍ & PŘEPÍNAČ JAZYKŮ (CS, EN, FR)
        // =========================================================================
        // Hlavní implementace je v static/js/translations.js (window.toggleLangDropdown, window.setAppLanguage, window.updateLangUI)
        function getCurrentLanguage() {
            return (window.currentLanguage && ["cs", "en", "fr"].includes(window.currentLanguage))
                ? window.currentLanguage
                : (localStorage.getItem("medstudio_lang") || "cs");
        }
        let currentLanguage = getCurrentLanguage();
        window.addEventListener("medstudio_lang_change", (e) => {
            currentLanguage = (e.detail && e.detail.lang) || getCurrentLanguage();
            try {
                if (typeof updateDashboardStats === "function") updateDashboardStats();
                if (typeof renderPomodoroUI === "function") renderPomodoroUI();
                if (typeof renderExamPlannerCalendar === "function") renderExamPlannerCalendar();
                if (typeof renderPlannerTable === "function") renderPlannerTable();
                if (typeof renderPlannerCalendarStrip === "function") renderPlannerCalendarStrip();
                if (typeof renderQuestionsManagerTable === "function") renderQuestionsManagerTable();
                if (typeof renderMedulingoDashboard === "function") renderMedulingoDashboard();
                if (appSettingsCache && typeof loadAppSettings === "function") {
                    const modalSettings = document.getElementById("modalSettings");
                    if (modalSettings && !modalSettings.classList.contains("hidden")) {
                        loadAppSettings(false);
                    }
                }
            } catch(err) {
                console.warn("Language refresh non-fatal error:", err);
            }
        });

        // =========================================================================
        // AUTENTIZACE, SPRÁVA UŽIVATELŮ A SCHVALOVÁNÍ PŘÍSTUPŮ
        // =========================================================================
        // (currentUser a isViewerMode jsou definovány v globálním stavu nahoře)

        // Interceptor pro automatické zachycení expirace relace (401), omezení pozorovatele (403) a předávání jazyka aplikace
        const originalFetch = window.fetch;
        window.fetch = async function(...args) {
            try {
                if (args.length > 0) {
                    args[1] = args[1] || {};
                    const activeLang = typeof currentLanguage !== "undefined" ? currentLanguage : (localStorage.getItem("medstudio_lang") || "cs");
                    if (!args[1].headers) {
                        args[1].headers = { "X-App-Language": activeLang };
                    } else if (args[1].headers instanceof Headers) {
                        if (!args[1].headers.has("X-App-Language")) {
                            args[1].headers.set("X-App-Language", activeLang);
                        }
                    } else if (Array.isArray(args[1].headers)) {
                        args[1].headers.push(["X-App-Language", activeLang]);
                    } else {
                        args[1].headers["X-App-Language"] = activeLang;
                    }
                }
            } catch (e) {
                console.warn("Chyba při vkládání X-App-Language do fetch:", e);
            }

            const response = await originalFetch.apply(this, args);
            if (response.status === 401) {
                const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url ? args[0].url : "");
                if (!url.includes("/api/auth/login") && !url.includes("/api/auth/status") && !url.includes("/api/auth/setup") && !url.includes("/api/auth/register")) {
                    initAuth();
                }
            } else if (response.status === 403) {
                try {
                    const clone = response.clone();
                    const data = await clone.json();
                    if (data && data.detail && data.detail.includes("Režim pozorovatele")) {
                        showGlobalToast("👁️ " + data.detail, "warning");
                    }
                } catch (e) {}
            }
            return response;
        };

        async function initAuth() {
            try {
                const res = await fetch("/api/auth/status");
                const data = await res.json();
                authRegistrationAllowed = !!data.allow_registration;
                authGuestAllowed = !!data.allow_guest;

                if (data.needs_setup) {
                    showAuthModal('setup');
                    return;
                }

                if (data.authenticated) {
                    // Řádně přihlášený uživatel (admin / user / viewer s účtem)
                    currentUser = data.user;
                    hideAuthModal();
                    updateUserInterfaceHeader();
                    if (currentUser && currentUser.role === "admin") {
                        checkPendingRequestsNotification();
                    }
                    loadProjects();
                    loadAppSettings(true);
                    setupSSE();
                    return;
                }

                if (data.is_guest || data.allow_guest) {
                    // Je povolen režim hosta (pozorovatel bez nutnosti přihlášení)
                    currentUser = data.user || {
                        id: -1,
                        username: "host",
                        email: null,
                        role: "viewer",
                        status: "approved",
                        is_guest: true
                    };
                    hideAuthModal();
                    updateUserInterfaceHeader();
                    loadProjects();
                    loadAppSettings(true);
                    setupSSE();
                    return;
                }

                // Není přihlášen a režim hosta je vypnut – vyžaduje přihlášení
                currentUser = null;
                updateUserInterfaceHeader();
                showAuthModal('login', authRegistrationAllowed, authGuestAllowed);
            } catch (err) {
                console.warn("Chyba při ověřování přihlášení:", err);
            }
        }

        function updateUserInterfaceHeader() {
            const badge = document.getElementById("headerUserBadge");
            const iconEl = document.getElementById("headerUserIcon");
            const nameEl = document.getElementById("headerUserName");
            const roleEl = document.getElementById("headerUserRoleBadge");
            const logoutBtn = document.getElementById("headerUserLogoutBtn");
            const loginBtn = document.getElementById("headerUserLoginBtn");

            const sidebarUserFooter = document.getElementById("sidebarUserFooter");
            const sidebarIconEl = document.getElementById("sidebarUserIcon");
            const sidebarNameEl = document.getElementById("sidebarUserName");
            const sidebarRoleEl = document.getElementById("sidebarUserRoleBadge");
            const sidebarLogoutBtn = document.getElementById("sidebarUserLogoutBtn");
            const sidebarLoginBtn = document.getElementById("sidebarUserLoginBtn");

            const sidebarAdminBtn = document.getElementById("sidebarBtnAdminUsers");
            const sidebarUserBtn = document.getElementById("sidebarBtnUserProfile");
            const viewerBanner = document.getElementById("viewerBanner");

            if (!currentUser) {
                if (badge) badge.classList.add("hidden");
                if (sidebarUserFooter) sidebarUserFooter.classList.add("hidden");
                if (sidebarAdminBtn) sidebarAdminBtn.classList.add("hidden");
                if (sidebarUserBtn) sidebarUserBtn.classList.add("hidden");
                if (viewerBanner) viewerBanner.classList.add("hidden");
                return;
            }

            const isGuest = !!currentUser.is_guest;
            const isViewer = currentUser.role === "viewer";
            const isAdmin = currentUser.role === "admin";

            // Zobrazení horního banneru pro pozorovatele (hosta i přihlášeného pozorovatele)
            if (viewerBanner) {
                if (isViewer) {
                    viewerBanner.classList.remove("hidden");
                } else {
                    viewerBanner.classList.add("hidden");
                }
            }

            // Texty jména a ikony
            if (nameEl) nameEl.textContent = isGuest ? "Host" : currentUser.username;
            if (sidebarNameEl) sidebarNameEl.textContent = isGuest ? "Host" : currentUser.username;

            if (iconEl) iconEl.textContent = isAdmin ? "👑" : (isViewer ? "👁️" : "👤");
            if (sidebarIconEl) sidebarIconEl.textContent = isAdmin ? "👑" : (isViewer ? "👁️" : "👤");

            if (roleEl) {
                if (isAdmin) {
                    roleEl.textContent = "Admin";
                    roleEl.className = "text-[10px] bg-emerald-950 text-emerald-400 font-bold px-1.5 py-0.5 rounded border border-emerald-800";
                } else if (isViewer) {
                    roleEl.textContent = "Pozorovatel";
                    roleEl.className = "text-[10px] bg-purple-950 text-purple-300 font-bold px-1.5 py-0.5 rounded border border-purple-800";
                } else {
                    roleEl.textContent = "Student";
                    roleEl.className = "text-[10px] bg-blue-950 text-blue-300 font-bold px-1.5 py-0.5 rounded border border-blue-800";
                }
            }

            if (sidebarRoleEl) {
                if (isAdmin) {
                    sidebarRoleEl.textContent = "Admin";
                    sidebarRoleEl.className = "text-[9px] bg-emerald-950 text-emerald-400 font-bold px-1.5 py-0.2 rounded border border-emerald-800";
                } else if (isViewer) {
                    sidebarRoleEl.textContent = "Pozorovatel";
                    sidebarRoleEl.className = "text-[9px] bg-purple-950 text-purple-300 font-bold px-1.5 py-0.2 rounded border border-purple-800";
                } else {
                    sidebarRoleEl.textContent = "Student";
                    sidebarRoleEl.className = "text-[9px] bg-blue-950 text-blue-300 font-bold px-1.5 py-0.2 rounded border border-blue-800";
                }
            }

            // Tlačítka odhlášení vs. přihlášení (pro hosta nabízíme přihlášení)
            if (isGuest) {
                if (logoutBtn) logoutBtn.classList.add("hidden");
                if (loginBtn) loginBtn.classList.remove("hidden");
                if (sidebarLogoutBtn) sidebarLogoutBtn.classList.add("hidden");
                if (sidebarLoginBtn) sidebarLoginBtn.classList.remove("hidden");
            } else {
                if (logoutBtn) logoutBtn.classList.remove("hidden");
                if (loginBtn) loginBtn.classList.add("hidden");
                if (sidebarLogoutBtn) sidebarLogoutBtn.classList.remove("hidden");
                if (sidebarLoginBtn) sidebarLoginBtn.classList.add("hidden");
            }

            if (badge) badge.classList.remove("hidden");
            if (sidebarUserFooter) sidebarUserFooter.classList.remove("hidden");

            if (sidebarAdminBtn) {
                if (isAdmin) {
                    sidebarAdminBtn.classList.remove("hidden");
                } else {
                    sidebarAdminBtn.classList.add("hidden");
                }
            }

            if (sidebarUserBtn) {
                if (!isAdmin) {
                    sidebarUserBtn.classList.remove("hidden");
                } else {
                    sidebarUserBtn.classList.add("hidden");
                }
            }

            // Dynamická aktualizace stavu interaktivních prvků podle role (zamknutí pro pozorovatele)
            if (typeof renderPlannerTable === "function" && questions && questions.length > 0) {
                renderPlannerTable();
            }
            if (typeof renderPlannerCalendarStrip === "function") {
                renderPlannerCalendarStrip();
            }
            if (typeof renderExamPlanner === "function") {
                renderExamPlanner();
            }
            if (typeof renderQuestionsManagerTable === "function") {
                renderQuestionsManagerTable();
            }
            if (typeof renderQuestionsTable === "function") {
                renderQuestionsTable();
            }
        }

        function showAuthModal(view = 'login', allowReg = authRegistrationAllowed, allowGuest = authGuestAllowed) {
            const modal = document.getElementById("modalAuth");
            if (modal) modal.classList.remove("hidden");
            showAuthView(view, allowReg, allowGuest);
        }

        function hideAuthModal() {
            const modal = document.getElementById("modalAuth");
            if (modal) modal.classList.add("hidden");
        }

        function showAuthView(view, allowReg = authRegistrationAllowed, allowGuest = authGuestAllowed) {
            const vSetup = document.getElementById("authViewSetup");
            const vLogin = document.getElementById("authViewLogin");
            const vReg = document.getElementById("authViewRegister");
            const regBox = document.getElementById("loginRegBox");
            const regDisabledBox = document.getElementById("loginRegDisabledBox");
            const guestBox = document.getElementById("loginGuestBox");

            [vSetup, vLogin, vReg].forEach(el => el && el.classList.add("hidden"));

            if (regBox && regDisabledBox) {
                if (allowReg) {
                    regBox.classList.remove("hidden");
                    regDisabledBox.classList.add("hidden");
                } else {
                    regBox.classList.add("hidden");
                    regDisabledBox.classList.remove("hidden");
                }
            }

            if (guestBox) {
                if (allowGuest) {
                    guestBox.classList.remove("hidden");
                } else {
                    guestBox.classList.add("hidden");
                }
            }

            if (view === 'setup' && vSetup) {
                vSetup.classList.remove("hidden");
            } else if (view === 'register' && vReg) {
                vReg.classList.remove("hidden");
            } else if (vLogin) {
                vLogin.classList.remove("hidden");
            }
        }

        function continueAsGuest() {
            currentUser = {
                id: -1,
                username: "host",
                email: null,
                role: "viewer",
                status: "approved",
                is_guest: true
            };
            hideAuthModal();
            updateUserInterfaceHeader();
            showGlobalToast(t("toast.guestNotice", "👀 Vstoupili jste v režimu Pozorovatele (Host). Máte k dispozici čtení a poslech materiálů."), "info");
            loadProjects();
            loadAppSettings(true);
            setupSSE();
        }

        async function submitAuthSetup() {
            const username = document.getElementById("setupUsername")?.value.trim() || "";
            const email = document.getElementById("setupEmail")?.value.trim() || "";
            const password = document.getElementById("setupPassword")?.value || "";
            const confirm = document.getElementById("setupPasswordConfirm")?.value || "";
            const errEl = document.getElementById("setupError");
            const btn = document.getElementById("btnSubmitSetup");

            if (errEl) {
                errEl.classList.add("hidden");
                errEl.textContent = "";
            }

            if (password !== confirm) {
                if (errEl) {
                    errEl.textContent = t("settings.passwordsMismatch", "Hesla se neshodují.");
                    errEl.classList.remove("hidden");
                }
                return;
            }

            if (btn) {
                btn.disabled = true;
                btn.textContent = t("settings.creatingAccount", "Vytvářím účet...");
            }

            try {
                const res = await fetch("/api/auth/setup", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ username, email, password })
                });
                const data = await res.json();
                if (!res.ok) {
                    throw new Error(data.detail || "Chyba při zakládání administrátora.");
                }

                currentUser = data.user;
                hideAuthModal();
                updateUserInterfaceHeader();
                showGlobalToast(t("toast.adminCreated", "🎉 Administrátorský účet byl úspěšně vytvořen! Vítejte v AI MedStudio."), "success");
                loadProjects();
                loadAppSettings(true);
                setupSSE();
            } catch (err) {
                if (errEl) {
                    errEl.textContent = err.message;
                    errEl.classList.remove("hidden");
                }
            } finally {
                if (btn) {
                    btn.disabled = false;
                    btn.textContent = "🚀 Vytvořit administrátorský účet a vstoupit";
                }
            }
        }

        async function submitAuthLogin() {
            const username = document.getElementById("loginUsername")?.value.trim() || "";
            const password = document.getElementById("loginPassword")?.value || "";
            const rememberMe = document.getElementById("loginRememberMe")?.checked ?? true;
            const errEl = document.getElementById("loginError");
            const btn = document.getElementById("btnSubmitLogin");

            if (errEl) {
                errEl.classList.add("hidden");
                errEl.textContent = "";
            }

            if (btn) {
                btn.disabled = true;
                btn.textContent = t("settings.loggingIn", "Přihlašuji...");
            }

            try {
                const res = await fetch("/api/auth/login", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ username, password, remember_me: rememberMe })
                });
                const data = await res.json();
                if (!res.ok) {
                    throw new Error(data.detail || "Neplatné přihlašovací údaje.");
                }

                currentUser = data.user;
                hideAuthModal();
                updateUserInterfaceHeader();
                showGlobalToast(`Vítejte zpět, ${currentUser.username}!`, "success");

                if (currentUser.role === "admin") {
                    checkPendingRequestsNotification();
                }

                loadProjects();
                loadAppSettings(true);
                setupSSE();
            } catch (err) {
                if (errEl) {
                    errEl.textContent = err.message;
                    errEl.classList.remove("hidden");
                }
            } finally {
                if (btn) {
                    btn.disabled = false;
                    btn.textContent = "➔ Přihlásit se";
                }
            }
        }

        async function submitAuthRegister() {
            const username = document.getElementById("regUsername")?.value.trim() || "";
            const email = document.getElementById("regEmail")?.value.trim() || "";
            const password = document.getElementById("regPassword")?.value || "";
            const confirm = document.getElementById("regPasswordConfirm")?.value || "";
            const errEl = document.getElementById("regError");
            const btn = document.getElementById("btnSubmitRegister");

            if (errEl) {
                errEl.className = "hidden p-2.5 rounded-lg text-xs";
                errEl.textContent = "";
            }

            if (password !== confirm) {
                if (errEl) {
                    errEl.className = "p-2.5 rounded-lg bg-red-950/70 border border-red-800 text-red-300 text-xs";
                    errEl.textContent = t("settings.passwordsMismatch", "Hesla se neshodují.");
                }
                return;
            }

            if (btn) {
                btn.disabled = true;
                btn.textContent = t("settings.sendingRequest", "Odesílám žádost...");
            }

            try {
                const res = await fetch("/api/auth/register", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ username, email, password })
                });
                const data = await res.json();
                if (!res.ok) {
                    throw new Error(data.detail || "Chyba při odesílání žádosti o registraci.");
                }

                if (errEl) {
                    errEl.className = "p-3 rounded-lg bg-emerald-950/70 border border-emerald-700 text-emerald-300 text-xs leading-relaxed";
                    errEl.innerHTML = "<strong>✅ Žádost byla úspěšně odeslána!</strong><br>Administrátor serveru váš účet zkontroluje a schválí. Poté se budete moci přihlásit.";
                }
                document.getElementById("formAuthRegister")?.reset();
            } catch (err) {
                if (errEl) {
                    errEl.className = "p-2.5 rounded-lg bg-red-950/70 border border-red-800 text-red-300 text-xs";
                    errEl.textContent = err.message;
                }
            } finally {
                if (btn) {
                    btn.disabled = false;
                    btn.textContent = "📨 Odeslat žádost administrátorovi";
                }
            }
        }

        async function submitAuthLogout() {
            try {
                await fetch("/api/auth/logout", { method: "POST" });
            } catch (err) {
                console.warn("Chyba při odhlašování:", err);
            }
            currentUser = null;
            const badge = document.getElementById("headerUserBadge");
            if (badge) badge.classList.add("hidden");
            const sidebarFooter = document.getElementById("sidebarUserFooter");
            if (sidebarFooter) sidebarFooter.classList.add("hidden");
            const sidebarAdminBtn = document.getElementById("sidebarBtnAdminUsers");
            if (sidebarAdminBtn) sidebarAdminBtn.classList.add("hidden");
            const sidebarUserBtn = document.getElementById("sidebarBtnUserProfile");
            if (sidebarUserBtn) sidebarUserBtn.classList.add("hidden");
            const sidebarBadge = document.getElementById("sidebarAdminPendingBadge");
            if (sidebarBadge) sidebarBadge.classList.add("hidden");
            closeSettingsModal();
            showAuthModal('login');
        }

        function switchSettingsTab(tab = 'general') {
            const btnGen = document.getElementById("tabBtnSettingsGeneral");
            const btnUsers = document.getElementById("tabBtnSettingsUsers");
            const contentGen = document.getElementById("settingsGeneralTabContent");
            const contentUsers = document.getElementById("settingsUsersTabContent");
            const btnSave = document.getElementById("btnSaveSettings");
            const statusEl = document.getElementById("settingsSaveStatus");

            if (tab === 'users') {
                if (btnGen) {
                    btnGen.className = "px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-400 hover:text-white hover:bg-slate-800 border border-transparent transition";
                }
                if (btnUsers) {
                    btnUsers.className = "px-3 py-1.5 rounded-lg text-xs font-bold bg-slate-800 text-white border border-slate-700 transition flex items-center gap-1.5";
                }
                if (contentGen) contentGen.classList.add("hidden");
                if (contentUsers) contentUsers.classList.remove("hidden");
                if (btnSave) btnSave.classList.add("hidden");
                if (statusEl) statusEl.textContent = "";
                const modal = document.getElementById("modalSettings");
                if (typeof applyTranslations === "function" && modal) {
                    applyTranslations(currentLanguage, modal);
                }
                loadAdminUserManagement();
            } else {
                if (btnGen) {
                    btnGen.className = "px-3 py-1.5 rounded-lg text-xs font-bold bg-slate-800 text-white border border-slate-700 transition";
                }
                if (btnUsers) {
                    btnUsers.className = "px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-400 hover:text-white hover:bg-slate-800 border border-transparent transition flex items-center gap-1.5";
                }
                if (contentGen) contentGen.classList.remove("hidden");
                if (contentUsers) contentUsers.classList.add("hidden");
                if (btnSave) btnSave.classList.remove("hidden");
            }
        }

        async function checkPendingRequestsNotification() {
            try {
                const res = await fetch("/api/auth/admin/pending");
                if (!res.ok) return;
                const data = await res.json();
                const count = (data.pending || []).length;
                
                const dot = document.getElementById("settingsPendingBadge");
                const tabBadge = document.getElementById("settingsTabPendingBadge");
                const sidebarBadge = document.getElementById("sidebarAdminPendingBadge");

                if (dot) {
                    if (count > 0) {
                        dot.textContent = count > 9 ? "9+" : count;
                        dot.classList.remove("hidden");
                    } else {
                        dot.classList.add("hidden");
                    }
                }
                if (tabBadge) {
                    if (count > 0) {
                        tabBadge.textContent = count;
                        tabBadge.classList.remove("hidden");
                    } else {
                        tabBadge.classList.add("hidden");
                    }
                }
                if (sidebarBadge) {
                    if (count > 0) {
                        sidebarBadge.textContent = count > 9 ? "9+" : count;
                        sidebarBadge.classList.remove("hidden");
                    } else {
                        sidebarBadge.classList.add("hidden");
                    }
                }
            } catch (err) {
                console.warn("Chyba při zjišťování čekajících žádostí:", err);
            }
        }

        async function loadAdminUserManagement() {
            if (!currentUser) return;

            const pIcon = document.getElementById("settingsProfileIcon");
            const pName = document.getElementById("settingsProfileUsername");
            const pRole = document.getElementById("settingsProfileRole");
            const pEmail = document.getElementById("settingsProfileEmail");
            const pLoginBtn = document.getElementById("settingsProfileLoginBtn");
            const pLogoutBtn = document.getElementById("settingsProfileLogoutBtn");
            const adminArea = document.getElementById("adminControlsArea");
            const nonAdminNotice = document.getElementById("userNonAdminNotice");

            const isGuest = !!currentUser.is_guest;
            const isViewer = currentUser.role === "viewer";
            const isAdmin = currentUser.role === "admin";

            if (pIcon) pIcon.textContent = isAdmin ? "👑" : (isViewer ? "👁️" : "👤");
            if (pName) pName.textContent = isGuest ? t("settings.unregisteredGuest", "Host") : currentUser.username;
            if (pEmail) pEmail.textContent = isGuest ? t("settings.unregisteredGuest", "Nepřihlášený návštěvník") : (currentUser.email || t("settings.noEmail", "bez e-mailu"));

            if (pRole) {
                if (isAdmin) {
                    pRole.textContent = t("settings.roleAdmin", "Admin");
                    pRole.className = "text-[10px] bg-emerald-950 text-emerald-400 font-bold px-1.5 py-0.5 rounded border border-emerald-800";
                } else if (isViewer) {
                    pRole.textContent = t("settings.roleViewer", "Pozorovatel");
                    pRole.className = "text-[10px] bg-purple-950 text-purple-300 font-bold px-1.5 py-0.5 rounded border border-purple-800";
                } else {
                    pRole.textContent = t("settings.roleStudent", "Student");
                    pRole.className = "text-[10px] bg-blue-950 text-blue-300 font-bold px-1.5 py-0.5 rounded border border-blue-800";
                }
            }

            if (isGuest) {
                if (pLoginBtn) pLoginBtn.classList.remove("hidden");
                if (pLogoutBtn) pLogoutBtn.classList.add("hidden");
            } else {
                if (pLoginBtn) pLoginBtn.classList.add("hidden");
                if (pLogoutBtn) pLogoutBtn.classList.remove("hidden");
            }

            if (!isAdmin) {
                if (adminArea) adminArea.classList.add("hidden");
                if (nonAdminNotice) nonAdminNotice.classList.remove("hidden");
                return;
            }

            if (adminArea) adminArea.classList.remove("hidden");
            if (nonAdminNotice) nonAdminNotice.classList.add("hidden");

            // 1. Načíst čekající žádosti a uživatele paralelně pro maximální rychlost
            const pendingContainer = document.getElementById("pendingRequestsContainer");
            const pendingCountBadge = document.getElementById("pendingRequestsCountBadge");
            const usersContainer = document.getElementById("allUsersContainer");
            const regToggle = document.getElementById("settingsAllowRegistrationToggle");
            const guestToggle = document.getElementById("settingsAllowGuestToggle");
            const sharedApiKeysToggle = document.getElementById("settingsSharedApiKeysToggle");
            const sharedProjectsToggle = document.getElementById("settingsSharedProjectsToggle");

            try {
                const [resP, resU] = await Promise.all([
                    fetch("/api/auth/admin/pending"),
                    fetch("/api/auth/admin/users")
                ]);

                if (resP.ok) {
                    const dataP = await resP.json();
                    const pendingList = dataP.pending || [];
                    
                    if (pendingCountBadge) pendingCountBadge.textContent = pendingList.length;
                    checkPendingRequestsNotification();

                    if (pendingContainer) {
                        const dateLocale = currentLanguage === 'en' ? 'en-US' : (currentLanguage === 'fr' ? 'fr-FR' : 'cs-CZ');
                        if (pendingList.length === 0) {
                            pendingContainer.innerHTML = `
                                <div class="text-xs text-slate-500 py-3 text-center bg-slate-950/40 rounded-xl border border-slate-800/60 flex items-center justify-center gap-1.5">
                                    <span>✅</span> ${t("settings.noPendingRequests", "Žádné čekající žádosti o schválení.")}
                                </div>
                            `;
                        } else {
                            pendingContainer.innerHTML = pendingList.map(u => `
                                <div class="p-3 rounded-xl bg-slate-950/90 border border-amber-900/40 flex items-center justify-between flex-wrap gap-2 text-xs">
                                    <div>
                                        <div class="flex items-center gap-2">
                                            <span class="font-bold text-white">${escapeHtml(u.username)}</span>
                                            <span class="text-[10px] bg-amber-950 text-amber-300 font-bold px-1.5 py-0.2 rounded border border-amber-800">${t("settings.pendingApprovalBadge", "Čeká na schválení")}</span>
                                        </div>
                                        <p class="text-slate-400 text-[11px] mt-0.5">
                                            ${u.email ? escapeHtml(u.email) + ' • ' : ''}${t("settings.registeredDate", "Registrováno: {date}", { date: new Date(u.created_at).toLocaleString(dateLocale) })}
                                        </p>
                                    </div>
                                    <div class="flex items-center gap-2 flex-wrap">
                                        <button type="button" onclick="adminApproveUser(${u.id}, 'user')" class="px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs transition flex items-center gap-1 shadow-sm" title="${t("settings.approveStudentTitle", "Schválit jako běžného studenta (plná tvorba)")}">
                                            <span>🎓</span> ${t("settings.approveStudent", "Student")}
                                        </button>
                                        <button type="button" onclick="adminApproveUser(${u.id}, 'viewer')" class="px-2.5 py-1 rounded-lg bg-purple-900 hover:bg-purple-800 text-purple-200 border border-purple-700/80 font-bold text-xs transition flex items-center gap-1 shadow-sm" title="${t("settings.approveViewerTitle", "Schválit jako pozorovatele (pouze čtení a poslech)")}">
                                            <span>👁️</span> ${t("settings.approveViewer", "Pozorovatel")}
                                        </button>
                                        <button type="button" onclick="adminRejectUser(${u.id})" class="px-2.5 py-1 rounded-lg bg-red-950 hover:bg-red-900 text-red-200 border border-red-800/80 font-bold text-xs transition flex items-center gap-1">
                                            <span>❌</span> ${t("settings.rejectUser", "Zamítnout")}
                                        </button>
                                    </div>
                                </div>
                            `).join("");
                        }
                    }
                }

                if (resU.ok) {
                    const dataU = await resU.json();
                    const usersList = dataU.users || [];
                    const summary = dataU.summary || {};

                    if (regToggle) {
                        regToggle.checked = !!summary.allow_registration;
                    }
                    if (guestToggle) {
                        guestToggle.checked = !!summary.allow_guest;
                    }
                    if (sharedApiKeysToggle) {
                        sharedApiKeysToggle.checked = summary.shared_api_keys !== false;
                    }
                    if (sharedProjectsToggle) {
                        sharedProjectsToggle.checked = summary.shared_projects !== false;
                    }

                    if (usersContainer) {
                        const dateLocale = currentLanguage === 'en' ? 'en-US' : (currentLanguage === 'fr' ? 'fr-FR' : 'cs-CZ');
                        if (usersList.length === 0) {
                            usersContainer.innerHTML = `<div class="text-xs text-slate-500 py-2">${t("settings.noUsersFound", "Žádní uživatelé.")}</div>`;
                        } else {
                            usersContainer.innerHTML = usersList.map(u => {
                                const isMe = u.id === currentUser.id;
                                const isApproved = u.status === "approved";
                                const isDisabled = u.status === "disabled";
                                const isPending = u.status === "pending";

                                let statusBadge = "";
                                if (isApproved) {
                                    statusBadge = `<span class="text-[10px] bg-emerald-950 text-emerald-400 font-bold px-1.5 py-0.2 rounded border border-emerald-800 transition-all">${t("settings.statusActive", "Aktivní")}</span>`;
                                } else if (isDisabled) {
                                    statusBadge = `<span class="text-[10px] bg-red-950 text-red-400 font-bold px-1.5 py-0.2 rounded border border-red-800 transition-all">${t("settings.statusBlocked", "Zablokován")}</span>`;
                                } else if (isPending) {
                                    statusBadge = `<span class="text-[10px] bg-amber-950 text-amber-300 font-bold px-1.5 py-0.2 rounded border border-amber-800 transition-all">${t("settings.statusPending", "Čeká")}</span>`;
                                } else {
                                    statusBadge = `<span class="text-[10px] bg-slate-800 text-slate-400 px-1.5 py-0.2 rounded transition-all">${escapeHtml(u.status)}</span>`;
                                }

                                let roleIcon = '👤';
                                let roleBadgeClass = 'bg-blue-950 text-blue-300 border-blue-800';
                                let roleName = t("settings.roleStudent", "Student");
                                if (u.role === 'admin') {
                                    roleIcon = '👑';
                                    roleBadgeClass = 'bg-emerald-950 text-emerald-400 border-emerald-800';
                                    roleName = t("settings.roleAdmin", "Admin");
                                } else if (u.role === 'viewer') {
                                    roleIcon = '👁️';
                                    roleBadgeClass = 'bg-purple-950 text-purple-300 border-purple-800';
                                    roleName = t("settings.roleViewer", "Pozorovatel");
                                }

                                return `
                                    <div id="adminUserRow_${u.id}" class="p-3 rounded-xl bg-slate-950/60 border border-slate-800/80 flex items-center justify-between flex-wrap gap-2 text-xs">
                                        <div class="flex items-center gap-2.5">
                                            <div class="w-7 h-7 rounded-lg bg-slate-800 border border-slate-700 flex items-center justify-center text-xs">
                                                ${roleIcon}
                                            </div>
                                            <div>
                                                <div class="flex items-center gap-2 flex-wrap">
                                                    <span class="font-bold text-white">${escapeHtml(u.username)}</span>
                                                    ${isMe ? `<span class="text-[10px] text-emerald-400 font-bold">${t("settings.youBadge", "(Vy)")}</span>` : ''}
                                                    <span class="text-[10px] ${roleBadgeClass} font-bold px-1.5 py-0.2 rounded border">${roleName}</span>
                                                    <span id="adminUserStatusBadge_${u.id}">${statusBadge}</span>
                                                </div>
                                                <p class="text-slate-400 text-[11px] mt-0.5">
                                                    ${u.email ? escapeHtml(u.email) + ' • ' : ''}${t("settings.lastLoginLabel", "Poslední přihlášení: {time}", { time: u.last_login ? new Date(u.last_login).toLocaleString(dateLocale) : t("settings.never", "nikdy") })}
                                                </p>
                                            </div>
                                        </div>
                                        <div class="flex items-center gap-2 flex-wrap">
                                            ${!isMe ? `
                                                <select onchange="adminChangeRole(${u.id}, this.value)" class="bg-slate-900 border border-slate-700 text-[11px] text-slate-200 rounded-lg px-2 py-1 focus:border-emerald-500 focus:outline-none" title="${t("settings.changeRoleTitle", "Změnit uživatelskou roli")}">
                                                    <option value="user" ${u.role === 'user' ? 'selected' : ''}>🎓 ${t("settings.roleStudent", "Student")}</option>
                                                    <option value="viewer" ${u.role === 'viewer' ? 'selected' : ''}>👁️ ${t("settings.roleViewer", "Pozorovatel")}</option>
                                                    <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>👑 ${t("settings.roleAdmin", "Admin")}</option>
                                                </select>
                                                <button type="button" 
                                                    id="adminToggleBtn_${u.id}" 
                                                    data-status="${isDisabled ? 'disabled' : (isApproved ? 'approved' : u.status)}" 
                                                    onclick="adminToggleUserStatus(${u.id}, this)" 
                                                    class="px-2 py-1 rounded-lg ${isDisabled ? 'bg-emerald-950 text-emerald-300 border border-emerald-800' : 'bg-slate-800 text-slate-300 hover:text-white'} text-xs font-semibold transition active:scale-95 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1" 
                                                    title="${isDisabled ? t("settings.unblockAccount", "Odblokovat účet") : t("settings.blockAccount", "Zablokovat účet")}">
                                                    ${isDisabled ? t("settings.btnUnblock", "🔓 Odblokovat") : t("settings.btnBlock", "🔒 Zablokovat")}
                                                </button>
                                                <button type="button" onclick="adminDeleteUser(${u.id}, '${escapeHtml(u.username)}')" class="px-2 py-1 rounded-lg bg-red-950/60 hover:bg-red-900 border border-red-800/80 text-red-300 text-xs transition active:scale-95 cursor-pointer" title="${t("settings.deleteUserTitle", "Smazat uživatele")}">
                                                    🗑️
                                                </button>
                                            ` : `
                                                <span class="text-[11px] text-slate-500 italic pr-2">${t("settings.activeSession", "Aktivní relace")}</span>
                                            `}
                                        </div>
                                    </div>
                                `;
                            }).join("");
                        }
                    }
                }
            } catch (err) {
                if (usersContainer) {
                    usersContainer.innerHTML = `<div class="text-xs text-red-400 p-2">Nelze načíst uživatele: ${escapeHtml(err.message)}</div>`;
                }
            }
        }

        async function adminApproveUser(userId, role = "user") {
            try {
                const res = await fetch(`/api/auth/admin/approve/${userId}?role=${encodeURIComponent(role)}`, { method: "POST" });
                const data = await res.json();
                if (!res.ok) throw new Error(data.detail || "Chyba při schvalování uživatele.");
                showGlobalToast(data.message || "✅ Účet byl úspěšně schválen.", "success");
                loadAdminUserManagement();
            } catch (err) {
                showGlobalToast(err.message, "error");
            }
        }

        async function adminChangeRole(userId, newRole) {
            try {
                const res = await fetch(`/api/auth/admin/change-role/${userId}`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ role: newRole })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.detail || "Chyba při změně role uživatele.");
                showGlobalToast(data.message || "Role byla úspěšně změněna.", "success");
                loadAdminUserManagement();
            } catch (err) {
                showGlobalToast(err.message, "error");
                loadAdminUserManagement();
            }
        }

        async function adminRejectUser(userId) {
            if (!confirm(t("settings.confirmRejectRegistration", "Opravdu chcete tuto žádost o registraci zamítnout?"))) return;
            try {
                const res = await fetch(`/api/auth/admin/reject/${userId}`, { method: "POST" });
                const data = await res.json();
                if (!res.ok) throw new Error(data.detail || "Chyba při zamítání žádosti.");
                showGlobalToast(t("toast.requestRejected", "Žádost byla zamítnuta."), "info");
                loadAdminUserManagement();
            } catch (err) {
                showGlobalToast(err.message, "error");
            }
        }

        async function adminToggleUserStatus(userId, btnEl = null) {
            const btn = btnEl || document.getElementById(`adminToggleBtn_${userId}`);
            const badgeContainer = document.getElementById(`adminUserStatusBadge_${userId}`);

            if (btn && (btn.dataset.busy === "true" || btn.disabled)) return;

            // Zjistit aktuální a cílový stav
            const prevStatus = btn?.dataset.status || (btn?.textContent.includes("Odblokovat") ? "disabled" : "approved");
            const isCurrentlyDisabled = prevStatus === "disabled";
            const targetStatus = isCurrentlyDisabled ? "approved" : "disabled";

            // 1. OKAMŽITÁ RESPONZIVNÍ OPTIMISTICKÁ ZMĚNA (0 ms zpoždění pro uživatele)
            if (btn) {
                btn.dataset.busy = "true";
                btn.disabled = true;
                btn.dataset.status = targetStatus;

                if (targetStatus === "disabled") {
                    btn.className = "px-2 py-1 rounded-lg bg-emerald-950 text-emerald-300 border border-emerald-800 text-xs font-semibold transition active:scale-95 cursor-pointer disabled:opacity-75 disabled:cursor-not-allowed inline-flex items-center gap-1";
                    btn.title = "Odblokovat účet";
                    btn.innerHTML = `<span class="animate-spin inline-block text-[10px]">⏳</span> <span>Odblokovat</span>`;
                } else {
                    btn.className = "px-2 py-1 rounded-lg bg-slate-800 text-slate-300 hover:text-white text-xs font-semibold transition active:scale-95 cursor-pointer disabled:opacity-75 disabled:cursor-not-allowed inline-flex items-center gap-1";
                    btn.title = "Zablokovat účet";
                    btn.innerHTML = `<span class="animate-spin inline-block text-[10px]">⏳</span> <span>Zablokovat</span>`;
                }
            }

            if (badgeContainer) {
                if (targetStatus === "disabled") {
                    badgeContainer.innerHTML = `<span class="text-[10px] bg-red-950 text-red-400 font-bold px-1.5 py-0.2 rounded border border-red-800 transition-all">Zablokován</span>`;
                } else {
                    badgeContainer.innerHTML = `<span class="text-[10px] bg-emerald-950 text-emerald-400 font-bold px-1.5 py-0.2 rounded border border-emerald-800 transition-all">Aktivní</span>`;
                }
            }

            // 2. VOLÁNÍ SERVERU
            try {
                const res = await fetch(`/api/auth/admin/toggle-status/${userId}`, { method: "POST" });
                const data = await res.json();
                if (!res.ok) throw new Error(data.detail || "Chyba při změně stavu uživatele.");

                const finalStatus = data.new_status || targetStatus;
                const isFinalDisabled = finalStatus === "disabled";

                if (btn) {
                    btn.dataset.status = finalStatus;
                    btn.disabled = false;
                    delete btn.dataset.busy;
                    if (isFinalDisabled) {
                        btn.className = "px-2 py-1 rounded-lg bg-emerald-950 text-emerald-300 border border-emerald-800 text-xs font-semibold transition active:scale-95 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1";
                        btn.title = "Odblokovat účet";
                        btn.innerHTML = "🔓 Odblokovat";
                    } else {
                        btn.className = "px-2 py-1 rounded-lg bg-slate-800 text-slate-300 hover:text-white text-xs font-semibold transition active:scale-95 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1";
                        btn.title = "Zablokovat účet";
                        btn.innerHTML = "🔒 Zablokovat";
                    }
                }

                if (badgeContainer) {
                    if (isFinalDisabled) {
                        badgeContainer.innerHTML = `<span class="text-[10px] bg-red-950 text-red-400 font-bold px-1.5 py-0.2 rounded border border-red-800 transition-all">Zablokován</span>`;
                    } else {
                        badgeContainer.innerHTML = `<span class="text-[10px] bg-emerald-950 text-emerald-400 font-bold px-1.5 py-0.2 rounded border border-emerald-800 transition-all">Aktivní</span>`;
                    }
                }

                showGlobalToast(data.message || (isFinalDisabled ? "Účet byl zablokován." : "Účet byl odblokován."), "success");
            } catch (err) {
                // 3. VRÁCENÍ PŮVODNÍHO STAVU PŘI CHYBĚ (ROLLBACK)
                if (btn) {
                    btn.dataset.status = prevStatus;
                    btn.disabled = false;
                    delete btn.dataset.busy;
                    if (isCurrentlyDisabled) {
                        btn.className = "px-2 py-1 rounded-lg bg-emerald-950 text-emerald-300 border border-emerald-800 text-xs font-semibold transition active:scale-95 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1";
                        btn.title = "Odblokovat účet";
                        btn.innerHTML = "🔓 Odblokovat";
                    } else {
                        btn.className = "px-2 py-1 rounded-lg bg-slate-800 text-slate-300 hover:text-white text-xs font-semibold transition active:scale-95 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1";
                        btn.title = "Zablokovat účet";
                        btn.innerHTML = "🔒 Zablokovat";
                    }
                }

                if (badgeContainer) {
                    if (isCurrentlyDisabled) {
                        badgeContainer.innerHTML = `<span class="text-[10px] bg-red-950 text-red-400 font-bold px-1.5 py-0.2 rounded border border-red-800 transition-all">Zablokován</span>`;
                    } else {
                        badgeContainer.innerHTML = `<span class="text-[10px] bg-emerald-950 text-emerald-400 font-bold px-1.5 py-0.2 rounded border border-emerald-800 transition-all">Aktivní</span>`;
                    }
                }

                showGlobalToast(err.message, "error");
            }
        }

        async function adminDeleteUser(userId, username) {
            if (!confirm(`Opravdu chcete smazat uživatele "${username}"? Tato akce je nevratná.`)) return;
            const row = document.getElementById(`adminUserRow_${userId}`);
            if (row) {
                row.style.opacity = "0.4";
                row.style.pointerEvents = "none";
            }
            try {
                const res = await fetch(`/api/auth/admin/users/${userId}`, { method: "DELETE" });
                const data = await res.json();
                if (!res.ok) {
                    if (row) {
                        row.style.opacity = "1";
                        row.style.pointerEvents = "auto";
                    }
                    throw new Error(data.detail || "Chyba při mazání uživatele.");
                }
                if (row) row.remove();
                showGlobalToast(`Uživatel "${username}" byl smazán.`, "info");
                loadAdminUserManagement();
            } catch (err) {
                showGlobalToast(err.message, "error");
            }
        }

        async function adminToggleRegistration(enabled) {
            const statusEl = document.getElementById("regToggleStatus");
            try {
                const res = await fetch("/api/auth/admin/registration-toggle", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ allow_registration: enabled })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.detail || "Chyba při změně nastavení registrací.");
                authRegistrationAllowed = enabled;
                if (statusEl) {
                    statusEl.textContent = enabled ? "✅ Registrace nových účtů jsou povoleny (vyžadují vaše schválení)." : "🔒 Registrace nových účtů jsou vypnuty.";
                    statusEl.classList.remove("hidden");
                    setTimeout(() => statusEl.classList.add("hidden"), 4000);
                }
            } catch (err) {
                showGlobalToast(err.message, "error");
            }
        }

        async function adminToggleGuest(enabled) {
            const statusEl = document.getElementById("guestToggleStatus");
            try {
                const res = await fetch("/api/auth/admin/guest-toggle", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ allow_guest: enabled })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.detail || "Chyba při změně nastavení hostů.");
                authGuestAllowed = enabled;
                if (statusEl) {
                    statusEl.textContent = enabled ? "✅ Režim hosta je zapnut. Návštěvníci mohou procházet aplikaci jako pozorovatelé." : "🔒 Režim hosta je vypnut. Návštěvníci se musí přihlásit.";
                    statusEl.classList.remove("hidden");
                    setTimeout(() => statusEl.classList.add("hidden"), 4000);
                }
            } catch (err) {
                showGlobalToast(err.message, "error");
            }
        }

        async function adminToggleSharedApiKeys(enabled) {
            try {
                const res = await fetch("/api/auth/admin/shared-api-keys-toggle", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ shared_api_keys: enabled })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.detail || "Chyba při změně sdílení API klíčů.");
                showGlobalToast(
                    enabled 
                        ? t("toast.apiSharedOn", "🔑 Všichni uživatelé nyní sdílejí centrální API klíče od administrátora.")
                        : t("toast.apiSharedOff", "🔑 Každý uživatel (mimo pozorovatele) si nyní může nastavit vlastní API klíče."),
                    "success"
                );
                await loadAppSettings(false);
            } catch (err) {
                showGlobalToast(err.message, "error");
                loadAdminUserManagement();
            }
        }

        async function adminToggleSharedProjects(enabled) {
            try {
                const res = await fetch("/api/auth/admin/shared-projects-toggle", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ shared_projects: enabled })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.detail || "Chyba při změně sdílení projektů.");
                showGlobalToast(
                    enabled 
                        ? t("toast.projectsSharedOn", "📁 Všechny projekty jsou nyní sdíleny napříč všemi uživateli.")
                        : t("toast.projectsSharedOff", "📁 Každý uživatel má nyní své vlastní soukromé projekty oddělené od ostatních."),
                    "success"
                );
                await loadProjects();
            } catch (err) {
                showGlobalToast(err.message, "error");
                loadAdminUserManagement();
            }
        }

        function openSettingsModal(defaultTab = 'general') {
            const modal = document.getElementById("modalSettings");
            if (!modal) return;
            modal.classList.remove("hidden");
            if (typeof applyTranslations === "function") {
                applyTranslations(currentLanguage, modal);
            }
            // Vyčistit předchozí stavové hlášky
            ["Gemini", "Openai", "Elevenlabs"].forEach(p => {
                const el = document.getElementById(`statusSettings${p}`);
                if (el) {
                    el.className = "text-xs hidden mt-1";
                    el.textContent = "";
                }
            });
            const statusEl = document.getElementById("settingsSaveStatus");
            if (statusEl) statusEl.textContent = "";
            loadAppSettings(false);
            switchSettingsTab(defaultTab);
        }

        function closeSettingsModal() {
            const modal = document.getElementById("modalSettings");
            if (modal) modal.classList.add("hidden");
        }


        function togglePasswordVisibility(inputId) {
            const input = document.getElementById(inputId);
            if (!input) return;
            input.type = input.type === "password" ? "text" : "password";
        }

        async function testApiKey(provider) {
            const cap = provider.charAt(0).toUpperCase() + provider.slice(1);
            const inputId = provider === "gemini" ? "inputSettingsGeminiKey" :
                            provider === "openai" ? "inputSettingsOpenaiKey" : "inputSettingsElevenlabsKey";
            const input = document.getElementById(inputId);
            const statusEl = document.getElementById(`statusSettings${cap}`);
            const btn = document.getElementById(`btnTest${cap}`);

            const keyVal = input ? input.value.trim() : "";

            if (btn) {
                btn.disabled = true;
                btn.textContent = "Ověřuji...";
            }
            if (statusEl) {
                statusEl.className = "text-xs text-slate-400 mt-1 block";
                statusEl.textContent = t("settings.testingApi", "Probíhá test připojení k API...");
            }

            try {
                const payload = { provider, key: keyVal };
                if (provider === "gemini") {
                    payload.model = getSelectedModel("geminiModelSelect", "geminiModelCustomInput");
                }
                const res = await fetch("/api/settings/test-key", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload)
                });
                const data = await res.json();
                if (statusEl) {
                    if (data.valid) {
                        statusEl.className = "text-xs text-emerald-400 font-semibold mt-1 block";
                        statusEl.textContent = "✅ " + data.message;
                    } else {
                        statusEl.className = "text-xs text-red-400 font-semibold mt-1 block";
                        statusEl.textContent = "❌ " + data.message;
                    }
                }
            } catch (err) {
                if (statusEl) {
                    statusEl.className = "text-xs text-red-400 font-semibold mt-1 block";
                    statusEl.textContent = "❌ Chyba spojení: " + err.message;
                }
            } finally {
                if (btn) {
                    btn.disabled = false;
                    btn.textContent = "Ověřit";
                }
            }
        }

        async function saveAppSettings() {
            const btn = document.getElementById("btnSaveSettings");
            const statusEl = document.getElementById("settingsSaveStatus");

            const geminiInput = document.getElementById("inputSettingsGeminiKey");
            const openaiInput = document.getElementById("inputSettingsOpenaiKey");
            const elevenlabsInput = document.getElementById("inputSettingsElevenlabsKey");

            const payload = {};
            if (geminiInput && geminiInput.value.trim()) {
                payload.gemini_api_key = geminiInput.value.trim();
            }
            if (openaiInput && openaiInput.value.trim()) {
                payload.openai_api_key = openaiInput.value.trim();
            }
            if (elevenlabsInput && elevenlabsInput.value.trim()) {
                payload.elevenlabs_api_key = elevenlabsInput.value.trim();
            }
            if (typeof savePomodoroSettingsFromModal === "function") {
                payload.pomodoro_settings = savePomodoroSettingsFromModal();
            }

            if (btn) {
                btn.disabled = true;
                btn.textContent = "⏳ Ukládám...";
            }
            if (statusEl) {
                statusEl.className = "text-xs text-slate-400";
                statusEl.textContent = "Ukládání do lokální konfigurace...";
            }

            try {
                const res = await fetch("/api/settings", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload)
                });
                const data = await res.json();

                if (res.ok) {
                    if (statusEl) {
                        statusEl.className = "text-xs text-emerald-400 font-semibold";
                        statusEl.textContent = t("settings.savedSuccess", "✅ Nastavení bylo úspěšně uloženo!");
                    }
                    if (geminiInput && geminiInput.value) geminiInput.value = "";
                    if (openaiInput && openaiInput.value) openaiInput.value = "";
                    if (elevenlabsInput && elevenlabsInput.value) elevenlabsInput.value = "";

                    await loadAppSettings(false);

                    setTimeout(() => {
                        closeSettingsModal();
                    }, 1200);
                } else {
                    if (statusEl) {
                        statusEl.className = "text-xs text-red-400 font-semibold";
                        statusEl.textContent = "❌ Chyba: " + (data.detail || "Nelze uložit");
                    }
                }
            } catch (err) {
                if (statusEl) {
                    statusEl.className = "text-xs text-red-400 font-semibold";
                    statusEl.textContent = "❌ Chyba spojení: " + err.message;
                }
            } finally {
                if (btn) {
                    btn.disabled = false;
                    btn.innerHTML = `<span>💾</span> ${t("settings.saveBtn", "Uložit nastavení")}`;
                }
            }
        }

        async function openUserDataFolder() {
            try {
                const res = await fetch("/api/settings/open-data-folder", { method: "POST" });
                const data = await res.json();
                if (!res.ok) {
                    alert("Nepodařilo se otevřít složku: " + (data.detail || "Neznámá chyba"));
                }
            } catch (err) {
                alert("Chyba při otevírání složky: " + err.message);
            }
        }

        // =========================================================================
        // MEDULINGO™ (INTEGROVANÁ STUDIJNÍ CESTA PRO MEDICÍNU)
        // =========================================================================
        let medulingoData = null;
        let medulingoActiveCategory = "all";
        let activeMedQuestion = null;
        let activeMedStep = 1;
        let medSubtopics = [];
        let activeSubtopicIdx = 0;
        let medCards = [];
        let medActiveCardIdx = 0;
        let medCardFlipped = false;
        let medTestQuestions = [];
        let medTestUserAnswers = {};
        let medTestEvaluated = false;
        let medChatMessages = [];

        async function loadMedulingo(showToast = false) {
            if (!currentProject) {
                appendConsoleLog("⚠️ Pro Medulingo musíte nejdříve vybrat projekt v horní liště.");
                return;
            }

            const pLabel = document.getElementById("medulingoProjectLabel");
            if (pLabel) pLabel.textContent = currentProject;

            try {
                const res = await fetch(`/api/medulingo/overview?project=${encodeURIComponent(currentProject)}`);
                if (!res.ok) throw new Error("Chyba při načítání dat pro Medulingo.");
                medulingoData = await res.json();

                renderMedulingoDashboard();
                renderMedulingoUnitsFilter();
                renderMedulingoRoadmap();
                if (typeof updateMedulingoPomodoroBar === "function") {
                    updateMedulingoPomodoroBar();
                }

                if (showToast) {
                    appendConsoleLog("🦉 Medulingo aktualizováno z plánovače a souborů.");
                }
            } catch (err) {
                console.error("Medulingo load error:", err);
                appendConsoleLog(`❌ Chyba Medulingo: ${err.message}`);
            }
        }

        function renderMedulingoDashboard() {
            if (!medulingoData) return;
            const m = medulingoData.metrics || {};
            const buf = medulingoData.buffer || {};

            // 1. Streak
            const elStreak = document.getElementById("medulingoStreakVal");
            if (elStreak) elStreak.textContent = t("medulingo.streakVal", "{count} dní", { count: m.streak || 1 });

            // 2. Dnešní cíl
            const elGoal = document.getElementById("medulingoTodayGoalVal");
            if (elGoal) {
                elGoal.textContent = t("medulingo.goalRatio", "{done} / {target} otázek", { done: m.completed_today || 0, target: m.questions_per_day || 1 });
            }

            // 3. Dny
            const elDays = document.getElementById("medulingoDaysVal");
            if (elDays) {
                if (!m.exam_date) {
                    elDays.textContent = t("medulingo.setExamDate", "Nastavit termín");
                } else {
                    elDays.textContent = t("medulingo.daysRemainingVal", "{count} dní", { count: m.study_days_remaining || 0 });
                }
            }

            // 4. Celkový postup
            const elProg = document.getElementById("medulingoProgressVal");
            if (elProg) {
                elProg.textContent = `${m.progress_pct || 0}% (${m.completed_questions || 0} / ${m.total_questions || 0})`;
            }

            // Progress bar
            const elBar = document.getElementById("medulingoProgressBar");
            if (elBar) elBar.style.width = `${m.progress_pct || 0}%`;

            // Buffer Alert Banner
            const elBufBanner = document.getElementById("medulingoBufferBanner");
            const elBufMsg = document.getElementById("medulingoBufferMsg");
            if (elBufBanner) {
                if (buf.needs_warning) {
                    elBufBanner.classList.remove("hidden");
                    if (elBufMsg) elBufMsg.textContent = buf.warning_message;
                } else {
                    elBufBanner.classList.add("hidden");
                }
            }
        }

        function renderMedulingoUnitsFilter() {
            if (!medulingoData) return;
            const units = medulingoData.units || [];
            const bar = document.getElementById("medulingoUnitsFilterBar");
            const countEl = document.getElementById("medulingoUnitsSummary");
            if (!bar) return;

            bar.innerHTML = "";
            if (countEl) countEl.textContent = `${units.length} lekcí (${medulingoData.all_questions?.length || 0} otázek)`;

            // Tlačítko pro "Všechny lekce"
            const allBtn = document.createElement("button");
            allBtn.onclick = () => filterMedulingoUnit("all");
            allBtn.className = `duo-btn px-3.5 py-1.5 rounded-xl text-xs font-bold transition flex items-center gap-1.5 flex-shrink-0 ${medulingoActiveCategory === "all" ? "bg-emerald-600 text-white shadow-emerald-900/50" : "bg-slate-800 text-slate-300 hover:bg-slate-700"}`;
            allBtn.innerHTML = `<span>🗺️</span> ${t("medulingo.wholeMap", "Celá mapa")}`;
            bar.appendChild(allBtn);

            units.forEach(u => {
                const btn = document.createElement("button");
                btn.onclick = () => filterMedulingoUnit(u.title);
                const isActive = medulingoActiveCategory === u.title;
                btn.className = `duo-btn px-3.5 py-1.5 rounded-xl text-xs font-bold transition flex items-center gap-1.5 flex-shrink-0 ${isActive ? "bg-emerald-600 text-white shadow-emerald-900/50" : "bg-slate-800 text-slate-300 hover:bg-slate-700"}`;
                btn.innerHTML = `<span>${u.icon}</span> <span>${u.title}</span> <span class="text-[10px] opacity-70">(${u.completed_count}/${u.total_count})</span>`;
                bar.appendChild(btn);
            });
        }

        function filterMedulingoUnit(catTitle) {
            medulingoActiveCategory = catTitle;
            renderMedulingoUnitsFilter();
            renderMedulingoRoadmap();
        }

        function setMedulingoSort(mode) {
            medulingoSortMode = mode;
            const btnSeq = document.getElementById("btnMedSortSequence");
            const btnCat = document.getElementById("btnMedSortCategory");
            if (mode === "sequence") {
                if (btnSeq) {
                    btnSeq.className = "px-3 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 shadow-sm bg-emerald-600 text-white";
                }
                if (btnCat) {
                    btnCat.className = "px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-400 hover:text-white transition flex items-center gap-1.5";
                }
            } else {
                if (btnCat) {
                    btnCat.className = "px-3 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 shadow-sm bg-emerald-600 text-white";
                }
                if (btnSeq) {
                    btnSeq.className = "px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-400 hover:text-white transition flex items-center gap-1.5";
                }
            }
            renderMedulingoRoadmap();
        }

        function renderMedulingoRoadmap() {
            if (!medulingoData) return;
            const container = document.getElementById("medulingoRoadmapContainer");
            if (!container) return;

            let questions = [...(medulingoData.all_questions || [])];
            if (medulingoActiveCategory !== "all") {
                questions = questions.filter(q => q.topic === medulingoActiveCategory);
            }

            if (questions.length === 0) {
                container.innerHTML = `
                    <div class="text-center py-16 text-slate-500">
                        <span class="text-4xl block mb-2">📭</span>
                        V této kategorii nejsou žádné zkouškové otázky.
                    </div>
                `;
                return;
            }

            // Řazení podle zvoleného režimu:
            // 1) "sequence" -> přesně po číslech otázek jak jdou za sebou
            // 2) "category" -> nejprve podle kategorií a v rámci kategorie se zachová původní číslování otázky
            if (medulingoSortMode === "category") {
                questions.sort((a, b) => {
                    const topA = a.topic || "Všeobecné";
                    const topB = b.topic || "Všeobecné";
                    const cTop = topA.localeCompare(topB, "cs", { sensitivity: "base" });
                    if (cTop !== 0) return cTop;
                    const numA = parseInt(a.number, 10);
                    const numB = parseInt(b.number, 10);
                    if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
                    return (a.number || "").localeCompare(b.number || "", undefined, { numeric: true });
                });
            } else {
                questions.sort((a, b) => {
                    const numA = parseInt(a.number, 10);
                    const numB = parseInt(b.number, 10);
                    if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
                    return (a.number || "").localeCompare(b.number || "", undefined, { numeric: true });
                });
            }

            container.innerHTML = "";

            // Střídavé horizontální posuny pro křivolakou cestu: 0 -> -36px -> 0 -> 36px -> 0...
            const offsets = ["translate-x-0", "-translate-x-12 sm:-translate-x-16", "translate-x-0", "translate-x-12 sm:translate-x-16"];

            let foundFirstActive = false;
            let lastRenderedTopic = null;

            questions.forEach((q, idx) => {
                // Pokud řadíme podle kategorií a jsme v přehledu celé mapy, zobrazíme předělový štítek kategorie
                if (medulingoSortMode === "category" && medulingoActiveCategory === "all" && q.topic !== lastRenderedTopic) {
                    lastRenderedTopic = q.topic;
                    const catDivider = document.createElement("div");
                    catDivider.className = "w-full my-6 flex items-center justify-center gap-3 z-0";
                    catDivider.innerHTML = `
                        <div class="h-px bg-slate-700/80 flex-1 max-w-[100px]"></div>
                        <span class="px-4 py-1.5 rounded-full text-xs font-black tracking-wider uppercase bg-emerald-950 text-emerald-300 border border-emerald-700 shadow-md flex items-center gap-2">
                            <span>🏷️</span> ${escapeHtml(q.topic || "VŠEOBECNÉ")}
                        </span>
                        <div class="h-px bg-slate-700/80 flex-1 max-w-[100px]"></div>
                    `;
                    container.appendChild(catDivider);
                }

                const offsetClass = offsets[idx % offsets.length];
                const isCompleted = q.is_completed;
                const isReady = q.is_ready;

                // Určení zda je toto doporučená aktuální otázka (první nesplněná)
                let isCurrent = false;
                if (!isCompleted && !foundFirstActive) {
                    isCurrent = true;
                    foundFirstActive = true;
                }

                // Vizuální styling uzlu
                let nodeBg = "bg-slate-800 border-slate-600 text-slate-400";
                let nodeIcon = "🔒";
                let nodeStatusText = "Zamčeno";

                if (isCompleted) {
                    nodeBg = "bg-gradient-to-b from-amber-400 to-amber-600 border-amber-300 text-slate-950 font-black shadow-amber-900/50";
                    nodeIcon = q.grade ? q.grade : "🌟";
                    nodeStatusText = `Splněno (${q.grade || "A"})`;
                } else if (isCurrent) {
                    nodeBg = isReady 
                        ? "bg-gradient-to-b from-emerald-400 to-emerald-600 border-emerald-300 text-white font-black duo-node-active" 
                        : "bg-gradient-to-b from-amber-500 to-amber-700 border-amber-300 text-white font-black duo-node-active";
                    nodeIcon = isReady ? "▶️" : "⚡";
                    nodeStatusText = isReady ? "Doporučeno ke studiu" : "Vygenerovat obsah";
                } else if (isReady) {
                    nodeBg = "bg-gradient-to-b from-sky-600 to-sky-800 border-sky-400 text-white font-bold";
                    nodeIcon = "📖";
                    nodeStatusText = "Připraveno";
                } else {
                    nodeBg = "bg-slate-800 hover:bg-slate-700 border-slate-600 text-amber-400";
                    nodeIcon = "⚡";
                    nodeStatusText = "On-demand";
                }

                // Asset badges
                const bNotes = q.has_notes ? `<span title="Studijní text připraven" class="text-xs">📖</span>` : "";
                const bAudio = q.has_audio ? `<span title="Podcast připraven" class="text-xs">🎙️</span>` : "";
                const bCards = q.has_cards ? `<span title="Kartičky připraveny (${q.cards_count} ks)" class="text-xs">🗂️</span>` : "";
                const bTest = q.has_test ? `<span title="Test připraven" class="text-xs">📋</span>` : "";

                const row = document.createElement("div");
                row.className = `flex flex-col items-center relative z-10 transition-transform duration-300 ${offsetClass}`;

                row.innerHTML = `
                    <!-- UZEL ROADMAPY (3D BUTTON) -->
                    <button onclick="openMedulingoQuestion('${q.id}')" 
                            class="duo-node w-16 h-16 rounded-full border-4 flex items-center justify-center text-xl cursor-pointer ${nodeBg}"
                            title="${q.title} - ${nodeStatusText}">
                        ${nodeIcon}
                    </button>

                    <!-- INFORMAČNÍ KARTA OTÁZKY -->
                    <div onclick="openMedulingoQuestion('${q.id}')" 
                         class="mt-2.5 bg-slate-900/90 hover:bg-slate-850 p-2.5 px-4 rounded-2xl border ${isCurrent ? 'border-emerald-500/80 shadow-lg shadow-emerald-950/50' : 'border-slate-800'} text-center max-w-[280px] cursor-pointer group transition-all">
                        <div class="flex items-center justify-center gap-1.5 text-[10px] text-slate-400 uppercase font-bold tracking-wider">
                            <span>Otázka ${q.number}</span> &bull; 
                            <span class="text-emerald-400 truncate">${escapeHtml(q.topic)}</span>
                        </div>
                        <h4 class="text-xs font-bold text-slate-100 group-hover:text-emerald-300 transition truncate mt-0.5" title="${escapeHtml(q.title)}">
                            ${escapeHtml(q.title)}
                        </h4>
                        <div class="flex items-center justify-center gap-1 mt-1.5">
                            ${bNotes} ${bAudio} ${bCards} ${bTest}
                            ${!q.has_notes && !q.has_audio && !q.has_cards && !q.has_test ? '<span class="text-[10px] text-amber-400/80 italic font-semibold">Generovat na vyžádání</span>' : ''}
                        </div>
                    </div>
                `;

                container.appendChild(row);
            });
        }

        async function openMedulingoQuestion(questionId) {
            if (!currentProject) return;
            const modal = document.getElementById("medulingoPathModal");
            if (!modal) return;

            modal.classList.remove("hidden");
            activeMedStep = 1;
            switchMedulingoStep(1);

            document.getElementById("medModalQuestionTitle").textContent = t("medulingo.loadingQuestions", "Načítám podklady otázky...");
            document.getElementById("medSubtopicMarkdownBody").innerHTML = `<div class="text-slate-500 italic py-8 text-center">Načítám kompletní studijní data...</div>`;

            try {
                const res = await fetch(`/api/medulingo/question/${encodeURIComponent(questionId)}?project=${encodeURIComponent(currentProject)}`);
                if (!res.ok) throw new Error("Nelze načíst otázku.");
                const data = await res.json();
                activeMedQuestion = data;
                window.currentMedulingoSources = data.sources || [];
                if (data.sources && data.sources.length > 0) {
                    registerProjectSources(data.project || currentProject, data.sources);
                }

                renderMedulingoModalHeader();
                renderMedulingoSubtopics();
                renderMedulingoPodcast();
                renderMedulingoCards();
                renderMedulingoTest();
                resetMedulingoChat(activeMedQuestion.question?.title);

            } catch (err) {
                console.error("Error opening question:", err);
                alert("Chyba při otevírání otázky: " + err.message);
                closeMedulingoModal();
            }
        }

        function closeMedulingoModal() {
            const modal = document.getElementById("medulingoPathModal");
            if (modal) modal.classList.add("hidden");
            // Stop audio if playing
            const audio = document.getElementById("medAudioPlayer");
            if (audio) audio.pause();
        }

        async function reloadCurrentMedulingoQuestion() {
            if (!activeMedQuestion || !activeMedQuestion.question) return;
            const qId = activeMedQuestion.question.id;
            const btn = document.getElementById("btnMedReloadQuestion");
            if (btn) btn.classList.add("animate-spin");

            try {
                appendConsoleLog(`🔄 [Medulingo] Obnovuji podklady otázky...`);
                const res = await fetch(`/api/medulingo/question/${encodeURIComponent(qId)}?project=${encodeURIComponent(currentProject)}&t=${Date.now()}`);
                if (!res.ok) throw new Error("Chyba při obnově otázky.");
                const data = await res.json();
                activeMedQuestion = data;
                window.currentMedulingoSources = data.sources || [];
                if (data.sources && data.sources.length > 0) {
                    registerProjectSources(data.project || currentProject, data.sources);
                }

                renderMedulingoModalHeader();
                renderMedulingoSubtopics();
                renderMedulingoPodcast();
                renderMedulingoCards();
                renderMedulingoTest();

                // Synchronizace roadmapy v pozadí
                loadMedulingo(false);
                appendConsoleLog(`✅ [Medulingo] Podklady otázky byly úspěšně aktualizovány!`);
            } catch (err) {
                console.error("reloadCurrentMedulingoQuestion error:", err);
                alert("Chyba při obnovování otázky: " + err.message);
            } finally {
                if (btn) btn.classList.remove("animate-spin");
            }
        }

        function renderMedulingoModalHeader() {
            if (!activeMedQuestion) return;
            const q = activeMedQuestion.question || {};
            const status = activeMedQuestion.status || {};
            const viewer = isViewerMode();

            document.getElementById("medModalQuestionTitle").textContent = `Otázka ${q.number}: ${q.title}`;
            document.getElementById("medModalCategoryName").textContent = (q.topic || "VŠEOBECNÉ").toUpperCase();

            // Grade badge
            const gradeBadge = document.getElementById("medModalGradeBadge");
            if (gradeBadge) {
                if (status.is_completed) {
                    gradeBadge.classList.remove("hidden");
                    gradeBadge.className = "text-[10px] font-extrabold px-2 py-0.5 rounded-full border bg-amber-950 text-amber-300 border-amber-700";
                    gradeBadge.textContent = `Splněno (${status.grade || 'A'})`;
                } else {
                    gradeBadge.classList.add("hidden");
                }
            }

            // Tlačítko splněno / neprošlo v záhlaví modalu
            const isComp = Boolean(status.is_completed || q.completedDate);
            const compBtn = document.getElementById("btnMedToggleComplete");
            const compIcon = document.getElementById("medCompleteCheckboxIcon");
            const compText = document.getElementById("medCompleteBtnText");
            if (compBtn) {
                if (viewer) {
                    compBtn.disabled = true;
                    compBtn.title = "Režim pozorovatele: Pouze ke čtení";
                    if (isComp) {
                        compBtn.className = "h-8 px-2.5 rounded-xl border text-xs font-bold transition flex items-center gap-1.5 shadow bg-emerald-950/60 text-emerald-300/70 border-emerald-800 opacity-60 cursor-not-allowed";
                        if (compIcon) compIcon.textContent = "✅";
                        if (compText) compText.textContent = t("medulingo.statusCompleted", "Splněno");
                    } else {
                        compBtn.className = "h-8 px-2.5 rounded-xl border text-xs font-bold transition flex items-center gap-1.5 shadow bg-slate-900/60 border-slate-800 text-slate-400 opacity-60 cursor-not-allowed";
                        if (compIcon) compIcon.textContent = "⬜";
                        if (compText) compText.textContent = t("medulingo.markCompleted", "Označit splněno");
                    }
                } else {
                    compBtn.disabled = false;
                    compBtn.title = "";
                    if (isComp) {
                        compBtn.className = "h-8 px-2.5 rounded-xl border text-xs font-bold transition flex items-center gap-1.5 shadow bg-emerald-950 text-emerald-300 border-emerald-600 hover:bg-emerald-900";
                        if (compIcon) compIcon.textContent = "✅";
                        if (compText) compText.textContent = t("medulingo.statusCompleted", "Splněno");
                    } else {
                        compBtn.className = "h-8 px-2.5 rounded-xl border text-xs font-bold transition flex items-center gap-1.5 shadow bg-slate-900 border-slate-700 text-slate-300 hover:text-white";
                        if (compIcon) compIcon.textContent = "⬜";
                        if (compText) compText.textContent = t("medulingo.markCompleted", "Označit splněno");
                    }
                }
            }

            // Výběr známky v záhlaví
            const gradeSel = document.getElementById("medModalGradeSelect");
            if (gradeSel) {
                gradeSel.value = status.grade || q.grade || "A";
                gradeSel.disabled = viewer;
                if (viewer) {
                    gradeSel.classList.add("opacity-60", "cursor-not-allowed");
                    gradeSel.title = "Režim pozorovatele: Pouze ke čtení";
                } else {
                    gradeSel.classList.remove("opacity-60", "cursor-not-allowed");
                    gradeSel.title = "";
                }
            }

            // Pomodoro v modalu Medulingo
            if (typeof updateMedulingoModalPomodoro === "function") {
                updateMedulingoModalPomodoro();
            }

            // On-demand missing banner
            const missingBanner = document.getElementById("medModalMissingBanner");
            const missingText = document.getElementById("medModalMissingModulesText");
            const missing = [];
            const missingKeys = [];
            if (!status.has_notes) { missing.push("Studijní text"); missingKeys.push("notes"); }
            if (!status.has_cards) { missing.push("Kartičky"); missingKeys.push("cards"); }
            if (!status.has_audio) { missing.push("Minipodcast"); missingKeys.push("podcast"); }
            if (!status.has_test) { missing.push("Finální test"); missingKeys.push("test"); }

            if (missing.length > 0 && missingBanner && missingText && !viewer) {
                missingBanner.classList.remove("hidden");
                missingText.textContent = missing.join(", ");
                const btn = document.getElementById("btnMedModalGenerate");
                if (btn) {
                    btn.onclick = () => medulingoTriggerPackGeneration(missingKeys);
                }
            } else if (missingBanner) {
                missingBanner.classList.add("hidden");
            }
        }

        async function toggleMedActiveQuestionComplete() {
            if (!activeMedQuestion || !activeMedQuestion.question || !currentProject) return;
            if (isViewerMode()) {
                showGlobalToast(t("toast.viewerRestrictedQuestion", "👁️ Režim pozorovatele: Nemáte oprávnění měnit stav ani obsah zkouškových otázek."), "warning");
                return;
            }
            const q = activeMedQuestion.question;
            const currentCompleted = Boolean(activeMedQuestion.status?.is_completed || q.completedDate);
            const newCompleted = !currentCompleted;
            const grade = (document.getElementById("medModalGradeSelect")?.value) || q.grade || "A";

            try {
                const res = await fetch("/api/medulingo/complete", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        project: currentProject,
                        question_id: q.id,
                        grade: grade,
                        completed: newCompleted
                    })
                });

                if (!res.ok) {
                    const errData = await res.json().catch(() => ({}));
                    throw new Error(errData.detail || "Chyba při ukládání stavu otázky.");
                }

                if (!activeMedQuestion.status) activeMedQuestion.status = {};
                activeMedQuestion.status.is_completed = newCompleted;
                activeMedQuestion.status.grade = grade;
                q.completedDate = newCompleted ? getLocalDateString() : null;
                q.grade = newCompleted ? grade : null;

                const projQ = questions.find(item => item.id === q.id || item.title === q.title);
                if (projQ) {
                    projQ.completedDate = q.completedDate;
                    projQ.grade = q.grade;
                    saveProjectQuestions(false);
                }

                renderMedulingoModalHeader();
                await loadMedulingo(false);
                appendConsoleLog(newCompleted ? `🏆 [Medulingo] Otázka '${q.title}' označena jako splněná (${grade})!` : `ℹ️ [Medulingo] Otázka '${q.title}' označena jako nesplněná.`);
            } catch (e) {
                console.error("toggleMedActiveQuestionComplete error:", e);
                alert("Chyba při změně stavu splnění: " + e.message);
            }
        }

        async function onMedGradeSelectChange(newGrade) {
            if (!activeMedQuestion || !activeMedQuestion.question || !currentProject) return;
            if (isViewerMode()) {
                showGlobalToast(t("toast.viewerRestrictedQuestion", "👁️ Režim pozorovatele: Nemáte oprávnění měnit stav ani obsah zkouškových otázek."), "warning");
                return;
            }
            const q = activeMedQuestion.question;
            const isCompleted = Boolean(activeMedQuestion.status?.is_completed || q.completedDate);
            const grade = newGrade || "A";

            try {
                const res = await fetch("/api/medulingo/complete", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        project: currentProject,
                        question_id: q.id,
                        grade: grade,
                        completed: isCompleted
                    })
                });

                if (!res.ok) {
                    const errData = await res.json().catch(() => ({}));
                    throw new Error(errData.detail || "Chyba při ukládání známky.");
                }

                if (!activeMedQuestion.status) activeMedQuestion.status = {};
                activeMedQuestion.status.grade = grade;
                q.grade = grade;

                const projQ = questions.find(item => item.id === q.id || item.title === q.title);
                if (projQ) {
                    projQ.grade = grade;
                    saveProjectQuestions(false);
                }

                renderMedulingoModalHeader();
                await loadMedulingo(false);
            } catch (e) {
                console.error("onMedGradeSelectChange error:", e);
                alert("Chyba při ukládání známky: " + e.message);
            }
        }

        async function saveMedManualCompletionFromStep5() {
            if (!activeMedQuestion || !activeMedQuestion.question || !currentProject) return;
            if (isViewerMode()) {
                showGlobalToast(t("toast.viewerRestrictedQuestion", "👁️ Režim pozorovatele: Nemáte oprávnění měnit stav ani obsah zkouškových otázek."), "warning");
                return;
            }
            const sel = document.getElementById("medStep5GradeSelect") || document.getElementById("medManualGradeSelect");
            const grade = (sel ? sel.value : "A") || "A";
            const q = activeMedQuestion.question;

            try {
                const res = await fetch("/api/medulingo/complete", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        project: currentProject,
                        question_id: q.id,
                        grade: grade,
                        completed: true
                    })
                });

                if (!res.ok) {
                    const errData = await res.json().catch(() => ({}));
                    throw new Error(errData.detail || "Chyba při ukládání hodnocení.");
                }

                if (!activeMedQuestion.status) activeMedQuestion.status = {};
                activeMedQuestion.status.is_completed = true;
                activeMedQuestion.status.grade = grade;
                q.completedDate = getLocalDateString();
                q.grade = grade;

                const projQ = questions.find(item => item.id === q.id || item.title === q.title);
                if (projQ) {
                    projQ.completedDate = q.completedDate;
                    projQ.grade = grade;
                    saveProjectQuestions(false);
                }

                appendConsoleLog(`🏆 [Medulingo] Otázka '${q.title}' označena jako splněná (${grade}) a zapsána do plánovače!`);
                closeMedulingoModal();
                await loadMedulingo(true);
            } catch (e) {
                console.error("saveMedManualCompletionFromStep5 error:", e);
                alert("Chyba při ukládání: " + e.message);
            }
        }

        function switchMedulingoStep(stepNum) {
            activeMedStep = stepNum;
            for (let i = 1; i <= 5; i++) {
                const btn = document.getElementById(`medStepBtn-${i}`);
                const view = document.getElementById(`medStepView-${i}`);

                if (i === stepNum) {
                    if (view) view.classList.remove("hidden");
                    if (btn) btn.className = "px-3 py-2 rounded-xl flex items-center gap-1.5 transition text-emerald-400 bg-emerald-950/60 border border-emerald-700/50 shadow-sm flex-shrink-0 font-bold";
                } else {
                    if (view) view.classList.add("hidden");
                    if (btn) btn.className = "px-3 py-2 rounded-xl flex items-center gap-1.5 transition text-slate-400 hover:text-slate-200 hover:bg-slate-800/60 flex-shrink-0 font-medium";
                }
            }

            // Auto-render KaTeX if switching to text
            if (stepNum === 1 && typeof renderMathInElement === "function") {
                const body = document.getElementById("medSubtopicMarkdownBody");
                if (body) {
                    renderMathInElement(body, {
                        delimiters: [
                            { left: "$$", right: "$$", display: true },
                            { left: "$", right: "$", display: false }
                        ],
                        throwOnError: false
                    });
                }
            }
        }

        // --- KROK 1: SUBTOPICS (PODTÉMATA) ---
        function renderMedulingoSubtopics() {
            if (!activeMedQuestion) return;
            medSubtopics = activeMedQuestion.subtopics || [];
            activeSubtopicIdx = 0;

            const markDoneBtn = document.getElementById("btnMedMarkTextDone");
            if (markDoneBtn) {
                if (isViewerMode()) {
                    markDoneBtn.classList.add("hidden");
                } else {
                    markDoneBtn.classList.remove("hidden");
                }
            }

            const pillBar = document.getElementById("medSubtopicsPillBar");
            const countEl = document.getElementById("medSubtopicsCount");
            if (countEl) countEl.textContent = `${medSubtopics.length} částí`;

            if (!pillBar) return;
            pillBar.innerHTML = "";

            if (medSubtopics.length === 0) {
                document.getElementById("medSubtopicMarkdownBody").innerHTML = `
                    <div class="text-center py-10 text-slate-500">
                        Pro tuto otázku ještě nebyl vygenerován studijní text. 
                        ${isViewerMode() ? '' : `
                        <button onclick="medulingoTriggerPackGeneration(['notes'])" class="mt-3 block mx-auto duo-btn bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs px-4 py-2 rounded-xl">
                            ⚡ Vygenerovat studijní text
                        </button>
                        `}
                    </div>
                `;
                return;
            }

            medSubtopics.forEach((sub, idx) => {
                const btn = document.createElement("button");
                btn.onclick = () => selectMedSubtopic(idx);
                btn.className = `px-3 py-1.5 rounded-xl text-xs font-bold transition flex-shrink-0 ${idx === 0 ? "bg-emerald-700 text-white" : "bg-slate-800 text-slate-300 hover:bg-slate-700"}`;
                btn.textContent = `${idx + 1}. ${sub.title}`;
                pillBar.appendChild(btn);
            });

            displayMedSubtopicContent(0);
        }

        function selectMedSubtopic(idx) {
            activeSubtopicIdx = idx;
            const pillBar = document.getElementById("medSubtopicsPillBar");
            if (pillBar) {
                Array.from(pillBar.children).forEach((btn, bIdx) => {
                    btn.className = `px-3 py-1.5 rounded-xl text-xs font-bold transition flex-shrink-0 ${bIdx === idx ? "bg-emerald-700 text-white" : "bg-slate-800 text-slate-300 hover:bg-slate-700"}`;
                });
            }
            displayMedSubtopicContent(idx);
        }

        function displayMedSubtopicContent(idx) {
            const body = document.getElementById("medSubtopicMarkdownBody");
            if (!body || !medSubtopics[idx]) return;

            if (activeMedQuestion && activeMedQuestion.sources) {
                window.currentMedulingoSources = activeMedQuestion.sources;
                registerProjectSources(activeMedQuestion.project || currentProject, activeMedQuestion.sources);
            }

            let html = renderMarkdownWithKaTeX(medSubtopics[idx].content || "");
            body.innerHTML = html;
        }

        // --- KROK 2: PODCAST ---
        function renderMedulingoPodcast() {
            if (!activeMedQuestion) return;
            const p = activeMedQuestion.podcast;
            const playerCont = document.getElementById("medPodcastPlayerContainer");
            const missingAlert = document.getElementById("medPodcastMissingAlert");
            const audio = document.getElementById("medAudioPlayer");

            if (p && p.audio_url) {
                if (playerCont) playerCont.classList.remove("hidden");
                if (missingAlert) missingAlert.classList.add("hidden");
                if (audio) audio.src = p.audio_url;
            } else {
                if (playerCont) playerCont.classList.add("hidden");
                if (missingAlert) missingAlert.classList.remove("hidden");
            }
        }

        function setMedAudioSpeed(speed) {
            const audio = document.getElementById("medAudioPlayer");
            if (audio) audio.playbackRate = speed;
        }

        // --- KROK 3: KARTIČKY ---
        function renderMedulingoCards() {
            if (!activeMedQuestion) return;
            medCards = activeMedQuestion.flashcards || [];
            medActiveCardIdx = 0;
            medCardFlipped = false;
            updateMedCardDisplay();
        }

        function updateMedCardDisplay() {
            const front = document.getElementById("medCardFrontText");
            const back = document.getElementById("medCardBackText");
            const counter = document.getElementById("medCardsCounter");
            const ref = document.getElementById("medCardSourceRef");
            const inner = document.getElementById("medFlashcardInner");

            // Reset flip
            medCardFlipped = false;
            if (inner) inner.style.transform = "rotateY(0deg)";

            if (!medCards || medCards.length === 0) {
                if (front) front.textContent = t("medulingo.noCardsForQuestion", "Pro tuto otázku zatím nejsou vygenerovány kartičky.");
                if (back) back.textContent = t("medulingo.generateCardsPrompt", "Vygenerujte kartičky pomocí horního tlačítka.");
                if (counter) counter.textContent = "0 karet";
                if (ref) ref.innerHTML = "";
                return;
            }

            if (medActiveCardIdx < 0 || medActiveCardIdx >= medCards.length) {
                medActiveCardIdx = 0;
            }

            const c = medCards[medActiveCardIdx];
            if (!c) return;

            if (front) front.textContent = c.front || "";
            if (back) {
                try {
                    back.innerHTML = typeof renderMarkdownWithKaTeX === "function"
                        ? renderMarkdownWithKaTeX(c.back || "")
                        : (typeof marked !== "undefined" ? marked.parse(c.back || "") : (c.back || ""));
                } catch (e) {
                    back.textContent = c.back || "";
                }
            }

            if (ref) {
                if (c.source_ref || c.source_file) {
                    const resolved = resolveCardSourceClient(c, (activeMedQuestion && activeMedQuestion.sources) || []);
                    const label = resolved.source_file 
                        ? `${resolved.source_file}${resolved.clean_page ? ` (s. ${resolved.clean_page})` : ''}`
                        : (resolved.source_ref || "Zobrazit zdroj");
                    const safeFile = (resolved.source_file || "").replace(/'/g, "\\'");
                    const safeId = (resolved.source_id || "").replace(/'/g, "\\'");
                    const safePage = (resolved.clean_page || "").replace(/'/g, "\\'");
                    const safeProj = ((activeMedQuestion && activeMedQuestion.project) || currentProject || "").replace(/'/g, "\\'");
                    ref.innerHTML = `<span class="cursor-pointer hover:underline text-sky-400 flex items-center gap-1 font-mono text-[11px]" onclick="event.stopPropagation(); handleCitationClick(event, '${safeFile || safeId}', '${safePage}', '${safeProj}')" title="Kliknutím otevřít zdroj">📖 ${label} ↗</span>`;
                } else {
                    ref.innerHTML = "";
                }
            }
            if (counter) counter.textContent = `Karta ${medActiveCardIdx + 1} z ${medCards.length}`;
        }

        function flipMedulingoCard() {
            const inner = document.getElementById("medFlashcardInner");
            if (!inner) return;
            medCardFlipped = !medCardFlipped;
            inner.style.transform = medCardFlipped ? "rotateY(180deg)" : "rotateY(0deg)";
        }

        function nextMedulingoCard(known = true) {
            if (medCards.length === 0) return;
            if (medActiveCardIdx < medCards.length - 1) {
                medActiveCardIdx++;
                updateMedCardDisplay();
            } else {
                // Dokončena série
                alert(t("medulingo.allCardsFinished", "🎉 Prošli jste všechny kartičky k této otázce! Můžete přejít k finálnímu testu."));
                switchMedulingoStep(5);
            }
        }

        // --- KROK 4: CHAT ASISTENT ---
        let medChatThreadId = null;

        function resetMedulingoChat(qTitle = "") {
            medChatThreadId = null;
            const history = document.getElementById("medChatHistory");
            const title = qTitle || activeMedQuestion?.question?.title || "této otázce";
            if (history) {
                history.innerHTML = `
                    <div class="bg-slate-900/80 p-3 rounded-xl border border-slate-800 text-slate-300 leading-relaxed">
                        Dobrý den! Jsem váš lékařský asistent se znalostí podkladů k otázce <strong>${escapeHtml(title)}</strong>. Máte k tomuto tématu jakoukoliv nejasnost, potřebujete vysvětlit patofyziologii, diferenciální diagnostiku, vyšetřovací postupy nebo farmakoterapii? Zeptejte se mě.
                    </div>
                `;
            }
            const input = document.getElementById("medChatInput");
            if (input) {
                input.value = "";
                input.disabled = false;
            }
            const btnSend = document.getElementById("btnMedChatSend");
            if (btnSend) {
                btnSend.disabled = false;
                btnSend.classList.remove("opacity-50", "cursor-not-allowed");
            }
        }

        function fillMedChatPrompt(keyOrText, fallback) {
            const input = document.getElementById("medChatInput");
            if (input) {
                input.value = typeof t === "function" ? t(keyOrText, fallback || keyOrText) : (fallback || keyOrText);
                input.focus();
            }
        }

        async function sendMedulingoChat() {
            const input = document.getElementById("medChatInput");
            const btnSend = document.getElementById("btnMedChatSend");
            if (!input || !input.value.trim() || !activeMedQuestion) return;
            const msg = input.value.trim();
            input.value = "";

            const history = document.getElementById("medChatHistory");
            if (!history) return;

            // User bubble
            const uBubble = document.createElement("div");
            uBubble.className = "bg-emerald-950/80 p-3 rounded-xl border border-emerald-800 text-emerald-200 ml-6 text-right leading-relaxed";
            uBubble.textContent = msg;
            history.appendChild(uBubble);
            history.scrollTop = history.scrollHeight;

            // AI placeholder
            const aiBubble = document.createElement("div");
            aiBubble.className = "bg-slate-900/90 p-3 rounded-xl border border-slate-800 text-slate-200 mr-6 text-xs leading-relaxed space-y-2";
            aiBubble.innerHTML = `<span class="inline-flex items-center gap-1.5 text-slate-400 italic"><span>⏳</span> ${t("medulingo.thinking", "Přemýšlím nad odpovědí...")}</span>`;
            history.appendChild(aiBubble);
            history.scrollTop = history.scrollHeight;

            // Ovládací prvky do stavu načítání
            if (btnSend) {
                btnSend.disabled = true;
                btnSend.classList.add("opacity-50", "cursor-not-allowed");
            }
            input.disabled = true;

            const proj = activeMedQuestion.project || currentProject || "";
            const qTitle = activeMedQuestion.question?.title || "";
            const qTopic = activeMedQuestion.question?.topic || "Všeobecné";

            // Extrakce podkladů otázky pro prompt kontext
            let contextSnippets = "";
            if (Array.isArray(activeMedQuestion.subtopics) && activeMedQuestion.subtopics.length > 0) {
                const summary = activeMedQuestion.subtopics
                    .slice(0, 8)
                    .map(st => `### ${st.title}\n${(st.content || "").substring(0, 1200)}`)
                    .join("\n\n");
                if (summary) {
                    contextSnippets = `\n\n=== VÝTAH ZE STUDIJNÍHO TEXTU K OTÁZCE "${qTitle}" ===\n${summary}\n===================================================\n`;
                }
            }

            const customSystemPrompt = `Jsi špičkový lékařský asistent a klinický tutor pro studenty medicíny v aplikaci Medulingo (obor: ${qTopic}, projekt: "{PROJECT}").
Student právě prochází zkouškovou otázku: "${qTitle}".

PRAVIDLA PRO TVOJI ODPOVĚĎ:
1. Odpovídej přehledně, didakticky, odborně a přesně na úrovni státní rigorózní zkoušky v češtině.
2. Využívej poznatky a fakta z přiložených studijních textů projektu.
3. Pokud se student ptá na specifické vyšetření (např. FENO, BDT, PEF, HRCT, laboratorní markery), patofyziologii, diferenciální diagnostiku či farmakoterapii související s otázkou, vysvětli:
   - Princip vyšetření a co přesně měří/odhaluje
   - Normální a patologické referenční hodnoty (např. mezní hodnoty ppb u FENO, % u reverzibility spirometrie)
   - Klinický význam a interpretaci pro dané onemocnění (${qTitle})
   - Jak výsledek ovlivní další management a léčebnou strategii
4. Formátuj text přehledně: používej odrážky, tučné zvýraznění klíčových termínů a číselných hodnot.
${contextSnippets}`;

            const model = (document.getElementById("chatModelSelect") && document.getElementById("chatModelSelect").value)
                || getSelectedModel("geminiModelSelect", "geminiModelCustomInput")
                || "gemini-3.6-flash";

            try {
                const res = await fetch("/api/chat/completions", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        project: proj,
                        message: msg,
                        system_prompt: customSystemPrompt,
                        model: model,
                        thread_id: medChatThreadId || undefined
                    })
                });

                if (!res.ok) {
                    const errDetail = await res.text();
                    throw new Error(errDetail || `Chyba serveru (${res.status})`);
                }

                const reader = res.body.getReader();
                const decoder = new TextDecoder("utf-8");
                let fullText = "";
                let buffer = "";

                while (true) {
                    const { value, done } = await reader.read();
                    if (done) break;

                    buffer += decoder.decode(value, { stream: true });
                    const blocks = buffer.split("\n\n");
                    buffer = blocks.pop();

                    for (const block of blocks) {
                        if (!block.trim()) continue;
                        const eventMatch = block.match(/^event:\s*(\w+)/m);
                        const dataMatch = block.match(/^data:\s*(.+)$/m);

                        if (!dataMatch) continue;
                        const eventType = eventMatch ? eventMatch[1] : "message";
                        let dataObj;
                        try {
                            dataObj = JSON.parse(dataMatch[1]);
                        } catch (e) {
                            dataObj = { raw: dataMatch[1] };
                        }

                        if (dataObj && dataObj.thread_id && !medChatThreadId) {
                            medChatThreadId = dataObj.thread_id;
                        }

                        if (eventType === "token") {
                            const delta = dataObj.delta || dataObj.text || "";
                            if (delta) {
                                fullText += delta;
                                try {
                                    aiBubble.innerHTML = (typeof renderMarkdownWithKaTeX === "function" 
                                        ? renderMarkdownWithKaTeX(fullText) 
                                        : marked.parse(fullText)) + '<span class="inline-block w-1.5 h-3.5 bg-emerald-400 ml-1 animate-pulse align-middle"></span>';
                                } catch (e) {
                                    aiBubble.textContent = fullText;
                                }
                                history.scrollTop = history.scrollHeight;
                            }
                        } else if (eventType === "done") {
                            if (dataObj.full_text) fullText = dataObj.full_text;
                            if (dataObj.thread_id) medChatThreadId = dataObj.thread_id;
                            try {
                                aiBubble.innerHTML = typeof renderMarkdownWithKaTeX === "function"
                                    ? renderMarkdownWithKaTeX(fullText)
                                    : marked.parse(fullText);
                            } catch (e) {
                                aiBubble.textContent = fullText;
                            }
                            history.scrollTop = history.scrollHeight;
                        } else if (eventType === "error") {
                            const errorMsg = dataObj.error || "Chyba při generování odpovědi";
                            aiBubble.innerHTML = `<div class="p-2 rounded bg-rose-950/80 border border-rose-800 text-rose-300 font-semibold">⚠️ ${escapeHtml(errorMsg)}</div>`;
                            history.scrollTop = history.scrollHeight;
                        }
                    }
                }

                if (fullText) {
                    try {
                        aiBubble.innerHTML = typeof renderMarkdownWithKaTeX === "function"
                            ? renderMarkdownWithKaTeX(fullText)
                            : marked.parse(fullText);
                    } catch (e) {
                        aiBubble.textContent = fullText;
                    }
                } else if (!aiBubble.innerHTML || aiBubble.textContent.includes("Přemýšlím")) {
                    aiBubble.innerHTML = `<div class="p-2 rounded bg-rose-950/80 border border-rose-800 text-rose-300 font-semibold">⚠️ Asistent nevrátil žádnou odpověď. Zkuste prosím dotaz zopakovat.</div>`;
                }

            } catch (err) {
                console.error("sendMedulingoChat error:", err);
                aiBubble.innerHTML = `<div class="p-2 rounded bg-rose-950/80 border border-rose-800 text-rose-300 font-semibold">⚠️ Chyba při komunikaci s asistentem: ${escapeHtml(err.message)}</div>`;
            } finally {
                if (btnSend) {
                    btnSend.disabled = false;
                    btnSend.classList.remove("opacity-50", "cursor-not-allowed");
                }
                input.disabled = false;
                input.focus();
                history.scrollTop = history.scrollHeight;
            }
        }

        // --- KROK 5: FINÁLNÍ TEST ---
        function renderMedulingoTest() {
            if (!activeMedQuestion) return;
            const testObj = activeMedQuestion.test || {};
            medTestQuestions = testObj.questions || [];
            medTestUserAnswers = {};
            medTestEvaluated = false;

            const container = document.getElementById("medTestContainer");
            const resCard = document.getElementById("medTestResultsCard");
            if (resCard) resCard.classList.add("hidden");

            const viewer = isViewerMode();
            const btnStep5Save = document.getElementById("btnStep5SaveComplete");
            const gradeStep5Sel = document.getElementById("medStep5GradeSelect") || document.getElementById("medManualGradeSelect");
            if (btnStep5Save) {
                btnStep5Save.disabled = viewer;
                if (viewer) {
                    btnStep5Save.classList.add("opacity-50", "cursor-not-allowed");
                    btnStep5Save.title = "Režim pozorovatele: Pouze ke čtení";
                } else {
                    btnStep5Save.classList.remove("opacity-50", "cursor-not-allowed");
                    btnStep5Save.title = "";
                }
            }
            if (gradeStep5Sel) {
                gradeStep5Sel.disabled = viewer;
                if (viewer) {
                    gradeStep5Sel.classList.add("opacity-60", "cursor-not-allowed");
                    gradeStep5Sel.title = "Režim pozorovatele: Pouze ke čtení";
                } else {
                    gradeStep5Sel.classList.remove("opacity-60", "cursor-not-allowed");
                    gradeStep5Sel.title = "";
                }
            }

            if (!container) return;
            container.innerHTML = "";

            if (medTestQuestions.length === 0) {
                container.innerHTML = `
                    <div class="text-center py-12 text-slate-500 bg-slate-950 p-6 rounded-2xl border border-slate-800">
                        <span class="text-4xl block mb-2">📋</span>
                        Pro tuto otázku zatím nebyl vygenerován finální zkouškový test.
                        <div class="flex items-center justify-center gap-3 mt-4 flex-wrap">
                            ${viewer ? '' : `
                            <button onclick="medulingoTriggerPackGeneration(['test'])" class="duo-btn bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs px-5 py-2.5 rounded-xl">
                                ⚡ Vygenerovat zkouškový test (4 otázky)
                            </button>
                            `}
                            <button onclick="reloadCurrentMedulingoQuestion()" class="duo-btn bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 font-bold text-xs px-4 py-2.5 rounded-xl transition flex items-center gap-1.5 shadow-sm" title="Znovu prohledat vygenerované testy pro tuto otázku">
                                <span>🔄</span> Znovu načíst existující test
                            </button>
                        </div>
                    </div>
                `;
                return;
            }

            medTestQuestions.forEach((q, qIdx) => {
                const card = document.createElement("div");
                card.className = "bg-slate-950 p-5 rounded-2xl border border-slate-800 space-y-3 shadow-lg";

                const qText = q.question || q.text || `Otázka ${qIdx + 1}`;
                const scenarioHtml = q.scenario ? `
                    <div class="p-3.5 rounded-xl bg-slate-900/90 border border-slate-800 text-xs text-slate-300 leading-relaxed">
                        <div class="flex items-center gap-1.5 text-[11px] font-bold text-emerald-400 uppercase tracking-wider mb-1">
                            <span>🩺</span> Klinická kazuistika:
                        </div>
                        <p>${escapeHtml(q.scenario)}</p>
                    </div>
                ` : "";
                const opts = q.options || [];

                let optsHtml = "";
                opts.forEach(opt => {
                    optsHtml += `
                        <button onclick="toggleMedTestOption(${qIdx}, '${opt.id}')" id="medOptBtn-${qIdx}-${opt.id}" 
                                class="w-full text-left p-3.5 rounded-xl border border-slate-800 hover:border-slate-700 bg-slate-900/60 hover:bg-slate-900 text-xs text-slate-200 transition flex items-start gap-3 group">
                            <span id="medOptBadge-${qIdx}-${opt.id}" class="w-6 h-6 rounded-lg bg-slate-800 group-hover:bg-slate-750 text-slate-400 font-bold flex items-center justify-center flex-shrink-0 border border-slate-700 text-xs transition">${opt.id}</span>
                            <span class="flex-1 min-w-0 pt-0.5 leading-relaxed">${escapeHtml(opt.text)}</span>
                        </button>
                    `;
                });

                card.innerHTML = `
                    <div class="flex items-center justify-between gap-2 text-xs font-bold text-emerald-400 uppercase tracking-wider">
                        <span>Otázka ${qIdx + 1} z ${medTestQuestions.length}</span>
                        <span class="text-[11px] text-slate-400 font-normal normal-case flex items-center gap-1 bg-slate-900 px-2 py-0.5 rounded-md border border-slate-800">
                            <span>☑️</span> Výběr možností (může být 1 i více správných)
                        </span>
                    </div>
                    ${scenarioHtml}
                    <p class="text-sm font-bold text-white leading-snug">${escapeHtml(qText)}</p>
                    <div class="space-y-2 pt-1" id="medTestOptionsBox-${qIdx}">
                        ${optsHtml}
                    </div>
                    <div id="medTestExplanation-${qIdx}" class="hidden p-3.5 rounded-xl text-xs bg-slate-900/90 border border-slate-700 text-slate-300 leading-relaxed space-y-1.5"></div>
                `;
                container.appendChild(card);
            });

            // Tlačítko pro vyhodnocení
            const submitBtn = document.createElement("button");
            submitBtn.id = "btnSubmitMedTest";
            submitBtn.onclick = evaluateMedulingoTest;
            submitBtn.className = "duo-btn w-full bg-emerald-600 hover:bg-emerald-500 text-white font-extrabold text-sm py-3.5 rounded-2xl transition shadow-lg flex items-center justify-center gap-2 mt-4";
            submitBtn.innerHTML = `<span>🏆</span> <span>${t("medulingo.submitTestBtn", "Dokončit a vyhodnotit test")}</span>`;
            container.appendChild(submitBtn);
        }

        function toggleMedTestOption(qIdx, optId) {
            if (medTestEvaluated) return;
            if (!medTestUserAnswers[qIdx]) {
                medTestUserAnswers[qIdx] = [];
            }
            const currentList = medTestUserAnswers[qIdx];
            const foundIdx = currentList.indexOf(optId);
            if (foundIdx > -1) {
                currentList.splice(foundIdx, 1);
            } else {
                currentList.push(optId);
            }

            const q = medTestQuestions[qIdx];
            if (!q) return;

            (q.options || []).forEach(opt => {
                const btn = document.getElementById(`medOptBtn-${qIdx}-${opt.id}`);
                const badge = document.getElementById(`medOptBadge-${qIdx}-${opt.id}`);
                if (!btn) return;
                const isSelected = currentList.includes(opt.id);
                if (isSelected) {
                    btn.className = "w-full text-left p-3.5 rounded-xl border-2 border-emerald-500 bg-emerald-950/40 text-xs text-emerald-100 transition flex items-start gap-3 shadow-sm";
                    if (badge) {
                        badge.className = "w-6 h-6 rounded-lg bg-emerald-600 text-white font-bold flex items-center justify-center flex-shrink-0 border border-emerald-400 text-xs shadow";
                        badge.innerHTML = "✓";
                    }
                } else {
                    btn.className = "w-full text-left p-3.5 rounded-xl border border-slate-800 hover:border-slate-700 bg-slate-900/60 hover:bg-slate-900 text-xs text-slate-200 transition flex items-start gap-3 group";
                    if (badge) {
                        badge.className = "w-6 h-6 rounded-lg bg-slate-800 group-hover:bg-slate-750 text-slate-400 font-bold flex items-center justify-center flex-shrink-0 border border-slate-700 text-xs transition";
                        badge.textContent = opt.id;
                    }
                }
            });
        }

        function selectMedTestOption(qIdx, optId) {
            toggleMedTestOption(qIdx, optId);
        }

        async function evaluateMedulingoTest() {
            if (medTestQuestions.length === 0 || medTestEvaluated) return;

            let unansweredCount = 0;
            medTestQuestions.forEach((q, qIdx) => {
                const ans = medTestUserAnswers[qIdx] || [];
                if (ans.length === 0) unansweredCount++;
            });
            if (unansweredCount > 0) {
                if (!confirm(`U ${unansweredCount} otázek nemáte zvolenou žádnou odpověď. Opravdu si přejete test odevzdat a vyhodnotit?`)) {
                    return;
                }
            }

            medTestEvaluated = true;
            const submitBtn = document.getElementById("btnSubmitMedTest");
            if (submitBtn) {
                submitBtn.disabled = true;
                submitBtn.classList.add("opacity-50", "cursor-not-allowed");
                submitBtn.innerHTML = `<span>🔒</span> <span>Test byl vyhodnocen</span>`;
            }

            let fullyCorrectCount = 0;

            medTestQuestions.forEach((q, qIdx) => {
                const userAnsList = medTestUserAnswers[qIdx] || [];
                const userSet = new Set(userAnsList.map(String));
                const correctList = Array.isArray(q.correct_answers) ? q.correct_answers : (q.correct_answers ? [q.correct_answers] : []);
                const expectedSet = new Set(correctList.map(String));

                const isExact = (expectedSet.size > 0) && (expectedSet.size === userSet.size) && [...expectedSet].every(x => userSet.has(x));
                if (isExact) {
                    fullyCorrectCount++;
                }

                // Obarvení všech možností
                (q.options || []).forEach(opt => {
                    const btn = document.getElementById(`medOptBtn-${qIdx}-${opt.id}`);
                    const badge = document.getElementById(`medOptBadge-${qIdx}-${opt.id}`);
                    if (!btn) return;
                    btn.disabled = true;

                    const isChosen = userSet.has(opt.id);
                    const isRight = expectedSet.has(opt.id);

                    if (isRight && isChosen) {
                        btn.className = "w-full text-left p-3.5 rounded-xl border-2 border-emerald-500 bg-emerald-950/80 text-xs text-emerald-100 font-bold flex items-start gap-3 shadow";
                        if (badge) {
                            badge.className = "w-6 h-6 rounded-lg bg-emerald-500 text-slate-950 font-black flex items-center justify-center flex-shrink-0 text-xs";
                            badge.innerHTML = "✓";
                        }
                    } else if (isRight && !isChosen) {
                        btn.className = "w-full text-left p-3.5 rounded-xl border-2 border-dashed border-emerald-400 bg-emerald-950/30 text-xs text-emerald-200 font-semibold flex items-start gap-3";
                        if (badge) {
                            badge.className = "w-6 h-6 rounded-lg bg-emerald-900/90 text-emerald-300 border border-emerald-400 font-black flex items-center justify-center flex-shrink-0 text-xs";
                            badge.innerHTML = "✓";
                        }
                    } else if (!isRight && isChosen) {
                        btn.className = "w-full text-left p-3.5 rounded-xl border-2 border-rose-500 bg-rose-950/80 text-xs text-rose-200 font-bold flex items-start gap-3 shadow";
                        if (badge) {
                            badge.className = "w-6 h-6 rounded-lg bg-rose-600 text-white font-black flex items-center justify-center flex-shrink-0 text-xs";
                            badge.innerHTML = "✗";
                        }
                    } else {
                        btn.className = "w-full text-left p-3.5 rounded-xl border border-slate-800/80 bg-slate-900/30 text-xs text-slate-500 opacity-60 flex items-start gap-3";
                        if (badge) {
                            badge.className = "w-6 h-6 rounded-lg bg-slate-800 text-slate-500 font-bold flex items-center justify-center flex-shrink-0 border border-slate-700 text-xs";
                            badge.textContent = opt.id;
                        }
                    }
                });

                // Zobrazení vysvětlení
                const expBox = document.getElementById(`medTestExplanation-${qIdx}`);
                if (expBox) {
                    expBox.classList.remove("hidden");
                    const statusBadge = isExact 
                        ? `<span class="inline-flex items-center gap-1 text-[11px] font-bold text-emerald-400 bg-emerald-950/90 px-2.5 py-0.5 rounded-full border border-emerald-800">✅ Správně vyřešeno</span>`
                        : `<span class="inline-flex items-center gap-1 text-[11px] font-bold text-rose-400 bg-rose-950/90 px-2.5 py-0.5 rounded-full border border-rose-800">❌ Nesprávně</span>`;

                    const correctStr = correctList.join(", ");
                    const userStr = userAnsList.length > 0 ? userAnsList.join(", ") : "žádná možnost";

                    expBox.innerHTML = `
                        <div class="flex items-center justify-between pb-1.5 border-b border-slate-800 text-xs">
                            ${statusBadge}
                            <span class="text-slate-400">Správně: <strong class="text-emerald-400 font-bold">${escapeHtml(correctStr)}</strong> &bull; Vaše volba: <span class="font-mono text-slate-300 font-bold">${escapeHtml(userStr)}</span></span>
                        </div>
                        <div class="text-xs text-slate-300 leading-relaxed pt-1">
                            <strong class="text-white">Klinický rozbor:</strong> ${escapeHtml(q.explanation || q.model_answer || 'Vysvětlení není k dispozici.')}
                        </div>
                        ${q.source_ref ? `<div class="text-[11px] text-emerald-400/80 pt-1 font-mono">Zdroj: ${escapeHtml(q.source_ref)}</div>` : ''}
                    `;
                }
            });

            const pct = Math.round((fullyCorrectCount / medTestQuestions.length) * 100);
            let grade = "A";
            if (pct < 50) grade = "D";
            else if (pct < 70) grade = "C";
            else if (pct < 85) grade = "B";

            // Zobrazení výsledkové karty
            const resCard = document.getElementById("medTestResultsCard");
            const gradeEl = document.getElementById("medTestFinalGrade");
            const scoreEl = document.getElementById("medTestFinalScoreText");

            if (resCard) {
                resCard.classList.remove("hidden");
                if (gradeEl) gradeEl.textContent = `Známka: ${grade}`;
                if (scoreEl) scoreEl.textContent = `Úspěšnost: ${fullyCorrectCount} z ${medTestQuestions.length} plně správně (${pct}%)`;
                resCard.scrollIntoView({ behavior: "smooth" });
            }

            // Automatický zápis do plánovače na serveru
            if (activeMedQuestion && activeMedQuestion.question) {
                if (isViewerMode()) {
                    appendConsoleLog(`👁️ [Medulingo] Test dokončen (známka ${grade}) v režimu pozorovatele. Stav otázky v plánovači nebyl změněn.`);
                } else {
                    try {
                        const res = await fetch("/api/medulingo/complete", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({
                                project: currentProject,
                                question_id: activeMedQuestion.question.id,
                                grade: grade,
                                completed: true
                            })
                        });

                        if (!res.ok) {
                            const errData = await res.json().catch(() => ({}));
                            throw new Error(errData.detail || "Chyba při ukládání splnění testu.");
                        }

                        if (!activeMedQuestion.status) activeMedQuestion.status = {};
                        activeMedQuestion.status.is_completed = true;
                        activeMedQuestion.status.grade = grade;
                        const q = activeMedQuestion.question;
                        q.completedDate = getLocalDateString();
                        q.grade = grade;

                        const projQ = questions.find(item => item.id === q.id || item.title === q.title);
                        if (projQ) {
                            projQ.completedDate = q.completedDate;
                            projQ.grade = grade;
                            saveProjectQuestions(false);
                        }

                        renderMedulingoModalHeader();
                        appendConsoleLog(`🏆 [Medulingo] Otázka '${activeMedQuestion.question.title}' zapsána jako splněná (${grade})!`);
                    } catch (e) {
                        console.error("Complete save error:", e);
                    }
                }
            }
        }

        async function medulingoProceedNextQuestion() {
            closeMedulingoModal();
            await loadMedulingo(true);
            if (medulingoData && medulingoData.buffer && medulingoData.buffer.suggested_question_id) {
                openMedulingoQuestion(medulingoData.buffer.suggested_question_id);
            }
        }

        // --- ON-DEMAND GENEROVÁNÍ PRO AKTIVNÍ OTÁZKU ---
        async function medulingoTriggerPackGeneration(customModules = null) {
            if (!activeMedQuestion || !activeMedQuestion.question) return;
            if (isViewerMode()) {
                showGlobalToast(t("toast.viewerRestrictedQuestion", "👁️ Režim pozorovatele: Nemáte oprávnění generovat podklady."), "warning");
                return;
            }
            const q = activeMedQuestion.question;
            const btn = document.getElementById("btnMedModalGenerate");

            const modules = customModules || ["notes", "cards", "podcast", "test"];

            if (btn) {
                btn.disabled = true;
                btn.innerHTML = `<span class="animate-spin inline-block">⏳</span> Generuji (${modules.length} modulů)...`;
            }

            appendConsoleLog(`🦉 [Medulingo] Spouštím on-demand generování pro '${q.title}'...`);

            try {
                const res = await fetch("/api/medulingo/generate-pack", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        project: currentProject,
                        question_id: q.id,
                        question_title: q.title,
                        modules: modules,
                        gemini_model: "gemini-3.6-flash",
                        tts_provider: "openai",
                        tts_voice: "onyx"
                    })
                });

                const data = await res.json();
                if (!res.ok) throw new Error(data.detail || "Chyba generování.");

                const failedModules = [];
                if (data.results) {
                    for (const mod in data.results) {
                        if (data.results[mod].status === "error") {
                            failedModules.push(mod);
                            appendConsoleLog(`⚠️ [Medulingo] Chyba v modulu ${mod}: ${data.results[mod].error}`);
                        }
                    }
                }

                if (failedModules.length > 0) {
                    appendConsoleLog(`⚠️ [Medulingo] Obsah pro '${q.title}' byl vygenerován částečně s chybami (selhalo: ${failedModules.join(", ")}).`);
                } else {
                    appendConsoleLog(`🎉 [Medulingo] Obsah pro '${q.title}' byl úspěšně vygenerován!`);
                }

                // Obnovíme data aktivní otázky
                if (data.question_details) {
                    activeMedQuestion = data.question_details;
                    renderMedulingoModalHeader();
                    renderMedulingoSubtopics();
                    renderMedulingoPodcast();
                    renderMedulingoCards();
                    renderMedulingoTest();
                }

                // Aktualizujeme i přehled na pozadí
                loadMedulingo(false);

            } catch (err) {
                console.error("Pack generation error:", err);
                alert("Chyba při generování: " + err.message);
            } finally {
                if (btn) {
                    btn.disabled = false;
                    btn.innerHTML = `<span>⚡</span> Vygenerovat chybějící obsah`;
                }
            }
        }

        // --- PUFROVACÍ RYCHLÉ GENEROVÁNÍ Z BANNERU ---
        async function medulingoQuickGenerateNext() {
            if (!medulingoData || !medulingoData.buffer) return;
            const qId = medulingoData.buffer.suggested_question_id;
            const qTitle = medulingoData.buffer.suggested_question_title;
            if (!qId) {
                alert(t("medulingo.allQuestionsReady", "Všechny otázky již mají vygenerovaný obsah!"));
                return;
            }

            const btn = document.getElementById("btnMedulingoQuickGen");
            if (btn) {
                btn.disabled = true;
                btn.innerHTML = `<span class="animate-spin inline-block">⏳</span> Generuji '${qTitle}'...`;
            }

            try {
                const res = await fetch("/api/medulingo/generate-pack", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        project: currentProject,
                        question_id: qId,
                        question_title: qTitle,
                        modules: ["notes", "cards", "podcast", "test"],
                        gemini_model: "gemini-3.6-flash",
                        tts_provider: "openai",
                        tts_voice: "onyx"
                    })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.detail || "Chyba generování.");
                appendConsoleLog(`🎉 [Medulingo] Otázka '${qTitle}' je připravena!`);
                await loadMedulingo(true);
            } catch (err) {
                alert("Chyba generování: " + err.message);
            } finally {
                if (btn) {
                    btn.disabled = false;
                    btn.innerHTML = `<span>⚡</span> Vygenerovat další otázku`;
                }
            }
        }

        async function medulingoBatchGenerateNext(count = 3) {
            if (!medulingoData || !medulingoData.all_questions) return;
            const unready = medulingoData.all_questions.filter(q => !q.is_completed && !q.is_ready).slice(0, count);

            if (unready.length === 0) {
                alert(t("medulingo.enoughQuestionsReady", "Máte již dostatek připravených otázek dopředu!"));
                return;
            }

            if (!confirm(`Opravdu chcete na pozadí vygenerovat kompletní obsah pro příštích ${unready.length} otázek?\n\n${unready.map(q => '• ' + q.title).join('\n')}`)) {
                return;
            }

            appendConsoleLog(`📦 [Medulingo] Zahajuji dávkovou přípravu ${unready.length} otázek dopředu...`);

            for (let i = 0; i < unready.length; i++) {
                const q = unready[i];
                appendConsoleLog(`📦 [Medulingo] (${i + 1}/${unready.length}) Připravuji '${q.title}'...`);
                try {
                    await fetch("/api/medulingo/generate-pack", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            project: currentProject,
                            question_id: q.id,
                            question_title: q.title,
                            modules: ["notes", "cards", "podcast", "test"],
                            gemini_model: "gemini-3.6-flash",
                            tts_provider: "openai",
                            tts_voice: "onyx"
                        })
                    });
                } catch (e) {
                    console.error("Batch gen item error:", e);
                }
            }

            appendConsoleLog(`🎉 [Medulingo] Dávková příprava dokončena!`);
            await loadMedulingo(true);
        }

        // =========================================================================
        // 🍅 MODUL POMODORO: ČASOVAČ SOUSTŘEDĚNÍ & MEDULINGO INTEGRACE
        // =========================================================================

        const POMODORO_STORAGE_KEY_SETTINGS = "medstudio_pomodoro_settings";
        const POMODORO_STORAGE_KEY_STATS = "medstudio_pomodoro_stats";
        const POMODORO_STORAGE_KEY_STATE = "medstudio_pomodoro_state";

        let pomodoroSettings = {
            workMinutes: 25,
            shortBreakMinutes: 5,
            longBreakMinutes: 15,
            longBreakInterval: 4,
            soundEnabled: true,
            showInMedulingo: true,
            showMiniWidget: true,
            autoStartBreak: false,
            autoStartWork: false
        };

        let pomodoroState = {
            mode: "work", // "work" | "short_break" | "long_break"
            timeLeft: 25 * 60,
            totalDuration: 25 * 60,
            isRunning: false,
            currentCycle: 1,
            activeQuestionId: "",
            activeQuestionTitle: "",
            activeTaskTitle: "Volné studium",
            lastTickTimestamp: null
        };

        let pomodoroStats = {
            date: new Date().toISOString().slice(0, 10),
            completedPomodoros: 0,
            totalWorkSeconds: 0
        };

        let pomodoroTimerInterval = null;

        function initPomodoro() {
            loadPomodoroSettings();
            loadPomodoroStats();
            loadPomodoroState();

            updatePomodoroUI();
            updatePomodoroSettingsUI();
            updatePomodoroHeaderWidget();
            updateMedulingoPomodoroBar();

            if (pomodoroState.isRunning) {
                resumePomodoroTimer();
            }
        }

        function loadPomodoroSettings() {
            try {
                const raw = localStorage.getItem(POMODORO_STORAGE_KEY_SETTINGS);
                if (raw) {
                    const parsed = JSON.parse(raw);
                    pomodoroSettings = { ...pomodoroSettings, ...parsed };
                }
            } catch (e) {
                console.warn("Chyba při čtení pomodoroSettings z localStorage:", e);
            }
        }

        function savePomodoroSettings() {
            try {
                localStorage.setItem(POMODORO_STORAGE_KEY_SETTINGS, JSON.stringify(pomodoroSettings));
            } catch (e) {
                console.warn("Chyba při ukládání pomodoroSettings:", e);
            }
        }

        function syncPomodoroSettingsToModal(backendSettings) {
            if (backendSettings && typeof backendSettings === "object") {
                if (backendSettings.work_duration) pomodoroSettings.workMinutes = parseInt(backendSettings.work_duration);
                if (backendSettings.short_break) pomodoroSettings.shortBreakMinutes = parseInt(backendSettings.short_break);
                if (backendSettings.long_break) pomodoroSettings.longBreakMinutes = parseInt(backendSettings.long_break);
                if (typeof backendSettings.sound_enabled === "boolean") pomodoroSettings.soundEnabled = backendSettings.sound_enabled;
                if (typeof backendSettings.show_in_medulingo === "boolean") pomodoroSettings.showInMedulingo = backendSettings.show_in_medulingo;
                if (typeof backendSettings.show_mini_widget === "boolean") pomodoroSettings.showMiniWidget = backendSettings.show_mini_widget;
                savePomodoroSettings();
            }

            const miniCheck = document.getElementById("settingsPomoMiniWidget");
            const meduCheck = document.getElementById("settingsPomoInMedulingo");
            const soundCheck = document.getElementById("settingsPomoSound");
            const wInput = document.getElementById("settingsPomoWorkMin");
            const sInput = document.getElementById("settingsPomoShortMin");
            const lInput = document.getElementById("settingsPomoLongMin");

            if (miniCheck) miniCheck.checked = Boolean(pomodoroSettings.showMiniWidget);
            if (meduCheck) meduCheck.checked = Boolean(pomodoroSettings.showInMedulingo);
            if (soundCheck) soundCheck.checked = Boolean(pomodoroSettings.soundEnabled);
            if (wInput) wInput.value = pomodoroSettings.workMinutes;
            if (sInput) sInput.value = pomodoroSettings.shortBreakMinutes;
            if (lInput) lInput.value = pomodoroSettings.longBreakMinutes;
        }

        function savePomodoroSettingsFromModal() {
            const miniCheck = document.getElementById("settingsPomoMiniWidget");
            const meduCheck = document.getElementById("settingsPomoInMedulingo");
            const soundCheck = document.getElementById("settingsPomoSound");
            const wInput = document.getElementById("settingsPomoWorkMin");
            const sInput = document.getElementById("settingsPomoShortMin");
            const lInput = document.getElementById("settingsPomoLongMin");

            if (miniCheck) pomodoroSettings.showMiniWidget = miniCheck.checked;
            if (meduCheck) pomodoroSettings.showInMedulingo = meduCheck.checked;
            if (soundCheck) pomodoroSettings.soundEnabled = soundCheck.checked;
            if (wInput && parseInt(wInput.value) > 0) pomodoroSettings.workMinutes = parseInt(wInput.value);
            if (sInput && parseInt(sInput.value) > 0) pomodoroSettings.shortBreakMinutes = parseInt(sInput.value);
            if (lInput && parseInt(lInput.value) > 0) pomodoroSettings.longBreakMinutes = parseInt(lInput.value);

            savePomodoroSettings();
            updatePomodoroSettingsUI();
            updatePomodoroUI();
            updatePomodoroHeaderWidget();
            updateMedulingoPomodoroBar();

            return {
                work_duration: pomodoroSettings.workMinutes,
                short_break: pomodoroSettings.shortBreakMinutes,
                long_break: pomodoroSettings.longBreakMinutes,
                sound_enabled: pomodoroSettings.soundEnabled,
                show_in_medulingo: pomodoroSettings.showInMedulingo,
                show_mini_widget: pomodoroSettings.showMiniWidget
            };
        }

        function loadPomodoroStats() {
            try {
                const today = new Date().toISOString().slice(0, 10);
                const raw = localStorage.getItem(POMODORO_STORAGE_KEY_STATS);
                if (raw) {
                    const parsed = JSON.parse(raw);
                    if (parsed.date === today) {
                        pomodoroStats = parsed;
                        return;
                    }
                }
                pomodoroStats = {
                    date: today,
                    completedPomodoros: 0,
                    totalWorkSeconds: 0
                };
                savePomodoroStats();
            } catch (e) {
                console.warn("Chyba při čtení pomodoroStats:", e);
            }
        }

        function savePomodoroStats() {
            try {
                localStorage.setItem(POMODORO_STORAGE_KEY_STATS, JSON.stringify(pomodoroStats));
            } catch (e) {
                console.warn("Chyba při ukládání pomodoroStats:", e);
            }
        }

        function resetPomodoroDailyStats() {
            if (!confirm(t("pomodoro.confirmResetStats", "Opravdu chcete vynulovat dnešní statistiku dokončených pomodor?"))) return;
            pomodoroStats.completedPomodoros = 0;
            pomodoroStats.totalWorkSeconds = 0;
            savePomodoroStats();
            updatePomodoroUI();
        }

        function loadPomodoroState() {
            try {
                const raw = localStorage.getItem(POMODORO_STORAGE_KEY_STATE);
                if (raw) {
                    const parsed = JSON.parse(raw);
                    pomodoroState = { ...pomodoroState, ...parsed };
                } else {
                    pomodoroState.timeLeft = pomodoroSettings.workMinutes * 60;
                    pomodoroState.totalDuration = pomodoroSettings.workMinutes * 60;
                }
            } catch (e) {
                console.warn("Chyba při čtení pomodoroState:", e);
            }
        }

        function savePomodoroState() {
            try {
                localStorage.setItem(POMODORO_STORAGE_KEY_STATE, JSON.stringify(pomodoroState));
            } catch (e) {
                console.warn("Chyba při ukládání pomodoroState:", e);
            }
        }

        function startPomodoro() {
            if (pomodoroState.timeLeft <= 0) {
                resetPomodoro();
            }
            pomodoroState.isRunning = true;
            pomodoroState.lastTickTimestamp = Date.now();
            if (pomodoroTimerInterval) clearInterval(pomodoroTimerInterval);
            pomodoroTimerInterval = setInterval(tickPomodoro, 1000);
            savePomodoroState();
            updatePomodoroUI();
        }

        function pausePomodoro() {
            pomodoroState.isRunning = false;
            pomodoroState.lastTickTimestamp = null;
            if (pomodoroTimerInterval) {
                clearInterval(pomodoroTimerInterval);
                pomodoroTimerInterval = null;
            }
            savePomodoroState();
            updatePomodoroUI();
        }

        function togglePomodoroPlayPause() {
            if (pomodoroState.isRunning) {
                pausePomodoro();
            } else {
                startPomodoro();
            }
        }

        function resumePomodoroTimer() {
            const now = Date.now();
            if (pomodoroState.lastTickTimestamp) {
                const elapsedSeconds = Math.floor((now - pomodoroState.lastTickTimestamp) / 1000);
                if (elapsedSeconds > 0) {
                    pomodoroState.timeLeft = Math.max(0, pomodoroState.timeLeft - elapsedSeconds);
                    if (pomodoroState.mode === "work") {
                        pomodoroStats.totalWorkSeconds += elapsedSeconds;
                        savePomodoroStats();
                    }
                }
            }
            if (pomodoroState.timeLeft <= 0) {
                onPomodoroPhaseComplete();
            } else {
                pomodoroState.lastTickTimestamp = now;
                if (pomodoroTimerInterval) clearInterval(pomodoroTimerInterval);
                pomodoroTimerInterval = setInterval(tickPomodoro, 1000);
                updatePomodoroUI();
            }
        }

        function resetPomodoro() {
            pausePomodoro();
            let durationMin = pomodoroSettings.workMinutes;
            if (pomodoroState.mode === "short_break") durationMin = pomodoroSettings.shortBreakMinutes;
            else if (pomodoroState.mode === "long_break") durationMin = pomodoroSettings.longBreakMinutes;

            pomodoroState.totalDuration = durationMin * 60;
            pomodoroState.timeLeft = durationMin * 60;
            savePomodoroState();
            updatePomodoroUI();
        }

        function switchPomodoroMode(mode, autoStart = false) {
            pausePomodoro();
            pomodoroState.mode = mode;
            let durationMin = pomodoroSettings.workMinutes;
            if (mode === "short_break") durationMin = pomodoroSettings.shortBreakMinutes;
            else if (mode === "long_break") durationMin = pomodoroSettings.longBreakMinutes;

            pomodoroState.totalDuration = durationMin * 60;
            pomodoroState.timeLeft = durationMin * 60;
            savePomodoroState();
            updatePomodoroUI();

            if (autoStart) {
                startPomodoro();
            }
        }

        function skipPomodoroPhase() {
            if (pomodoroState.mode === "work") {
                if (pomodoroState.currentCycle >= pomodoroSettings.longBreakInterval) {
                    switchPomodoroMode("long_break");
                } else {
                    switchPomodoroMode("short_break");
                }
            } else {
                if (pomodoroState.mode === "long_break") {
                    pomodoroState.currentCycle = 1;
                } else {
                    pomodoroState.currentCycle = Math.min(pomodoroSettings.longBreakInterval, pomodoroState.currentCycle + 1);
                }
                switchPomodoroMode("work");
            }
        }

        function tickPomodoro() {
            const now = Date.now();
            const last = pomodoroState.lastTickTimestamp || now;
            const delta = Math.floor((now - last) / 1000);

            if (delta >= 1) {
                pomodoroState.lastTickTimestamp = now;
                pomodoroState.timeLeft = Math.max(0, pomodoroState.timeLeft - delta);

                if (pomodoroState.mode === "work") {
                    pomodoroStats.totalWorkSeconds += delta;
                    savePomodoroStats();
                }

                savePomodoroState();
                updatePomodoroUI();

                if (pomodoroState.timeLeft <= 0) {
                    onPomodoroPhaseComplete();
                }
            }
        }

        function onPomodoroPhaseComplete() {
            pausePomodoro();

            if (pomodoroState.mode === "work") {
                pomodoroStats.completedPomodoros += 1;
                savePomodoroStats();
                playPomodoroChime("work_end");

                const isLong = pomodoroState.currentCycle >= pomodoroSettings.longBreakInterval;
                const nextMode = isLong ? "long_break" : "short_break";

                openPomodoroCompleteModal("work", isLong);

                if (pomodoroSettings.autoStartBreak) {
                    setTimeout(() => {
                        closePomodoroCompleteModal();
                        switchPomodoroMode(nextMode, true);
                    }, 1200);
                }
            } else {
                playPomodoroChime("break_end");
                if (pomodoroState.mode === "long_break") {
                    pomodoroState.currentCycle = 1;
                } else {
                    pomodoroState.currentCycle = Math.min(pomodoroSettings.longBreakInterval, pomodoroState.currentCycle + 1);
                }

                openPomodoroCompleteModal("break");

                if (pomodoroSettings.autoStartWork) {
                    setTimeout(() => {
                        closePomodoroCompleteModal();
                        switchPomodoroMode("work", true);
                    }, 1200);
                }
            }
        }

        function playPomodoroChime(type = "work_end") {
            if (!pomodoroSettings.soundEnabled) return;
            try {
                const AudioCtx = window.AudioContext || window.webkitAudioContext;
                if (!AudioCtx) return;
                const ctx = new AudioCtx();

                if (type === "work_end") {
                    const notes = [523.25, 659.25, 783.99, 1046.50];
                    notes.forEach((freq, idx) => {
                        const osc = ctx.createOscillator();
                        const gain = ctx.createGain();
                        osc.type = "sine";
                        osc.frequency.setValueAtTime(freq, ctx.currentTime + idx * 0.16);
                        gain.gain.setValueAtTime(0, ctx.currentTime + idx * 0.16);
                        gain.gain.linearRampToValueAtTime(0.2, ctx.currentTime + idx * 0.16 + 0.04);
                        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + idx * 0.16 + 0.7);
                        osc.connect(gain);
                        gain.connect(ctx.destination);
                        osc.start(ctx.currentTime + idx * 0.16);
                        osc.stop(ctx.currentTime + idx * 0.16 + 0.75);
                    });
                } else {
                    const notes = [880.00, 739.99, 587.33];
                    notes.forEach((freq, idx) => {
                        const osc = ctx.createOscillator();
                        const gain = ctx.createGain();
                        osc.type = "triangle";
                        osc.frequency.setValueAtTime(freq, ctx.currentTime + idx * 0.18);
                        gain.gain.setValueAtTime(0, ctx.currentTime + idx * 0.18);
                        gain.gain.linearRampToValueAtTime(0.22, ctx.currentTime + idx * 0.18 + 0.03);
                        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + idx * 0.18 + 0.8);
                        osc.connect(gain);
                        gain.connect(ctx.destination);
                        osc.start(ctx.currentTime + idx * 0.18);
                        osc.stop(ctx.currentTime + idx * 0.18 + 0.85);
                    });
                }
            } catch (e) {
                console.warn("Chyba při přehrávání Pomodoro zvuku:", e);
            }
        }

        function playPomodoroSoundPreview() {
            playPomodoroChime("work_end");
            setTimeout(() => {
                playPomodoroChime("break_end");
            }, 850);
            if (typeof appendConsoleLog === "function") {
                appendConsoleLog("🔔 [Pomodoro] Zvukové tóny otestovány (Web Audio API).");
            }
        }

        function formatPomodoroTime(seconds) {
            const m = Math.floor(seconds / 60);
            const s = seconds % 60;
            return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
        }

        function updatePomodoroUI() {
            const timeStr = formatPomodoroTime(pomodoroState.timeLeft);

            // 1. Zobrazení v modulu Pomodoro
            const displayEl = document.getElementById("pomoTimeDisplay");
            if (displayEl) displayEl.textContent = timeStr;

            const taskEl = document.getElementById("pomoActiveTaskDisplay");
            if (taskEl) taskEl.textContent = pomodoroState.activeTaskTitle || "Volné studium";

            // SVG kruh postupu (obvod r=100 je ~628.3)
            const ring = document.getElementById("pomoProgressRing");
            if (ring) {
                const total = pomodoroState.totalDuration || 1;
                const ratio = Math.max(0, Math.min(1, pomodoroState.timeLeft / total));
                const circumference = 628.318;
                const offset = circumference * (1 - ratio);
                ring.style.strokeDashoffset = offset;

                if (pomodoroState.mode === "work") {
                    ring.className = "text-rose-500 fill-none transition-all duration-1000 ease-linear drop-shadow-[0_0_8px_rgba(244,63,94,0.5)]";
                } else if (pomodoroState.mode === "short_break") {
                    ring.className = "text-emerald-400 fill-none transition-all duration-1000 ease-linear drop-shadow-[0_0_8px_rgba(52,211,153,0.5)]";
                } else {
                    ring.className = "text-sky-400 fill-none transition-all duration-1000 ease-linear drop-shadow-[0_0_8px_rgba(56,189,248,0.5)]";
                }
            }

            // Tlačítko start/pause v modulu
            const mainActionText = document.getElementById("pomoMainActionText");
            const mainActionIcon = document.getElementById("pomoMainActionIcon");
            const mainActionBtn = document.getElementById("btnPomoMainAction");
            if (mainActionText && mainActionIcon) {
                if (pomodoroState.isRunning) {
                    mainActionIcon.textContent = "⏸️";
                    mainActionText.textContent = "Pozastavit";
                    if (mainActionBtn) {
                        mainActionBtn.className = "h-12 px-7 rounded-xl bg-gradient-to-r from-amber-600 to-amber-500 hover:from-amber-500 hover:to-amber-400 text-white font-black text-sm shadow-xl shadow-amber-950/60 transition transform active:scale-95 flex items-center gap-2";
                    }
                } else {
                    mainActionIcon.textContent = "▶️";
                    mainActionText.textContent = pomodoroState.mode === "work" ? t("pomodoro.startFocus", "Spustit soustředění") : t("pomodoro.startBreak", "Spustit přestávku");
                    if (mainActionBtn) {
                        mainActionBtn.className = pomodoroState.mode === "work"
                            ? "h-12 px-7 rounded-xl bg-gradient-to-r from-rose-600 to-rose-500 hover:from-rose-500 hover:to-rose-400 text-white font-black text-sm shadow-xl shadow-rose-950/60 transition transform active:scale-95 flex items-center gap-2"
                            : "h-12 px-7 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-500 hover:from-emerald-500 hover:to-teal-400 text-white font-black text-sm shadow-xl shadow-emerald-950/60 transition transform active:scale-95 flex items-center gap-2";
                    }
                }
            }

            // Tlačítka fází
            ["work", "short_break", "long_break"].forEach(m => {
                const btn = document.getElementById(`pomoModeBtn-${m}`);
                if (!btn) return;
                if (pomodoroState.mode === m) {
                    btn.className = m === "work"
                        ? "px-3.5 py-1.5 rounded-lg bg-rose-600 text-white font-bold transition shadow flex items-center gap-1.5"
                        : "px-3.5 py-1.5 rounded-lg bg-emerald-600 text-white font-bold transition shadow flex items-center gap-1.5";
                } else {
                    btn.className = "px-3.5 py-1.5 rounded-lg text-slate-400 hover:text-white transition flex items-center gap-1.5";
                }
            });

            // Fázový štítek
            const phaseBadge = document.getElementById("pomoPhaseBadge");
            const phaseBadgeText = document.getElementById("pomoPhaseBadgeText");
            if (phaseBadge && phaseBadgeText) {
                if (pomodoroState.mode === "work") {
                    phaseBadgeText.textContent = t("pomodoro.deepFocusPhase", "Hluboké soustředění");
                    phaseBadge.className = "text-xs uppercase font-extrabold px-3.5 py-1.5 rounded-full bg-rose-950 border border-rose-600/60 text-rose-300 shadow-md flex items-center gap-2";
                } else if (pomodoroState.mode === "short_break") {
                    phaseBadgeText.textContent = t("pomodoro.shortBreakPhase", "Krátká regenerace (5 min)");
                    phaseBadge.className = "text-xs uppercase font-extrabold px-3.5 py-1.5 rounded-full bg-emerald-950 border border-emerald-600/60 text-emerald-300 shadow-md flex items-center gap-2";
                } else {
                    phaseBadgeText.textContent = t("pomodoro.longBreakPhase", "Dlouhá regenerace (15 min)");
                    phaseBadge.className = "text-xs uppercase font-extrabold px-3.5 py-1.5 rounded-full bg-sky-950 border border-sky-600/60 text-sky-300 shadow-md flex items-center gap-2";
                }
            }

            // Indikátor cyklů (rajčata)
            const cycleDots = document.getElementById("pomoCycleDots");
            if (cycleDots) {
                let html = "";
                const totalCycles = pomodoroSettings.longBreakInterval || 4;
                for (let i = 1; i <= totalCycles; i++) {
                    const isDoneOrActive = i <= pomodoroState.currentCycle;
                    html += `<span title="Blok ${i}" class="${isDoneOrActive ? 'scale-110 drop-shadow' : 'opacity-25'} transition-all text-base">🍅</span>`;
                }
                cycleDots.innerHTML = html;
            }

            // Dnešní statistiky
            const statCompleted = document.getElementById("pomoStatCompletedVal");
            if (statCompleted) statCompleted.textContent = `${pomodoroStats.completedPomodoros} ${pomodoroStats.completedPomodoros === 1 ? 'blok' : pomodoroStats.completedPomodoros < 5 ? 'bloky' : 'bloků'}`;

            const statFocusTime = document.getElementById("pomoStatFocusTimeVal");
            if (statFocusTime) {
                const totalMins = Math.round(pomodoroStats.totalWorkSeconds / 60);
                const h = Math.floor(totalMins / 60);
                const m = totalMins % 60;
                statFocusTime.textContent = h > 0 ? `${h}h ${m}m` : `${m} min`;
            }

            const statGoal = document.getElementById("pomoStatGoalVal");
            if (statGoal) {
                const pct = Math.min(100, Math.round((pomodoroStats.completedPomodoros / 4) * 100));
                statGoal.textContent = `${pomodoroStats.completedPomodoros} / 4 (${pct}%)`;
            }

            const statCycle = document.getElementById("pomoStatCycleVal");
            if (statCycle) {
                statCycle.textContent = `${pomodoroState.currentCycle}. ze ${pomodoroSettings.longBreakInterval}`;
            }

            // 2. Mini-časovač v horní liště aplikace
            updatePomodoroHeaderWidget();

            // 3. Mini-časovač v Medulingo (jak v přehledu, tak v modalu otázky)
            updateMedulingoModalPomodoro();
            updateMedulingoPomodoroBar();

            // 4. Homescreen card text
            const homePomoStatus = document.getElementById("homePomodoroStatusText");
            if (homePomoStatus) {
                if (pomodoroState.isRunning) {
                    homePomoStatus.textContent = `Aktivní: ${timeStr} 🍅`;
                } else if (pomodoroStats.completedPomodoros > 0) {
                    homePomoStatus.textContent = `Dnes: ${pomodoroStats.completedPomodoros} 🍅 (${timeStr})`;
                } else {
                    homePomoStatus.textContent = `Spustit časovač (25m)`;
                }
            }
        }

        function updatePomodoroHeaderWidget() {
            const widget = document.getElementById("headerPomodoroWidget");
            const timeEl = document.getElementById("headerPomodoroTime");
            const playBtn = document.getElementById("headerPomodoroPlayBtn");
            const iconEl = document.getElementById("headerPomodoroIcon");

            if (!widget) return;

            // Zobrazujeme, pokud je widget povolen v nastavení a (buď běží časovač, nebo uživatel chce widget vidět stále)
            if (pomodoroSettings.showMiniWidget) {
                widget.classList.remove("hidden");
                if (timeEl) timeEl.textContent = formatPomodoroTime(pomodoroState.timeLeft);
                if (playBtn) playBtn.textContent = pomodoroState.isRunning ? "⏸️" : "▶️";
                if (iconEl) {
                    if (pomodoroState.isRunning) iconEl.classList.add("animate-pulse");
                    else iconEl.classList.remove("animate-pulse");
                }
            } else {
                widget.classList.add("hidden");
            }
        }

        function updateMedulingoPomodoroBar() {
            const bar = document.getElementById("medulingoPomodoroBarWidget");
            const chk = document.getElementById("chkMedulingoPomodoro");
            const quickStatus = document.getElementById("medulingoPomodoroQuickStatus");

            if (chk) chk.checked = Boolean(pomodoroSettings.showInMedulingo);

            if (quickStatus) {
                const timeStr = formatPomodoroTime(pomodoroState.timeLeft);
                if (pomodoroState.isRunning) {
                    quickStatus.textContent = `${timeStr} (běží)`;
                    quickStatus.className = "font-mono text-[11px] font-bold text-rose-400 animate-pulse hidden sm:inline";
                } else {
                    quickStatus.textContent = timeStr;
                    quickStatus.className = "font-mono text-[11px] font-bold text-rose-400/80 hidden sm:inline";
                }
            }
        }

        function toggleMedulingoPomodoroPreference(enabled) {
            pomodoroSettings.showInMedulingo = Boolean(enabled);
            savePomodoroSettings();
            updateMedulingoModalPomodoro();
            updateMedulingoPomodoroBar();
            if (typeof appendConsoleLog === "function") {
                appendConsoleLog(`🍅 [Pomodoro] Asistent v Medulingo byl ${enabled ? 'aktivován' : 'vypnut'}.`);
            }
        }

        function updateMedulingoModalPomodoro() {
            const box = document.getElementById("medModalPomodoroBox");
            const timeEl = document.getElementById("medModalPomodoroTime");
            const toggleBtn = document.getElementById("btnMedModalPomodoroToggle");

            if (!box) return;

            // Pokud má uživatel Pomodoro v Medulingo vypnuté, skryjeme
            if (!pomodoroSettings.showInMedulingo) {
                box.classList.add("hidden");
                return;
            }

            box.classList.remove("hidden");
            if (timeEl) timeEl.textContent = formatPomodoroTime(pomodoroState.timeLeft);

            if (toggleBtn) {
                if (pomodoroState.isRunning) {
                    toggleBtn.textContent = "Pauza";
                    toggleBtn.className = "px-2 py-0.5 rounded bg-amber-950/80 hover:bg-amber-900 text-amber-300 hover:text-white font-semibold text-[11px] border border-amber-800/60 transition";
                } else {
                    toggleBtn.textContent = "Start";
                    toggleBtn.className = "px-2 py-0.5 rounded bg-rose-950/80 hover:bg-rose-900 text-rose-300 hover:text-white font-semibold text-[11px] border border-rose-800/60 transition";
                }
            }
        }

        function togglePomodoroForCurrentMedQuestion() {
            if (pomodoroState.isRunning) {
                pausePomodoro();
            } else {
                if (activeMedQuestion && activeMedQuestion.question) {
                    const q = activeMedQuestion.question;
                    pomodoroState.activeQuestionId = q.id || "";
                    pomodoroState.activeQuestionTitle = q.title || "";
                    pomodoroState.activeTaskTitle = `Otázka ${q.number}: ${q.title}`;

                    const sel = document.getElementById("pomodoroQuestionSelect");
                    if (sel && q.title) sel.value = q.title;

                    const custInput = document.getElementById("pomodoroCustomTaskInput");
                    if (custInput) custInput.value = "";

                    const actBox = document.getElementById("pomoQuestionActions");
                    if (actBox) actBox.classList.remove("hidden");
                }
                startPomodoro();
            }
        }

        function updatePomodoroSettingsUI() {
            const wInput = document.getElementById("pomoWorkDurationInput");
            const sInput = document.getElementById("pomoShortBreakInput");
            const lInput = document.getElementById("pomoLongBreakInput");
            const soundToggle = document.getElementById("pomoSoundToggle");
            const autoBreakToggle = document.getElementById("pomoAutoBreakToggle");
            const miniWidgetToggle = document.getElementById("pomoMiniWidgetToggle");

            if (wInput) wInput.value = pomodoroSettings.workMinutes;
            if (sInput) sInput.value = pomodoroSettings.shortBreakMinutes;
            if (lInput) lInput.value = pomodoroSettings.longBreakMinutes;
            if (soundToggle) soundToggle.checked = Boolean(pomodoroSettings.soundEnabled);
            if (autoBreakToggle) autoBreakToggle.checked = Boolean(pomodoroSettings.autoStartBreak);
            if (miniWidgetToggle) miniWidgetToggle.checked = Boolean(pomodoroSettings.showMiniWidget);
        }

        function updatePomodoroDurationsFromUI() {
            const wInput = document.getElementById("pomoWorkDurationInput");
            const sInput = document.getElementById("pomoShortBreakInput");
            const lInput = document.getElementById("pomoLongBreakInput");

            if (wInput && parseInt(wInput.value) > 0) pomodoroSettings.workMinutes = parseInt(wInput.value);
            if (sInput && parseInt(sInput.value) > 0) pomodoroSettings.shortBreakMinutes = parseInt(sInput.value);
            if (lInput && parseInt(lInput.value) > 0) pomodoroSettings.longBreakMinutes = parseInt(lInput.value);

            savePomodoroSettings();
            if (!pomodoroState.isRunning) {
                resetPomodoro();
            }
        }

        function updatePomodoroPreferencesFromUI() {
            const soundToggle = document.getElementById("pomoSoundToggle");
            const autoBreakToggle = document.getElementById("pomoAutoBreakToggle");
            const miniWidgetToggle = document.getElementById("pomoMiniWidgetToggle");

            if (soundToggle) pomodoroSettings.soundEnabled = soundToggle.checked;
            if (autoBreakToggle) pomodoroSettings.autoStartBreak = autoBreakToggle.checked;
            if (miniWidgetToggle) pomodoroSettings.showMiniWidget = miniWidgetToggle.checked;

            savePomodoroSettings();
            updatePomodoroHeaderWidget();
        }

        function onPomodoroQuestionSelectChange() {
            const sel = document.getElementById("pomodoroQuestionSelect");
            const actBox = document.getElementById("pomoQuestionActions");
            if (!sel) return;

            const val = sel.value.trim();
            if (val) {
                pomodoroState.activeQuestionTitle = val;
                pomodoroState.activeTaskTitle = val;
                if (actBox) actBox.classList.remove("hidden");
            } else {
                pomodoroState.activeQuestionTitle = "";
                pomodoroState.activeTaskTitle = "Volné studium";
                if (actBox) actBox.classList.add("hidden");
            }
            savePomodoroState();
            updatePomodoroUI();
        }

        function onPomodoroCustomTaskInput(val) {
            const sel = document.getElementById("pomodoroQuestionSelect");
            if (sel) sel.value = "";
            const actBox = document.getElementById("pomoQuestionActions");
            if (actBox) actBox.classList.add("hidden");

            pomodoroState.activeQuestionTitle = "";
            pomodoroState.activeTaskTitle = val.trim() || "Volné studium";
            savePomodoroState();
            updatePomodoroUI();
        }

        function openPomodoroInMedulingo() {
            const title = pomodoroState.activeQuestionTitle;
            if (!title) return;
            switchTab("medulingo");

            // Najít otázku v medulingoData
            if (medulingoData && medulingoData.all_questions) {
                const found = medulingoData.all_questions.find(q => q.title === title || q.title.toLowerCase().includes(title.toLowerCase()));
                if (found) {
                    openMedulingoQuestion(found.id);
                    return;
                }
            }
            // Fallback na questions
            const fIndex = questions.findIndex(q => q.title === title);
            if (fIndex >= 0) {
                openMedulingoQuestion(questions[fIndex].id || fIndex);
            }
        }

        function openPomodoroInNotes() {
            switchTab("notes");
            const sel = document.getElementById("notesQuestionSelect");
            if (sel && pomodoroState.activeQuestionTitle) {
                sel.value = pomodoroState.activeQuestionTitle;
                if (typeof onNotesQuestionSelectChange === "function") onNotesQuestionSelectChange();
            }
        }

        function openPomodoroInCards() {
            switchTab("cards");
            const sel = document.getElementById("cardsQuestionSelect");
            if (sel && pomodoroState.activeQuestionTitle) {
                sel.value = pomodoroState.activeQuestionTitle;
                if (typeof onCardsQuestionSelectChange === "function") onCardsQuestionSelectChange();
            }
        }

        function renderPomodoroView() {
            updatePomodoroUI();
            updatePomodoroSettingsUI();

            const sel = document.getElementById("pomodoroQuestionSelect");
            if (sel && pomodoroState.activeQuestionTitle) {
                sel.value = pomodoroState.activeQuestionTitle;
            }
            const actBox = document.getElementById("pomoQuestionActions");
            if (actBox) {
                if (pomodoroState.activeQuestionTitle) actBox.classList.remove("hidden");
                else actBox.classList.add("hidden");
            }
        }

        function openPomodoroCompleteModal(phaseType, isLongBreak = false) {
            const modal = document.getElementById("modalPomodoroComplete");
            if (!modal) return;

            const icon = document.getElementById("pomoCompleteIcon");
            const title = document.getElementById("pomoCompleteTitle");
            const msg = document.getElementById("pomoCompleteMsg");
            const actionText = document.getElementById("btnPomoCompleteActionText");
            const taskBox = document.getElementById("pomoCompleteTaskBox");

            if (phaseType === "work") {
                if (icon) icon.textContent = "🎉";
                if (title) title.textContent = isLongBreak ? "4 bloky hotovy! Čas na velkou pauzu!" : "Skvělá práce! 25 minut soustředění uplynulo!";
                if (msg) {
                    msg.textContent = isLongBreak
                        ? "Dokončili jste celou sérii 4 pomodorů. Dopřejte si 15 minut pořádného odpočinku pro plnou mentální regeneraci."
                        : "Dokončili jste blok soustředění. Krátká 5minutová přestávka pomůže mozku lépe upevnit paměťové stopy.";
                }
                if (actionText) actionText.textContent = isLongBreak ? "Zahájit dlouhou pauzu (15 min)" : "Zahájit krátkou pauzu (5 min)";
            } else {
                if (icon) icon.textContent = "☕";
                if (title) title.textContent = "Přestávka skončila!";
                if (msg) msg.textContent = "Jste odpočatí a připravení vrhnout se na další 25minutový blok hlubokého soustředění?";
                if (actionText) actionText.textContent = "Zahájit další blok (25 min)";
            }

            if (taskBox) {
                if (pomodoroState.activeTaskTitle && pomodoroState.activeTaskTitle !== "Volné studium") {
                    taskBox.textContent = `🎯 Cíl: ${pomodoroState.activeTaskTitle}`;
                    taskBox.classList.remove("hidden");
                } else {
                    taskBox.classList.add("hidden");
                }
            }

            modal.classList.remove("hidden");
        }

        function closePomodoroCompleteModal() {
            const modal = document.getElementById("modalPomodoroComplete");
            if (modal) modal.classList.add("hidden");
        }

        function onPomodoroModalPrimaryAction() {
            closePomodoroCompleteModal();
            if (pomodoroState.mode === "work") {
                const isLong = pomodoroState.currentCycle >= pomodoroSettings.longBreakInterval;
                switchPomodoroMode(isLong ? "long_break" : "short_break", true);
            } else {
                switchPomodoroMode("work", true);
            }
        }

        function startNewPomodoroWorkImmediately() {
            closePomodoroCompleteModal();
            switchPomodoroMode("work", true);
        }


        // --- PODCAST PLAYER MODAL ---
        function closePodcastPlayer() {
            const modal = document.getElementById("modalPodcastPlayer");
            if (modal) modal.classList.add("hidden");
            const audioEl = document.getElementById("podcastAudioElement");
            if (audioEl) audioEl.pause();
        }

        async function openPodcastPlayer(filename) {
            document.getElementById("podcastPlayerTitle").innerText = `🎙️ ${filename}`;
            const audioEl = document.getElementById("podcastAudioElement");
            const transcriptContainer = document.getElementById("podcastTranscriptContainer");
            
            transcriptContainer.innerHTML = `<div class="text-center text-slate-500 py-10">${t("podcast.loadingTranscript", "Načítám text...")}</div>`;
            
            const modal = document.getElementById("modalPodcastPlayer");
            if (modal) modal.classList.remove("hidden");
            
            audioEl.src = `/audio/${filename}`;
            audioEl.load();

            // Fetch SRT
            const srtFilename = filename.replace(/\.(mp3|mp4)$/i, '.srt');
            try {
                const res = await fetch(`/audio/${srtFilename}`);
                if (!res.ok) throw new Error("SRT nenalezeno");
                const srtText = await res.text();
                
                const cues = parseSRT(srtText);
                
                transcriptContainer.innerHTML = '';
                if (cues.length === 0) {
                     transcriptContainer.innerHTML = `<div class="text-center text-slate-500 py-10">${t("podcast.noTranscriptFound", "Žádný text nebyl nalezen.")}</div>`;
                     audioEl.ontimeupdate = null;
                     return;
                }
                
                cues.forEach((cue, index) => {
                    const span = document.createElement("span");
                    span.className = "podcast-cue cursor-pointer hover:text-emerald-300 transition inline mr-1";
                    span.dataset.start = cue.start;
                    span.dataset.end = cue.end;
                    span.innerText = cue.text + " ";
                    span.onclick = () => {
                        audioEl.currentTime = cue.start;
                        audioEl.play();
                    };
                    transcriptContainer.appendChild(span);
                });
                
                audioEl.ontimeupdate = () => {
                    const ct = audioEl.currentTime;
                    const spans = transcriptContainer.querySelectorAll('.podcast-cue');
                    let activeSpan = null;
                    
                    spans.forEach(span => {
                        const start = parseFloat(span.dataset.start);
                        const end = parseFloat(span.dataset.end);
                        if (ct >= start && ct <= end) {
                            if (!span.classList.contains('text-emerald-400')) {
                                span.classList.add('text-emerald-400', 'bg-emerald-900/40', 'rounded', 'px-0.5');
                                span.classList.remove('text-slate-400');
                                activeSpan = span;
                            }
                        } else {
                            if (span.classList.contains('text-emerald-400')) {
                                span.classList.remove('text-emerald-400', 'bg-emerald-900/40', 'rounded', 'px-0.5');
                                span.classList.add('text-slate-400');
                            }
                        }
                    });
                    
                    if (activeSpan) {
                         // Optional: auto-scroll to active span if it gets out of view
                         const containerRect = transcriptContainer.getBoundingClientRect();
                         const spanRect = activeSpan.getBoundingClientRect();
                         
                         if (spanRect.top < containerRect.top || spanRect.bottom > containerRect.bottom) {
                             activeSpan.scrollIntoView({ behavior: 'smooth', block: 'center' });
                         }
                    }
                };

            } catch(e) {
                transcriptContainer.innerHTML = '<div class="text-center text-rose-500 py-10">Nepodařilo se načíst synchronizovaný text k tomuto audiu.</div>';
                audioEl.ontimeupdate = null;
            }
        }

        function parseSRT(srt) {
            const cues = [];
            const blocks = srt.trim().split(/\n\s*\n/);
            for (let block of blocks) {
                const lines = block.split('\n');
                if (lines.length >= 3) {
                    const timeLine = lines[1];
                    const text = lines.slice(2).join(' ');
                    const match = timeLine.match(/(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})/);
                    if (match) {
                        const start = parseInt(match[1])*3600 + parseInt(match[2])*60 + parseInt(match[3]) + parseInt(match[4])/1000;
                        const end = parseInt(match[5])*3600 + parseInt(match[6])*60 + parseInt(match[7]) + parseInt(match[8])/1000;
                        cues.push({ start, end, text });
                    }
                }
            }
            return cues;
        }
