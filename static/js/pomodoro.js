// =========================================================================
// Pomodoro – časovač soustředění (oddělen z app.js, krok 3.5). Klasický skript:
// sdílí globální scope s app.js a načítá se hned za ním (index.html).
// =========================================================================

        // =========================================================================
        // 🍅 MODUL POMODORO: ČASOVAČ SOUSTŘEDĚNÍ & MEDULINGO INTEGRACE
        // =========================================================================

        const POMODORO_STORAGE_KEY_SETTINGS = "medstudio_pomodoro_settings";
        const POMODORO_STORAGE_KEY_STATS = "medstudio_pomodoro_stats";
        const POMODORO_STORAGE_KEY_STATE = "medstudio_pomodoro_state";

        let pomodoroSettings = {
            workMinutes: 25,
            shortBreakMinutes: 5,
            longBreakMinutes: 15,
            longBreakInterval: 4,
            soundEnabled: true,
            showInMedulingo: true,
            showMiniWidget: true,
            autoStartBreak: false,
            autoStartWork: false
        };

        let pomodoroState = {
            mode: "work", // "work" | "short_break" | "long_break"
            timeLeft: 25 * 60,
            totalDuration: 25 * 60,
            isRunning: false,
            currentCycle: 1,
            activeQuestionId: "",
            activeQuestionTitle: "",
            activeTaskTitle: "Volné studium",
            lastTickTimestamp: null
        };

        let pomodoroStats = {
            date: new Date().toISOString().slice(0, 10),
            completedPomodoros: 0,
            totalWorkSeconds: 0
        };

        let pomodoroTimerInterval = null;

        function initPomodoro() {
            loadPomodoroSettings();
            loadPomodoroStats();
            loadPomodoroState();

            updatePomodoroUI();
            updatePomodoroSettingsUI();
            updatePomodoroHeaderWidget();
            updateMedulingoPomodoroBar();

            if (pomodoroState.isRunning) {
                resumePomodoroTimer();
            }
        }

        function loadPomodoroSettings() {
            try {
                const raw = localStorage.getItem(POMODORO_STORAGE_KEY_SETTINGS);
                if (raw) {
                    const parsed = JSON.parse(raw);
                    pomodoroSettings = { ...pomodoroSettings, ...parsed };
                }
            } catch (e) {
                console.warn("Chyba při čtení pomodoroSettings z localStorage:", e);
            }
        }

        function savePomodoroSettings() {
            try {
                localStorage.setItem(POMODORO_STORAGE_KEY_SETTINGS, JSON.stringify(pomodoroSettings));
            } catch (e) {
                console.warn("Chyba při ukládání pomodoroSettings:", e);
            }
        }

        function syncPomodoroSettingsToModal(backendSettings) {
            if (backendSettings && typeof backendSettings === "object") {
                if (backendSettings.work_duration) pomodoroSettings.workMinutes = parseInt(backendSettings.work_duration);
                if (backendSettings.short_break) pomodoroSettings.shortBreakMinutes = parseInt(backendSettings.short_break);
                if (backendSettings.long_break) pomodoroSettings.longBreakMinutes = parseInt(backendSettings.long_break);
                if (typeof backendSettings.sound_enabled === "boolean") pomodoroSettings.soundEnabled = backendSettings.sound_enabled;
                if (typeof backendSettings.show_in_medulingo === "boolean") pomodoroSettings.showInMedulingo = backendSettings.show_in_medulingo;
                if (typeof backendSettings.show_mini_widget === "boolean") pomodoroSettings.showMiniWidget = backendSettings.show_mini_widget;
                savePomodoroSettings();
            }

            const miniCheck = document.getElementById("settingsPomoMiniWidget");
            const meduCheck = document.getElementById("settingsPomoInMedulingo");
            const soundCheck = document.getElementById("settingsPomoSound");
            const wInput = document.getElementById("settingsPomoWorkMin");
            const sInput = document.getElementById("settingsPomoShortMin");
            const lInput = document.getElementById("settingsPomoLongMin");

            if (miniCheck) miniCheck.checked = Boolean(pomodoroSettings.showMiniWidget);
            if (meduCheck) meduCheck.checked = Boolean(pomodoroSettings.showInMedulingo);
            if (soundCheck) soundCheck.checked = Boolean(pomodoroSettings.soundEnabled);
            if (wInput) wInput.value = pomodoroSettings.workMinutes;
            if (sInput) sInput.value = pomodoroSettings.shortBreakMinutes;
            if (lInput) lInput.value = pomodoroSettings.longBreakMinutes;
        }

        function savePomodoroSettingsFromModal() {
            const miniCheck = document.getElementById("settingsPomoMiniWidget");
            const meduCheck = document.getElementById("settingsPomoInMedulingo");
            const soundCheck = document.getElementById("settingsPomoSound");
            const wInput = document.getElementById("settingsPomoWorkMin");
            const sInput = document.getElementById("settingsPomoShortMin");
            const lInput = document.getElementById("settingsPomoLongMin");

            if (miniCheck) pomodoroSettings.showMiniWidget = miniCheck.checked;
            if (meduCheck) pomodoroSettings.showInMedulingo = meduCheck.checked;
            if (soundCheck) pomodoroSettings.soundEnabled = soundCheck.checked;
            if (wInput && parseInt(wInput.value) > 0) pomodoroSettings.workMinutes = parseInt(wInput.value);
            if (sInput && parseInt(sInput.value) > 0) pomodoroSettings.shortBreakMinutes = parseInt(sInput.value);
            if (lInput && parseInt(lInput.value) > 0) pomodoroSettings.longBreakMinutes = parseInt(lInput.value);

            savePomodoroSettings();
            updatePomodoroSettingsUI();
            updatePomodoroUI();
            updatePomodoroHeaderWidget();
            updateMedulingoPomodoroBar();

            return {
                work_duration: pomodoroSettings.workMinutes,
                short_break: pomodoroSettings.shortBreakMinutes,
                long_break: pomodoroSettings.longBreakMinutes,
                sound_enabled: pomodoroSettings.soundEnabled,
                show_in_medulingo: pomodoroSettings.showInMedulingo,
                show_mini_widget: pomodoroSettings.showMiniWidget
            };
        }

        function loadPomodoroStats() {
            try {
                const today = new Date().toISOString().slice(0, 10);
                const raw = localStorage.getItem(POMODORO_STORAGE_KEY_STATS);
                if (raw) {
                    const parsed = JSON.parse(raw);
                    if (parsed.date === today) {
                        pomodoroStats = parsed;
                        return;
                    }
                }
                pomodoroStats = {
                    date: today,
                    completedPomodoros: 0,
                    totalWorkSeconds: 0
                };
                savePomodoroStats();
            } catch (e) {
                console.warn("Chyba při čtení pomodoroStats:", e);
            }
        }

        function savePomodoroStats() {
            try {
                localStorage.setItem(POMODORO_STORAGE_KEY_STATS, JSON.stringify(pomodoroStats));
            } catch (e) {
                console.warn("Chyba při ukládání pomodoroStats:", e);
            }
        }

        function resetPomodoroDailyStats() {
            if (!confirm(t("pomodoro.confirmResetStats", "Opravdu chcete vynulovat dnešní statistiku dokončených pomodor?"))) return;
            pomodoroStats.completedPomodoros = 0;
            pomodoroStats.totalWorkSeconds = 0;
            savePomodoroStats();
            updatePomodoroUI();
        }

        function loadPomodoroState() {
            try {
                const raw = localStorage.getItem(POMODORO_STORAGE_KEY_STATE);
                if (raw) {
                    const parsed = JSON.parse(raw);
                    pomodoroState = { ...pomodoroState, ...parsed };
                } else {
                    pomodoroState.timeLeft = pomodoroSettings.workMinutes * 60;
                    pomodoroState.totalDuration = pomodoroSettings.workMinutes * 60;
                }
            } catch (e) {
                console.warn("Chyba při čtení pomodoroState:", e);
            }
        }

        function savePomodoroState() {
            try {
                localStorage.setItem(POMODORO_STORAGE_KEY_STATE, JSON.stringify(pomodoroState));
            } catch (e) {
                console.warn("Chyba při ukládání pomodoroState:", e);
            }
        }

        function startPomodoro() {
            if (pomodoroState.timeLeft <= 0) {
                resetPomodoro();
            }
            pomodoroState.isRunning = true;
            pomodoroState.lastTickTimestamp = Date.now();
            if (pomodoroTimerInterval) clearInterval(pomodoroTimerInterval);
            pomodoroTimerInterval = setInterval(tickPomodoro, 1000);
            savePomodoroState();
            updatePomodoroUI();
        }

        function pausePomodoro() {
            pomodoroState.isRunning = false;
            pomodoroState.lastTickTimestamp = null;
            if (pomodoroTimerInterval) {
                clearInterval(pomodoroTimerInterval);
                pomodoroTimerInterval = null;
            }
            savePomodoroState();
            updatePomodoroUI();
        }

        function togglePomodoroPlayPause() {
            if (pomodoroState.isRunning) {
                pausePomodoro();
            } else {
                startPomodoro();
            }
        }

        function resumePomodoroTimer() {
            const now = Date.now();
            if (pomodoroState.lastTickTimestamp) {
                const elapsedSeconds = Math.floor((now - pomodoroState.lastTickTimestamp) / 1000);
                if (elapsedSeconds > 0) {
                    pomodoroState.timeLeft = Math.max(0, pomodoroState.timeLeft - elapsedSeconds);
                    if (pomodoroState.mode === "work") {
                        pomodoroStats.totalWorkSeconds += elapsedSeconds;
                        savePomodoroStats();
                    }
                }
            }
            if (pomodoroState.timeLeft <= 0) {
                onPomodoroPhaseComplete();
            } else {
                pomodoroState.lastTickTimestamp = now;
                if (pomodoroTimerInterval) clearInterval(pomodoroTimerInterval);
                pomodoroTimerInterval = setInterval(tickPomodoro, 1000);
                updatePomodoroUI();
            }
        }

        function resetPomodoro() {
            pausePomodoro();
            let durationMin = pomodoroSettings.workMinutes;
            if (pomodoroState.mode === "short_break") durationMin = pomodoroSettings.shortBreakMinutes;
            else if (pomodoroState.mode === "long_break") durationMin = pomodoroSettings.longBreakMinutes;

            pomodoroState.totalDuration = durationMin * 60;
            pomodoroState.timeLeft = durationMin * 60;
            savePomodoroState();
            updatePomodoroUI();
        }

        function switchPomodoroMode(mode, autoStart = false) {
            pausePomodoro();
            pomodoroState.mode = mode;
            let durationMin = pomodoroSettings.workMinutes;
            if (mode === "short_break") durationMin = pomodoroSettings.shortBreakMinutes;
            else if (mode === "long_break") durationMin = pomodoroSettings.longBreakMinutes;

            pomodoroState.totalDuration = durationMin * 60;
            pomodoroState.timeLeft = durationMin * 60;
            savePomodoroState();
            updatePomodoroUI();

            if (autoStart) {
                startPomodoro();
            }
        }

        function skipPomodoroPhase() {
            if (pomodoroState.mode === "work") {
                if (pomodoroState.currentCycle >= pomodoroSettings.longBreakInterval) {
                    switchPomodoroMode("long_break");
                } else {
                    switchPomodoroMode("short_break");
                }
            } else {
                if (pomodoroState.mode === "long_break") {
                    pomodoroState.currentCycle = 1;
                } else {
                    pomodoroState.currentCycle = Math.min(pomodoroSettings.longBreakInterval, pomodoroState.currentCycle + 1);
                }
                switchPomodoroMode("work");
            }
        }

        function tickPomodoro() {
            const now = Date.now();
            const last = pomodoroState.lastTickTimestamp || now;
            const delta = Math.floor((now - last) / 1000);

            if (delta >= 1) {
                pomodoroState.lastTickTimestamp = now;
                pomodoroState.timeLeft = Math.max(0, pomodoroState.timeLeft - delta);

                if (pomodoroState.mode === "work") {
                    pomodoroStats.totalWorkSeconds += delta;
                    savePomodoroStats();
                }

                savePomodoroState();
                updatePomodoroUI();

                if (pomodoroState.timeLeft <= 0) {
                    onPomodoroPhaseComplete();
                }
            }
        }

        function onPomodoroPhaseComplete() {
            pausePomodoro();

            if (pomodoroState.mode === "work") {
                pomodoroStats.completedPomodoros += 1;
                savePomodoroStats();
                playPomodoroChime("work_end");

                const isLong = pomodoroState.currentCycle >= pomodoroSettings.longBreakInterval;
                const nextMode = isLong ? "long_break" : "short_break";

                openPomodoroCompleteModal("work", isLong);

                if (pomodoroSettings.autoStartBreak) {
                    setTimeout(() => {
                        closePomodoroCompleteModal();
                        switchPomodoroMode(nextMode, true);
                    }, 1200);
                }
            } else {
                playPomodoroChime("break_end");
                if (pomodoroState.mode === "long_break") {
                    pomodoroState.currentCycle = 1;
                } else {
                    pomodoroState.currentCycle = Math.min(pomodoroSettings.longBreakInterval, pomodoroState.currentCycle + 1);
                }

                openPomodoroCompleteModal("break");

                if (pomodoroSettings.autoStartWork) {
                    setTimeout(() => {
                        closePomodoroCompleteModal();
                        switchPomodoroMode("work", true);
                    }, 1200);
                }
            }
        }

        function playPomodoroChime(type = "work_end") {
            if (!pomodoroSettings.soundEnabled) return;
            try {
                const AudioCtx = window.AudioContext || window.webkitAudioContext;
                if (!AudioCtx) return;
                const ctx = new AudioCtx();

                if (type === "work_end") {
                    const notes = [523.25, 659.25, 783.99, 1046.50];
                    notes.forEach((freq, idx) => {
                        const osc = ctx.createOscillator();
                        const gain = ctx.createGain();
                        osc.type = "sine";
                        osc.frequency.setValueAtTime(freq, ctx.currentTime + idx * 0.16);
                        gain.gain.setValueAtTime(0, ctx.currentTime + idx * 0.16);
                        gain.gain.linearRampToValueAtTime(0.2, ctx.currentTime + idx * 0.16 + 0.04);
                        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + idx * 0.16 + 0.7);
                        osc.connect(gain);
                        gain.connect(ctx.destination);
                        osc.start(ctx.currentTime + idx * 0.16);
                        osc.stop(ctx.currentTime + idx * 0.16 + 0.75);
                    });
                } else {
                    const notes = [880.00, 739.99, 587.33];
                    notes.forEach((freq, idx) => {
                        const osc = ctx.createOscillator();
                        const gain = ctx.createGain();
                        osc.type = "triangle";
                        osc.frequency.setValueAtTime(freq, ctx.currentTime + idx * 0.18);
                        gain.gain.setValueAtTime(0, ctx.currentTime + idx * 0.18);
                        gain.gain.linearRampToValueAtTime(0.22, ctx.currentTime + idx * 0.18 + 0.03);
                        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + idx * 0.18 + 0.8);
                        osc.connect(gain);
                        gain.connect(ctx.destination);
                        osc.start(ctx.currentTime + idx * 0.18);
                        osc.stop(ctx.currentTime + idx * 0.18 + 0.85);
                    });
                }
            } catch (e) {
                console.warn("Chyba při přehrávání Pomodoro zvuku:", e);
            }
        }

        function playPomodoroSoundPreview() {
            playPomodoroChime("work_end");
            setTimeout(() => {
                playPomodoroChime("break_end");
            }, 850);
            if (typeof appendConsoleLog === "function") {
                appendConsoleLog("🔔 [Pomodoro] Zvukové tóny otestovány (Web Audio API).");
            }
        }

        function formatPomodoroTime(seconds) {
            const m = Math.floor(seconds / 60);
            const s = seconds % 60;
            return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
        }

        function updatePomodoroUI() {
            const timeStr = formatPomodoroTime(pomodoroState.timeLeft);

            // 1. Zobrazení v modulu Pomodoro
            const displayEl = document.getElementById("pomoTimeDisplay");
            if (displayEl) displayEl.textContent = timeStr;

            const taskEl = document.getElementById("pomoActiveTaskDisplay");
            if (taskEl) taskEl.textContent = pomodoroState.activeTaskTitle || "Volné studium";

            // SVG kruh postupu (obvod r=100 je ~628.3)
            const ring = document.getElementById("pomoProgressRing");
            if (ring) {
                const total = pomodoroState.totalDuration || 1;
                const ratio = Math.max(0, Math.min(1, pomodoroState.timeLeft / total));
                const circumference = 628.318;
                const offset = circumference * (1 - ratio);
                ring.style.strokeDashoffset = offset;

                if (pomodoroState.mode === "work") {
                    ring.className = "text-rose-500 fill-none transition-all duration-1000 ease-linear drop-shadow-[0_0_8px_rgba(244,63,94,0.5)]";
                } else if (pomodoroState.mode === "short_break") {
                    ring.className = "text-emerald-400 fill-none transition-all duration-1000 ease-linear drop-shadow-[0_0_8px_rgba(52,211,153,0.5)]";
                } else {
                    ring.className = "text-sky-400 fill-none transition-all duration-1000 ease-linear drop-shadow-[0_0_8px_rgba(56,189,248,0.5)]";
                }
            }

            // Tlačítko start/pause v modulu
            const mainActionText = document.getElementById("pomoMainActionText");
            const mainActionIcon = document.getElementById("pomoMainActionIcon");
            const mainActionBtn = document.getElementById("btnPomoMainAction");
            if (mainActionText && mainActionIcon) {
                if (pomodoroState.isRunning) {
                    mainActionIcon.textContent = "⏸️";
                    mainActionText.textContent = "Pozastavit";
                    if (mainActionBtn) {
                        mainActionBtn.className = "h-12 px-7 rounded-xl bg-gradient-to-r from-amber-600 to-amber-500 hover:from-amber-500 hover:to-amber-400 text-white font-black text-sm shadow-xl shadow-amber-950/60 transition transform active:scale-95 flex items-center gap-2";
                    }
                } else {
                    mainActionIcon.textContent = "▶️";
                    mainActionText.textContent = pomodoroState.mode === "work" ? t("pomodoro.startFocus", "Spustit soustředění") : t("pomodoro.startBreak", "Spustit přestávku");
                    if (mainActionBtn) {
                        mainActionBtn.className = pomodoroState.mode === "work"
                            ? "h-12 px-7 rounded-xl bg-gradient-to-r from-rose-600 to-rose-500 hover:from-rose-500 hover:to-rose-400 text-white font-black text-sm shadow-xl shadow-rose-950/60 transition transform active:scale-95 flex items-center gap-2"
                            : "h-12 px-7 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-500 hover:from-emerald-500 hover:to-teal-400 text-white font-black text-sm shadow-xl shadow-emerald-950/60 transition transform active:scale-95 flex items-center gap-2";
                    }
                }
            }

            // Tlačítka fází
            ["work", "short_break", "long_break"].forEach(m => {
                const btn = document.getElementById(`pomoModeBtn-${m}`);
                if (!btn) return;
                if (pomodoroState.mode === m) {
                    btn.className = m === "work"
                        ? "px-3.5 py-1.5 rounded-lg bg-rose-600 text-white font-bold transition shadow flex items-center gap-1.5"
                        : "px-3.5 py-1.5 rounded-lg bg-emerald-600 text-white font-bold transition shadow flex items-center gap-1.5";
                } else {
                    btn.className = "px-3.5 py-1.5 rounded-lg text-slate-400 hover:text-white transition flex items-center gap-1.5";
                }
            });

            // Fázový štítek
            const phaseBadge = document.getElementById("pomoPhaseBadge");
            const phaseBadgeText = document.getElementById("pomoPhaseBadgeText");
            if (phaseBadge && phaseBadgeText) {
                if (pomodoroState.mode === "work") {
                    phaseBadgeText.textContent = t("pomodoro.deepFocusPhase", "Hluboké soustředění");
                    phaseBadge.className = "text-xs uppercase font-extrabold px-3.5 py-1.5 rounded-full bg-rose-950 border border-rose-600/60 text-rose-300 shadow-md flex items-center gap-2";
                } else if (pomodoroState.mode === "short_break") {
                    phaseBadgeText.textContent = t("pomodoro.shortBreakPhase", "Krátká regenerace (5 min)");
                    phaseBadge.className = "text-xs uppercase font-extrabold px-3.5 py-1.5 rounded-full bg-emerald-950 border border-emerald-600/60 text-emerald-300 shadow-md flex items-center gap-2";
                } else {
                    phaseBadgeText.textContent = t("pomodoro.longBreakPhase", "Dlouhá regenerace (15 min)");
                    phaseBadge.className = "text-xs uppercase font-extrabold px-3.5 py-1.5 rounded-full bg-sky-950 border border-sky-600/60 text-sky-300 shadow-md flex items-center gap-2";
                }
            }

            // Indikátor cyklů (rajčata)
            const cycleDots = document.getElementById("pomoCycleDots");
            if (cycleDots) {
                let html = "";
                const totalCycles = pomodoroSettings.longBreakInterval || 4;
                for (let i = 1; i <= totalCycles; i++) {
                    const isDoneOrActive = i <= pomodoroState.currentCycle;
                    html += `<span title="Blok ${i}" class="${isDoneOrActive ? 'scale-110 drop-shadow' : 'opacity-25'} transition-all text-base">🍅</span>`;
                }
                cycleDots.innerHTML = html;
            }

            // Dnešní statistiky
            const statCompleted = document.getElementById("pomoStatCompletedVal");
            if (statCompleted) statCompleted.textContent = `${pomodoroStats.completedPomodoros} ${pomodoroStats.completedPomodoros === 1 ? 'blok' : pomodoroStats.completedPomodoros < 5 ? 'bloky' : 'bloků'}`;

            const statFocusTime = document.getElementById("pomoStatFocusTimeVal");
            if (statFocusTime) {
                const totalMins = Math.round(pomodoroStats.totalWorkSeconds / 60);
                const h = Math.floor(totalMins / 60);
                const m = totalMins % 60;
                statFocusTime.textContent = h > 0 ? `${h}h ${m}m` : `${m} min`;
            }

            const statGoal = document.getElementById("pomoStatGoalVal");
            if (statGoal) {
                const pct = Math.min(100, Math.round((pomodoroStats.completedPomodoros / 4) * 100));
                statGoal.textContent = `${pomodoroStats.completedPomodoros} / 4 (${pct}%)`;
            }

            const statCycle = document.getElementById("pomoStatCycleVal");
            if (statCycle) {
                statCycle.textContent = `${pomodoroState.currentCycle}. ze ${pomodoroSettings.longBreakInterval}`;
            }

            // 2. Mini-časovač v horní liště aplikace
            updatePomodoroHeaderWidget();

            // 3. Mini-časovač v Medulingo (jak v přehledu, tak v modalu otázky)
            updateMedulingoModalPomodoro();
            updateMedulingoPomodoroBar();

            // 4. Homescreen card text
            const homePomoStatus = document.getElementById("homePomodoroStatusText");
            if (homePomoStatus) {
                if (pomodoroState.isRunning) {
                    homePomoStatus.textContent = `Aktivní: ${timeStr} 🍅`;
                } else if (pomodoroStats.completedPomodoros > 0) {
                    homePomoStatus.textContent = `Dnes: ${pomodoroStats.completedPomodoros} 🍅 (${timeStr})`;
                } else {
                    homePomoStatus.textContent = `Spustit časovač (25m)`;
                }
            }
        }

        function updatePomodoroHeaderWidget() {
            const widget = document.getElementById("headerPomodoroWidget");
            const timeEl = document.getElementById("headerPomodoroTime");
            const playBtn = document.getElementById("headerPomodoroPlayBtn");
            const iconEl = document.getElementById("headerPomodoroIcon");

            if (!widget) return;

            // Zobrazujeme, pokud je widget povolen v nastavení a (buď běží časovač, nebo uživatel chce widget vidět stále)
            if (pomodoroSettings.showMiniWidget) {
                widget.classList.remove("hidden");
                if (timeEl) timeEl.textContent = formatPomodoroTime(pomodoroState.timeLeft);
                if (playBtn) playBtn.textContent = pomodoroState.isRunning ? "⏸️" : "▶️";
                if (iconEl) {
                    if (pomodoroState.isRunning) iconEl.classList.add("animate-pulse");
                    else iconEl.classList.remove("animate-pulse");
                }
            } else {
                widget.classList.add("hidden");
            }
        }

        function updateMedulingoPomodoroBar() {
            const bar = document.getElementById("medulingoPomodoroBarWidget");
            const chk = document.getElementById("chkMedulingoPomodoro");
            const quickStatus = document.getElementById("medulingoPomodoroQuickStatus");

            if (chk) chk.checked = Boolean(pomodoroSettings.showInMedulingo);

            if (quickStatus) {
                const timeStr = formatPomodoroTime(pomodoroState.timeLeft);
                if (pomodoroState.isRunning) {
                    quickStatus.textContent = `${timeStr} (běží)`;
                    quickStatus.className = "font-mono text-[11px] font-bold text-rose-400 animate-pulse hidden sm:inline";
                } else {
                    quickStatus.textContent = timeStr;
                    quickStatus.className = "font-mono text-[11px] font-bold text-rose-400/80 hidden sm:inline";
                }
            }
        }

        function toggleMedulingoPomodoroPreference(enabled) {
            pomodoroSettings.showInMedulingo = Boolean(enabled);
            savePomodoroSettings();
            updateMedulingoModalPomodoro();
            updateMedulingoPomodoroBar();
            if (typeof appendConsoleLog === "function") {
                appendConsoleLog(`🍅 [Pomodoro] Asistent v Medulingo byl ${enabled ? 'aktivován' : 'vypnut'}.`);
            }
        }

        function updateMedulingoModalPomodoro() {
            const box = document.getElementById("medModalPomodoroBox");
            const timeEl = document.getElementById("medModalPomodoroTime");
            const toggleBtn = document.getElementById("btnMedModalPomodoroToggle");

            if (!box) return;

            // Pokud má uživatel Pomodoro v Medulingo vypnuté, skryjeme
            if (!pomodoroSettings.showInMedulingo) {
                box.classList.add("hidden");
                return;
            }

            box.classList.remove("hidden");
            if (timeEl) timeEl.textContent = formatPomodoroTime(pomodoroState.timeLeft);

            if (toggleBtn) {
                if (pomodoroState.isRunning) {
                    toggleBtn.textContent = "Pauza";
                    toggleBtn.className = "px-2 py-0.5 rounded bg-amber-950/80 hover:bg-amber-900 text-amber-300 hover:text-white font-semibold text-[11px] border border-amber-800/60 transition";
                } else {
                    toggleBtn.textContent = "Start";
                    toggleBtn.className = "px-2 py-0.5 rounded bg-rose-950/80 hover:bg-rose-900 text-rose-300 hover:text-white font-semibold text-[11px] border border-rose-800/60 transition";
                }
            }
        }

        function togglePomodoroForCurrentMedQuestion() {
            if (pomodoroState.isRunning) {
                pausePomodoro();
            } else {
                if (activeMedQuestion && activeMedQuestion.question) {
                    const q = activeMedQuestion.question;
                    pomodoroState.activeQuestionId = q.id || "";
                    pomodoroState.activeQuestionTitle = q.title || "";
                    pomodoroState.activeTaskTitle = `Otázka ${q.number}: ${q.title}`;

                    const sel = document.getElementById("pomodoroQuestionSelect");
                    if (sel && q.title) sel.value = q.title;

                    const custInput = document.getElementById("pomodoroCustomTaskInput");
                    if (custInput) custInput.value = "";

                    const actBox = document.getElementById("pomoQuestionActions");
                    if (actBox) actBox.classList.remove("hidden");
                }
                startPomodoro();
            }
        }

        function updatePomodoroSettingsUI() {
            const wInput = document.getElementById("pomoWorkDurationInput");
            const sInput = document.getElementById("pomoShortBreakInput");
            const lInput = document.getElementById("pomoLongBreakInput");
            const soundToggle = document.getElementById("pomoSoundToggle");
            const autoBreakToggle = document.getElementById("pomoAutoBreakToggle");
            const miniWidgetToggle = document.getElementById("pomoMiniWidgetToggle");

            if (wInput) wInput.value = pomodoroSettings.workMinutes;
            if (sInput) sInput.value = pomodoroSettings.shortBreakMinutes;
            if (lInput) lInput.value = pomodoroSettings.longBreakMinutes;
            if (soundToggle) soundToggle.checked = Boolean(pomodoroSettings.soundEnabled);
            if (autoBreakToggle) autoBreakToggle.checked = Boolean(pomodoroSettings.autoStartBreak);
            if (miniWidgetToggle) miniWidgetToggle.checked = Boolean(pomodoroSettings.showMiniWidget);
        }

        function updatePomodoroDurationsFromUI() {
            const wInput = document.getElementById("pomoWorkDurationInput");
            const sInput = document.getElementById("pomoShortBreakInput");
            const lInput = document.getElementById("pomoLongBreakInput");

            if (wInput && parseInt(wInput.value) > 0) pomodoroSettings.workMinutes = parseInt(wInput.value);
            if (sInput && parseInt(sInput.value) > 0) pomodoroSettings.shortBreakMinutes = parseInt(sInput.value);
            if (lInput && parseInt(lInput.value) > 0) pomodoroSettings.longBreakMinutes = parseInt(lInput.value);

            savePomodoroSettings();
            if (!pomodoroState.isRunning) {
                resetPomodoro();
            }
        }

        function updatePomodoroPreferencesFromUI() {
            const soundToggle = document.getElementById("pomoSoundToggle");
            const autoBreakToggle = document.getElementById("pomoAutoBreakToggle");
            const miniWidgetToggle = document.getElementById("pomoMiniWidgetToggle");

            if (soundToggle) pomodoroSettings.soundEnabled = soundToggle.checked;
            if (autoBreakToggle) pomodoroSettings.autoStartBreak = autoBreakToggle.checked;
            if (miniWidgetToggle) pomodoroSettings.showMiniWidget = miniWidgetToggle.checked;

            savePomodoroSettings();
            updatePomodoroHeaderWidget();
        }

        function onPomodoroQuestionSelectChange() {
            const sel = document.getElementById("pomodoroQuestionSelect");
            const actBox = document.getElementById("pomoQuestionActions");
            if (!sel) return;

            const val = sel.value.trim();
            if (val) {
                pomodoroState.activeQuestionTitle = val;
                pomodoroState.activeTaskTitle = val;
                if (actBox) actBox.classList.remove("hidden");
            } else {
                pomodoroState.activeQuestionTitle = "";
                pomodoroState.activeTaskTitle = "Volné studium";
                if (actBox) actBox.classList.add("hidden");
            }
            savePomodoroState();
            updatePomodoroUI();
        }

        function onPomodoroCustomTaskInput(val) {
            const sel = document.getElementById("pomodoroQuestionSelect");
            if (sel) sel.value = "";
            const actBox = document.getElementById("pomoQuestionActions");
            if (actBox) actBox.classList.add("hidden");

            pomodoroState.activeQuestionTitle = "";
            pomodoroState.activeTaskTitle = val.trim() || "Volné studium";
            savePomodoroState();
            updatePomodoroUI();
        }

        function openPomodoroInMedulingo() {
            const title = pomodoroState.activeQuestionTitle;
            if (!title) return;
            switchTab("medulingo");

            // Najít otázku v medulingoData
            if (medulingoData && medulingoData.all_questions) {
                const found = medulingoData.all_questions.find(q => q.title === title || q.title.toLowerCase().includes(title.toLowerCase()));
                if (found) {
                    openMedulingoQuestion(found.id);
                    return;
                }
            }
            // Fallback na questions
            const fIndex = questions.findIndex(q => q.title === title);
            if (fIndex >= 0) {
                openMedulingoQuestion(questions[fIndex].id || fIndex);
            }
        }

        function openPomodoroInNotes() {
            switchTab("notes");
            const sel = document.getElementById("notesQuestionSelect");
            if (sel && pomodoroState.activeQuestionTitle) {
                sel.value = pomodoroState.activeQuestionTitle;
                if (typeof onNotesQuestionSelectChange === "function") onNotesQuestionSelectChange();
            }
        }

        function openPomodoroInCards() {
            switchTab("cards");
            const sel = document.getElementById("cardsQuestionSelect");
            if (sel && pomodoroState.activeQuestionTitle) {
                sel.value = pomodoroState.activeQuestionTitle;
                if (typeof onCardsQuestionSelectChange === "function") onCardsQuestionSelectChange();
            }
        }

        function renderPomodoroView() {
            updatePomodoroUI();
            updatePomodoroSettingsUI();

            const sel = document.getElementById("pomodoroQuestionSelect");
            if (sel && pomodoroState.activeQuestionTitle) {
                sel.value = pomodoroState.activeQuestionTitle;
            }
            const actBox = document.getElementById("pomoQuestionActions");
            if (actBox) {
                if (pomodoroState.activeQuestionTitle) actBox.classList.remove("hidden");
                else actBox.classList.add("hidden");
            }
        }

        function openPomodoroCompleteModal(phaseType, isLongBreak = false) {
            const modal = document.getElementById("modalPomodoroComplete");
            if (!modal) return;

            const icon = document.getElementById("pomoCompleteIcon");
            const title = document.getElementById("pomoCompleteTitle");
            const msg = document.getElementById("pomoCompleteMsg");
            const actionText = document.getElementById("btnPomoCompleteActionText");
            const taskBox = document.getElementById("pomoCompleteTaskBox");

            if (phaseType === "work") {
                if (icon) icon.textContent = "🎉";
                if (title) title.textContent = isLongBreak ? "4 bloky hotovy! Čas na velkou pauzu!" : "Skvělá práce! 25 minut soustředění uplynulo!";
                if (msg) {
                    msg.textContent = isLongBreak
                        ? "Dokončili jste celou sérii 4 pomodorů. Dopřejte si 15 minut pořádného odpočinku pro plnou mentální regeneraci."
                        : "Dokončili jste blok soustředění. Krátká 5minutová přestávka pomůže mozku lépe upevnit paměťové stopy.";
                }
                if (actionText) actionText.textContent = isLongBreak ? "Zahájit dlouhou pauzu (15 min)" : "Zahájit krátkou pauzu (5 min)";
            } else {
                if (icon) icon.textContent = "☕";
                if (title) title.textContent = "Přestávka skončila!";
                if (msg) msg.textContent = "Jste odpočatí a připravení vrhnout se na další 25minutový blok hlubokého soustředění?";
                if (actionText) actionText.textContent = "Zahájit další blok (25 min)";
            }

            if (taskBox) {
                if (pomodoroState.activeTaskTitle && pomodoroState.activeTaskTitle !== "Volné studium") {
                    taskBox.textContent = `🎯 Cíl: ${pomodoroState.activeTaskTitle}`;
                    taskBox.classList.remove("hidden");
                } else {
                    taskBox.classList.add("hidden");
                }
            }

            modal.classList.remove("hidden");
        }

        function closePomodoroCompleteModal() {
            const modal = document.getElementById("modalPomodoroComplete");
            if (modal) modal.classList.add("hidden");
        }

        function onPomodoroModalPrimaryAction() {
            closePomodoroCompleteModal();
            if (pomodoroState.mode === "work") {
                const isLong = pomodoroState.currentCycle >= pomodoroSettings.longBreakInterval;
                switchPomodoroMode(isLong ? "long_break" : "short_break", true);
            } else {
                switchPomodoroMode("work", true);
            }
        }

        function startNewPomodoroWorkImmediately() {
            closePomodoroCompleteModal();
            switchPomodoroMode("work", true);
        }


        // --- PODCAST PLAYER MODAL ---
        function closePodcastPlayer() {
            const modal = document.getElementById("modalPodcastPlayer");
            if (modal) modal.classList.add("hidden");
            const audioEl = document.getElementById("podcastAudioElement");
            if (audioEl) audioEl.pause();
        }

        async function openPodcastPlayer(filename) {
            document.getElementById("podcastPlayerTitle").innerText = `🎙️ ${filename}`;
            const audioEl = document.getElementById("podcastAudioElement");
            const transcriptContainer = document.getElementById("podcastTranscriptContainer");
            
            transcriptContainer.innerHTML = `<div class="text-center text-slate-500 py-10">${t("podcast.loadingTranscript", "Načítám text...")}</div>`;
            
            const modal = document.getElementById("modalPodcastPlayer");
            if (modal) modal.classList.remove("hidden");
            
            audioEl.src = `/audio/${filename}`;
            audioEl.load();

            // Fetch SRT
            const srtFilename = filename.replace(/\.(mp3|mp4)$/i, '.srt');
            try {
                const res = await fetch(`/audio/${srtFilename}`);
                if (!res.ok) throw new Error("SRT nenalezeno");
                const srtText = await res.text();
                
                const cues = parseSRT(srtText);
                
                transcriptContainer.innerHTML = '';
                if (cues.length === 0) {
                     transcriptContainer.innerHTML = `<div class="text-center text-slate-500 py-10">${t("podcast.noTranscriptFound", "Žádný text nebyl nalezen.")}</div>`;
                     audioEl.ontimeupdate = null;
                     return;
                }
                
                cues.forEach((cue, index) => {
                    const span = document.createElement("span");
                    span.className = "podcast-cue cursor-pointer hover:text-emerald-300 transition inline mr-1";
                    span.dataset.start = cue.start;
                    span.dataset.end = cue.end;
                    span.innerText = cue.text + " ";
                    span.onclick = () => {
                        audioEl.currentTime = cue.start;
                        audioEl.play();
                    };
                    transcriptContainer.appendChild(span);
                });
                
                audioEl.ontimeupdate = () => {
                    const ct = audioEl.currentTime;
                    const spans = transcriptContainer.querySelectorAll('.podcast-cue');
                    let activeSpan = null;
                    
                    spans.forEach(span => {
                        const start = parseFloat(span.dataset.start);
                        const end = parseFloat(span.dataset.end);
                        if (ct >= start && ct <= end) {
                            if (!span.classList.contains('text-emerald-400')) {
                                span.classList.add('text-emerald-400', 'bg-emerald-900/40', 'rounded', 'px-0.5');
                                span.classList.remove('text-slate-400');
                                activeSpan = span;
                            }
                        } else {
                            if (span.classList.contains('text-emerald-400')) {
                                span.classList.remove('text-emerald-400', 'bg-emerald-900/40', 'rounded', 'px-0.5');
                                span.classList.add('text-slate-400');
                            }
                        }
                    });
                    
                    if (activeSpan) {
                         // Optional: auto-scroll to active span if it gets out of view
                         const containerRect = transcriptContainer.getBoundingClientRect();
                         const spanRect = activeSpan.getBoundingClientRect();
                         
                         if (spanRect.top < containerRect.top || spanRect.bottom > containerRect.bottom) {
                             activeSpan.scrollIntoView({ behavior: 'smooth', block: 'center' });
                         }
                    }
                };

            } catch(e) {
                transcriptContainer.innerHTML = '<div class="text-center text-rose-500 py-10">Nepodařilo se načíst synchronizovaný text k tomuto audiu.</div>';
                audioEl.ontimeupdate = null;
            }
        }

        function parseSRT(srt) {
            const cues = [];
            const blocks = srt.trim().split(/\n\s*\n/);
            for (let block of blocks) {
                const lines = block.split('\n');
                if (lines.length >= 3) {
                    const timeLine = lines[1];
                    const text = lines.slice(2).join(' ');
                    const match = timeLine.match(/(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})/);
                    if (match) {
                        const start = parseInt(match[1])*3600 + parseInt(match[2])*60 + parseInt(match[3]) + parseInt(match[4])/1000;
                        const end = parseInt(match[5])*3600 + parseInt(match[6])*60 + parseInt(match[7]) + parseInt(match[8])/1000;
                        cues.push({ start, end, text });
                    }
                }
            }
            return cues;
        }
