---
id: DATA-04
rfc: RFC-041
depends_on: [DATA-03]
mode: code
---
# DATA-04 — Implementar executor limitado com retomada e drift

Siga `prompts/roadmap/btc/00-protocolo.md`. Consulte em
`docs/roadmap/BTC_EXECUTION_STATE.md` somente este bloco e suas dependências.
Um bloco por contexto; não carregar o diagnóstico ou handoff histórico inteiro.

## Objetivo

Entregar executor testado em fixture que aplica somente um manifesto elegível,
com efeitos auditáveis e retomada idempotente; não executar em produção.

## Leitura mínima

- `docs/rfcs/RFC-041-limpeza-retencao-e-capacidade.md` — execução limitada.
- `apps/api/src/polymarket/retention.ts` — createRetentionJob / batches e coverage.
- `apps/api/src/database.ts` — transaction / SqlExecutor.
- `apps/api/test/polymarket/retention.test.ts` — retries e cortes.
- `migrations/0013_retention_time_indexes.sql` — índice do predicado temporal.
- `migrations/0005_polymarket_data_foundation.sql` — polymarket_retention_log.

Abra os símbolos/seções indicados; paths de saída novos são propostos.

## Escopo e limites

Consumir contratos DATA-02/03. Antes de iniciar e cada lote, revalidar schema,
policy, validade, pins/referências novas, coverage e watermark dentro da transação
do lote, sob lock/serialização compartilhado com escritores até commit. Drift
invalida manifesto; novas linhas não ampliam escopo. DELETE keyset com índice,
limite de linhas/bytes/tempo, transação curta e timeouts explícitos. Cursor/evento
atômicos, retries finitos e pausa por lag/I/O. Não usar OFFSET crescente, cutoff
relativo a now() ou TRUNCATE. Fecho protected permanece intocável. Comandos reais
são somente parte do plano futuro coberto pela autorização vigente; não disparar
rotina automática ao instalar ferramenta.

## Aceite e verificação

- Crash entre lotes e reinício produzem mesmo conjunto final sem evento duplicado.
- Timeout/lock retry é limitado; cursor não pula linhas não removidas.
- Pin/referência criado entre SELECT e DELETE coordena bloqueio/aborto sem perda;
  drift/certificado errado/manifesto vencido interrompem execução.
- Empates de timestamp usam chave estável; dado após watermark fica intacto.
- Testes PostgreSQL reais cobrem atomicidade, FK e dry-run/execução equivalentes.

## Fim e handoff

Registrar CLI/API proposta, limites seguros, ponto de retomada e evidência;
DATA-05 recebe plano de aplicação e manutenção. Não confundir executor testado
com limpeza feita nem DELETE com bytes devolvidos ao filesystem.
