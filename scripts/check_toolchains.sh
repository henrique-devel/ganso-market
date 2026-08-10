#!/bin/sh
set -eu

missing=0
for tool in rustc cargo node npm python3 docker make curl; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "missing toolchain: $tool" >&2
    missing=1
  fi
done

if [ "$missing" -ne 0 ]; then
  exit 1
fi

rust_major="$(rustc --version | awk '{print $2}' | cut -d. -f1)"
rust_minor="$(rustc --version | awk '{print $2}' | cut -d. -f2)"
node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
python_minor="$(python3 -c 'import sys; print(sys.version_info.major * 100 + sys.version_info.minor)')"

if [ "$rust_major" -lt 1 ] || { [ "$rust_major" -eq 1 ] && [ "$rust_minor" -lt 96 ]; }; then
  echo "rustc 1.96+ is required" >&2
  exit 1
fi

if [ "$node_major" -lt 24 ] || [ "$node_major" -gt 26 ]; then
  echo "Node.js 24, 25, or 26 is required; containers use the pinned Node 24 LTS" >&2
  exit 1
fi

if [ "$python_minor" -lt 309 ]; then
  echo "Python 3.9+ is required; containers use pinned Python 3.13" >&2
  exit 1
fi

docker compose version >/dev/null
echo "toolchains verified"
