// =========================================================================
// Autentizace, správa uživatelů a schvalování přístupů (odděleno z app.js, krok 3.5). Klasický skript:
// sdílí globální scope s app.js; pořadí načítání je dané v index.html.
// =========================================================================

        // =========================================================================
        // AUTENTIZACE, SPRÁVA UŽIVATELŮ A SCHVALOVÁNÍ PŘÍSTUPŮ
        // =========================================================================
        // (currentUser a isViewerMode jsou definovány v globálním stavu nahoře)

        // Interceptor pro automatické zachycení expirace relace (401), omezení pozorovatele (403) a předávání jazyka aplikace
        const originalFetch = window.fetch;
        window.fetch = async function(...args) {
            try {
                if (args.length > 0) {
                    args[1] = args[1] || {};
                    const activeLang = typeof currentLanguage !== "undefined" ? currentLanguage : (localStorage.getItem("medstudio_lang") || "cs");
                    if (!args[1].headers) {
                        args[1].headers = { "X-App-Language": activeLang };
                    } else if (args[1].headers instanceof Headers) {
                        if (!args[1].headers.has("X-App-Language")) {
                            args[1].headers.set("X-App-Language", activeLang);
                        }
                    } else if (Array.isArray(args[1].headers)) {
                        args[1].headers.push(["X-App-Language", activeLang]);
                    } else {
                        args[1].headers["X-App-Language"] = activeLang;
                    }
                }
            } catch (e) {
                console.warn("Chyba při vkládání X-App-Language do fetch:", e);
            }

            const response = await originalFetch.apply(this, args);
            if (response.status === 401) {
                const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url ? args[0].url : "");
                if (!url.includes("/api/auth/login") && !url.includes("/api/auth/status") && !url.includes("/api/auth/setup") && !url.includes("/api/auth/register")) {
                    initAuth();
                }
            } else if (response.status === 403) {
                try {
                    const clone = response.clone();
                    const data = await clone.json();
                    if (data && data.detail && data.detail.includes("Režim pozorovatele")) {
                        showGlobalToast("👁️ " + data.detail, "warning");
                    }
                } catch (e) {}
            }
            return response;
        };

        async function initAuth() {
            try {
                const res = await fetch("/api/auth/status");
                const data = await res.json();
                authRegistrationAllowed = !!data.allow_registration;
                authGuestAllowed = !!data.allow_guest;

                if (data.needs_setup) {
                    showAuthModal('setup');
                    return;
                }

                if (data.authenticated) {
                    // Řádně přihlášený uživatel (admin / user / viewer s účtem)
                    currentUser = data.user;
                    hideAuthModal();
                    updateUserInterfaceHeader();
                    if (currentUser && currentUser.role === "admin") {
                        checkPendingRequestsNotification();
                    }
                    loadProjects();
                    loadAppSettings(true);
                    setupSSE();
                    return;
                }

                if (data.is_guest || data.allow_guest) {
                    // Je povolen režim hosta (pozorovatel bez nutnosti přihlášení)
                    currentUser = data.user || {
                        id: -1,
                        username: "host",
                        email: null,
                        role: "viewer",
                        status: "approved",
                        is_guest: true
                    };
                    hideAuthModal();
                    updateUserInterfaceHeader();
                    loadProjects();
                    loadAppSettings(true);
                    setupSSE();
                    return;
                }

                // Není přihlášen a režim hosta je vypnut – vyžaduje přihlášení
                currentUser = null;
                updateUserInterfaceHeader();
                showAuthModal('login', authRegistrationAllowed, authGuestAllowed);
            } catch (err) {
                console.warn("Chyba při ověřování přihlášení:", err);
            }
        }

        function updateUserInterfaceHeader() {
            const badge = document.getElementById("headerUserBadge");
            const iconEl = document.getElementById("headerUserIcon");
            const nameEl = document.getElementById("headerUserName");
            const roleEl = document.getElementById("headerUserRoleBadge");
            const logoutBtn = document.getElementById("headerUserLogoutBtn");
            const loginBtn = document.getElementById("headerUserLoginBtn");

            const sidebarUserFooter = document.getElementById("sidebarUserFooter");
            const sidebarIconEl = document.getElementById("sidebarUserIcon");
            const sidebarNameEl = document.getElementById("sidebarUserName");
            const sidebarRoleEl = document.getElementById("sidebarUserRoleBadge");
            const sidebarLogoutBtn = document.getElementById("sidebarUserLogoutBtn");
            const sidebarLoginBtn = document.getElementById("sidebarUserLoginBtn");

            const sidebarAdminBtn = document.getElementById("sidebarBtnAdminUsers");
            const sidebarUserBtn = document.getElementById("sidebarBtnUserProfile");
            const viewerBanner = document.getElementById("viewerBanner");

            if (!currentUser) {
                if (badge) badge.classList.add("hidden");
                if (sidebarUserFooter) sidebarUserFooter.classList.add("hidden");
                if (sidebarAdminBtn) sidebarAdminBtn.classList.add("hidden");
                if (sidebarUserBtn) sidebarUserBtn.classList.add("hidden");
                if (viewerBanner) viewerBanner.classList.add("hidden");
                return;
            }

            const isGuest = !!currentUser.is_guest;
            const isViewer = currentUser.role === "viewer";
            const isAdmin = currentUser.role === "admin";

            // Zobrazení horního banneru pro pozorovatele (hosta i přihlášeného pozorovatele)
            if (viewerBanner) {
                if (isViewer) {
                    viewerBanner.classList.remove("hidden");
                } else {
                    viewerBanner.classList.add("hidden");
                }
            }

            // Texty jména a ikony
            if (nameEl) nameEl.textContent = isGuest ? "Host" : currentUser.username;
            if (sidebarNameEl) sidebarNameEl.textContent = isGuest ? "Host" : currentUser.username;

            if (iconEl) iconEl.textContent = isAdmin ? "👑" : (isViewer ? "👁️" : "👤");
            if (sidebarIconEl) sidebarIconEl.textContent = isAdmin ? "👑" : (isViewer ? "👁️" : "👤");

            if (roleEl) {
                if (isAdmin) {
                    roleEl.textContent = "Admin";
                    roleEl.className = "text-[10px] bg-emerald-950 text-emerald-400 font-bold px-1.5 py-0.5 rounded border border-emerald-800";
                } else if (isViewer) {
                    roleEl.textContent = "Pozorovatel";
                    roleEl.className = "text-[10px] bg-purple-950 text-purple-300 font-bold px-1.5 py-0.5 rounded border border-purple-800";
                } else {
                    roleEl.textContent = "Student";
                    roleEl.className = "text-[10px] bg-blue-950 text-blue-300 font-bold px-1.5 py-0.5 rounded border border-blue-800";
                }
            }

            if (sidebarRoleEl) {
                if (isAdmin) {
                    sidebarRoleEl.textContent = "Admin";
                    sidebarRoleEl.className = "text-[9px] bg-emerald-950 text-emerald-400 font-bold px-1.5 py-0.2 rounded border border-emerald-800";
                } else if (isViewer) {
                    sidebarRoleEl.textContent = "Pozorovatel";
                    sidebarRoleEl.className = "text-[9px] bg-purple-950 text-purple-300 font-bold px-1.5 py-0.2 rounded border border-purple-800";
                } else {
                    sidebarRoleEl.textContent = "Student";
                    sidebarRoleEl.className = "text-[9px] bg-blue-950 text-blue-300 font-bold px-1.5 py-0.2 rounded border border-blue-800";
                }
            }

            // Tlačítka odhlášení vs. přihlášení (pro hosta nabízíme přihlášení)
            if (isGuest) {
                if (logoutBtn) logoutBtn.classList.add("hidden");
                if (loginBtn) loginBtn.classList.remove("hidden");
                if (sidebarLogoutBtn) sidebarLogoutBtn.classList.add("hidden");
                if (sidebarLoginBtn) sidebarLoginBtn.classList.remove("hidden");
            } else {
                if (logoutBtn) logoutBtn.classList.remove("hidden");
                if (loginBtn) loginBtn.classList.add("hidden");
                if (sidebarLogoutBtn) sidebarLogoutBtn.classList.remove("hidden");
                if (sidebarLoginBtn) sidebarLoginBtn.classList.add("hidden");
            }

            if (badge) badge.classList.remove("hidden");
            if (sidebarUserFooter) sidebarUserFooter.classList.remove("hidden");

            if (sidebarAdminBtn) {
                if (isAdmin) {
                    sidebarAdminBtn.classList.remove("hidden");
                } else {
                    sidebarAdminBtn.classList.add("hidden");
                }
            }

            if (sidebarUserBtn) {
                if (!isAdmin) {
                    sidebarUserBtn.classList.remove("hidden");
                } else {
                    sidebarUserBtn.classList.add("hidden");
                }
            }

            // Dynamická aktualizace stavu interaktivních prvků podle role (zamknutí pro pozorovatele)
            if (typeof renderPlannerTable === "function" && questions && questions.length > 0) {
                renderPlannerTable();
            }
            if (typeof renderPlannerCalendarStrip === "function") {
                renderPlannerCalendarStrip();
            }
            if (typeof renderExamPlanner === "function") {
                renderExamPlanner();
            }
            if (typeof renderQuestionsManagerTable === "function") {
                renderQuestionsManagerTable();
            }
            if (typeof renderQuestionsTable === "function") {
                renderQuestionsTable();
            }
        }

        function showAuthModal(view = 'login', allowReg = authRegistrationAllowed, allowGuest = authGuestAllowed) {
            const modal = document.getElementById("modalAuth");
            if (modal) modal.classList.remove("hidden");
            showAuthView(view, allowReg, allowGuest);
        }

        function hideAuthModal() {
            const modal = document.getElementById("modalAuth");
            if (modal) modal.classList.add("hidden");
        }

        function showAuthView(view, allowReg = authRegistrationAllowed, allowGuest = authGuestAllowed) {
            const vSetup = document.getElementById("authViewSetup");
            const vLogin = document.getElementById("authViewLogin");
            const vReg = document.getElementById("authViewRegister");
            const regBox = document.getElementById("loginRegBox");
            const regDisabledBox = document.getElementById("loginRegDisabledBox");
            const guestBox = document.getElementById("loginGuestBox");

            [vSetup, vLogin, vReg].forEach(el => el && el.classList.add("hidden"));

            if (regBox && regDisabledBox) {
                if (allowReg) {
                    regBox.classList.remove("hidden");
                    regDisabledBox.classList.add("hidden");
                } else {
                    regBox.classList.add("hidden");
                    regDisabledBox.classList.remove("hidden");
                }
            }

            if (guestBox) {
                if (allowGuest) {
                    guestBox.classList.remove("hidden");
                } else {
                    guestBox.classList.add("hidden");
                }
            }

            if (view === 'setup' && vSetup) {
                vSetup.classList.remove("hidden");
            } else if (view === 'register' && vReg) {
                vReg.classList.remove("hidden");
            } else if (vLogin) {
                vLogin.classList.remove("hidden");
            }
        }

        function continueAsGuest() {
            currentUser = {
                id: -1,
                username: "host",
                email: null,
                role: "viewer",
                status: "approved",
                is_guest: true
            };
            hideAuthModal();
            updateUserInterfaceHeader();
            showGlobalToast(t("toast.guestNotice", "👀 Vstoupili jste v režimu Pozorovatele (Host). Máte k dispozici čtení a poslech materiálů."), "info");
            loadProjects();
            loadAppSettings(true);
            setupSSE();
        }

        async function submitAuthSetup() {
            const username = document.getElementById("setupUsername")?.value.trim() || "";
            const email = document.getElementById("setupEmail")?.value.trim() || "";
            const password = document.getElementById("setupPassword")?.value || "";
            const confirm = document.getElementById("setupPasswordConfirm")?.value || "";
            const errEl = document.getElementById("setupError");
            const btn = document.getElementById("btnSubmitSetup");

            if (errEl) {
                errEl.classList.add("hidden");
                errEl.textContent = "";
            }

            if (password !== confirm) {
                if (errEl) {
                    errEl.textContent = t("settings.passwordsMismatch", "Hesla se neshodují.");
                    errEl.classList.remove("hidden");
                }
                return;
            }

            if (btn) {
                btn.disabled = true;
                btn.textContent = t("settings.creatingAccount", "Vytvářím účet...");
            }

            try {
                const res = await sendJson("/api/auth/setup", { username, email, password });
                const data = await res.json();
                if (!res.ok) {
                    throw new Error(data.detail || "Chyba při zakládání administrátora.");
                }

                currentUser = data.user;
                hideAuthModal();
                updateUserInterfaceHeader();
                showGlobalToast(t("toast.adminCreated", "🎉 Administrátorský účet byl úspěšně vytvořen! Vítejte v AI MedStudio."), "success");
                loadProjects();
                loadAppSettings(true);
                setupSSE();
            } catch (err) {
                if (errEl) {
                    errEl.textContent = err.message;
                    errEl.classList.remove("hidden");
                }
            } finally {
                if (btn) {
                    btn.disabled = false;
                    btn.textContent = "🚀 Vytvořit administrátorský účet a vstoupit";
                }
            }
        }

        async function submitAuthLogin() {
            const username = document.getElementById("loginUsername")?.value.trim() || "";
            const password = document.getElementById("loginPassword")?.value || "";
            const rememberMe = document.getElementById("loginRememberMe")?.checked ?? true;
            const errEl = document.getElementById("loginError");
            const btn = document.getElementById("btnSubmitLogin");

            if (errEl) {
                errEl.classList.add("hidden");
                errEl.textContent = "";
            }

            if (btn) {
                btn.disabled = true;
                btn.textContent = t("settings.loggingIn", "Přihlašuji...");
            }

            try {
                const res = await sendJson("/api/auth/login", { username, password, remember_me: rememberMe });
                const data = await res.json();
                if (!res.ok) {
                    throw new Error(data.detail || "Neplatné přihlašovací údaje.");
                }

                currentUser = data.user;
                hideAuthModal();
                updateUserInterfaceHeader();
                showGlobalToast(`Vítejte zpět, ${currentUser.username}!`, "success");

                if (currentUser.role === "admin") {
                    checkPendingRequestsNotification();
                }

                loadProjects();
                loadAppSettings(true);
                setupSSE();
            } catch (err) {
                if (errEl) {
                    errEl.textContent = err.message;
                    errEl.classList.remove("hidden");
                }
            } finally {
                if (btn) {
                    btn.disabled = false;
                    btn.textContent = "➔ Přihlásit se";
                }
            }
        }

        async function submitAuthRegister() {
            const username = document.getElementById("regUsername")?.value.trim() || "";
            const email = document.getElementById("regEmail")?.value.trim() || "";
            const password = document.getElementById("regPassword")?.value || "";
            const confirm = document.getElementById("regPasswordConfirm")?.value || "";
            const errEl = document.getElementById("regError");
            const btn = document.getElementById("btnSubmitRegister");

            if (errEl) {
                errEl.className = "hidden p-2.5 rounded-lg text-xs";
                errEl.textContent = "";
            }

            if (password !== confirm) {
                if (errEl) {
                    errEl.className = "p-2.5 rounded-lg bg-red-950/70 border border-red-800 text-red-300 text-xs";
                    errEl.textContent = t("settings.passwordsMismatch", "Hesla se neshodují.");
                }
                return;
            }

            if (btn) {
                btn.disabled = true;
                btn.textContent = t("settings.sendingRequest", "Odesílám žádost...");
            }

            try {
                const res = await sendJson("/api/auth/register", { username, email, password });
                const data = await res.json();
                if (!res.ok) {
                    throw new Error(data.detail || "Chyba při odesílání žádosti o registraci.");
                }

                if (errEl) {
                    errEl.className = "p-3 rounded-lg bg-emerald-950/70 border border-emerald-700 text-emerald-300 text-xs leading-relaxed";
                    errEl.innerHTML = "<strong>✅ Žádost byla úspěšně odeslána!</strong><br>Administrátor serveru váš účet zkontroluje a schválí. Poté se budete moci přihlásit.";
                }
                document.getElementById("formAuthRegister")?.reset();
            } catch (err) {
                if (errEl) {
                    errEl.className = "p-2.5 rounded-lg bg-red-950/70 border border-red-800 text-red-300 text-xs";
                    errEl.textContent = err.message;
                }
            } finally {
                if (btn) {
                    btn.disabled = false;
                    btn.textContent = "📨 Odeslat žádost administrátorovi";
                }
            }
        }

        async function submitAuthLogout() {
            try {
                await fetch("/api/auth/logout", { method: "POST" });
            } catch (err) {
                console.warn("Chyba při odhlašování:", err);
            }
            currentUser = null;
            const badge = document.getElementById("headerUserBadge");
            if (badge) badge.classList.add("hidden");
            const sidebarFooter = document.getElementById("sidebarUserFooter");
            if (sidebarFooter) sidebarFooter.classList.add("hidden");
            const sidebarAdminBtn = document.getElementById("sidebarBtnAdminUsers");
            if (sidebarAdminBtn) sidebarAdminBtn.classList.add("hidden");
            const sidebarUserBtn = document.getElementById("sidebarBtnUserProfile");
            if (sidebarUserBtn) sidebarUserBtn.classList.add("hidden");
            const sidebarBadge = document.getElementById("sidebarAdminPendingBadge");
            if (sidebarBadge) sidebarBadge.classList.add("hidden");
            closeSettingsModal();
            showAuthModal('login');
        }

        function switchSettingsTab(tab = 'general') {
            const btnGen = document.getElementById("tabBtnSettingsGeneral");
            const btnUsers = document.getElementById("tabBtnSettingsUsers");
            const contentGen = document.getElementById("settingsGeneralTabContent");
            const contentUsers = document.getElementById("settingsUsersTabContent");
            const btnSave = document.getElementById("btnSaveSettings");
            const statusEl = document.getElementById("settingsSaveStatus");

            if (tab === 'users') {
                if (btnGen) {
                    btnGen.className = "px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-400 hover:text-white hover:bg-slate-800 border border-transparent transition";
                }
                if (btnUsers) {
                    btnUsers.className = "px-3 py-1.5 rounded-lg text-xs font-bold bg-slate-800 text-white border border-slate-700 transition flex items-center gap-1.5";
                }
                if (contentGen) contentGen.classList.add("hidden");
                if (contentUsers) contentUsers.classList.remove("hidden");
                if (btnSave) btnSave.classList.add("hidden");
                if (statusEl) statusEl.textContent = "";
                const modal = document.getElementById("modalSettings");
                if (typeof applyTranslations === "function" && modal) {
                    applyTranslations(currentLanguage, modal);
                }
                loadAdminUserManagement();
            } else {
                if (btnGen) {
                    btnGen.className = "px-3 py-1.5 rounded-lg text-xs font-bold bg-slate-800 text-white border border-slate-700 transition";
                }
                if (btnUsers) {
                    btnUsers.className = "px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-400 hover:text-white hover:bg-slate-800 border border-transparent transition flex items-center gap-1.5";
                }
                if (contentGen) contentGen.classList.remove("hidden");
                if (contentUsers) contentUsers.classList.add("hidden");
                if (btnSave) btnSave.classList.remove("hidden");
            }
        }

        async function checkPendingRequestsNotification() {
            try {
                const res = await fetch("/api/auth/admin/pending");
                if (!res.ok) return;
                const data = await res.json();
                const count = (data.pending || []).length;
                
                const dot = document.getElementById("settingsPendingBadge");
                const tabBadge = document.getElementById("settingsTabPendingBadge");
                const sidebarBadge = document.getElementById("sidebarAdminPendingBadge");

                if (dot) {
                    if (count > 0) {
                        dot.textContent = count > 9 ? "9+" : count;
                        dot.classList.remove("hidden");
                    } else {
                        dot.classList.add("hidden");
                    }
                }
                if (tabBadge) {
                    if (count > 0) {
                        tabBadge.textContent = count;
                        tabBadge.classList.remove("hidden");
                    } else {
                        tabBadge.classList.add("hidden");
                    }
                }
                if (sidebarBadge) {
                    if (count > 0) {
                        sidebarBadge.textContent = count > 9 ? "9+" : count;
                        sidebarBadge.classList.remove("hidden");
                    } else {
                        sidebarBadge.classList.add("hidden");
                    }
                }
            } catch (err) {
                console.warn("Chyba při zjišťování čekajících žádostí:", err);
            }
        }

        async function loadAdminUserManagement() {
            if (!currentUser) return;

            const pIcon = document.getElementById("settingsProfileIcon");
            const pName = document.getElementById("settingsProfileUsername");
            const pRole = document.getElementById("settingsProfileRole");
            const pEmail = document.getElementById("settingsProfileEmail");
            const pLoginBtn = document.getElementById("settingsProfileLoginBtn");
            const pLogoutBtn = document.getElementById("settingsProfileLogoutBtn");
            const adminArea = document.getElementById("adminControlsArea");
            const nonAdminNotice = document.getElementById("userNonAdminNotice");

            const isGuest = !!currentUser.is_guest;
            const isViewer = currentUser.role === "viewer";
            const isAdmin = currentUser.role === "admin";

            if (pIcon) pIcon.textContent = isAdmin ? "👑" : (isViewer ? "👁️" : "👤");
            if (pName) pName.textContent = isGuest ? t("settings.unregisteredGuest", "Host") : currentUser.username;
            if (pEmail) pEmail.textContent = isGuest ? t("settings.unregisteredGuest", "Nepřihlášený návštěvník") : (currentUser.email || t("settings.noEmail", "bez e-mailu"));

            if (pRole) {
                if (isAdmin) {
                    pRole.textContent = t("settings.roleAdmin", "Admin");
                    pRole.className = "text-[10px] bg-emerald-950 text-emerald-400 font-bold px-1.5 py-0.5 rounded border border-emerald-800";
                } else if (isViewer) {
                    pRole.textContent = t("settings.roleViewer", "Pozorovatel");
                    pRole.className = "text-[10px] bg-purple-950 text-purple-300 font-bold px-1.5 py-0.5 rounded border border-purple-800";
                } else {
                    pRole.textContent = t("settings.roleStudent", "Student");
                    pRole.className = "text-[10px] bg-blue-950 text-blue-300 font-bold px-1.5 py-0.5 rounded border border-blue-800";
                }
            }

            if (isGuest) {
                if (pLoginBtn) pLoginBtn.classList.remove("hidden");
                if (pLogoutBtn) pLogoutBtn.classList.add("hidden");
            } else {
                if (pLoginBtn) pLoginBtn.classList.add("hidden");
                if (pLogoutBtn) pLogoutBtn.classList.remove("hidden");
            }

            if (!isAdmin) {
                if (adminArea) adminArea.classList.add("hidden");
                if (nonAdminNotice) nonAdminNotice.classList.remove("hidden");
                return;
            }

            if (adminArea) adminArea.classList.remove("hidden");
            if (nonAdminNotice) nonAdminNotice.classList.add("hidden");

            // 1. Načíst čekající žádosti a uživatele paralelně pro maximální rychlost
            const pendingContainer = document.getElementById("pendingRequestsContainer");
            const pendingCountBadge = document.getElementById("pendingRequestsCountBadge");
            const usersContainer = document.getElementById("allUsersContainer");
            const regToggle = document.getElementById("settingsAllowRegistrationToggle");
            const guestToggle = document.getElementById("settingsAllowGuestToggle");
            const sharedApiKeysToggle = document.getElementById("settingsSharedApiKeysToggle");
            const sharedProjectsToggle = document.getElementById("settingsSharedProjectsToggle");

            try {
                const [resP, resU] = await Promise.all([
                    fetch("/api/auth/admin/pending"),
                    fetch("/api/auth/admin/users")
                ]);

                if (resP.ok) {
                    const dataP = await resP.json();
                    const pendingList = dataP.pending || [];
                    
                    if (pendingCountBadge) pendingCountBadge.textContent = pendingList.length;
                    checkPendingRequestsNotification();

                    if (pendingContainer) {
                        const dateLocale = currentLanguage === 'en' ? 'en-US' : (currentLanguage === 'fr' ? 'fr-FR' : 'cs-CZ');
                        if (pendingList.length === 0) {
                            pendingContainer.innerHTML = `
                                <div class="text-xs text-slate-500 py-3 text-center bg-slate-950/40 rounded-xl border border-slate-800/60 flex items-center justify-center gap-1.5">
                                    <span>✅</span> ${t("settings.noPendingRequests", "Žádné čekající žádosti o schválení.")}
                                </div>
                            `;
                        } else {
                            pendingContainer.innerHTML = pendingList.map(u => `
                                <div class="p-3 rounded-xl bg-slate-950/90 border border-amber-900/40 flex items-center justify-between flex-wrap gap-2 text-xs">
                                    <div>
                                        <div class="flex items-center gap-2">
                                            <span class="font-bold text-white">${escapeHtml(u.username)}</span>
                                            <span class="text-[10px] bg-amber-950 text-amber-300 font-bold px-1.5 py-0.2 rounded border border-amber-800">${t("settings.pendingApprovalBadge", "Čeká na schválení")}</span>
                                        </div>
                                        <p class="text-slate-400 text-[11px] mt-0.5">
                                            ${u.email ? escapeHtml(u.email) + ' • ' : ''}${t("settings.registeredDate", "Registrováno: {date}", { date: new Date(u.created_at).toLocaleString(dateLocale) })}
                                        </p>
                                    </div>
                                    <div class="flex items-center gap-2 flex-wrap">
                                        <button type="button" onclick="adminApproveUser(${u.id}, 'user')" class="px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs transition flex items-center gap-1 shadow-sm" title="${t("settings.approveStudentTitle", "Schválit jako běžného studenta (plná tvorba)")}">
                                            <span>🎓</span> ${t("settings.approveStudent", "Student")}
                                        </button>
                                        <button type="button" onclick="adminApproveUser(${u.id}, 'viewer')" class="px-2.5 py-1 rounded-lg bg-purple-900 hover:bg-purple-800 text-purple-200 border border-purple-700/80 font-bold text-xs transition flex items-center gap-1 shadow-sm" title="${t("settings.approveViewerTitle", "Schválit jako pozorovatele (pouze čtení a poslech)")}">
                                            <span>👁️</span> ${t("settings.approveViewer", "Pozorovatel")}
                                        </button>
                                        <button type="button" onclick="adminRejectUser(${u.id})" class="px-2.5 py-1 rounded-lg bg-red-950 hover:bg-red-900 text-red-200 border border-red-800/80 font-bold text-xs transition flex items-center gap-1">
                                            <span>❌</span> ${t("settings.rejectUser", "Zamítnout")}
                                        </button>
                                    </div>
                                </div>
                            `).join("");
                        }
                    }
                }

                if (resU.ok) {
                    const dataU = await resU.json();
                    const usersList = dataU.users || [];
                    const summary = dataU.summary || {};

                    if (regToggle) {
                        regToggle.checked = !!summary.allow_registration;
                    }
                    if (guestToggle) {
                        guestToggle.checked = !!summary.allow_guest;
                    }
                    if (sharedApiKeysToggle) {
                        sharedApiKeysToggle.checked = summary.shared_api_keys !== false;
                    }
                    if (sharedProjectsToggle) {
                        sharedProjectsToggle.checked = summary.shared_projects !== false;
                    }

                    if (usersContainer) {
                        const dateLocale = currentLanguage === 'en' ? 'en-US' : (currentLanguage === 'fr' ? 'fr-FR' : 'cs-CZ');
                        if (usersList.length === 0) {
                            usersContainer.innerHTML = `<div class="text-xs text-slate-500 py-2">${t("settings.noUsersFound", "Žádní uživatelé.")}</div>`;
                        } else {
                            usersContainer.innerHTML = usersList.map(u => {
                                const isMe = u.id === currentUser.id;
                                const isApproved = u.status === "approved";
                                const isDisabled = u.status === "disabled";
                                const isPending = u.status === "pending";

                                let statusBadge = "";
                                if (isApproved) {
                                    statusBadge = `<span class="text-[10px] bg-emerald-950 text-emerald-400 font-bold px-1.5 py-0.2 rounded border border-emerald-800 transition-all">${t("settings.statusActive", "Aktivní")}</span>`;
                                } else if (isDisabled) {
                                    statusBadge = `<span class="text-[10px] bg-red-950 text-red-400 font-bold px-1.5 py-0.2 rounded border border-red-800 transition-all">${t("settings.statusBlocked", "Zablokován")}</span>`;
                                } else if (isPending) {
                                    statusBadge = `<span class="text-[10px] bg-amber-950 text-amber-300 font-bold px-1.5 py-0.2 rounded border border-amber-800 transition-all">${t("settings.statusPending", "Čeká")}</span>`;
                                } else {
                                    statusBadge = `<span class="text-[10px] bg-slate-800 text-slate-400 px-1.5 py-0.2 rounded transition-all">${escapeHtml(u.status)}</span>`;
                                }

                                let roleIcon = '👤';
                                let roleBadgeClass = 'bg-blue-950 text-blue-300 border-blue-800';
                                let roleName = t("settings.roleStudent", "Student");
                                if (u.role === 'admin') {
                                    roleIcon = '👑';
                                    roleBadgeClass = 'bg-emerald-950 text-emerald-400 border-emerald-800';
                                    roleName = t("settings.roleAdmin", "Admin");
                                } else if (u.role === 'viewer') {
                                    roleIcon = '👁️';
                                    roleBadgeClass = 'bg-purple-950 text-purple-300 border-purple-800';
                                    roleName = t("settings.roleViewer", "Pozorovatel");
                                }

                                return `
                                    <div id="adminUserRow_${u.id}" class="p-3 rounded-xl bg-slate-950/60 border border-slate-800/80 flex items-center justify-between flex-wrap gap-2 text-xs">
                                        <div class="flex items-center gap-2.5">
                                            <div class="w-7 h-7 rounded-lg bg-slate-800 border border-slate-700 flex items-center justify-center text-xs">
                                                ${roleIcon}
                                            </div>
                                            <div>
                                                <div class="flex items-center gap-2 flex-wrap">
                                                    <span class="font-bold text-white">${escapeHtml(u.username)}</span>
                                                    ${isMe ? `<span class="text-[10px] text-emerald-400 font-bold">${t("settings.youBadge", "(Vy)")}</span>` : ''}
                                                    <span class="text-[10px] ${roleBadgeClass} font-bold px-1.5 py-0.2 rounded border">${roleName}</span>
                                                    <span id="adminUserStatusBadge_${u.id}">${statusBadge}</span>
                                                </div>
                                                <p class="text-slate-400 text-[11px] mt-0.5">
                                                    ${u.email ? escapeHtml(u.email) + ' • ' : ''}${t("settings.lastLoginLabel", "Poslední přihlášení: {time}", { time: u.last_login ? new Date(u.last_login).toLocaleString(dateLocale) : t("settings.never", "nikdy") })}
                                                </p>
                                            </div>
                                        </div>
                                        <div class="flex items-center gap-2 flex-wrap">
                                            ${!isMe ? `
                                                <select onchange="adminChangeRole(${u.id}, this.value)" class="bg-slate-900 border border-slate-700 text-[11px] text-slate-200 rounded-lg px-2 py-1 focus:border-emerald-500 focus:outline-none" title="${t("settings.changeRoleTitle", "Změnit uživatelskou roli")}">
                                                    <option value="user" ${u.role === 'user' ? 'selected' : ''}>🎓 ${t("settings.roleStudent", "Student")}</option>
                                                    <option value="viewer" ${u.role === 'viewer' ? 'selected' : ''}>👁️ ${t("settings.roleViewer", "Pozorovatel")}</option>
                                                    <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>👑 ${t("settings.roleAdmin", "Admin")}</option>
                                                </select>
                                                <button type="button" 
                                                    id="adminToggleBtn_${u.id}" 
                                                    data-status="${isDisabled ? 'disabled' : (isApproved ? 'approved' : u.status)}" 
                                                    onclick="adminToggleUserStatus(${u.id}, this)" 
                                                    class="px-2 py-1 rounded-lg ${isDisabled ? 'bg-emerald-950 text-emerald-300 border border-emerald-800' : 'bg-slate-800 text-slate-300 hover:text-white'} text-xs font-semibold transition active:scale-95 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1" 
                                                    title="${isDisabled ? t("settings.unblockAccount", "Odblokovat účet") : t("settings.blockAccount", "Zablokovat účet")}">
                                                    ${isDisabled ? t("settings.btnUnblock", "🔓 Odblokovat") : t("settings.btnBlock", "🔒 Zablokovat")}
                                                </button>
                                                <button type="button" onclick="adminDeleteUser(${u.id}, '${escapeJsStringAttr(u.username)}')" class="px-2 py-1 rounded-lg bg-red-950/60 hover:bg-red-900 border border-red-800/80 text-red-300 text-xs transition active:scale-95 cursor-pointer" title="${t("settings.deleteUserTitle", "Smazat uživatele")}">
                                                    🗑️
                                                </button>
                                            ` : `
                                                <span class="text-[11px] text-slate-500 italic pr-2">${t("settings.activeSession", "Aktivní relace")}</span>
                                            `}
                                        </div>
                                    </div>
                                `;
                            }).join("");
                        }
                    }
                }
            } catch (err) {
                if (usersContainer) {
                    usersContainer.innerHTML = `<div class="text-xs text-red-400 p-2">Nelze načíst uživatele: ${escapeHtml(err.message)}</div>`;
                }
            }
        }

        async function adminApproveUser(userId, role = "user") {
            try {
                const res = await fetch(`/api/auth/admin/approve/${userId}?role=${encodeURIComponent(role)}`, { method: "POST" });
                const data = await res.json();
                if (!res.ok) throw new Error(data.detail || "Chyba při schvalování uživatele.");
                showGlobalToast(data.message || "✅ Účet byl úspěšně schválen.", "success");
                loadAdminUserManagement();
            } catch (err) {
                showGlobalToast(err.message, "error");
            }
        }

        async function adminChangeRole(userId, newRole) {
            try {
                const res = await sendJson(`/api/auth/admin/change-role/${userId}`, { role: newRole });
                const data = await res.json();
                if (!res.ok) throw new Error(data.detail || "Chyba při změně role uživatele.");
                showGlobalToast(data.message || "Role byla úspěšně změněna.", "success");
                loadAdminUserManagement();
            } catch (err) {
                showGlobalToast(err.message, "error");
                loadAdminUserManagement();
            }
        }

        async function adminRejectUser(userId) {
            if (!confirm(t("settings.confirmRejectRegistration", "Opravdu chcete tuto žádost o registraci zamítnout?"))) return;
            try {
                const res = await fetch(`/api/auth/admin/reject/${userId}`, { method: "POST" });
                const data = await res.json();
                if (!res.ok) throw new Error(data.detail || "Chyba při zamítání žádosti.");
                showGlobalToast(t("toast.requestRejected", "Žádost byla zamítnuta."), "info");
                loadAdminUserManagement();
            } catch (err) {
                showGlobalToast(err.message, "error");
            }
        }

        async function adminToggleUserStatus(userId, btnEl = null) {
            const btn = btnEl || document.getElementById(`adminToggleBtn_${userId}`);
            const badgeContainer = document.getElementById(`adminUserStatusBadge_${userId}`);

            if (btn && (btn.dataset.busy === "true" || btn.disabled)) return;

            // Zjistit aktuální a cílový stav
            const prevStatus = btn?.dataset.status || (btn?.textContent.includes("Odblokovat") ? "disabled" : "approved");
            const isCurrentlyDisabled = prevStatus === "disabled";
            const targetStatus = isCurrentlyDisabled ? "approved" : "disabled";

            // 1. OKAMŽITÁ RESPONZIVNÍ OPTIMISTICKÁ ZMĚNA (0 ms zpoždění pro uživatele)
            if (btn) {
                btn.dataset.busy = "true";
                btn.disabled = true;
                btn.dataset.status = targetStatus;

                if (targetStatus === "disabled") {
                    btn.className = "px-2 py-1 rounded-lg bg-emerald-950 text-emerald-300 border border-emerald-800 text-xs font-semibold transition active:scale-95 cursor-pointer disabled:opacity-75 disabled:cursor-not-allowed inline-flex items-center gap-1";
                    btn.title = "Odblokovat účet";
                    btn.innerHTML = `<span class="animate-spin inline-block text-[10px]">⏳</span> <span>Odblokovat</span>`;
                } else {
                    btn.className = "px-2 py-1 rounded-lg bg-slate-800 text-slate-300 hover:text-white text-xs font-semibold transition active:scale-95 cursor-pointer disabled:opacity-75 disabled:cursor-not-allowed inline-flex items-center gap-1";
                    btn.title = "Zablokovat účet";
                    btn.innerHTML = `<span class="animate-spin inline-block text-[10px]">⏳</span> <span>Zablokovat</span>`;
                }
            }

            if (badgeContainer) {
                if (targetStatus === "disabled") {
                    badgeContainer.innerHTML = `<span class="text-[10px] bg-red-950 text-red-400 font-bold px-1.5 py-0.2 rounded border border-red-800 transition-all">Zablokován</span>`;
                } else {
                    badgeContainer.innerHTML = `<span class="text-[10px] bg-emerald-950 text-emerald-400 font-bold px-1.5 py-0.2 rounded border border-emerald-800 transition-all">Aktivní</span>`;
                }
            }

            // 2. VOLÁNÍ SERVERU
            try {
                const res = await fetch(`/api/auth/admin/toggle-status/${userId}`, { method: "POST" });
                const data = await res.json();
                if (!res.ok) throw new Error(data.detail || "Chyba při změně stavu uživatele.");

                const finalStatus = data.new_status || targetStatus;
                const isFinalDisabled = finalStatus === "disabled";

                if (btn) {
                    btn.dataset.status = finalStatus;
                    btn.disabled = false;
                    delete btn.dataset.busy;
                    if (isFinalDisabled) {
                        btn.className = "px-2 py-1 rounded-lg bg-emerald-950 text-emerald-300 border border-emerald-800 text-xs font-semibold transition active:scale-95 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1";
                        btn.title = "Odblokovat účet";
                        btn.innerHTML = "🔓 Odblokovat";
                    } else {
                        btn.className = "px-2 py-1 rounded-lg bg-slate-800 text-slate-300 hover:text-white text-xs font-semibold transition active:scale-95 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1";
                        btn.title = "Zablokovat účet";
                        btn.innerHTML = "🔒 Zablokovat";
                    }
                }

                if (badgeContainer) {
                    if (isFinalDisabled) {
                        badgeContainer.innerHTML = `<span class="text-[10px] bg-red-950 text-red-400 font-bold px-1.5 py-0.2 rounded border border-red-800 transition-all">Zablokován</span>`;
                    } else {
                        badgeContainer.innerHTML = `<span class="text-[10px] bg-emerald-950 text-emerald-400 font-bold px-1.5 py-0.2 rounded border border-emerald-800 transition-all">Aktivní</span>`;
                    }
                }

                showGlobalToast(data.message || (isFinalDisabled ? "Účet byl zablokován." : "Účet byl odblokován."), "success");
            } catch (err) {
                // 3. VRÁCENÍ PŮVODNÍHO STAVU PŘI CHYBĚ (ROLLBACK)
                if (btn) {
                    btn.dataset.status = prevStatus;
                    btn.disabled = false;
                    delete btn.dataset.busy;
                    if (isCurrentlyDisabled) {
                        btn.className = "px-2 py-1 rounded-lg bg-emerald-950 text-emerald-300 border border-emerald-800 text-xs font-semibold transition active:scale-95 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1";
                        btn.title = "Odblokovat účet";
                        btn.innerHTML = "🔓 Odblokovat";
                    } else {
                        btn.className = "px-2 py-1 rounded-lg bg-slate-800 text-slate-300 hover:text-white text-xs font-semibold transition active:scale-95 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1";
                        btn.title = "Zablokovat účet";
                        btn.innerHTML = "🔒 Zablokovat";
                    }
                }

                if (badgeContainer) {
                    if (isCurrentlyDisabled) {
                        badgeContainer.innerHTML = `<span class="text-[10px] bg-red-950 text-red-400 font-bold px-1.5 py-0.2 rounded border border-red-800 transition-all">Zablokován</span>`;
                    } else {
                        badgeContainer.innerHTML = `<span class="text-[10px] bg-emerald-950 text-emerald-400 font-bold px-1.5 py-0.2 rounded border border-emerald-800 transition-all">Aktivní</span>`;
                    }
                }

                showGlobalToast(err.message, "error");
            }
        }

        async function adminDeleteUser(userId, username) {
            if (!confirm(`Opravdu chcete smazat uživatele "${username}"? Tato akce je nevratná.`)) return;
            const row = document.getElementById(`adminUserRow_${userId}`);
            if (row) {
                row.style.opacity = "0.4";
                row.style.pointerEvents = "none";
            }
            try {
                const res = await fetch(`/api/auth/admin/users/${userId}`, { method: "DELETE" });
                const data = await res.json();
                if (!res.ok) {
                    if (row) {
                        row.style.opacity = "1";
                        row.style.pointerEvents = "auto";
                    }
                    throw new Error(data.detail || "Chyba při mazání uživatele.");
                }
                if (row) row.remove();
                showGlobalToast(`Uživatel "${username}" byl smazán.`, "info");
                loadAdminUserManagement();
            } catch (err) {
                showGlobalToast(err.message, "error");
            }
        }

        async function adminToggleRegistration(enabled) {
            const statusEl = document.getElementById("regToggleStatus");
            try {
                const res = await sendJson("/api/auth/admin/registration-toggle", { allow_registration: enabled });
                const data = await res.json();
                if (!res.ok) throw new Error(data.detail || "Chyba při změně nastavení registrací.");
                authRegistrationAllowed = enabled;
                if (statusEl) {
                    statusEl.textContent = enabled ? "✅ Registrace nových účtů jsou povoleny (vyžadují vaše schválení)." : "🔒 Registrace nových účtů jsou vypnuty.";
                    statusEl.classList.remove("hidden");
                    setTimeout(() => statusEl.classList.add("hidden"), 4000);
                }
            } catch (err) {
                showGlobalToast(err.message, "error");
            }
        }

        async function adminToggleGuest(enabled) {
            const statusEl = document.getElementById("guestToggleStatus");
            try {
                const res = await sendJson("/api/auth/admin/guest-toggle", { allow_guest: enabled });
                const data = await res.json();
                if (!res.ok) throw new Error(data.detail || "Chyba při změně nastavení hostů.");
                authGuestAllowed = enabled;
                if (statusEl) {
                    statusEl.textContent = enabled ? "✅ Režim hosta je zapnut. Návštěvníci mohou procházet aplikaci jako pozorovatelé." : "🔒 Režim hosta je vypnut. Návštěvníci se musí přihlásit.";
                    statusEl.classList.remove("hidden");
                    setTimeout(() => statusEl.classList.add("hidden"), 4000);
                }
            } catch (err) {
                showGlobalToast(err.message, "error");
            }
        }

        async function adminToggleSharedApiKeys(enabled) {
            try {
                const res = await sendJson("/api/auth/admin/shared-api-keys-toggle", { shared_api_keys: enabled });
                const data = await res.json();
                if (!res.ok) throw new Error(data.detail || "Chyba při změně sdílení API klíčů.");
                showGlobalToast(
                    enabled 
                        ? t("toast.apiSharedOn", "🔑 Všichni uživatelé nyní sdílejí centrální API klíče od administrátora.")
                        : t("toast.apiSharedOff", "🔑 Každý uživatel (mimo pozorovatele) si nyní může nastavit vlastní API klíče."),
                    "success"
                );
                await loadAppSettings(false);
            } catch (err) {
                showGlobalToast(err.message, "error");
                loadAdminUserManagement();
            }
        }

        async function adminToggleSharedProjects(enabled) {
            try {
                const res = await sendJson("/api/auth/admin/shared-projects-toggle", { shared_projects: enabled });
                const data = await res.json();
                if (!res.ok) throw new Error(data.detail || "Chyba při změně sdílení projektů.");
                showGlobalToast(
                    enabled 
                        ? t("toast.projectsSharedOn", "📁 Všechny projekty jsou nyní sdíleny napříč všemi uživateli.")
                        : t("toast.projectsSharedOff", "📁 Každý uživatel má nyní své vlastní soukromé projekty oddělené od ostatních."),
                    "success"
                );
                await loadProjects();
            } catch (err) {
                showGlobalToast(err.message, "error");
                loadAdminUserManagement();
            }
        }

        function openSettingsModal(defaultTab = 'general') {
            const modal = document.getElementById("modalSettings");
            if (!modal) return;
            modal.classList.remove("hidden");
            if (typeof applyTranslations === "function") {
                applyTranslations(currentLanguage, modal);
            }
            // Vyčistit předchozí stavové hlášky
            ["Gemini", "Openai", "Elevenlabs"].forEach(p => {
                const el = document.getElementById(`statusSettings${p}`);
                if (el) {
                    el.className = "text-xs hidden mt-1";
                    el.textContent = "";
                }
            });
            const statusEl = document.getElementById("settingsSaveStatus");
            if (statusEl) statusEl.textContent = "";
            loadAppSettings(false);
            switchSettingsTab(defaultTab);
        }

        function closeSettingsModal() {
            const modal = document.getElementById("modalSettings");
            if (modal) modal.classList.add("hidden");
        }


        function togglePasswordVisibility(inputId) {
            const input = document.getElementById(inputId);
            if (!input) return;
            input.type = input.type === "password" ? "text" : "password";
        }

        async function testApiKey(provider) {
            const cap = provider.charAt(0).toUpperCase() + provider.slice(1);
            const inputId = provider === "gemini" ? "inputSettingsGeminiKey" :
                            provider === "openai" ? "inputSettingsOpenaiKey" : "inputSettingsElevenlabsKey";
            const input = document.getElementById(inputId);
            const statusEl = document.getElementById(`statusSettings${cap}`);
            const btn = document.getElementById(`btnTest${cap}`);

            const keyVal = input ? input.value.trim() : "";

            if (btn) {
                btn.disabled = true;
                btn.textContent = "Ověřuji...";
            }
            if (statusEl) {
                statusEl.className = "text-xs text-slate-400 mt-1 block";
                statusEl.textContent = t("settings.testingApi", "Probíhá test připojení k API...");
            }

            try {
                const payload = { provider, key: keyVal };
                if (provider === "gemini") {
                    payload.model = getSelectedModel("geminiModelSelect", "geminiModelCustomInput");
                }
                const res = await sendJson("/api/settings/test-key", payload);
                const data = await res.json();
                if (statusEl) {
                    if (data.valid) {
                        statusEl.className = "text-xs text-emerald-400 font-semibold mt-1 block";
                        statusEl.textContent = "✅ " + data.message;
                    } else {
                        statusEl.className = "text-xs text-red-400 font-semibold mt-1 block";
                        statusEl.textContent = "❌ " + data.message;
                    }
                }
            } catch (err) {
                if (statusEl) {
                    statusEl.className = "text-xs text-red-400 font-semibold mt-1 block";
                    statusEl.textContent = "❌ Chyba spojení: " + err.message;
                }
            } finally {
                if (btn) {
                    btn.disabled = false;
                    btn.textContent = "Ověřit";
                }
            }
        }

        async function saveAppSettings() {
            const btn = document.getElementById("btnSaveSettings");
            const statusEl = document.getElementById("settingsSaveStatus");

            const geminiInput = document.getElementById("inputSettingsGeminiKey");
            const openaiInput = document.getElementById("inputSettingsOpenaiKey");
            const elevenlabsInput = document.getElementById("inputSettingsElevenlabsKey");

            const payload = {};
            if (geminiInput && geminiInput.value.trim()) {
                payload.gemini_api_key = geminiInput.value.trim();
            }
            if (openaiInput && openaiInput.value.trim()) {
                payload.openai_api_key = openaiInput.value.trim();
            }
            if (elevenlabsInput && elevenlabsInput.value.trim()) {
                payload.elevenlabs_api_key = elevenlabsInput.value.trim();
            }
            if (typeof savePomodoroSettingsFromModal === "function") {
                payload.pomodoro_settings = savePomodoroSettingsFromModal();
            }

            if (btn) {
                btn.disabled = true;
                btn.textContent = "⏳ Ukládám...";
            }
            if (statusEl) {
                statusEl.className = "text-xs text-slate-400";
                statusEl.textContent = "Ukládání do lokální konfigurace...";
            }

            try {
                const res = await sendJson("/api/settings", payload);
                const data = await res.json();

                if (res.ok) {
                    if (statusEl) {
                        statusEl.className = "text-xs text-emerald-400 font-semibold";
                        statusEl.textContent = t("settings.savedSuccess", "✅ Nastavení bylo úspěšně uloženo!");
                    }
                    if (geminiInput && geminiInput.value) geminiInput.value = "";
                    if (openaiInput && openaiInput.value) openaiInput.value = "";
                    if (elevenlabsInput && elevenlabsInput.value) elevenlabsInput.value = "";

                    await loadAppSettings(false);

                    setTimeout(() => {
                        closeSettingsModal();
                    }, 1200);
                } else {
                    if (statusEl) {
                        statusEl.className = "text-xs text-red-400 font-semibold";
                        statusEl.textContent = "❌ Chyba: " + (data.detail || "Nelze uložit");
                    }
                }
            } catch (err) {
                if (statusEl) {
                    statusEl.className = "text-xs text-red-400 font-semibold";
                    statusEl.textContent = "❌ Chyba spojení: " + err.message;
                }
            } finally {
                if (btn) {
                    btn.disabled = false;
                    btn.innerHTML = `<span>💾</span> ${t("settings.saveBtn", "Uložit nastavení")}`;
                }
            }
        }

        async function openUserDataFolder() {
            try {
                const res = await fetch("/api/settings/open-data-folder", { method: "POST" });
                const data = await res.json();
                if (!res.ok) {
                    alert("Nepodařilo se otevřít složku: " + (data.detail || "Neznámá chyba"));
                }
            } catch (err) {
                alert("Chyba při otevírání složky: " + err.message);
            }
        }

