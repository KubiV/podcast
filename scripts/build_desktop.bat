@echo off
REM =========================================================================
REM Skript pro sestaveni desktopove aplikace AI MedStudio (Windows)
REM =========================================================================

echo 🩺 Zahajuji sestaveni AI MedStudio pro Windows...

REM Aktivace virtualniho prostredi pokud existuje
if exist "venv\Scripts\activate.bat" (
    echo 📦 Pouzivam virtualni prostredi .\venv
    call venv\Scripts\activate.bat
) else if exist ".venv\Scripts\activate.bat" (
    echo 📦 Pouzivam virtualni prostredi .\.venv
    call .venv\Scripts\activate.bat
)

REM Overeni PyInstaller
where pyinstaller >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo ⚠️ PyInstaller nebyl nalezen. Instaluji...
    pip install pyinstaller pywebview
)

REM Cisteni starych buildu
echo 🧹 Cisteni dist\ a build\...
if exist dist rmdir /s /q dist
if exist build rmdir /s /q build

REM Spusteni sestaveni
echo 🚀 Spoustim PyInstaller...
pyinstaller --noconfirm --clean medstudio.spec

echo.
echo =========================================================================
echo ✅ Sestaveni bylo uspesne dokonceno!
echo 🎉 Vysledna aplikace: dist\AIMedStudio\AIMedStudio.exe
echo =========================================================================
pause
