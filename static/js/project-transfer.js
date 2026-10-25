// =========================================================================
// Sdílení projektů: export a import .medproj / .zip (odděleno z app.js, krok 3.5). Klasický skript:
// sdílí globální scope s app.js; pořadí načítání je dané v index.html.
// =========================================================================

        // =========================================================================
        // SDÍLENÍ PROJEKTŮ: EXPORT A IMPORT SOUBORŮ .MEDPROJ / .ZIP
        // =========================================================================

        let currentExportTargetProject = "";
        let currentImportFile = null;
        let currentImportInspectData = null;

        async function openProjectExportModal(projectName) {
            const target = projectName || currentProject;
            if (!target) {
                alert(t("project.export.selectFirst", "Nejprve vyberte projekt k exportu."));
                return;
            }

            currentExportTargetProject = target;
            const modal = document.getElementById("modalProjectExport");
            if (!modal) return;

            modal.classList.remove("hidden");
            const badge = document.getElementById("exportProjectBadge");
            if (badge) badge.textContent = target;

            const loadingState = document.getElementById("exportLoadingState");
            const contentState = document.getElementById("exportContentState");
            if (loadingState) loadingState.classList.remove("hidden");
            if (contentState) contentState.classList.add("hidden");

            const btn = document.getElementById("btnExecuteProjectExport");
            const btnIcon = document.getElementById("btnExecuteExportIcon");
            const btnText = document.getElementById("btnExecuteExportText");
            if (btn) btn.disabled = false;
            if (btnIcon) btnIcon.textContent = "📦";
            if (btnText) btnText.textContent = "Stáhnout balíček projektu (.medproj)";

            try {
                const res = await fetch(`/api/projects/${encodeURIComponent(target)}/export-info`);
                if (!res.ok) throw new Error("Nepodařilo se načíst informace o projektu.");
                const info = await res.json();

                if (document.getElementById("exportStatFiles")) {
                    document.getElementById("exportStatFiles").textContent = info.source_files_count || 0;
                }
                if (document.getElementById("exportStatFilesSize")) {
                    const mb = ((info.source_bytes || 0) / (1024 * 1024)).toFixed(1);
                    document.getElementById("exportStatFilesSize").textContent = `${mb} MB podkladů`;
                }
                if (document.getElementById("exportStatChunks")) {
                    document.getElementById("exportStatChunks").textContent = (info.chunks_count || 0).toLocaleString();
                }
                if (document.getElementById("exportStatQuestions")) {
                    document.getElementById("exportStatQuestions").textContent = info.questions_count || 0;
                }
                if (document.getElementById("exportStatOutputs")) {
                    const totalOut = (info.notes_count || 0) + (info.flashcards_count || 0) + (info.tests_count || 0);
                    document.getElementById("exportStatOutputs").textContent = totalOut;
                }

                const chkAudio = document.getElementById("chkExportAudio");
                const hintAudio = document.getElementById("exportAudioSizeHint");
                if (chkAudio && hintAudio) {
                    if (info.audio_count > 0) {
                        const aMb = ((info.audio_bytes || 0) / (1024 * 1024)).toFixed(1);
                        hintAudio.textContent = `(${info.audio_count} souborů, ${aMb} MB)`;
                        chkAudio.disabled = false;
                        chkAudio.checked = false; // standardně vypnuto, aby byl export bleskově malý
                    } else {
                        hintAudio.textContent = "(Žádné audiosoubory)";
                        chkAudio.checked = false;
                        chkAudio.disabled = true;
                    }
                }

                if (loadingState) loadingState.classList.add("hidden");
                if (contentState) contentState.classList.remove("hidden");
            } catch (e) {
                if (loadingState) {
                    loadingState.innerHTML = `<div class="text-rose-400">Chyba při přípravě exportu: ${escapeHtml(e.message)}</div>`;
                }
            }
        }

        function closeProjectExportModal() {
            hideModal("modalProjectExport");
        }

        async function executeProjectExport() {
            const target = currentExportTargetProject;
            if (!target) return;

            const chkAudio = document.getElementById("chkExportAudio");
            const chkChat = document.getElementById("chkExportChat");
            const chkOutputs = document.getElementById("chkExportOutputs");
            const chkProgress = document.getElementById("chkExportProgress");

            const includeAudio = chkAudio ? chkAudio.checked : false;
            const includeChat = chkChat ? chkChat.checked : true;
            const includeOutputs = chkOutputs ? chkOutputs.checked : true;
            const includeProgress = chkProgress ? chkProgress.checked : true;

            const btn = document.getElementById("btnExecuteProjectExport");
            const btnIcon = document.getElementById("btnExecuteExportIcon");
            const btnText = document.getElementById("btnExecuteExportText");

            if (btn) btn.disabled = true;
            if (btnIcon) btnIcon.textContent = "⏳";
            if (btnText) btnText.textContent = "Generuji a balím .medproj...";

            try {
                const params = new URLSearchParams({
                    include_audio: includeAudio ? "true" : "false",
                    include_chat: includeChat ? "true" : "false",
                    include_outputs: includeOutputs ? "true" : "false",
                    include_progress: includeProgress ? "true" : "false"
                });

                const downloadUrl = `/api/projects/${encodeURIComponent(target)}/export?${params.toString()}`;
                
                const a = document.createElement("a");
                a.href = downloadUrl;
                a.download = `${target}.medproj`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);

                if (btnIcon) btnIcon.textContent = "✅";
                if (btnText) btnText.textContent = "Export zahájen!";

                setTimeout(() => {
                    closeProjectExportModal();
                }, 1200);
            } catch (e) {
                alert(`Chyba při exportu: ${e.message}`);
                if (btn) btn.disabled = false;
                if (btnIcon) btnIcon.textContent = "📦";
                if (btnText) btnText.textContent = "Stáhnout balíček projektu (.medproj)";
            }
        }

        function openProjectImportModal() {
            const modal = document.getElementById("modalProjectImport");
            if (!modal) return;
            modal.classList.remove("hidden");
            resetImportModalStep();
        }

        function closeProjectImportModal() {
            hideModal("modalProjectImport");
            currentImportFile = null;
            currentImportInspectData = null;
        }

        function resetImportModalStep() {
            const step1 = document.getElementById("importStep1");
            const step2 = document.getElementById("importStep2");
            const loading = document.getElementById("importLoadingState");
            const progress = document.getElementById("importProgressState");
            const success = document.getElementById("importSuccessState");
            const btnBack = document.getElementById("btnImportBack");
            const btnExec = document.getElementById("btnExecuteProjectImport");
            const fileInput = document.getElementById("importFileInput");

            if (fileInput) fileInput.value = "";
            if (step1) step1.classList.remove("hidden");
            if (step2) step2.classList.add("hidden");
            if (loading) loading.classList.add("hidden");
            if (progress) progress.classList.add("hidden");
            if (success) success.classList.add("hidden");
            if (btnBack) btnBack.classList.add("hidden");
            if (btnExec) btnExec.classList.add("hidden");
            currentImportFile = null;
            currentImportInspectData = null;
        }

        function handleProjectImportDrop(e) {
            const dt = e.dataTransfer;
            if (dt && dt.files && dt.files.length > 0) {
                handleProjectImportFile(dt.files[0]);
            }
        }

        function handleProjectImportFileSelect(e) {
            if (e.target && e.target.files && e.target.files.length > 0) {
                handleProjectImportFile(e.target.files[0]);
            }
        }

        async function handleProjectImportFile(file) {
            if (!file) return;
            const fname = file.name.toLowerCase();
            if (!fname.endsWith(".medproj") && !fname.endsWith(".zip")) {
                alert(t("project.import.extError", "Vybraný soubor musí mít příponu .medproj nebo .zip."));
                return;
            }

            currentImportFile = file;
            const step1 = document.getElementById("importStep1");
            const step2 = document.getElementById("importStep2");
            const loading = document.getElementById("importLoadingState");
            const loadText = document.getElementById("importLoadingText");
            const btnBack = document.getElementById("btnImportBack");
            const btnExec = document.getElementById("btnExecuteProjectImport");

            if (step1) step1.classList.add("hidden");
            if (step2) step2.classList.add("hidden");
            if (loading) loading.classList.remove("hidden");
            if (loadText) loadText.textContent = `Analyzuji balíček ${file.name}...`;

            try {
                const formData = new FormData();
                formData.append("file", sanitizeFile(file));

                const res = await fetch("/api/projects/import/inspect", {
                    method: "POST",
                    body: formData
                });

                if (!res.ok) {
                    const err = await res.json().catch(() => ({}));
                    throw new Error(err.detail || "Chyba při analýze balíčku projektu.");
                }

                const data = await res.json();
                currentImportInspectData = data;

                // Vyplnění dat v Kroku 2
                if (document.getElementById("importInspectFiles")) {
                    document.getElementById("importInspectFiles").textContent = data.source_files_count || 0;
                }
                if (document.getElementById("importInspectChunks")) {
                    document.getElementById("importInspectChunks").textContent = (data.chunks_count || 0).toLocaleString();
                }
                if (document.getElementById("importInspectQuestions")) {
                    document.getElementById("importInspectQuestions").textContent = data.questions_count || 0;
                }
                if (document.getElementById("importInspectOutputs")) {
                    const totalOut = (data.notes_count || 0) + (data.flashcards_count || 0) + (data.tests_count || 0);
                    document.getElementById("importInspectOutputs").textContent = totalOut;
                }

                if (document.getElementById("importInspectionDate")) {
                    if (data.exported_at) {
                        try {
                            const d = new Date(data.exported_at);
                            document.getElementById("importInspectionDate").textContent = `Exportováno: ${d.toLocaleString('cs-CZ')}`;
                        } catch {
                            document.getElementById("importInspectionDate").textContent = "";
                        }
                    } else {
                        document.getElementById("importInspectionDate").textContent = "";
                    }
                }

                // Seznam souborů
                const listEl = document.getElementById("importInspectFilesList");
                if (listEl) {
                    const sfiles = data.source_files || [];
                    if (sfiles.length === 0) {
                        listEl.innerHTML = `<span class="text-slate-500 italic">Žádné samostatné soubory v uploads</span>`;
                    } else {
                        listEl.innerHTML = sfiles.map(sf => `<div class="truncate">📄 ${escapeHtml(sf)}</div>`).join("");
                    }
                }

                // Cílový název a řešení konfliktů
                const nameInput = document.getElementById("importTargetProjectName");
                const conflictBox = document.getElementById("importConflictWarning");
                const conflictMsg = document.getElementById("importConflictMessage");

                if (data.exists) {
                    if (conflictBox) conflictBox.classList.remove("hidden");
                    if (conflictMsg) conflictMsg.textContent = `Projekt s názvem '${data.project_name}' již na tomto počítači existuje!`;
                    if (nameInput) nameInput.value = data.suggested_name || `${data.project_name}_import`;
                    
                    const radios = document.getElementsByName("importConflictMode");
                    for (const r of radios) {
                        if (r.value === "rename") r.checked = true;
                    }
                } else {
                    if (conflictBox) conflictBox.classList.add("hidden");
                    if (nameInput) nameInput.value = data.project_name || "Novy_projekt";
                }

                if (loading) loading.classList.add("hidden");
                if (step2) step2.classList.remove("hidden");
                if (btnBack) btnBack.classList.remove("hidden");
                if (btnExec) btnExec.classList.remove("hidden");

            } catch (e) {
                alert(`Chyba při čtení balíčku projektu: ${e.message}`);
                resetImportModalStep();
            }
        }

        function onImportConflictModeChange() {
            if (!currentImportInspectData) return;
            const radios = document.getElementsByName("importConflictMode");
            let mode = "rename";
            for (const r of radios) {
                if (r.checked) mode = r.value;
            }

            const nameInput = document.getElementById("importTargetProjectName");
            if (nameInput) {
                if (mode === "overwrite") {
                    nameInput.value = currentImportInspectData.project_name;
                } else {
                    nameInput.value = currentImportInspectData.suggested_name || `${currentImportInspectData.project_name}_import`;
                }
            }
        }

        async function executeProjectImport() {
            if (!currentImportFile) {
                alert(t("project.import.noFile", "Není vybrán žádný soubor k importu."));
                return;
            }

            const nameInput = document.getElementById("importTargetProjectName");
            const targetName = (nameInput ? nameInput.value : "").trim();
            if (!targetName) {
                alert(t("project.import.invalidTargetName", "Zadejte prosím platný název pro cílový projekt."));
                return;
            }

            let overwrite = false;
            if (currentImportInspectData && currentImportInspectData.exists) {
                const radios = document.getElementsByName("importConflictMode");
                for (const r of radios) {
                    if (r.checked && r.value === "overwrite") overwrite = true;
                }
            }

            const chkOutputs = document.getElementById("chkImportOutputs");
            const chkChat = document.getElementById("chkImportChat");
            const chkAudio = document.getElementById("chkImportAudio");

            const step2 = document.getElementById("importStep2");
            const progress = document.getElementById("importProgressState");
            const success = document.getElementById("importSuccessState");
            const btnBack = document.getElementById("btnImportBack");
            const btnExec = document.getElementById("btnExecuteProjectImport");

            if (step2) step2.classList.add("hidden");
            if (btnBack) btnBack.classList.add("hidden");
            if (btnExec) btnExec.classList.add("hidden");
            if (progress) progress.classList.remove("hidden");

            try {
                const formData = new FormData();
                formData.append("file", sanitizeFile(currentImportFile));
                formData.append("project_name", targetName);
                formData.append("overwrite", overwrite ? "true" : "false");
                formData.append("include_outputs", (chkOutputs && chkOutputs.checked) ? "true" : "false");
                formData.append("include_chat", (chkChat && chkChat.checked) ? "true" : "false");
                formData.append("include_audio", (chkAudio && chkAudio.checked) ? "true" : "false");

                const res = await fetch("/api/projects/import", {
                    method: "POST",
                    body: formData
                });

                if (!res.ok) {
                    const err = await res.json().catch(() => ({}));
                    throw new Error(err.detail || "Chyba při importu projektu.");
                }

                const result = await res.json();
                const importedProject = result.project || targetName;

                if (progress) progress.classList.add("hidden");
                if (success) {
                    success.classList.remove("hidden");
                    const title = document.getElementById("importSuccessTitle");
                    const msg = document.getElementById("importSuccessMessage");
                    if (title) title.textContent = `Projekt '${importedProject}' byl úspěšně importován!`;
                    if (msg) msg.textContent = `Nahráno ${result.source_files_count || 0} podkladů a ${result.chunks_count || 0} předpočítaných vektorů ChromaDB.`;
                }

                // Automaticky načteme seznam projektů a aktivujeme importovaný projekt
                await loadProjects();
                const select = document.getElementById("projectSelect");
                if (select) {
                    select.value = importedProject;
                }
                localStorage.setItem("aiPodcastActiveProject", importedProject);
                await onProjectChange();

                const pmModal = document.getElementById("modalProjectManager");
                if (pmModal && !pmModal.classList.contains("hidden")) {
                    openProjectManagerModal();
                }

                setTimeout(() => {
                    closeProjectImportModal();
                }, 1500);

            } catch (e) {
                alert(`Chyba při importu: ${e.message}`);
                if (progress) progress.classList.add("hidden");
                if (step2) step2.classList.remove("hidden");
                if (btnBack) btnBack.classList.remove("hidden");
                if (btnExec) btnExec.classList.remove("hidden");
            }
        }

