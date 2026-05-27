# Pi Health Monitor

Monitoring + alerting + auto-recovery pour le Pi rasta-server.

## Pourquoi

Suite aux incidents du 12/05/2026 et 27/05/2026 où le Pi est devenu injoignable sans aucune alerte (link Ethernet PHY stuck, puis dnsmasq qui ne démarre pas), il fallait un système qui :
1. **Détecte tôt** les anomalies (température, link réseau qui flap, services down)
2. **Alerte** par mail (channel Slack de Franck) avant que ce soit catastrophique
3. **Récupère automatiquement** quand c'est faisable (restart service, ip link cycle)

## Architecture

```
systemd timer (60s)
       │
       ▼
pi_health.py (root)
       │
       ├── Lit métriques (temp, link, services, DNS, charge)
       ├── Log JSON ligne /var/log/pi-health/health.log
       ├── Évalue vs seuils → liste d'anomalies
       ├── Auto-recovery (après 2 checks consécutifs en erreur)
       └── Envoie mail si nouvelle anomalie OU persistante > 30 min
```

## Métriques collectées

| Métrique | Source | Seuil warning | Seuil critical |
|----------|--------|---------------|----------------|
| Température CPU | `/sys/class/thermal/thermal_zone0/temp` | 75°C | 85°C (throttling) |
| Link eth0 | `/sys/class/net/eth0/operstate` + carrier | flap ≥4/min | down |
| Services systemd | `systemctl is-active` sur nginx, dnsmasq, tailscaled | — | non actif |
| DNS local | `dig @127.0.0.1 jellyfin.rastapi.fr` | — | ne résout pas |
| Disque / | `df -h /` | 85% | 95% |
| RAM dispo | `/proc/meminfo` MemAvailable | < 200 MB | — |
| Charge CPU | `/proc/loadavg` (load1) | > 4.0 | — |

## Alertes (mail)

- Destinataire : `aaaaafe63k2shrr2w6wuw3hk2i@yacast.slack.com` (canal Slack Franck)
- SMTP : Yacast `10.10.0.61:25` direct
- Fallback : SSH relay via `fbauer@10.2.10.173` (depuis le VPN OpenVPN Yacast déjà actif sur le Pi)
- Anti-spam : une alerte est ré-envoyée au max toutes les 30 min tant qu'elle persiste
- Notif de résolution envoyée quand l'anomalie disparaît

## Auto-recovery (Phase 2)

Déclenchée après **2 checks consécutifs en erreur** (donc ~2 min de persistance) :
- Service down → `systemctl restart <service>`
- Link eth0 down → `ip link set eth0 down ; sleep 2 ; ip link set eth0 up`

Le mail d'alerte inclut le résultat du recovery (succès/échec).

## Installation

Depuis le Pi :
```bash
cd /tmp && git clone ... # ou scp depuis Formule1
cd control_tower/pi-health
bash install.sh
```

Installe :
- `/opt/pi-health/pi_health.py`
- `/etc/systemd/system/pi-health.{service,timer}`
- Active le timer
- Lance un test immédiat

## Vérification

```bash
# Voir le prochain run
systemctl list-timers pi-health.timer

# Log live
tail -f /var/log/pi-health/health.log

# Alertes uniquement
tail -f /var/log/pi-health/alerts.log

# Logs systemd
journalctl -u pi-health.service --since "1 hour ago"

# Forcer un run
sudo systemctl start pi-health.service

# Tester l'envoi mail (simuler une alerte en désactivant temporairement dnsmasq)
sudo systemctl stop dnsmasq
# Attendre 2-3 cycles, le mail doit arriver
sudo systemctl start dnsmasq
```

## État (persistent)

`/var/lib/pi-health/state.json` : garde les counters d'erreurs consécutives + timestamps des dernières notifs pour anti-spam et résolution.

## Phase 3 (à venir)

Endpoint `/api/pi-health` sur l'agent existant qui expose les dernières métriques en JSON,
consommé par le dashboard control_tower pour un widget visuel.

## Désinstallation

```bash
sudo systemctl disable --now pi-health.timer
sudo rm /etc/systemd/system/pi-health.{service,timer}
sudo rm -rf /opt/pi-health /var/log/pi-health /var/lib/pi-health
sudo systemctl daemon-reload
```
