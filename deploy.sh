#!/bin/bash
# ============================================
# Control Tower - Script de deploiement
# Redemarrage de tous les services
# ============================================
set -e

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_DIR"

echo "=== Control Tower - Deploy ==="
echo ""

# --- 1. Verifier la syntaxe ---
echo "[1/6] Verification syntaxe..."
python3 -c "import ast; ast.parse(open('agent/api.py').read()); ast.parse(open('dashboard/main.py').read()); ast.parse(open('dashboard/proxy.py').read())"
node --check frontend/app.js
echo "  OK"

# --- 2. Sync fichiers vers Pi ---
echo "[2/6] Sync vers Rasta Server (Pi 5)..."
rsync -az --exclude 'venv' --exclude '__pycache__' --exclude '.git' --exclude 'node_modules' \
  --exclude 'machines.json' --exclude 'auth.json' \
  "$PROJECT_DIR/" franck@192.168.1.16:~/perso/Raspberry/
echo "  OK"

# --- 3. Sync fichiers vers Windows ---
echo "[3/6] Sync vers Formule1 Windows..."
cp agent/api.py /mnt/c/Users/franc/pi-dashboard-agent/api.py
cp agent/main.py /mnt/c/Users/franc/pi-dashboard-agent/main.py
echo "  OK"

# --- 4. Redemarrer agents + dashboard locaux (WSL) ---
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
ssh -o ConnectTimeout=5 franck@192.168.1.16 "pkill -f 'uvicorn agent' 2>/dev/null; sleep 1; cd ~/perso/Raspberry && source venv/bin/activate && nohup python3 -m uvicorn agent.main:app --host 0.0.0.0 --port 3001 > /tmp/ct-agent.log 2>&1 & sleep 3 && curl -s http://localhost:3001/health > /dev/null && echo started" || echo "  WARN: SSH failed, Pi may be offline"
echo "  OK"

# --- 6. Redemarrer agent Windows ---
echo "[6/6] Redemarrage agent Formule1 Windows..."
/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -Command \
  "Get-Process python -ErrorAction SilentlyContinue | Stop-Process -Force; Start-Sleep 2; Start-Process python -ArgumentList 'C:\Users\franc\pi-dashboard-agent\run.py' -WindowStyle Hidden" 2>/dev/null
echo "  OK"

# --- Attendre que tout demarre ---
echo ""
echo "Attente du demarrage..."
sleep 5

# --- Verification ---
echo ""
echo "=== Verification ==="
FAIL=0

for name in "Agent WSL:http://localhost:3001/health" "Dashboard:http://localhost:3000/api/machines" "Agent Win:http://172.23.80.1:3002/health" "Agent Pi:http://localhost:3000/api/m/rasta-server/system"; do
  label="${name%%:*}"
  url="${name#*:}"
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
  echo "Dashboard: http://localhost:3000"
else
  echo "=== Deploiement avec erreurs ==="
  echo "Verifier les logs:"
  echo "  WSL Agent: /tmp/ct-agent-wsl.log"
  echo "  Dashboard: /tmp/ct-dashboard.log"
  echo "  Pi Agent:  ssh franck@192.168.1.16 cat /tmp/ct-agent.log"
  echo "  Win Agent: cat /mnt/c/Users/franc/pi-dashboard-agent/agent.log"
fi
