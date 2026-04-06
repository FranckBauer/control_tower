# Changelog

## v3.0 - 2026-04-06
### Refonte complete du frontend
- Nouveau design "Control Tower" inspire de Grafana/Cockpit
- Gauges circulaires CSS avec valeurs visibles (conic-gradient)
- Vue "All" : grille de cartes machines avec mini-gauges et infos systeme
- Vue single : 4 grandes jauges + panneau d'info systeme detaille
- Branding "Control Tower" avec icones SVG dans la sidebar

### Multi-machines
- Support 3 machines : Windows natif, WSL, Raspberry Pi 5
- Agent cross-platform (Linux + Windows)
- Services Windows via `sc query` / services Linux via `systemctl`
- Drives : listing des disques (C:\, D:\, E:\ sur Windows, partitions sur Linux)
- Terminal avec CWD persistant par machine
- Navigateur de fichiers avec chemins Unix et Windows

### Infrastructure
- README, CHANGELOG, ARCHITECTURE.md
- Tests d'integration complets (tous endpoints, toutes machines)

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
