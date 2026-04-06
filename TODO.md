# Control Tower - TODO

## Revue des onglets (terminee 2026-04-06)
- [x] Monitoring (jauges cliquables, processus, partitions)
- [x] Services (dynamiques, descriptions, filtres Excel-style, categorie system/tiers)
- [x] Network (stat cards cliquables, connexions actives, interfaces enrichies)
- [x] Files (navigateur multi-drives, actions par fichier, transfer avec explorateur destination)
- [x] Terminal (CWD persistant, Windows fix UNC path)
- [x] Updates (Windows Get-HotFix rapide, WSL fallback apt list)
- [x] Logs (dropdown services, system par defaut)
- [ ] Machine Management (modal) - non teste en detail

## Bugs connus
- [ ] CPU% processus = 0% sur Windows (psutil trop lent)
- [x] favicon.ico 404
- [ ] deploy.sh : Pi peut reporter FAIL si demarrage >5s
- [ ] IP Windows (172.23.80.1) peut changer au reboot WSL

## Priorite haute
- [ ] Authentification (token ou mot de passe)
- [ ] Agent Windows en service permanent (Task Scheduler)
- [ ] Agent Pi en service systemd (verifier setup.sh)
- [ ] Dashboard en production sur le Pi

## Priorite moyenne
- [ ] Notifications/alertes (seuils CPU/RAM/Disk)
- [ ] Graphiques historiques (sparklines)
- [ ] HTTPS
- [ ] CPU% processus Windows (alternative a psutil)

## Priorite basse
- [ ] 3eme machine (PC campagne)
- [ ] Responsive mobile (tester)
- [ ] i18n francais
