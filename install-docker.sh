#!/usr/bin/env bash
set +x
set -euo pipefail

SUNNIE_REPO=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "$SUNNIE_REPO/scripts/install-common.sh"

if [[ ${1:-} == --help || ${1:-} == -h ]]; then
  echo 'Usage: bash install-docker.sh'
  echo 'Install Sunnie on Ubuntu with Docker Compose. Requests sudo if needed.'
  exit 0
fi
[[ $# == 0 ]] || fail 'This installer takes no arguments; use --help.'
require_root "$SUNNIE_REPO/install-docker.sh" "$@"
prepare_install docker
# Explicitly use the VPS daemon, regardless of the invoking account's Docker context.
unset DOCKER_HOST DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH COMPOSE_FILE COMPOSE_PROJECT_NAME
export DOCKER_CONFIG="$INSTALL_TMP/docker-config"
install -d -m 0700 "$DOCKER_CONFIG"

apt-get update
apt-get install -y --no-install-recommends ca-certificates curl openssl

if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1 || ! docker buildx version >/dev/null 2>&1; then
  # Do not remove another application's container runtime to install ours.
  for package in docker.io docker-compose docker-compose-v2 docker-doc docker-buildx podman-docker containerd runc; do
    if dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -qx 'install ok installed'; then
      fail "Conflicting package $package is installed. Install Docker Engine and Compose first, then rerun."
    fi
  done
  cat > "$INSTALL_TMP/docker.sources" <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $UBUNTU_SUITE
Components: stable
Architectures: $INSTALL_ARCH
Signed-By: /etc/apt/keyrings/docker.asc
EOF
  for source_file in /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources; do
    if [[ -f $source_file ]] && grep -q 'download.docker.com' "$source_file"; then
      [[ $source_file == /etc/apt/sources.list.d/docker.sources ]] && cmp -s "$source_file" "$INSTALL_TMP/docker.sources" || \
        fail 'A different Docker apt source exists. Complete that Docker/Compose installation, then rerun.'
    fi
  done
  install -d -m 0755 /etc/apt/keyrings
  download "https://download.docker.com/linux/ubuntu/gpg" "$INSTALL_TMP/docker.asc"
  install -m 0644 "$INSTALL_TMP/docker.asc" /etc/apt/keyrings/docker.asc
  install -m 0644 "$INSTALL_TMP/docker.sources" /etc/apt/sources.list.d/docker.sources
  apt-get update
  apt-get install -y --no-install-recommends docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi

docker compose version >/dev/null 2>&1 || fail 'Docker is installed but Compose is missing. Install its Compose plugin, then rerun.'
docker buildx version >/dev/null 2>&1 || fail 'Docker is installed but Buildx is missing. Install its Buildx plugin, then rerun.'
systemctl enable --now docker.service
docker --host unix:///var/run/docker.sock info >/dev/null

write_credentials
[[ ! -e /opt/sunnie/docker || -L /opt/sunnie/docker ]] || fail '/opt/sunnie/docker must be an installer-managed symlink.'
install -d -m 0755 /opt/sunnie/releases
release=$(mktemp -d /opt/sunnie/releases/docker.XXXXXXXX)
chmod 0755 "$release"
copy_api "$release"
install -m 0644 "$SUNNIE_REPO/api/Dockerfile" "$SUNNIE_REPO/api/docker-compose.yml" \
  "$SUNNIE_REPO/api/.dockerignore" "$release/"
ln -s /etc/sunnie/sunnie.env "$release/.env"
ln -sfnT "$release" /opt/sunnie/docker
printf 'docker\n' > /etc/sunnie/install-mode

compose=(docker --host unix:///var/run/docker.sock compose --project-name sunnie-vps
  --project-directory /opt/sunnie/docker --file /opt/sunnie/docker/docker-compose.yml)
echo 'Building Sunnie (the first build downloads the browser and can take several minutes)...'
"${compose[@]}" build sunnie
"${compose[@]}" up -d --wait --wait-timeout 120 sunnie
wait_ready
print_connection
echo 'Logs: sudo docker compose -p sunnie-vps -f /opt/sunnie/docker/docker-compose.yml logs -f --tail 100'
echo 'Update: git pull, then run bash install-docker.sh again from your clone.'
echo 'Data: Docker volumes sunnie-vps_sunnie-data and sunnie-vps_sunnie-home.'
