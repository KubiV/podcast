// =========================================================================
// Kartičky (Anki / Quizlet) (odděleno z app.js, krok 3.5). Klasický skript:
// sdílí globální scope s app.js; pořadí načítání je dané v index.html.
// =========================================================================

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
                    <td class="p-2 text-slate-200 text-xs font-medium truncate max-w-[200px]" title="${escapeHtml(q.title)}">
                        <span class="text-slate-400 font-mono text-[10px] mr-1">${idx + 1}.</span>${escapeHtml(q.title)}
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
                const res = await sendJson("/api/process-flashcards-batch", {
                    questions: target.map(q => ({ title: q.title, q_index: q.q_index })),
                    count: count,
                    prompt: document.getElementById("cardsPromptInput").value,
                    project: currentProject,
                    gemini_model: modelName,
                    overnight_mode: isOvernight
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
                const res = await sendJson("/api/generate-flashcards", {
                    question,
                    project: currentProject,
                    count,
                    prompt: document.getElementById("cardsPromptInput").value,
                    gemini_model: modelName,
                    force_regenerate: forceRegen
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
                badgeEl.innerHTML = `📖 <span class="hover:underline">${escapeHtml(label)}</span> <span class="text-[10px] text-sky-400 font-bold">↗</span>`;
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

                const cleanFront = escapeHtml(decodeHtmlEntities((c.front || '').replace(/<[^>]*>?/gm, ' ').replace(/\s+/g, ' ').trim()));
                const cleanBack = escapeHtml(decodeHtmlEntities((c.back || '').replace(/<[^>]*>?/gm, ' ').replace(/\s+/g, ' ').trim()));

                tr.innerHTML = `
                    <td class="p-2 text-center text-slate-400 font-mono">${idx + 1}</td>
                    <td class="p-2 truncate font-semibold text-slate-200" title="${cleanFront}">${cleanFront}</td>
                    <td class="p-2 truncate text-slate-400" title="${cleanBack}">${cleanBack}</td>
                    <td class="p-2 text-center text-sky-400 font-mono text-[10px] cursor-pointer hover:underline truncate" title="${escapeHtml(srcTitle)}" onclick="event.stopPropagation(); if ('${escapeJsStringAttr(resolved.source_file)}') openDocumentViewer('${escapeJsStringAttr(resolved.source_file)}', '${escapeJsStringAttr(resolved.clean_page)}', currentProject); else selectCardFromTable(${idx});">${srcLabel}</td>
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
                    <div class="flex-1 min-w-0 pr-2" onclick="openSavedDeck('${escapeJsStringAttr(deck.filename)}')">
                        <p class="text-xs font-semibold text-slate-200 truncate group-hover:text-amber-300" title="${escapeHtml(deck.question)}">${escapeHtml(deck.question)}</p>
                        <p class="text-[10px] text-amber-400 font-bold">${deck.count} kartiček</p>
                    </div>
                    <button onclick="deleteSavedDeck('${escapeJsStringAttr(deck.filename)}')" class="text-red-400 hover:text-red-300 font-bold px-1.5 opacity-50 group-hover:opacity-100 transition" title="Smazat">✕</button>
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
