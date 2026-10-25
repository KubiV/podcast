"""
Smoke testy frontendu v reálném prohlížeči (Playwright, Chromium) – pojistka pro dělení app.js (krok 3.5).

Opt-in: spouští se jen s `AIMEDSTUDIO_FRONTEND_SMOKE=1` a nainstalovaným Playwrightem
(`pip install -r requirements-dev.txt` a `python -m playwright install chromium`). Stránka potřebuje
internet kvůli knihovnám z CDN; server běží lokálně s dočasnými daty a bez API klíčů.

Ověřuje: žádné nezachycené chyby JS při načtení, přihlášení a průchodu všemi sekcemi, existenci všech
globálních funkcí volaných z inline handlerů, běh loaderů sekcí a to, že se nespustí žádný podstrčený skript.
"""

import json
import os
import re
import secrets
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATIC = os.path.join(ROOT, "static")
ENABLED = os.environ.get("AIMEDSTUDIO_FRONTEND_SMOKE") == "1"

try:
    from playwright.sync_api import sync_playwright
except ImportError:  # Playwright je jen dev závislost
    sync_playwright = None

# Hlášky prohlížeče, které nejsou chybou aplikace
IGNORED_CONSOLE = (
    "cdn.tailwindcss.com should not be used in production",
    "the server responded with a status of 401",
)
# Známé chyby, které existovaly před krokem 3.5 (zapsané v CHANGELOG). Testovací data obsahují vlákno
# s ID "thread_x');window.__xss=1;//" – lomítka rozbijí URL /api/chat/threads/{id} (404 při automatickém výběru).
KNOWN_ISSUES = (
    "Chyba selectChatThread: Error: Chyba při načítání vlákna",
    "the server responded with a status of 404 (Not Found)",
)
TABS = ("home", "files", "planner", "notes", "cards", "tests", "chat", "podcast", "lesson", "medulingo", "pomodoro")
_HANDLER_CALL = re.compile(r"(?<![\w.$])([A-Za-z_$][\w$]*)\s*\(")
_NOT_GLOBAL_FUNCTIONS = {
    "if",
    "for",
    "while",
    "switch",
    "return",
    "function",
    "typeof",
    "new",
    "catch",
    "await",
    "async",
    "decodeURIComponent",
    "encodeURIComponent",
    "parseInt",
    "parseFloat",
    "String",
    "Number",
    "Boolean",
    "alert",
    "confirm",
    "prompt",
    "setTimeout",
    "clearTimeout",
    "Math",
    "JSON",
    "Date",
    "escapeJsStringAttr",
    "escapeHtml",
}


