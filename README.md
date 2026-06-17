# 📍 Geoloc

Un jeu de **géo-devinette maison** : on est lâché quelque part dans le monde en vue Street View, et il faut deviner où sur une carte. **Solo** ou **multijoueur en ligne** (pair-à-pair, deux joueurs sur les mêmes lieux).

Fait par **Axel & Clément** — même équipe que le projet d'échecs, dont on a réutilisé tout le moteur multijoueur.

## Fonctionnalités

- 🎯 **Mode solo** : 3, 5 ou 10 manches, score selon la distance (jusqu'à 5000 pts/manche).
- 🌐 **Multijoueur 1v1 en ligne** : l'hôte crée une partie (code à 4 lettres ou lien à partager), l'invité rejoint. Mêmes lieux pour les deux, scores comparés manche par manche. La **manche suivante** et le **Rejouer** nécessitent l'accord des deux joueurs (2/2).
- 🧑‍🎨 **Avatars identicon** générés depuis le pseudo (déterministes, affichés des deux côtés en multi sans rien transmettre de plus).
- 🗺️ Street View réel via l'**API Google Maps** ; cartes de guess en **Leaflet** (tuiles sombres CartoDB, sans clé).
- 🎨 Interface sombre soignée (glassmorphism).

## Architecture

| Brique | Techno |
|---|---|
| Street View | Google Maps JavaScript API (`StreetViewPanorama`, `StreetViewService`) |
| Cartes de guess / résultat | Leaflet + tuiles CartoDB (raster, sans clé ni WebGL) |
| Distances | formule de Haversine (maison) |
| Multijoueur (signaling WebRTC) | **PeerJS** (STUN Google + TURN openrelay) — repris du projet d'échecs |
| Synchro des lieux | l'hôte valide les panoramas puis envoie la liste `{lat,lng,panoId}` à l'invité |

Pas de backend, pas de base de données : **100 % statique** côté serveur, tout se passe dans le navigateur + une connexion P2P directe entre les deux joueurs.

## Clé Google Maps

Le jeu a besoin d'une **clé Google Maps API** (Maps JavaScript API activée).

- **Jamais dans le code** : `game.js` ne contient que le placeholder `__GMAPS_KEY__`.
- Au démarrage du conteneur, `docker-entrypoint.sh` remplace ce placeholder par la variable d'environnement `GMAPS_KEY` (définie dans Coolify), donc la clé n'est jamais commitée.
- ⚠️ Une clé Maps JS est **toujours visible** dans le navigateur : la seule vraie protection est de la **restreindre par référent HTTP** (`https://<ton-domaine>.planbadge.fr/*`) et de la limiter à la **Maps JavaScript API** dans la console Google Cloud.

## Lancer en local

```sh
# en local seulement : remplace __GMAPS_KEY__ par ta clé dans game.js, puis
python3 -m http.server 8765
# http://localhost:8765
```

## Déploiement (Coolify, via Docker)

1. Pousser ce dossier sur un dépôt Git.
2. Coolify → New Resource → **Dockerfile** (pas Nixpacks : l'injection de clé passe par l'entrypoint nginx).
3. Variable d'environnement : `GMAPS_KEY = <ta clé restreinte>`.
4. Port interne : **80**. Deploy.

La clé reste dans Coolify, jamais dans le dépôt.
