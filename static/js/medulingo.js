// =========================================================================
// Medulingo – studijní cesta (oddělena z app.js, krok 3.5). Klasický skript:
// sdílí globální scope s app.js; načítá se za app.js a před pomodoro.js (index.html).
// =========================================================================

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
                    <button onclick="openMedulingoQuestion('${escapeJsStringAttr(q.id)}')" 
                            class="duo-node w-16 h-16 rounded-full border-4 flex items-center justify-center text-xl cursor-pointer ${nodeBg}"
                            title="${escapeHtml(q.title)} - ${escapeHtml(nodeStatusText)}">
                        ${nodeIcon}
                    </button>

                    <!-- INFORMAČNÍ KARTA OTÁZKY -->
                    <div onclick="openMedulingoQuestion('${escapeJsStringAttr(q.id)}')" 
                         class="mt-2.5 bg-slate-900/90 hover:bg-slate-850 p-2.5 px-4 rounded-2xl border ${isCurrent ? 'border-emerald-500/80 shadow-lg shadow-emerald-950/50' : 'border-slate-800'} text-center max-w-[280px] cursor-pointer group transition-all">
                        <div class="flex items-center justify-center gap-1.5 text-[10px] text-slate-400 uppercase font-bold tracking-wider">
                            <span>Otázka ${escapeHtml(q.number)}</span> &bull; 
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
                        : renderMarkdownSafe(c.back || "");
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
                    const safeFile = escapeJsStringAttr(resolved.source_file || "");
                    const safeId = escapeJsStringAttr(resolved.source_id || "");
                    const safePage = escapeJsStringAttr(resolved.clean_page || "");
                    const safeProj = escapeJsStringAttr((activeMedQuestion && activeMedQuestion.project) || currentProject || "");
                    ref.innerHTML = `<span class="cursor-pointer hover:underline text-sky-400 flex items-center gap-1 font-mono text-[11px]" onclick="event.stopPropagation(); handleCitationClick(event, '${safeFile || safeId}', '${safePage}', '${safeProj}')" title="Kliknutím otevřít zdroj">📖 ${escapeHtml(label)} ↗</span>`;
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
                                        : renderMarkdownSafe(fullText)) + '<span class="inline-block w-1.5 h-3.5 bg-emerald-400 ml-1 animate-pulse align-middle"></span>';
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
                                    : renderMarkdownSafe(fullText);
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
                            : renderMarkdownSafe(fullText);
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
                        <button onclick="toggleMedTestOption(${qIdx}, '${escapeJsStringAttr(opt.id)}')" id="medOptBtn-${qIdx}-${opt.id}" 
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

