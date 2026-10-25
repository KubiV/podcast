// =========================================================================
// Plánovač zkoušky a metriky (odděleno z app.js, krok 3.5). Klasický skript:
// sdílí globální scope s app.js; pořadí načítání je dané v index.html.
// =========================================================================

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
                const res = await sendJson(`/api/projects/${encodeURIComponent(currentProject)}/ai-classify-questions`, {
                    gemini_model: "gemini-3.6-flash"
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
                const res = await sendJson(`/api/projects/${encodeURIComponent(currentProject)}/planner`, { planner: examPlanner });

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

