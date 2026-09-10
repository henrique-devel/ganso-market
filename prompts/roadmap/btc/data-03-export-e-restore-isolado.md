---
id: DATA-03
rfc: RFC-041
depends_on: [DATA-02]
mode: code
---
# DATA-03 — Verificar preservação antes de remover dados necessários

Siga `prompts/roadmap/btc/00-protocolo.md`. Consulte em
`docs/roadmap/BTC_EXECUTION_STATE.md` somente este bloco e suas dependências.
Um bloco por contexto; não carregar o diagnóstico ou handoff histórico inteiro.

## Objetivo

Entregar ferramenta e teste isolado que comprovem exportação/restauração do
recorte necessário à preservação, consumindo manifesto DATA-02.

## Leitura mínima

- `docs/rfcs/RFC-041-limpeza-retencao-e-capacidade.md` — arquivo e restauração.
- `apps/api/src/polymarket/retention.ts` — política/proteção existente.
- `migrations/0008_polymarket_paper_broker.sql` — fecho ledger/orders.
- `migrations/0014_polymarket_portfolio_engine.sql` — versões/decisões.
- `apps/api/test/polymarket/portfolio/integration.pg.test.ts` — banco isolado.
- `scripts/tests/test_migration_script.py` — execução controlada de SQL.

Abra os símbolos/seções indicados; paths de saída novos são propostos.

## Escopo e limites

Implementar export de allowlist/predicado/fecho estável, formato+schema, checksum,
contagens e limites de capacidade. Destino nunca é escolhido por varredura de
credenciais. Restore em banco isolado com integridade, reconciliação e replay de
fixture representativa. Evidência só libera manifesto correspondente e ainda
válido. Arquivo existente não prova restauração. Derivado regenerável exige fonte
retida e equivalência demonstrada. Registrar ausência histórica irrecuperável.
Novos scripts/testes têm nomes propostos no patch, sem tocar servidor. Não criar
backups ilimitados, fazer dump integral por conveniência ou remover origem.

## Aceite e verificação

- Export/restore de fixture mantém chaves, dependências, contagens e checksum.
- Corrupção, schema incompatível ou export parcial impedem certificado de restore.
- Sem espaço suficiente, reduzir/falhar antes de encher disco.
- Dataset raw necessário ao replay não é substituído só por agregado 1m.
- Teste usa instância isolada e nunca credenciais de produção.

## Fim e handoff

Registrar formato do certificado, destino configurável, limites/quota/expiração
e evidência de fixture; restore real ainda não testado fica explícito. DATA-04
consome certificado exato, sem presumir que toda história ainda existe.
