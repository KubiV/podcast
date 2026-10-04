# syntax=docker/dockerfile:1
FROM python:3.11-slim

# Popis a metadata
LABEL maintainer="AI MedStudio"
LABEL description="AI MedStudio & Podcast - Lékařská studijní platforma a generátor podcastů"

# Zákaz interaktivních dotazů při instalaci balíčků
ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HOST=0.0.0.0 \
    PORT=8000 \
    AIMEDSTUDIO_DATA_DIR=/app/data

# Instalace systémových závislostí:
# - ffmpeg: nezbytný pro skládání a stříhání audio podcastů
# - curl: pro Docker healthcheck
# - build-essential: pro bezproblémovou kompilaci na všech architekturách (x86_64 i ARM64)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    curl \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Nejprve zkopírujeme požadavky pro optimální cachování Docker vrstev
COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt

# Zkopírování zdrojových kódů aplikace
COPY . .

# Vytvoření složky pro perzistentní data (databáze, audio, dokumenty)
RUN mkdir -p /app/data

# Definice perzistentního svazku
VOLUME ["/app/data"]

# Bezpečnost: běh jako non-root uživatel
RUN groupadd -r medstudio && useradd -r -g medstudio -d /app medstudio \
    && chown -R medstudio:medstudio /app /app/data
USER medstudio

# Exponovaný port aplikace
EXPOSE 8000

# Kontrola zdraví kontejneru (Docker healthcheck)
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD curl -f http://localhost:8000/health || exit 1

# Spuštění aplikace přes uvicorn na všech síťových rozhraních (včetně podpory reverse proxy / Cloudflare)
# BEZPEČNOST: V produkci omezit --forwarded-allow-ips na IP reverse proxy (např. 172.17.0.1).
# Výchozí '*' je vhodné pro Cloudflare Tunnel / NPM, kde proxy běží ve stejné Docker síti.
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips=*"]

