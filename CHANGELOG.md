# Changelog

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
