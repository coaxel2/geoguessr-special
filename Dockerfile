# GeoGuessr Spécial — image statique servie par nginx.
# La clé Google Maps n'est PAS dans le code : elle est injectée au démarrage
# du conteneur depuis la variable d'environnement GMAPS_KEY (voir entrypoint).
FROM nginx:alpine

# Fichiers de l'application
COPY index.html style.css game.js /usr/share/nginx/html/

# Script d'injection de la clé (exécuté par le mécanisme docker-entrypoint.d de nginx)
COPY docker-entrypoint.sh /docker-entrypoint.d/40-inject-gmaps-key.sh
RUN chmod +x /docker-entrypoint.d/40-inject-gmaps-key.sh

EXPOSE 80
