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
                        bodyHtml = renderMarkdownSafe(msg.content || "");
                    } else {
                        bodyHtml = `<p>${(msg.content || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</p>`;
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

        // Dekóduje HTML entity (např. text z výstupu marked) na prostý řetězec; textarea nespouští skripty.
        function decodeHtmlEntities(str) {
            const textarea = document.createElement("textarea");
            textarea.innerHTML = String(str);
            return textarea.value;
        }

        // Řetězec pro JS literál v '…' uvnitř inline handleru (onclick="fn('…')"): nejdřív JS, pak HTML escapování.
        function escapeJsStringAttr(str) {
            return escapeHtml(String(str).replace(/\\/g, "\\\\").replace(/'/g, "\\'"));
        }

        // HTML z markdownu (výstup AI, uživatelský text) vždy přes DOMPurify; bez knihovny fail-closed jako text.
        function sanitizeHtml(html) {
            if (typeof DOMPurify !== "undefined" && DOMPurify.sanitize) {
                return DOMPurify.sanitize(html);
            }
            console.warn("DOMPurify není načten – HTML se zobrazí jako prostý text.");
            return escapeHtml(html);
        }

        // Markdown bez KaTeX/citací (tisk, záložní cesty) – sanitizovaný.
        function renderMarkdownSafe(markdown) {
            if (typeof marked === "undefined" || !marked.parse) {
                return `<pre>${escapeHtml(markdown || "")}</pre>`;
            }
            try {
                return sanitizeHtml(marked.parse(markdown || ""));
            } catch (err) {
                console.warn("marked.parse error:", err);
                return `<pre>${escapeHtml(markdown || "")}</pre>`;
            }
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
                                    onchange="event.stopPropagation(); togglePlannerQuestionCompleted('${escapeJsStringAttr(q.id)}')"
                                    class="mt-0.5 accent-emerald-500 w-3.5 h-3.5 cursor-pointer shrink-0"
                                    title="${isDone ? t("planner.calUnmarkDone", "Splněno ({date}) - klikněte pro zrušení", { date: q.completedDate || '' }) : t("planner.calMarkDoneToday", "Označit otázku jako hotovou dnes")}">`;

                        const topicDisplay = escapeHtml(q.topic || t("common.general", "Všeobecné"));
                        const editTitle = viewer ? escapeHtml(q.title) : t("planner.calEditQuestionTitle", "Klikněte pro úpravu otázky");

                        return `
                            <div class="p-1.5 sm:p-2 rounded-lg ${isDone ? 'bg-emerald-950/20 border-emerald-900/60' : 'bg-slate-950/80 border-slate-800'} border hover:border-slate-600 transition flex items-start gap-1.5 group text-left">
                                ${checkboxHtml}
                                
                                <div class="flex-1 min-w-0 ${viewer ? 'cursor-default' : 'cursor-pointer'}" ${viewer ? '' : `onclick="openPlannerEditQuestionModal('${escapeJsStringAttr(q.id)}')"`} title="${editTitle}">
                                    <div class="flex items-center gap-1 mb-0.5 flex-wrap">
                                        <span class="font-mono text-[9px] text-slate-400 font-bold">#${escapeHtml(q.number || '')}</span>
                                        <span class="inline-block px-1 py-0.2 rounded text-[8.5px] font-semibold border ${topicBadge} truncate max-w-[80px]" title="${topicDisplay}">
                                            ${topicDisplay}
                                        </span>
                                        ${q.grade ? `<span class="px-1 rounded text-[8.5px] ${gradeBadge}">${escapeHtml(q.grade)}</span>` : ''}
                                    </div>
                                    <p class="text-[11px] leading-snug text-slate-200 group-hover:text-emerald-300 transition line-clamp-2" title="${escapeHtml(q.title)}">
                                        ${escapeHtml(q.title)}
                                    </p>
                                </div>

                                <button type="button" onclick="event.stopPropagation(); explainExamQuestion('${escapeJsStringAttr(q.title)}')"
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
                        <button type="button" onclick="togglePlannerCalendarDayFilter('${escapeJsStringAttr(day.dateStr)}')"
                            class="w-full text-center py-1.5 px-2 text-[10px] font-bold text-emerald-300 bg-emerald-950/70 hover:bg-emerald-900/80 rounded-lg border border-emerald-700/80 transition flex items-center justify-center gap-1 shadow-sm">
                            <span>✕</span> <span>${t("planner.calClearFilter", "Zrušit filtr")}</span>
                        </button>
                    `;
                } else {
                    filterBtnHtml = `
                        <button type="button" onclick="togglePlannerCalendarDayFilter('${escapeJsStringAttr(day.dateStr)}')"
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

                    return `<button onclick="setPlannerQuestionGrade('${escapeJsStringAttr(q.id)}', '${escapeJsStringAttr(g)}')" class="${cls}" title="Nastavit známku ${g}">${g}</button>`;
                }).join(" ");

                const dateDisplay = q.completedDate 
                    ? `<span class="font-mono text-[10px] text-slate-300 bg-slate-950 px-1.5 py-0.5 rounded border border-slate-800 ${viewer ? 'cursor-default' : 'cursor-pointer'}" ${viewer ? '' : `onclick="editPlannerQuestionDate('${escapeJsStringAttr(q.id)}')"`} title="${viewer ? `Datum splnění: ${escapeHtml(q.completedDate)}` : 'Klikněte pro změnu data'}">${isDoneToday ? '🌟 Dnes' : q.completedDate}</span>` 
                    : `<span class="text-[10px] text-slate-500 italic">Neprojito</span>`;

                const checkboxHtml = viewer
                    ? `<input type="checkbox" ${isCompleted ? 'checked' : ''} disabled class="accent-emerald-500 w-4 h-4 cursor-not-allowed opacity-60" title="Režim pozorovatele: Pouze ke čtení">`
                    : `<input type="checkbox" ${isCompleted ? 'checked' : ''} onchange="togglePlannerQuestionCompleted('${escapeJsStringAttr(q.id)}')" class="accent-emerald-500 w-4 h-4 cursor-pointer" title="${isCompleted ? 'Kliknutím zrušíte splnění' : 'Označit jako hotové dnes'}">`;

                const titleActionHtml = viewer
                    ? `<span class="text-slate-100 font-medium leading-snug ${isCompleted ? 'text-slate-300' : ''}">${escapeHtml(q.title)}</span>`
                    : `<span class="text-slate-100 font-medium leading-snug cursor-pointer hover:text-emerald-300 transition ${isCompleted ? 'text-slate-300' : ''}" onclick="openPlannerEditQuestionModal('${escapeJsStringAttr(q.id)}')" title="Klikněte pro úpravu otázky">
                           ${escapeHtml(q.title)}
                       </span>
                       <button onclick="openPlannerEditQuestionModal('${escapeJsStringAttr(q.id)}')" class="opacity-0 group-hover:opacity-100 text-slate-500 hover:text-white text-xs transition" title="Upravit otázku">✏️</button>`;

                const noteInputHtml = viewer
                    ? `<input type="text" value="${escapeHtml(q.note || '')}" placeholder="" readonly disabled class="w-full bg-slate-950/80 border border-slate-800 rounded px-2 py-1 text-slate-400 placeholder-slate-600 focus:outline-none cursor-default opacity-80 transition text-xs" title="Režim pozorovatele: Pouze ke čtení">`
                    : `<input type="text" value="${escapeHtml(q.note || '')}" placeholder="Přidat poznámku..." onchange="updatePlannerQuestionNote('${escapeJsStringAttr(q.id)}', this.value)" class="w-full bg-slate-950/80 border border-slate-800 rounded px-2 py-1 text-slate-300 placeholder-slate-600 focus:outline-none focus:border-rose-500/80 transition text-xs">`;

                const deleteBtnHtml = viewer
                    ? ""
                    : `<button onclick="deletePlannerQuestion('${escapeJsStringAttr(q.id)}')" class="text-slate-500 hover:text-red-400 px-1 py-1 font-bold text-xs transition" title="Smazat otázku">✕</button>`;

                tr.innerHTML = `
                    <td class="p-3">
                        <span class="inline-block px-2 py-0.5 rounded text-[11px] font-semibold border ${badgeClass}">
                            ${escapeHtml(q.topic || 'Všeobecné')}
                        </span>
                    </td>
                    <td class="p-3 text-center font-mono text-slate-400 text-xs font-semibold">
                        ${escapeHtml(q.number || (idx + 1))}
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
                            ${q.grade && !viewer ? `<button onclick="setPlannerQuestionGrade('${escapeJsStringAttr(q.id)}', null)" class="text-slate-500 hover:text-red-400 text-[10px] px-1" title="Zrušit známku">✕</button>` : ''}
                        </div>
                    </td>
                    <td class="p-3">
                        ${noteInputHtml}
                    </td>
                    <td class="p-3 text-center">
                        <div class="flex items-center justify-center gap-1.5">
                            <button onclick="explainExamQuestion('${escapeJsStringAttr(q.title)}')" class="bg-gradient-to-r from-sky-600 to-indigo-600 hover:from-sky-500 hover:to-indigo-500 text-white font-semibold px-2.5 py-1.5 rounded-lg transition shadow flex items-center gap-1 text-[11px]" title="Sestaví expertní prompt a vygeneruje studijní text v záložce Poznámky">
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
                    <div onclick="makeQmTitleEditable(event, '${escapeJsStringAttr(q.id)}')" class="font-medium text-slate-200 hover:text-emerald-300 cursor-pointer select-text leading-snug p-1 rounded hover:bg-slate-900 border border-transparent hover:border-emerald-500/40 transition" title="${t("qm.clickToEditTitle", "Klikněte pro přímou úpravu textu otázky")}">
                        ${escapeHtml(q.title)}
                    </div>
                    ${noteHtml}
                `;

                if (!viewer && qmInlineEditMode) {
                    topicCellHtml = `
                        <input type="text" value="${escapeHtml(q.topic || fallbackTopic)}" onchange="updateQuestionInlineField('${escapeJsStringAttr(q.id)}', 'topic', this.value)" class="w-full bg-slate-950 text-emerald-300 border border-slate-700 rounded px-2 py-1 text-xs focus:border-emerald-500 focus:outline-none">
                    `;
                    numberCellHtml = `
                        <input type="text" value="${escapeHtml(q.number || String(originalIndex + 1))}" onchange="updateQuestionInlineField('${escapeJsStringAttr(q.id)}', 'number', this.value)" class="w-12 text-center bg-slate-950 text-white font-mono border border-slate-700 rounded px-1 py-1 text-xs focus:border-emerald-500 focus:outline-none">
                    `;
                    titleCellHtml = `
                        <input type="text" value="${escapeHtml(q.title)}" onchange="updateQuestionInlineField('${escapeJsStringAttr(q.id)}', 'title', this.value)" class="w-full bg-slate-950 text-white font-medium border border-emerald-500/80 rounded px-2 py-1 text-xs focus:ring-1 focus:ring-emerald-400 focus:outline-none shadow-inner">
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
                        <button onclick="editQuestionById('${escapeJsStringAttr(q.id)}')" class="p-1.5 rounded hover:bg-slate-800 text-slate-400 hover:text-emerald-400 transition" title="${t("qm.editInDialog", "Upravit otázku v dialogovém okně")}">✏️</button>
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

