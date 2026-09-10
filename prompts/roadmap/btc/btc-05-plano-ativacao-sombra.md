---
id: BTC-05
rfc: RFC-039
depends_on: [BTC-04, OPS-04, FRESH-02, EXP-01]
mode: operation-plan
---

# BTC-05 — Preparar ativação e observar a sombra

Prepare rollout verificável do worker observacional. Siga `00-protocolo.md`.
Aplicação requer operação concreta coberta pela autorização vigente.

## Contexto mínimo

- `docs/rfcs/RFC-039-btc-horario-contrato-benchmark-worker.md`: decisões 4–7.
- `docs/runbooks/single-server.md`: sequência operacional existente.
- `deploy/remote-deploy.sh`: alvos de deploy.
- `docker-compose.yml`: serviços/configuração e volumes.
- `docs/roadmap/RECEIPT_TEMPLATE.md`: evidência operacional.

## Escopo fechado

1. Confira contratos/recibos dos predecessores, SHAs e manifesto EXP-01
   congelado antes de novos dados. Plano OPS-04 pronto não comprova coleta saudável.
2. Produza `docs/runbooks/btc-shadow-rollout.md` (novo): comandos, serviços,
   config/hash, migrações, pré-verificação, impacto, rollback e consultas de aceite.
3. Preserve default sombra e zero ordens. Dados próprios válidos permitem
   observar independentemente de FIN/gates de execução; registre seu estado.
4. Aplicar somente escopo operacional autorizado; depois observar avanço real
   de insumos/decisões, versões, gaps, cobertura e ausência de contaminação.
5. Registre separadamente plano pronto, aplicado, período observado e pendências.
   Plano ou teste com fixture não gera evidência prospectiva.

## Verificação necessária

- Release/config efetivos coincidem com artefatos previstos, se houve aplicação.
- Dados novos respeitam freeze e timestamps; decisões têm IDs verificáveis.
- Contagens de ordens/ledger da sombra continuam zero; gates principais intactos.
- Exclusão por dado inválido permanece localizada e não reinicia toda a amostra.

## Entrega

- Runbook completo e recibo com UTC, SHAs, consultas e contagens observadas.
- Estado distingue `code-verified` de `production-verified`; pendente fica explícito.
- EXP-02 só pode usar dados prospectivos com esse recibo operacional e manifesto.

## Limite do bloco

Sem paper, live ou redistribuição de capital. A criação destas RFCs não executa
o plano; autorização de leitura SSH não autoriza genericamente aplicação.
