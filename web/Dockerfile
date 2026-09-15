# Chachi POS — the web version (TASK-062). One container per store, built once:
#
#   docker build -f web/Dockerfile -t chachi-pos:latest .
#
# The container listens on 0.0.0.0:8080 in hosted mode (src/config/hosting.js); compose
# publishes it on the host's 127.0.0.1 only, and the host's nginx is in front with TLS.
# The store's database is in /data and its backups in /backups — two volumes, because a
# backup kept beside the thing it backs up survives nothing (OPS-001).

FROM node:20-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
# --omit=dev: Electron and its builder are the desktop app's, not the server's.
RUN npm ci --omit=dev

FROM node:20-bookworm-slim
ENV NODE_ENV=production \
    TZ=Asia/Manila \
    AGRIVET_HOSTED=1 \
    AGRIVET_HOST=0.0.0.0 \
    AGRIVET_PORT=8080 \
    AGRIVET_DATA_DIR=/data \
    AGRIVET_BACKUP_DIR=/backups
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
RUN rm -rf src/tests \
    && mkdir -p /data /backups && chown node:node /data /backups
USER node
VOLUME ["/data", "/backups"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
