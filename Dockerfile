# ——— build stage: bundle the Vite client ———
FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY index.html vite.config.js ./
COPY src ./src
RUN npm run build

# ——— runtime stage: only the server + bundled dist ———
FROM node:20-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DATA_DIR=/data

# runtime-only deps (express, ws). three/tone/vite are bundled into dist/.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY --from=build /app/dist ./dist

# volume mount point — Fly attaches the persistent disk here
RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 3000

# drop to non-root for a little hardening; /data must be writable
RUN chown -R node:node /app /data
USER node

CMD ["node", "server/index.js"]
