FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends git openssh-client ca-certificates bash \
    && rm -rf /var/lib/apt/lists/*

ENV NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_MAXSOCKETS=2 \
    NPM_CONFIG_LOGLEVEL=warn

RUN npm install -g @viewportai/daemon@0.25.11 --no-audit --no-fund --maxsockets=2 \
    && vpd --help >/tmp/vpd-help.txt

WORKDIR /workspace
