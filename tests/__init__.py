"""Automated test suite for AI MedStudio."""

import os
import socket
import tempfile

# Testy musí běžet nad izolovaným datovým adresářem: import `main` vytváří SQLite databáze,
# složky a spouští migrace. Proměnnou nastavujeme dřív, než kterýkoli testovací modul importuje `core.config`.
os.environ["AIMEDSTUDIO_DATA_DIR"] = tempfile.mkdtemp(prefix="aimedstudio_tests_")

# Testy nesmí volat placená AI API. Prázdné hodnoty zabrání `load_dotenv()` načíst skutečné klíče z `.env`
# (python-dotenv nepřepisuje proměnné, které už v prostředí existují).
for _key in ("GEMINI_API_KEY", "OPENAI_API_KEY", "ELEVENLABS_API_KEY", "APP_PASSWORD"):
    os.environ[_key] = ""

# Pojistka: testy nesmí sahat na síť (AI API, stahování modelů). Povolené jsou jen lokální spojení.
_LOCAL_HOSTS = {"127.0.0.1", "::1", "localhost", None, ""}
_real_connect = socket.socket.connect
_real_connect_ex = socket.socket.connect_ex
_real_getaddrinfo = socket.getaddrinfo


class NetworkAccessInTests(RuntimeError):
    pass


def _check_address(sock: socket.socket, address) -> None:
    host = address[0] if isinstance(address, tuple) else None
    if sock.family != getattr(socket, "AF_UNIX", None) and host not in _LOCAL_HOSTS:
        raise NetworkAccessInTests(f"Testy nesmí přistupovat na síť (spojení s {address!r}).")


def _guarded_connect(self, address):
    _check_address(self, address)
    return _real_connect(self, address)


def _guarded_connect_ex(self, address):
    _check_address(self, address)
    return _real_connect_ex(self, address)


def _guarded_getaddrinfo(host, *args, **kwargs):
    if host not in _LOCAL_HOSTS:
        raise NetworkAccessInTests(f"Testy nesmí přistupovat na síť (DNS dotaz na {host!r}).")
    return _real_getaddrinfo(host, *args, **kwargs)


socket.socket.connect = _guarded_connect
socket.socket.connect_ex = _guarded_connect_ex
socket.getaddrinfo = _guarded_getaddrinfo
