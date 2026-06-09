FROM node:22-alpine AS deps
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/daemon/package.json ./packages/daemon/package.json
COPY packages/context-engine/package.json ./packages/context-engine/package.json
RUN npm ci --workspace @viewportai/daemon --include-workspace-root=false

FROM node:22-alpine AS build
WORKDIR /repo
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/packages/daemon/node_modules ./packages/daemon/node_modules
COPY package.json package-lock.json tsconfig.json* ./
COPY packages/daemon ./packages/daemon
COPY packages/context-engine ./packages/context-engine
RUN npm run build -w @viewportai/daemon

FROM node:22-alpine AS runtime
WORKDIR /repo
ENV NODE_ENV=production
ENV PATH="/repo/node_modules/.bin:/repo/packages/daemon/node_modules/.bin:${PATH}"
RUN apk add --no-cache git openssh-client \
    && addgroup -S viewport \
    && adduser -S -G viewport -h /home/viewport viewport \
    && mkdir -p /home/viewport/.ssh /tmp/viewport-workspace \
    && chown -R viewport:viewport /home/viewport /tmp/viewport-workspace
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/packages/daemon/node_modules ./packages/daemon/node_modules
COPY --from=build /repo/packages/context-engine ./packages/context-engine
COPY --from=build /repo/packages/daemon/package.json ./packages/daemon/package.json
COPY --from=build /repo/packages/daemon/bin ./packages/daemon/bin
COPY --from=build /repo/packages/daemon/dist ./packages/daemon/dist
COPY --from=build /repo/packages/daemon/docs ./packages/daemon/docs
RUN chmod +x /repo/packages/daemon/bin/vpd.js && ln -sf /repo/packages/daemon/bin/vpd.js /usr/local/bin/vpd
USER viewport
ENV HOME=/home/viewport
EXPOSE 7070
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD wget -qO- "http://127.0.0.1:7070/health" >/dev/null || exit 1
CMD ["node", "packages/daemon/dist/index.js", "start", "--foreground", "--listen", "0.0.0.0:7070"]
