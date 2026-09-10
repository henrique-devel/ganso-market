---
id: OPS-01
rfc: RFC-021
depends_on: []
mode: read-only
---
# OPS-01 — Inventariar a falha atual sem alterar o servidor

Siga `prompts/roadmap/btc/00-protocolo.md`. Consulte em
`docs/roadmap/BTC_EXECUTION_STATE.md` somente este bloco e suas dependências.
Um bloco por contexto; não carregar o diagnóstico ou handoff histórico inteiro.

## Objetivo

Produzir um diagnóstico operacional curto, datado e reproduzível, ligando a
última observação de cada feed à versão de código realmente em execução.

## Leitura mínima

- `docs/rfcs/RFC-021-silencio-do-feed-e-kill-switch.md` — emenda e D1–D3.
- `apps/api/src/polymarket/orchestrator.ts` — createOrchestrator / statusReport.
- `apps/api/src/polymarket/rtds.ts` — createRtdsRecorder.
- `apps/api/src/polymarket/paper/brokerstore.ts` — killSwitchTriggersTick.
- `docs/runbooks/single-server.md` — consulta de status e release.

Abra os símbolos/seções indicados; paths de saída novos são propostos.

## Escopo e limites

Consultar por SSH somente se já autorizado no contexto. Ler release por processo,
status/restarts e logs recentes delimitados; snapshots, deltas e RTDS têm relógios
separados. Usar limites e índices, sem COUNT global ou logs ilimitados. Correlacionar
lacunas, persistência, pools e engate/rearme. Separar conexão viva, frame recebido,
commit bem-sucedido e valor novo. Identificar D1/D2/D3 já presentes: não refazê-los.
Salvar evidência sanitizada em `docs/test-results/btc/OPS-01.md` (novo artefato).
Não reiniciar/rearmar, instalar extensão, fazer limpeza ou abrir live.

## Aceite e verificação

- Evidência contém UTC, SHA, janela e comandos de leitura sem credenciais.
- Tabela por feed identifica último dado, último erro e lacuna conhecida.
- Cada hipótese tem evidência favorável/contrária e um próximo teste limitado.
- Separar itens concluídos da RFC021 dos defeitos ainda reproduzíveis.

## Fim e handoff

Entregar diagnóstico e indicar o defeito exato para OPS-02/03/05. Se o servidor
não estiver acessível, registrar limite e concluir o mapa de código sem inventar
estado atual. Próximo bloco não exige reler logs ou diagnóstico completos.
