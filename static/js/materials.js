// =========================================================================
// Propojení s tabem Poznámky z materiálů (odděleno z app.js, krok 3.5). Klasický skript:
// sdílí globální scope s app.js; pořadí načítání je dané v index.html.
// =========================================================================

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

                    const safeNameAttr = escapeHtml(f);
                    const safeNameArg = encodeURIComponent(f);
                    const safeProjArg = encodeURIComponent(currentProject);
                    
                    const li = document.createElement("li");
                    li.className = "flex justify-between items-center bg-slate-900/90 hover:bg-slate-850 p-2 rounded-lg border border-slate-700/80 hover:border-slate-600 transition group";
                    li.innerHTML = `
                        <div class="flex items-center gap-2 truncate pr-2 min-w-0 flex-1 cursor-pointer" onclick="openDocumentViewer(decodeURIComponent('${escapeJsStringAttr(safeNameArg)}'), '', currentProject)" title="Klikněte pro zobrazení náhledu souboru">
                            <span class="text-sm shrink-0">${icon}</span>
                            <span class="text-[9px] font-mono px-1 py-0.5 rounded border uppercase shrink-0 ${badgeColor}">${extBadge}</span>
                            <span class="truncate text-slate-300 group-hover:text-emerald-300 text-xs font-medium transition">${safeNameAttr}</span>
                        </div>
                        <div class="flex items-center gap-1 shrink-0">
                            <button onclick="openDocumentViewer(decodeURIComponent('${escapeJsStringAttr(safeNameArg)}'), '', currentProject)" class="text-slate-400 hover:text-emerald-400 p-1.5 rounded hover:bg-slate-800 transition outline-none" title="Prohlédnout materiál">
                                👁️
                            </button>
                            <a href="/api/files/${safeProjArg}/${safeNameArg}/view" target="_blank" rel="noopener noreferrer" class="text-slate-400 hover:text-sky-400 p-1.5 rounded hover:bg-slate-800 transition outline-none inline-flex items-center" title="Otevřít v nové záložce">
                                ↗
                            </a>
                            <button onclick="deleteFile(decodeURIComponent('${escapeJsStringAttr(safeNameArg)}'))" class="text-red-400/60 hover:text-red-400 font-bold p-1.5 rounded hover:bg-slate-800 transition outline-none" title="Smazat soubor">
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

                const editBtnHtml = viewer ? "" : `<button onclick="event.stopPropagation(); editQuestionById('${escapeJsStringAttr(q.id)}')" class="text-slate-500 hover:text-emerald-400 flex-shrink-0 transition text-xs md:text-sm px-1 outline-none" title="Upravit otázku (okruh, číslo, znění, poznámka)">✏️</button>`;
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

