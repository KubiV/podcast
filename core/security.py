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


# CSP pro HTML stránky aplikace. 'unsafe-inline' ve script-src je zatím nutné kvůli inline handlerům
# v index.html a static/js/*.js (onclick=…); omezuje se tím hlavně původ externích skriptů, pluginy a <base>.
APP_CONTENT_SECURITY_POLICY = "; ".join(
    [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://cdn.jsdelivr.net https://cdnjs.cloudflare.com",
        "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
        "font-src 'self' data: https://cdn.jsdelivr.net",
        "img-src 'self' data: blob: https:",
        "media-src 'self' blob:",
        "connect-src 'self'",
        "frame-src 'self' blob:",
        "worker-src 'self' blob:",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'self'",
    ]
)
