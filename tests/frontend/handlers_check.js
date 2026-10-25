/*
 * Kontrola inline handlerů a escapování v seznamech (krok 1.6 auditu).
 *
 * 1. Spustit server s prázdným AIMEDSTUDIO_DATA_DIR a bez API klíčů.
 * 2. python tests/frontend/seed_xss_data.py PORT DATA_DIR  (heslo testovacího admina uloží do DATA_DIR/pw.txt)
 * 3. V konzoli prohlížeče na http://127.0.0.1:PORT/ nastavit window.__PW a vložit tento skript.
 * Výsledek: xss (0 = nic se nespustilo), seznam volání handlerů s předanými argumenty a hashe všech innerHTML.
 * Pro porovnání před/po spustit totéž proti starší verzi app.js a porovnat výstupy.
 */
(async () => {
  const PW = window.__PW;
  await fetch("/api/auth/login", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({username: "v16admin", password: PW})});
  const html = [];
  const desc = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML");
  Object.defineProperty(Element.prototype, "innerHTML", {configurable: true, get() { return desc.get.call(this); }, set(v) { html.push(String(v)); desc.set.call(this, v); }});
  const names = ["switchToProject","openProjectExportModal","promptRenameProject","confirmDeleteProjectByName","togglePlannerQuestionCompleted","openPlannerEditQuestionModal","explainExamQuestion","togglePlannerCalendarDayFilter","setPlannerQuestionGrade","editPlannerQuestionDate","updatePlannerQuestionNote","deletePlannerQuestion","makeQmTitleEditable","updateQuestionInlineField","editQuestionById","openDocumentViewer","deleteFile","openSavedNote","deleteSavedNote","openSavedDeck","deleteSavedDeck","loadSavedTest","deleteSavedTest","selectChatThread","togglePinThread","renameChatThread","deleteChatThread","selectViewerDocument","deleteFileFromViewer","openPodcastPlayer","deleteExplorerFile","playLessonChapter","openMedulingoQuestion","toggleMedTestOption","handleCitationClick","handleDirectCitationClick","selectCardFromTable","removeQuestion","moveQuestionUp","moveQuestionDown","toggleQuestion","selectQuestion"];
  const calls = [];
  for (const n of names) {
    if (typeof window[n] === "function") window[n] = (...a) => { calls.push([n, ...a.filter(x => !(x instanceof Event)).map(x => (x && typeof x === "object") ? "[obj]" : x)]); };
  }
  window.__xss = 0;
  const errors = [];
  const step = async (label, fn) => { try { await fn(); } catch (e) { errors.push(label + ": " + e.message); } };
  currentProject = "xss_proj";
  await step("pm", () => renderPmProjectsTable());
  await step("files", () => loadFileList());
  await step("notes", () => loadSavedNotesList());
  await step("decks", () => loadSavedFlashcardsList());
  await step("tests", () => loadSavedTestsList());
  await step("explorer", () => loadExplorer());
  await step("planner", () => loadProjectQuestionsAndPlanner());
  await step("plannerTable", () => renderPlannerTable());
  await step("calendar", () => renderPlannerCalendarStrip());
  await step("qm", () => renderQuestionsManagerTable());
  await step("qtable", () => renderQuestionsTable());
  await step("threads", () => loadChatThreads());
  await step("chapters", () => renderLessonChapters([{seconds: 12, time: "00:12", title: "Úvod"}, {seconds: "1);window.__xss=1;(", time: "<b>0</b>", title: "<img src=x onerror=window.__xss=1>"}]));
  await step("chatmsg", () => appendChatMessageToUI({role: "assistant", content: "Odpověď [1, s. 2]", sources: [{id: "1", filename: "kardio.pdf", page: "2"}, {id: '2" x="', filename: "x');window.__xss=1;(.pdf", page: "<b>3</b>"}]}));
  await step("notesResult", () => renderNotesResult("# T\n\nText [1, s. 2]", [{id: "1", filename: "kardio.pdf"}, {id: "<i>2</i>", filename: "<img src=x onerror=window.__xss=1>"}]));
  await step("deck", async () => { currentDeck = {question: "<img src=x onerror=window.__xss=1>", project: "xss_proj", sources: [], cards: [{front: 'a" onmouseover="window.__xss=1', back: "b & <c>", source_ref: "[Zdroj: x');window.__xss=1;(.pdf, s. 1]"}]}; renderDeckTable(); });
  await step("deckOk", async () => { const r = await fetch("/api/flashcards/xss_proj_q1.json"); currentDeck = await r.json(); renderDeckTable(); });
  await new Promise(r => setTimeout(r, 600));
  const recorded = new RegExp("\\b(" + names.join("|") + ")\\(");
  let clicked = 0;
  document.querySelectorAll("[onclick]").forEach(el => {
    if (recorded.test(el.getAttribute("onclick"))) { clicked++; try { el.click(); } catch (e) { errors.push("click: " + e.message); } }
  });
  document.querySelectorAll("[onmouseover]").forEach(el => el.dispatchEvent(new MouseEvent("mouseover")));
  await new Promise(r => setTimeout(r, 400));
  Object.defineProperty(Element.prototype, "innerHTML", desc);
  const hash = async s => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))).slice(0, 6).map(b => b.toString(16).padStart(2, "0")).join("");
  const htmlHashes = await Promise.all(html.map(hash));
  window.__v16 = {html, calls};
  return JSON.stringify({xss: window.__xss, errors, clicked, nHtml: html.length, htmlHashes, calls});
})()
