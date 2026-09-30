# Open Study Room — web client (React + Vite SPA)
#
# Build context is the REPO ROOT (see docker-compose.yml: `context: .`). The
# web `prebuild` step syncs shared inputs from repo-relative paths, so both
# must exist in the image at their repo-relative locations:
#   ../assets                          (world assets -> web/public)
#   ../server/src/moderation/words.ts  (moderation wordlist)
#
# VITE_BACKEND_URL is baked into the bundle at BUILD time (Vite inlines
# VITE_* vars). Default works when the browser runs on this host. Phone on
# the LAN? Rebuild with the host's LAN IP, e.g.:
#   VITE_BACKEND_URL=http://192.168.1.42:8787 docker compose up --build web

FROM node:20 AS build
WORKDIR /app

# Inject any extra root CAs (e.g. a corporate TLS proxy) BEFORE the first
# network call — same trick as server/Dockerfile. Debian's system bundle is
# /etc/ssl/certs/ca-certificates.crt (not the Alpine path the server uses).
COPY server/certs/ /tmp/extra-ca/
RUN if ls /tmp/extra-ca/*.crt >/dev/null 2>&1; then \
      cat /tmp/extra-ca/*.crt >> /etc/ssl/certs/ca-certificates.crt; \
    fi && rm -rf /tmp/extra-ca
# Node ships its own CA bundle, so npm needs this hint to trust the proxy CA.
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt

# Install deps first for better layer caching.
COPY web/package.json web/package-lock.json ./web/
RUN cd web && npm ci --no-audit --no-fund

# Web sources + the two repo-level inputs the prebuild sync scripts read.
COPY web ./web
COPY assets ./assets
COPY server/src/moderation/words.ts ./server/src/moderation/words.ts

ARG VITE_BACKEND_URL=http://localhost:8787
# Runs `prebuild` first (npm lifecycle hook): sync-assets + sync-words.
RUN cd web && npm run build

# ---- runtime: static files behind nginx ----
FROM nginx:alpine
COPY web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/web/dist /usr/share/nginx/html
EXPOSE 80
