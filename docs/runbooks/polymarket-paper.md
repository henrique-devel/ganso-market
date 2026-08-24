# Runbook — paper broker Polymarket (RFC-011)

**SIMULAÇÃO — SEM EXECUÇÃO REAL.** Este serviço nunca ganha auth de trading,
wallet, signer ou caminho de ordem real; o guard automatizado é
`apps/api/test/polymarket/paper/scope.test.ts` (roda no `make verify` e no CI),
incluindo padrões EIP-712 que o guard da RFC-010 não cobria.

## Estado desta revisão (fundação)

O serviço apenas boota, valida os guards e emite heartbeat. As features de
microestrutura, o validador/política de ordem, o simulador e o ledger chegam
nos próximos PRs da RFC-011 (ver a RFC para o plano de partes A–D).

- Entrypoint: `apps/api/src/polymarket-paper.ts` → módulo
  `apps/api/src/polymarket/paper/`.
- Boot exige `execution_mode = "paper"` (o runtime já falha fechado para
  modos desconhecidos; o runner recusa qualquer outro valor com
  `EXECUTION_MODE_NOT_PAPER`).
- Logs JSON com `service: "polymarket-paper"`: `PAPER_BOOT` (com o banner de
  simulação e `git_sha_known`), `PAPER_HEARTBEAT` a cada 60 s (`SELECT 1`),
  `PAPER_HEARTBEAT_FAILED` quando o banco não responde (nunca derruba o
  processo), `PAPER_STOPPED` no shutdown.

## Operação

```sh
make paper-up      # sobe (profile polymarket; requer migrate concluído)
make paper-logs    # acompanha os logs
make paper-down    # encerra
```

O deploy do CD **não troca a imagem dos containers de profile** (lição do
HANDOFF): após merge que altere este serviço, rodar no servidor

```sh
docker compose --env-file deploy/server.env --profile polymarket up --build --detach polymarket-paper
```

## Orçamento

- `mem_limit: 256m` (decisão do proprietário, 2026-08-23), com
  `--max-old-space-size=192`.
- O `model-worker` (stub) cedeu memória: 256 → **96 MiB**. Não 128: o cap do
  `check_compose_policy.py` é estrito (`< 4 GiB`) e com 128 o agregado
  cairia exatamente em 4 GiB. Agregado atual: 4064 MiB.
- Rede: somente `backend` (todo insumo já está no PostgreSQL); nenhuma porta
  publicada; endpoints futuros ficam atrás da auth da RFC-002 e fora do Nginx,
  como os das RFCs 007/010.
