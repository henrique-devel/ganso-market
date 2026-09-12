# OPS-01 — inventário operacional e mapa local

Referência UTC: **2026-09-10T21:03:45Z**. RFC-021, emenda e D1–D3; dependências: nenhuma.
Estado: **code-verified — mapa local concluído; produção não verificada**.

## Evidência e limite de acesso

- Raiz confirmada: `/Users/kovi/Desktop/henrique/ganso-market/ganso-market`.
  SHA **`c528d5b0d74cc5cf8894ee953dd335df5f1e1b03`**, checkout inicialmente limpo.
  O repositório do diretório pai é distinto; suas alterações preexistentes foram preservadas.
- Consulta SSH coberta pelo [protocolo](../../../prompts/roadmap/btc/00-protocolo.md),
  mediante [registro de acesso](../../ops/SERVER_ACCESS.md), mas interrompida **antes de conectar**:
  Ed25519 esperada `SHA256:Qr1GY+n8sfQfQe6ZxHhHkUSZ3PzBtPAwkDQWnU/VV9Q`;
  entrada local `SHA256:u6gqFKW4wplj8HZSAI6UjF1Bt00FRNf1unAoWOVEO2k`.
  Isso prova divergência entre registro e `known_hosts`, não a identidade atual do servidor
  nem indisponibilidade de rede. Nenhuma chave foi substituída e nenhum SSH foi executado.
- Janela operacional: **não coletada**. Release, processos, restarts, logs, banco,
  pools e engate/rearme atuais permanecem desconhecidos. Não foram importadas observações históricas.

| Processo / vínculo com os feeds | SHA em execução, imagem, início e restarts |
| --- | --- |
| `polymarket-recorder`: CLOB snapshots/deltas e RTDS | Não observados; SHA local não comprova release |
| `polymarket-paper`: gatilho e ledger do kill switch | Não observados; pode divergir do recorder |

A marca por imagem vem de `apps/api/Dockerfile:23–26`, `/etc/ganso/release-sha`.
`deploy/release-sha` local contém `$Format:%H$`; `git archive` o expande via `.gitattributes`.
Ler somente `.deploy/current-sha` no host não provaria a versão de cada container.

## Última observação por série

**NV = não verificado em produção**, inclusive ausência de erro ou de lacuna.
Cada linha precisa ser vinculada à release do recorder acima, ainda desconhecida.

| Feed / série | Último dado persistido | Último erro | Lacuna conhecida nesta coleta |
| --- | --- | --- | --- |
| CLOB `polymarket_book_snapshots` (top) | NV: `received_at`, `source_ts` | NV: `BOOKPIPE_PERSIST_FAILED`, discriminado por `insert` | NV; silêncio não tem detector D1 local |
| CLOB `polymarket_book_deltas` | NV: `received_at`, `source_ts` | NV: `BOOKPIPE_PERSIST_FAILED` / overflow | NV; não participa do gatilho local |
| CLOB `polymarket_book_snapshots_full` | NV: timestamps e `reason` | NV: `BOOKPIPE_PERSIST_FAILED` | NV; anchor não comprova novidade do WS |
| RTDS `spot`, por símbolo | NV: `received_at`, `source_ts`, preço | NV: `RTDS_PERSIST_FAILED` | NV; sem detector de silêncio local |
| RTDS `twap30`, por símbolo | NV: mesmos campos | NV: mesmo erro, sem identificação da série no log raw | NV; gap de disconnect só é tentado na reconexão |
| RTDS `twap60`, por símbolo | NV: mesmos campos | NV: mesma limitação | NV; gap pode falhar junto do INSERT raw |
| RTDS `polymarket_rtds_1m` (derivada) | NV: `bucket_start`, `received_at`, `samples` | NV: `RTDS_1M_PERSIST_FAILED` por feed/símbolo | NV; bucket aberto não equivale a interrupção |

O universo RTDS configurado localmente contém BTC, ETH, SOL e XRP (`orchestrator.ts:38`).
A medição BTC deve distinguir `btcusdt` de `btc/usd`; não agregar os três feeds num único relógio.

## O que o código prova

Referências abaixo relativas a `apps/api/src/`, no SHA inspecionado.

| Camada | CLOB | RTDS |
| --- | --- | --- |
| Conexão viva | `polymarket/dualws.ts:230–250`: open, PING e filtro de PONG | `polymarket/rtds.ts:369–377,494–524`: estado privado, PING 5 s, PING/PONG ignorados |
| Frame recebido | `polymarket/orchestrator.ts:631–659`: heartbeat e fechamento de gap antes do parse; raw sem livro pode renovar frescor | `polymarket/rtds.ts:154–192,520–539`: ACK reconhecido pode conter zero amostras; STATUS só expõe unknown frames |
| Persistência concluída | `polymarket/bookpipe.ts:309–334,392–434`: query aguardada e contadores de sucesso; STATUS não carimba último commit | `polymarket/rtds.ts:414–448`: raw usa hora de recepção, lote perdido em falha; SELECT visível comprovaria persistência até a consulta |
| Valor novo | `polymarket/bookpipe.ts:674,740–758`: hash distingue livro repetido; anchor **full** regrava cache com tempo novo e `source_ts=null` | `polymarket/rtds.ts:534–539`: amostras entram sem dedupe por preço/timestamp; preço igual pode ser observação legítima |

