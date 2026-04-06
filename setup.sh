#!/bin/bash
set -e

echo "=== Pi Dashboard — Installation ==="

# Create venv and install Python deps
echo "[1/4] Création du venv et installation des dépendances Python..."
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# Create systemd service
echo "[2/4] Création du service systemd..."
sudo tee /etc/systemd/system/pi-dashboard.service > /dev/null << 'UNIT'
[Unit]
Description=Pi Dashboard
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=WORKDIR
ExecStart=WORKDIR/venv/bin/python -m uvicorn backend.main:app --host 0.0.0.0 --port 3000
Restart=always
RestartSec=5
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=multi-user.target
UNIT

# Replace WORKDIR with actual path
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
sudo sed -i "s|WORKDIR|$SCRIPT_DIR|g" /etc/systemd/system/pi-dashboard.service

# Enable and start
echo "[3/4] Activation du service..."
sudo systemctl daemon-reload
sudo systemctl enable pi-dashboard.service
sudo systemctl start pi-dashboard.service

echo "[4/4] Terminé !"
echo ""
echo "Dashboard accessible sur : http://$(hostname).local:3000"
echo "Ou sur : http://$(hostname -I | awk '{print $1}'):3000"
