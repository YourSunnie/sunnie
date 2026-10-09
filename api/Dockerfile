# Sunnie's "computer" is this container: the server runs as root and drops to the unprivileged
# `sunnie` user for every command the agent runs, so the agent can use its machine freely
# without being able to read the server's secrets or database.
FROM node:24-bookworm-slim

# Tools the agent can expect to find on its machine.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash ca-certificates curl wget git jq ripgrep less procps unzip zip \
      python3 python3-pip python3-venv build-essential sqlite3 \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g pnpm@11.5.0

WORKDIR /opt/sunnie
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml* ./
RUN pnpm install --frozen-lockfile --prod

# The agent's web browser: Google Chrome (stable) from Google's own package, which pulls in the
# system libraries it needs. (The driver, playwright-core, came in with the dependencies above.)
# Xvfb is the virtual screen its window opens on. Rebuild the image to update Chrome.
# poppler-utils (pdftotext, pdftoppm) reads the PDFs in the user's Drive without an install first.
RUN curl -fsSL -o /tmp/chrome.deb \
      "https://dl.google.com/linux/direct/google-chrome-stable_current_$(dpkg --print-architecture).deb" \
 && apt-get update \
 && apt-get install -y --no-install-recommends /tmp/chrome.deb fonts-noto-color-emoji fonts-noto-cjk xvfb poppler-utils \
 && mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix \
 && rm -rf /tmp/chrome.deb /var/lib/apt/lists/* /etc/apt/sources.list.d/google-chrome.list \
 && google-chrome-stable --version && pdftotext -v

# A standalone package manager; environments and caches belong to the agent's persistent home.
# Pin both architecture-specific binaries to the upstream 2.9.0-0 release digests.
RUN set -eu; \
    case "$(dpkg --print-architecture)" in \
      amd64) platform=linux-64; checksum=366cd9cd8be14df1ab8ed50352a82111082a36686b2d389fdb79a92c3fafb3e3 ;; \
      arm64) platform=linux-aarch64; checksum=9f93b974adcb4d166996af969b6cd371287d1a3e52733704727884d9b74cb7a7 ;; \
      *) echo "Unsupported Micromamba architecture" >&2; exit 1 ;; \
    esac; \
    curl -fsSL --connect-timeout 20 --max-time 120 --retry 3 \
      -o /tmp/micromamba \
      "https://github.com/mamba-org/micromamba-releases/releases/download/2.9.0-0/micromamba-${platform}"; \
    printf '%s  /tmp/micromamba\n' "$checksum" | sha256sum -c -; \
    install -m 0755 /tmp/micromamba /usr/local/bin/micromamba; \
    rm /tmp/micromamba; \
    micromamba --version

COPY src ./src
COPY browser ./browser
COPY skills ./skills

# See browser/nosme.c: keeps Chrome's tabs from crashing on Apple-silicon hosts.
RUN gcc -shared -fPIC -O2 -o /usr/local/lib/sunnie-nosme.so browser/nosme.c -ldl

RUN useradd --create-home --home-dir /home/sunnie --shell /bin/bash sunnie \
 && mkdir -p /var/lib/sunnie && chmod 700 /var/lib/sunnie

ENV NODE_ENV=production \
    SUNNIE_HOME=/var/lib/sunnie \
    SUNNIE_WORKSPACE=/home/sunnie \
    SUNNIE_COMPUTER_USER=sunnie \
    SUNNIE_HOST=0.0.0.0 \
    SUNNIE_PORT=8787

# /var/lib/sunnie: database + config.json (root only). /home/sunnie: the agent's own files.
VOLUME ["/var/lib/sunnie", "/home/sunnie"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD curl -fsS http://127.0.0.1:8787/health || exit 1

CMD ["node", "src/index.ts"]
