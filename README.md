# 📍 Geoloc

Un jeu de **géo-devinette maison** : on est lâché quelque part dans le monde en vue Street View, et il faut deviner où sur une carte. **Solo** ou **multijoueur en ligne** avec code de salle.

Fait par **Axel Courty**.

## Fonctionnalités

- 🎯 **Mode solo** : 3, 5 ou 10 manches, score selon la distance (jusqu'à 5000 pts/manche).
- 🌐 **Multijoueur en ligne** : l'hôte crée une partie (code à 4 caractères ou lien à partager), les invités rejoignent. Mêmes lieux pour tous, scores comparés manche par manche.
- 🧑‍🎨 **Avatars** choisis dans une galerie et synchronisés en multi.
- 🗺️ Street View et carte de choix via l'**API Google Maps** : routes, commerces et points d'intérêt Google sont visibles pendant la manche. Leaflet reste utilisé pour les mini-cartes de zones et la carte de résultat.
- 🏆 **Classement persistant** : chaque partie solo terminée est enregistrée dans une base **PostgreSQL** ; meilleurs scores par zone et top global consultables depuis l'accueil.
- 🎨 Interface sombre soignée (glassmorphism).

## Architecture

| Brique | Techno |
|---|---|
| Street View | Google Maps JavaScript API (`StreetViewPanorama`, `StreetViewService`) |
| Carte de choix | Google Maps JavaScript API (fond routier, commerces et POI) |
| Mini-cartes de zones / résultat | Leaflet + tuiles CartoDB (raster, sans clé ni WebGL) |
| Distances | formule de Haversine (maison) |
| Serveur app + multijoueur | Node/Express + relay WebSocket `/rooms` |
| Base de données | **PostgreSQL** (table `scores`) — classement des parties solo |
| Synchro des lieux | l'hôte valide les panoramas puis envoie la liste `{lat,lng,panoId}` aux invités |

### Base de données (classement)

À la fin d'une partie solo, le client envoie le score à l'API du serveur, qui le **persiste** en PostgreSQL :

- `POST /api/scores` — enregistre `{pseudo, zone, zoneLabel, rounds, score}` (validation stricte côté serveur, requêtes paramétrées) et renvoie le rang du joueur dans la zone.
- `GET /api/scores?zone=…&limit=…` — meilleurs scores d'une zone, ou top global si `zone` est absent.

La connexion se fait via la variable d'environnement **`DATABASE_URL`** (fournie par la base Postgres de Coolify). **Si `DATABASE_URL` est absente, le jeu fonctionne quand même** : le classement est simplement masqué — aucune fonctionnalité de jeu n'en dépend. `GET /healthz` renvoie `{"ok":true,"db":true|false}` pour vérifier d'un coup d'œil l'app **et** la connexion à la base.

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
3. Dans le même projet Coolify, créer une base **PostgreSQL** (New Resource → Database → PostgreSQL).
4. Variables d'environnement de l'app :
   - `GMAPS_KEY = <ta clé restreinte>`
   - `DATABASE_URL = <URL de connexion interne de la base Postgres>` (ex. `postgres://user:pass@<service>:5432/postgres`)
5. Port interne : **80**. Deploy.

La clé et l'URL de base restent dans Coolify, jamais dans le dépôt. La table `scores` est créée automatiquement au premier démarrage.
