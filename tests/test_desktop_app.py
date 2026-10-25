"""
Desktopové okno (pywebview) si musí pamatovat cookies a localStorage mezi spuštěními.

pywebview spouští okno ve výchozím stavu v anonymním režimu (`private_mode=True`): po zavření zmizela přihlašovací
cookie i volba „úvodní obrazovku nezobrazovat“. Test nahrazuje modul `webview` záznamníkem a spouští launcher
v režimu vzdáleného serveru, takže nevzniká žádné okno ani lokální server.
"""

import tests  # noqa: F401 – musí být první: izolace dat, prázdné API klíče a blokace sítě (tests/__init__.py)

# isort: split

import sys
import types
import unittest
from unittest.mock import patch

import desktop_app


class TestDesktopWindow(unittest.TestCase):
    def test_window_keeps_cookies_and_local_storage(self):
        calls = {}
        fake_webview = types.ModuleType("webview")
        fake_webview.create_window = lambda **kwargs: calls.setdefault("create_window", kwargs)
        fake_webview.start = lambda *args, **kwargs: calls.setdefault("start", kwargs)

        argv = ["desktop_app.py", "--server", "http://127.0.0.1:9"]
        with patch.dict(sys.modules, {"webview": fake_webview}), patch.object(sys, "argv", argv):
            desktop_app.run_desktop_app()

        self.assertEqual(calls["create_window"]["url"], "http://127.0.0.1:9")
        self.assertIs(calls["start"].get("private_mode"), False)


if __name__ == "__main__":
    unittest.main()
