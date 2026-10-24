# Backend QA-UI Agent : Node + Playwright + les 3 navigateurs (Chromium, Firefox, WebKit) déjà installés.
# La version de l'image doit être la MÊME que celle de "playwright" dans package-lock.json (1.63.0),
# sinon Playwright ne retrouve pas ses navigateurs.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

WORKDIR /app/backend

# D'abord les dépendances (cette couche est réutilisée tant que package*.json ne change pas).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

# Tout ce que l'outil écrit (runs, captures, traces) vit dans /data, un volume Docker :
# les résultats survivent à un redémarrage ou à une mise à jour du conteneur.
# Les dossiers attendus dans backend/ sont des liens vers /data.
RUN mkdir -p /data \
 && for d in runs run-screenshots run-traces diff-screenshots debug-screenshots reports; do \
      mkdir -p /data/$d && ln -s /data/$d /app/backend/$d; \
    done \
 && chown -R pwuser:pwuser /data /app/backend

USER pwuser
ENV NODE_ENV=production PORT=4000
EXPOSE 4000

CMD ["node", "src/server.js"]
