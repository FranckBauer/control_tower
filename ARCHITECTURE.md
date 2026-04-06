# Pi Dashboard - Architecture

## Vue d'ensemble

- Dashboard web multi-machines accessible depuis le reseau local ou via Tailscale.
- Permet de monitorer et gerer plusieurs machines (PC, Raspberry Pi, etc.) depuis une interface unique.
- Architecture agent/dashboard : chaque machine fait tourner un agent leger, un dashboard central agrege tout.

## Architecture

### Schema

```
Machine 1 (Formule1)       Machine 2 (Rasta Server)     Machine 3 (a venir)
[Agent :3001]              [Agent :3001]                [Agent :3001]
      |                          |                           |
      +--------- Reseau ---------+---------------------------+
                     |
            [Dashboard :3000]
            [Frontend + Proxy]
```

### Agent (agent/)

- FastAPI sur le port 3001.
- Tourne sur chaque machine du reseau.
- Expose les endpoints API locaux (systeme, services, fichiers, terminal, etc.).
- Endpoint /health pour le monitoring de disponibilite.

### Dashboard (dashboard/)

- FastAPI sur le port 3000.
- Tourne sur une seule machine (le Pi 5 en production).
- Sert le frontend (HTML/CSS/JS).
- Proxy les requetes vers les agents via /api/m/{machine_id}/...
- Gere la configuration des machines (machines.json).
- Gere le transfert de fichiers entre machines.

### Frontend (frontend/)

- HTML/CSS/JS vanilla, pas de framework.
- Theme sombre avec accents raspberry.
- Selecteur de machine en haut de page.
- Vue "Toutes les machines" pour le monitoring global.
- Sections : Monitoring, Services, Reseau, Fichiers, Terminal, Mises a jour, Logs.

## Endpoints API

### Agent (port 3001)

| Methode | Endpoint | Description |
|---------|----------|-------------|
| GET | /health | Status + hostname + timestamp |
| GET | /api/system | CPU, RAM, disque, temperature, uptime, load |
| GET | /api/network | Interfaces, connexions, IO reseau |
| GET | /api/services | Liste des services systemd et leur status |
| POST | /api/services/{name}/{action} | Start/stop/restart un service |
| GET | /api/logs | Logs journalctl par service |
| POST | /api/terminal | Executer une commande (avec blocage des commandes dangereuses) |
| POST | /api/update/check | apt update |
| POST | /api/update/upgrade | apt upgrade -y |
| GET | /api/files | Lister un repertoire |
| GET | /api/files/content | Lire un fichier |
| POST | /api/files/content | Ecrire un fichier |
| POST | /api/files/upload | Upload un fichier (multipart) |
| GET | /api/files/download | Telecharger un fichier |

### Dashboard (port 3000)

| Methode | Endpoint | Description |
|---------|----------|-------------|
| GET | /api/machines | Liste des machines avec status online/offline |
| POST | /api/machines | Ajouter une machine |
| DELETE | /api/machines/{id} | Supprimer une machine |
| POST | /api/transfer | Transferer un fichier entre machines |
| * | /api/m/{machine_id}/{path} | Proxy vers l'agent de la machine |

## Machines configurees

| ID | Nom | Description | IP |
|-----|------|-------------|-----|
| formule1 | Formule1 | PC Ivry (Windows 11 / WSL) | localhost (dev) / 100.115.135.121 (Tailscale) |
| rasta-server | Rasta Server | Raspberry Pi 5 | 192.168.1.16 (local) / 100.105.88.5 (Tailscale) |
| (a venir) | PC Campagne | PC residence secondaire | A configurer |

## Stack technique

- Backend : Python 3.13, FastAPI, uvicorn, psutil, httpx
- Frontend : HTML5, CSS3 (variables, grid, flexbox, conic-gradient), JavaScript vanilla
- Reseau : Tailscale (VPN mesh) pour l'acces distant, reseau local pour le LAN
- Deploiement : systemd service, venv Python

## Lancement

### Developpement (sur le PC)

```bash
cd ~/perso/Raspberry
source venv/bin/activate

# Agent local (port 3001)
python3 -m uvicorn agent.main:app --host 0.0.0.0 --port 3001 &

# Dashboard (port 3000)
python3 -m uvicorn dashboard.main:app --host 0.0.0.0 --port 3000 &

# Agent sur le Pi (via SSH)
ssh franck@192.168.1.16 "cd ~/pi-dashboard && source venv/bin/activate && nohup python3 -m uvicorn agent.main:app --host 0.0.0.0 --port 3001 > /tmp/agent.log 2>&1 &"
```

### Production (sur le Pi)

```bash
cd ~/pi-dashboard
chmod +x setup.sh
./setup.sh
```

## Points a revoir / ameliorer

- Tailscale dans le WSL : actuellement non installe, les IPs Tailscale ne sont pas utilisables depuis le WSL.
- Le fichier machines.json utilise des IPs en dur, il faudrait gerer les IPs Tailscale ET locales avec fallback.
- Le dashboard devrait idealement tourner sur le Pi 5 en production (pas sur le PC).
- Securite : pas d'authentification pour l'instant, le terminal web et les actions sudo sont ouverts.
- Services : la liste est en dur dans le code, il faudrait la rendre configurable par machine.
- Agent sur Windows natif : psutil fonctionne sur Windows mais systemctl non, il faut gerer les services Windows differemment.
- Setup automatise : script pour deployer l'agent sur une nouvelle machine facilement.
- Persistance : les agents et le dashboard devraient tourner en services systemd.
- HTTPS : pas de TLS pour l'instant.
