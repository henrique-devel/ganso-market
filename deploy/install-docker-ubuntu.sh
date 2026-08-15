#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "execute com sudo: sudo ./deploy/install-docker-ubuntu.sh" >&2
  exit 1
fi

if [ ! -r /etc/os-release ]; then
  echo "não foi possível identificar o sistema operacional" >&2
  exit 1
fi

. /etc/os-release
if [ "${ID:-}" != "ubuntu" ]; then
  echo "instalador suporta somente Ubuntu; sistema detectado: ${ID:-desconhecido}" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install --yes ca-certificates curl git make python3 rsync

if command -v docker >/dev/null 2>&1; then
  if ! docker compose version >/dev/null 2>&1; then
    echo "Docker existe, mas o plugin Compose não está disponível; corrija a instalação existente" >&2
    exit 1
  fi
  echo "Docker e Compose já estão instalados"
else
  ubuntu_codename="${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}"
  if [ -z "$ubuntu_codename" ]; then
    echo "não foi possível identificar o codename do Ubuntu" >&2
    exit 1
  fi

  install -m 0755 -d /etc/apt/keyrings
  curl --fail --silent --show-error --location \
    https://download.docker.com/linux/ubuntu/gpg \
    --output /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc

  architecture="$(dpkg --print-architecture)"
  printf '%s\n' \
    'Types: deb' \
    'URIs: https://download.docker.com/linux/ubuntu' \
    "Suites: $ubuntu_codename" \
    'Components: stable' \
    "Architectures: $architecture" \
    'Signed-By: /etc/apt/keyrings/docker.asc' \
    > /etc/apt/sources.list.d/docker.sources

  apt-get update
  apt-get install --yes \
    docker-ce \
    docker-ce-cli \
    containerd.io \
    docker-buildx-plugin \
    docker-compose-plugin
fi

systemctl enable --now docker
docker info >/dev/null
docker compose version

if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ]; then
  usermod --append --groups docker "$SUDO_USER"
  echo "usuário $SUDO_USER adicionado ao grupo docker; encerre e abra a sessão novamente"
fi

echo "servidor pronto para executar make server-up"
