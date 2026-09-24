#!/usr/bin/env python3
"""
AI MedStudio - Desktop Application Launcher
Spouští lokální Uvicorn server v samostatném vlákně a otevírá nativní okno aplikace (pywebview).
Pokud pywebview není k dispozici nebo selže, automaticky otevře výchozí webový prohlížeč.
"""

import os
import sys
import time
import socket
import logging
import argparse
import threading
import webbrowser

# Potlačení zbytečných hlášek uvicornu při startu
logging.getLogger("uvicorn.error").setLevel(logging.WARNING)
logging.getLogger("uvicorn.access").setLevel(logging.WARNING)


def find_available_port(preferred_port: int = 8000, max_attempts: int = 50) -> int:
    """Nalezne volný port pro lokální server počínaje od preferred_port."""
    for port in range(preferred_port, preferred_port + max_attempts):
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                s.bind(("127.0.0.1", port))
                return port
        except OSError:
            continue

    # Záložní automatické přidělení volného portu OS
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def run_desktop_app():
    parser = argparse.ArgumentParser(description="AI MedStudio Desktop")
    parser.add_argument("--browser", action="store_true", help="Otevřít v systémovém webovém prohlížeči místo nativního okna")
    parser.add_argument("--port", type=int, default=8000, help="Preferovaný port (výchozí: 8000)")
    args, _ = parser.parse_known_args()

    port = find_available_port(args.port)
    url = f"http://127.0.0.1:{port}"
    print(f"🩺 AI MedStudio startuje na: {url}")

    # Import až zde, aby se správně uplatnila cesty MEIPASS před načtením modulů
    import uvicorn
    from main import app

    config = uvicorn.Config(
        app,
        host="127.0.0.1",
        port=port,
        log_level="warning",
        access_log=False,
    )
    server = uvicorn.Server(config)

    server_thread = threading.Thread(target=server.run, daemon=True)
    server_thread.start()

    # Čekání na inicializaci serveru v paměti
    for _ in range(60):
        if getattr(server, "started", False):
            break
        time.sleep(0.1)

    # Režim prohlížeče
    if args.browser:
        print(f"Otevírám prohlížeč na: {url}")
        webbrowser.open(url)
        try:
            while not server.should_exit:
                time.sleep(0.5)
        except (KeyboardInterrupt, SystemExit):
            pass
        finally:
            server.should_exit = True
        return

    # Nativní okno pywebview s fallbackem na webový prohlížeč
    try:
        import webview

        window = webview.create_window(
            title="AI MedStudio",
            url=url,
            width=1280,
            height=860,
            min_size=(960, 640),
            text_select=True,
            confirm_close=False,
        )
        print("Spouštím desktopové okno...")
        webview.start()
    except Exception as e:
        print(f"Nativní okno pywebview se nepodařilo otevřít ({e}). Otevírám webový prohlížeč...")
        webbrowser.open(url)
        try:
            while not server.should_exit:
                time.sleep(0.5)
        except (KeyboardInterrupt, SystemExit):
            pass
    finally:
        server.should_exit = True
        print("AI MedStudio ukončeno.")


if __name__ == "__main__":
    run_desktop_app()
