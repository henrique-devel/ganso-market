---
id: G2-12.1
macro: G2-12
rfc: RFC-053
section: S2
depends_on: [G2-11.1]
authorization: continuous-with-operational-gates
tracking: docs/roadmap/GANSO_2_EXECUTION_STATE.md
---

# G2-12.1 — Fechar a solução de capacidade e custo

Execute somente esta sessão. Leia o [protocolo](00-protocolo.md), o contrato comum e a [seção S2 da RFC-053](../../docs/rfcs/RFC-053-ganso-2-prontidao-operacional.md#s2), e sua linha no [estado único](../../docs/roadmap/GANSO_2_EXECUTION_STATE.md). Consulte o [roadmap](../../docs/roadmap/GANSO_2_OPERATIONAL_ROADMAP.md) somente para dependência ou decisão concreta. Não reler todo o histórico.

## Entrega

Plano executável de armazenamento/CPU para 7, 30 e 90 dias, com decisões externas claramente separadas.

Medir corpus protegido, raw, índices/TOAST, WAL, temporários, crescimento por classe, CPU/cgroup e latência sem ensaio pesado em produção. Separar limites worker, quotas SQL e disco físico. Projetar cenários normal/pico e overhead de equity/replay/Jev. Quantificar o conflito entre HOLD, cerca de 20h históricas de folga de coleta e metas de 25% mínimo + reserva, 40% no lançamento e 90 dias. Priorizar redução de volume futuro e consultas dentro do host atual. Verificar custo recorrente real com informações disponíveis; ausência de fatura fica desconhecida. Se nenhuma solução preservar dados e cumprir metas, preparar alternativas concretas com bytes/custo/risco e pedir somente a decisão realmente ausente; não reduzir os critérios para caber.

## Contexto de código

- `docs/runbooks/btc-collector.md`
- `docs/runbooks/single-server.md`
- `docs/runbooks/ganso-2-data-map.md`
- `apps/api/src/storage/btc-marketstore.ts`
- `apps/api/src/storage/btc-retention.ts`
- `deploy/capacity_series.py`

Os caminhos são pontos de entrada, não autorização para refatorar tudo. Localize a versão atual antes de inferir ausência; leia 3–6 arquivos relevantes e amplie somente por necessidade demonstrada.

## Validação

Cálculos reproduzíveis por classe com unidades e intervalo; diferenciar lógico/físico, taxa curta/projeção e CPU do host/cgroup. Mostrar por que a alternativa escolhida cabe ou onde falha. Não prometer economia por preço de tabela ou por desligar servidor sem cancelar cobrança.

Execute testes proporcionais e checks obrigatórios. SQL financeiro usa PostgreSQL descartável; fixtures não comprovam produção, estabilidade ou desempenho econômico.

## Entrega e limites operacionais

Documental. Nenhum descarte, compressão destrutiva, mudança de HOLD, quota, host ou contratação. Falta de decisão externa não impede código independente.

A autorização contínua cobre código → PR → correções/checks → merge → implantação aplicável desta sessão, sem nova confirmação por etapa. Compra, consumo pago ainda não coberto, descarte delimitado, capital e mudança de perímetro dependem da autorização específica aplicável. Prepare o resultado concreto antes de solicitar apenas o que faltar. Criar este prompt não executou nem ativou seu conteúdo.

## Encerramento

Atualize a linha **G2-12.1** no acompanhamento: status, PR/SHA quando houver, validação resumida e deploy/pendência. Atualize o resumo/próxima sessão se necessário; sem recibo ou dossiê obrigatório. Diferencie código pronto, ativação realizada e aceite observado. Não classifique ativação faltante como concluída por haver código. Pare nesta fatia; não inicie outra sessão, agente ou automação.
