# Runbook — recorder Polymarket (dados públicos)

O recorder grava dados públicos da Polymarket (registry de mercados via Gamma e
snapshots top-of-book via WebSocket) no PostgreSQL local. É **somente leitura de
dados públicos**: não há autenticação de trading, wallet, ordens ou execução.

## O que ele faz

- Consulta a Gamma API, filtra o universo (crypto/macro/economics/weather,
  excluindo eleições) e faz upsert em `polymarket_markets` (regras versionadas).
- Assina o WebSocket de mercado dos token IDs selecionados, reconstrói o livro e
  grava snapshots top-10 em `polymarket_book_snapshots` a cada ~2–5 s por token
  (`source_ts` da origem + `received_at` local).
- Reconecta com atraso curto se o socket cair.

## Serviço e rede

- Serviço Compose `polymarket-recorder`, atrás do profile `polymarket` (não sobe
  com `make up` nem no smoke de CI).
- Reusa a imagem da API e roda `node apps/api/dist/polymarket-recorder.js`.
- Fica nas redes `backend` (para o PostgreSQL) e `edge` (egress de internet para
  as APIs públicas da Polymarket). **Não publica porta no host.**
- Envia `User-Agent`/`Origin` de navegador (o edge Cloudflare da Polymarket
  rejeita clientes sem eles).
- `mem_limit` 384 MiB; o orçamento agregado do Compose permanece abaixo de 4 GiB
  (validado por `scripts/check_compose_policy.py`, que conta o profile).

## Operar em desenvolvimento

```bash
make up            # sobe a base (postgres, migrate, api, web, nginx)
make recorder-up   # sobe o recorder Polymarket
make recorder-logs # acompanha os logs
make recorder-down # encerra o recorder
```

## Operar no servidor standalone

```bash
cd /opt/ganso-market
docker compose --env-file deploy/server.env --profile polymarket \
  up --build --detach polymarket-recorder
docker compose --env-file deploy/server.env --profile polymarket \
  logs --follow --tail 100 polymarket-recorder
```

## Verificar que está gravando

```bash
# dentro do container postgres (rede interna):
docker compose exec postgres psql -U ganso_market -d ganso_market -c \
  "SELECT count(*) FROM polymarket_markets;"
docker compose exec postgres psql -U ganso_market -d ganso_market -c \
  "SELECT token_id, received_at FROM polymarket_book_snapshots ORDER BY received_at DESC LIMIT 5;"
```

## Limites e pendências

- Retenção/TTL das tabelas Polymarket ainda não é automática (entra com o
  restante da RFC-007). Acompanhar o crescimento de `polymarket_book_snapshots`.
- Se o handshake do WebSocket for rejeitado (bloqueio de IP/Cloudflare), os logs
  mostram reconexões; validar egress e os cabeçalhos. As APIs e formatos podem
  mudar — verificar a documentação oficial antes de depender de campos novos.
- O recorder grava dados públicos; nada aqui executa ordens nem toca wallet.
