"""CSP hlavička aplikace a pinnuté externí zdroje s SRI (krok 1.8)."""

import tests  # noqa: F401 – musí být první: izolace dat, prázdné API klíče a blokace sítě (tests/__init__.py)

# isort: split

import os
import re
import unittest

from fastapi.testclient import TestClient

from core.config import STATIC_DIR, UPLOAD_DIR
from main import app
from tests.test_project_authz import ProjectAuthzBase, _write


def _csp_directives(header: str) -> dict[str, list[str]]:
    result = {}
    for part in header.split(";"):
        tokens = part.split()
        if tokens:
            result[tokens[0]] = tokens[1:]
    return result


class TestContentSecurityPolicy(ProjectAuthzBase):
    def test_index_has_csp(self):
        res = TestClient(app).get("/")
        self.assertEqual(res.status_code, 200)
        csp = _csp_directives(res.headers.get("content-security-policy", ""))
        self.assertEqual(csp.get("default-src"), ["'self'"])
        self.assertEqual(csp.get("object-src"), ["'none'"])
        self.assertEqual(csp.get("base-uri"), ["'self'"])
        self.assertEqual(csp.get("frame-ancestors"), ["'self'"])
        self.assertEqual(csp.get("connect-src"), ["'self'"])
        scripts = csp.get("script-src", [])
        for origin in (
            "'self'",
            "https://cdn.tailwindcss.com",
            "https://cdn.jsdelivr.net",
            "https://cdnjs.cloudflare.com",
        ):
            self.assertIn(origin, scripts)
        self.assertNotIn("'unsafe-eval'", scripts)
        self.assertNotIn("*", scripts)

    def test_print_preview_keeps_its_own_csp(self):
        client = self.client_as("alice")
        doc_id = client.post("/api/print/prepare", json={"html": "<p>x</p>"}).json()["doc_id"]
        csp = client.get(f"/print_preview/{doc_id}").headers.get("content-security-policy", "")
        self.assertIn("default-src 'none'", csp)

    def test_non_html_responses_untouched(self):
        _write(os.path.join(UPLOAD_DIR, "authz_alice_proj", "doc.pdf"), "%PDF-1.4")
        client = self.client_as("alice")
        self.assertNotIn("content-security-policy", client.get("/health").headers)
        self.assertNotIn("content-security-policy", client.get("/uploads/authz_alice_proj/doc.pdf").headers)


# CDN bez CORS hlaviček: prohlížeč u nich SRI ověřit nedokáže (skript by se nenačetl)
NO_CORS_ORIGINS = ("https://cdn.tailwindcss.com/",)


class TestPinnedExternalAssets(unittest.TestCase):
    def test_external_assets_pinned_with_sri(self):
        with open(os.path.join(STATIC_DIR, "index.html"), encoding="utf-8") as f:
            html = f.read()
        tags = re.findall(r"<(?:script|link)\b[^>]*\b(?:src|href)=\"https?://[^\"]+\"[^>]*>", html)
        self.assertGreaterEqual(len(tags), 6)
        for tag in tags:
            if 'rel="stylesheet"' not in tag and "<script" not in tag:
                continue
            with self.subTest(tag=tag[:90]):
                url = re.search(r"(?:src|href)=\"([^\"]+)\"", tag).group(1)
                self.assertRegex(url, r"(@\d+\.\d+\.\d+|/\d+\.\d+\.\d+)", "URL musí obsahovat přesnou verzi")
                if url.startswith(NO_CORS_ORIGINS):
                    continue  # SRI vyžaduje CORS; tento CDN ho nepodporuje (jen pinnutá verze)
                self.assertRegex(tag, r'integrity="sha(256|384|512)-[A-Za-z0-9+/=]+"')
                self.assertIn('crossorigin="anonymous"', tag)


if __name__ == "__main__":
    unittest.main()
