# RFC-030 — Cadência do estimador compatível com a validade do sinal

**Status:** draft — especificação solicitada em 2026-09-10; não implementada por este documento.
**Prioridade:** após RFC-037; foco BTC horário. **Bloco:** FRESH-01.
**Dependências:** RFC-021 (coleta saudável), RFC-037 (capacidade medida).

## Problema e evidência

`fundamental/config.ts` admite cadências de 600 s nos horizontes longos, enquanto
`portfolio/config.ts` declara `estimateMaxAgeMs = 300000`. Diminuir o intervalo do
loop sem medir duração pode acumular trabalho; ampliar TTL pode esconder sinal
velho. Os números do diagnóstico são históricos e precisam de nova janela datada.

## Decisões propostas

1. Medir por horizonte e modelo: intervalo entre tentativas, entre estimativas
   válidas, p95/p99 de ciclo, atraso da fila, motivos de descarte e tempo em
   `DATA_STALENESS`. Separar ausência de modelo, feed ruim e envelhecimento.
2. No universo BTC horário elegível, escolher cadência que comporte p99 do ciclo
   mais jitter dentro do TTL vigente. Não alterar fórmula, status do modelo,
   universo nem limites de risco neste bloco.
3. Persistir a configuração com versão/hash e registrar o horizonte de validade.
   A idade é calculada a partir da observação/decisão original, nunca do horário
   de leitura do cache. Reprocessar dados antigos não renova validade.
4. Garantir uma execução por job, sem sobreposição ou fila ilimitada. Se a
   capacidade não comportar a cadência, expor atraso e reduzir o universo ativo
   de forma explícita; não converter `stale` em `fresh`.
5. Manter TTL de 300 s neste primeiro ajuste. Qualquer TTL diferente por horizonte
   exige resultado separado de sensibilidade com sinal e erro fora da amostra,
   seguido de mudança versionada do contrato; não é atalho implícito desta RFC.

## Resultado e aceite

O bloco entrega uma alteração estreita de cadência/configuração e um relatório
comparável antes/depois. Com coleta saudável, a meta operacional é menos de 10%
do tempo elegível BTC horário bloqueado **apenas** por idade da estimativa;
publicar denominador, janela, mercados distintos e intervalos sem cobertura.
A meta não equivale a comprovação de lucro.

Testes: relógio falso confirma limites entre horizontes, tentativa sem estimativa
não cria tempestade de retries, ciclo lento não sobrepõe outro, timestamps antigos
seguem expirados. Executar os testes do estimador/configuração afetados, typecheck
da API e as verificações requeridas pelo protocolo antes de integrar.

## Execução em contexto curto

Executar [FRESH-01](../../prompts/roadmap/btc/fresh-01-cadencia-estimador.md).
Ler apenas os símbolos indicados pelo prompt, o protocolo comum e o registro da
dependência; não carregar o diagnóstico inteiro ou todo o histórico de handoff.
Atualizar `docs/roadmap/BTC_EXECUTION_STATE.md` com medição, SHA e próximo bloco.

## Fora do escopo

Novos ativos, máquina local, tuning de alpha, alteração dos gates e produção live.
Se o orçamento de consulta ainda falhar, retornar a RFC-037 com a consulta exata,
em vez de compensar elevando TTL ou timeout global.
