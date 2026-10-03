#!/usr/bin/env bash
# ==============================================================================
# AI MedStudio & Podcast – SSH Nasazení a Aktualizace z Macu na Raspberry Pi
# ==============================================================================
# Použití:
#   ./deploy.sh            # Rychlá aktualizace (rsync změn + docker compose rebuild)
#   ./deploy.sh --git      # Aktualizace přes Git pull na Raspberry Pi
#   ./deploy.sh --setup    # Prvotní inicializace a příprava složek na Pi
#   ./deploy.sh --restart  # Rychlý restart kontejneru na Pi bez rebuildu
#   ./deploy.sh --logs     # Živé sledování logů z Dockeru na Pi
#   ./deploy.sh --status   # Zjištění stavu kontejneru a healthchecku
#   ./deploy.sh --help     # Zobrazí nápovědu
# ==============================================================================

set -e

# Barvy pro přehledný výstup
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Načtení volitelné konfigurace ze souboru .deploy.env (pokud existuje)
if [ -f "$SCRIPT_DIR/.deploy.env" ]; then
    # shellcheck disable=SC1091
    source "$SCRIPT_DIR/.deploy.env"
fi

# Výchozí hodnoty odpovídající vašemu Raspberry Pi serveru
PI_USER="${PI_USER:-pi}"
PI_HOST="${PI_HOST:-malina}"
PI_DIR="${PI_DIR:-/srv/compose/podcast}"
PI_PORT="${PI_PORT:-8000}"
SSH_PORT="${SSH_PORT:-22}"

# Sestavení cílového SSH řetězce
SSH_TARGET="${PI_USER}@${PI_HOST}"
SSH_OPTS="-p ${SSH_PORT} -o ConnectTimeout=8"

log() {
    local timestamp
    timestamp=$(date "+%H:%M:%S")
    echo -e "${CYAN}[$timestamp]${NC} $1"
}

print_header() {
    echo -e "${BOLD}${BLUE}══════════════════════════════════════════════════════════════${NC}"
    echo -e "${BOLD}${BLUE}  🚀 AI MedStudio – SSH Deploy na Raspberry Pi (${SSH_TARGET}) ${NC}"
    echo -e "${BOLD}${BLUE}══════════════════════════════════════════════════════════════${NC}"
}

check_ssh_connection() {
    log "🔌 Testuji SSH spojení s ${BOLD}${SSH_TARGET}${NC}..."
    if ! ssh $SSH_OPTS -q "${SSH_TARGET}" "exit 0" 2>/dev/null; then
        echo -e "${RED}❌ Chyba: Nelze se připojit k ${SSH_TARGET} přes SSH (port ${SSH_PORT}).${NC}"
        echo -e "${YELLOW}Doporučené kroky k ověření:${NC}"
        echo -e " 1. Je Raspberry Pi zapnuté a na stejné síti?"
        echo -e " 2. Zkuste: ${BOLD}ssh ${SSH_TARGET}${NC}"
        echo -e " 3. Pokud máte jinou IP adresu, spusťte deploy s proměnnou:"
        echo -e "    ${BOLD}PI_HOST=192.168.x.x ./deploy.sh${NC}"
        echo -e "    Nebo vytvořte soubor ${BOLD}.deploy.env${NC} (viz vzor v .deploy.env.example)."
        exit 1
    fi
    log "${GREEN}✓ SSH spojení v pořádku.${NC}"
}

get_remote_docker_cmd() {
    # Zjistí, zda se na Pi používá 'docker compose' nebo 'docker-compose'
    ssh $SSH_OPTS "${SSH_TARGET}" "
        if command -v docker &>/dev/null && docker compose version &>/dev/null; then
            echo 'docker compose'
        elif command -v docker-compose &>/dev/null; then
            echo 'docker-compose'
        else
            echo 'NONE'
        fi
    "
}

