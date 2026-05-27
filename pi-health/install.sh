#!/bin/bash
# Installation pi-health sur le Pi rasta-server
# Usage : bash install.sh   (à lancer sur le Pi avec sudo, ou via SSH avec ssh sudo)

set -euo pipefail

INSTALL_DIR=/opt/pi-health
SYSTEMD_DIR=/etc/systemd/system

echo "==> Création des répertoires"
sudo mkdir -p "$INSTALL_DIR" /var/log/pi-health /var/lib/pi-health

echo "==> Copie du script"
sudo cp pi_health.py "$INSTALL_DIR/pi_health.py"
sudo chmod 755 "$INSTALL_DIR/pi_health.py"

echo "==> Copie des units systemd"
sudo cp pi-health.service "$SYSTEMD_DIR/pi-health.service"
sudo cp pi-health.timer "$SYSTEMD_DIR/pi-health.timer"

echo "==> Reload systemd + activation"
sudo systemctl daemon-reload
sudo systemctl enable --now pi-health.timer

echo "==> Test : run unique pour vérifier"
sudo systemctl start pi-health.service
sleep 2
sudo journalctl -u pi-health.service --no-pager -n 20

echo ""
echo "==> Logs disponibles :"
echo "  tail -f /var/log/pi-health/health.log    # log de chaque check"
echo "  tail -f /var/log/pi-health/alerts.log    # alertes uniquement"
echo "  journalctl -u pi-health.service --since today"
echo "  systemctl list-timers pi-health.timer    # voir prochain run"

echo "==> OK installé."
