#!/bin/sh
# Injecte la clé Google Maps dans game.js au démarrage du conteneur.
# La clé vient de la variable d'environnement GMAPS_KEY (définie dans Coolify),
# elle n'est donc jamais commitée dans le dépôt.
set -e

HTML_DIR="/usr/share/nginx/html"

if [ -n "$GMAPS_KEY" ]; then
  sed -i "s|__GMAPS_KEY__|$GMAPS_KEY|g" "$HTML_DIR/game.js"
  echo "[entrypoint] Clé Google Maps injectée dans game.js."
else
  echo "[entrypoint] ⚠️  GMAPS_KEY non définie — Street View ne fonctionnera pas."
fi
