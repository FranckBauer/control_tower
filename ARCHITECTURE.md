# Control Tower - Architecture

## Vue d'ensemble

Dashboard d'administration reseau multi-machines. Monitore et gere un PC Windows, son WSL et un Raspberry Pi 5 depuis une interface web unique, accessible en HTTPS sur internet.

---

## Machines

| Machine | OS | Hostname | IP LAN | IP Tailscale | Agent port | Emplacement |
|---------|-----|----------|--------|-------------|------------|-------------|
| Formule1 Windows | Windows 11 | Formule1 | 192.168.1.10 | 100.115.135.121 | 3002 | Ivry |
| Formule1 WSL | Ubuntu WSL2 | Formule1 | 172.23.94.9 (NAT) | — | 3001 | Ivry (dans le PC) |
| Rasta Server | Raspberry Pi OS (Trixie arm64) | rasta-server | 192.168.1.16 | 100.105.88.5 | 3001 | Ivry |
| PC Campagne | ? | ? | ? | ? | 3001 | Campagne (a venir) |

### Particularites reseau

- **WSL** est derriere un NAT (172.23.x.x). La gateway vers Windows est 172.23.80.1 (peut changer au reboot)
- **Tailscale** est installe sur Windows et le Pi, PAS dans WSL
- L'IP WSL se retrouve avec : `ip route | grep default | awk '{print $3}'`

---

## Reseau et connectivite

```
                    Internet
                       |
              [IP publique Orange]
              86.246.253.121 (dynamique)
                       |
               [Livebox Orange]
               192.168.1.1
               Port 80 → Pi
               Port 443 → Pi
                       |
        +--------------+--------------+
        |                             |
  [Formule1 PC]                [Rasta Server Pi 5]
  192.168.1.10                 192.168.1.16
        |                             |
  [WSL2 Ubuntu]                [Nginx reverse proxy]
  172.23.94.9                  HTTPS → Dashboard :3000
  (NAT via 172.23.80.1)


  === Tailscale VPN (mesh, acces distant) ===

  Formule1 Windows  ←→  Rasta Server Pi 5
  100.115.135.121        100.105.88.5
```

---

## Sites deployes

| URL | Service | Machine | Port interne | Auth | Certificat |
|-----|---------|---------|-------------|------|------------|
| https://control.rastapi.fr | Control Tower Dashboard | Rasta Server (Pi) | :3000 | Login (session cookie 7j) | Let's Encrypt, expire 07/07/2026 |
| https://stalag13.rastapi.fr | Stalag13 Mods Guide | Rasta Server (Pi) | fichiers statiques | Public | Let's Encrypt (meme cert) |
| (prevu) https://quiquigagne.rastapi.fr | QuiQuiGagne | A migrer depuis Oracle Cloud | — | — | — |
| (prevu) https://terje.rastapi.fr | Terje Medecine Guide | A deployer sur le Pi | — | — | — |

### Domaine

- **Domaine** : rastapi.fr
- **Registrar** : OVH (compte sr894797-ovh / franck.bauer@gmail.com)
- **Prix** : 7.79/an, renouvellement le 8 avril 2027

### DNS OVH (Zone DNS)

```
control   A   86.246.253.121
stalag13  A   86.246.253.121
```

---

## Infrastructure sur le Pi (Rasta Server)

### Nginx

Reverse proxy HTTPS sur le Pi. Configs dans `/etc/nginx/sites-available/` :

- **control.rastapi.fr** : proxy vers `http://127.0.0.1:3000` (dashboard FastAPI)
- **stalag13.rastapi.fr** : fichiers statiques depuis `/home/franck/perso/dayz/stalag13-mods-guide/`

### HTTPS / Let's Encrypt

- Certificat unique pour `control.rastapi.fr` + `stalag13.rastapi.fr`
- Renouvellement automatique via certbot
- Expiration : 7 juillet 2026

### Services systemd

| Service | Port | Commande |
|---------|------|----------|
| `control-tower-agent.service` | :3001 | uvicorn agent.main:app |
| `control-tower-dashboard.service` | :3000 | uvicorn dashboard.main:app |

