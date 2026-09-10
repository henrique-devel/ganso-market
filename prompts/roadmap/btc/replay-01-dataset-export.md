---
id: REPLAY-01
rfc: RFC-032
depends_on: [BTC-02]
mode: code
---

# REPLAY-01 — Dataset verificável e contrato de preservação

Implemente exportador read-only e manifesto para replay; nenhuma poda.
Siga `00-protocolo.md`; use o contrato temporal entregue por `BTC-02`.

## Contexto mínimo

- `docs/rfcs/RFC-032-replay-carteira-finita-evidencia.md`: decisões 1–2.
- `apps/api/src/fast-backtest-cli.ts`: `loadMarkets` e loaders associados.
- `apps/api/src/polymarket/portfolio/sweepstore.ts`: `readOnlyPool`.
- `apps/api/src/polymarket/portfolio/replay.ts`: serialização de decisões.
- `apps/api/src/polymarket/retention.ts`: fronteiras existentes de retenção.

## Escopo fechado

1. Manifesto versionado: schema/hash, commit/config, contratos, mercados,
   intervalos/cutoff, fontes, custos, cobertura e exclusões.
   Reserve classe/procedência de sintéticos para integração central DATA-02.
2. Exporte eventos em páginas limitadas, com ordenação determinística e
   identidade estável. Preserve source/received e publicação de rótulos.
3. Inclua dados necessários a fila, profundidade, cancelamento e resolução;
   ausência explícita torna determinada análise indisponível, nunca inventada.
4. Publique contrato de pin por dataset/mercado/intervalo para DATA-03,
   incluindo fontes de proveniência e proteção de experimento ativo.
5. Valide checksum, reimportação e contagens. Fixtures pequenas no Git;
   datasets completos são artefatos separados, sem secrets.

## Verificação necessária

- Export/import preserva contagens e hash lógico apesar da paginação.
- Evento recebido depois do cutoff não entra como feature conhecida.
- Exportador não escreve no banco fonte e não altera retenção.
- Simule export incompleto: manifesto não pode indicar artefato verificado.

## Entrega

- Exportador e schema; exemplo verificável de dataset mínimo.
- Estado com contrato de pin para DATA-03 e loader para REPLAY-02.
- Lista explícita das análises impossíveis com dados históricos disponíveis.

## Limite do bloco

Não dependa de DATA-03 para exportar: DATA-03 consome este contrato.
Não podar, compactar produção ou falsificar timestamps ausentes em backfill.
