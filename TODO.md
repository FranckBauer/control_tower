# Control Tower - TODO

## Revue des onglets (terminee 2026-04-06)
- [x] Monitoring (jauges cliquables, processus, partitions, volumes repertoires)
- [x] Services (dynamiques, descriptions, filtres Excel-style, categorie system/tiers)
- [x] Network (stat cards cliquables, connexions actives, interfaces enrichies)
- [x] Files (navigateur multi-drives, actions par fichier, transfer avec explorateur destination)
- [x] Terminal (CWD persistant, Windows fix UNC path)
- [x] Updates (Windows Get-HotFix rapide, WSL fallback apt list)
- [x] Logs (dropdown services, system par defaut)
- [ ] Machine Management (modal) - non teste en detail

## Infrastructure (terminee 2026-04-08)
- [x] Agent Pi en service systemd (control-tower-agent.service)
- [x] Dashboard Pi en service systemd (control-tower-dashboard.service)
- [x] Agent Windows en service permanent (Startup folder + VBS)
- [x] Domaine rastapi.fr achete (OVH, 4.99/an)
- [x] DNS configure (control + stalag13 → IP publique)
- [x] Nginx reverse proxy sur le Pi
- [x] Port forwarding Livebox (80 + 443 → Pi)
- [x] Fichier hosts Windows pour acces LAN
- [x] Favicon

## Bugs connus
- [ ] CPU% processus = 0% sur Windows (psutil trop lent)
- [ ] deploy.sh : Pi peut reporter FAIL si demarrage >5s
- [ ] IP publique Orange potentiellement dynamique (pas de DynDNS)
- [ ] NAT loopback Livebox non supporte (contourne via fichier hosts)

## Priorite haute
- [x] Authentification (htpasswd Nginx sur control.rastapi.fr)
- [x] HTTPS avec Let's Encrypt (certbot, renouvellement auto, expire 7 juillet 2026)

## Priorite moyenne
- [ ] Notifications/alertes (seuils CPU/RAM/Disk)
- [ ] Graphiques historiques (sparklines)
- [ ] CPU% processus Windows (alternative a psutil)
- [ ] DynDNS si IP publique change

## Priorite basse
- [ ] 3eme machine (PC campagne)
- [ ] Responsive mobile (tester)
- [ ] i18n francais
- [ ] Migrer quiquigagne.rastapi.fr depuis Oracle Cloud
- [ ] Configurer terje.rastapi.fr
