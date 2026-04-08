# Control Tower - TODO

## Termine
- [x] Revue des 7 onglets (Monitoring, Services, Network, Files, Terminal, Updates, Logs)
- [x] Infrastructure (systemd Pi, Startup Windows, domaine, DNS, Nginx, port forwarding, HTTPS, auth)
- [x] Graphiques historiques (sparklines sous les jauges + page History avec courbes 30min/1h/6h/24h)
- [x] Infos WSL dans le monitoring Formule1 Windows (RAM + Disk)

## Bugs connus
- [ ] CPU% par processus Windows toujours a 0% — psutil ne peut pas le calculer rapidement, on affiche seulement le tri par RAM
- [ ] Le script deploy.sh peut afficher FAIL pour le Pi si le demarrage prend plus de 5 secondes (faux positif, le Pi est juste lent)
- [ ] L'IP publique Orange (86.246.253.121) peut changer sans prevenir — si ca arrive, les domaines ne pointeront plus vers le Pi
- [ ] La Livebox ne supporte pas le NAT loopback — depuis le reseau local, on passe par le fichier hosts Windows pour acceder aux sites

## A faire - Fonctionnalites
- [ ] Notifications/alertes : afficher une banniere rouge dans le monitoring quand un seuil est depasse (ex: RAM > 90%, Disk > 85%, machine offline). Eventuellement envoyer un email
- [ ] Machine Management modal : tester l'ajout et la suppression de machines depuis l'interface web (le code existe mais n'a pas ete teste avec Franck)
- [ ] Tailles des dossiers Windows : trouver une methode rapide pour calculer la taille des dossiers sur les gros disques Windows (actuellement trop lent, on affiche seulement le nombre d'elements)

## A faire - Infrastructure
- [ ] DynDNS : mettre en place un script qui met a jour le DNS OVH automatiquement si l'IP publique Orange change (API OVH ou ddclient)
- [ ] 3eme machine (PC campagne) : quand Franck sera sur place, ajouter la machine via l'interface Control Tower et configurer Tailscale dessus
- [ ] Migrer quiquigagne.rastapi.fr : le site QuiQuiGagne tourne sur Oracle Cloud, il faudrait le migrer sur le Pi et creer le sous-domaine + Nginx config
- [ ] Configurer terje.rastapi.fr : deployer le site Terje Medecine Guide sur le Pi et creer le sous-domaine + Nginx config

## A faire - Ameliorations
- [ ] Responsive mobile : le CSS est pret mais pas teste sur telephone, verifier que tout s'affiche correctement
- [ ] i18n francais : traduire l'interface en francais (actuellement en anglais)
