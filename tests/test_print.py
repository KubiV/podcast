"""
Tiskový náhled /api/print/prepare → /print_preview/{id} (krok 1.5).

Charakterizace: běžný obsah (markdown, tabulky, citace, KaTeX) projde se stejnou strukturou.
Bezpečnost: škodlivé HTML se ze stránky odstraní, viewer smí tisknout, server neotevírá prohlížeč
pro vzdálené klienty a úlohy mají limity.
"""

import html
import re
import unittest
from html.parser import HTMLParser
from unittest.mock import patch

from fastapi.testclient import TestClient

from main import app
from tests.test_project_authz import ProjectAuthzBase

BENIGN_HTML = """<h1>Srdeční selhání</h1>
<h2>Definice</h2>
<p>Srdeční selhání je <strong>klinický syndrom</strong> <span class="inline-citation" title="Kliknutím otevřít zdroj #1, s. 12"><sup>[1, s. 12]</sup></span> &amp; <em>ESC</em>.</p>
<ul><li>NYHA I–IV</li><li>Ejekční frakce &lt; 40 %<ul><li>HFrEF</li></ul></li></ul>
<ol start="2"><li>Echokardiografie</li></ol>
<table><thead><tr><th align="left">Parametr</th><th>Hodnota</th></tr></thead>
<tbody><tr><td>NT-proBNP</td><td colspan="1">&gt; 125 pg/ml</td></tr></tbody></table>
<blockquote><p>Viz <a href="https://www.escardio.org">odkaz</a> a <a href="#kapitola">kotva</a>.</p></blockquote>
<pre><code class="language-js">function x() { return a &lt; b; }</code></pre>
<p><img src="https://example.org/schema.png" alt="schéma"> <input type="checkbox" disabled="" checked=""> hotovo</p>
<hr><p>Řádek<br>druhý</p>
<p><span class="katex"><span class="katex-mathml"><math xmlns="http://www.w3.org/1998/Math/MathML"><semantics><mrow><mi>C</mi><mo>=</mo><mfrac><mi>a</mi><mi>b</mi></mfrac></mrow><annotation encoding="application/x-tex">C = \\frac{a}{b}</annotation></semantics></math></span><span class="katex-html" aria-hidden="true"><span class="base"><span class="strut" style="height:1.04em;vertical-align:-0.35em;"></span><span class="mord mathnormal" style="margin-right:0.07em;">C</span></span><svg xmlns="http://www.w3.org/2000/svg" width="400em" height="1.08em" viewBox="0 0 400000 1080" preserveAspectRatio="xMinYMin slice"><path d="M95,702 c-2.7,0,-7.17,-2.7,-13.5,-8z"></path></svg></span></span></p>
<details open=""><summary>Více</summary><p>Skryté</p></details>"""

MALICIOUS = {
    "script": "<p>a</p><script>window.__xss=1</script>",
    "img_onerror": '<img src=x onerror="window.__xss=1">',
    "js_href": '<a href="javascript:window.__xss=1">x</a>',
    "js_href_obfuscated": '<a href=" jav&#x09;ascript:window.__xss=1">x</a>',
    "data_html_href": '<a href="data:text/html,<script>window.__xss=1</script>">x</a>',
    "iframe": '<iframe src="https://evil.example"></iframe>',
    "svg_onload": '<svg onload="window.__xss=1"><circle r="1"></circle></svg>',
    "style_tag": "<style>body{background:url(https://evil.example/t)}</style>",
    "style_attr_url": '<span style="background:url(https://evil.example/t)">x</span>',
    "object_embed": '<object data="evil.swf"></object><embed src="evil.swf">',
    "form": '<form action="https://evil.example"><input name="pw"><button>Ok</button></form>',
    "meta_refresh": '<meta http-equiv="refresh" content="0;url=https://evil.example">',
    "base_tag": '<base href="https://evil.example/">',
    "break_out": "</article></div><script>window.__xss=1</script><article>",
    "mxss": "<math><mtext><table><mglyph><style><img src=x onerror=window.__xss=1></style></mglyph></table></mtext></math>",
    "comment": "<!--<script>window.__xss=1</script>-->x",
    "citation_onclick": '<span class="inline-citation" onclick="alert(1)" title="t"><sup>[1]</sup></span>',
}

DANGEROUS_PATTERNS = [
    r"<script",
    r"\son[a-z]+\s*=",
    r"javascript:",
    r"<iframe",
    r"<object",
    r"<embed",
    r"<form",
    r"<meta",
    r"<base",
    r"<style",
    r"url\(",
    r"data:text/html",
    r"<!--",
]


