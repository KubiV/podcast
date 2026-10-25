// =========================================================================
// Jazykové rozhraní a přepínač jazyků (odděleno z app.js, krok 3.5). Klasický skript:
// sdílí globální scope s app.js; pořadí načítání je dané v index.html.
// =========================================================================

        // =========================================================================
        // JAZYKOVÉ ROZHRANÍ & PŘEPÍNAČ JAZYKŮ (CS, EN, FR)
        // =========================================================================
        // Hlavní implementace je v static/js/translations.js (window.toggleLangDropdown, window.setAppLanguage, window.updateLangUI)
        function getCurrentLanguage() {
            return (window.currentLanguage && ["cs", "en", "fr"].includes(window.currentLanguage))
                ? window.currentLanguage
                : (localStorage.getItem("medstudio_lang") || "cs");
        }
        let currentLanguage = getCurrentLanguage();
        window.addEventListener("medstudio_lang_change", (e) => {
            currentLanguage = (e.detail && e.detail.lang) || getCurrentLanguage();
            try {
                if (typeof updateDashboardStats === "function") updateDashboardStats();
                if (typeof renderPomodoroUI === "function") renderPomodoroUI();
                if (typeof renderExamPlannerCalendar === "function") renderExamPlannerCalendar();
                if (typeof renderPlannerTable === "function") renderPlannerTable();
                if (typeof renderPlannerCalendarStrip === "function") renderPlannerCalendarStrip();
                if (typeof renderQuestionsManagerTable === "function") renderQuestionsManagerTable();
                if (typeof renderMedulingoDashboard === "function") renderMedulingoDashboard();
                if (appSettingsCache && typeof loadAppSettings === "function") {
                    const modalSettings = document.getElementById("modalSettings");
                    if (modalSettings && !modalSettings.classList.contains("hidden")) {
                        loadAppSettings(false);
                    }
                }
            } catch(err) {
                console.warn("Language refresh non-fatal error:", err);
            }
        });

