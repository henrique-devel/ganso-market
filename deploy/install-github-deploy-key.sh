#!/bin/sh
set -eu

PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

if [ "$(id -u)" -ne 0 ]; then
  echo "execute como root: sudo $0 CAMINHO_DA_CHAVE_PUBLICA" >&2
  exit 1
fi
if [ "$#" -ne 1 ]; then
  echo "uso: $0 CAMINHO_DA_CHAVE_PUBLICA" >&2
  exit 1
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
secret_scanner_source="$script_dir/../scripts/scan_secrets.py"
public_key_file=$1
marker=ganso-market-github-actions

[ -f "$secret_scanner_source" ] && [ ! -L "$secret_scanner_source" ] || {
  echo "scanner de secrets confiável ausente" >&2
  exit 1
}

[ -f "$public_key_file" ] && [ ! -L "$public_key_file" ] || {
  echo "a chave pública deve ser um arquivo regular" >&2
  exit 1
}
[ "$(awk 'NF { count += 1 } END { print count + 0 }' "$public_key_file")" -eq 1 ] || {
  echo "o arquivo deve conter exatamente uma chave pública" >&2
  exit 1
}

IFS=' ' read -r key_type key_blob key_comment < "$public_key_file"
[ "$key_type" = "ssh-ed25519" ] || {
  echo "use uma chave Ed25519 dedicada" >&2
  exit 1
}
[ -n "$key_blob" ] || {
  echo "chave pública vazia" >&2
  exit 1
}
case "$key_blob" in
  *[!A-Za-z0-9+/=]*)
    echo "chave pública inválida" >&2
    exit 1
    ;;
esac
ssh-keygen -l -f "$public_key_file" >/dev/null

for executable in docker flock make python3 rsync; do
  command -v "$executable" >/dev/null 2>&1 || {
    echo "dependência ausente no servidor: $executable" >&2
    exit 1
  }
done
[ -d /opt/ganso-market ] && [ ! -L /opt/ganso-market ] || {
  echo "checkout esperado ausente: /opt/ganso-market" >&2
  exit 1
}

sh -n "$script_dir/remote-deploy.sh"
python3 -m py_compile "$script_dir/validate_release.py" "$secret_scanner_source"
install -d -o root -g root -m 0755 /usr/local/lib/ganso-market
install -o root -g root -m 0755 \
  "$script_dir/remote-deploy.sh" \
  /usr/local/sbin/ganso-market-deploy
install -o root -g root -m 0644 \
  "$script_dir/validate_release.py" \
  /usr/local/lib/ganso-market/validate_release.py
install -o root -g root -m 0644 \
  "$secret_scanner_source" \
  /usr/local/lib/ganso-market/scan_secrets.py

install -d -o root -g root -m 0700 /root/.ssh
authorized_keys=/root/.ssh/authorized_keys
authorized_keys_tmp=$(mktemp /root/.ssh/authorized_keys.ganso-market.XXXXXX)
cleanup() {
  rm -f -- "$authorized_keys_tmp"
}
trap cleanup EXIT HUP INT TERM

if [ -f "$authorized_keys" ]; then
  awk -v marker="$marker" '$NF != marker { print }' "$authorized_keys" \
    > "$authorized_keys_tmp"
fi
printf 'restrict,command="/usr/local/sbin/ganso-market-deploy" %s %s %s\n' \
  "$key_type" \
  "$key_blob" \
  "$marker" \
  >> "$authorized_keys_tmp"
chown root:root "$authorized_keys_tmp"
chmod 0600 "$authorized_keys_tmp"
mv "$authorized_keys_tmp" "$authorized_keys"
trap - EXIT HUP INT TERM

fingerprint=$(ssh-keygen -E sha256 -lf "$public_key_file" | awk '{ print $2 }')
echo "chave restrita de deploy instalada: $fingerprint"
echo "o GitHub Actions só poderá executar o comando forçado de deploy"
