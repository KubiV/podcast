"""Ukládání testů do adresáře generated_tests (TestStorageManager) a sanitizace názvu projektu."""

import json
import os
import re
import time
import uuid
from datetime import datetime
from typing import Any

from core.security import safe_join


# Pomocná funkce pro sanitizaci jména
def sanitize_name(name: str) -> str:
    cleaned = re.sub(r"[^\w\-_.]", "_", name.strip())
    return re.sub(r"_+", "_", cleaned)


class TestStorageManager:
    """Správce ukládání a načítání testů v adresáři generated_tests."""

    def __init__(self, tests_dir: str):
        self.tests_dir = tests_dir
        os.makedirs(self.tests_dir, exist_ok=True)

    def _file_path(self, filename: str) -> str:
        return safe_join(self.tests_dir, filename)

    def save_test(self, test_data: dict[str, Any]) -> str:
        project = test_data.get("project", "default")
        safe_proj = sanitize_name(project)
        test_id = test_data.get("id") or f"test_{int(time.time())}_{uuid.uuid4().hex[:6]}"
        test_data["id"] = test_id

        # Pokud už má soubor přiřazené jméno, zachováme ho pro kontinuitu vlákna
        filename = test_data.get("filename") or f"{safe_proj}_{test_id}.json"
        test_data["filename"] = filename
        if "created_at" not in test_data:
            test_data["created_at"] = datetime.now().isoformat()
        test_data["updated_at"] = datetime.now().isoformat()

        path = self._file_path(filename)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(test_data, f, ensure_ascii=False, indent=2)
        return filename

    def update_test(self, test_data_or_filename: Any, test_data: dict[str, Any] | None = None) -> str:
        """Aktualizuje existující vlákno testu se zachováním jeho souboru a historie."""
        if test_data is not None:
            test_data["filename"] = str(test_data_or_filename)
            return self.save_test(test_data)
        elif isinstance(test_data_or_filename, dict):
            return self.save_test(test_data_or_filename)
        else:
            raise ValueError("Neplatné argumenty pro update_test.")

    def get_test(self, filename_or_id: str) -> dict[str, Any] | None:
        # Přímý název souboru
        if not filename_or_id.endswith(".json"):
            # Pokus o vyhledání podle id
            for f in os.listdir(self.tests_dir):
                if f.endswith(".json") and filename_or_id in f:
                    filename_or_id = f
                    break
            else:
                filename_or_id = f"{filename_or_id}.json"

        path = self._file_path(filename_or_id)
        if not os.path.exists(path):
            return None

        try:
            with open(path, encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return None

    def list_tests(self, project: str = "") -> list[dict[str, Any]]:
        if not os.path.exists(self.tests_dir):
            return []

        safe_proj = sanitize_name(project) if project else ""
        results = []

        files = [f for f in os.listdir(self.tests_dir) if f.endswith(".json")]
        if safe_proj:
            files = [f for f in files if f.startswith(f"{safe_proj}_")]

        files.sort(key=lambda x: os.path.getmtime(self._file_path(x)), reverse=True)

        for f in files:
            path = self._file_path(f)
            try:
                with open(path, encoding="utf-8") as fl:
                    data = json.load(fl)
                    results.append(
                        {
                            "filename": f,
                            "id": data.get("id", f.replace(".json", "")),
                            "title": data.get("title", f),
                            "project": data.get("project", safe_proj),
                            "created_at": data.get("created_at", ""),
                            "updated_at": data.get("updated_at", data.get("created_at", "")),
                            "difficulty": data.get("difficulty", "normal"),
                            "count": len(data.get("questions", [])),
                            "rounds": data.get("rounds", 1),
                            "mode": data.get("mode", "instant"),
                            "question_types": data.get("question_types", []),
                            "categories": data.get("categories", []),
                            "topics": data.get("topics", []),
                            "result": data.get("result", None),
                            "mtime": os.path.getmtime(path),
                        }
                    )
            except Exception:
                continue

        return results

    def save_test_result(self, filename: str, result_payload: dict[str, Any]) -> dict[str, Any] | None:
        test_data = self.get_test(filename)
        if not test_data:
            return None

        test_data["result"] = result_payload
        test_data["updated_at"] = datetime.now().isoformat()
        path = self._file_path(test_data["filename"])
        with open(path, "w", encoding="utf-8") as f:
            json.dump(test_data, f, ensure_ascii=False, indent=2)
        return test_data

    def delete_test(self, filename: str) -> bool:
        path = self._file_path(filename)
        if os.path.exists(path):
            os.remove(path)
            return True
        return False
