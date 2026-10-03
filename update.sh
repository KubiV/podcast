#!/usr/bin/env bash
# ==============================================================================
# AI MedStudio – Automatizovaný aktualizační skript
# ==============================================================================
# Použití:
#   ./update.sh               # Zkontroluje aktualizace, stáhne a bezvýpadkově restartuje
#   ./update.sh --force       # Vynutí rebuild i bez nových git commitů
#   ./update.sh --install-cron # Automaticky nastaví noční aktualizace v cronu (každý den ve 3:00)
#   ./update.sh --cron        # Tichý režim vhodný pro spouštění cronem
# ==============================================================================

set -e

# Barvy pro výpis do terminálu
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Zjištění kořenové složky projektu
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IS_CRON=false
FORCE_UPDATE=false

for arg in "$@"; do
    case $arg in
        --cron)
            IS_CRON=true
            ;;
        --force)
            FORCE_UPDATE=true
            ;;
        --install-cron)
            CRON_JOB="0 3 * * * $SCRIPT_DIR/update.sh --cron >> $SCRIPT_DIR/update.log 2>&1"
            (crontab -l 2>/dev/null | grep -v "$SCRIPT_DIR/update.sh" ; echo "$CRON_JOB") | crontab -
            echo -e "${GREEN}✅ Noční automatická aktualizace byla úspěšně nastavena v crontabu (každou noc ve 3:00).${NC}"
            echo -e "Protokol aktualizací se bude ukládat do: ${BLUE}$SCRIPT_DIR/update.log${NC}"
            exit 0
            ;;
        --help|-h)
            echo "Použití: ./update.sh [--force] [--cron] [--install-cron]"
            exit 0
            ;;
    esac
done

log() {
    local timestamp
    timestamp=$(date "+%Y-%m-%d %H:%M:%S")
    if [ "$IS_CRON" = true ]; then
        echo "[$timestamp] $1"
    else
        echo -e "[$timestamp] $1"
    fi
}

log "${BLUE}🔍 Zahajuji kontrolu aktualizací AI MedStudio...${NC}"

# Ověření přítomnosti Gitu
if ! command -v git &> /dev/null; then
    log "${RED}❌ Git není nainstalován.${NC}"
    exit 1
fi

# Ověření přítomnosti Docker Compose
if command -v docker &> /dev/null && docker compose version &> /dev/null; then
    DOCKER_COMPOSE="docker compose"
elif command -v docker-compose &> /dev/null; then
    DOCKER_COMPOSE="docker-compose"
else
    log "${RED}❌ Docker Compose nebyl nalezen. Nainstalujte prosím Docker.${NC}"
    exit 1
fi

# Kontrola aktuální větve
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")

# Získání změn ze vzdáleného repozitáře
git fetch origin "$CURRENT_BRANCH" --quiet

LOCAL_COMMIT=$(git rev-parse HEAD)
REMOTE_COMMIT=$(git rev-parse "origin/$CURRENT_BRANCH")

if [ "$LOCAL_COMMIT" = "$REMOTE_COMMIT" ] && [ "$FORCE_UPDATE" = false ]; then
    log "${GREEN}✨ Aplikace je již na nejnovější verzi ($LOCAL_COMMIT). Žádné aktualizace nejsou potřeba.${NC}"
    exit 0
fi

log "${YELLOW}📦 Nalezena nová verze na GitHubu! Stahuji změny...${NC}"

# Bezpečné stažení nejnovějšího kódu
git pull origin "$CURRENT_BRANCH"

log "${BLUE}🔨 Sestavuji a restartuji Docker kontejner...${NC}"
$DOCKER_COMPOSE up -d --build

log "${BLUE}⏳ Čekám na dokončení startu a ověření zdraví aplikace...${NC}"
PORT=$(grep -oE 'PORT=[0-9]+' docker-compose.yml 2>/dev/null | cut -d= -f2 || echo "8000")

# Čekání na healthcheck
HEALTH_OK=false
for i in {1..30}; do
    if curl -s "http://localhost:${PORT}/health" | grep -q '"status":"ok"'; then
        HEALTH_OK=true
        break
    fi
    sleep 1
done

if [ "$HEALTH_OK" = true ]; then
    log "${GREEN}🎉 Aktualizace proběhla úspěšně! AI MedStudio běží a je plně funkční.${NC}"
else
    log "${YELLOW}⚠️ Kontejner byl restartován, ale kontrola /health neodpověděla do 30s. Zkontrolujte prosím: $DOCKER_COMPOSE logs${NC}"
fi

# Úklid starých nepoužívaných Docker obrazů (klíčové pro šetření místa na SD kartě Raspberry Pi)
log "${BLUE}🧹 Čistím staré dočasné Docker obrazy...${NC}"
docker image prune -f > /dev/null 2>&1 || true

log "${GREEN}✅ Hotovo! Aplikace je připravena k použití na http://localhost:${PORT}${NC}"