# Zpracování argumentů
MODE="sync"
while [ $# -gt 0 ]; do
    case "$1" in
        --git|--pull)
            MODE="git"
            shift
            ;;
        --setup)
            MODE="setup"
            shift
            ;;
        --restart)
            MODE="restart"
            shift
            ;;
        --logs|-l)
            MODE="logs"
            shift
            ;;
        --status|-s)
            MODE="status"
            shift
            ;;
        --help|-h)
            print_header
            echo -e "Použití: ${BOLD}./deploy.sh [PŘEPÍNAČ]${NC}\n"
            echo -e "Přepínače:"
            echo -e "  ${BOLD}(bez parametrů)${NC}  Rychlá aktualizace: sesynchronizuje změny z Macu přes rsync"
            echo -e "                     a spustí nový build kontejneru na Raspberry Pi."
            echo -e "  ${BOLD}--git, --pull${NC}    Aktualizace přes Git: na Pi provede 'git pull' a přebuduje kontejner."
            echo -e "  ${BOLD}--setup${NC}          Prvotní příprava složky /srv/compose/podcast a práv na Pi."
            echo -e "  ${BOLD}--restart${NC}        Rychlý restart běžícího kontejneru bez rebuildu."
            echo -e "  ${BOLD}--logs, -l${NC}       Otevře živý stream Docker logů z Raspberry Pi."
            echo -e "  ${BOLD}--status, -s${NC}     Zobrazí stav kontejneru a ověří /health."
            echo -e "  ${BOLD}--help, -h${NC}       Zobrazí tuto nápovědu.\n"
            echo -e "Nastavení cílového serveru:"
            echo -e "  Výchozí cíl je ${BOLD}pi@malina:${PI_DIR}${NC}."
            echo -e "  Změnu lze provést jednorázově: ${BOLD}PI_HOST=192.168.1.50 ./deploy.sh${NC}"
            echo -e "  Nebo trvale v souboru ${BOLD}.deploy.env${NC}."
            exit 0
            ;;
        *)
            echo -e "${RED}Neznámý parametr: $1${NC} (použijte ./deploy.sh --help)"
            exit 1
            ;;
    esac
done

print_header

# Režim: Sledování logů
if [ "$MODE" = "logs" ]; then
    check_ssh_connection
    log "${BLUE}📋 Připojuji se k živým logům kontejneru na ${SSH_TARGET}...${NC}"
    ssh -t $SSH_OPTS "${SSH_TARGET}" "cd ${PI_DIR} 2>/dev/null && docker compose logs -f || docker-compose logs -f"
    exit 0
fi

# Režim: Status
if [ "$MODE" = "status" ]; then
    check_ssh_connection
    log "${BLUE}🔍 Zjišťuji stav kontejneru na ${SSH_TARGET}...${NC}"
    ssh $SSH_OPTS "${SSH_TARGET}" "
        echo -e '\n--- STAV SLUŽEB DOCKER ---'
        if [ -d '${PI_DIR}' ]; then
            cd '${PI_DIR}'
            (docker compose ps 2>/dev/null || docker-compose ps 2>/dev/null || docker ps --filter name=aimedstudio)
        else
            echo 'Adresář ${PI_DIR} zatím neexistuje.'
        fi
        echo -e '\n--- KONTROLA HEALTHCHECK (PORT ${PI_PORT}) ---'
        if curl -s -f 'http://localhost:${PI_PORT}/health' >/dev/null 2>&1; then
            echo '✅ Aplikace odpovídá (status 200 OK):'
            curl -s 'http://localhost:${PI_PORT}/health'
            echo ''
        else
            echo '⚠️ Služba na portu ${PI_PORT} neodpovídá na /health.'
        fi
    "
    exit 0
fi

# Režim: Restart
if [ "$MODE" = "restart" ]; then
    check_ssh_connection
    log "${YELLOW}🔄 Restartuji kontejner na ${SSH_TARGET}...${NC}"
    ssh $SSH_OPTS "${SSH_TARGET}" "cd ${PI_DIR} && (docker compose restart || docker-compose restart)"
    log "${GREEN}✓ Kontejner byl restartován.${NC}"
    exit 0
fi

# Režim: Prvotní setup
if [ "$MODE" = "setup" ]; then
    check_ssh_connection
    log "${BLUE}🛠️ Připravuji cílové prostředí na ${SSH_TARGET}...${NC}"
    ssh $SSH_OPTS "${SSH_TARGET}" "
        echo '1. Vytvářím adresářovou strukturu: ${PI_DIR} a ${PI_DIR}/data...'
        if [ ! -d '${PI_DIR}' ]; then
            sudo mkdir -p '${PI_DIR}'
            sudo chown -R ${PI_USER}:${PI_USER} '${PI_DIR}'
        fi
        mkdir -p '${PI_DIR}/data'
        echo '2. Kontrola Dockeru...'
        if ! command -v docker &>/dev/null; then
            echo '❌ Docker není nainstalován na Raspberry Pi!'
            exit 1
        fi
        echo '✅ Příprava dokončena. Adresář ${PI_DIR} je připraven.'
    "
    log "${GREEN}✓ Vzdálené prostředí je připraveno.${NC}"
    log "${BLUE}Nyní provedu první synchronizaci a spuštění...${NC}"
    MODE="sync"
fi

