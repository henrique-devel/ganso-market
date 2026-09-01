# Build context: repository root.
FROM node:24.19.0-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS build
WORKDIR /workspace
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN npm ci --workspace @ganso-market/web --include-workspace-root
COPY apps/web apps/web
# RFC-015: the bundle bakes in the revision it was built from, so the footer can
# say which build is on screen and the panel can tell the operator to reload
# when the API reports a different one. `git archive` rewrites the placeholder
# in this file to the deployed commit; a plain checkout leaves it literal and
# the build correctly reports "unknown".
COPY deploy/release-sha deploy/release-sha
RUN npm run build --workspace @ganso-market/web

FROM nginx:1.30.4-alpine3.24@sha256:97d490c12ba55b4946b01546d1c3ed324e8d41ab1c9fcb2a616aa470620e5b46 AS runtime
COPY --chown=nginx:nginx apps/web/nginx.conf /etc/nginx/nginx.conf
COPY --from=build --chown=nginx:nginx /workspace/apps/web/dist /usr/share/nginx/html
USER nginx
EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
