"""
Vygeneruje `tests/fixtures/batch_golden.json` z aktuálního chování dávkového zpracování.

Spouštět jen záměrně:
    python -m tests.fixtures.generate_batch_golden
"""

import json
import os

import tests  # noqa: F401 – izolace datového adresáře, prázdné klíče, blokace sítě
from tests.fixtures.batch_cases import run_all

GOLDEN_PATH = os.path.join(os.path.dirname(__file__), "batch_golden.json")


def main() -> None:
    with open(GOLDEN_PATH, "w", encoding="utf-8") as f:
        json.dump(run_all(), f, ensure_ascii=False, indent=1, sort_keys=True)
        f.write("\n")
    print(f"Zapsáno: {GOLDEN_PATH}")


if __name__ == "__main__":
    main()
