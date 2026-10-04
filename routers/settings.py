import asyncio
import os
import subprocess
import sys
from typing import Any

import httpx
from fastapi import APIRouter, Body, HTTPException, Request
from google import genai
from google.genai import types
from openai import OpenAI

from core.clients import (
    get_elevenlabs_api_key,
    get_gemini_api_key,
    get_openai_api_key,
)
from core.config import IS_FROZEN, USER_DATA_DIR, load_user_config, save_user_config
from core.context import current_user_var
from core.logger import send_log
from core.utils import extract_gemini_error_detail, friendly_api_error
from services.auth_service import AuthService

router = APIRouter()


def mask_key(k: str) -> str:
    if not k:
        return ""
    if len(k) <= 8:
        return "****"
    return k[:4] + "..." + k[-4:]


@router.get("/api/settings")
async def get_settings(request: Request):
    auth_srv = AuthService.get_instance()
    user = getattr(request.state, "user", None) or current_user_var.get()
    is_shared = auth_srv.is_shared_api_keys() if auth_srv else True
    is_admin = bool(user and user.get("role") == "admin")
    is_viewer = bool(user and user.get("role") == "viewer")

    cfg = load_user_config()

    if is_shared:
        # V režimu sdílených klíčů vidí všichni stav globálních klíčů serveru (admin je smí měnit)
        g_key = (cfg.get("gemini_api_key") or os.getenv("GEMINI_API_KEY") or "").strip()
        o_key = (cfg.get("openai_api_key") or os.getenv("OPENAI_API_KEY") or "").strip()
        e_key = (cfg.get("elevenlabs_api_key") or os.getenv("ELEVENLABS_API_KEY") or "").strip()
        can_edit = is_admin
        mode_label = "shared"
    else:
        # V režimu BYOK (per-user)
        if is_viewer:
            g_key, o_key, e_key = "", "", ""
            can_edit = False
            mode_label = "per_user"
        elif user and user.get("id"):
            u_keys = auth_srv.get_user_api_keys(user["id"]) if auth_srv else {}
            g_key = u_keys.get("gemini_api_key") or (cfg.get("gemini_api_key") if is_admin else "") or ""
            o_key = u_keys.get("openai_api_key") or (cfg.get("openai_api_key") if is_admin else "") or ""
            e_key = u_keys.get("elevenlabs_api_key") or (cfg.get("elevenlabs_api_key") if is_admin else "") or ""
            can_edit = True
            mode_label = "per_user"
        else:
            g_key, o_key, e_key = "", "", ""
            can_edit = False
            mode_label = "per_user"

    return {
        "gemini_configured": bool(g_key),
        "gemini_masked": mask_key(g_key),
        "openai_configured": bool(o_key),
        "openai_masked": mask_key(o_key),
        "elevenlabs_configured": bool(e_key),
        "elevenlabs_masked": mask_key(e_key),
        "user_data_dir": USER_DATA_DIR,
        "is_desktop": IS_FROZEN,
        "pomodoro_settings": cfg.get("pomodoro_settings", {}),
        "shared_api_keys": is_shared,
        "can_edit_keys": can_edit,
        "mode": mode_label,
        "is_admin": is_admin,
        "is_viewer": is_viewer,
    }


@router.post("/api/settings")
async def save_settings(request: Request, payload: dict[str, Any] = Body(...)):
    auth_srv = AuthService.get_instance()
    user = getattr(request.state, "user", None) or current_user_var.get()
    is_shared = auth_srv.is_shared_api_keys() if auth_srv else True
    is_admin = bool(user and user.get("role") == "admin")
    is_viewer = bool(user and user.get("role") == "viewer")

    if is_viewer:
        raise HTTPException(
            status_code=403, detail="Režim pozorovatele: Nemáte oprávnění ukládat nastavení ani API klíče."
        )

    cfg = load_user_config()

    # Zpracování Pomodoro preferencí (dostupné pro každého přihlášeného uživatele)
    if "pomodoro_settings" in payload and isinstance(payload["pomodoro_settings"], dict):
        cfg["pomodoro_settings"] = payload["pomodoro_settings"]
        save_user_config(cfg)

    # Ukládání API klíčů
    has_key_payload = any(k in payload for k in ("gemini_api_key", "openai_api_key", "elevenlabs_api_key"))

    if has_key_payload:
        if is_shared:
            if not is_admin:
                raise HTTPException(
                    status_code=403, detail="V režimu centrálních API klíčů může klíče spravovat pouze administrátor."
                )
            if "gemini_api_key" in payload:
                val = str(payload["gemini_api_key"]).strip()
                if "..." not in val:
                    cfg["gemini_api_key"] = val
            if "openai_api_key" in payload:
                val = str(payload["openai_api_key"]).strip()
                if "..." not in val:
                    cfg["openai_api_key"] = val
            if "elevenlabs_api_key" in payload:
                val = str(payload["elevenlabs_api_key"]).strip()
                if "..." not in val:
                    cfg["elevenlabs_api_key"] = val
            save_user_config(cfg)
            await send_log("⚙️ Centrální administrátorské API klíče byly úspěšně uloženy.")
        else:
            # Per-user BYOK režim
            if not user or not user.get("id"):
                raise HTTPException(status_code=401, detail="Pro uložení osobních API klíčů musíte být přihlášeni.")

            user_id = user["id"]
            g_val = None
            if "gemini_api_key" in payload:
                v = str(payload["gemini_api_key"]).strip()
                if "..." not in v:
                    g_val = v
            o_val = None
            if "openai_api_key" in payload:
                v = str(payload["openai_api_key"]).strip()
                if "..." not in v:
                    o_val = v
            e_val = None
            if "elevenlabs_api_key" in payload:
                v = str(payload["elevenlabs_api_key"]).strip()
                if "..." not in v:
                    e_val = v

            if auth_srv:
                auth_srv.save_user_api_keys(
                    user_id=user_id, gemini_api_key=g_val, openai_api_key=o_val, elevenlabs_api_key=e_val
                )

            # Pokud je to admin, uložíme i do server configu pro případný fallback
            if is_admin:
                if g_val is not None:
                    cfg["gemini_api_key"] = g_val
                if o_val is not None:
                    cfg["openai_api_key"] = o_val
                if e_val is not None:
                    cfg["elevenlabs_api_key"] = e_val
                save_user_config(cfg)

            await send_log(f"⚙️ Osobní API klíče uživatele {user.get('username', '')} byly úspěšně uloženy.")

    return {"status": "success", "message": "Nastavení bylo úspěšně uloženo."}


