#!/bin/bash
# ============================================
# Control Tower - Setup systemd services
# Run on the Pi (or any Linux machine)
# ============================================
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VENV="$SCRIPT_DIR/venv"
USER=$(whoami)

echo "=== Control Tower - Setup ==="
echo "Directory: $SCRIPT_DIR"
echo "User: $USER"
echo ""

# --- 1. Venv + deps ---
echo "[1/5] Python venv and dependencies..."
if [ ! -d "$VENV" ]; then
    python3 -m venv "$VENV"
fi
"$VENV/bin/pip" install -r "$SCRIPT_DIR/requirements.txt" -q
echo "  OK"

# --- 2. Agent service ---
echo "[2/5] Creating agent service..."
sudo tee /etc/systemd/system/control-tower-agent.service > /dev/null << EOF
[Unit]
Description=Control Tower Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$SCRIPT_DIR
ExecStart=$VENV/bin/python -m uvicorn agent.main:app --host 0.0.0.0 --port 3001
Restart=always
RestartSec=5
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=multi-user.target
EOF
echo "  OK"

# --- 3. Dashboard service ---
echo "[3/5] Creating dashboard service..."
sudo tee /etc/systemd/system/control-tower-dashboard.service > /dev/null << EOF
[Unit]
Description=Control Tower Dashboard
After=network-online.target control-tower-agent.service
Wants=network-online.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$SCRIPT_DIR
ExecStart=$VENV/bin/python -m uvicorn dashboard.main:app --host 0.0.0.0 --port 3000
Restart=always
RestartSec=5
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=multi-user.target
EOF
echo "  OK"

# --- 4. Enable and start ---
echo "[4/5] Enabling and starting services..."
sudo systemctl daemon-reload
sudo systemctl enable control-tower-agent.service
sudo systemctl enable control-tower-dashboard.service
sudo systemctl restart control-tower-agent.service
sudo systemctl restart control-tower-dashboard.service
echo "  OK"

# --- 5. Verify ---
echo "[5/5] Verifying..."
sleep 3

AGENT_STATUS=$(systemctl is-active control-tower-agent.service)
DASHBOARD_STATUS=$(systemctl is-active control-tower-dashboard.service)

echo "  Agent:     $AGENT_STATUS"
echo "  Dashboard: $DASHBOARD_STATUS"

echo ""
if [ "$AGENT_STATUS" = "active" ] && [ "$DASHBOARD_STATUS" = "active" ]; then
    IP=$(hostname -I | awk '{print $1}')
    echo "=== Setup complete ==="
    echo "Dashboard:  http://$IP:3000"
    echo "Agent:      http://$IP:3001"
    echo ""
    echo "Services will start automatically on boot."
    echo ""
    echo "Useful commands:"
    echo "  sudo systemctl status control-tower-agent"
    echo "  sudo systemctl status control-tower-dashboard"
    echo "  sudo journalctl -u control-tower-agent -f"
    echo "  sudo journalctl -u control-tower-dashboard -f"
else
    echo "=== Setup had issues ==="
    echo "Check logs with:"
    echo "  sudo journalctl -u control-tower-agent -n 20"
    echo "  sudo journalctl -u control-tower-dashboard -n 20"
fi