class _Normalizer(HTMLParser):
    """Normalizovaná podoba HTML pro porovnání struktury (nezávislá na uvozovkách a entitách)."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.tokens = []

    def handle_starttag(self, tag, attrs):
        self.tokens.append(("start", tag, tuple(sorted((k, v or "") for k, v in attrs))))

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)

    def handle_endtag(self, tag):
        self.tokens.append(("end", tag))

    def handle_data(self, data):
        text = " ".join(data.split())
        if text:
            self.tokens.append(("text", text))


def normalize(markup: str) -> list:
    parser = _Normalizer()
    parser.feed(markup)
    parser.close()
    # Prázdné elementy (void) mohou být v HTML uzavřené i neuzavřené; koncové tagy void elementů ignorujeme
    void = {"br", "hr", "img", "input", "col", "wbr"}
    return [t for t in parser.tokens if not (t[0] == "end" and t[1] in void)]


def article_body(page: str) -> str:
    start = page.index('<article class="markdown-content">') + len('<article class="markdown-content">')
    end = page.rindex("</article>")
    return page[start:end]


class TestPrintPreview(ProjectAuthzBase):
    def prepare_and_view(self, client: TestClient, markup: str, **extra):
        res = client.post("/api/print/prepare", json={"title": "Test <b>", "html": markup, "project": "p", **extra})
        self.assertEqual(res.status_code, 200, res.text)
        doc_id = res.json()["doc_id"]
        page = client.get(f"/print_preview/{doc_id}")
        self.assertEqual(page.status_code, 200)
        return page

    # --- Charakterizace ---
    def test_benign_content_structure_preserved(self):
        page = self.prepare_and_view(self.client_as("alice"), BENIGN_HTML)
        self.assertEqual(normalize(article_body(page.text)), normalize(BENIGN_HTML))
        self.assertIn(html.escape("Test <b>"), page.text)

    def test_viewer_can_print(self):
        page = self.prepare_and_view(self.client_as("viewer"), "<p>Ahoj</p>")
        self.assertIn("<p>Ahoj</p>", page.text)

    def test_unknown_print_job_404(self):
        self.assertEqual(self.client_as("alice").get("/print_preview/neexistuje").status_code, 404)

    # --- Sanitizace ---
    def test_malicious_markup_removed(self):
        client = self.client_as("alice")
        for name, markup in MALICIOUS.items():
            with self.subTest(sample=name):
                body = article_body(self.prepare_and_view(client, markup).text)
                for pattern in DANGEROUS_PATTERNS:
                    self.assertIsNone(re.search(pattern, body, re.IGNORECASE), f"{pattern!r} v: {body!r}")

    def test_citation_keeps_markup_without_handler(self):
        body = article_body(self.prepare_and_view(self.client_as("alice"), MALICIOUS["citation_onclick"]).text)
        self.assertEqual(body.strip(), '<span class="inline-citation" title="t"><sup>[1]</sup></span>')

    def test_preview_has_restrictive_csp(self):
        csp = self.prepare_and_view(self.client_as("alice"), "<p>x</p>").headers.get("content-security-policy", "")
        self.assertIn("default-src 'none'", csp)
        self.assertIn("script-src", csp)
        self.assertNotIn("'unsafe-inline'", csp.split("script-src", 1)[1].split(";", 1)[0])

    # --- Otevírání prohlížeče a limity ---
    def test_browser_not_opened_for_remote_client(self):
        with patch("routers.print.webbrowser.open") as opener:
            self.prepare_and_view(self.client_as("alice"), "<p>x</p>", auto_open_browser=True)
            opener.assert_not_called()

    def test_browser_opened_for_local_desktop_client(self):
        token, _ = __import__("main").auth_service.create_session(self.ids["alice"])
        client = TestClient(app, client=("127.0.0.1", 50000))
        client.cookies.set("medstudio_session", token)
        with patch("routers.print.webbrowser.open") as opener:
            self.prepare_and_view(client, "<p>x</p>", auto_open_browser=True)
            opener.assert_called_once()

    def test_oversized_print_job_rejected(self):
        res = self.client_as("alice").post("/api/print/prepare", json={"html": "x" * (10 * 1024 * 1024 + 1)})
        self.assertEqual(res.status_code, 413)

    def test_print_jobs_are_capped(self):
        from routers import print as print_router

        client = self.client_as("alice")
        for _ in range(print_router.MAX_PRINT_JOBS + 5):
            client.post("/api/print/prepare", json={"html": "<p>x</p>"})
        self.assertLessEqual(len(print_router._print_jobs), print_router.MAX_PRINT_JOBS)


class TestHtmlSanitizer(unittest.TestCase):
    def test_edge_cases(self):
        from core.html_sanitizer import sanitize_html

        cases = {
            "<form><meta><p>x</p></form><p>po</p>": "<p>po</p>",
            "<b>neuzavřené": "<b>neuzavřené</b>",
            "</div><p>a</p></article>": "<p>a</p>",
            "a < b & c": "a &lt; b &amp; c",
            '<img src="data:image/png;base64,iVBORw0KGgo=">': '<img src="data:image/png;base64,iVBORw0KGgo=">',
            '<img src="data:image/svg+xml;base64,PHN2Zz4=">': "<img>",
            '<a href="mailto:a@b.cz">m</a>': '<a href="mailto:a@b.cz">m</a>',
            '<p id="print" name="x">t</p>': "<p>t</p>",
            '<input type="text" value="x"><input type="checkbox" checked>': '<input type="checkbox" checked>',
            "<script><p>uvnitř</p></script><p>po</p>": "<p>po</p>",
            '<svg viewBox="0 0 1 1"><path d="M0,0"/></svg>': '<svg viewBox="0 0 1 1"><path d="M0,0"></path></svg>',
            "<section><p>x</p></section>": "<p>x</p>",
            "": "",
        }
        for markup, expected in cases.items():
            with self.subTest(markup=markup):
                self.assertEqual(sanitize_html(markup), expected)


if __name__ == "__main__":
    unittest.main()
