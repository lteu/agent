FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        dnsutils \
        git \
        jq \
        openssh-client \
        python3 \
        python3-pip \
        ripgrep \
        unzip \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 agent \
    && useradd --uid 10001 --gid 10001 --create-home --home-dir /home/agent agent

WORKDIR /opt/ai
COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi \
    && npm cache clean --force
COPY dist/cli.js ./dist/cli.js

USER agent
ENV HOME=/home/agent
ENTRYPOINT ["node", "/opt/ai/dist/cli.js"]
