FROM node:22-bookworm-slim

ARG CLAUDE_CODE_VERSION=latest
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright

COPY deploy/ai-cc-apt-packages.txt /tmp/ai-cc-apt-packages.txt
COPY deploy/ai-cc-python-packages.txt /tmp/ai-cc-python-packages.txt

RUN apt-get update \
    && xargs -r apt-get install -y --no-install-recommends < /tmp/ai-cc-apt-packages.txt \
    && xargs -r python3 -m pip install --no-cache-dir --break-system-packages < /tmp/ai-cc-python-packages.txt \
    && python3 -m playwright install --with-deps chromium \
    && chmod -R a+rX "${PLAYWRIGHT_BROWSERS_PATH}" \
    && npm install --global "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    && npm cache clean --force \
    && rm -rf /var/lib/apt/lists/* /tmp/ai-cc-apt-packages.txt /tmp/ai-cc-python-packages.txt \
    && groupadd --gid 10001 agent \
    && useradd --uid 10001 --gid 10001 --create-home --home-dir /home/agent agent

COPY deploy/ai-cc-proxy.sh /usr/local/bin/ai-cc-proxy
COPY deploy/ai-cc-privoxy.conf /etc/privoxy/ai-cc.conf
RUN chmod 0755 /usr/local/bin/ai-cc-proxy

ENV HOME=/home/agent \
    USER=agent \
    LOGNAME=agent \
    HOSTNAME=claude-workspace \
    TZ=Etc/UTC \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PATH=/home/agent/.local/bin:$PATH \
    PIP_BREAK_SYSTEM_PACKAGES=1 \
    PIP_USER=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    DISABLE_TELEMETRY=1 \
    DISABLE_ERROR_REPORTING=1 \
    DISABLE_BUG_COMMAND=1 \
    DISABLE_AUTOUPDATER=1

WORKDIR /workspace
USER agent
ENTRYPOINT ["claude"]
