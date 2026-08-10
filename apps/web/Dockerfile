# Build context: repository root.
FROM node:24.19.0-bookworm-slim AS build
WORKDIR /workspace
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN npm ci --workspace @ganso-market/web --include-workspace-root
COPY apps/web apps/web
RUN npm run build --workspace @ganso-market/web

FROM nginx:1.30.4-alpine3.24 AS runtime
COPY --chown=nginx:nginx apps/web/nginx.conf /etc/nginx/nginx.conf
COPY --from=build --chown=nginx:nginx /workspace/apps/web/dist /usr/share/nginx/html
USER nginx
EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
