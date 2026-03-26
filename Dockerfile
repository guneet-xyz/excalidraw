# Custom Dockerfile for self-hosted Excalidraw
# Supports build-time VITE_MODE to switch between .env.development and .env.production
#
# Build for dev (localhost URLs):
#   docker build --build-arg VITE_MODE=development -t excalidraw .
#
# Build for prod (draw.guneet.xyz URLs):
#   docker build -t excalidraw .

FROM --platform=${BUILDPLATFORM} node:20 AS build

WORKDIR /opt/node_app

COPY . .

# Install dependencies
RUN --mount=type=cache,target=/root/.cache/yarn \
    npm_config_target_arch=${TARGETARCH} yarn --network-timeout 600000

ARG NODE_ENV=production
ARG VITE_MODE=production

# Build with the specified Vite mode (determines which .env file is loaded)
RUN npm_config_target_arch=${TARGETARCH} \
    VITE_APP_DISABLE_SENTRY=true \
    yarn --cwd ./excalidraw-app vite build --mode ${VITE_MODE}

FROM --platform=${TARGETPLATFORM} nginx:1.27-alpine

COPY --from=build /opt/node_app/excalidraw-app/build /usr/share/nginx/html

HEALTHCHECK CMD wget -q -O /dev/null http://localhost || exit 1
