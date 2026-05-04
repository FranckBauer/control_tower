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
| Beast | Windows | beast | — (LAN distant) | 100.105.121.10 | 3002 | Campagne |

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

  Formule1 Windows  ←→  Rasta Server Pi 5  ←→  Beast (Campagne)
  100.115.135.121        100.105.88.5            100.105.121.10
```

---

## Sites deployes

| URL | Service | Machine | Port interne | Auth | Certificat |
|-----|---------|---------|-------------|------|------------|
| https://control.rastapi.fr | Control Tower Dashboard | Rasta Server (Pi) | :3000 (FastAPI) | Login (session cookie 7j) | Let's Encrypt |
| https://stalag13.rastapi.fr | Stalag13 Mods Guide | Rasta Server (Pi) | fichiers statiques | Public | Let's Encrypt |
| https://terje.rastapi.fr | Terje Medecine Guide | Rasta Server (Pi) | fichiers statiques | Public | Let's Encrypt |
| https://quiquigagne.online | QuiQuiGagne | Rasta Server (Pi) | :8000 (gunicorn Flask) | App | Let's Encrypt |
| https://immich.rastapi.fr | Immich (photos) | Pi → Formule1 :2283 | reverse proxy | Tailscale + LAN only | Let's Encrypt |
| https://jellyfin.rastapi.fr | Jellyfin (films/series) | Pi → Formule1 :8096 | reverse proxy | Tailscale + LAN only | Let's Encrypt |
| https://navidrome.rastapi.fr | Navidrome (musique) | Pi → Formule1 :4533 | reverse proxy | Tailscale + LAN only | Let's Encrypt |
| https://download.rastapi.fr | Download Center (Homepage) | Pi → Formule1 :3030 | reverse proxy | Tailscale + LAN only | Let's Encrypt (combine `download-center`) |
| https://jellyseerr.rastapi.fr | Jellyseerr | Pi → Formule1 :5055 | reverse proxy | Tailscale + LAN only | Let's Encrypt (combine `download-center`) |
| https://radarr.rastapi.fr | Radarr | Pi → Formule1 :7878 | reverse proxy | Tailscale + LAN only | Let's Encrypt (combine `download-center`) |
| https://sonarr.rastapi.fr | Sonarr | Pi → Formule1 :8989 | reverse proxy | Tailscale + LAN only | Let's Encrypt (combine `download-center`) |
| https://prowlarr.rastapi.fr | Prowlarr | Pi → Formule1 :9696 | reverse proxy | Tailscale + LAN only | Let's Encrypt (combine `download-center`) |
| https://qbittorrent.rastapi.fr | qBittorrent | Pi → Formule1 :8080 | reverse proxy | Tailscale + LAN only | Let's Encrypt (combine `download-center`) |

### Domaine

- **Domaine** : rastapi.fr
- **Registrar** : OVH (compte sr894797-ovh / franck.bauer@gmail.com)
- **Prix** : 7.79/an, renouvellement le 8 avril 2027

### DNS OVH (Zone DNS)

```
control      A   86.246.253.121
stalag13     A   86.246.253.121
terje        A   86.246.253.121
immich       A   86.246.253.121
jellyfin     A   86.246.253.121
navidrome    A   86.246.253.121
download     A   86.246.253.121
jellyseerr   A   86.246.253.121
radarr       A   86.246.253.121
sonarr       A   86.246.253.121
prowlarr     A   86.246.253.121
qbittorrent  A   86.246.253.121
```

---

## Infrastructure sur le Pi (Rasta Server)

### Nginx

Reverse proxy HTTPS sur le Pi. Configs dans `/etc/nginx/sites-available/` :

- **control.rastapi.fr** : proxy vers `http://127.0.0.1:3000` (dashboard FastAPI)
- **stalag13.rastapi.fr** : fichiers statiques depuis `/home/franck/perso/dayz/stalag13-mods-guide/`
- **terje.rastapi.fr** : fichiers statiques depuis `/home/franck/perso/dayz/terje_medicine_guide/`
- **quiquigagne.online** : proxy vers `http://127.0.0.1:8000` (gunicorn Flask QuiQuiGagne)
- **immich.rastapi.fr** : proxy vers `http://100.115.135.121:2283` (Formule1 via Tailscale, `client_max_body_size 50000M`, websockets, no buffering)
- **jellyfin.rastapi.fr** : proxy vers `http://100.115.135.121:8096` (Formule1 via Tailscale, websockets, no buffering, timeouts 600s)
- **navidrome.rastapi.fr** : proxy vers `http://100.115.135.121:4533` (Formule1 via Tailscale)
- **download.rastapi.fr** : proxy vers `http://100.115.135.121:3030` (Formule1 WSL Docker, Homepage)
- **jellyseerr.rastapi.fr** : proxy vers `http://100.115.135.121:5055` (Formule1 WSL Docker, Jellyseerr)
- **radarr.rastapi.fr** : proxy vers `http://100.115.135.121:7878` (Formule1 WSL Docker, Radarr)
- **sonarr.rastapi.fr** : proxy vers `http://100.115.135.121:8989` (Formule1 WSL Docker, Sonarr)
- **prowlarr.rastapi.fr** : proxy vers `http://100.115.135.121:9696` (Formule1 WSL Docker, Prowlarr)
- **qbittorrent.rastapi.fr** : proxy vers `http://100.115.135.121:8080` (Formule1 WSL Docker, qBittorrent)

