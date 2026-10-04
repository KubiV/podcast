import os
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel

router = APIRouter()

auth_service = None


def init(service):
    global auth_service
    auth_service = service


class SetupRequest(BaseModel):
    username: str
    password: str
    email: str | None = None


class LoginRequest(BaseModel):
    username: str
    password: str
    remember_me: bool = True


class RegisterRequest(BaseModel):
    username: str
    password: str
    email: str | None = None


class RegistrationToggleRequest(BaseModel):
    allow_registration: bool


class GuestToggleRequest(BaseModel):
    allow_guest: bool


class SharedApiKeysToggleRequest(BaseModel):
    shared_api_keys: bool


class SharedProjectsToggleRequest(BaseModel):
    shared_projects: bool


class RoleChangeRequest(BaseModel):
    role: str


def set_auth_cookie(response: Response, token: str, remember_me: bool, request: Request):
    is_https = request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https"
    max_age = 30 * 24 * 3600 if remember_me else 24 * 3600
    response.set_cookie(
        key="medstudio_session", value=token, max_age=max_age, httponly=True, samesite="lax", secure=is_https, path="/"
    )


def clear_auth_cookie(response: Response, request: Request):
    is_https = request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https"
    response.delete_cookie(key="medstudio_session", httponly=True, samesite="lax", secure=is_https, path="/")


def require_admin(request: Request) -> dict:
    user = getattr(request.state, "user", None)
    if not user:
        raise HTTPException(status_code=401, detail="Přístup vyžaduje přihlášení.")
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Tato akce vyžaduje administrátorská oprávnění.")
    return user


@router.get("/health")
def health_check():
    return {"status": "ok", "timestamp": datetime.now().isoformat()}


# --- ENDPOINTY PRO AUTENTIZACI A SPRÁVU ÚČTŮ ---


@router.get("/api/auth/status")
async def get_auth_status(request: Request):
    user = getattr(request.state, "user", None)
    return {
        "authenticated": user is not None and not user.get("is_guest", False),
        "is_guest": bool(user and user.get("is_guest", False)),
        "needs_setup": auth_service.needs_setup(),
        "allow_registration": auth_service.is_registration_allowed(),
        "allow_guest": auth_service.is_guest_allowed(),
        "shared_api_keys": auth_service.is_shared_api_keys(),
        "shared_projects": auth_service.is_shared_projects(),
        "user": user,
    }


@router.post("/api/auth/setup")
async def setup_initial_admin(req: SetupRequest, request: Request, response: Response):
    user, err = auth_service.create_initial_admin(req.username, req.password, req.email)
    if err:
        raise HTTPException(status_code=400, detail=err)

    token, _ = auth_service.create_session(
        user["id"], remember_me=True, user_agent=request.headers.get("user-agent", "")
    )
    set_auth_cookie(response, token, True, request)
    return {"status": "ok", "user": user, "token": token}


@router.post("/api/auth/login")
async def login(req: LoginRequest, request: Request, response: Response):
    user, msg = auth_service.authenticate(req.username, req.password)
    if not user:
        raise HTTPException(status_code=401, detail=msg)

    token, _ = auth_service.create_session(
        user["id"], remember_me=req.remember_me, user_agent=request.headers.get("user-agent", "")
    )
    set_auth_cookie(response, token, req.remember_me, request)
    return {"status": "ok", "user": user, "token": token}


@router.post("/api/auth/register")
async def register(req: RegisterRequest):
    user, err = auth_service.register_user(req.username, req.password, req.email)
    if err:
        raise HTTPException(status_code=400, detail=err)
    return {
        "status": "pending",
        "message": "Vaše žádost o registraci byla úspěšně odeslána. Účet musí před prvním přihlášením schválit administrátor serveru.",
    }


@router.post("/api/auth/logout")
async def logout(request: Request, response: Response):
    token = request.cookies.get("medstudio_session")
    if not token:
        auth_h = request.headers.get("Authorization")
        if auth_h and auth_h.startswith("Bearer "):
            token = auth_h.split(" ", 1)[1].strip()
    if token:
        auth_service.revoke_session(token)
    clear_auth_cookie(response, request)
    return {"status": "ok"}


