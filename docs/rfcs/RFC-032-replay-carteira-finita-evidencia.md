# RFC-032 — Replay com carteira finita e evidência preservada

**Status:** draft — documentação solicitada em 2026-09-10; implementação e operação pendentes.
**Objetivo:** transformar observações em uma simulação que possa perder dinheiro, ficar sem capital e ser reproduzida.
**Dependências:** RFC-039 para benchmark BTC; RFC-038/034/022 para execução financeira; RFC-041 para retenção integrada.
**Prompts:** `REPLAY-01` → `REPLAY-02` → `REPLAY-03` → `REPLAY-04`.

## Problema e base existente

`portfolio/sourcereplay.ts` calcula contrafactuais por decisão; `fastbacktest.ts`
avalia braços e instantes. Nenhum resultado agregado pode representar automaticamente
uma carteira de US$1.000: decisões repetidas, capital simultâneo, fila e custos mudam o resultado.
Reutilizar loaders/serialização existentes quando adequados, mantendo os relatórios antigos identificados.

## Decisões

1. **Dataset imutável.** Manifesto contém ID/hash, schema, commit, configuração, estratégia,
   contratos, mercados, intervalos, timezone, cutoff, cobertura, fonte e versão de custos.
   Features incluem `source_ts` e `received_at`; livros, trades, rótulos e publicação de
   resolução preservam sua ordem temporal. Nenhuma feature usa evento recebido depois da decisão.
   Excluir ou classificar separadamente backfill sem recepção histórica verificável.
   Registrar exclusões, duplicatas e buracos; dados ausentes não viram zero.
   Manifesto reserva classificação/procedência de registros sintéticos conforme `DATA-02`;
   relatórios usam essa fonte central, sem excluir testes por constantes dispersas.
2. **Exportação e pin.** Exportador read-only com filtros e paginação limitada gera artefato,
   checksum, contagens e teste de reimportação. Manifesto declara relações/intervalos a preservar
   para `DATA-03` da RFC-041. O exportador não depende de poda; a poda depende de pin/export
   validado. Preservar também evidência dos experimentos ativos ainda sem export final.
   Ordem/ledger/configuração/rótulos necessários à reconciliação nunca são descartados como ruído.
3. **US$1.000 finitos por cenário alternativo.** Livro-caixa usa aritmética decimal exata e
   os contratos reconciliados da RFC-038. Identidade por execução, conta, estratégia e token.
   Braços da mesma carteira compartilham limite; cenários alternativos recebem cópias independentes
   dos mesmos US$1.000, sem somar seus lucros ou capital como portfólio realizável.
   Dinheiro disponível, reservado, posições, custos e equity reconciliam em cada evento.
   Não há refill automático, reutilização de colateral comprometido ou venda descoberta implícita.
4. **Relógio e execução.** Processar colocação, latência, fill parcial, cancelamento confirmado,
   expiração, saída e liquidação em ordem determinística. Desempate de timestamps é especificado.
   Só liberar reserva quando o evento permite; ordem aberta pode bloquear a seguinte.
   Maker exige evidência de execução condicional e fila conservadora; tocar o preço não basta
   para assumir fill integral. Taker usa profundidade e limite da ordem final.
   Taxas são versionadas por mercado/período e cobradas uma vez; taxa desconhecida invalida
   o resultado líquido ou entra em cenário explicitamente assumido, nunca como zero silencioso.
5. **Stress causal.** Reexecutar com piores filas, latência, profundidade, slippage, taxas e
   cenários de cauda. Recalcular fills, capital, PnL e estatística de cada cenário.
   Multiplicar todo PnL por 0,5 não é stress: reduz perdas e pode preservar o veredito.
   Testar monotonicidade de custos na mesma trajetória; não exigir que seleção alterada produza
   PnL agregado monotônico. Publicar todos os cenários, inclusive negativos.
6. **Relatório.** Separar oportunidades, ordens, fills, negócios encerrados e mercados independentes.
   Reportar caixa/equity, PnL realizado e não realizado, taxas, drawdown, capital bloqueado,
   uso de limite e retorno sobre capital. PnL de negociação é separado de incentivos observados.
   Custos fixos de infraestrutura são campo opcional conhecido/desconhecido; desconhecido não é zero.
   Comparar sinal e controle no mesmo universo elegível e justificar amostras não pareadas.
   IC usa mercados e blocos de dia; revisões estatísticas pertencem à RFC-033.

## Aceite por bloco

| Bloco | Evidência necessária |
| --- | --- |
| REPLAY-01 | Export/import conserva hash lógico, timestamps e contagens; contrato de pin publicado |
| REPLAY-02 | US$1.000 não financiam duas obrigações incompatíveis; restart e liquidação não duplicam PnL |
| REPLAY-03 | Duplicar ticks não dobra N/retorno; custos adicionais reduzem resultado na trajetória fixa |
| REPLAY-04 | Replay idêntico reproduz ledger/relatório; incentivos, custos e cobertura discriminados |

## Operação e reversão

CLI sem escrita no banco fonte e sem ordens reais. Persistência de resultados é separada,
versionada e identificada como simulação. Fixtures pequenas no Git; datasets grandes fora dele.
Nenhuma poda de produção é executada por esta RFC. O protocolo da RFC-041 governa recuperação
de espaço e restauração. Manter relatórios legados disponíveis; novos resultados não recalculam
silenciosamente evidência ou gates existentes.
