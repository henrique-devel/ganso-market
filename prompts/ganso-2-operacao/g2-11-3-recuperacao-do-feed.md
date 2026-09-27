---
id: G2-11.3
macro: G2-11
rfc: RFC-053
section: S1
depends_on: [G2-11.1]
authorization: continuous-with-operational-gates
tracking: docs/roadmap/GANSO_2_EXECUTION_STATE.md
---

# G2-11.3 — Recuperar falhas transitórias sem inventar continuidade

Execute somente esta sessão. Leia o [protocolo](00-protocolo.md), o contrato comum e a [seção S1 da RFC-053](../../docs/rfcs/RFC-053-ganso-2-prontidao-operacional.md#s1), e sua linha no [estado único](../../docs/roadmap/GANSO_2_EXECUTION_STATE.md). Consulte o [roadmap](../../docs/roadmap/GANSO_2_OPERATIONAL_ROADMAP.md) somente para dependência ou decisão concreta. Não reler todo o histórico.

## Entrega

Feed suporta reconexões sustentáveis, com abstenção durante gaps e parada por falhas não recuperáveis.

Revisar orçamentos de reconexão por sessão e timeout HTTP que encerram uma captura longa após poucas falhas. Definir falhas transitórias versus terminais e recuperação com backoff limitado, jitter, orçamento por janela e revalidação. Não repetir escrita de resultado incerto. Disconnect, source stale e retorno do estado atual permanecem gaps; não preencher barras históricas nem trocar source timestamp por relógio local. Capacidade insuficiente, evidência inconsistente e identidade inválida continuam terminais. Não habilitar restart Docker irrestrito nem loop que contorne os guards.

## Contexto de código

- `apps/api/src/venues/hyperliquid/feed.ts`
- `apps/api/src/btc/context-poll.ts`
- `apps/api/src/btc/collector.ts`
- `apps/api/src/btc-worker.ts`
- `apps/api/test/btc-context-poll.test.ts`
- `docs/runbooks/btc-collector.md`

Os caminhos são pontos de entrada, não autorização para refatorar tudo. Localize a versão atual antes de inferir ausência; leia 3–6 arquivos relevantes e amplie somente por necessidade demonstrada.

## Validação

Relógio controlado: múltiplas desconexões espaçadas, rajada de falhas, resposta tardia, stop, overflow, limite de API e retomada parcial dos canais. Confirmar bloqueio de novos fills durante gap e continuidade da gestão de risco. Consultar documentação oficial vigente da venue ao alterar limites/protocolo.

Execute testes proporcionais e checks obrigatórios. SQL financeiro usa PostgreSQL descartável; fixtures não comprovam produção, estabilidade ou desempenho econômico.

## Entrega e limites operacionais

Entregar código e runbook; implantação seletiva não implica ativação. Retomada sustentada somente em G2-12.3 após capacidade admitida.

A autorização contínua cobre código → PR → correções/checks → merge → implantação aplicável desta sessão, sem nova confirmação por etapa. Compra, consumo pago ainda não coberto, descarte delimitado, capital e mudança de perímetro dependem da autorização específica aplicável. Prepare o resultado concreto antes de solicitar apenas o que faltar. Criar este prompt não executou nem ativou seu conteúdo.

## Encerramento

Atualize a linha **G2-11.3** no acompanhamento: status, PR/SHA quando houver, validação resumida e deploy/pendência. Atualize o resumo/próxima sessão se necessário; sem recibo ou dossiê obrigatório. Diferencie código pronto, ativação realizada e aceite observado. Não classifique ativação faltante como concluída por haver código. Pare nesta fatia; não inicie outra sessão, agente ou automação.
