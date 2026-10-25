"""
Autorizace přístupu k projektům a jejich výstupům (ochrana proti IDOR).

Pravidla navazují na původní kontrolu v mazání/přejmenování projektu (routers/projects.py):
- sdílené projekty (shared_projects=1), role admin nebo chybějící uživatel / AuthService → přístup povolen,
- pozorovatel (viewer, host) smí číst všechny projekty, stejně jako je vidí ve výpisu; zápis mu blokuje middleware,
- ostatní uživatelé smí pracovat jen s projekty, které vlastní; projekt bez záznamu vlastníka je přístupný.

Výstupy (poznámky, kartičky, testy, audio) leží v plochých složkách s prefixem `{projekt}_`,
proto se jejich projekt určuje podle nejdelšího odpovídajícího názvu existujícího projektu.
"""

import os
from collections.abc import Iterable
from typing import Any

from fastapi import HTTPException

from core.config import UPLOAD_DIR
from core.context import current_user_var
from core.utils import sanitize_name
from services.auth_service import AuthService

FORBIDDEN_DETAIL = "Nemáte oprávnění pracovat s cizím privátním projektem."


def _restricted_user(user: dict[str, Any] | None = None) -> dict[str, Any] | None:
    """Vrátí uživatele, na kterého se vztahuje omezení vlastnictví; None znamená přístup ke všemu."""
    auth = AuthService.get_instance()
    user = user if user is not None else current_user_var.get()
    if not auth or not user or auth.is_shared_projects():
        return None
    if user.get("role") == "admin":
        return None
    return user


def can_access_project(project: str, user: dict[str, Any] | None = None, write: bool = False) -> bool:
    restricted = _restricted_user(user)
    if restricted is None:
        return True
    if restricted.get("role") == "viewer":
        return not write
    owner_id = AuthService.get_instance().get_project_owner(sanitize_name(project))
    return owner_id is None or owner_id == restricted.get("id")


def require_project_access(project: str, *, write: bool = False, user: dict[str, Any] | None = None) -> None:
    if not can_access_project(project, user=user, write=write):
        raise HTTPException(status_code=403, detail=FORBIDDEN_DETAIL)


def _known_projects() -> list[str]:
    try:
        return [d for d in os.listdir(UPLOAD_DIR) if os.path.isdir(os.path.join(UPLOAD_DIR, d))]
    except OSError:
        return []


def project_of_output_file(filename: str, known_projects: list[str] | None = None) -> str | None:
    """Určí projekt výstupního souboru podle prefixu `{projekt}_` (nejdelší shoda)."""
    projects = known_projects if known_projects is not None else _known_projects()
    candidates = [p for p in projects if filename.startswith(f"{p}_")]
    return max(candidates, key=len) if candidates else None


def require_output_file_access(filename: str, *, write: bool = False, user: dict[str, Any] | None = None) -> None:
    if _restricted_user(user) is None:
        return
    project = project_of_output_file(filename)
    if project is not None:
        require_project_access(project, write=write, user=user)


def filter_accessible_output_files(filenames: Iterable[str], user: dict[str, Any] | None = None) -> list[str]:
    restricted = _restricted_user(user)
    if restricted is None:
        return list(filenames)
    known = _known_projects()
    allowed: dict[str, bool] = {}
    result = []
    for f in filenames:
        project = project_of_output_file(f, known)
        if project is None:
            result.append(f)
            continue
        if project not in allowed:
            allowed[project] = can_access_project(project, user=restricted)
        if allowed[project]:
            result.append(f)
    return result


def _projects_for_chat_id(chat_project_id: str) -> list[str]:
    """Chat ukládá ASCII variantu názvu (`sanitize_project_name`), proto ji mapujeme zpět na projekty."""
    from services.chat_service import sanitize_project_name

    matches = [p for p in _known_projects() if sanitize_project_name(p) == chat_project_id]
    return matches or [chat_project_id]


def can_access_chat_project(chat_project_id: str, user: dict[str, Any] | None = None, write: bool = False) -> bool:
    restricted = _restricted_user(user)
    if restricted is None:
        return True
    return all(can_access_project(p, user=restricted, write=write) for p in _projects_for_chat_id(chat_project_id))


def require_thread_access(
    thread_id: str, *, write: bool = False, user: dict[str, Any] | None = None
) -> dict[str, Any] | None:
    """Ověří přístup k projektu chatového vlákna. Vrací vlákno, nebo None, pokud neexistuje."""
    from services.chat_service import get_thread

    thread = get_thread(thread_id)
    if thread and not can_access_chat_project(thread["project_id"], user=user, write=write):
        raise HTTPException(status_code=403, detail=FORBIDDEN_DETAIL)
    return thread
