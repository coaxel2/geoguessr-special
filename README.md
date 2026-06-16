# 🌍 GeoGuessr Spécial

Un clone de GeoGuessr **maison** : on est lâché quelque part dans le monde en vue Street View, et il faut deviner où sur une carte. **Solo** ou **multijoueur en ligne** (pair-à-pair, deux joueurs sur les mêmes lieux).

Fait par **Axel & Clément** — même équipe que le projet d'échecs, dont on a réutilisé tout le moteur multijoueur.

## Fonctionnalités

- 🎯 **Mode solo** : 3, 5 ou 10 manches, score façon GeoGuessr (jusqu'à 5000 pts/manche selon la distance).
- 🌐 **Multijoueur 1v1 en ligne** : l'hôte crée une partie (code à 4 lettres ou lien à partager), l'invité rejoint. Les deux joueurs ont **exactement les mêmes lieux** et comparent leurs scores manche par manche.
- 🗺️ Street View réel via l'**API Google Maps**, carte de guess sombre assortie à l'UI.
- 🎨 Interface soignée (thème sombre, glassmorphism).

## Architecture

| Brique | Techno |
|---|---|
| Street View + carte + distances | Google Maps JavaScript API (`StreetViewPanorama`, `Map`, lib `geometry`) |
| Recherche de lieux jouables | `StreetViewService.getPanorama` sur des régions à bonne couverture |
| Multijoueur (signaling WebRTC) | **PeerJS** (STUN Google + TURN openrelay) — repris du projet d'échecs |
| Synchro des lieux | l'hôte valide les panoramas puis envoie la liste `{lat,lng,panoId}` à l'invité |

Pas de backend, pas de base de données : **100 % statique** côté serveur, tout se passe dans le navigateur + une connexion P2P directe entre les deux joueurs.

## Clé Google Maps

Le jeu a besoin d'une **clé Google Maps API** (Maps JavaScript API activée).

- En local : remplace `__GMAPS_KEY__` dans `game.js` par ta clé.
- En production : **ne mets pas la clé dans le code**. L'image Docker l'injecte au démarrage depuis la variable d'environnement `GMAPS_KEY` (voir `docker-entrypoint.sh`).

⚠️ **Restreins toujours la clé** à `*.planbadge.fr` (restriction « référents HTTP ») dans la console Google Cloud : la clé est visible côté navigateur (inévitable pour Maps JS), la restriction par domaine empêche son usage ailleurs.

## Lancer en local

```sh
python3 -m http.server 8765
# puis http://localhost:8765  (après avoir mis ta clé dans game.js)
```

## Déploiement (Coolify, via Docker)

1. Pousser ce dossier sur un dépôt Git.
2. Coolify → New Resource → **Dockerfile** (build depuis le dépôt).
3. Variables d'environnement : `GMAPS_KEY = <ta clé>`.
4. Port interne : **80**. Domaine : `geoguessr2.planbadge.fr`.
5. Deploy.

La clé reste dans Coolify, jamais dans le dépôt.
