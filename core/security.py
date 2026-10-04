"""
Bezpečnostní funkce pro prevenci Path Traversal útoků a sanitizaci názvů souborů.
"""

import os
import re

from fastapi import HTTPException


def safe_join(base_dir: str, *paths: str) -> str:
    """
    Bezpečně spojí cesty a ověří, že výsledná absolutní cesta leží uvnitř base_dir.
    Zabraňuje útokům typu Path Traversal (např. ../../etc/passwd).
    """
    base = os.path.abspath(base_dir)
    cleaned_paths = []
    for p in paths:
        if not p:
            continue
        clean = str(p).lstrip("/\\")
        cleaned_paths.append(clean)

    target = os.path.abspath(os.path.join(base, *cleaned_paths))
    if target != base and not target.startswith(base + os.sep):
        raise HTTPException(status_code=400, detail="Neplatná cesta k souboru (Path Traversal detekován).")
    return target


def safe_filename(filename: str) -> str:
    """
    Vrátí bezpečný název souboru bez relativních komponent adresářů.
    """
    if not filename:
        return ""
    base = os.path.basename(filename.strip().replace("\\", "/"))
    cleaned = re.sub(r"[^\w\-_.]", "_", base)
    return re.sub(r"_+", "_", cleaned).strip("._")
