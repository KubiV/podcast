"""
Centralizovaná AI služba pro spolehlivé volání LLM (Gemini, OpenAI)
s retry mechanismem, exponenciálním backoffem, podporou fallback modelů
a robustním zpracováním JSON výstupů.
"""

import asyncio
import json
import re
from collections.abc import Callable
from typing import Any, Optional

from google import genai
from google.genai import types

from core.clients import get_gemini_client
from core.context import current_language_var, get_language_directive
from core.logger import send_log
from core.utils import extract_gemini_error_detail, friendly_api_error, is_retryable_gemini_error


def get_fallback_model(model: str) -> str:
    """
    Vrací vhodný záložní model, pokud je primární model dočasně nedostupný nebo přetížený.
    """
    m = model.lower().strip()
    if "gemini-2.5-pro" in m:
        return "gemini-3.6-flash"
    elif "gemini-3.6-pro" in m:
        return "gemini-3.6-flash"
    elif "gemini-3.6-flash" in m:
        return "gemini-flash-latest"
    elif "gemini-flash-latest" in m:
        return "gemini-3.6-flash"
    return "gemini-3.6-flash"


def clean_and_parse_json(raw_text: str) -> list[dict[str, Any]]:
    """
    Robustně vyčistí výstup modelu od markdown bloků a naparsuje JSON.
    Vrací pole JSON objektů (případně jednoprvkové pole pro samostatný dict).
    """
    cleaned = raw_text.strip()
    if "```" in cleaned:
        cleaned = re.sub(r"^```[a-zA-Z]*\s*", "", cleaned)
        cleaned = re.sub(r"\s*```$", "", cleaned)
        cleaned = cleaned.strip()

    # 1. Přímé načtení
    try:
        data = json.loads(cleaned, strict=False)
        if isinstance(data, list):
            return data
        if isinstance(data, dict):
            return [data]
    except Exception:
        pass

    # 2. Extrakce největšího JSON pole z textu
    match = re.search(r"\[\s*\{.*\}\s*\]", cleaned, re.DOTALL)
    if match:
        try:
            data = json.loads(match.group(0), strict=False)
            if isinstance(data, list):
                return data
        except Exception:
            pass

    # 3. Záchranný regex pro jednotlivé JSON objekty
    objects = []
    for m in re.finditer(r"\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}", cleaned):
        try:
            obj = json.loads(m.group(0), strict=False)
            if isinstance(obj, dict):
                objects.append(obj)
        except Exception:
            continue

    if objects:
        return objects

    raise ValueError(f"Nepodařilo se extrahovat platný JSON z odpovědi modelu: {raw_text[:300]}...")


async def call_gemini_with_retries(
    model: str,
    contents: list[Any],
    system_instruction: str = "",
    temperature: float = 0.7,
    max_output_tokens: int = 8192,
    response_mime_type: str = "",
    response_schema: Any = None,
    client: genai.Client | None = None,
    log_fn: Callable[[str], Any] | None = None,
    enable_fallback: bool = True,
    wait_intervals: list[int] | None = None,
) -> str:
    """
    Spolehlivé volání Gemini API s automatickými retries při přetížení (HTTP 503 / 429),
    progresivním čekáním a volitelným přepnutím na záložní model.
    """
    # Automatické promítnutí zvoleného jazyka
    active_lang = current_language_var.get()
    lang_directive = get_language_directive(active_lang)
    if lang_directive and lang_directive not in system_instruction:
        system_instruction = (system_instruction + lang_directive).strip()

    if wait_intervals is None:
        wait_intervals = [8, 16, 30, 45, 60]

    max_attempts = len(wait_intervals) + 1
    current_model = model
    fallback_used = False
    ai_client = client or get_gemini_client()

    async def log_msg(msg: str):
        if log_fn:
            try:
                res = log_fn(msg)
                if asyncio.iscoroutine(res):
                    await res
            except Exception:
                pass
        else:
            await send_log(msg)

    for attempt in range(max_attempts):
        try:
            config_args: dict[str, Any] = {
                "temperature": temperature,
                "max_output_tokens": max_output_tokens,
            }
            if system_instruction:
                config_args["system_instruction"] = system_instruction
            if response_mime_type:
                config_args["response_mime_type"] = response_mime_type
            if response_schema:
                config_args["response_schema"] = response_schema

            config = types.GenerateContentConfig(**config_args)
            response = await asyncio.to_thread(
                ai_client.models.generate_content,
                model=current_model,
                contents=contents,
                config=config,
            )
            return response.text or ""

        except Exception as e:
            if is_retryable_gemini_error(e):
                err_detail = extract_gemini_error_detail(e)

                # Přepnutí na fallback model od 3. pokusu
                if enable_fallback and attempt >= 2 and not fallback_used:
                    fallback = get_fallback_model(current_model)
                    if fallback and fallback != current_model:
                        fallback_used = True
                        await log_msg(
                            f"⚠️ Model {current_model} je dočasně přetížen ({err_detail}). Přepínám na záložní model {fallback}..."
                        )
                        current_model = fallback
                        await asyncio.sleep(4)
                        continue

                if attempt < max_attempts - 1:
                    wait_time = wait_intervals[attempt]
                    await log_msg(
                        f"⚠️ Gemini API [{err_detail}] (pokus {attempt + 1}/{max_attempts}). Čekám {wait_time} s..."
                    )
                    await asyncio.sleep(wait_time)
                else:
                    raise ValueError(f"{friendly_api_error(e, 'Gemini')} (Detail: {err_detail})") from e
            else:
                raise


async def call_gemini_with_resilience(
    ai_client: Any,
    model: str,
    contents: list[Any],
    config: types.GenerateContentConfig,
    report_fn: Any | None = None,
    step_name: str = "generating",
    step_pct: int = 30,
    wait_intervals: list[int] | None = None,
) -> Any:
    """
    Zpětně kompatibilní wrapper pro generování lekcí v lesson_service.
    Vrací přímo instanci response z ai_client.models.generate_content.
    """
    if wait_intervals is None:
        wait_intervals = [6, 12, 25, 45, 60]

    current_model = model
    fallback_used = False
    max_attempts = len(wait_intervals) + 1

    for attempt in range(max_attempts):
        try:
            resp = await asyncio.to_thread(
                ai_client.models.generate_content,
                model=current_model,
                contents=contents,
                config=config,
            )
            return resp
        except Exception as e:
            if is_retryable_gemini_error(e):
                err_detail = extract_gemini_error_detail(e)
                if attempt >= 2 and not fallback_used:
                    fallback = get_fallback_model(current_model)
                    if fallback and fallback != current_model:
                        fallback_used = True
                        if report_fn:
                            await report_fn(
                                step_name,
                                step_pct,
                                f"⚠️ Model {current_model} je přetížen ({err_detail}). Přepínám na záložní model {fallback}...",
                            )
                        current_model = fallback
                        await asyncio.sleep(4)
                        continue

                if attempt < max_attempts - 1:
                    wait_time = wait_intervals[attempt]
                    if report_fn:
                        await report_fn(
                            step_name,
                            step_pct,
                            f"⚠️ Gemini API je přetížené ({err_detail}). Pokus {attempt + 1}/{max_attempts}, čekám {wait_time} s...",
                        )
                    await asyncio.sleep(wait_time)
                else:
                    raise
            else:
                raise
