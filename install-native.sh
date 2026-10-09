#!/usr/bin/env bash
set +x
set -euo pipefail

SUNNIE_REPO=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "$SUNNIE_REPO/scripts/install-common.sh"

if [[ ${1:-} == --help || ${1:-} == -h ]]; then
  echo 'Usage: bash install-native.sh [--user EXISTING_LINUX_USER]'
  echo 'Install Sunnie directly on Ubuntu with systemd. Requests sudo if needed.'
  echo 'Defaults to the invoking non-root user; root must pass --user.'
  exit 0
fi
require_root "$SUNNIE_REPO/install-native.sh" "$@"
agent_user=${SUDO_USER:-}
if [[ $# == 2 && $1 == --user ]]; then
  agent_user=$2
elif [[ $# != 0 ]]; then
  fail 'Use --user EXISTING_LINUX_USER, or --help.'
fi
[[ $agent_user =~ ^[a-z_][a-z0-9_-]*\$?$ ]] || fail 'Specify the existing Linux user with --user.'
agent_uid=$(id -u "$agent_user") || fail 'Create the Linux user before installing.'
[[ $agent_uid != 0 ]] || fail 'The agent must run as an unprivileged user.'
agent_home=$(getent passwd "$agent_user" | cut -d: -f6)
[[ $agent_home =~ ^/home/[a-zA-Z0-9._-]+$ && -d $agent_home && ! -L $agent_home ]] || fail 'Use a user with a regular home directory directly under /home.'
[[ $(stat -c %u "$agent_home") == "$agent_uid" ]] || fail 'The user must own its home directory.'
prepare_install native
if [[ -e /etc/systemd/system/sunnie.service && ! -f /etc/sunnie/install-mode ]]; then
  fail 'A pre-existing sunnie.service is not managed by this installer. Migrate it explicitly before installing.'
fi
if [[ -f /etc/sunnie/agent-user ]]; then
  [[ $(cat /etc/sunnie/agent-user) == "$agent_user" ]] || fail 'This native instance belongs to another user; rerun with that --user.'
fi
for program in node npm npx pnpm micromamba; do
  local_bin="$agent_home/.local/bin/$program"
  if [[ -e $local_bin || -L $local_bin ]]; then
    [[ -L $local_bin && $(readlink "$local_bin") == /opt/sunnie/runtimes/node.*/bin/"$program" ]] || \
      fail "$local_bin already exists and is not managed by this installer. Move it aside before installing."
  fi
done

apt-get update
apt-get install -y --no-install-recommends \
  bash ca-certificates curl wget git jq ripgrep less procps unzip zip xz-utils openssl \
  python3 python3-pip python3-venv build-essential sqlite3 xvfb fonts-noto-color-emoji fonts-noto-cjk poppler-utils

write_credentials

# Keep the runtime separate from any Node installation used by other applications.
case $INSTALL_ARCH in amd64) node_arch=x64 ;; arm64) node_arch=arm64 ;; esac
download https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt "$INSTALL_TMP/SHASUMS256.txt"
node_archive=$(awk -v arch="$node_arch" '$2 ~ "^node-v24\\.[0-9]+\\.[0-9]+-linux-" arch "\\.tar\\.xz$" {print $2}' "$INSTALL_TMP/SHASUMS256.txt")
[[ $node_archive =~ ^node-v24\.[0-9]+\.[0-9]+-linux-(x64|arm64)\.tar\.xz$ ]] || fail 'Could not select the Node 24 download.'
node_version=${node_archive#node-}
node_version=${node_version%-linux-*}
download "https://nodejs.org/dist/$node_version/$node_archive" "$INSTALL_TMP/$node_archive"
(cd "$INSTALL_TMP" && awk -v file="$node_archive" '$2 == file' SHASUMS256.txt | sha256sum -c -)
install -d -m 0755 /opt/sunnie/runtimes /opt/sunnie/releases
runtime=$(mktemp -d /opt/sunnie/runtimes/node.XXXXXXXX)
tar -xJf "$INSTALL_TMP/$node_archive" --strip-components=1 -C "$runtime"
chmod 0755 "$runtime"
export PATH="$runtime/bin:$PATH"

pnpm_spec=$(node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).packageManager' "$SUNNIE_REPO/api/package.json")
[[ $pnpm_spec =~ ^pnpm@[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail 'packageManager must pin a pnpm version.'
npm install --global --prefix "$runtime" --ignore-scripts --no-audit --no-fund "$pnpm_spec"
release=$(mktemp -d /opt/sunnie/releases/api.XXXXXXXX)
chmod 0755 "$release"
copy_api "$release"
(cd "$release" && CI=true pnpm install --prod --frozen-lockfile --ignore-scripts)
chown -R root:root "$runtime" "$release"
chmod -R go-w "$runtime" "$release"

if ! command -v google-chrome-stable >/dev/null; then
  download "https://dl.google.com/linux/direct/google-chrome-stable_current_${INSTALL_ARCH}.deb" "$INSTALL_TMP/chrome.deb"
  apt-get install -y --no-install-recommends "$INSTALL_TMP/chrome.deb"
fi
install -d -m 1777 /tmp/.X11-unix
gcc -shared -fPIC -O2 -o "$INSTALL_TMP/sunnie-nosme.so" "$release/browser/nosme.c" -ldl
install -m 0755 "$INSTALL_TMP/sunnie-nosme.so" /usr/local/lib/sunnie-nosme.so

# Match the existing Docker computer's package manager and verified release digests.
case $INSTALL_ARCH in
  amd64) mamba_platform=linux-64; mamba_sha=366cd9cd8be14df1ab8ed50352a82111082a36686b2d389fdb79a92c3fafb3e3 ;;
  arm64) mamba_platform=linux-aarch64; mamba_sha=9f93b974adcb4d166996af969b6cd371287d1a3e52733704727884d9b74cb7a7 ;;
esac
download "https://github.com/mamba-org/micromamba-releases/releases/download/2.9.0-0/micromamba-$mamba_platform" "$INSTALL_TMP/micromamba"
printf '%s  %s\n' "$mamba_sha" "$INSTALL_TMP/micromamba" | sha256sum -c -
install -m 0755 "$INSTALL_TMP/micromamba" "$runtime/bin/micromamba"

# Login profiles reset PATH. Supply agent tools via the local bin restored by LocalComputer.
# Do this as the agent user so user-controlled symlinks cannot cause root writes elsewhere.
runuser -u "$agent_user" -- mkdir -p "$agent_home/.local/bin"
for program in node npm npx pnpm micromamba; do
  runuser -u "$agent_user" -- ln -sfnT "$runtime/bin/$program" "$agent_home/.local/bin/$program"
done

install -d -m 0700 /var/lib/sunnie
cat > "$INSTALL_TMP/sunnie.service" <<EOF
[Unit]
Description=Sunnie personal agent
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=$release
ExecStart=$runtime/bin/node $release/src/index.ts
EnvironmentFile=/etc/sunnie/sunnie.env
Environment=NODE_ENV=production
Environment=SUNNIE_HOME=/var/lib/sunnie
Environment=SUNNIE_WORKSPACE=$agent_home
Environment=SUNNIE_COMPUTER_USER=$agent_user
Environment=SUNNIE_HOST=127.0.0.1
Environment=SUNNIE_PORT=8787
Environment=PATH=$runtime/bin:/usr/local/bin:/usr/bin:/bin
Restart=on-failure
RestartSec=5
TimeoutStopSec=45
KillMode=mixed
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF
install -m 0644 "$INSTALL_TMP/sunnie.service" /etc/systemd/system/sunnie.service
printf 'native\n' > /etc/sunnie/install-mode
printf '%s\n' "$agent_user" > /etc/sunnie/agent-user
systemctl daemon-reload
systemctl enable sunnie.service
systemctl restart sunnie.service
wait_ready
systemctl is-active --quiet sunnie.service || fail 'The service stopped. Inspect it with sudo journalctl -u sunnie.'
print_connection
echo 'Logs: sudo journalctl -u sunnie -f'
echo 'Restart: sudo systemctl restart sunnie'
echo 'Update: git pull, then rerun install-native.sh with the same user.'
echo "Data: /var/lib/sunnie; agent files: $agent_home (including Drive, skills, packages and browser profile)."
echo 'Previous code/runtime directories stay in /opt/sunnie/releases and /opt/sunnie/runtimes.'