def handler_function_names() -> list[str]:
    """Jména globálních funkcí volaných z inline handlerů v index.html i v šablonách app.js."""
    sources = []
    js_dir = os.path.join(STATIC, "js")
    paths = [os.path.join(STATIC, "index.html")] + [
        os.path.join(js_dir, f) for f in sorted(os.listdir(js_dir)) if f.endswith(".js")
    ]
    for path in paths:
        with open(path, encoding="utf-8") as f:
            sources.append(f.read())
    names = set()
    for src in sources:
        for attr in re.findall(r'\son[a-z]+="([^"]*)"', src):
            attr = re.sub(r"\$\{[^}]*\}", "", attr)  # interpolace šablon
            attr = re.sub(r"'[^']*'", "''", attr)  # řetězcové argumenty
            names.update(_HANDLER_CALL.findall(attr))
    return sorted(n for n in names if n not in _NOT_GLOBAL_FUNCTIONS)


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@unittest.skipUnless(ENABLED and sync_playwright, "frontend smoke testy jsou opt-in (AIMEDSTUDIO_FRONTEND_SMOKE=1)")
class TestFrontendSmoke(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data_dir = tempfile.mkdtemp(prefix="aimedstudio_smoke_")
        cls.port = _free_port()
        env = {
            **os.environ,
            "AIMEDSTUDIO_DATA_DIR": cls.data_dir,
            "GEMINI_API_KEY": "",
            "OPENAI_API_KEY": "",
            "ELEVENLABS_API_KEY": "",
            "APP_PASSWORD": "",
        }
        cls.server = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "main:app", "--port", str(cls.port)],
            cwd=ROOT,
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        cls.base = f"http://127.0.0.1:{cls.port}"
        for _ in range(60):
            try:
                urllib.request.urlopen(f"{cls.base}/health", timeout=1)
                break
            except OSError:
                time.sleep(0.5)
        subprocess.run(
            [sys.executable, os.path.join(ROOT, "tests", "frontend", "seed_xss_data.py"), str(cls.port), cls.data_dir],
            check=True,
            capture_output=True,
            env={k: v for k, v in env.items() if k != "PYTHONPATH"},
        )
        with open(os.path.join(cls.data_dir, "pw.txt"), encoding="utf-8") as f:
            cls.password = f.read().strip()

        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()
        cls.server.terminate()
        cls.server.wait(timeout=10)

    def setUp(self):
        self.context = self.browser.new_context()
        self.page = self.context.new_page()
        self.errors: list[str] = []
        self.page.on("pageerror", lambda exc: self.errors.append(f"pageerror: {exc}"))
        self.page.on(
            "console",
            lambda msg: self.errors.append(f"console.{msg.type}: {msg.text}")
            if msg.type == "error" and not any(s in msg.text for s in IGNORED_CONSOLE + KNOWN_ISSUES)
            else None,
        )

    def tearDown(self):
        self.context.close()

    def login(self):
        self.page.goto(f"{self.base}/index.html?smoke={secrets.token_hex(4)}")
        status = self.page.evaluate(
            """async (pw) => (await fetch('/api/auth/login', {method: 'POST', headers: {'Content-Type': 'application/json'},
                 body: JSON.stringify({username: 'v16admin', password: pw})})).status""",
            self.password,
        )
        self.assertEqual(status, 200)
        self.errors.clear()  # chyby před přihlášením (401 loadery) nejsou předmětem testu
        self.page.reload()
        self.page.wait_for_load_state("networkidle")

    def test_load_and_libraries(self):
        self.login()
        libs = self.page.evaluate(
            "() => ({tailwind: typeof tailwind, marked: typeof marked, DOMPurify: typeof DOMPurify, katex: typeof katex})"
        )
        self.assertEqual(libs, {"tailwind": "object", "marked": "object", "DOMPurify": "function", "katex": "object"})
        self.assertEqual(self.errors, [])

    def test_inline_handler_functions_exist(self):
        self.login()
        names = handler_function_names()
        self.assertGreater(len(names), 100)
        missing = self.page.evaluate("(names) => names.filter(n => typeof window[n] !== 'function')", names)
        self.assertEqual(missing, [], f"Funkce volané z HTML chybí na window: {missing}")

    def test_all_tabs_and_section_loaders(self):
        self.login()
        for tab in TABS:
            with self.subTest(tab=tab):
                self.page.evaluate("(t) => sidebarSwitchTab(t)", tab)
                self.page.wait_for_timeout(300)
        result = self.page.evaluate(
            """async () => {
                window.__xss = 0;
                currentProject = 'xss_proj';
                const steps = {
                    pm: () => renderPmProjectsTable(), files: () => loadFileList(), notes: () => loadSavedNotesList(),
                    decks: () => loadSavedFlashcardsList(), tests: () => loadSavedTestsList(), explorer: () => loadExplorer(),
                    planner: () => loadProjectQuestionsAndPlanner(), threads: () => loadChatThreads(),
                    medulingo: () => loadMedulingo(), pomodoro: () => initPomodoro(),
                };
                const failed = {};
                for (const [name, fn] of Object.entries(steps)) {
                    try { await fn(); } catch (e) { failed[name] = String(e); }
                }
                await new Promise(r => setTimeout(r, 500));
                return {failed, xss: window.__xss};
            }"""
        )
        self.assertEqual(result, {"failed": {}, "xss": 0})
        self.assertEqual(self.errors, [], "\n".join(self.errors))

    def test_render_markdown_pipeline(self):
        self.login()
        html = self.page.evaluate(
            "() => renderMarkdownWithKaTeX('**tučně** $x^2$ [1, s. 2] <img src=x onerror=window.__xss=1>')"
        )
        self.assertIn("<strong>tučně</strong>", html)
        self.assertIn('class="katex"', html)
        self.assertIn("inline-citation", html)
        # Škodlivé HTML smí zůstat jen jako escapovaný text – žádný element s atributem on*
        handlers = self.page.evaluate(
            """(html) => { const d = document.createElement('div'); d.innerHTML = html;
                return [...d.querySelectorAll('*')].filter(el => !el.classList.contains('inline-citation'))
                    .flatMap(el => [...el.attributes].map(a => a.name)).filter(n => n.startsWith('on')); }""",
            html,
        )
        self.assertEqual(handlers, [])


if __name__ == "__main__":
    unittest.main()
