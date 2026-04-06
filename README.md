# Control Tower

Dashboard d'administration reseau multi-machines. Monitore et gere des machines Windows, Linux et Raspberry Pi depuis une interface web unique.

## Architecture

```
Machine 1              Machine 2              Machine 3
[Agent :3001]          [Agent :3001]          [Agent :3002]
      |                      |                      |
      +-------- Reseau ------+----------------------+
                     |
            [Dashboard :3000]
            [Frontend + Proxy]
```

- **Agent** : FastAPI leger, tourne sur chaque machine (Linux/Windows), expose les API systeme
- **Dashboard** : FastAPI + proxy, sert le frontend et relaie les requetes vers les agents
- **Frontend** : HTML/CSS/JS vanilla, theme sombre, interface d'administration complete

## Fonctionnalites

| Section | Description |
|---------|-------------|
| Monitoring | CPU, RAM, disque, temperature, uptime, load average |
| Services | Start/stop/restart de services systemd (Linux) ou Windows |
| Network | Interfaces, IPs, trafic reseau, connexions |
| Files | Navigateur de fichiers multi-drives, editeur, transfert entre machines |
| Terminal | Terminal web avec CWD persistant, historique de commandes |
| Updates | apt update/upgrade (Linux) ou winget (Windows) |
| Logs | Consultation des logs par service (journalctl / Event Log) |

## Machines configurees

| Machine | OS | IP | Port |
|---------|----|----|------|
| Formule1 Windows | Windows 11 | 172.23.80.1 | 3002 |
| Formule1 WSL | Ubuntu WSL2 | localhost | 3001 |
| Rasta Server | Raspberry Pi OS | 192.168.1.16 | 3001 |

## Installation

### Pre-requis
- Python 3.11+
- pip

### Agent (sur chaque machine)
```bash
cd agent/
python3 -m venv venv
source venv/bin/activate  # ou venv\Scripts\activate sur Windows
pip install -r ../requirements.txt
python -m uvicorn main:app --host 0.0.0.0 --port 3001
```

### Dashboard (sur la machine centrale)
```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python -m uvicorn dashboard.main:app --host 0.0.0.0 --port 3000
```

### Deploiement systemd (Linux)
```bash
chmod +x setup.sh
./setup.sh
```

## Configuration

Les machines sont configurees dans `machines.json`. Elles peuvent aussi etre ajoutees/supprimees depuis l'interface web (icone engrenage).

## Stack technique

- Backend : Python 3, FastAPI, uvicorn, psutil, httpx
- Frontend : HTML5, CSS3, JavaScript vanilla
- Reseau : Tailscale (VPN mesh) ou LAN
