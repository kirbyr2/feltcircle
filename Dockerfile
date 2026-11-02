# FeltCircle — Node.js backend + web app in one small image (amd64 and arm64).
# Build:  docker build -t feltcircle .
# Run:    docker compose up -d   (see docker-compose.yml and docs/DEPLOYMENT.md)

FROM node:22-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
# Only the workspaces needed for this image (skips the Cloudflare toolchain).
RUN npm ci --no-audit --no-fund --include-workspace-root \
      -w @feltcircle/web -w @feltcircle/server-node \
 && npm run build

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DATA_DIR=/data \
    STATIC_DIR=/app/web
WORKDIR /app
# The server is bundled into a single file; no node_modules needed at runtime.
COPY --from=build /src/apps/server-node/dist/server.mjs ./server.mjs
COPY --from=build /src/apps/web/dist ./web
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "server.mjs"]
