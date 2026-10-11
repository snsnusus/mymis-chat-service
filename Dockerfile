# ---- Stage 1: build ----
# Full toolchain: dev dependencies + TypeScript compiler. Thrown away after the build.
FROM node:24-alpine AS build
WORKDIR /app

# Dependencies first, in their own layer: this layer is rebuilt only when
# package.json or package-lock.json change, not on every code change.
COPY package.json package-lock.json ./
RUN npm ci

# Then the source and compiler settings, and compile to dist/.
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- Stage 2: runtime ----
# Only what's needed to RUN: Node, production dependencies, compiled JavaScript.
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Apply the latest Alpine security patches for the system packages in the base image.
RUN apk upgrade --no-cache

COPY package.json package-lock.json ./

# Install production dependencies, then remove the package managers: the running service
# only needs `node`, and npm/yarn/corepack bring their own (often vulnerable) dependencies.
RUN npm ci --omit=dev \
 && npm cache clean --force \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
           /usr/local/lib/node_modules/corepack /usr/local/bin/corepack \
           /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg

# Take only the compiled output from the build stage.
COPY --from=build /app/dist ./dist

# Don't run as root: the official Node image ships a non-root user called "node".
USER node

# Documentation only: the port the service listens on (config default 4000).
EXPOSE 4000

CMD ["node", "dist/index.js"]