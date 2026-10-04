#!/bin/sh
set -e

# Zajistí správná oprávnění pro namountovaný perzistentní svazek /app/data
mkdir -p /app/data
chown -R medstudio:medstudio /app/data 2>/dev/null || chmod -R 777 /app/data 2>/dev/null || true

# Spuštění aplikace pod non-root uživatelem medstudio s korektním předáváním procesních signálů
exec gosu medstudio "$@"
