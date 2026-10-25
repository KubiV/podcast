// =========================================================================
// Nastavení aplikace a vlastních API klíčů (BYOK) (odděleno z app.js, krok 3.5). Klasický skript:
// sdílí globální scope s app.js; pořadí načítání je dané v index.html.
// =========================================================================

        // =========================================================================
        // NASTAVENÍ APLIKACE A VLASTNÍCH API KLÍČŮ (BYOK)
        // =========================================================================
        let appSettingsCache = null;

        async function loadAppSettings(showModalIfMissing = false) {
            try {
                const res = await fetch("/api/settings");
                if (!res.ok) return;
                const data = await res.json();
                appSettingsCache = data;

                // Indikace tlačítka nastavení v horní liště (zelená tečka odstraněna, tlačítko má čistý standardní vzhled)
                const dot = document.getElementById("globalSettingsDot");
                const btnSettings = document.getElementById("btnGlobalSettings");
                if (data.gemini_configured) {
                    // Klíč je nakonfigurován – žádnou zelenou tečku nezobrazujeme
                    if (dot) {
                        dot.className = "hidden";
                    }
                    if (btnSettings) {
                        btnSettings.classList.remove("border-amber-500/80", "text-amber-300");
                        btnSettings.title = "Nastavení aplikace a API klíčů (BYOK)";
                    }
                } else {
                    // Varování: Klíč chybí – decentní jantarové varování
                    if (dot) {
                        dot.className = "absolute top-1 right-1 w-2 h-2 rounded-full bg-amber-500 animate-pulse";
                        dot.title = "Pozor: Gemini API klíč není nastaven!";
                    }
                    if (btnSettings) {
                        btnSettings.classList.add("border-amber-500/80");
                        btnSettings.title = "Pozor: Gemini API klíč není nastaven! Otevřete nastavení.";
                    }
                }

                // Stavové odznaky pro jednotlivé poskytovatele přímo v okně nastavení
                const geminiBadge = document.getElementById("settingsGeminiConfigBadge");
                if (geminiBadge) {
                    if (data.gemini_configured) {
                        geminiBadge.className = "text-[10px] bg-emerald-950/80 text-emerald-400 font-bold px-2 py-0.5 rounded border border-emerald-700/60 inline-flex items-center gap-1";
                        geminiBadge.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span> ${t("common.active", "Aktivní")}`;
                    } else {
                        geminiBadge.className = "text-[10px] bg-amber-950/80 text-amber-300 font-bold px-2 py-0.5 rounded border border-amber-700/60 inline-flex items-center gap-1";
                        geminiBadge.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse"></span> ${t("settings.missingKey", "Chybí klíč")}`;
                    }
                }

                const openaiBadge = document.getElementById("settingsOpenaiConfigBadge");
                if (openaiBadge) {
                    if (data.openai_configured) {
                        openaiBadge.className = "text-[10px] bg-emerald-950/80 text-emerald-400 font-bold px-2 py-0.5 rounded border border-emerald-700/60 inline-flex items-center gap-1";
                        openaiBadge.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span> ${t("common.active", "Aktivní")}`;
                    } else {
                        openaiBadge.className = "text-[10px] bg-slate-900 text-slate-500 font-medium px-2 py-0.5 rounded border border-slate-800";
                        openaiBadge.textContent = t("settings.notConfigured", "Nenastaveno");
                    }
                }

                const elevenBadge = document.getElementById("settingsElevenlabsConfigBadge");
                if (elevenBadge) {
                    if (data.elevenlabs_configured) {
                        elevenBadge.className = "text-[10px] bg-emerald-950/80 text-emerald-400 font-bold px-2 py-0.5 rounded border border-emerald-700/60 inline-flex items-center gap-1";
                        elevenBadge.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span> ${t("common.active", "Aktivní")}`;
                    } else {
                        elevenBadge.className = "text-[10px] bg-slate-900 text-slate-500 font-medium px-2 py-0.5 rounded border border-slate-800";
                        elevenBadge.textContent = t("settings.notConfigured", "Nenastaveno");
                    }
                }

                // Cesta k lokálnímu adresáři
                const pathEl = document.getElementById("settingsUserDataPath");
                if (pathEl && data.user_data_dir) {
                    pathEl.value = data.user_data_dir;
                }

                // Placeholder / hodnoty pro vstupy
                const geminiInput = document.getElementById("inputSettingsGeminiKey");
                const openaiInput = document.getElementById("inputSettingsOpenaiKey");
                const elevenlabsInput = document.getElementById("inputSettingsElevenlabsKey");

                // Politika správy API klíčů (sdílené vs individuální per-user)
                const policyBanner = document.getElementById("settingsApiKeyPolicyBanner");
                const policyIcon = document.getElementById("settingsApiKeyPolicyIcon");
                const policyText = document.getElementById("settingsApiKeyPolicyText");
                const btnSave = document.getElementById("btnSaveSettings");

                const isShared = data.shared_api_keys !== false;
                const isAdmin = data.is_admin === true || (currentUser && currentUser.role === "admin");
                const isViewer = data.is_viewer === true || (currentUser && currentUser.role === "viewer");

                if (policyBanner && policyText) {
                    policyBanner.classList.remove("hidden");
                    if (isShared) {
                        if (isAdmin) {
                            policyBanner.className = "p-3 rounded-xl border border-sky-800/60 bg-sky-950/40 text-sky-200 text-xs flex items-center gap-2.5";
                            if (policyIcon) policyIcon.textContent = "👑";
                            policyText.innerHTML = `<strong>${t("settings.apiPolicySharedAdminTitle", "Centrální režim API klíčů (Administrátor):")}</strong> ${t("settings.apiPolicySharedAdminDesc", "Tyto klíče jsou centrálně sdíleny všemi uživateli aplikace.")}`;
                            if (geminiInput) geminiInput.disabled = false;
                            if (openaiInput) openaiInput.disabled = false;
                            if (elevenlabsInput) elevenlabsInput.disabled = false;
                            if (btnSave) btnSave.disabled = false;
                        } else {
                            policyBanner.className = "p-3 rounded-xl border border-emerald-800/60 bg-emerald-950/40 text-emerald-200 text-xs flex items-center gap-2.5";
                            if (policyIcon) policyIcon.textContent = "🛡️";
                            policyText.innerHTML = `<strong>${t("settings.apiPolicySharedUserTitle", "Centrální API klíče:")}</strong> ${t("settings.apiPolicySharedUserDesc", "Aplikace využívá centrální klíče nastavené administrátorem. Vlastní klíče není nutné zadávat.")}`;
                            if (geminiInput) { geminiInput.disabled = true; geminiInput.placeholder = t("settings.apiPlaceholderManaged", "Spravováno administrátorem (sdílené klíče)"); }
                            if (openaiInput) { openaiInput.disabled = true; openaiInput.placeholder = t("settings.apiPlaceholderManaged", "Spravováno administrátorem (sdílené klíče)"); }
                            if (elevenlabsInput) { elevenlabsInput.disabled = true; elevenlabsInput.placeholder = t("settings.apiPlaceholderManaged", "Spravováno administrátorem (sdílené klíče)"); }
                            if (btnSave) btnSave.disabled = false;
                        }
                    } else {
                        if (isViewer) {
                            policyBanner.className = "p-3 rounded-xl border border-purple-800/60 bg-purple-950/40 text-purple-200 text-xs flex items-center gap-2.5";
                            if (policyIcon) policyIcon.textContent = "👁️";
                            policyText.innerHTML = `<strong>${t("settings.apiPolicyViewerTitle", "Režim pozorovatele:")}</strong> ${t("settings.apiPolicyViewerDesc", "Účet pozorovatele je pouze ke čtení a nemůže nastavovat API klíče.")}`;
                            if (geminiInput) { geminiInput.disabled = true; geminiInput.placeholder = t("settings.apiPlaceholderViewer", "Pozorovatelé nemohou nastavovat klíče"); }
                            if (openaiInput) { openaiInput.disabled = true; openaiInput.placeholder = t("settings.apiPlaceholderViewer", "Pozorovatelé nemohou nastavovat klíče"); }
                            if (elevenlabsInput) { elevenlabsInput.disabled = true; elevenlabsInput.placeholder = t("settings.apiPlaceholderViewer", "Pozorovatelé nemohou nastavovat klíče"); }
                            if (btnSave) btnSave.disabled = true;
                        } else {
                            policyBanner.className = "p-3 rounded-xl border border-indigo-800/60 bg-indigo-950/40 text-indigo-200 text-xs flex items-center gap-2.5";
                            if (policyIcon) policyIcon.textContent = "👤";
                            policyText.innerHTML = `<strong>${t("settings.apiPolicyByokTitle", "Osobní API klíče (BYOK):")}</strong> ${t("settings.apiPolicyByokDesc", "Zde zadané klíče budou bezpečně uloženy pro váš osobní účet.")}`;
                            if (geminiInput) geminiInput.disabled = false;
                            if (openaiInput) openaiInput.disabled = false;
                            if (elevenlabsInput) elevenlabsInput.disabled = false;
                            if (btnSave) btnSave.disabled = false;
                        }
                    }
                }

                if (geminiInput && !geminiInput.disabled) {
                    geminiInput.placeholder = data.gemini_configured ? t("settings.apiPlaceholderActive", "Aktivní ({masked}) - ponechte prázdné pro zachování", { masked: data.gemini_masked }) : t("settings.apiPlaceholderGemini", "Vložte AIzaSy...");
                }
                if (openaiInput && !openaiInput.disabled) {
                    openaiInput.placeholder = data.openai_configured ? t("settings.apiPlaceholderActive", "Aktivní ({masked}) - ponechte prázdné pro zachování", { masked: data.openai_masked }) : t("settings.apiPlaceholderOpenai", "Vložte sk-...");
                }
                if (elevenlabsInput && !elevenlabsInput.disabled) {
                    elevenlabsInput.placeholder = data.elevenlabs_configured ? t("settings.apiPlaceholderActive", "Aktivní ({masked}) - ponechte prázdné pro zachování", { masked: data.elevenlabs_masked }) : t("settings.apiPlaceholderEleven", "Vložte klíč...");
                }

                // Alert v modalu
                const alertEl = document.getElementById("settingsGeminiMissingAlert");
                if (alertEl) {
                    if (!data.gemini_configured) {
                        alertEl.classList.remove("hidden");
                    } else {
                        alertEl.classList.add("hidden");
                    }
                }

                // Pomodoro nastavení v modalu
                if (typeof syncPomodoroSettingsToModal === "function") {
                    syncPomodoroSettingsToModal(data.pomodoro_settings);
                }

                // Pokud je klíč nepřítomen při startu, automaticky otevřeme dialog
                if (showModalIfMissing && !data.gemini_configured) {
                    openSettingsModal();
                }
            } catch (err) {
                console.warn("Nelze načíst nastavení:", err);
            }
        }