> Les 9 vhosts media+download (immich/jellyfin/navidrome + download/jellyseerr/radarr/sonarr/prowlarr/qbittorrent) restreignent l'acces a `100.64.0.0/10` (Tailscale) + `192.168.1.0/24` (LAN Ivry) + `127.0.0.1`. Pas d'exposition internet publique malgre le DNS A public — l'URL HTTPS est juste un confort de nommage. Hors LAN/Tailscale, les requetes recoivent un `403 Forbidden` du nginx.

> **Templates download-center** : les 6 vhosts download/jellyseerr/radarr/sonarr/prowlarr/qbittorrent sont generes depuis le repo `~/perso/download-center/` (templates nginx parametres + script de generation). Source de verite des templates : `/home/franck/perso/download-center/nginx/`.

### HTTPS / Let's Encrypt

- Certificats Let's Encrypt :
  - `control.rastapi.fr` + `stalag13.rastapi.fr` (combine, expire 2026-07-07)
  - `terje.rastapi.fr` (expire 2026-07-07)
  - `quiquigagne.online` + `www.quiquigagne.online` (combine, expire 2026-07-09)
  - `immich.rastapi.fr` (expire 2026-08-01)
  - `jellyfin.rastapi.fr` (expire 2026-08-01)
  - `navidrome.rastapi.fr` (expire 2026-08-01)
  - `download-center` (combine : download + jellyseerr + radarr + sonarr + prowlarr + qbittorrent .rastapi.fr)
- Renouvellement automatique via certbot (timer systemd)

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

## Code source : ou il se trouve

| Machine | Source du code | Usage |
|---------|----------------|-------|
| Pi (rasta-server) | `~/perso/infra/control_tower/` (clone git) | Source de verite. Dashboard + agent. |
| WSL Formule1 | `~/perso/infra/control_tower/` (clone git) | Dev local. |
| WSL Beast | `~/perso/infra/control_tower/` (clone git) | Dev local. |
| Windows Formule1 | `C:\ProgramData\ControlTowerAgent\` (deploiement) | Runtime agent uniquement. **Pas un clone git.** |
| Windows Beast | `C:\ProgramData\ControlTowerAgent\` (deploiement) | Runtime agent uniquement. **Pas un clone git.** |

L'agent Windows tourne en Python natif (psutil/services Windows, droits SYSTEM). Sur Windows, on ne deploie que le strict necessaire : `agent/*.py`, `requirements.txt`, venv. Pas de clone git, pas de duplication de tout le repo.

## Agents Windows (Formule1 + Beast)

### Installation initiale

- Cible : `C:\ProgramData\ControlTowerAgent\`
- Tache planifiee `ControlTowerAgent` (SYSTEM, AtStartup, RunLevel Highest), port 3002
- OpenSSH Server active sur le port 22, cle publique du Pi dans `C:\ProgramData\ssh\administrators_authorized_keys`
- Setup : depuis WSL de la machine, `bash setup_windows.sh` (helper) ou directement `powershell.exe -Verb RunAs -File setup_windows.ps1` (UAC interactif)

### Mise a jour

`deploy.sh` depuis le Pi pousse les `.py` modifies via SSH/SCP vers chaque machine Windows et redemarre la tache planifiee. Pas de `git pull` cote Windows.

### Particularites par machine

- **Formule1** : LAN Ivry, joignable en `192.168.1.10:3002` ou via Tailscale `100.115.135.121:3002`
- **Beast** : LAN campagne, joignable **uniquement via Tailscale** `100.105.121.10:3002` (pas de port forward sur le routeur campagne, et c'est tres bien ainsi : zero surface d'attaque internet)

### Fichier hosts Windows (Formule1 uniquement, contournement NAT loopback)

La Livebox d'Ivry ne supporte pas le NAT loopback. Pour acceder aux sites depuis le LAN Ivry :

```
# C:\Windows\System32\drivers\etc\hosts
192.168.1.16  control.rastapi.fr  stalag13.rastapi.fr  terje.rastapi.fr  immich.rastapi.fr  jellyfin.rastapi.fr  navidrome.rastapi.fr
192.168.1.16  download.rastapi.fr  jellyseerr.rastapi.fr  radarr.rastapi.fr  sonarr.rastapi.fr  prowlarr.rastapi.fr  qbittorrent.rastapi.fr
```

Script de fix : `C:\Users\franc\fix-hosts.ps1`

---

## machines.json (specifique par machine)

Le fichier `machines.json` n'est lu que par le **dashboard** (qui ne tourne que sur le Pi et eventuellement en dev sur les WSL). L'agent ne lit pas `machines.json`.

Chaque machine ou tourne un dashboard a donc son propre `machines.json` avec les IPs adaptees a son point de vue reseau.

### Depuis le Pi (prod)

```json
formule1-win  → 192.168.1.10:3002    (PC Ivry sur le LAN)
rasta-server  → localhost:3001       (lui-meme)
beast         → 100.105.121.10:3002  (PC Campagne via Tailscale)
```

### Depuis le WSL Formule1 (dev)

```json
formule1-win  → 172.23.80.1:3002   (gateway WSL vers Windows hote)
formule1-wsl  → localhost:3001     (lui-meme)
rasta-server  → 192.168.1.16:3001  (Pi sur le LAN)
```

### Depuis le WSL Beast (dev)

```json
formule1-win  → 100.115.135.121:3002 (Tailscale)
rasta-server  → 100.105.88.5:3001    (Tailscale)
beast-win     → 100.105.121.10:3002  (Windows hote via Tailscale)
```

**IMPORTANT** : `machines.json` et `auth.json` sont gitignored (specifiques par machine). Templates : `machines.json.example`, `auth.json.example`.

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
