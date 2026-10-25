"""
Vygeneruje `tests/fixtures/services_golden.json` z aktuálního chování kódu.

Spouštět jen záměrně (např. po vědomé změně chování schválené v plánu):
    python -m tests.fixtures.generate_services_golden
"""

import json
import os

import tests  # noqa: F401 – izolace datového adresáře, prázdné klíče, blokace sítě
from tests.fixtures.service_cases import compute_all

GOLDEN_PATH = os.path.join(os.path.dirname(__file__), "services_golden.json")


def main() -> None:
    with open(GOLDEN_PATH, "w", encoding="utf-8") as f:
        json.dump(compute_all(), f, ensure_ascii=False, indent=1, sort_keys=True)
        f.write("\n")
    print(f"Zapsáno: {GOLDEN_PATH}")


if __name__ == "__main__":
    main()
