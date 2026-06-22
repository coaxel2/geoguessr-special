# Geoloc — serveur Node : fichiers statiques + relay multijoueur WebSocket (/rooms).
# La clé Google Maps est injectée au démarrage depuis la variable GMAPS_KEY (jamais commitée).
FROM node:20-alpine
WORKDIR /app

# Dépendances (cache de couche tant que package.json ne change pas)
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# Fichiers de l'application
COPY index.html style.css game.js favicon.svg zones-geo.json globe-land.json cities-by-country.json server.js entrypoint.sh ./
RUN chmod +x entrypoint.sh

EXPOSE 80
CMD ["./entrypoint.sh"]
