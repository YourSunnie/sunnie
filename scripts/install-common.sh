#!/usr/bin/env bash
# Shared by the two Ubuntu installers; sourcing this file performs no installation.

fail() {
  printf 'sunnie installer: %s\n' "$*" >&2
  exit 1
}

require_root() {
  [[ $(uname -s) == Linux ]] || fail 'Run this installer on the Ubuntu VPS.'
  if [[ $EUID != 0 ]]; then
    command -v sudo >/dev/null || fail 'Run this script as root, or install sudo and grant your login account access.'
    exec sudo -- bash "$@"
  fi
  # Privileged commands must never resolve through the agent's writable home.
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  umask 022
}

prepare_install() {
  local mode=$1
  [[ -r /etc/os-release ]] || fail 'Cannot identify this operating system.'
  source /etc/os-release
  [[ $ID == ubuntu ]] || fail 'These installers support Ubuntu only.'
  case $VERSION_ID in
    22.04|24.04|26.04) ;;
    *) fail 'Use Ubuntu 22.04, 24.04, or 26.04 LTS.' ;;
  esac
  UBUNTU_SUITE=${UBUNTU_CODENAME:-$VERSION_CODENAME}
  INSTALL_ARCH=$(dpkg --print-architecture)
  case $INSTALL_ARCH in
    amd64|arm64) ;;
    *) fail 'Sunnie requires an amd64 or arm64 VPS.' ;;
  esac
  [[ -d /run/systemd/system ]] || fail 'A running systemd is required for startup after reboot.'
  [[ -f $SUNNIE_REPO/api/src/index.ts ]] || fail 'Run this script from a complete Sunnie clone.'
  exec 9>/run/lock/sunnie-install.lock
  flock -n 9 || fail 'Another Sunnie installer is running.'
  for directory in /etc/sunnie /opt/sunnie /var/lib/sunnie; do
    [[ ! -L $directory ]] || fail "$directory must not be a symlink."
    if [[ -e $directory ]]; then
      [[ -d $directory && $(stat -c %u "$directory") == 0 ]] || fail "$directory must be a root-owned directory."
      [[ $(stat -c %a "$directory") =~ ^[0-7][0145][0145]$ ]] || fail "$directory must not be writable by group or others."
    fi
  done
  if [[ -f /etc/sunnie/install-mode ]]; then
    [[ $(cat /etc/sunnie/install-mode) == "$mode" ]] || fail 'The other install mode already owns this instance. Switching modes requires a deliberate data migration.'
  elif [[ -n $(ss -H -ltn 'sport = :8787') ]]; then
    fail 'Port 8787 is already in use. Stop or move that service before installing Sunnie.'
  fi
  install -d -m 0700 /etc/sunnie
  install -d -m 0755 /opt/sunnie
  INSTALL_TMP=$(mktemp -d /tmp/sunnie-install.XXXXXXXX)
  trap 'rm -rf -- "$INSTALL_TMP"' EXIT
  trap 'printf "Installation stopped at line %s. Fix the reported error and rerun the same installer; stored data is retained.\n" "$LINENO" >&2' ERR
}

download() {
  curl --fail --show-error --location --proto '=https' --proto-redir '=https' \
    --connect-timeout 20 --max-time 600 --retry 3 --output "$2" "$1"
}

create_credentials_file() {
  local destination=$1 provider_key=$2 model=$3 api_key
  [[ $provider_key =~ ^[a-zA-Z0-9._/-]+$ ]] || fail 'Enter a nonempty OpenRouter key with no spaces or quotes.'
  [[ -z $model || $model =~ ^[a-zA-Z0-9._:+/-]+/[a-zA-Z0-9._:+/-]+$ ]] || fail 'Use a provider/model spec with no spaces or quotes.'
  api_key=$(openssl rand -hex 32)
  [[ $api_key =~ ^[a-f0-9]{64}$ ]] || fail 'Could not generate an app access key.'
  (
    umask 077
    set -o noclobber
    {
      printf 'SUNNIE_API_KEY=%s\nOPENROUTER_API_KEY=%s\n' "$api_key" "$provider_key"
      if [[ -n $model ]]; then printf 'SUNNIE_MODEL=%s\n' "$model"; fi
    } > "$destination"
  )
}

