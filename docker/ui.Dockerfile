FROM node:22.23.1-bookworm-slim@sha256:53ada149d435c38b14476cb57e4a7da73c15595aba79bd6971b547ceb6d018bf AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
# packages/shared is a workspace dependency of packages/ui and resolves to its
# compiled dist/, so it has to be installed and BUILT here — a ui-only install
# leaves @atlas/shared unresolvable and `vite build` dies on the first import.
COPY packages/shared/package.json packages/shared/
COPY packages/ui/package.json packages/ui/
RUN npm ci --no-audit --no-fund \
      --workspace packages/shared --workspace packages/ui \
      --include-workspace-root
COPY packages/shared packages/shared
COPY packages/ui packages/ui
RUN npm run build -w packages/shared && npm run build -w packages/ui

FROM nginx:1.31.2-alpine@sha256:54f2a904c251d5a34adf545a72d32515a15e08418dae0266e23be2e18c66fefa
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/packages/ui/dist /usr/share/nginx/html
