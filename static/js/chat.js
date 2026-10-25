// =========================================================================
// Projektový grounded chat s historií vláken (odděleno z app.js, krok 3.5). Klasický skript:
// sdílí globální scope s app.js; pořadí načítání je dané v index.html.
// =========================================================================

        // =========================================================================
        // NOVÝ MODUL: PROJEKTOVÝ GROUNDED CHAT S HISTORIÍ VLÁKEN
        // =========================================================================
        let chatThreads = [];
        let currentChatThreadId = null;
        let currentChatThreadData = null;
        let chatMessages = [];
        let chatAbortController = null;
        let isChatStreaming = false;
        let chatHistorySearchDebounce = null;
        let isChatSidebarOpenOnMobile = false;

        function toggleChatHistorySidebar() {
            const sidebar = document.getElementById("chatHistorySidebar");
            const textEl = document.getElementById("btnToggleChatSidebarText");
            if (!sidebar) return;
            isChatSidebarOpenOnMobile = !isChatSidebarOpenOnMobile;
            if (isChatSidebarOpenOnMobile) {
                sidebar.classList.remove("hidden");
                sidebar.classList.add("flex");
                if (textEl) textEl.textContent = "Zavřít";
            } else {
                sidebar.classList.add("hidden");
                sidebar.classList.remove("flex");
                if (textEl) textEl.textContent = "Historie";
            }
        }

        let activeLessonChatContext = null;

        async function loadChatHistory(keepSelectedThreadId = null) {
            const projLabel = document.getElementById("chatCurrentProjectLabel");
            if (activeLessonChatContext) {
                if (projLabel) projLabel.textContent = `🎓 Lekce: ${activeLessonChatContext.title}`;
            } else {
                if (projLabel) projLabel.textContent = currentProject || "-- (Není vybrán)";
            }
            await loadChatThreads(keepSelectedThreadId);
        }

        async function loadChatThreads(keepSelectedThreadId = null) {
            const container = document.getElementById("chatThreadsListContainer");
            const countBadge = document.getElementById("chatThreadsCountBadge");
            const searchInput = document.getElementById("chatHistorySearchInput");
            const filterAllCheckbox = document.getElementById("chatFilterAllProjects");
            const filterInfo = document.getElementById("chatHistoryFilterInfo");

            const query = (searchInput ? searchInput.value : "").trim();
            const isAll = filterAllCheckbox ? filterAllCheckbox.checked : false;
            let targetProj = isAll ? "__all__" : (currentProject || "");
            if (!isAll && activeLessonChatContext) {
                targetProj = activeLessonChatContext.id;
            }

            if (filterInfo) {
                filterInfo.textContent = isAll ? "Všechny projekty" : (activeLessonChatContext ? `🎓 ${activeLessonChatContext.title}` : (currentProject || "Bez výběru"));
            }

            if (!container) return;

            try {
                let url = `/api/chat/threads?`;
                const params = new URLSearchParams();
                if (targetProj) params.set("project_id", targetProj);
                if (query) params.set("q", query);
                url += params.toString();

                const res = await fetch(url);
                const data = await res.json();
                chatThreads = data.threads || [];

                if (countBadge) countBadge.textContent = chatThreads.length;

                renderChatThreadsList();

                // Určení, které vlákno vybrat
                const targetId = keepSelectedThreadId || currentChatThreadId;
                if (targetId && chatThreads.some(t => t.id === targetId)) {
                    await selectChatThread(targetId, false);
                } else if (chatThreads.length > 0 && !query) {
                    await selectChatThread(chatThreads[0].id, false);
                } else if (chatThreads.length === 0) {
                    createNewChatThread(false);
                }
            } catch (err) {
                console.error("Chyba při načítání vláken chatu:", err);
                if (container) {
                    container.innerHTML = `<div class="p-3 text-xs text-red-400 bg-red-950/40 rounded-lg border border-red-800">Chyba při načítání historie: ${escapeHtml(err.message)}</div>`;
                }
            }
        }

        function renderChatThreadsList() {
            const container = document.getElementById("chatThreadsListContainer");
            const searchInput = document.getElementById("chatHistorySearchInput");
            const query = (searchInput ? searchInput.value : "").trim();

            if (!container) return;

            if (!chatThreads || chatThreads.length === 0) {
                if (query) {
                    container.innerHTML = `
                        <div class="p-6 text-center text-slate-500 space-y-2">
                            <span class="text-2xl block">🔍</span>
                            <p class="text-xs">Žádné konverzace neodpovídají dotazu <span class="text-indigo-300 font-semibold">"${query}"</span></p>
                            <button onclick="clearChatHistorySearch()" class="text-[11px] text-indigo-400 hover:text-indigo-300 underline font-medium">Vymazat filtr</button>
                        </div>
                    `;
                } else {
                    container.innerHTML = `
                        <div class="p-6 text-center text-slate-500 space-y-2">
                            <span class="text-2xl block">💬</span>
                            <p class="text-xs">Zatím žádné konverzace.</p>
                            <button onclick="createNewChatThread()" class="text-[11px] bg-indigo-700/80 hover:bg-indigo-600 text-white px-2.5 py-1 rounded transition font-medium">Zahájit nový chat</button>
                        </div>
                    `;
                }
                return;
            }

            const pinned = chatThreads.filter(t => t.is_pinned);
            const unpinned = chatThreads.filter(t => !t.is_pinned);

            let html = "";

            // 1. Připnuté oblíbené konverzace
            if (pinned.length > 0) {
                html += `
                    <div class="space-y-1">
                        <div class="flex items-center gap-1.5 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-amber-400/90 select-none">
                            <span>📌</span>
                            <span>Připnuté (${pinned.length})</span>
                        </div>
                        <div class="space-y-1">
                            ${pinned.map(t => renderThreadItemHtml(t)).join("")}
                        </div>
                    </div>
                `;
            }

            // 2. Ostatní / Všechny konverzace
            if (unpinned.length > 0) {
                html += `
                    <div class="space-y-1 ${pinned.length > 0 ? "mt-3 pt-2 border-t border-slate-700/50" : ""}">
                        <div class="flex items-center gap-1.5 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-slate-400 select-none">
                            <span>🕒</span>
                            <span>${pinned.length > 0 ? "Ostatní konverzace" : "Konverzace"} (${unpinned.length})</span>
                        </div>
                        <div class="space-y-1">
                            ${unpinned.map(t => renderThreadItemHtml(t)).join("")}
                        </div>
                    </div>
                `;
            }

            container.innerHTML = html;
        }

        function renderThreadItemHtml(t) {
            const isActive = t.id === currentChatThreadId;
            const isPinned = t.is_pinned;

            let dateStr = "";
            if (t.updated_at) {
                try {
                    const d = new Date(t.updated_at.replace(" ", "T"));
                    const today = new Date();
                    const isToday = d.toDateString() === today.toDateString();
                    if (isToday) {
                        dateStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    } else {
                        dateStr = `${d.getDate()}. ${d.getMonth() + 1}.`;
                    }
                } catch (e) {
                    dateStr = t.updated_at.split(" ")[0];
                }
            }

            const safeTitle = escapeHtml(t.title || "Nová konverzace");
            const projBadge = (t.project_id && (!currentProject || t.project_id !== currentProject)) 
                ? `<span class="text-[9px] bg-slate-900 text-emerald-400 px-1 py-0.5 rounded border border-slate-700 truncate max-w-[80px]" title="Projekt: ${escapeHtml(t.project_id)}">${escapeHtml(t.project_id)}</span>` 
                : "";

            return `
                <div id="thread-item-${escapeHtml(t.id)}" onclick="selectChatThread('${escapeJsStringAttr(t.id)}')" class="group relative p-2.5 rounded-xl border transition-all cursor-pointer flex flex-col gap-1 ${
                    isActive 
                        ? "bg-indigo-950/80 border-indigo-500 shadow-md text-white" 
                        : "bg-slate-900/70 hover:bg-slate-800/80 border-slate-800/80 hover:border-slate-700 text-slate-300"
                }">
                    <div class="flex items-center justify-between gap-1.5 min-w-0">
                        <div class="flex items-center gap-1.5 min-w-0 flex-1">
                            ${isPinned ? '<span class="text-xs text-amber-400 shrink-0" title="Připnutá konverzace">📌</span>' : ''}
                            <h4 class="text-xs font-semibold truncate ${isActive ? 'text-white' : 'group-hover:text-white'}" title="${safeTitle}">
                                ${safeTitle}
                            </h4>
                        </div>

                        <!-- Tlačítka rychlých akcí -->
                        <div class="flex items-center gap-0.5 shrink-0 opacity-80 group-hover:opacity-100 transition">
                            <!-- Pin button -->
                            <button onclick="togglePinThread('${escapeJsStringAttr(t.id)}', event)" class="p-1 rounded hover:bg-slate-700/80 text-[11px] ${isPinned ? 'text-amber-400' : 'text-slate-500 hover:text-amber-300'}" title="${isPinned ? 'Odepnout z oblíbených' : 'Připnout do oblíbených'}">
                                ${isPinned ? '📌' : '📍'}
                            </button>
                            <!-- Rename button -->
                            <button onclick="renameChatThread('${escapeJsStringAttr(t.id)}', event)" class="p-1 rounded hover:bg-slate-700/80 text-[11px] text-slate-500 hover:text-indigo-300" title="Přejmenovat">
                                ✏️
                            </button>
                            <!-- Delete button -->
                            <button onclick="deleteChatThread('${escapeJsStringAttr(t.id)}', event)" class="p-1 rounded hover:bg-slate-700/80 text-[11px] text-slate-500 hover:text-red-400" title="Smazat">
                                🗑️
                            </button>
                        </div>
                    </div>

                    <!-- Podtitul: snippet, datum, počet zpráv, projekt -->
                    <div class="flex items-center justify-between gap-2 text-[10px] text-slate-400">
                        <div class="flex items-center gap-1.5 truncate flex-1">
                            ${projBadge}
                            ${t.last_snippet ? `<span class="truncate italic text-slate-400/90">${t.last_snippet}</span>` : `<span class="italic text-slate-500">Zatím bez zpráv</span>`}
                        </div>
                        <div class="flex items-center gap-1.5 shrink-0 text-slate-400 font-mono">
                            <span>${dateStr}</span>
                            <span class="bg-slate-800 text-slate-400 px-1 rounded border border-slate-700">${t.message_count || 0}</span>
                        </div>
                    </div>
                </div>
            `;
        }

        async function selectChatThread(threadId, shouldCloseMobile = true) {
            if (isChatStreaming) return;
            currentChatThreadId = threadId;

            // Vizuální výběr
            document.querySelectorAll("[id^='thread-item-']").forEach(el => {
                el.classList.remove("bg-indigo-950/80", "border-indigo-500", "shadow-md", "text-white");
                el.classList.add("bg-slate-900/70", "border-slate-800/80", "text-slate-300");
            });
            const selectedEl = document.getElementById(`thread-item-${threadId}`);
            if (selectedEl) {
                selectedEl.classList.remove("bg-slate-900/70", "border-slate-800/80", "text-slate-300");
                selectedEl.classList.add("bg-indigo-950/80", "border-indigo-500", "shadow-md", "text-white");
            }

            if (shouldCloseMobile && window.innerWidth < 1024 && isChatSidebarOpenOnMobile) {
                toggleChatHistorySidebar();
            }

            const titleLabel = document.getElementById("currentChatTitleLabel");
            const pinBtn = document.getElementById("btnCurrentChatPin");
            const pinIcon = document.getElementById("currentChatPinIcon");
            const metaBadge = document.getElementById("currentChatMetaBadge");
            const listEl = document.getElementById("chatMessagesList");

            if (!listEl) return;

            listEl.innerHTML = `
                <div class="flex items-center justify-center h-48 text-slate-500 text-xs">
                    <span class="inline-block w-4 h-4 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin mr-2"></span>
                    Načítám konverzaci...
                </div>
            `;

            try {
                const res = await fetch(`/api/chat/threads/${encodeURIComponent(threadId)}`);
                if (!res.ok) throw new Error("Chyba při načítání vlákna");
                const data = await res.json();
                currentChatThreadData = data.thread;
                chatMessages = data.messages || [];

                if (titleLabel) titleLabel.textContent = currentChatThreadData.title || "Nová konverzace";
                if (metaBadge) metaBadge.textContent = `${chatMessages.length} zpráv`;

                if (pinBtn && pinIcon) {
                    if (currentChatThreadData.is_pinned) {
                        pinBtn.className = "p-1.5 rounded-lg border border-amber-600 bg-amber-950/60 text-amber-300 transition shrink-0";
                        pinIcon.textContent = "📌";
                    } else {
                        pinBtn.className = "p-1.5 rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-amber-300 transition shrink-0";
                        pinIcon.textContent = "📍";
                    }
                }

                renderAllChatMessages();
            } catch (err) {
                console.error("Chyba selectChatThread:", err);
                listEl.innerHTML = `<div class="p-4 text-xs text-red-400 bg-red-950/40 rounded-xl border border-red-800">Chyba při načítání zpráv konverzace: ${escapeHtml(err.message)}</div>`;
            }
        }

        function createNewChatThread(focusInput = true) {
            if (isChatStreaming) return;
            currentChatThreadId = null;
            currentChatThreadData = null;
            chatMessages = [];

            // Vizuálně odznačit všechna vlákna v sidebaru
            document.querySelectorAll("[id^='thread-item-']").forEach(el => {
                el.classList.remove("bg-indigo-950/80", "border-indigo-500", "shadow-md", "text-white");
                el.classList.add("bg-slate-900/70", "border-slate-800/80", "text-slate-300");
            });

            const titleLabel = document.getElementById("currentChatTitleLabel");
            if (titleLabel) titleLabel.textContent = t("chat.newConversationTitle", "Nová konverzace");

            const metaBadge = document.getElementById("currentChatMetaBadge");
            if (metaBadge) metaBadge.textContent = "0 zpráv";

            const pinBtn = document.getElementById("btnCurrentChatPin");
            const pinIcon = document.getElementById("currentChatPinIcon");
            if (pinBtn && pinIcon) {
                pinBtn.className = "p-1.5 rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-amber-300 transition shrink-0";
                pinIcon.textContent = "📍";
            }

            renderAllChatMessages();

            if (window.innerWidth < 1024 && isChatSidebarOpenOnMobile) {
                toggleChatHistorySidebar();
            }

            if (focusInput) {
                const inp = document.getElementById("chatInputText");
                if (inp) inp.focus();
            }
        }

        async function togglePinThread(threadId, e) {
            if (e) e.stopPropagation();
            try {
                const res = await fetch(`/api/chat/threads/${encodeURIComponent(threadId)}/pin`, { method: "POST" });
                if (!res.ok) throw new Error("Chyba při změně připnutí");
                const data = await res.json();

                await loadChatThreads(currentChatThreadId);

                if (threadId === currentChatThreadId && currentChatThreadData) {
                    currentChatThreadData.is_pinned = data.thread.is_pinned;
                    const pinBtn = document.getElementById("btnCurrentChatPin");
                    const pinIcon = document.getElementById("currentChatPinIcon");
                    if (pinBtn && pinIcon) {
                        if (currentChatThreadData.is_pinned) {
                            pinBtn.className = "p-1.5 rounded-lg border border-amber-600 bg-amber-950/60 text-amber-300 transition shrink-0";
                            pinIcon.textContent = "📌";
                        } else {
                            pinBtn.className = "p-1.5 rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-amber-300 transition shrink-0";
                            pinIcon.textContent = "📍";
                        }
                    }
                }
            } catch (err) {
                alert(`Chyba při připnutí konverzace: ${err.message}`);
            }
        }

        function togglePinCurrentThread() {
            if (!currentChatThreadId) {
                alert(t("chat.startConversationFirst", "Nejprve zahajte konverzaci odesláním dotazu."));
                return;
            }
            togglePinThread(currentChatThreadId);
        }

        async function renameChatThread(threadId, e) {
            if (e) e.stopPropagation();
            const thread = chatThreads.find(t => t.id === threadId) || (currentChatThreadData && currentChatThreadData.id === threadId ? currentChatThreadData : null);
            const oldTitle = thread ? thread.title : "";
            const newTitle = prompt("Zadejte nový název této konverzace:", oldTitle);
            if (!newTitle || newTitle.trim() === oldTitle || !newTitle.trim()) return;

            try {
                const res = await sendJson(`/api/chat/threads/${encodeURIComponent(threadId)}`, { title: newTitle.trim() }, "PATCH");
                if (!res.ok) throw new Error("Chyba při přejmenování");
                await loadChatThreads(currentChatThreadId);
                if (threadId === currentChatThreadId) {
                    const titleLabel = document.getElementById("currentChatTitleLabel");
                    if (titleLabel) titleLabel.textContent = newTitle.trim();
                }
            } catch (err) {
                alert(`Chyba při přejmenování konverzace: ${err.message}`);
            }
        }

        function renameCurrentThread() {
            if (!currentChatThreadId) {
                alert(t("chat.startConversationFirst", "Nejprve zahajte konverzaci odesláním dotazu."));
                return;
            }
            renameChatThread(currentChatThreadId);
        }

        async function deleteChatThread(threadId, e) {
            if (e) e.stopPropagation();
            const thread = chatThreads.find(t => t.id === threadId);
            const name = thread ? `"${thread.title}"` : "tuto konverzaci";
            if (!confirm(`Opravdu chcete smazat konverzaci ${name}?`)) return;

            try {
                const res = await fetch(`/api/chat/threads/${encodeURIComponent(threadId)}`, { method: "DELETE" });
                if (!res.ok) throw new Error("Chyba při mazání");
                if (currentChatThreadId === threadId) {
                    currentChatThreadId = null;
                    currentChatThreadData = null;
                }
                await loadChatThreads();
            } catch (err) {
                alert(`Chyba při mazání konverzace: ${err.message}`);
            }
        }

        function deleteCurrentChatThread() {
            if (!currentChatThreadId) {
                chatMessages = [];
                renderAllChatMessages();
                return;
            }
            deleteChatThread(currentChatThreadId);
        }

        function handleChatHistorySearchInput(e) {
            const val = (e.target.value || "").trim();
            const clearBtn = document.getElementById("btnClearChatHistorySearch");
            if (clearBtn) clearBtn.classList.toggle("hidden", !val);

            clearTimeout(chatHistorySearchDebounce);
            chatHistorySearchDebounce = setTimeout(() => {
                loadChatThreads(currentChatThreadId);
            }, 250);
        }

        function clearChatHistorySearch() {
            const input = document.getElementById("chatHistorySearchInput");
            const clearBtn = document.getElementById("btnClearChatHistorySearch");
            if (input) input.value = "";
            if (clearBtn) clearBtn.classList.add("hidden");
            loadChatThreads(currentChatThreadId);
        }

        function renderAllChatMessages() {
            const listEl = document.getElementById("chatMessagesList");
            const suggestions = document.getElementById("chatSuggestionsBar");
            if (!listEl) return;

            if (!chatMessages || chatMessages.length === 0) {
                if (suggestions) suggestions.classList.remove("hidden");
                listEl.innerHTML = `
                    <div class="flex flex-col items-center justify-center h-full text-center text-slate-500 p-8 space-y-3">
                        <span class="text-4xl">💬</span>
                        <h4 class="text-base font-bold text-slate-300">Zahajte konverzaci se zdroji projektu</h4>
                        <p class="text-xs max-w-md text-slate-400">
                            Položte libovolný dotaz. Asistent vyhledá relevantní pasáže v nahraných materiálech projektu, přesně ocituje zdroje a odpoví bez halucinací.
                        </p>
                    </div>
                `;
                return;
            }

            if (suggestions) suggestions.classList.add("hidden");
            listEl.innerHTML = "";
            chatMessages.forEach(msg => {
                appendChatMessageToUI(msg);
            });
            listEl.scrollTop = listEl.scrollHeight;

            if (window.chatSearcher) {
                const q = document.getElementById("chatSearchInput")?.value?.trim();
                if (q) window.chatSearcher.search(q);
                else window.chatSearcher.clearHighlights();
            }
        }

        function resolveCardSourceClient(card, sourcesList = []) {
            let source_file = String(card.source_file || "").trim();
            let source_page = String(card.source_page || card.page || "").trim();
            let source_ref = String(card.source_ref || "").trim();
            let source_id = "";

            // Mapa ID -> filename
            const idMap = {};
            (sourcesList || []).forEach(s => {
                if (s && s.id !== undefined && s.filename) idMap[String(s.id)] = s.filename;
            });

            if (!source_file && source_ref) {
                const m = source_ref.match(/\[(?:Zdroj\s*)?(\d+)(?:,\s*s(?:tr)?\.?\s*([^\]]+))?\]/i);
                if (m) {
                    source_id = m[1];
                    if (!source_page && m[2]) source_page = m[2].trim();
                    if (idMap[source_id]) source_file = idMap[source_id];
                } else {
                    const mDir = source_ref.match(/\[Zdroj:\s*([^,\]]+)(?:,\s*s(?:tr)?\.?\s*([^\]]+))?\]/i);
                    if (mDir) {
                        source_file = mDir[1].trim();
                        if (!source_page && mDir[2]) source_page = mDir[2].trim();
                    }
                }
            }

            if (!source_file && /^\d+$/.test(source_file) && idMap[source_file]) {
                source_file = idMap[source_file];
            }

            if (!source_page && source_ref) {
                const mp = source_ref.match(/s(?:tr)?\.?\s*([0-9]+(?:\s*[-–]\s*[0-9]+)?)/i);
                if (mp) source_page = mp[1].trim();
            }

            if (!source_file && sourcesList && sourcesList.length === 1 && sourcesList[0].filename) {
                source_file = sourcesList[0].filename;
            }

            let clean_page = "";
            if (source_page) {
                const md = source_page.match(/\d+/);
                if (md) clean_page = md[0];
            }

            return {
                source_file,
                source_page,
                source_ref,
                source_id,
                clean_page
            };
        }

        let docViewerCurrentData = null;
        let docViewerCurrentTab = "native";

        async function openDocumentViewer(filename, page = "", project = "") {
            if (!filename) return;
            const proj = project || currentProject;
            const modal = document.getElementById("modalDocumentViewer");
            const frame = document.getElementById("docViewerFrame");
            const titleEl = document.getElementById("docViewerTitle");
            const pageBadge = document.getElementById("docViewerPageBadge");
            const sizeBadge = document.getElementById("docViewerSizeBadge");
            const subEl = document.getElementById("docViewerSubtitle");
            const linkEl = document.getElementById("docViewerExternalLink");
            const downloadEl = document.getElementById("docViewerDownloadLink");
            const officeDownloadBtn = document.getElementById("docViewerOfficeDownloadBtn");
            const officeNotice = document.getElementById("docViewerOfficeNotice");
            const iconEl = document.getElementById("docViewerIcon");
            const loader = document.getElementById("docViewerLoading");
            const loaderText = document.getElementById("docViewerLoadingText");

            let cleanPage = "";
            if (page) {
                const m = String(page).match(/\d+/);
                if (m) cleanPage = m[0];
            }

            const safeProj = encodeURIComponent(proj);
            const safeFile = encodeURIComponent(filename);
            const viewUrl = `/api/files/${safeProj}/${safeFile}/view${cleanPage ? `#page=${cleanPage}` : ''}`;
            const ext = filename.split('.').pop().toLowerCase();

            // Ikona podle formátu
            let icon = "📄";
            if (ext === "pptx" || ext === "ppt") icon = "📊";
            else if (ext === "docx" || ext === "doc") icon = "📝";
            else if (ext === "txt" || ext === "md") icon = "📋";
            else if (["png", "jpg", "jpeg", "webp"].includes(ext)) icon = "🖼️";
            if (iconEl) iconEl.textContent = icon;

            if (titleEl) {
                titleEl.textContent = filename;
                titleEl.title = filename;
            }
            if (pageBadge) {
                pageBadge.textContent = page ? `Strana: ${page}` : (ext === "pptx" ? "Snímky" : (ext === "docx" ? "Dokument" : "Začátek"));
                pageBadge.className = cleanPage 
                    ? "text-[11px] bg-sky-900/60 text-sky-300 font-mono px-2 py-0.5 rounded border border-sky-700 font-bold" 
                    : "text-[11px] bg-slate-800 text-slate-400 font-mono px-2 py-0.5 rounded border border-slate-700";
            }
            if (sizeBadge) {
                sizeBadge.textContent = "-- KB";
            }
            if (subEl) {
                subEl.textContent = `Projekt: ${proj || 'Neznámý'}`;
            }
            if (linkEl) {
                linkEl.href = viewUrl;
            }
            if (downloadEl) {
                downloadEl.href = `/api/files/${safeProj}/${safeFile}/view`;
                downloadEl.setAttribute("download", filename);
            }
            if (officeDownloadBtn) {
                officeDownloadBtn.href = `/api/files/${safeProj}/${safeFile}/view`;
                officeDownloadBtn.setAttribute("download", filename);
            }
            const footerLabel = document.getElementById("docViewerFooterLabel");
            if (footerLabel) {
                footerLabel.textContent = `${filename}${cleanPage ? ` (s. ${cleanPage})` : ''} • Projekt: ${proj || 'Aktuální'}`;
            }
            const footerLinkEl = document.getElementById("docViewerFooterExternalLink");
            if (footerLinkEl) {
                footerLinkEl.href = viewUrl;
            }
            const footerDownloadEl = document.getElementById("docViewerFooterDownloadLink");
            if (footerDownloadEl) {
                footerDownloadEl.href = `/api/files/${safeProj}/${safeFile}/view`;
                footerDownloadEl.setAttribute("download", filename);
            }

            // Reset a zobrazení modalu
            docViewerCurrentData = null;
            if (modal) modal.classList.remove("hidden");

            // Rozhodnutí o výchozím zobrazení
            const isOffice = ["docx", "doc", "pptx", "ppt"].includes(ext);
            if (officeNotice) {
                officeNotice.classList.toggle("hidden", !isOffice);
            }

            if (isOffice) {
                // Office formáty přepneme rovnou na extrahovaný text (RAG náhled)
                setDocViewerTab('text');
                if (frame) frame.src = "about:blank";
            } else {
                setDocViewerTab('native');
                if (loader) {
                    if (loaderText) loaderText.textContent = t("viewer.loadingFile", "Načítám soubor...");
                    loader.classList.remove("hidden");
                }
                if (frame) {
                    if (frame.src && frame.src.includes(safeFile)) {
                        frame.src = "about:blank";
                        setTimeout(() => { frame.src = viewUrl; }, 20);
                    } else {
                        frame.src = viewUrl;
                    }
                    frame.onload = () => {
                        if (loader) loader.classList.add("hidden");
                    };
                }
            }

            // Asynchronně načíst strukturovaný náhled z /api/files/.../preview
            fetchDocViewerPreview(proj, filename, cleanPage);
        }

        async function fetchDocViewerPreview(project, filename, targetPage = "") {
            const safeProj = encodeURIComponent(project);
            const safeFile = encodeURIComponent(filename);
            const sizeBadge = document.getElementById("docViewerSizeBadge");
            const textContent = document.getElementById("docViewerTextContent");
            const sectionsCountEl = document.getElementById("docViewerSectionsCount");
            const searchInput = document.getElementById("docViewerTextSearch");
            if (searchInput) searchInput.value = "";

            try {
                const res = await fetch(`/api/files/${safeProj}/${safeFile}/preview`);
                if (!res.ok) throw new Error("Chyba při načítání náhledu.");
                const data = await res.json();
                docViewerCurrentData = data;

                if (sizeBadge && data.size_bytes) {
                    const kb = (data.size_bytes / 1024).toFixed(1);
                    const mb = (data.size_bytes / (1024 * 1024)).toFixed(2);
                    sizeBadge.textContent = data.size_bytes > 1024 * 1024 ? `${mb} MB` : `${kb} KB`;
                }

                renderDocViewerSections(data.sections, targetPage);
            } catch (err) {
                if (textContent) {
                    textContent.innerHTML = `<div class="p-4 bg-red-950/40 border border-red-800 rounded-lg text-red-300">Nelze načíst textový náhled: ${escapeHtml(err.message)}</div>`;
                }
            }
        }

        function renderDocViewerSections(sections, targetPage = "") {
            const textContent = document.getElementById("docViewerTextContent");
            const sectionsCountEl = document.getElementById("docViewerSectionsCount");
            if (!textContent) return;

            if (!sections || sections.length === 0) {
                textContent.innerHTML = `<div class="p-8 text-center text-slate-500 italic">${t("viewer.noTextFound", "V tomto dokumentu nebyl nalezen žádný strojově čitelný text.")}</div>`;
                if (sectionsCountEl) sectionsCountEl.textContent = "0 sekcí";
                return;
            }

            if (sectionsCountEl) {
                sectionsCountEl.textContent = `${sections.length} ${sections.length === 1 ? 'sekce' : (sections.length < 5 ? 'sekce' : 'sekcí')}`;
            }

            let html = "";
            sections.forEach((sec, idx) => {
                const isTarget = targetPage && String(sec.page).includes(targetPage);
                const safePage = (sec.page || `Sekce ${idx + 1}`).toString().replace(/</g, "&lt;");
                const safeText = (sec.text || "").replace(/</g, "&lt;");
                
                html += `
                    <div class="doc-viewer-section bg-slate-900 border ${isTarget ? 'border-sky-500 ring-2 ring-sky-500/30' : 'border-slate-800'} rounded-xl p-4 transition" data-text="${safeText.toLowerCase()}">
                        <div class="flex items-center justify-between pb-2 mb-3 border-b border-slate-800 text-xs">
                            <span class="font-mono font-bold ${isTarget ? 'text-sky-300' : 'text-slate-300'} flex items-center gap-1.5">
                                <span>📌</span> ${safePage}
                            </span>
                            <button onclick="copySnippetText(this)" data-content="${safeText.replace(/"/g, '&quot;')}" class="text-[11px] text-slate-400 hover:text-slate-200 bg-slate-800 hover:bg-slate-700 px-2 py-0.5 rounded border border-slate-700 transition">
                                📋 Kopírovat pasáž
                            </button>
                        </div>
                        <div class="text-slate-200 whitespace-pre-wrap font-sans text-xs leading-relaxed select-text">${safeText}</div>
                    </div>
                `;
            });

            textContent.innerHTML = html;

            // Pokud máme targetPage, zaskrollujeme k němu
            if (targetPage) {
                setTimeout(() => {
                    const targetEl = textContent.querySelector(".ring-2");
                    if (targetEl) targetEl.scrollIntoView({ behavior: "smooth", block: "center" });
                }, 100);
            }
        }

        function setDocViewerTab(tab) {
            docViewerCurrentTab = tab;
            const nativePane = document.getElementById("docViewerNativePane");
            const textPane = document.getElementById("docViewerTextPane");
            const btnNative = document.getElementById("docViewerTabNative");
            const btnText = document.getElementById("docViewerTabText");

            if (tab === "native") {
                if (nativePane) nativePane.classList.remove("hidden");
                if (textPane) textPane.classList.add("hidden");
                if (btnNative) {
                    btnNative.className = "px-2.5 py-1 rounded-md font-semibold text-slate-200 bg-sky-900/60 border border-sky-700 flex items-center gap-1.5 transition";
                }
                if (btnText) {
                    btnText.className = "px-2.5 py-1 rounded-md font-semibold text-slate-400 hover:text-slate-200 flex items-center gap-1.5 transition";
                }
            } else {
                if (nativePane) nativePane.classList.add("hidden");
                if (textPane) textPane.classList.remove("hidden");
                if (btnNative) {
                    btnNative.className = "px-2.5 py-1 rounded-md font-semibold text-slate-400 hover:text-slate-200 flex items-center gap-1.5 transition";
                }
                if (btnText) {
                    btnText.className = "px-2.5 py-1 rounded-md font-semibold text-slate-200 bg-sky-900/60 border border-sky-700 flex items-center gap-1.5 transition";
                }
            }
        }

        function toggleDocViewerFullscreen() {
            const box = document.getElementById("modalDocumentViewerBox");
            const btn = document.getElementById("docViewerBtnFullscreen");
            if (!box) return;

            const isFull = box.classList.contains("max-w-none");
            if (isFull) {
                box.classList.remove("max-w-none", "h-[98vh]", "w-[98vw]");
                box.classList.add("max-w-6xl", "h-[92vh]", "w-full");
                if (btn) btn.innerHTML = "⛶";
            } else {
                box.classList.remove("max-w-6xl", "h-[92vh]", "w-full");
                box.classList.add("max-w-none", "h-[98vh]", "w-[98vw]");
                if (btn) btn.innerHTML = "🗗";
            }
        }

        function filterDocViewerText() {
            const input = document.getElementById("docViewerTextSearch");
            const q = (input ? input.value : "").trim().toLowerCase();
            const sections = document.querySelectorAll(".doc-viewer-section");
            let visibleCount = 0;

            sections.forEach(sec => {
                const text = sec.getAttribute("data-text") || "";
                const matches = !q || text.includes(q);
                sec.style.display = matches ? "" : "none";
                if (matches) visibleCount++;
            });

            const sectionsCountEl = document.getElementById("docViewerSectionsCount");
            if (sectionsCountEl) {
                sectionsCountEl.textContent = q ? `Nalezeno ${visibleCount} z ${sections.length}` : `${sections.length} sekcí`;
            }
        }

        function copySnippetText(btn) {
            const content = btn.getAttribute("data-content") || "";
            navigator.clipboard.writeText(content);
            const origText = btn.innerHTML;
            btn.innerHTML = t("viewer.copiedBtn", "✅ Zkopírováno!");
            setTimeout(() => { btn.innerHTML = origText; }, 1500);
        }

        function copyDocViewerFullText() {
            if (!docViewerCurrentData || !docViewerCurrentData.sections) return;
            const full = docViewerCurrentData.sections.map(s => `--- ${s.page || 'Sekce'} ---\n${s.text}`).join("\n\n");
            navigator.clipboard.writeText(full);
            alert(t("chat.textCopied", "✅ Celý extrahovaný text dokumentu byl zkopírován do schránky."));
        }

        function closeDocumentViewer() {
            const modal = document.getElementById("modalDocumentViewer");
            const frame = document.getElementById("docViewerFrame");
            const box = document.getElementById("modalDocumentViewerBox");
            if (box && box.classList.contains("max-w-none")) {
                toggleDocViewerFullscreen(); // reset full screen
            }
            if (frame) frame.src = "about:blank";
            if (modal) modal.classList.add("hidden");
        }

        let viewerFilesCache = [];
        let viewerActiveFilename = "";
        let viewerActiveTabMode = "native"; // 'native' | 'text'
        let viewerCurrentExtFilter = "all";
        let isViewerFullScreen = false;
        let viewerCurrentPreviewData = null;

        // Čtecí a navigační stav
        let viewerCurrentPage = 1;
        let viewerTotalPages = 1;
        let viewerTextFontSize = parseInt(localStorage.getItem("medstudio_viewer_fontsize") || "16", 10);
        let viewerReadingTheme = localStorage.getItem("medstudio_viewer_theme") || "dark";
        let viewerPdfZoom = "page-width";
        let isViewerSidebarCollapsed = false;
        let viewerSearchMatches = [];
        let viewerSearchMatchIndex = -1;

        async function loadViewerFileList(force = false) {
            const label = document.getElementById("viewerProjectLabel");
            if (label) label.textContent = currentProject || "--";

            const badge = document.getElementById("sidebarFilesBadge");
            const countBadge = document.getElementById("viewerFileCountBadge");
            const list = document.getElementById("viewerFileList");

            if (!currentProject) {
                if (list) list.innerHTML = `<li class="text-slate-500 italic text-center py-8">Vyberte nebo vytvořte projekt.</li>`;
                if (countBadge) countBadge.textContent = "0";
                if (badge) badge.classList.add("hidden");
                resetViewerReaderState();
                return;
            }

            try {
                const res = await fetch(`/api/files?project=${encodeURIComponent(currentProject)}`);
                if (!res.ok) throw new Error("Chyba při stahování souborů");
                const data = await res.json();
                viewerFilesCache = data.files || [];

                if (countBadge) countBadge.textContent = viewerFilesCache.length;
                if (badge) {
                    badge.textContent = viewerFilesCache.length;
                    badge.classList.toggle("hidden", viewerFilesCache.length === 0);
                }

                renderViewerFilesList();

                // Automatický výběr prvního dokumentu, pokud dosud žádný není vybrán nebo byl smazán
                if (viewerFilesCache.length > 0) {
                    if (!viewerActiveFilename || !viewerFilesCache.includes(viewerActiveFilename)) {
                        selectViewerDocument(viewerFilesCache[0]);
                    }
                } else {
                    resetViewerReaderState();
                }
            } catch (err) {
                if (list) list.innerHTML = `<li class="text-red-400 text-center py-6">Chyba načítání: ${escapeHtml(err.message)}</li>`;
            }
        }

        function resetViewerReaderState() {
            viewerActiveFilename = "";
            viewerCurrentPage = 1;
            viewerTotalPages = 1;
            viewerCurrentPreviewData = null;

            const emptyState = document.getElementById("viewerEmptyState");
            const frame = document.getElementById("viewerNativeFrame");
            const textContent = document.getElementById("viewerTextContent");
            const activeTitle = document.getElementById("viewerActiveTitle");
            const activeExt = document.getElementById("viewerActiveExtBadge");
            const activeSize = document.getElementById("viewerActiveSizeBadge");
            const activeSec = document.getElementById("viewerActiveSectionsBadge");
            const textSearch = document.getElementById("viewerTextSearchBar");
            const pageInput = document.getElementById("viewerPageJumpInput");
            const totalDisplay = document.getElementById("viewerTotalPagesDisplay");
            const dropdown = document.getElementById("viewerChaptersDropdown");

            if (emptyState) emptyState.classList.remove("hidden");
            if (frame) { frame.classList.add("hidden"); frame.src = "about:blank"; }
            if (textContent) { textContent.classList.add("hidden"); textContent.innerHTML = ""; }
            if (activeTitle) activeTitle.textContent = "Vyberte dokument ze seznamu vlevo";
            if (activeExt) activeExt.classList.add("hidden");
            if (activeSize) activeSize.classList.add("hidden");
            if (activeSec) activeSec.classList.add("hidden");
            if (textSearch) textSearch.classList.add("hidden");
            if (pageInput) { pageInput.value = "1"; pageInput.max = "1"; }
            if (totalDisplay) totalDisplay.textContent = "--";
            if (dropdown) dropdown.innerHTML = `<option value="">${t("viewer.jumpToChapter", "-- Přejít na kapitolu / stranu --")}</option>`;
        }

        function toggleViewerSidebar(force) {
            const sidebar = document.getElementById("viewerSidebarPanel");
            const container = document.getElementById("viewerReaderContainer");
            const icon = document.getElementById("btnViewerToggleSidebarIcon");
            const txt = document.getElementById("btnViewerToggleSidebarText");
            if (!sidebar || !container) return;

            if (force !== undefined) {
                isViewerSidebarCollapsed = !force;
            } else {
                isViewerSidebarCollapsed = !isViewerSidebarCollapsed;
            }

            if (isViewerSidebarCollapsed) {
                sidebar.classList.add("hidden");
                container.classList.remove("lg:col-span-8", "xl:col-span-8.5");
                container.classList.add("col-span-12");
                if (icon) icon.textContent = "▶";
                if (txt) txt.textContent = "Podklady";
            } else {
                sidebar.classList.remove("hidden");
                container.classList.remove("col-span-12");
                container.classList.add("lg:col-span-8", "xl:col-span-8.5");
                if (icon) icon.textContent = "◀";
                if (txt) txt.textContent = "Podklady";
            }
        }

        function filterViewerByExtension(ext) {
            viewerCurrentExtFilter = ext;
            ["all", "pdf", "docx", "pptx", "txt"].forEach(t => {
                const btn = document.getElementById(`btnFilterExt-${t}`);
                if (btn) {
                    if (t === ext) {
                        btn.className = "px-2.5 py-1 rounded-lg bg-sky-900/80 text-sky-200 font-bold border border-sky-700 shrink-0 transition";
                    } else {
                        btn.className = "px-2.5 py-1 rounded-lg bg-slate-800 text-slate-400 hover:text-white border border-slate-700 shrink-0 transition";
                    }
                }
            });
            renderViewerFilesList();
        }

        function filterViewerFiles(term) {
            const clearBtn = document.getElementById("btnViewerFilesSearchClear");
            if (clearBtn) clearBtn.classList.toggle("hidden", !term || term.trim() === "");
            renderViewerFilesList();
        }

        function clearViewerFilesSearch() {
            const input = document.getElementById("viewerFilesSearchInput");
            const clearBtn = document.getElementById("btnViewerFilesSearchClear");
            if (input) input.value = "";
            if (clearBtn) clearBtn.classList.add("hidden");
            renderViewerFilesList();
        }

        function renderViewerFilesList() {
            const list = document.getElementById("viewerFileList");
            if (!list) return;

            const searchInput = document.getElementById("viewerFilesSearchInput");
            const query = (searchInput ? searchInput.value : "").trim().toLowerCase();

            let filtered = viewerFilesCache;
            if (viewerCurrentExtFilter !== "all") {
                filtered = filtered.filter(f => {
                    const ext = f.split('.').pop().toLowerCase();
                    if (viewerCurrentExtFilter === "pdf") return ext === "pdf";
                    if (viewerCurrentExtFilter === "docx") return ext === "docx" || ext === "doc";
                    if (viewerCurrentExtFilter === "pptx") return ext === "pptx" || ext === "ppt";
                    if (viewerCurrentExtFilter === "txt") return ext === "txt" || ext === "md";
                    return true;
                });
            }
            if (query) {
                filtered = filtered.filter(f => f.toLowerCase().includes(query));
            }

            if (filtered.length === 0) {
                list.innerHTML = `<li class="text-slate-500 italic text-center py-8">Nenalezeny žádné odpovídající soubory.</li>`;
                return;
            }

            let html = "";
            filtered.forEach(filename => {
                const ext = filename.split('.').pop().toLowerCase();
                let icon = "📄";
                let extBadge = ext.toUpperCase();
                let badgeColor = "bg-red-950/70 text-red-300 border-red-800/60";
                if (ext === "pptx" || ext === "ppt") {
                    icon = "📊"; extBadge = "PPTX"; badgeColor = "bg-amber-950/70 text-amber-300 border-amber-800/60";
                } else if (ext === "docx" || ext === "doc") {
                    icon = "📝"; extBadge = "DOCX"; badgeColor = "bg-blue-950/70 text-blue-300 border-blue-800/60";
                } else if (ext === "txt" || ext === "md") {
                    icon = "📋"; extBadge = ext.toUpperCase(); badgeColor = "bg-emerald-950/70 text-emerald-300 border-emerald-800/60";
                } else if (["png", "jpg", "jpeg", "webp"].includes(ext)) {
                    icon = "🖼️"; extBadge = ext.toUpperCase(); badgeColor = "bg-purple-950/70 text-purple-300 border-purple-800/60";
                }

                const isActive = filename === viewerActiveFilename;
                const safeNameAttr = escapeHtml(filename);
                const safeNameArg = encodeURIComponent(filename);
                const safeProjArg = encodeURIComponent(currentProject);

                html += `
                    <li class="flex items-center justify-between p-2 sm:p-2.5 rounded-xl border transition group cursor-pointer ${
                        isActive
                            ? 'bg-sky-950/70 border-sky-500 shadow-md ring-1 ring-sky-500/40'
                            : 'bg-slate-950/70 border-slate-800/80 hover:bg-slate-850 hover:border-slate-700'
                    }">
                        <div class="flex items-start gap-2.5 pr-2 min-w-0 flex-1" onclick="selectViewerDocument(decodeURIComponent('${escapeJsStringAttr(safeNameArg)}'))" title="${safeNameAttr}">
                            <span class="text-base shrink-0 mt-0.5">${icon}</span>
                            <div class="min-w-0 flex-1">
                                <div class="text-xs font-semibold leading-snug line-clamp-2 break-words ${isActive ? 'text-sky-200 font-bold' : 'text-slate-300 group-hover:text-white'} transition">
                                    ${safeNameAttr}
                                </div>
                                <div class="flex items-center gap-1.5 mt-1 text-[9px] text-slate-500 font-mono">
                                    <span class="px-1.5 py-0.2 rounded border uppercase font-bold ${badgeColor}">${extBadge}</span>
                                </div>
                            </div>
                        </div>
                        <div class="flex items-center gap-1 shrink-0">
                            <a href="/api/files/${safeProjArg}/${safeNameArg}/view" target="_blank" rel="noopener noreferrer" class="text-slate-400 hover:text-sky-300 p-1.5 rounded-lg hover:bg-slate-800 text-xs transition inline-flex items-center" title="Otevřít originál v nové záložce">
                                ↗
                            </a>
                            <button type="button" onclick="deleteFileFromViewer(decodeURIComponent('${escapeJsStringAttr(safeNameArg)}'))" class="text-slate-500 hover:text-red-400 p-1.5 rounded-lg hover:bg-slate-800 text-xs transition" title="Smazat soubor">
                                🗑️
                            </button>
                        </div>
                    </li>
                `;
            });
            list.innerHTML = html;
        }

        async function selectViewerDocument(filename, page = 1) {
            if (!filename || !currentProject) return;
            viewerActiveFilename = filename;
            viewerCurrentPage = parseInt(page, 10) || 1;
            renderViewerFilesList();

            const ext = filename.split('.').pop().toLowerCase();
            const safeProj = encodeURIComponent(currentProject);
            const safeFile = encodeURIComponent(filename);
            const zoomParam = viewerPdfZoom ? `&zoom=${viewerPdfZoom}` : '';
            const viewUrl = `/api/files/${safeProj}/${safeFile}/view#page=${viewerCurrentPage}${zoomParam}`;

            // Update header
            const emptyState = document.getElementById("viewerEmptyState");
            const iconEl = document.getElementById("viewerActiveIcon");
            const titleEl = document.getElementById("viewerActiveTitle");
            const extBadge = document.getElementById("viewerActiveExtBadge");
            const extBtn = document.getElementById("btnViewerExternal");
            const dlBtn = document.getElementById("btnViewerDownload");
            const frame = document.getElementById("viewerNativeFrame");
            const loader = document.getElementById("viewerLoadingSpinner");
            const loaderText = document.getElementById("viewerLoadingText");
            const pageInput = document.getElementById("viewerPageJumpInput");

            if (emptyState) emptyState.classList.add("hidden");

            let icon = "📄";
            if (ext === "pptx" || ext === "ppt") icon = "📊";
            else if (ext === "docx" || ext === "doc") icon = "📝";
            else if (ext === "txt" || ext === "md") icon = "📋";
            else if (["png", "jpg", "jpeg", "webp"].includes(ext)) icon = "🖼️";

            if (iconEl) iconEl.textContent = icon;
            if (titleEl) {
                titleEl.textContent = filename;
                titleEl.title = filename;
            }
            if (extBadge) {
                extBadge.textContent = ext.toUpperCase();
                extBadge.classList.remove("hidden");
            }
            if (extBtn) extBtn.href = viewUrl;
            if (dlBtn) {
                dlBtn.href = `/api/files/${safeProj}/${safeFile}/view`;
                dlBtn.setAttribute("download", filename);
            }
            if (pageInput) pageInput.value = viewerCurrentPage;

            const isOffice = ["docx", "doc", "pptx", "ppt"].includes(ext);

            if (isOffice) {
                // Office soubory neumí prohlížeč vykreslit nativně v iframe -> přepnout na extrahovaný text (RAG)
                setSectionViewerTab("text");
                if (frame) frame.src = "about:blank";
            } else {
                if (viewerActiveTabMode !== "text") {
                    setSectionViewerTab("native");
                } else {
                    setSectionViewerTab("text");
                }

                if (viewerActiveTabMode === "native") {
                    if (loader) {
                        if (loaderText) loaderText.textContent = t("viewer.loadingFile", "Načítám soubor do čtečky...");
                        loader.classList.remove("hidden");
                    }
                    if (frame) {
                        frame.onload = () => {
                            if (loader) loader.classList.add("hidden");
                        };
                        frame.src = viewUrl;
                    }
                }
            }

            // Asynchronně načíst strukturovaný náhled a metadata stran
            await fetchViewerDocumentPreview(currentProject, filename, viewerCurrentPage);
        }

        async function fetchViewerDocumentPreview(project, filename, targetPage = 1) {
            const safeProj = encodeURIComponent(project);
            const safeFile = encodeURIComponent(filename);
            const sizeBadge = document.getElementById("viewerActiveSizeBadge");
            const sectionsBadge = document.getElementById("viewerActiveSectionsBadge");
            const textContent = document.getElementById("viewerTextContent");
            const totalDisplay = document.getElementById("viewerTotalPagesDisplay");
            const pageInput = document.getElementById("viewerPageJumpInput");
            const dropdown = document.getElementById("viewerChaptersDropdown");
            const searchInput = document.getElementById("viewerTextSearchInput");
            if (searchInput) searchInput.value = "";

            try {
                const res = await fetch(`/api/files/${safeProj}/${safeFile}/preview`);
                if (!res.ok) throw new Error("Nelze načíst textový náhled.");
                const data = await res.json();
                viewerCurrentPreviewData = data;

                // Celkový počet stran
                viewerTotalPages = Math.max(data.total_pages || 1, (data.sections && data.sections.length) || 1);
                if (totalDisplay) totalDisplay.textContent = viewerTotalPages;
                if (pageInput) {
                    pageInput.max = viewerTotalPages;
                    pageInput.value = viewerCurrentPage;
                }

                if (sizeBadge && data.size_bytes) {
                    const kb = (data.size_bytes / 1024).toFixed(1);
                    const mb = (data.size_bytes / (1024 * 1024)).toFixed(2);
                    sizeBadge.textContent = data.size_bytes > 1024 * 1024 ? `${mb} MB` : `${kb} KB`;
                    sizeBadge.classList.remove("hidden");
                }

                if (sectionsBadge && data.sections) {
                    const cnt = data.sections.length;
                    sectionsBadge.textContent = `${viewerTotalPages} ${viewerTotalPages === 1 ? 'strana' : (viewerTotalPages < 5 ? 'strany' : 'stran')} (${cnt} ${cnt === 1 ? 'sekce' : (cnt < 5 ? 'sekce' : 'sekcí')})`;
                    sectionsBadge.classList.remove("hidden");
                }

                // Naplnit dropdown osnovy kapitol / stran
                if (dropdown) {
                    dropdown.innerHTML = `<option value="">${t("viewer.jumpToChapter", "-- Přejít na kapitolu / stranu --")}</option>`;
                    if (data.sections && data.sections.length > 0) {
                        data.sections.forEach((sec, idx) => {
                            const pNum = sec.page_number || (idx + 1);
                            const pLabel = sec.page || `Strana ${pNum}`;
                            let snippet = (sec.text || "").replace(/\s+/g, " ").trim();
                            if (snippet.length > 40) snippet = snippet.slice(0, 40) + "...";
                            const opt = document.createElement("option");
                            opt.value = pNum;
                            opt.textContent = `${pLabel}: ${snippet || 'Sekce ' + (idx + 1)}`;
                            dropdown.appendChild(opt);
                        });
                    } else if (viewerTotalPages > 1) {
                        for (let i = 1; i <= Math.min(viewerTotalPages, 200); i++) {
                            const opt = document.createElement("option");
                            opt.value = i;
                            opt.textContent = `Strana ${i} z ${viewerTotalPages}`;
                            dropdown.appendChild(opt);
                        }
                    }
                }

                renderViewerSections(data.sections, targetPage);
            } catch (err) {
                if (textContent) {
                    textContent.innerHTML = `<div class="p-4 bg-red-950/40 border border-red-800 rounded-xl text-red-300 text-xs">Nelze načíst strukturovaný náhled: ${escapeHtml(err.message)}</div>`;
                }
            }
        }

        function renderViewerSections(sections, targetPage = 1) {
            const textContent = document.getElementById("viewerTextContent");
            if (!textContent) return;

            if (!sections || sections.length === 0) {
                textContent.innerHTML = `<div class="p-8 text-center text-slate-500 italic">${t("viewer.noTextFound", "V tomto dokumentu nebyl nalezen žádný strojově čitelný text.")}</div>`;
                return;
            }

            let html = "";
            sections.forEach((sec, idx) => {
                const pageNum = sec.page_number || (idx + 1);
                const isTarget = targetPage && (String(pageNum) === String(targetPage) || String(sec.page).includes(String(targetPage)));
                const safePage = (sec.page || `Strana ${pageNum}`).toString().replace(/</g, "&lt;");
                const safeText = (sec.text || "").replace(/</g, "&lt;");

                html += `
                    <div class="viewer-section-card bg-slate-900 border ${isTarget ? 'border-sky-500 ring-2 ring-sky-500/40' : 'border-slate-800'} rounded-xl p-4 transition" data-text="${safeText.toLowerCase()}" data-page-num="${pageNum}" data-page="${safePage}">
                        <div class="flex items-center justify-between pb-2 mb-3 border-b border-slate-800 text-xs flex-wrap gap-2">
                            <span class="font-mono font-bold ${isTarget ? 'text-sky-300' : 'text-slate-300'} flex items-center gap-1.5 cursor-pointer hover:text-sky-300 transition" onclick="jumpToViewerPage(${pageNum})" title="Přejít na stranu ${pageNum}">
                                <span>📌</span> ${safePage}
                            </span>
                            <div class="flex items-center gap-1.5">
                                <button type="button" onclick="jumpToViewerPage(${pageNum})" class="text-[11px] text-slate-400 hover:text-sky-300 bg-slate-800 hover:bg-slate-700 px-2 py-0.5 rounded border border-slate-700 transition" title="Označit tuto stranu jako aktuální">
                                    Strana ${pageNum}
                                </button>
                                <button type="button" onclick="copySnippetText(this)" data-content="${safeText.replace(/"/g, '&quot;')}" class="text-[11px] text-slate-400 hover:text-slate-200 bg-slate-800 hover:bg-slate-700 px-2 py-0.5 rounded border border-slate-700 transition">
                                    📋 Kopírovat pasáž
                                </button>
                            </div>
                        </div>
                        <div class="viewer-card-body text-slate-200 whitespace-pre-wrap font-sans leading-relaxed select-text" style="font-size: ${viewerTextFontSize}px; line-height: ${viewerTextFontSize * 1.6}px;">${safeText}</div>
                    </div>
                `;
            });

            textContent.innerHTML = html;

            // Uplatnit čtecí téma a velikost písma
            setViewerReadingTheme(viewerReadingTheme);

            if (targetPage) {
                setTimeout(() => {
                    const targetEl = textContent.querySelector(`[data-page-num="${targetPage}"]`) || textContent.querySelector(".ring-2");
                    if (targetEl) targetEl.scrollIntoView({ behavior: "smooth", block: "start" });
                }, 100);
            }
        }

        function setSectionViewerTab(tab) {
            viewerActiveTabMode = tab;
            const nativePane = document.getElementById("viewerNativeFrame");
            const textPane = document.getElementById("viewerTextContent");
            const textSearchBar = document.getElementById("viewerTextSearchBar");
            const btnNative = document.getElementById("btnViewerTabNative");
            const btnText = document.getElementById("btnViewerTabText");
            const emptyState = document.getElementById("viewerEmptyState");
            const pdfTools = document.getElementById("viewerPdfTools");
            const textTools = document.getElementById("viewerTextTools");
            const themeTools = document.getElementById("viewerThemeTools");

            if (!viewerActiveFilename) return;
            if (emptyState) emptyState.classList.add("hidden");

            const ext = viewerActiveFilename.split('.').pop().toLowerCase();
            const isPdf = ext === "pdf";

            if (tab === "native") {
                if (nativePane) nativePane.classList.remove("hidden");
                if (textPane) textPane.classList.add("hidden");
                if (textSearchBar) textSearchBar.classList.add("hidden");

                if (btnNative) {
                    btnNative.className = "px-2.5 py-1 rounded-lg text-xs font-bold bg-sky-900/80 text-sky-200 border border-sky-700 transition flex items-center gap-1";
                }
                if (btnText) {
                    btnText.className = "px-2.5 py-1 rounded-lg text-xs font-semibold text-slate-400 hover:text-white transition flex items-center gap-1";
                }

                // Zobrazit PDF nástroje, skrýt textové
                if (pdfTools) {
                    if (isPdf) {
                        pdfTools.classList.remove("hidden");
                        pdfTools.classList.add("flex");
                    } else {
                        pdfTools.classList.add("hidden");
                        pdfTools.classList.remove("flex");
                    }
                }
                if (textTools) {
                    textTools.classList.add("hidden");
                    textTools.classList.remove("flex");
                }
                if (themeTools) {
                    themeTools.classList.add("hidden");
                    themeTools.classList.remove("flex");
                }

                // Pokud je iframe prázdný, nastavíme URL s aktuální stranou a zoomem
                if (nativePane && (!nativePane.src || nativePane.src.includes("about:blank"))) {
                    const safeProj = encodeURIComponent(currentProject);
                    const safeFile = encodeURIComponent(viewerActiveFilename);
                    const zoomParam = viewerPdfZoom ? `&zoom=${viewerPdfZoom}` : '';
                    nativePane.src = `/api/files/${safeProj}/${safeFile}/view#page=${viewerCurrentPage}${zoomParam}`;
                }
            } else {
                if (nativePane) nativePane.classList.add("hidden");
                if (textPane) textPane.classList.remove("hidden");
                if (textSearchBar) textSearchBar.classList.remove("hidden");

                if (btnNative) {
                    btnNative.className = "px-2.5 py-1 rounded-lg text-xs font-semibold text-slate-400 hover:text-white transition flex items-center gap-1";
                }
                if (btnText) {
                    btnText.className = "px-2.5 py-1 rounded-lg text-xs font-bold bg-sky-900/80 text-sky-200 border border-sky-700 transition flex items-center gap-1";
                }

                // Skrýt PDF nástroje, zobrazit textové nástroje a témata
                if (pdfTools) {
                    pdfTools.classList.add("hidden");
                    pdfTools.classList.remove("flex");
                }
                if (textTools) {
                    textTools.classList.remove("hidden");
                    textTools.classList.add("flex");
                }
                if (themeTools) {
                    themeTools.classList.remove("hidden");
                    themeTools.classList.add("flex");
                }
            }
        }

