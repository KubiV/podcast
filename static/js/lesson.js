// =========================================================================
// Výuková lekce od A do Z (odděleno z app.js, krok 3.5). Klasický skript:
// sdílí globální scope s app.js; pořadí načítání je dané v index.html.
// =========================================================================

        // =========================================================================
        // NOVÝ MODUL: VÝUKOVÁ LEKCE OD A DO Z (EDUCATIONAL LECTURE)
        // =========================================================================
        let selectedLessonFiles = [];
        let allLessonsList = [];
        let currentLessonData = null;

        function openNewLessonModal() {
            const modal = document.getElementById("modalNewLesson");
            if (!modal) return;
            modal.classList.remove("hidden");
            document.getElementById("newLessonProgressPanel").classList.add("hidden");
            document.getElementById("btnSubmitNewLesson").disabled = false;
            document.getElementById("btnCancelLessonModal").disabled = false;
            selectedLessonFiles = [];
            renderSelectedLessonFilesPreview();
            document.getElementById("newLessonTitle").value = "";
            document.getElementById("newLessonTitle").placeholder = typeof t === "function" ? t("modal.newLesson.topicPlaceholder", "Zadejte téma výukové lekce (např. Cévní mozková příhoda, Sepse)...") : "Zadejte téma výukové lekce (např. Cévní mozková příhoda, Sepse)...";
            
            const lessonLangMap = { cs: "Čeština", en: "English", fr: "Français" };
            const lessonLangSelect = document.getElementById("newLessonLanguage");
            if (lessonLangSelect && lessonLangMap[currentLanguage]) {
                lessonLangSelect.value = lessonLangMap[currentLanguage];
            }

            if (typeof syncQuestionsDropdowns === "function") {
                syncQuestionsDropdowns();
            }
        }

        function closeNewLessonModal() {
            const modal = document.getElementById("modalNewLesson");
            if (modal) modal.classList.add("hidden");
        }

        function onNewLessonTTSProviderChange() {
            const provider = document.getElementById("newLessonTTSProvider").value;
            const voiceSelect = document.getElementById("newLessonTTSVoice");
            if (!voiceSelect) return;
            if (provider === "elevenlabs") {
                voiceSelect.innerHTML = `
                    <option value="21m00Tcm4TlvDq8ikWAM" selected>Rachel (Přirozená, expresivní přednášející)</option>
                    <option value="AZnzlk1XvdvUeBnXmlld">Domi (Mladá, energická pedagožka)</option>
                    <option value="EXAVITQu4vr4xnSDxMaL">Bella (Kultivovaný akademický projev)</option>
                    <option value="ErXwobaYiN019PkySvjV">Antoni (Klidný a vyrovnaný profesor)</option>
                    <option value="MF3mGyEYCl7XYWbV9V6O">Elli (Čistý a jasný ženský hlas)</option>
                    <option value="TxGEqnHWrfWFTfGW9XjX">Josh (Hluboký, poutavý přednášející)</option>
                    <option value="VR6AewLTigWG4xSOukaG">Arnold (Autoritativní starší profesor)</option>
                `;
            } else {
                voiceSelect.innerHTML = `
                    <option value="onyx" selected>Onyx (Hluboký, autoritativní profesor)</option>
                    <option value="echo">Echo (Vyrovnaný, energický přednášející)</option>
                    <option value="alloy">Alloy (Neutrální, jasný akademický tón)</option>
                    <option value="fable">Fable (Poutavý britský tón)</option>
                    <option value="nova">Nova (Kultivovaný ženský přednáškový hlas)</option>
                    <option value="shimmer">Shimmer (Jasný, expresivní ženský hlas)</option>
                `;
            }
        }

        function onNewLessonFilesSelected(e) {
            const files = e.target.files;
            if (!files || files.length === 0) return;
            for (let i = 0; i < files.length; i++) {
                selectedLessonFiles.push(files[i]);
            }
            renderSelectedLessonFilesPreview();
            e.target.value = "";
        }

        function removeSelectedLessonFile(index) {
            selectedLessonFiles.splice(index, 1);
            renderSelectedLessonFilesPreview();
        }

        function renderSelectedLessonFilesPreview() {
            const container = document.getElementById("newLessonFilesPreviewList");
            if (!container) return;
            if (!selectedLessonFiles || selectedLessonFiles.length === 0) {
                container.innerHTML = "";
                return;
            }

            container.innerHTML = selectedLessonFiles.map((f, idx) => {
                const sizeKb = (f.size / 1024).toFixed(0);
                const ext = f.name.split('.').pop().toUpperCase();
                return `
                    <div class="flex justify-between items-center bg-slate-900 px-3 py-1.5 rounded-lg border border-slate-800 text-xs">
                        <div class="flex items-center gap-2 truncate">
                            <span class="text-[10px] font-bold bg-slate-800 text-teal-300 px-1.5 py-0.5 rounded border border-slate-700">${ext}</span>
                            <span class="text-slate-200 truncate font-medium">${escapeHtml(f.name)}</span>
                            <span class="text-slate-500 text-[10px]">(${sizeKb} KB)</span>
                        </div>
                        <button onclick="removeSelectedLessonFile(${idx})" class="text-slate-400 hover:text-red-400 px-1 font-bold">✕</button>
                    </div>
                `;
            }).join("");
        }

        async function submitGenerateLesson() {
            const title = (document.getElementById("newLessonTitle").value || "").trim();
            if (!title) {
                alert(t("lesson.fillTopic", "Vyplňte prosím téma nebo název výukové lekce."));
                return;
            }
            if (!selectedLessonFiles || selectedLessonFiles.length === 0) {
                alert(t("lesson.uploadSourceFirst", "Nahrajte alespoň jeden soubor s podklady (PDF, sken, obrázek)."));
                return;
            }

            const targetLang = document.getElementById("newLessonLanguage").value;
            const model = document.getElementById("newLessonModel").value;
            const ttsProvider = document.getElementById("newLessonTTSProvider").value;
            const ttsVoice = document.getElementById("newLessonTTSVoice").value;

            const progressPanel = document.getElementById("newLessonProgressPanel");
            progressPanel.classList.remove("hidden");
            document.getElementById("btnSubmitNewLesson").disabled = true;
            document.getElementById("btnCancelLessonModal").disabled = true;

            const progressBar = document.getElementById("newLessonProgressBar");
            const stageLabel = document.getElementById("newLessonProgressStageLabel");
            const pctLabel = document.getElementById("newLessonProgressPctLabel");
            const statusText = document.getElementById("newLessonProgressStatusText");

            progressBar.style.width = "10%";
            stageLabel.textContent = t("lesson.sendingFiles", "Odesílám soubory...");
            pctLabel.textContent = "10%";
            statusText.textContent = t("lesson.uploadingToServer", "Nahrávám podklady na server...");

            const formData = new FormData();
            formData.append("title", title);
            formData.append("target_language", targetLang);
            formData.append("gemini_model", model);
            formData.append("tts_provider", ttsProvider);
            formData.append("tts_voice", ttsVoice);
            selectedLessonFiles.forEach(f => {
                formData.append("files", sanitizeFile(f));
            });

            try {
                const res = await fetch("/api/lessons/generate", {
                    method: "POST",
                    body: formData,
                });

                if (!res.ok) {
                    let errDetail = `Chyba serveru (${res.status})`;
                    try {
                        const err = await res.json();
                        errDetail = err.detail || "Chyba při generování lekce.";
                    } catch (e) {
                        // Někdy může server vrátit HTML (např. 413 Payload Too Large)
                    }
                    throw new Error(errDetail);
                }

                const data = await res.json();
                progressBar.style.width = "100%";
                stageLabel.textContent = t("lesson.completedTitle", "Dokončeno! 🎉");
                pctLabel.textContent = "100%";
                statusText.textContent = "Lekce úspěšně vytvořena. Otevírám prohlížeč lekce...";

                setTimeout(async () => {
                    closeNewLessonModal();
                    switchTab("lesson");
                    await loadLessonsList(data.project_id);
                }, 1200);

            } catch (err) {
                progressBar.classList.add("bg-red-500");
                stageLabel.textContent = t("lesson.errorProcessing", "Chyba při zpracování ❌");
                statusText.textContent = err.message;
                document.getElementById("btnSubmitNewLesson").disabled = false;
                document.getElementById("btnCancelLessonModal").disabled = false;
            }
        }

        function handleLessonProgressEvent(data) {
            const progressBar = document.getElementById("newLessonProgressBar");
            const stageLabel = document.getElementById("newLessonProgressStageLabel");
            const pctLabel = document.getElementById("newLessonProgressPctLabel");
            const statusText = document.getElementById("newLessonProgressStatusText");

            if (!progressBar) return;
            const pct = data.percentage || 0;
            progressBar.style.width = `${pct}%`;
            if (pctLabel) pctLabel.textContent = `${pct}%`;
            if (statusText && data.message) statusText.textContent = data.message;

            const stageNames = {
                "extracting": "1/4 Ingesce & Multimodální OCR",
                "generating_markdown": "2/4 Generování studijního textu (Markdown)",
                "generating_lecture": "3/4 Tvorba scénáře přednášky",
                "synthesizing_audio": "4/4 Syntéza mluveného audia (TTS)",
                "finalizing": "Dokončuji kapitoly a ukládám...",
                "complete": "Hotovo!",
            };
            if (stageLabel && data.step && stageNames[data.step]) {
                stageLabel.textContent = stageNames[data.step];
            }
        }

        async function loadLessonsList(autoSelectProjectId = null) {
            try {
                const res = await fetch("/api/lessons");
                const data = await res.json();
                allLessonsList = data.lessons || [];

                const sel = document.getElementById("lessonSelect");
                if (!sel) return;
                sel.innerHTML = '<option value="">-- Vyberte lekci --</option>';

                allLessonsList.forEach(l => {
                    const opt = document.createElement("option");
                    opt.value = l.project_id;
                    opt.textContent = `${l.title} (${l.target_language || 'CZ'})`;
                    sel.appendChild(opt);
                });

                const targetProj = autoSelectProjectId || (allLessonsList.length > 0 ? allLessonsList[0].project_id : null);
                if (targetProj) {
                    sel.value = targetProj;
                    await onLessonSelectChange();
                } else {
                    renderEmptyLessonViewer();
                }
            } catch (err) {
                console.error("Chyba při načítání lekcí:", err);
            }
        }

        async function onLessonSelectChange() {
            const sel = document.getElementById("lessonSelect");
            const projId = sel ? sel.value : "";
            if (!projId) {
                renderEmptyLessonViewer();
                return;
            }

            try {
                const res = await fetch(`/api/lessons/${encodeURIComponent(projId)}`);
                if (!res.ok) throw new Error("Lekce nenalezena.");
                const data = await res.json();
                currentLessonData = data.lesson;
                renderLessonDetails(currentLessonData);
            } catch (err) {
                alert(`Chyba při načítání detailu lekce: ${err.message}`);
            }
        }

        function renderLessonDetails(lesson) {
            if (!lesson) return;

            document.getElementById("lessonViewerHeaderTitle").textContent = lesson.title || "Výuková lekce";
            document.getElementById("lessonLanguageBadge").textContent = lesson.target_language || "Čeština";

            const mdContainer = document.getElementById("lessonMarkdownRendered");
            try {
                mdContainer.innerHTML = renderMarkdownWithKaTeX(lesson.markdown_content || "");
            } catch (e) {
                mdContainer.textContent = lesson.markdown_content || "";
            }

            const audioPlayer = document.getElementById("lessonAudioPlayer");
            audioPlayer.src = lesson.audio_url || "";
            document.getElementById("btnLessonPlayPause").disabled = !lesson.audio_url;
            document.getElementById("lessonAudioScrubber").disabled = !lesson.audio_url;
            document.getElementById("btnDownloadLessonMd").disabled = false;
            document.getElementById("btnAskChatLesson").disabled = false;
            document.getElementById("btnDeleteLesson").disabled = false;

            renderLessonChapters(lesson.chapters || []);

            const scriptText = document.getElementById("lessonScriptText") || document.getElementById("lessonScriptBody");
            if (scriptText) scriptText.textContent = lesson.lecture_script || "Scénář není k dispozici.";

            if (window.lessonSearcher) {
                const q = document.getElementById("lessonSearchInput")?.value?.trim();
                if (q) window.lessonSearcher.search(q);
                else window.lessonSearcher.clearHighlights();
            }
            if (window.lessonScriptSearcher) {
                const sq = document.getElementById("lessonScriptSearchInput")?.value?.trim();
                if (sq) window.lessonScriptSearcher.search(sq);
                else window.lessonScriptSearcher.clearHighlights();
            }
        }

        function renderLessonChapters(chapters) {
            const container = document.getElementById("lessonChaptersList");
            const countLabel = document.getElementById("lessonChaptersCountLabel");
            if (countLabel) countLabel.textContent = `${chapters.length} kapitol`;

            if (!chapters || chapters.length === 0) {
                container.innerHTML = '<div class="p-3 text-center text-xs text-slate-500 italic bg-slate-900/60 rounded-lg border border-slate-800">Žádné kapitoly k zobrazení.</div>';
                return;
            }

            container.innerHTML = chapters.map((ch, idx) => `
                <div onclick="playLessonChapter(${Number(ch.seconds) || 0})" id="chapterItem-${idx}" class="chapter-item cursor-pointer p-2 rounded-lg bg-slate-900/80 hover:bg-slate-750 border border-slate-800 hover:border-teal-500/50 flex items-center justify-between transition group">
                    <div class="flex items-center gap-2 truncate">
                        <span class="text-xs font-mono font-bold bg-slate-800 group-hover:bg-teal-900 group-hover:text-teal-300 text-teal-400 px-2 py-0.5 rounded border border-slate-700 transition">
                            ${escapeHtml(ch.time || '00:00')}
                        </span>
                        <span class="text-xs font-medium text-slate-200 group-hover:text-white truncate">
                            ${escapeHtml(ch.title || `Kapitola ${idx + 1}`)}
                        </span>
                    </div>
                    <span class="text-xs text-slate-500 group-hover:text-teal-400 shrink-0 ml-2">▶</span>
                </div>
            `).join("");
        }

        function renderEmptyLessonViewer() {
            document.getElementById("lessonViewerHeaderTitle").textContent = t("lesson.defaultTitle", "Výuková lekce od A do Z");
            document.getElementById("lessonMarkdownRendered").innerHTML = `
                <div class="flex flex-col items-center justify-center h-64 text-center text-slate-500">
                    <span class="text-4xl mb-2">🎓</span>
                    <p class="text-sm font-semibold">Žádná lekce není vybrána.</p>
                    <p class="text-xs text-slate-400 mt-1">Zvolte lekci ze seznamu nebo vytvořte novou kliknutím na "➕ Nová lekce".</p>
                </div>
            `;
            document.getElementById("btnLessonPlayPause").disabled = true;
            document.getElementById("lessonAudioScrubber").disabled = true;
            document.getElementById("btnDownloadLessonMd").disabled = true;
            document.getElementById("btnAskChatLesson").disabled = true;
            document.getElementById("btnDeleteLesson").disabled = true;
            document.getElementById("lessonChaptersList").innerHTML = '<div class="p-3 text-center text-xs text-slate-500 italic bg-slate-900/60 rounded-lg border border-slate-800">Žádné kapitoly k zobrazení.</div>';

            if (window.lessonSearcher) window.lessonSearcher.clearHighlights();
            if (window.lessonScriptSearcher) window.lessonScriptSearcher.clearHighlights();
        }

        function toggleLessonAudioPlay() {
            const player = document.getElementById("lessonAudioPlayer");
            const icon = document.getElementById("lessonPlayIcon");
            if (player.paused) {
                player.play();
                icon.textContent = "⏸";
            } else {
                player.pause();
                icon.textContent = "▶";
            }
        }

        function onLessonAudioTimeUpdate() {
            const player = document.getElementById("lessonAudioPlayer");
            const scrubber = document.getElementById("lessonAudioScrubber");
            const curDisplay = document.getElementById("lessonCurrentTimeDisplay");
            const totDisplay = document.getElementById("lessonTotalTimeDisplay");
            const durBadge = document.getElementById("lessonAudioDurationBadge");

            if (!player.duration || isNaN(player.duration)) return;

            const pct = (player.currentTime / player.duration) * 100;
            scrubber.value = pct;

            const curMin = Math.floor(player.currentTime / 60);
            const curSec = Math.floor(player.currentTime % 60);
            const totMin = Math.floor(player.duration / 60);
            const totSec = Math.floor(player.duration % 60);

            const curFormatted = `${String(curMin).padStart(2, '0')}:${String(curSec).padStart(2, '0')}`;
            const totFormatted = `${String(totMin).padStart(2, '0')}:${String(totSec).padStart(2, '0')}`;

            curDisplay.textContent = curFormatted;
            totDisplay.textContent = totFormatted;
            if (durBadge) durBadge.textContent = totFormatted;

            if (currentLessonData && currentLessonData.chapters) {
                const chapters = currentLessonData.chapters;
                let activeIdx = 0;
                for (let i = 0; i < chapters.length; i++) {
                    if (player.currentTime >= chapters[i].seconds) {
                        activeIdx = i;
                    }
                }
                chapters.forEach((_, idx) => {
                    const el = document.getElementById(`chapterItem-${idx}`);
                    if (el) {
                        if (idx === activeIdx) {
                            el.classList.add("border-teal-400", "bg-teal-950/30");
                        } else {
                            el.classList.remove("border-teal-400", "bg-teal-950/30");
                        }
                    }
                });
            }
        }

        function onLessonScrubberInput() {
            const player = document.getElementById("lessonAudioPlayer");
            const scrubber = document.getElementById("lessonAudioScrubber");
            if (player.duration) {
                player.currentTime = (scrubber.value / 100) * player.duration;
            }
        }

        function onLessonAudioEnded() {
            const icon = document.getElementById("lessonPlayIcon");
            if (icon) icon.textContent = "▶";
        }

        function playLessonChapter(seconds) {
            const player = document.getElementById("lessonAudioPlayer");
            const icon = document.getElementById("lessonPlayIcon");
            player.currentTime = seconds;
            player.play();
            if (icon) icon.textContent = "⏸";
        }

        function setLessonPlaybackRate(rate) {
            const player = document.getElementById("lessonAudioPlayer");
            player.playbackRate = rate;
            const buttons = document.querySelectorAll(".lesson-rate-btn");
            buttons.forEach(b => {
                if (b.textContent.includes(`${rate}x`)) {
                    b.className = "lesson-rate-btn text-[10px] px-2 py-0.5 rounded bg-teal-900 text-teal-300 font-mono font-bold transition border border-teal-700";
                } else {
                    b.className = "lesson-rate-btn text-[10px] px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 font-mono transition";
                }
            });
        }

        function toggleLessonScript() {
            const body = document.getElementById("lessonScriptBody");
            const arrow = document.getElementById("lessonScriptToggleArrow");
            body.classList.toggle("hidden");
            if (body.classList.contains("hidden")) {
                arrow.textContent = "▼";
            } else {
                arrow.textContent = "▲";
            }
        }

        function downloadLessonMarkdown() {
            if (!currentLessonData || !currentLessonData.markdown_content) return;
            const blob = new Blob([currentLessonData.markdown_content], { type: "text/markdown;charset=utf-8" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `lekce_${currentLessonData.project_id || 'material'}.md`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }

        function openChatForCurrentLesson() {
            if (!currentLessonData || !currentLessonData.project_id) return;
            activeLessonChatContext = {
                id: currentLessonData.project_id,
                title: currentLessonData.title || "Výuková lekce"
            };
            switchTab("chat");
        }

        async function deleteSelectedLesson() {
            if (!currentLessonData || !currentLessonData.project_id) return;
            const projId = currentLessonData.project_id;
            if (!confirm(`Opravdu chcete smazat výukovou lekci "${currentLessonData.title}"?`)) return;

            try {
                await fetch(`/api/lessons/${encodeURIComponent(projId)}`, { method: "DELETE" });
                if (activeLessonChatContext && activeLessonChatContext.id === projId) {
                    activeLessonChatContext = null;
                }
                currentLessonData = null;
                await loadLessonsList();
            } catch (err) {
                alert(`Chyba při mazání lekce: ${err.message}`);
            }
        }