# --- ADMIN ENDPOINTY PRO SPRÁVU A SCHVALOVÁNÍ ÚČTŮ ---


@router.get("/api/auth/admin/users")
async def admin_get_users(request: Request):
    require_admin(request)
    return {"users": auth_service.list_users(), "summary": auth_service.get_auth_summary()}


@router.get("/api/auth/admin/pending")
async def admin_get_pending(request: Request):
    require_admin(request)
    return {"pending": auth_service.list_pending_requests()}


@router.post("/api/auth/admin/approve/{user_id}")
async def admin_approve_user(user_id: int, request: Request, role: str = "user"):
    require_admin(request)
    success = auth_service.approve_user(user_id, role=role)
    if not success:
        raise HTTPException(status_code=404, detail="Čekající uživatel nebyl nalezen.")
    role_label = "Pozorovatel" if role == "viewer" else ("Uživatel" if role == "user" else role)
    return {"status": "ok", "message": f"Účet byl úspěšně schválen s rolí: {role_label}.", "role": role}


@router.post("/api/auth/admin/change-role/{user_id}")
async def admin_change_role(user_id: int, req: RoleChangeRequest, request: Request):
    admin = require_admin(request)
    success, msg = auth_service.change_user_role(user_id, req.role, admin["id"])
    if not success:
        raise HTTPException(status_code=400, detail=msg)
    return {"status": "ok", "message": msg, "role": req.role}


@router.post("/api/auth/admin/reject/{user_id}")
async def admin_reject_user(user_id: int, request: Request):
    require_admin(request)
    success = auth_service.reject_user(user_id)
    if not success:
        raise HTTPException(status_code=404, detail="Čekající uživatel nebyl nalezen.")
    return {"status": "ok", "message": "Žádost byla zamítnuta."}


@router.post("/api/auth/admin/toggle-status/{user_id}")
async def admin_toggle_status(user_id: int, request: Request):
    admin = require_admin(request)
    result = auth_service.toggle_user_active(user_id, admin["id"])
    if len(result) == 3:
        success, msg, new_status = result
    else:
        success, msg = result
        new_status = None
    if not success:
        raise HTTPException(status_code=400, detail=msg)
    return {"status": "ok", "message": msg, "new_status": new_status}


@router.delete("/api/auth/admin/users/{user_id}")
async def admin_delete_user(user_id: int, request: Request):
    admin = require_admin(request)
    success, msg = auth_service.delete_user(user_id, admin["id"])
    if not success:
        raise HTTPException(status_code=400, detail=msg)
    return {"status": "ok", "message": msg}


@router.post("/api/auth/admin/registration-toggle")
async def admin_toggle_registration(req: RegistrationToggleRequest, request: Request):
    require_admin(request)
    auth_service.set_registration_allowed(req.allow_registration)
    return {"status": "ok", "allow_registration": req.allow_registration}


@router.post("/api/auth/admin/guest-toggle")
async def admin_toggle_guest(req: GuestToggleRequest, request: Request):
    require_admin(request)
    auth_service.set_guest_allowed(req.allow_guest)
    return {"status": "ok", "allow_guest": req.allow_guest}


@router.post("/api/auth/admin/shared-api-keys-toggle")
async def admin_toggle_shared_api_keys(req: SharedApiKeysToggleRequest, request: Request):
    require_admin(request)
    auth_service.set_shared_api_keys(req.shared_api_keys)
    return {"status": "ok", "shared_api_keys": req.shared_api_keys}


@router.post("/api/auth/admin/shared-projects-toggle")
async def admin_toggle_shared_projects(req: SharedProjectsToggleRequest, request: Request):
    require_admin(request)
    auth_service.set_shared_projects(req.shared_projects)
    return {"status": "ok", "shared_projects": req.shared_projects}
