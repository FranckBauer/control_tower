# Changelog

## v4.11 - 2026-05-27
### pi-health : canal de notification basculé de mail SMTP vers ntfy.sh

Le canal mail v4.10 ne fonctionnait pas en pratique :
- SMTP Yacast `10.10.0.61:25` rejette les IP VPN `10.0.8.x` (rejet `cannot find your
  reverse hostname`). Le Pi est sur 10.0.8.x via OpenVPN Yacast → rejeté.
- Le fallback SSH relay vers `fbauer@10.2.10.173` (réutilisé du `notify.sh`
  sync-claude-memory) échoue depuis le Pi : sa clé `fbauer_ed25519` n'est pas
  autorisée sur cet host (alors qu'elle l'est pour Formule1).
- Même fixé, ça mélangerait infra Yacast (boulot) avec monitoring perso (règle
  feedbacks #10 = pas de mix boulot/perso).

Remplacé par **ntfy.sh** :
- Service push notification gratuit, sans inscription
- Le Pi POST sur `https://ntfy.sh/<topic-secret>` → notification instantanée
  sur le tel de Franck (app ntfy gratuite Android/iOS) et/ou browser
- Topic secret stocké dans `/etc/pi-health/ntfy-topic` (mode 600 root, jamais
  en git ni en mémoire — conforme règle feedbacks #9 pas de secrets)
- Marche depuis n'importe quelle IP avec sortie HTTPS, indépendant de Yacast,
  pas de dépendance à Formule1
- Mapping niveaux pi-health → ntfy : ok=low (tag ✓), warning=high, critical=urgent (tag ⚠️)

Code modifié :
- `pi_health.py` : suppression `send_mail()` + dépendances `smtplib`/MIMEText,
  ajout `send_ntfy(title, body, level)` qui POST en HTTPS via `urllib.request`
  (stdlib, pas de dep). Lecture du topic depuis `/etc/pi-health/ntfy-topic`.
- Notifs de résolution envoyées en priorité `low` avec tag `white_check_mark`.

Pour installer/utiliser : voir `pi-health/README.md`.

Le même topic ntfy peut être réutilisé par d'autres scripts/projets perso pour
alerter Franck (cf. message inbox déposé dans `/home/franck/perso`).

## v4.10 - 2026-05-27
### pi-health : monitoring + alerting + auto-recovery du Pi rasta-server

Nouveau module `pi-health/` (script + units systemd + install) à côté de `agent/` et `dashboard/`.

- Script Python `pi_health.py` lancé par timer systemd toutes les minutes (root).
  Collecte par check :
  - Température CPU (`/sys/class/thermal/thermal_zone0/temp` + fallback `vcgencmd`)
  - État link eth0 (operstate, carrier, speed) + nombre de flap Up/Down sur 1 min (parse `dmesg`)
  - État des services critiques : nginx, dnsmasq, tailscaled
  - DNS local : `dig @127.0.0.1 jellyfin.rastapi.fr` doit retourner `100.105.88.5`
  - Charge CPU (load1), RAM dispo, % disque /

- Seuils déclenchant alerte :
  - Température : warning à 75°C, critical à 85°C (throttling imminent)
  - Link eth0 : critical si down, warning si ≥4 flap/min
  - Service systemd non actif : critical
  - DNS local KO : critical
  - Disque : warning à 85%, critical à 95%
  - RAM dispo < 200 MB ou load1 > 4 : warning

- Logs structurés JSON ligne par ligne :
  - `/var/log/pi-health/health.log` : métriques de chaque check
  - `/var/log/pi-health/alerts.log` : anomalies détectées
  - `journalctl -u pi-health.service` : exécution systemd

- Auto-recovery (Phase 2) après 2 checks consécutifs en erreur (~2 min) :
  - Service down → `systemctl restart <service>`
  - Link eth0 down → `ip link set eth0 down ; sleep 2 ; ip link set eth0 up`

- Mail d'alerte vers `aaaaafe63k2shrr2w6wuw3hk2i@yacast.slack.com` (canal Slack Franck) :
  - SMTP direct Yacast `10.10.0.61:25` avec fallback SSH relay `fbauer@10.2.10.173`
    (Pi via OpenVPN Yacast actif sur `tun0`)
  - Anti-spam : ré-envoi au max toutes les 30 min tant que l'anomalie persiste
  - Mail de résolution envoyé quand l'anomalie disparaît

- State persistant dans `/var/lib/pi-health/state.json` (counters d'erreurs consécutives,
  timestamps des dernières notifs).

Conçu suite aux incidents 2026-05-12 et 2026-05-27 où le Pi est devenu injoignable
sans aucune alerte, avec heures perdues à diagnostiquer post-mortem. Désormais une
alerte mail/Slack arrive en quelques minutes en cas de problème critique.

Installation : `cd pi-health && bash install.sh` sur le Pi (sudo).

## v4.9 - 2026-05-06
### Vue Tailnet — liste de tous les noeuds Tailscale

- Nouvelle section **Tailnet** dans la sidebar (entre Sites et Services).
- Backend `dashboard/tailscale.py` : endpoint `GET /api/tailscale/devices` qui invoque
  `tailscale status --json` localement (binaire detecte automatiquement Linux ou
  Windows via WSL) et expose Self + Peers normalises. Cache 15s pour ne pas spammer
  le demon Tailscale.
- Frontend : grille de cards responsives, une card par appareil, avec :
  - Icone OS (Windows/Linux/Android/macOS), nom, FQDN MagicDNS
  - Badge "Soi" pour la machine locale, "Exit Node actif/dispo" si applicable
  - Pill Online/Offline avec dot pulsant (vert) ou last_seen relatif (rouge)
  - IP v4 + v6, OS, type de liaison (Direct + adresse, ou DERP + ville)
  - Trafic Tx/Rx formate, dernier handshake, date d'ajout au tailnet
- Auto-refresh 30s. Header affiche le suffixe MagicDNS (ex: `tailbb26eb.ts.net`).
- Tri : Soi > online > offline, puis par nom alphabetique.
- Permet enfin d'avoir une visibilite sur les noeuds sans agent control_tower
  (Android, iPad...) — un Pi avec son agent reste vu via Monitoring, mais un S20
  ou une Tab A9+ apparaissent ici avec leur etat reel du tailnet.

## v4.7 - 2026-05-04
### Sous-domaines HTTPS pour immich/jellyfin/navidrome (reverse proxy Pi)

- Ajout de 3 vhosts nginx sur le Pi rasta-server, avec certificats Let's Encrypt :
  - `https://immich.rastapi.fr` → `http://100.115.135.121:2283` (Formule1 via Tailscale)
  - `https://jellyfin.rastapi.fr` → `http://100.115.135.121:8096`
  - `https://navidrome.rastapi.fr` → `http://100.115.135.121:4533`
- Particularites par vhost :
  - Immich : `client_max_body_size 50000M`, websockets, `proxy_buffering off`, timeouts 600s
  - Jellyfin : websockets, `proxy_buffering off`, timeouts 600s (streaming continu)
  - Navidrome : reverse proxy standard
- Restriction d'acces : `allow 100.64.0.0/10` (Tailscale CGNAT) + `allow 192.168.1.0/24`
  (LAN Ivry) + `allow 127.0.0.1` + `deny all`. Le DNS A est public mais le contenu n'est
  pas expose a internet — l'URL HTTPS est juste un confort de nommage.
- DNS OVH : 3 records A ajoutes vers 86.246.253.121 (typo `.12` corrigee pour immich).
- `sites.json` : URLs migrees de `http://100.115.135.121:PORT/` vers `https://X.rastapi.fr/`.
  Ajout des `nginx_log_paths` pour les 3 nouveaux sites.

## v4.6 - 2026-05-03
### Sites — Immich, Navidrome, Jellyfin + bouton "ouvrir" + schéma url/healthcheck_path

- Ajout de 3 services self-hosted Docker tournant sur Formule1 (WSL2) :
  - Immich (photos) : http://100.115.135.121:2283/, healthcheck `/api/server/version`
  - Navidrome (musique) : http://100.115.135.121:4533/, healthcheck `/` (302)
  - Jellyfin (films/series) : http://100.115.135.121:8096/, healthcheck `/System/Info/Public`
  - URL via Tailscale Windows (100.115.135.121) atteignable depuis le Pi
- Bascule WSL2 en `networkingMode=mirrored` (`.wslconfig` cote Windows) : les ports WSL
  sont accessibles depuis toutes les interfaces Windows (LAN, Tailscale, loopback) sans
  portproxy. Plus de bidouille a chaque service ajoute.
- Regles firewall Windows entrantes pour 2283/4533/8096 (cree via l'agent SYSTEM).
- Schema `sites.json` : nouveau champ optionnel `healthcheck_path`. `url` est maintenant
  l'URL home (ce qui s'ouvre quand on clique le bouton), `healthcheck_path` est le path
  teste par le checker (default "/"). Migration de control-tower : `url` passe de
  `/health` a `/`, `healthcheck_path: /health` ajoute.
- Frontend : petit bouton "ouvrir dans un nouvel onglet" sur chaque carte de site (icone
  external-link, en haut a droite, target=_blank avec stopPropagation pour ne pas trigger
  l'expand).
- API `/api/sites` expose desormais `check_url` (URL effectivement testee, utile au debug).

## v4.5 - 2026-04-30
### Sites — fix detection sites statiques (terje)
- L'heuristique v4.4 exigeait au moins 1 asset CSS/JS pour qualifier une IP de "humaine".
  Probleme : terje est purement statique (HTML + images, pas de CSS/JS externe), donc
  meme un humain qui charge la page restait a 0 visiteur.
- Ajout d'un critere alternatif : `Referer` qui pointe vers le hostname legitime du site
  (ex: `Referer: https://terje.rastapi.fr/...`). Un navigateur l'envoie automatiquement
  quand il charge des images depuis une page, un scanner non. On exige le hostname
  pour ne pas matcher les Referer forges vers l'IP brute (`https://86.246.253.121/`).
- `_quick_analytics(site_id, log_path, hostname)` : nouveau parametre `hostname` extrait
  de l'URL via urlparse dans `list_sites`.
- Resultat : terje passe de 0 -> 1 IP humaine / 126 hits 24h. Control-tower reste a 2.

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
