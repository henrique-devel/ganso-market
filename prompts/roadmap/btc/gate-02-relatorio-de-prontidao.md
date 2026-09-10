---
id: GATE-02
rfc: RFC-040
depends_on: [GATE-01, EXP-03, EXEC-05]
mode: code
---

# GATE-02 — relatório separado de prontidão

Siga [00-protocolo.md](00-protocolo.md), sua linha e dependências no estado.

## Objetivo

Produzir relatório read-only que distingue operação, paper, proposta de experimento
e escala sem modificar os gates históricos ou criar grant de execução.

## Leitura mínima

- `docs/rfcs/RFC-040-experimento-btc-e-progressao-de-capital.md`: §§2–5.
- `docs/roadmap/BTC_MANDATE.md`: produzido por GATE-01; conferir recibo.
- `apps/api/src/polymarket/portfolio/gates.ts`: preservar legado.
- `apps/api/src/polymarket/portfolio/gatestore.ts`: leitura/persistência dos reports atuais.
- Artefatos e símbolos publicados nos recibos EXP-03 e EXEC-05, só o necessário
  para consumir a evidência versionada; não importar os relatórios inteiros.

## Escopo

Escolha o menor CLI/artefato read-only compatível com o relatório existente.
Contrato inclui estratégia/account, janela, hashes, fonte de cada requisito,
estado e motivo. `insufficient_evidence`, `failed`, `ready_for_review` e
`not_applicable` não podem se confundir. Campos ausentes não viram zero/aprovação.

Não adicionar UI ampla, POST, signer, botão de promover ou alteração de limites.
Se precisar schema novo, separe essa migração antes de misturar com apresentação.

## Aceite

Fixtures: lucro com ledger divergente falha técnico; N pequeno é insuficiente;
fees desconhecidas falham evidência econômica; versão divergente não se combina;
fonte não aplicável mantém justificativa. Os G1–G6 antigos ficam byte-equivalentes
nas mesmas entradas. Rode teste relevante e teste de ausência de caminho de escrita.

Feche recibo/estado; GATE-03 recebe o relatório e as limitações reais.
