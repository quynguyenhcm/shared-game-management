# Next.js standalone server. Build context is the repository root:  docker build -f apps/web/Dockerfile .

FROM node:24-slim AS build
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --frozen-lockfile --filter "@sgm/web..."
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web
# next.config.ts reads WEB_BASE_URL at build time for serverActions.allowedOrigins (baked into the server).
# There is deliberately NO default: an image built for the wrong origin rejects every form submission, so the
# build fails unless the environment's public origin is passed:  --build-arg WEB_BASE_URL=https://games.example.nz
# (docker-compose.yml supplies the local http://localhost:3000 for development only). At boot the server
# refuses to start when the runtime WEB_BASE_URL host differs from the host baked in here.
ARG WEB_BASE_URL
RUN case "${WEB_BASE_URL}" in \
      http://?*|https://?*) ;; \
      *) echo "ERROR: build arg WEB_BASE_URL is required (an http(s) origin, e.g. https://games.example.nz)" >&2; exit 1 ;; \
    esac
ENV WEB_BASE_URL=${WEB_BASE_URL}
RUN pnpm --filter @sgm/web build

FROM node:24-slim
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
