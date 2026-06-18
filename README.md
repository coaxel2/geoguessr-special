# 📍 Geoloc

Un jeu de **géo-devinette maison** : on est lâché quelque part dans le monde en vue Street View, et il faut deviner où sur une carte. **Solo** ou **multijoueur en ligne** avec code de salle.

Fait par **Axel & Clément**.

## Fonctionnalités

- 🎯 **Mode solo** : 3, 5 ou 10 manches, score selon la distance (jusqu'à 5000 pts/manche).
- 🌐 **Multijoueur en ligne** : l'hôte crée une partie (code à 4 caractères ou lien à partager), les invités rejoignent. Mêmes lieux pour tous, scores comparés manche par manche.
- 🧑‍🎨 **Avatars** choisis dans une galerie et synchronisés en multi.
- 🗺️ Street View réel via l'**API Google Maps** ; cartes de guess en **Leaflet** (tuiles sombres CartoDB, sans clé).
- 🎨 Interface sombre soignée (glassmorphism).

## Architecture

| Brique | Techno |
|---|---|
| Street View | Google Maps JavaScript API (`StreetViewPanorama`, `StreetViewService`) |
| Cartes de guess / résultat | Leaflet + tuiles CartoDB (raster, sans clé ni WebGL) |
| Distances | formule de Haversine (maison) |
| Serveur app + multijoueur | Node/Express + relay WebSocket `/rooms` |
| Synchro des lieux | l'hôte valide les panoramas puis envoie la liste `{lat,lng,panoId}` aux invités |

Pas de base de données : le serveur Node sert les fichiers et relaie uniquement les petits messages de salle en mémoire.

## Clé Google Maps

Le jeu a besoin d'une **clé Google Maps API** (Maps JavaScript API activée).

- **Jamais dans le code** : `game.js` ne contient que le placeholder `__GMAPS_KEY__`.
- Au démarrage du conteneur, `entrypoint.sh` remplace ce placeholder par la variable d'environnement `GMAPS_KEY` (définie dans Coolify), donc la clé n'est jamais commitée.
- ⚠️ Une clé Maps JS est **toujours visible** dans le navigateur : la seule vraie protection est de la **restreindre par référent HTTP** (`https://<ton-domaine>.planbadge.fr/*`) et de la limiter à la **Maps JavaScript API** dans la console Google Cloud.

## Lancer en local

```sh
# en local seulement : remplace temporairement __GMAPS_KEY__ par ta clé dans game.js
npm install
PORT=8080 npm start
# http://localhost:8080
```

## Déploiement (Coolify, via Docker)

1. Pousser ce dossier sur un dépôt Git.
2. Coolify → New Resource → **Dockerfile** (pas Nixpacks : l'injection de clé passe par `entrypoint.sh`).
3. Variable d'environnement : `GMAPS_KEY = <ta clé restreinte>`.
4. Port interne : **80**. Deploy.

La clé reste dans Coolify, jamais dans le dépôt.
