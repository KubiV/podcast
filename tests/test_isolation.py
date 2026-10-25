"""
Izolace testů od skutečných dat (incident v kroku 5.1, docs/audit/CHANGELOG.md).

Testy smí běžet jen nad dočasným datovým adresářem z `tests/__init__.py`. Regresní testy spouštějí discovery
v kopii kódu v dočasném adresáři (bez `AIMEDSTUDIO_DATA_DIR`), takže ani selhání pojistky nesáhne na skutečná data:
- `discover tests` (moduly jako top-level) musí běžet izolovaně, protože každý modul importuje `tests` jako první;
- discovery z kořene (`python -m unittest`) importuje `services/test_service.py` dřív než `tests`, proto se testy
  nesmí vůbec načíst.
"""

import tests  # noqa: F401 – musí být první: izolace dat, prázdné API klíče a blokace sítě (tests/__init__.py)

# isort: split

import glob
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CODE = ("core", "services", "routers", "prompts", "tests", "static", "main.py", "desktop_app.py")
PROBE = """
import json, sys, unittest
loader = unittest.TestLoader()
loader.discover({start!r}{top})
cfg = sys.modules.get("core.config")
print(json.dumps({{"data_dir": getattr(cfg, "USER_DATA_DIR", None), "errors": loader.errors}}))
"""


def _is_test_dir(path) -> bool:
    return bool(path) and os.path.basename(path).startswith("aimedstudio_tests_")


class TestDataIsolation(unittest.TestCase):
    def test_suite_uses_temporary_data_dir(self):
        from core import config
        from services.chat import storage

        self.assertTrue(_is_test_dir(config.USER_DATA_DIR), config.USER_DATA_DIR)
        self.assertEqual(storage.USER_DATA_DIR, config.USER_DATA_DIR)
        self.assertNotEqual(os.path.abspath(config.USER_DATA_DIR), ROOT)


class TestDiscoveryModes(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sandbox = tempfile.mkdtemp(prefix="aimedstudio_sandbox_")
        for name in CODE:
            src, dst = os.path.join(ROOT, name), os.path.join(cls.sandbox, name)
            if os.path.isdir(src):
                shutil.copytree(src, dst, ignore=shutil.ignore_patterns("__pycache__"))
            else:
                shutil.copy2(src, dst)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.sandbox, ignore_errors=True)

    def discover(self, start: str, top: str | None = None) -> dict:
        import json

        env = {k: v for k, v in os.environ.items() if k not in ("AIMEDSTUDIO_DATA_DIR", "PYTHONPATH")}
        code = PROBE.format(start=start, top=f", top_level_dir={top!r}" if top else "")
        out = subprocess.run(
            [sys.executable, "-c", code], cwd=self.sandbox, env=env, capture_output=True, text=True, timeout=300
        )
        self.assertEqual(out.returncode, 0, out.stderr[-2000:])
        return json.loads(out.stdout.strip().splitlines()[-1])

    def sandbox_databases(self) -> list[str]:
        return sorted(os.path.basename(p) for p in glob.glob(os.path.join(self.sandbox, "*.db")))

    def test_recommended_command_is_isolated(self):
        result = self.discover("tests", ".")
        self.assertEqual(result["errors"], [])
        self.assertTrue(_is_test_dir(result["data_dir"]), result["data_dir"])
        self.assertNotIn("auth.db", self.sandbox_databases())

    def test_discover_tests_as_top_level_is_isolated(self):
        result = self.discover("tests")
        self.assertEqual(result["errors"], [])
        self.assertTrue(_is_test_dir(result["data_dir"]), result["data_dir"])
        self.assertNotIn("auth.db", self.sandbox_databases())

    def test_discovery_from_repo_root_refuses_to_load_tests(self):
        result = self.discover(".")
        self.assertTrue(result["errors"])
        self.assertTrue(all("nespustí" in e for e in result["errors"] if "tests" in e))
        # Aplikace (main, AuthService) se nenačetla – auth.db v kořeni nevznikla
        self.assertNotIn("auth.db", self.sandbox_databases())


if __name__ == "__main__":
    unittest.main()
