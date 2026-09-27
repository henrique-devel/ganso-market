---
id: G2-14.4
macro: G2-14
rfc: RFC-053
section: S4
depends_on: [G2-14.3]
authorization: continuous-with-operational-gates
tracking: docs/roadmap/GANSO_2_EXECUTION_STATE.md
---

# G2-14.4 — Cobrir a janela completa sem truncar replay

Execute somente esta sessão. Leia o [protocolo](00-protocolo.md), o contrato comum e a [seção S4 da RFC-053](../../docs/rfcs/RFC-053-ganso-2-prontidao-operacional.md#s4), e sua linha no [estado único](../../docs/roadmap/GANSO_2_EXECUTION_STATE.md). Consulte o [roadmap](../../docs/roadmap/GANSO_2_OPERATIONAL_ROADMAP.md) somente para dependência ou decisão concreta. Não reler todo o histórico.

## Entrega

Export/replay limitado por lote cobre 2.880 janelas de 15 min e seus eventos sem perda ou dupla contagem.

Revalidar limites atuais (256 decisões, 4.096 eventos financeiros por artefato e limites de bytes/grafo). Entregar cortes paginados/chunks com identidade de dataset e snapshot estável, fronteiras e reconciliação global. Não somar percentuais/drawdowns por chunk; reconstruir estado e carregar picos necessários. Preservar dependências externas, funding tardio e respostas Jev originais sem chamadas novas. Proibir truncamento silencioso e export monolítico ilimitado. Validar retenção/pins e orçamento real do volume esperado; número de janelas não é número de observações independentes.

## Contexto de código

- `apps/api/src/storage/replay-dataset.ts`
- `apps/api/src/storage/replaystore.ts`
- `apps/api/src/btc-replay-cli.ts`
- `apps/api/src/storage/metrics.ts`
- `apps/api/test/trading/replay.pg.test.ts`
- `docs/contracts/btc-replay-dataset-v1.md`

Os caminhos são pontos de entrada, não autorização para refatorar tudo. Localize a versão atual antes de inferir ausência; leia 3–6 arquivos relevantes e amplie somente por necessidade demonstrada.

## Validação

Corpus descartável acima dos limites anteriores, páginas repetidas/faltantes/fora de ordem, mudança concorrente, restart de export e evento na fronteira. Resultado agregado coincide com fixture econômica independente e não duplica custo/ledger. Medir memória, SQL e tamanho máximo.

Execute testes proporcionais e checks obrigatórios. SQL financeiro usa PostgreSQL descartável; fixtures não comprovam produção, estabilidade ou desempenho econômico.

## Entrega e limites operacionais

Runner sob demanda e leitores compatíveis; não instalar replay contínuo pesado. Captura produtiva delimitada só quando capacidade permitir e sem alegar cobertura de dados inexistentes.

A autorização contínua cobre código → PR → correções/checks → merge → implantação aplicável desta sessão, sem nova confirmação por etapa. Compra, consumo pago ainda não coberto, descarte delimitado, capital e mudança de perímetro dependem da autorização específica aplicável. Prepare o resultado concreto antes de solicitar apenas o que faltar. Criar este prompt não executou nem ativou seu conteúdo.

## Encerramento

Atualize a linha **G2-14.4** no acompanhamento: status, PR/SHA quando houver, validação resumida e deploy/pendência. Atualize o resumo/próxima sessão se necessário; sem recibo ou dossiê obrigatório. Diferencie código pronto, ativação realizada e aceite observado. Não classifique ativação faltante como concluída por haver código. Pare nesta fatia; não inicie outra sessão, agente ou automação.