# Režim: Git pull
if [ "$MODE" = "git" ]; then
    check_ssh_connection
    log "${BLUE}📥 Stahuji nejnovější změny z Git repozitáře na ${SSH_TARGET}...${NC}"
    ssh $SSH_OPTS "${SSH_TARGET}" "
        cd '${PI_DIR}' || { echo 'Chyba: ${PI_DIR} neexistuje.'; exit 1; }
        if [ -d .git ]; then
            git pull
        else
            echo '⚠️ ${PI_DIR} není git repozitář. Použijte standardní ./deploy.sh (rsync)!'
            exit 1
        fi
    "
fi

# Režim: Sync přes rsync (výchozí chování)
if [ "$MODE" = "sync" ]; then
    check_ssh_connection
    
    # Ověření rsync na Macu
    if ! command -v rsync &>/dev/null; then
        echo -e "${RED}❌ Na Macu nebyl nalezen rsync.${NC}"
        exit 1
    fi

    # Zajištění existence cílového adresáře
    ssh $SSH_OPTS "${SSH_TARGET}" "
        if [ ! -d '${PI_DIR}' ]; then
            sudo mkdir -p '${PI_DIR}' 2>/dev/null || mkdir -p '${PI_DIR}'
            sudo chown -R ${PI_USER}:${PI_USER} '${PI_DIR}' 2>/dev/null || true
        fi
    "

    log "${BLUE}📦 Synchronizuji zdrojové kódy z Macu do ${SSH_TARGET}:${PI_DIR}...${NC}"
    
    rsync -avz --progress \
        -e "ssh -p ${SSH_PORT} -o ConnectTimeout=8" \
        --exclude='.git/' \
        --exclude='.gitignore' \
        --exclude='venv/' \
        --exclude='.venv/' \
        --exclude='env/' \
        --exclude='__pycache__/' \
        --exclude='*.pyc' \
        --exclude='*.pyo' \
        --exclude='*.pyd' \
        --exclude='.DS_Store' \
        --exclude='.idea/' \
        --exclude='.vscode/' \
        --exclude='.deploy.env' \
        --exclude='data/' \
        --exclude='uploads/' \
        --exclude='lessons_data/' \
        --exclude='generated_audio/' \
        --exclude='generated_flashcards/' \
        --exclude='generated_notes/' \
        --exclude='generated_tests/' \
        --exclude='chroma_db/' \
        --exclude='*.db*' \
        --exclude='*.sqlite*' \
        --exclude='scratch/' \
        --exclude='build/' \
        --exclude='dist/' \
        --exclude='*.spec' \
        "${SCRIPT_DIR}/" "${SSH_TARGET}:${PI_DIR}/"

    log "${GREEN}✓ Synchronizace souborů dokončena.${NC}"
fi

# Přebudování a spuštění kontejneru na Raspberry Pi
log "${BLUE}🔨 Sestavuji a spouštím Docker kontejner na ${SSH_TARGET}...${NC}"

ssh $SSH_OPTS "${SSH_TARGET}" "
    cd '${PI_DIR}'
    
    # Detekce docker compose příkazu
    if command -v docker &>/dev/null && docker compose version &>/dev/null; then
        DC='docker compose'
    elif command -v docker-compose &>/dev/null; then
        DC='docker-compose'
    else
        echo '❌ Docker Compose nebyl nalezen na Pi!'
        exit 1
    fi

    echo 'Spouštím: '\$DC' up -d --build'
    \$DC up -d --build

    echo 'Čekám na spuštění aplikace a healthcheck...'
    HEALTH_OK=false
    for i in \$(seq 1 20); do
        if curl -s -f 'http://localhost:${PI_PORT}/health' | grep -q '\"status\":\"ok\"'; then
            HEALTH_OK=true
            break
        fi
        sleep 1
    done

    if [ \"\$HEALTH_OK\" = true ]; then
        echo '✅ Aplikace úspěšně běží a hlásí OK!'
    else
        echo '⚠️ Aplikace byla restartována, ale /health ještě neodpověděl. Zkontrolujte logy: ./deploy.sh --logs'
    fi

    echo '🧹 Čištění starých Docker vrstev...'
    docker image prune -f >/dev/null 2>&1 || true
"

echo -e "\n${BOLD}${GREEN}🎉 Nasazení úspěšně dokončeno!${NC}"
echo -e "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e " • Lokální síť:       ${CYAN}http://${PI_HOST}.local:${PI_PORT}${NC}"
echo -e " • Zobrazení logů:    ${BOLD}./deploy.sh --logs${NC}"
echo -e " • Kontrola stavu:    ${BOLD}./deploy.sh --status${NC}"
echo -e " • Cloudflare Tunnel: Zkontrolujte Public Hostname v Cloudflare Zero Trust"
echo -e "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
