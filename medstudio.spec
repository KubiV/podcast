# -*- mode: python ; coding: utf-8 -*-
import os
import sys
from PyInstaller.utils.hooks import collect_data_files, collect_submodules

block_cipher = None

# Zahrnutí statických souborů (HTML, JS, CSS)
datas = [
    ('static', 'static'),
]

# Automatický sběr datových souborů (šablony, migrace) pro ChromaDB
datas += collect_data_files('chromadb')

# Skryté importy pro uvicorn, chromadb, google.genai, pywebview a další
hiddenimports = [
    'uvicorn',
    'uvicorn.logging',
    'uvicorn.loops',
    'uvicorn.loops.auto',
    'uvicorn.protocols',
    'uvicorn.protocols.http',
    'uvicorn.protocols.http.auto',
    'uvicorn.protocols.websockets',
    'uvicorn.protocols.websockets.auto',
    'uvicorn.lifespans',
    'uvicorn.lifespans.on',
    'fastapi',
    'starlette',
    'pydantic',
    'pdfplumber',
    'pypdf',
    'docx',
    'pptx',
    'mutagen',
    'mutagen.mp3',
    'ffmpeg',
    'webview',
    'chat_service',
    'lesson_service',
]

hiddenimports += collect_submodules('chromadb')
hiddenimports += collect_submodules('uvicorn')
hiddenimports += collect_submodules('google.genai')

# Specifické knihovny pro platformy
if sys.platform == 'darwin':
    hiddenimports += [
        'webview.platforms.cocoa',
        'objc',
        'WebKit',
        'AppKit',
        'Foundation',
    ]
elif sys.platform == 'win32':
    hiddenimports += [
        'webview.platforms.winforms',
        'webview.platforms.edgechromium',
    ]

a = Analysis(
    ['desktop_app.py'],
    pathex=['.'],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=['tkinter', 'matplotlib', 'pytest', 'unittest'],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='AIMedStudio',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,  # Běží jako samostatná desktopová aplikace bez terminálového okna
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='AIMedStudio',
)

if sys.platform == 'darwin':
    app = BUNDLE(
        coll,
        name='AIMedStudio.app',
        icon=None,
        bundle_identifier='cz.aimedstudio.app',
        info_plist={
            'NSPrincipalClass': 'NSApplication',
            'NSAppleScriptEnabled': False,
            'CFBundleDocumentTypes': [],
            'NSHighResolutionCapable': 'True',
        },
    )
