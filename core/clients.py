import os
from typing import Any, Optional

import chromadb
from fastapi import HTTPException
from google import genai

from core.config import DB_DIR, load_user_config
from core.context import current_user_var
from services.auth_service import AuthService

_chroma_client = None
_ai_client = None


def get_gemini_api_key(user: dict[str, Any] | None = None) -> str:
    auth_srv = AuthService.get_instance()
    cfg = load_user_config()

    # 1. Pokud je zapnuto sdílení API klíčů (nebo auth ještě neběží)
    if not auth_srv or auth_srv.is_shared_api_keys():
        return (cfg.get("gemini_api_key") or os.getenv("GEMINI_API_KEY") or "").strip()

    # 2. Privátní režim klíčů per-user (BYOK)
    target_user = user or current_user_var.get()
    if target_user and target_user.get("id"):
        user_keys = auth_srv.get_user_api_keys(target_user["id"])
        k = (user_keys.get("gemini_api_key") or "").strip()
        if k:
            return k
        # Pokud je to admin a nemá nastaven specifický klíč, použijeme záložní z konfigurace
        if target_user.get("role") == "admin":
            return (cfg.get("gemini_api_key") or os.getenv("GEMINI_API_KEY") or "").strip()

    return ""


def get_openai_api_key(user: dict[str, Any] | None = None) -> str:
    auth_srv = AuthService.get_instance()
    cfg = load_user_config()

    if not auth_srv or auth_srv.is_shared_api_keys():
        return (cfg.get("openai_api_key") or os.getenv("OPENAI_API_KEY") or "").strip()

    target_user = user or current_user_var.get()
    if target_user and target_user.get("id"):
        user_keys = auth_srv.get_user_api_keys(target_user["id"])
        k = (user_keys.get("openai_api_key") or "").strip()
        if k:
            return k
        if target_user.get("role") == "admin":
            return (cfg.get("openai_api_key") or os.getenv("OPENAI_API_KEY") or "").strip()

    return ""


def get_elevenlabs_api_key(user: dict[str, Any] | None = None) -> str:
    auth_srv = AuthService.get_instance()
    cfg = load_user_config()

    if not auth_srv or auth_srv.is_shared_api_keys():
        return (cfg.get("elevenlabs_api_key") or os.getenv("ELEVENLABS_API_KEY") or "").strip()

    target_user = user or current_user_var.get()
    if target_user and target_user.get("id"):
        user_keys = auth_srv.get_user_api_keys(target_user["id"])
        k = (user_keys.get("elevenlabs_api_key") or "").strip()
        if k:
            return k
        if target_user.get("role") == "admin":
            return (cfg.get("elevenlabs_api_key") or os.getenv("ELEVENLABS_API_KEY") or "").strip()

    return ""


def get_gemini_client(user: dict[str, Any] | None = None) -> genai.Client:
    global _ai_client
    current_key = get_gemini_api_key(user=user)
    if not current_key:
        raise HTTPException(
            status_code=400,
            detail="Není nastaven Google Gemini API klíč. Přejděte v horní liště do 'Nastavení ⚙️' a vložte svůj API klíč.",
        )
    cached_key = getattr(_ai_client, "_cached_api_key", None) if _ai_client else None
    if _ai_client is None or cached_key != current_key:
        _ai_client = genai.Client(api_key=current_key)
        setattr(_ai_client, "_cached_api_key", current_key)
    return _ai_client


_openai_client = None


def get_openai_client(user: dict[str, Any] | None = None):
    global _openai_client
    current_key = get_openai_api_key(user=user)
    if not current_key:
        raise HTTPException(
            status_code=400,
            detail="Není nastaven OpenAI API klíč. Přejděte v horní liště do 'Nastavení ⚙️' a zadejte svůj API klíč.",
        )
    from openai import OpenAI

    cached_key = getattr(_openai_client, "_cached_api_key", None) if _openai_client else None
    if _openai_client is None or cached_key != current_key:
        _openai_client = OpenAI(api_key=current_key)
        setattr(_openai_client, "_cached_api_key", current_key)
    return _openai_client


def get_chroma_client() -> chromadb.PersistentClient:
    global _chroma_client
    if _chroma_client is None:
        _chroma_client = chromadb.PersistentClient(path=DB_DIR)
    return _chroma_client
