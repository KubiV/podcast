// =========================================================================
// Testové otázky (practice tests a Anki match) (odděleno z app.js, krok 3.5). Klasický skript:
// sdílí globální scope s app.js; pořadí načítání je dané v index.html.
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
                                <input type="checkbox" ${isChecked ? 'checked' : ''} onchange="toggleTestsCategory('${escapeJsStringAttr(cat)}', this.checked)" class="accent-purple-500 cursor-pointer w-4 h-4 rounded">
                                <div class="flex items-center gap-1.5 flex-wrap">
                                    <span class="font-semibold text-slate-100 text-xs">${escapeHtml(cat)}</span>
                                    <span class="text-[10px] bg-slate-800 text-purple-300 px-1.5 py-0.5 rounded border border-slate-700 font-mono font-medium">${qList.length} ${qList.length === 1 ? 'otázka' : (qList.length < 5 ? 'otázky' : 'otázek')}</span>
                                </div>
                            </label>
                            <button type="button" onclick="toggleExpandTestsCategory('${escapeJsStringAttr(cat)}')" class="text-slate-400 hover:text-purple-300 text-xs px-1.5 py-0.5 rounded transition" title="Zobrazit otázky v kategorii">
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
                const res = await sendJson("/api/tests/generate", {
                    project: currentProject,
                    questions: selectedQuestionTitles,
                    categories: selectedCategories,
                    categories_map: categoriesMap,
                    count: currentTestCount,
                    question_types: qTypes,
                    difficulty: currentTestDifficulty,
                    mode: currentTestMode,
                    gemini_model: modelName
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
                            <span class="w-6 h-6 rounded-lg font-mono font-bold text-xs flex items-center justify-center border shrink-0 ${badgeStyle}">${escapeHtml(opt.id)}</span>
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
                            <span class="w-5 h-5 rounded font-mono font-bold text-[11px] flex items-center justify-center bg-slate-800 text-purple-300 shrink-0 border border-slate-700">${escapeHtml(opt.id)}</span>
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
                    await sendJson(`/api/tests/${encodeURIComponent(activeTest.filename)}/result`, resultPayload);
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
                const res = await sendJson("/api/tests/generate-more", {
                    previous_test_id: activeTest.filename,
                    project: currentProject,
                    count: followupQuestionsCount,
                    difficulty_shift: followupDifficultyShift,
                    focus_mistakes: focusMistakes,
                    gemini_model: modelName
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
                        <div class="min-w-0 flex-1 cursor-pointer" onclick="loadSavedTest('${escapeJsStringAttr(t.filename)}')">
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
                            <button onclick="loadSavedTest('${escapeJsStringAttr(t.filename)}')" class="p-1 hover:bg-slate-750 text-slate-300 hover:text-white rounded text-xs transition" title="Spustit / Prohlédnout test">▶️</button>
                            <button onclick="deleteSavedTest('${escapeJsStringAttr(t.filename)}')" class="p-1 hover:bg-slate-750 text-slate-500 hover:text-rose-400 rounded text-xs transition" title="Smazat test">🗑️</button>
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

