#!/bin/sh
# Injecte la clé Google Maps dans game.js puis lance le serveur Node.
set -e

if [ -n "$GMAPS_KEY" ]; then
  sed -i "s|__GMAPS_KEY__|$GMAPS_KEY|g" /app/game.js
  echo "[entrypoint] Clé Google Maps injectée dans game.js."
else
  echo "[entrypoint] ⚠️  GMAPS_KEY non définie — Street View ne fonctionnera pas."
fi

exec node server.js
