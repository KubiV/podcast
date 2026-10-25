"""
Limity a kontroly pro nahrávané soubory a importované archivy (ochrana proti zaplnění disku a zip bombám).

Limity lze změnit proměnnými prostředí (v MB); hodnoty se čtou při startu aplikace.
"""

import os
import zipfile
from typing import BinaryIO

from fastapi import HTTPException

_MB = 1024 * 1024


def _env_mb(name: str, default_mb: int) -> int:
    try:
        return int(os.getenv(name, "") or default_mb) * _MB
    except ValueError:
        return default_mb * _MB


MAX_UPLOAD_FILE_BYTES = _env_mb("AIMEDSTUDIO_MAX_UPLOAD_MB", 200)
MAX_IMPORT_ARCHIVE_BYTES = _env_mb("AIMEDSTUDIO_MAX_IMPORT_MB", 2048)
MAX_IMPORT_UNCOMPRESSED_BYTES = _env_mb("AIMEDSTUDIO_MAX_IMPORT_UNCOMPRESSED_MB", 4096)
MAX_IMPORT_ENTRIES = 20_000
# Podezřelý poměr komprese (zip bomb) se posuzuje jen u větších položek
MAX_COMPRESSION_RATIO = 200
COMPRESSION_RATIO_MIN_BYTES = 10 * _MB

_COPY_CHUNK = _MB


def copy_with_limit(source: BinaryIO, dest_path: str, max_bytes: int, what: str = "Soubor") -> int:
    """Zkopíruje proud do souboru; při překročení limitu soubor smaže a vrátí 413."""
    total = 0
    try:
        with open(dest_path, "wb") as out:
            while chunk := source.read(_COPY_CHUNK):
                total += len(chunk)
                if total > max_bytes:
                    raise HTTPException(
                        status_code=413,
                        detail=f"{what} překračuje povolenou velikost {max_bytes // _MB} MB.",
                    )
                out.write(chunk)
    except HTTPException:
        if os.path.exists(dest_path):
            os.remove(dest_path)
        raise
    return total


def validate_import_archive(zf: zipfile.ZipFile) -> None:
    """Odmítne archiv s příliš mnoha položkami, příliš velkým obsahem nebo podezřelou kompresí."""
    infos = zf.infolist()
    if len(infos) > MAX_IMPORT_ENTRIES:
        raise HTTPException(
            status_code=413, detail=f"Archiv obsahuje příliš mnoho souborů (max. {MAX_IMPORT_ENTRIES})."
        )
    total = sum(info.file_size for info in infos)
    if total > MAX_IMPORT_UNCOMPRESSED_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"Rozbalený obsah archivu překračuje {MAX_IMPORT_UNCOMPRESSED_BYTES // _MB} MB.",
        )
    for info in infos:
        if (
            info.file_size >= COMPRESSION_RATIO_MIN_BYTES
            and info.compress_size > 0
            and info.file_size / info.compress_size > MAX_COMPRESSION_RATIO
        ):
            raise HTTPException(status_code=400, detail="Archiv obsahuje podezřele komprimovaný soubor (zip bomb).")


def is_within(base_dir: str, path: str) -> bool:
    """True, pokud `path` leží uvnitř `base_dir` (porovnání po celých složkách, ne jen prefixem řetězce)."""
    base = os.path.abspath(base_dir)
    return os.path.abspath(path).startswith(base + os.sep)
