// =========================================================================
// Podcast studio (odděleno z app.js, krok 3.5). Klasický skript:
// sdílí globální scope s app.js; pořadí načítání je dané v index.html.
// =========================================================================

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
                                <p class="text-xs text-slate-200 font-mono font-bold truncate" title="${escapeHtml(f)}">${escapeHtml(f)}</p>
                                <p class="text-[10px] ${typeColor} uppercase font-bold mt-1">${escapeHtml(f.split('.').pop())}</p>
                            </div>
                        </div>
                        <div class="flex flex-wrap justify-between items-center mt-2 border-t border-slate-800 pt-2 gap-2">
                            ${isAudio ? `<button onclick="openPodcastPlayer('${escapeJsStringAttr(f)}')" class="text-[11px] bg-emerald-900/50 hover:bg-emerald-800 text-emerald-400 px-2 py-1 rounded transition font-bold text-center border border-emerald-700/50 whitespace-nowrap">▶ Přehrát s textem</button>` : `<a href="/audio/${escapeHtml(f)}" target="_blank" class="text-xs bg-emerald-900/50 hover:bg-emerald-800 text-emerald-400 px-2 py-1 rounded transition">Otevřít</a>`}
                            <button onclick="deleteExplorerFile('${escapeJsStringAttr(f)}')" class="text-xs text-red-500 hover:text-red-400 font-bold px-2 py-1 rounded transition opacity-50 group-hover:opacity-100">Smazat</button>
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

