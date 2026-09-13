# syntax=docker/dockerfile:1.7
# --- build stage ---
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
# Prefer `npm ci` for reproducible installs; fall back to `npm install` if the
# lockfile isn't present (e.g. building from a workspace subdir without hoisted
# lockfile — CI produces one, but local devs may not).
RUN if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; \
    else npm install --no-audit --no-fund; fi
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json

# --- runtime stage ---
FROM node:20-alpine AS runtime
# tini reaps zombies and forwards signals so SIGTERM actually reaches Node.
RUN apk add --no-cache tini
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev --no-audit --no-fund; \
    else npm install --omit=dev --no-audit --no-fund; fi
COPY --from=build /app/dist ./dist

# Drop privileges. The upstream node image ships a `node` user (uid 1000).
USER node

EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=2s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
