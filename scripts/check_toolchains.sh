#!/bin/sh
set -eu

missing=0
for tool in node npm python3 docker make curl; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "missing toolchain: $tool" >&2
    missing=1
  fi
done

if [ "$missing" -ne 0 ]; then
  exit 1
fi

node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
python_minor="$(python3 -c 'import sys; print(sys.version_info.major * 100 + sys.version_info.minor)')"

if [ "$node_major" -lt 24 ] || [ "$node_major" -gt 26 ]; then
  echo "Node.js 24, 25, or 26 is required; containers use the pinned Node 24 LTS" >&2
  exit 1
fi

if [ "$python_minor" -lt 309 ]; then
  echo "Python 3.9+ is required for operational scripts" >&2
  exit 1
fi

docker compose version >/dev/null
echo "toolchains verified"
