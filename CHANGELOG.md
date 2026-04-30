# Changelog

## v4.4 - 2026-04-30
### Sites — fix compteur visiteurs
- `_quick_analytics` filtre maintenant 3 niveaux de pollution avant de compter un "visiteur humain" :
  1. Exclusion de `127.0.0.1` (le checker du Pi se tape lui-meme via le proxy nginx → c'etait 851 hits sur 2400 dans le compteur control-tower).
  2. Exclusion des UA bot connus (regex : `bot|crawler|spider|fasthttp|libredtail|censys|zgrab|infrawat|keydrop|nmap|masscan|ControlTower|curl|wget|python-requests`...).
  3. Exigence d'avoir charge au moins 1 asset `.css` / `.js` / `.mjs` — un vrai navigateur charge automatiquement les `<link>` / `<script>` du HTML, un scanner non.
- `requests_24h` / `unique_ips_24h` exposent les humains estimes ; `raw_requests_24h` / `raw_unique_ips_24h` exposent le brut pour debug.
- Ajout de `quiquigagne` aux `nginx_log_paths` (tourne maintenant sur le Pi en gunicorn :8000, plus sur Oracle Cloud — ARCHITECTURE.md mis a jour en consequence).
- Resultat sur 24h : control-tower passe de 65 IPs → 2 humaines (verifie : c'est bien Franck sur 2 connexions distinctes).

## v4.3 - 2026-04-30
### Audit Monitoring / Sites / Network
- **Monitoring** : renommage machines (`Formule 1` au lieu de `Formule1 Windows`), ajout de l'IP publique sur les cartes (cache 10 min cote agent via api.ipify.org). Temperature CPU desactivee sur Windows : les valeurs lues via psutil/WMI sont des seuils ACPI figes, pas une mesure live — afficher None plutot qu'une fausse valeur (la jauge se masque deja automatiquement).
- **Sites** : nouvel endpoint dashboard `GET /health` (non authentifie) — le checker pointe maintenant `https://control.rastapi.fr/health` au lieu de `/`, ce qui evite le `307 → /auth/login` qui s'affichait. Ajout des stats `Hits 24h` et `Visiteurs 24h` (IPs uniques) directement sur les cartes des sites avec logs nginx, via un cache 60s cote dashboard.
- **Network** : fix CSS — les libelles `IP`, `Mask`, `Speed`, `MTU` sont maintenant separes des valeurs (flex + min-width 48px). Ajout d'une description humaine sous le nom de chaque interface (`Tailscale`, `OpenVPN`, `WSL2 / Hyper-V`, `Wi-Fi`, `Ethernet filaire`, `Adapter inactif (IP 169.254.x)`, etc.).

## v4.2 - 2026-04-28
### Reconstruction de la page Sites Monitoring
- Onglet "Sites" reintegre dans la sidebar (perdu lors de la reorganisation du dashboard du 2026-04-24, jamais committe en git, seul `sites.json` l'etait)
- Nouveau module `dashboard/sites.py` : checker HTTP en background toutes les 60s, persistence historique disque, infos SSL via socket TLS, parsing access logs nginx
- Endpoints `/api/sites` (liste + statut courant + historique 24h) et `/api/sites/{id}/analytics` (requetes, IPs uniques, top pages/IPs, repartition codes HTTP)
- Frontend : grille de cartes avec status pill UP/ERROR/DOWN, panneau de detail (SSL, headers, graphique latence canvas, analytics nginx) au clic, barre de selection machine masquee sur cette section
- L'historique existant `.sites_history.json` (1440 entrees) est repris au demarrage

## v4.1 - 2026-04-26
### Integration de Beast (PC Campagne) + refonte agent Windows
- Ajout de Beast dans `machines.json` (Pi) via Tailscale `100.105.121.10:3002`
- **Refonte du pattern agent Windows** : plus de clone git cote Windows, plus de dossier `pi-dashboard-agent` a plat. Deploiement minimal dans `C:\ProgramData\ControlTowerAgent\` (4 .py + requirements.txt + venv). Source unique = repo Pi/WSL.
- Nouveau script `setup_windows.ps1` : copie les fichiers depuis le clone WSL local, cree la tache planifiee `ControlTowerAgent` (SYSTEM, AtStartup, port 3002), active OpenSSH Server avec la cle publique du Pi pour permettre les mises a jour a distance.
- `deploy.sh` refait : push SSH/SCP vers les machines Windows (au lieu du `cp /mnt/c/`), restart de la tache planifiee. Plus de dependance a un point de montage `/mnt/c/` accessible.
- Fix : `/api/system` renvoie maintenant la vraie IP systeme (route par defaut) au lieu de l'IP de routage `machines.json` (qui peut valoir `localhost` ou une IP Tailscale, pas significative pour l'utilisateur).
- ARCHITECTURE.md : section infra Windows refondue, topologie Tailscale a jour, table source du code par machine.

## v4.0 - 2026-04-06
### Revue complete des 7 onglets avec Franck

#### Monitoring
- Jauges cliquables : clic CPU/RAM affiche les top processus, clic Disk affiche les partitions
- Endpoint /api/processes (optimise Windows : 2.6s au lieu de 24s)
- Endpoint /api/disk/usage
- Temperature masquee si indisponible
- Refresh auto sans clignotement, timers sans duplication

#### Services
- Detection dynamique de tous les services (plus de liste en dur)
- WSL: 126 services, Windows: 317, Pi: tous les services systemd
- Colonne Description (display_name)
- Colonne Type : system/tiers (detection via chemin executable sur Windows)
- Filtres Excel-style : dropdowns sur les en-tetes Type/Running/Boot
- Compteurs dynamiques dans les filtres
- Barre de recherche texte
- Encodage UTF-8 corrige pour les accents Windows

#### Network
- Stat cards cliquables : Connections et Interfaces ouvrent des panneaux detail
- Endpoint /api/connections (TCP/UDP avec status, local/remote, PID)
- Interfaces enrichies : status UP/DOWN, vitesse Mbps, MTU, trafic par interface
- Descriptions explicatives sur chaque stat card

#### Files
- Actions par fichier : Edit, Download, Transfer
- Modal Transfer avec mini-explorateur de fichiers pour la destination
- Breadcrumbs avec separateur > (plus de double //)
- Reset chemin au changement de machine (default_path)

#### Terminal
- Fix Windows : CWD passe au process (plus d'erreur UNC path)
- Reset CWD au changement de machine

#### Updates
- Windows : Get-HotFix rapide (1.5s) + winget en complement
- WSL : fallback apt list --upgradable si sudo indisponible
- Message explicite si sudo requis pour l'installation
- Timeout winget augmente a 120s

#### Logs
- Dropdown simple avec tous les services de la machine

#### Infrastructure
- Script deploy.sh automatise (syntax check, sync, restart, verify)
- Favicon SVG raspberry
- getMachine() helper function

## v3.0 - 2026-04-06
### Refonte complete du frontend
- Nouveau design "Control Tower" inspire de Grafana/Cockpit
- Gauges circulaires CSS avec valeurs visibles (conic-gradient)
- Vue "All" : grille de cartes machines avec mini-gauges et infos systeme
- Vue single : 4 grandes jauges + panneau d'info systeme detaille
- Branding "Control Tower" avec icones SVG dans la sidebar
- 30 tests d'integration pytest

## v2.0 - 2026-04-06
### Architecture multi-machines
- Separation agent/dashboard
- Proxy des requetes vers les agents via /api/m/{machineId}/...
- Configuration machines via machines.json
- Frontend avec selecteur de machines

## v1.0 - 2026-04-06
### Version initiale
- Backend FastAPI monolithique
- Frontend HTML/CSS/JS vanilla
- Monitoring, Services, Network, Files, Terminal, Updates, Logs
