# Escopo do paper broker (RFC-011) — ausência de execução real

**SIMULAÇÃO — SEM EXECUÇÃO REAL.** Este documento é a declaração explícita
exigida pela tarefa 10 da RFC-011: o módulo `apps/api/src/polymarket/paper/`
simula execução contra dados públicos gravados pelo recorder (RFC-007) e
**não contém nenhum caminho de execução real** — nem desarmado, nem atrás de
flag.

## O que o módulo NÃO tem, e como isso é garantido

- **Nenhuma** autenticação CLOB L1/L2 de trading, API key/secret/passphrase,
  wallet, signer, private key, seed, approve de token ou chamada a
  `POST /order` da CLOB.
- **Nenhum** struct EIP-712 de ordem (`signTypedData`, `EIP712Domain`,
  `verifyingContract`, `*_TypedData`) — padrões que o guard da RFC-010 não
  cobria e este cobre.
- **Nenhuma** conexão de rede de saída: o módulo não importa `ws`, não abre
  `WebSocket` e não chama `fetch` — todo insumo já está no PostgreSQL.
- Escreve **somente** nas tabelas `paper_*` (lista fechada).

A verificação automática é
[`apps/api/test/polymarket/paper/scope.test.ts`](../../apps/api/test/polymarket/paper/scope.test.ts),
que varre todos os arquivos do módulo (comentários removidos) a cada
`make verify` e no CI (job "Verify source"). Qualquer violação futura falha o
build antes de poder ser mergeada.

## Guardas de runtime

- `execution_mode` do runtime aceita somente `paper` (fail-closed em
  TS/Rust/JSON Schema); o runner do paper broker recusa boot com qualquer
  outro valor (`EXECUTION_MODE_NOT_PAPER`) como última linha de defesa.
- Toda resposta da API do módulo carrega o banner
  `"SIMULAÇÃO — SEM EXECUÇÃO REAL"`.
- No banco: nenhuma ordem existe sem `limit_price`; nenhuma FAK/FOK sem
  `worst_price`; o ledger é append-only por trigger.

## Fronteira com a RFC-009

Execução real (assinatura de ordem, auth de trading, wallet burn na Polygon)
é escopo **exclusivo** da RFC-009, que só se inicia após os gates G1–G6 da
RFC-013 e aprovação explícita do proprietário. O track record que esses gates
leem é o ledger deste módulo — exclusivamente as colunas base conservadora e
estresse do relatório de performance; a coluna otimista é diagnóstica e
proibida em gates.
