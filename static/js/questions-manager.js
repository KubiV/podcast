// =========================================================================
// Centrální správce otázek projektu (odděleno z app.js, krok 3.5). Klasický skript:
// sdílí globální scope s app.js; pořadí načítání je dané v index.html.
// =========================================================================

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

