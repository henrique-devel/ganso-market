#!/bin/sh
# RFC-024 — os logs do soak, no servidor. Somente leitura.
#
#   ssh -i ~/.ssh/id_ed25519 root@178.105.65.251 'sh -s' < scripts/rfc024/soak_logs.sh
#
# Criterio de parada da RFC: qualquer RETENTION_QUOTA_UNMET,
# RETENTION_QUOTA_NO_PROGRESS ou RETENTION_STEP_FAILED para
# polymarket_book_deltas => reverter o PR 2 e voltar ao proprietario.
set -eu
since=${1:-72h}
recorder=ganso-market-polymarket-recorder-1

echo "=== FAST_COVERAGE (ultimas 5 linhas) ==="
docker logs "$recorder" --since "$since" 2>&1 | grep '"FAST_COVERAGE"' | tail -5

echo
echo "=== FAST_COVERAGE: ciclos com serie entrando ==="
docker logs "$recorder" --since "$since" 2>&1 \
  | grep '"FAST_COVERAGE"' \
  | grep -c '"series_entered":[1-9]' || echo 0

echo
echo "=== SUBSCRIBE_BOOK_MISSING (contagem) ==="
docker logs "$recorder" --since "$since" 2>&1 | grep -c SUBSCRIBE_BOOK_MISSING || echo 0

echo
echo "=== PARADA: RETENTION_* de book_deltas (deve ser VAZIO) ==="
docker logs "$recorder" --since "$since" 2>&1 \
  | grep -E 'RETENTION_QUOTA_UNMET|RETENTION_QUOTA_NO_PROGRESS|RETENTION_STEP_FAILED' \
  | grep polymarket_book_deltas || echo "(vazio — ok)"

echo
echo "=== SERIES_COVERAGE_MISSING (estanca a poda daquele token) ==="
docker logs "$recorder" --since "$since" 2>&1 | grep -c SERIES_COVERAGE_MISSING || echo 0

echo
echo "=== SERIES_FETCH_FAILED (a serie nao respondeu) ==="
docker logs "$recorder" --since "$since" 2>&1 | grep -c SERIES_FETCH_FAILED || echo 0

echo
echo "=== release-sha ==="
for c in polymarket-recorder api; do
  printf '%s: ' "$c"
  docker exec "ganso-market-$c-1" cat /etc/ganso/release-sha 2>/dev/null || echo AUSENTE
done
