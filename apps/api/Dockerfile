# Build context: repository root.
FROM node:24.19.0-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS build
WORKDIR /workspace
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN npm ci --workspace @ganso-market/api --include-workspace-root
COPY apps/api apps/api
RUN npm run build --workspace @ganso-market/api

FROM node:24.19.0-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS runtime
ENV NODE_ENV=production
WORKDIR /workspace
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN npm ci --omit=dev --workspace @ganso-market/api --include-workspace-root=false \
    && npm cache clean --force
COPY --from=build /workspace/apps/api/dist apps/api/dist
# RFC-010 provenance. `git archive` rewrites this file to the exact commit SHA
# of the deployed revision (see .gitattributes export-subst), and baking it into
# the IMAGE — rather than mounting it from the checkout — means the stamp on an
# estimate can never drift from the code that produced it.
COPY deploy/release-sha /etc/ganso/release-sha
USER node
EXPOSE 3000
CMD ["node", "apps/api/dist/main.js"]