Dossier : `/home/franck/perso/infra/control_tower/`
Setup : `bash setup.sh` (cree les services, installe le venv, demarre tout)

### Port forwarding Livebox

| Port | Protocole | Destination |
|------|-----------|-------------|
| 80 | TCP | rasta-server (192.168.1.16) |
| 443 | TCP | rasta-server (192.168.1.16) |

---

## Infrastructure sur le PC (Formule1)

### Agent Windows (port 3002)

- Dossier : `C:\Users\franc\pi-dashboard-agent\`
- Lancement automatique au login via `start-silent.vbs` dans le dossier Startup

### Agent WSL (port 3001)

- Dossier : `/home/franck/perso/infra/control_tower/`
- Lancement manuel ou via deploy.sh

### Dashboard (dev, port 3000)

- Meme dossier que l'agent WSL
- En prod, le dashboard tourne sur le Pi

### Fichier hosts Windows (contournement NAT loopback)

La Livebox ne supporte pas le NAT loopback. Pour acceder aux sites depuis le LAN :

```
# C:\Windows\System32\drivers\etc\hosts
192.168.1.16  control.rastapi.fr  stalag13.rastapi.fr
```

Script de fix : `C:\Users\franc\fix-hosts.ps1`

---

## machines.json (specifique par machine)

Chaque machine a son propre `machines.json` avec les IPs adaptees a son point de vue reseau.

### Depuis le WSL

```json
formule1-win  → 172.23.80.1:3002   (gateway WSL vers Windows)
formule1-wsl  → localhost:3001     (lui-meme)
rasta-server  → 192.168.1.16:3001  (Pi sur le LAN)
```

### Depuis le Pi

```json
formule1-win  → 192.168.1.10:3002  (PC sur le LAN)
rasta-server  → localhost:3001     (lui-meme)
```

**IMPORTANT** : `deploy.sh` exclut `machines.json` et `auth.json` du rsync pour ne pas ecraser les configs specifiques.

---

## Architecture logicielle

### Schema

```
Machine 1 (Formule1)       Machine 2 (Rasta Server)     Machine 3 (a venir)
[Agent :3001/:3002]        [Agent :3001]                [Agent :3001]
      |                          |                           |
      +--------- Reseau ---------+---------------------------+
                     |
            [Dashboard :3000]
            [Frontend + Proxy]
                     |
               [Nginx :443]
                     |
              [Internet HTTPS]
```

### Agent (`agent/`)

- FastAPI, port 3001 (Linux) ou 3002 (Windows)
- Tourne sur chaque machine
- Expose : systeme, services, fichiers, terminal, reseau, logs, mises a jour
- Endpoint `/health` pour le monitoring

### Dashboard (`dashboard/`)

- FastAPI, port 3000
- Sert le frontend + proxy les requetes vers les agents via `/api/m/{machine_id}/...`
- Auth integree : page login, session cookie 7 jours, fichier `auth.json`
- Collecteur de metriques historiques (sparklines + page History)

### Frontend (`frontend/`)

- HTML/CSS/JS vanilla, theme sombre
- 7 onglets : Monitoring, Services, Reseau, Fichiers, Terminal, Mises a jour, Logs
- Vue "Toutes les machines" avec monitoring global

---

## Deploiement

```bash
bash deploy.sh
```

Le script fait tout en 6 etapes :
1. Verif venv local
2. Rsync vers le Pi (exclut machines.json, auth.json, venv, .git)
3. Rsync vers Windows (agent uniquement)
4. Restart dashboard + agent WSL
5. Restart agent Pi (via SSH)
6. Restart agent Windows (via PowerShell)

---

## Stack technique

- **Backend** : Python 3.13, FastAPI, uvicorn, psutil, httpx
- **Frontend** : HTML5, CSS3 (variables, grid, flexbox), JavaScript vanilla
- **Reverse proxy** : Nginx + Let's Encrypt
- **VPN** : Tailscale (mesh)
- **Deploiement** : systemd (Pi), Startup folder (Windows), deploy.sh (sync)
