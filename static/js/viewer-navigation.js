// =========================================================================
// Navigace mezi stranami, skoky, zoom a čtecí nástroje (odděleno z app.js, krok 3.5). Klasický skript:
// sdílí globální scope s app.js; pořadí načítání je dané v index.html.
// =========================================================================

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
            // Vstupy jsou text z výstupu modelu (už HTML-escapovaný markdownem): dekódovat a escapovat podle kontextu
            const cleanPage = page ? decodeHtmlEntities(page).trim() : "";
            const pageLabel = cleanPage ? `, s. ${cleanPage}` : "";
            if (isDirect) {
                const cleanFile = decodeHtmlEntities(idOrFile).trim();
                const safeFile = escapeJsStringAttr(cleanFile);
                const safePage = escapeJsStringAttr(cleanPage);
                const label = escapeHtml(`${cleanFile}${pageLabel}`);
                return `<span class="inline-citation cursor-pointer hover:bg-sky-950/80 hover:border-sky-500 transition" onclick="handleDirectCitationClick(event, '${safeFile}', '${safePage}')" title="Kliknutím otevřít ${label}"><sup>📖 ${label}</sup></span>`;
            } else {
                const cleanId = decodeHtmlEntities(idOrFile).trim();
                const safeId = escapeJsStringAttr(cleanId);
                const safePage = escapeJsStringAttr(cleanPage);
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
                return `<span class="inline-citation cursor-pointer hover:bg-sky-950/80 hover:border-sky-500 transition" data-src-id="${escapeHtml(cleanId)}" onclick="handleCitationClick(event, '${safeId}', '${safePage}')" title="${escapeHtml(tooltip)}"><sup>[${escapeHtml(`${cleanId}${pageLabel}`)}]</sup></span>`;
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
                parsedContent = escapeHtml(msg.content || "");
            }

            let sourcesHtml = "";
            if (msg.sources && msg.sources.length > 0) {
                window.chatSources = msg.sources;
                const srcCards = msg.sources.map(s => `
                    <div id="source-item-${escapeHtml(s.id || '')}" class="p-2 bg-slate-950/80 hover:bg-slate-900 rounded border border-slate-800 hover:border-sky-500/60 text-[11px] space-y-1 transition-all cursor-pointer group" onclick="openDocumentViewer('${escapeJsStringAttr(s.filename || '')}', '${escapeJsStringAttr(s.page || '')}', currentProject)" title="Kliknutím otevřít ${escapeHtml(s.filename || '')}">
                        <div class="font-bold text-emerald-400 group-hover:text-sky-300 flex items-center justify-between">
                            <span class="flex items-center gap-1.5 truncate">
                                <span>📄</span> [Zdroj ${escapeHtml(s.id || '?')}] ${escapeHtml(s.filename || 'Dokument')}
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

