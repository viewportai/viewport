FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
COPY tests ./tests
COPY index.mjs ./
COPY eslint.config.mjs ./
RUN npm run build

FROM node:22-alpine AS runtime
LABEL org.opencontainers.image.source="https://github.com/viewportai/viewport"
LABEL org.opencontainers.image.description="Viewport relay service"
LABEL org.opencontainers.image.licenses="Apache-2.0"
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=7781
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json package-lock.json index.mjs ./
EXPOSE 7781
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD wget -qO- "http://127.0.0.1:${PORT}/health" >/dev/null || exit 1
USER node
CMD ["node", "dist/index.js"]