read_api_key() {
  local key
  # This is a dotenv/systemd file, never executable shell input.
  key=$(sed -n 's/^SUNNIE_API_KEY=//p' "$1")
  [[ $key =~ ^[a-zA-Z0-9._/-]+$ ]] || fail 'Set SUNNIE_API_KEY to one nonempty, unquoted token in the credentials file.'
  printf '%s' "$key"
}

write_credentials() {
  local provider_key model
  if [[ -e /etc/sunnie/sunnie.env ]]; then
    [[ -f /etc/sunnie/sunnie.env && ! -L /etc/sunnie/sunnie.env ]] || fail 'The credentials file must be a regular file.'
    chown root:root /etc/sunnie/sunnie.env
    chmod 0600 /etc/sunnie/sunnie.env
    echo 'Keeping existing credentials in /etc/sunnie/sunnie.env.'
  else
    [[ -t 0 ]] || fail 'First installation is interactive; run it in a terminal to enter your OpenRouter key.'
    read -r -s -p 'OpenRouter API key: ' provider_key
    printf '\n'
    read -r -p 'Model spec (Enter for the repository default): ' model
    create_credentials_file "$INSTALL_TMP/sunnie.env" "$provider_key" "$model"
    install -m 0600 "$INSTALL_TMP/sunnie.env" /etc/sunnie/sunnie.env
    unset provider_key
  fi
  INSTALL_API_KEY=$(read_api_key /etc/sunnie/sunnie.env)
  # Both Compose and systemd let env files override deployment settings.
  if grep -Eq '^[[:space:]]*(export[[:space:]]+)?(SUNNIE_HOME|SUNNIE_WORKSPACE|SUNNIE_COMPUTER_USER|SUNNIE_HOST|SUNNIE_PORT|SUNNIE_CONFIG|PATH|NODE_OPTIONS)[[:space:]]*=' /etc/sunnie/sunnie.env; then
    fail 'Keep runtime/path/bind settings out of /etc/sunnie/sunnie.env; it is for credentials and model settings.'
  fi
}

copy_api() {
  local destination=$1
  # An explicit list excludes the clone's secrets, database, dependencies and local config.
  tar -C "$SUNNIE_REPO/api" -cf - src browser skills package.json pnpm-lock.yaml |
    tar -C "$destination" --no-same-owner -xf -
  [[ -z $(find "$destination" -type l -print -quit) ]] || fail 'Deployment source must not link back into writable files. Replace source symlinks with regular files.'
  chown -R root:root "$destination"
  chmod -R a+rX,go-w "$destination"
}

wait_ready() {
  local attempt
  for ((attempt = 0; attempt < 40; attempt++)); do
    if curl --silent --fail --noproxy '*' --max-time 2 --config - \
      http://127.0.0.1:8787/v1/info > "$INSTALL_TMP/info.json" <<EOF
header = "Authorization: Bearer $INSTALL_API_KEY"
EOF
    then
      return 0
    fi
    sleep 1
  done
  fail 'Sunnie did not accept an authenticated request within 120 seconds. Check its service/container logs; credentials and data have been retained.'
}

print_connection() {
  echo
  echo 'Sunnie is running at http://127.0.0.1:8787 and enabled for startup after reboot.'
  echo 'Point your HTTPS tunnel at http://127.0.0.1:8787, then enter its HTTPS URL in the iOS app.'
  echo "Read your app key: sudo sed -n 's/^SUNNIE_API_KEY=//p' /etc/sunnie/sunnie.env"
  echo 'Credentials: /etc/sunnie/sunnie.env (root only).'
  echo 'For an SSH tunnel from your laptop: ssh -N -L 8787:127.0.0.1:8787 USER@VPS'
}
