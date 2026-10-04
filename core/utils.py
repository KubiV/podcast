import re


def sanitize_name(name: str) -> str:
    """Sanitize a name (project, file, etc.) by replacing invalid characters with underscores."""
    if not name:
        return ""
    cleaned = re.sub(r"[^\w\-_.]", "_", name.strip())
    return re.sub(r"_+", "_", cleaned).strip("_")


def chunk_text(text: str, chunk_size: int = 6500, overlap: int = 1000) -> list:
    """Zpětně kompatibilní funkce chunkingu pro čistý text se sémantickým dělením."""
    if not text:
        return []
    chunks = []
    start = 0
    text_len = len(text)
    while start < text_len:
        end = min(start + chunk_size, text_len)
        if end < text_len:
            cut = text.rfind("\n\n", start + overlap, end)
            if cut == -1:
                cut = text.rfind(". ", start + overlap, end)
                if cut != -1:
                    cut += 2
            if cut != -1 and cut > start:
                end = cut
        clean_chunk = text[start:end].strip()
        if clean_chunk:
            chunks.append(clean_chunk)
        if end == text_len:
            break
        start = max(end - overlap, start + 1)
    return chunks


def extract_gemini_error_detail(error: Exception) -> str:
    """Extrahuje stručný a přesný detail o chybě z Gemini API pro diagnostiku."""
    raw = str(error)
    normalized = raw.lower()

    code = ""
    if "403" in raw or "permission_denied" in normalized:
        code = "HTTP 403 (Přístup zamítnut / Projekt nepovolen)"
    elif "404" in raw or "not_found" in normalized:
        code = "HTTP 404 (Model nenalezen nebo již není podporován)"
    elif "429" in raw or "resource_exhausted" in normalized:
        code = "HTTP 429 (Vyčerpán limit požadavků / RPM / TPM)"
    elif "503" in raw or "unavailable" in normalized or "overloaded" in normalized:
        code = "HTTP 503 (Model Googlu je přetížený)"
    elif "504" in raw or "timeout" in normalized:
        code = "HTTP 504 / Timeout"
    elif "500" in raw:
        code = "HTTP 500 (Interní chyba serveru Google)"
    elif "connecterror" in normalized or "nodename nor servname" in normalized or "failed to resolve" in normalized:
        code = "Chyba sítě (Nelze navázat spojení se servery Google)"

    msg_match = re.search(r"['\"]message['\"]:\s*['\"]([^'\"]+)['\"]", raw)
    detail = ""
    if msg_match:
        detail = msg_match.group(1).strip()
    elif "the model is overloaded" in normalized:
        detail = "The model is overloaded. Please try again later."
    elif "quota exceeded" in normalized:
        quota_match = re.search(r"(quota exceeded[^\.\n]+)", raw, re.IGNORECASE)
        if quota_match:
            detail = quota_match.group(1).strip()

    if code and detail:
        return f"{code}: {detail}"
    if code:
        return code
    if detail:
        return detail

    clean_raw = " ".join(raw.split())
    return clean_raw[:120] + "..." if len(clean_raw) > 120 else clean_raw


def is_retryable_gemini_error(error: Exception) -> bool:
    """Zjistí, zda se jedná o dočasnou/řešitelnou chybu Gemini API (přetížení, rate limit, timeout)."""
    normalized = str(error).lower()
    return any(
        marker in normalized
        for marker in (
            "503",
            "unavailable",
            "overloaded",
            "429",
            "resource exhausted",
            "resource_exhausted",
            "quota",
            "timeout",
            "timed out",
            "504",
            "500",
            "internal server error",
            "connecterror",
            "connection reset",
            "remote disconnected",
            "deadline exceeded",
        )
    )


def friendly_api_error(error: Exception, provider: str) -> str:
    """Převede časté chyby vzdálených API na stručnou a použitelnou zprávu."""
    raw_error = str(error)
    normalized_error = raw_error.lower()

    if "denied access" in normalized_error or "permission_denied" in normalized_error or "403" in normalized_error:
        return (
            f"{provider}: přístup byl zamítnut (403 PERMISSION_DENIED). "
            "Google zablokoval přístup pro tento projekt (časté u free tier projektů). "
            "Řešení: Vytvořte nový API klíč v novém projektu na https://aistudio.google.com/app/apikey a uložte jej do .env."
        )
    if "404" in normalized_error or "not_found" in normalized_error:
        return (
            f"{provider}: model nebyl nalezen (404 NOT_FOUND). "
            "Původní model (např. gemini-2.5-flash) již není dostupný pro nové uživatele. "
            "Doporučujeme použít výchozí gemini-3.6-flash nebo gemini-flash-latest."
        )
    if "insufficient_quota" in normalized_error or "billing" in normalized_error:
        return (
            f"{provider}: vyčerpána dostupná kvóta nebo kredit. "
            "Zkontrolujte tarif a fakturaci, potom lze dávku spustit znovu."
        )
    if "invalid_api_key" in normalized_error or "api key" in normalized_error:
        return f"{provider}: neplatný nebo chybějící API klíč. Zkontrolujte soubor .env."
    if "429" in normalized_error or "resource exhausted" in normalized_error:
        return f"{provider}: limit požadavků je dočasně vyčerpán. Zkuste dávku spustit znovu za chvíli."
    if "503" in normalized_error or "unavailable" in normalized_error or "overloaded" in normalized_error:
        return f"{provider}: služba je dočasně nedostupná nebo přetížená. Zkuste to prosím za pár minut."
    if "timeout" in normalized_error or "timed out" in normalized_error:
        return f"{provider}: vypršel časový limit spojení. Zkuste dávku spustit znovu."
    return raw_error


def is_terminal_auth_error(error: Exception) -> bool:
    """Zjistí, zda se jedná o fatální chybu autorizace (403, zablokovaný projekt, neplatný API klíč)."""
    normalized = str(error).lower()
    return any(marker in normalized for marker in ("denied access", "permission_denied", "403", "invalid_api_key"))
