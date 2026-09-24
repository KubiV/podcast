#!/usr/bin/env bash
# =========================================================================
# Skript pro sestavení desktopové aplikace AI MedStudio (macOS / Linux)
# =========================================================================
set -e

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." && pwd )"
cd "$DIR"

echo "🩺 Zahajuji sestavení AI MedStudio..."

# Aktivace virtuálního prostředí pokud existuje
if [ -d "venv" ]; then
    echo "📦 Používám virtuální prostředí ./venv"
    source venv/bin/activate
elif [ -d ".venv" ]; then
    echo "📦 Používám virtuální prostředí ./.venv"
    source .venv/bin/activate
fi

# Ověření přítomnosti PyInstaller
if ! command -v pyinstaller &> /dev/null; then
    echo "⚠️ PyInstaller nebyl nalezen. Instaluji potřebné balíčky..."
    pip install pyinstaller pywebview
fi

# Vyčištění předchozích buildů
echo "🧹 Čištění předchozích buildů (dist/, build/)..."
rm -rf dist/ build/

# Spuštění PyInstaller podle spec souboru
echo "🚀 Spouštím PyInstaller build (medstudio.spec)..."
pyinstaller --noconfirm --clean medstudio.spec

echo ""
echo "========================================================================="
echo "✅ Sestavení bylo úspěšně dokončeno!"
if [ "$(uname)" == "Darwin" ]; then
    echo "🎉 Výsledná aplikace: dist/AIMedStudio.app"
    echo "👉 Spustíte kliknutím na aplikaci nebo příkazem:"
    echo "   open dist/AIMedStudio.app"
else
    echo "🎉 Výsledná aplikace: dist/AIMedStudio/AIMedStudio"
    echo "👉 Spustíte příkazem:"
    echo "   ./dist/AIMedStudio/AIMedStudio"
fi
echo "========================================================================="
