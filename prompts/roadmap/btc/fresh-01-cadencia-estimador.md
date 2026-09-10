---
id: FRESH-01
rfc: RFC-030
depends_on: [DB-04]
mode: code
---
# FRESH-01 — Alinhar cadência BTC à validade atual da estimativa

Siga `prompts/roadmap/btc/00-protocolo.md`. Consulte em
`docs/roadmap/BTC_EXECUTION_STATE.md` somente este bloco e suas dependências.
Um bloco por contexto; não carregar o diagnóstico ou handoff histórico inteiro.

## Objetivo

Entregar ajuste de cadência BTC horário que caiba no TTL e na capacidade,
medindo envelhecimento separadamente de ausência de modelo ou feed.

## Leitura mínima

- `docs/rfcs/RFC-030-cadencia-estimador-e-ttl.md` — contrato e aceite.
- `apps/api/src/polymarket/fundamental/config.ts` — estimateCadenceMs / parseCadence.
- `apps/api/src/polymarket/fundamental/estimator.ts` — tentativas por bucket.
- `apps/api/src/polymarket/fundamental/runner.ts` — safeJob / createRunner.
- `apps/api/src/polymarket/portfolio/config.ts` — StalenessConfig.
- `apps/api/test/polymarket/fundamental/runner.test.ts` — agendamento.

Abra os símbolos/seções indicados; paths de saída novos são propostos.

## Escopo e limites

Ler baseline compacta DB-04; medir por bucket tentativas, estimativas válidas,
p95/p99 de ciclo e jitter. Ajustar somente configuração/agendamento necessário,
versionando mudança; TTL segue 300 s. Não ampliar universo, fórmula, gates ou
status shadow. Não fazer polling acumulativo em ciclo lento nem reciclar data de
observação de cache. Se capacidade ainda não demonstrada, produzir fixture e
relatório de insuficiência em vez de supor que reduzir todo intervalo é viável.
Arquivo config/fundamental.json é alvo existente adicional somente se alterado.

## Aceite e verificação

- Relógio falso testa fronteira dos buckets e tentativas sem estimativa.
- Ciclo lento não sobrepõe execução ou gera fila ilimitada.
- Reuso/reprocessamento de dado velho não renova validade.
- Meta: <10% de tempo BTC elegível bloqueado só por idade, em janela saudável datada.
- Rodar config/estimator/runner afetados e typecheck; publicar denominador real.

## Fim e handoff

Registrar valores escolhidos, capacidade, janela e pendências de medição. Não
confundir reduzir DATA_STALENESS com obter alpha; próxima etapa usa sinais válidos
sem alterar o gate financeiro.
