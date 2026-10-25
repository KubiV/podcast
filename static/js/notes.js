// =========================================================================
// Studijní poznámky (odděleno z app.js, krok 3.5). Klasický skript:
// sdílí globální scope s app.js; pořadí načítání je dané v index.html.
// =========================================================================

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
                    <td class="p-2 text-slate-200 text-xs font-medium truncate max-w-[200px]" title="${escapeHtml(q.title)}">
                        <span class="text-slate-400 font-mono text-[10px] mr-1">${idx + 1}.</span>${escapeHtml(q.title)}
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
                const res = await sendJson("/api/process-notes-batch", {
                    questions: target.map(q => ({ title: q.title, q_index: q.q_index })),
                    prompt: document.getElementById("notesPromptInput").value,
                    project: currentProject,
                    gemini_model: modelName,
                    overnight_mode: isOvernight
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
                const res = await sendJson("/api/generate-notes", {
                    question,
                    project: currentProject,
                    prompt: document.getElementById("notesPromptInput").value,
                    gemini_model: modelName
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
                    document.getElementById("notesRenderedArea").innerHTML = `<div class="p-4 text-red-400">Generování selhalo: ${escapeHtml(data.detail || 'Chyba serveru')}</div>`;
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
                html = escapeHtml(text);
            }

            // 5b. Sanitizace (před citacemi a KaTeX: ty generuje aplikace sama s escapovanými hodnotami)
            html = sanitizeHtml(html);

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
                    span.innerHTML = `<strong>[${escapeHtml(s.id)}]</strong> <span class="truncate max-w-[200px] text-slate-200 group-hover:text-sky-300">${escapeHtml(s.filename)}</span> <span class="text-[10px] text-sky-400 font-bold ml-0.5 opacity-70 group-hover:opacity-100">↗</span>`;
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
                    <div class="flex-1 min-w-0 pr-2" onclick="openSavedNote('${escapeJsStringAttr(note.filename)}')">
                        <p class="text-xs font-semibold text-slate-200 truncate group-hover:text-sky-300" title="${escapeHtml(note.title)}">${escapeHtml(note.title)}</p>
                        <p class="text-[10px] text-slate-500">${(note.size / 1024).toFixed(1)} KB</p>
                    </div>
                    <button onclick="deleteSavedNote('${escapeJsStringAttr(note.filename)}')" class="text-red-400 hover:text-red-300 font-bold px-1.5 opacity-50 group-hover:opacity-100 transition" title="Smazat">✕</button>
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

