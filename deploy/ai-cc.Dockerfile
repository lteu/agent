FROM node:22-bookworm-slim

ARG CLAUDE_CODE_VERSION=latest

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        openssh-client \
        privoxy \
        python3 \
        python3-pip \
        python3-venv \
        python-is-python3 \
        ripgrep \
        vim-tiny \
    && python3 -m pip install --no-cache-dir --break-system-packages \
        beautifulsoup4 \
        httpx \
        ipython \
        lxml \
        matplotlib \
        numpy \
        openpyxl \
        pandas \
        pillow \
        pytest \
        python-dotenv \
        pyyaml \
        requests \
        scikit-learn \
        scipy \
        seaborn \
        tqdm \
        xlsxwriter \
    && npm install --global "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    && npm cache clean --force \
    && rm -rf /var/lib/apt/lists/* \
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
