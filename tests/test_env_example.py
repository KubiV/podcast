"""`.env.example` musí dokumentovat všechny proměnné prostředí, které čte aplikace nebo docker-compose (krok 1.11)."""

import tests  # noqa: F401 – musí být první: izolace dat, prázdné API klíče a blokace sítě (tests/__init__.py)

# isort: split

import os
import re
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CODE_PATHS = ["core", "services", "routers", "main.py", "desktop_app.py"]
IGNORED = {"PATH"}

_PY_PATTERNS = [
    re.compile(r"os\.(?:getenv|environ\.get)\(\s*[\"']([A-Z0-9_]+)[\"']"),
    re.compile(r"os\.environ\[\s*[\"']([A-Z0-9_]+)[\"']\s*\]"),
    re.compile(r"_env_mb\(\s*[\"']([A-Z0-9_]+)[\"']"),
]
_COMPOSE_PATTERN = re.compile(r"\$\{([A-Z0-9_]+)")


def _python_files():
    for rel in CODE_PATHS:
        path = os.path.join(ROOT, rel)
        if os.path.isfile(path):
            yield path
        else:
            for dirpath, _, files in os.walk(path):
                yield from (os.path.join(dirpath, f) for f in files if f.endswith(".py"))


def used_variables() -> set[str]:
    names = set()
    for path in _python_files():
        with open(path, encoding="utf-8") as f:
            src = f.read()
        for pattern in _PY_PATTERNS:
            names.update(pattern.findall(src))
    with open(os.path.join(ROOT, "docker-compose.yml"), encoding="utf-8") as f:
        names.update(_COMPOSE_PATTERN.findall(f.read()))
    return names - IGNORED


def documented_variables() -> set[str]:
    with open(os.path.join(ROOT, ".env.example"), encoding="utf-8") as f:
        return set(re.findall(r"^#?\s*([A-Z0-9_]+)=", f.read(), re.MULTILINE))


class TestEnvExample(unittest.TestCase):
    def test_all_used_variables_documented(self):
        missing = sorted(used_variables() - documented_variables())
        self.assertEqual(missing, [], f"Chybí v .env.example: {missing}")

    def test_scan_finds_known_variables(self):
        # pojistka, že vyhledávání v kódu funguje (včetně víceřádkového volání os.getenv)
        found = used_variables()
        for name in ("GEMINI_API_KEY", "APP_PASSWORD", "AIMEDSTUDIO_ALLOWED_MODELS", "MEDSTUDIO_BIND_ADDRESS"):
            self.assertIn(name, found)


if __name__ == "__main__":
    unittest.main()
