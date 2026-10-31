# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS source
WORKDIR /app
# The ignore file excludes local secrets, sessions, dependencies and build data.
# A single source COPY also keeps VFS-backed development daemons affordable.
COPY . .

FROM source AS backend
# Preserve inherited proxy routing and TLS checks. The public CA is mounted
# only for this networked step. Install only backend/worker workspace needs.
RUN --mount=type=secret,id=proxy_ca \
    if [ -s /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm ci --workspace=@cloudnest/api --workspace=@cloudnest/telegram-worker --include-workspace-root --strict-ssl=true --no-audit --no-fund \
    && npm cache clean --force \
    && mkdir -p /data/staging /data/api /data/tdlib \
    && chown -R node:node /data \
    && chmod -R a+rX /app
ENV NODE_ENV=production
ENV NPM_CONFIG_CACHE=/tmp/npm
USER node
CMD ["npm", "start", "--workspace=@cloudnest/api"]

FROM source AS frontend
ARG NEXT_PUBLIC_STORAGE_MODE=server
ARG API_URL=http://api:4000
ENV NEXT_PUBLIC_STORAGE_MODE=$NEXT_PUBLIC_STORAGE_MODE
ENV API_URL=$API_URL
ENV NEXT_TELEMETRY_DISABLED=1
RUN --mount=type=secret,id=proxy_ca \
    if [ -s /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm ci --workspace=@cloudnest/web --include-workspace-root --strict-ssl=true --no-audit --no-fund \
    && npm run build --workspace=@cloudnest/web \
    && npm cache clean --force \
    && chown -R node:node /app/apps/web/.next \
    && chmod -R a+rX /app
ENV NODE_ENV=production
ENV NPM_CONFIG_CACHE=/tmp/npm
USER node
EXPOSE 3000
CMD ["npm", "start", "--workspace=@cloudnest/web", "--", "--hostname", "0.0.0.0"]
