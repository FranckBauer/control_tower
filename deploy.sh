#!/bin/bash
# ============================================
# Control Tower - Script de deploiement
# Source de verite : ce repo (Pi). Pas de clone Windows.
# - Pi WSL local + Pi rasta-server : git pull
# - Windows (Formule1 + Beast) : scp des .py vers C:\ProgramData\ControlTowerAgent\
# ============================================
set -e

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_DIR"

WINDOWS_HOSTS=("formule1-win" "beast-win")
WINDOWS_INSTALL="C:/ProgramData/ControlTowerAgent"

echo "=== Control Tower - Deploy ==="
echo ""

# --- 1. Verifier la syntaxe ---
echo "[1/6] Verification syntaxe..."
python3 -c "import ast; ast.parse(open('agent/api.py').read()); ast.parse(open('agent/main.py').read()); ast.parse(open('agent/metrics.py').read()); ast.parse(open('dashboard/main.py').read()); ast.parse(open('dashboard/proxy.py').read())"
node --check frontend/app.js
echo "  OK"

# --- 2. Git pull sur Pi ---
echo "[2/6] Pull sur Rasta Server (Pi 5)..."
ssh rasta-server "cd ~/perso/infra/control_tower && git pull origin main"
echo "  OK"

# --- 3. Push agent vers les Windows (scp + restart) ---
echo "[3/6] Push agent Python vers les Windows..."
for host in "${WINDOWS_HOSTS[@]}"; do
    if ! ssh -o ConnectTimeout=5 -o BatchMode=yes "$host" "echo OK" >/dev/null 2>&1; then
        echo "  [SKIP] $host (SSH indisponible)"
        continue
    fi
    scp -q agent/*.py "$host:$WINDOWS_INSTALL/agent/"
    scp -q requirements.txt "$host:$WINDOWS_INSTALL/requirements.txt"
    # Re-installer les deps si requirements.txt a change (cheap, idempotent)
    ssh "$host" "& '$WINDOWS_INSTALL/venv/Scripts/python.exe' -m pip install -r '$WINDOWS_INSTALL/requirements.txt' --quiet"
    # Redemarrer la tache planifiee SYSTEM
    ssh "$host" "powershell -Command Stop-ScheduledTask -TaskName ControlTowerAgent -ErrorAction SilentlyContinue; Start-ScheduledTask -TaskName ControlTowerAgent"
    echo "  [OK] $host"
done

# --- 4. Redemarrer agent + dashboard locaux (WSL) ---
echo "[4/6] Redemarrage agent WSL + dashboard..."
pkill -f "uvicorn agent.main" 2>/dev/null || true
pkill -f "uvicorn dashboard.main" 2>/dev/null || true
sleep 1

source venv/bin/activate
nohup python3 -m uvicorn agent.main:app --host 0.0.0.0 --port 3001 > /tmp/ct-agent-wsl.log 2>&1 &
nohup python3 -m uvicorn dashboard.main:app --host 0.0.0.0 --port 3000 > /tmp/ct-dashboard.log 2>&1 &
echo "  Agent WSL PID: $(pgrep -f 'uvicorn agent.main' | head -1)"
echo "  Dashboard PID: $(pgrep -f 'uvicorn dashboard.main' | head -1)"

# --- 5. Redemarrer agent Pi ---
echo "[5/6] Redemarrage agent Rasta Server..."
ssh -o ConnectTimeout=5 rasta-server "pkill -f 'uvicorn agent' 2>/dev/null; sleep 1; cd ~/perso/infra/control_tower && source venv/bin/activate && nohup python3 -m uvicorn agent.main:app --host 0.0.0.0 --port 3001 > /tmp/ct-agent.log 2>&1 & sleep 3 && curl -s http://localhost:3001/health > /dev/null && echo started" || echo "  WARN: SSH failed"

# --- 6. Verification ---
echo ""
echo "=== Verification ==="
FAIL=0
CHECKS=("Agent WSL:http://localhost:3001/health" "Dashboard:http://localhost:3000/api/machines")
for host in "${WINDOWS_HOSTS[@]}"; do
    CHECKS+=("Agent $host:http://localhost:3000/api/m/${host%-*}/system")
done
CHECKS+=("Agent Pi:http://localhost:3000/api/m/rasta-server/system")

for entry in "${CHECKS[@]}"; do
    label="${entry%%:*}"
    url="${entry#*:}"
    code=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 3 "$url" 2>/dev/null)
    if [ "$code" = "200" ]; then
        echo "  [OK] $label"
    else
        echo "  [FAIL] $label (HTTP $code)"
        FAIL=1
    fi
done

echo ""
if [ "$FAIL" = "0" ]; then
    echo "=== Deploiement reussi ==="
else
    echo "=== Deploiement avec erreurs ==="
    echo "Logs : /tmp/ct-agent-wsl.log, /tmp/ct-dashboard.log, ssh rasta-server cat /tmp/ct-agent.log"
fi