Nenhum `received_at` é um timestamp exato de commit: no snapshot top é o default SQL;
nos deltas é o relógio de processamento (`bookpipe.ts:765–777`), no RTDS raw a recepção,
e no full o momento de gravação calculado. Fila atrasada pode afastar processamento de recepção.
Anchor periódico escreve **full**, não a série top usada pelo kill switch.
RTDS 1m fecha com amostra de minuto posterior ou parada (`rtds.ts:264–314,600–601`).

| Decisão RFC-021 | Resultado local e delta exato |
| --- | --- |
| D1 | **Ausente.** Sem `stream_silent`, `WS_STREAM_SILENT`, controle REST duplo ou seleção dos cinco tokens ativos. `orchestrator.ts:747–768` só abre o gap global por duas conexões caídas. OPS-02 deve cobrir silêncio após já ter recebido livro. |
| D2 | **Ausente.** `polymarket/paper/brokerstore.ts:2887–2899` lê apenas MAX de snapshots top; não lê deltas. `newest=null` não engata. Payload/log do engate contêm motivo, sem `series`/idades (`418–449`). |
| D3 | **Ausente.** Sem contador de 15 ticks, consulta de lacunas ou chamada automática de rearme. Rearme atual é manual, payload vazio (`brokerstore.ts:452–475`; `paper/api.ts:706`). A aprovação registrada continua válida. |

**Concluído e a preservar no código:** both-down; reconnect/resubscribe; guarda RFC-024
de primeiro livro ausente; retry único de deltas e fila de retry de evidência CLOB;
limiar de cinco minutos; engate/auditoria/cancelamentos atômicos; bloqueio de novas ordens,
perda diária e freeze de mercado por disputa UMA. São bases existentes, não entrega de D1–D3.
Nenhuma conclusão sobre implantação dessas bases foi possível.

## Hipóteses discrimináveis e próximos testes limitados

| Hipótese | Evidência favorável | Contrária / limite | Próximo teste |
| --- | --- | --- | --- |
| CLOB pode ficar mudo com sockets abertos sem gap | D1 ausente; heartbeat anterior ao parse | PONG é filtrado; proteção de primeiro livro já existe; incidente atual NV | OPS-02: fake sockets com primeiro livro, depois 121 s só PONG; repetir com raw desconhecido; exigir gap único, resubscribe, escalada após mais 120 s e fechamento por livro válido |
| Deltas stale podem coexistir com switch desengatado | Trigger só consulta top snapshots | Top stale ainda engata; full não entra na consulta; estado atual NV | OPS-03: snapshots frescos/deltas >5 min, inverso e ambos stale; exigir `series`/idades; incluir série vazia |
| Feed recuperado pode deixar `RECORDER_STALE` engatado indefinidamente | Nenhum rearme automático | Endpoint manual existe; motivo atual NV | OPS-03: 14 e 15 ticks de 60 s, reset por stale/gap, e motivos manual/perda/disputa sem rearme; verificar evento e log |
| RTDS vivo pode não produzir amostra nova nem gap | Sem watchdog; disconnect só vira gap ao reconectar; ACK pode ser vazio | Reconexão com close existe; preço constante não prova origem parada | OPS-05: PONG-only, ACK-only e timestamps repetidos em fake socket por 2 min; separar frame/amostra/commit/valor; 120 s é cenário de teste, não limiar RTDS aprovado |
| Persistência/pool explica parada simultânea ou falta de gaps | CLOB, RTDS e retention compartilham pool; raw RTDS e seu gap usam o mesmo banco, sem retry do gap | Pool recorder max=10, query/statement timeout=30 s; CLOB já tem retries; saturação atual NV | Fake DB rejeita raw e gap por dois ciclos e recupera; depois medir duas amostras operacionais separadas por 5 min, LIMIT 20 sessões e erros na mesma janela |
| Gatilho de risco pode perder cadência | `paper/runner.ts:425–435`: só roda após settlement resolver | Há exclusão de sobreposição e pool paper separado (max=2, 30 s); bloqueio atual NV | OPS-03: settlement rejeitado e pendente em dois ciclos de fake timer; observar execução do trigger |

`RTDS_GAP_RECORDED` é emitido antes de confirmar o INSERT (`rtds.ts:505–509`):
o log sozinho não prova lacuna persistida. Ausência de gap também não prova ausência de perda.

## Reprodução local executada

```sh
cd /Users/kovi/Desktop/henrique/ganso-market/ganso-market
git rev-parse --show-toplevel
git rev-parse HEAD
git status --short
date -u '+%Y-%m-%dT%H:%M:%SZ'
ssh-keygen -F 178.105.65.251 -f /Users/kovi/.ssh/known_hosts | ssh-keygen -E sha256 -lf -
npm run test --workspace @ganso-market/api -- test/polymarket/orchestrator.test.ts test/polymarket/rtds.test.ts test/polymarket/paper/brokerstore.test.ts
npm run test --workspace @ganso-market/api -- test/polymarket/dualws.test.ts test/polymarket/bookpipe.test.ts test/polymarket/quality.test.ts
```

