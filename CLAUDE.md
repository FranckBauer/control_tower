# Control Tower

Dashboard d'administration reseau multi-machines (Windows, WSL, Raspberry Pi 5).

## Regles

Les feedbacks globaux du repertoire `/perso` s'appliquent ici :
- **Tout en francais** : reponses, commits, commentaires, noms de branches — jamais d'anglais
- **Pas de Co-Authored-By** dans les commits git
- **Tester visuellement** avant de presenter quoi que ce soit

## Deploiement

- `bash deploy.sh` pour tout deployer (sync + restart sur les 3 machines)
- **Ne JAMAIS sync machines.json ou auth.json** vers le Pi ou Windows (specifiques par machine)
- Le Pi peut mettre >5s a demarrer, un FAIL dans deploy.sh peut etre un faux positif

## Architecture

Voir ARCHITECTURE.md pour le schema reseau complet, les IPs, les sites deployes et l'infrastructure.
