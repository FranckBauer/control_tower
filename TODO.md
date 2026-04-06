# Control Tower - TODO

## Revue des onglets (en cours avec Franck)
- [x] Monitoring
- [ ] Services
- [ ] Network
- [ ] Files
- [ ] Terminal
- [ ] Updates
- [ ] Logs
- [ ] Machine Management (modal)

## Bugs connus
- [ ] CPU% processus = 0% sur Windows (psutil trop lent)
- [ ] favicon.ico 404
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
- [ ] Favicon