Node `v26.4.0`, Vitest `4.1.10`, dependências já disponíveis. Primeira execução:
**120/120**, segunda **69/69**, seis arquivos; exit 0 em ambas, sem banco externo.
Execuções em 2026-09-10 aproximadamente **21:02:46–21:02:54Z**.
Erros/PONGs/horários dos cenários são fixtures/fake timers, **não logs de produção**.
Os 189 testes confirmam proteções existentes; não demonstram D1–D3 nem saúde operacional.

## Retomada operacional delimitada — preparada, não executada

Primeiro reconciliar a identidade do host por canal independente, conforme o registro de acesso.
Depois, usando a conexão já autorizada, colher UTC inicial/final e estas leituras:

```sh
date -u '+%Y-%m-%dT%H:%M:%SZ'
docker ps --filter label=com.docker.compose.project=ganso-market --format '{{.ID}} {{.Names}} {{.Status}}'
# Para cada ID retornado de recorder e paper, substitua ID pelo valor observado:
docker inspect --format '{{.Id}} {{.Image}} {{.State.Status}} {{.State.StartedAt}} {{.State.FinishedAt}} {{.RestartCount}} {{.State.OOMKilled}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' ID
docker exec ID cat /etc/ganso/release-sha
docker logs --timestamps --since 2026-09-10T20:48:45Z --until 2026-09-10T21:03:45Z --tail 300 ID
```

A janela de 15 min acima é proposta para esta referência UTC; fixar outra janela explicitamente
em nova coleta. Não usar `make server-logs` (segue indefinidamente). Sanitizar logs por campos
permitidos: UTC, reason_code, feed/symbol, insert, pg_code, contadores, series/idades e motivo;
não salvar payloads arbitrários, env ou credenciais. Último erro significa último **na amostra**.

No PostgreSQL, usar `BEGIN READ ONLY`, `SET LOCAL statement_timeout='5s'`,
`SET LOCAL lock_timeout='1s'`, timezone UTC e finalizar com `ROLLBACK`.
Confirmar índices reais por `pg_indexes` filtrado às tabelas abaixo e `LIMIT 30`;
usar `EXPLAIN` sem `ANALYZE` antes de leituras em tabelas de eventos.
Índices esperados no código: migrations `0005` e `0013`; aplicação em produção NV.

| Leitura SQL a reproduzir | Limite / índice esperado |
| --- | --- |
| `SELECT received_at,source_ts FROM polymarket_book_snapshots ORDER BY received_at DESC LIMIT 1;` e mesma consulta em `polymarket_book_deltas` | Índices `*_received_at_idx`; manter resultados separados |
| `SELECT received_at,source_ts,reason FROM polymarket_book_snapshots_full ORDER BY received_at DESC LIMIT 1;` | Índice temporal; não usar como saúde do livro |
| `SELECT received_at,source_ts,price FROM polymarket_rtds_prices WHERE feed='spot' AND symbol='btcusdt' ORDER BY received_at DESC LIMIT 20;` | Índice `(feed,symbol,received_at)`; repetir para spot `btc/usd` e twap30/twap60 `btc/usd`; últimos 20 não garantem encontrar a última mudança |
| `SELECT bucket_start,received_at,samples FROM polymarket_rtds_1m WHERE feed='spot' AND symbol='btcusdt' ORDER BY bucket_start DESC LIMIT 2;` | PK por feed/símbolo/bucket; repetir para os pares acima |
| `SELECT engaged,reason,engaged_at,rearmed_at,updated_at FROM paper_kill_switch WHERE kill_switch_id=1;` | PK singleton; relacionar com release do paper |

Gaps: para cada `source IN ('clob_ws','rtds','internal')`, buscar os últimos **100** por
`gap_start DESC` via índice `(source,gap_start)` e só então filtrar abertos; essa amostra
não prova inexistência de gap antigo aberto. Para ledger, buscar os últimos **100** eventos
com `received_at` na mesma janela de 15 min, depois filtrar engate/rearme e projetar apenas
UTC, motivo, `series`, idades, `mode` e `healthy_ticks`. Pool: `pg_stat_activity` filtrado
por `application_name` de recorder/paper, `LIMIT 20`, somente estado, waits e início;
não colher texto de queries. Isso mede sessões, não a fila de espera dentro do processo.
Sem índice/plano adequado, registrar limite; não criar índice nem recorrer a COUNT global.

## Handoff sem releitura integral

**OPS-02:** falta D1 após primeiro livro; reutilizar both-down, resync e guarda RFC-024.
**OPS-03:** faltam leitura de deltas/`series` e rearme condicionado de 15 ticks já aprovado;
preservar guardas e testar cadência após settlement. **OPS-05:** falta silêncio RTDS por
feed/símbolo, relógios separados e evidência que sobreviva à falha de persistência.
Antes de atribuir esses defeitos à produção, conferir a release de recorder e paper;
se divergirem desta base, comparar somente os símbolos citados. Nenhum bloco seguinte foi executado.