@router.post("/api/settings/test-key")
async def test_api_key(request: Request, payload: dict[str, Any] = Body(...)):
    provider = payload.get("provider", "gemini")
    key = str(payload.get("key") or "").strip()

    if not key or "..." in key:
        user = getattr(request.state, "user", None) or current_user_var.get()
        if provider == "gemini":
            key = get_gemini_api_key(user=user)
        elif provider == "openai":
            key = get_openai_api_key(user=user)
        elif provider == "elevenlabs":
            key = get_elevenlabs_api_key(user=user)

    if not key:
        return {"valid": False, "message": f"Klíč pro {provider.upper()} není zadán."}

    try:
        if provider == "gemini":
            test_client = genai.Client(api_key=key)
            test_model = str(payload.get("model") or "gemini-3.6-flash").strip()
            try:
                await asyncio.to_thread(
                    test_client.models.generate_content,
                    model=test_model,
                    contents="ping",
                    config=types.GenerateContentConfig(max_output_tokens=10),
                )
            except Exception as test_err:
                err_str = str(test_err).lower()
                if ("404" in err_str or "not_found" in err_str) and test_model != "gemini-flash-latest":
                    await asyncio.to_thread(
                        test_client.models.generate_content,
                        model="gemini-flash-latest",
                        contents="ping",
                        config=types.GenerateContentConfig(max_output_tokens=10),
                    )
                    test_model = "gemini-flash-latest"
                else:
                    raise test_err
            return {"valid": True, "message": f"Google Gemini API klíč je platný a připraven k použití ({test_model})!"}

        elif provider == "openai":
            test_client = OpenAI(api_key=key)
            await asyncio.to_thread(test_client.models.list)
            return {"valid": True, "message": "OpenAI API klíč je platný a ověřen!"}

        elif provider == "elevenlabs":
            async with httpx.AsyncClient(timeout=10) as http_client:
                res = await http_client.get(
                    "https://api.elevenlabs.io/v1/user",
                    headers={"xi-api-key": key},
                )
                if res.status_code == 200:
                    data = res.json()
                    char_count = data.get("subscription", {}).get("character_count", 0)
                    char_limit = data.get("subscription", {}).get("character_limit", 0)
                    return {
                        "valid": True,
                        "message": f"ElevenLabs klíč je platný! Využito: {char_count:,} z {char_limit:,} znaků.",
                    }
                else:
                    return {"valid": False, "message": f"ElevenLabs vrátil chybu {res.status_code}: {res.text[:100]}"}

        else:
            return {"valid": False, "message": f"Neznámý poskytovatel: {provider}"}

    except Exception as e:
        print(f"⚠️ Test klíče selhal pro {provider}: {e}")
        if provider == "gemini":
            friendly = friendly_api_error(e, "Gemini")
            detail = extract_gemini_error_detail(e)
            msg = friendly if friendly != str(e) else f"Chyba ověření ({detail})"
            return {"valid": False, "message": msg}
        return {"valid": False, "message": f"Chyba ověření: {str(e)[:150]}"}


@router.post("/api/settings/open-data-folder")
async def open_data_folder():
    os.makedirs(USER_DATA_DIR, exist_ok=True)
    try:
        if sys.platform == "darwin":
            subprocess.Popen(["open", USER_DATA_DIR])
        elif sys.platform == "win32":
            os.startfile(USER_DATA_DIR)
        else:
            subprocess.Popen(["xdg-open", USER_DATA_DIR])
        return {"status": "success", "path": USER_DATA_DIR}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Nelze otevřít složku: {e}")
