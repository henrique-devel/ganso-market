# RFC-022 — ponte decisão→ordem, graça do runtime e saídas

Três PRs, tudo em SIMULAÇÃO. A RFC decide (D1–D4, P1–P3, testes, aceite); este
prompt remete. Origem: diagnóstico de 02–03/09/2026 (relatório linkado no cabeçalho da RFC-022).

## Contexto mínimo: leia só

1. `docs/rfcs/RFC-022-ponte-runtime-e-saidas.md` — inteira.
2. `apps/api/src/polymarket/paper/bridge.ts` — inteiro (396 linhas) e seu teste
   `apps/api/test/polymarket/paper/bridge.test.ts` (`aged_out` em ~l. 170–178).
3. `apps/api/src/polymarket/paper/runner.ts` — só ~l. 46–51 (`DEFAULT_BRIDGE_TICK_MS`),
   ~l. 291–320 (`bridgeTickOnce`; pulo `JOB_STILL_RUNNING` ~l. 297–300), ~l. 386 (`PAPER_BOOT`).
4. `apps/api/src/polymarket/paper/brokerstore.ts` — só ~l. 55–69 (graça), ~l. 575–690
   (aceite carimba geração), ~l. 1137–1150 (`interface ResolutionRuntimeSnapshot`),
   ~l. 1360 (`assertResolutionPolicyStillAuthorizesOrder`), ~l. 1392–1450
   (`loadLockedResolutionRuntime` e seu SELECT), ~l. 1451–1533 (`resolutionRuntimeFailure`),
   ~l. 1613 (`revalidateResolutionRuntimeForFill`; seis chamadas), ~l. 1810–1875
   (cancelamento com graça); teste `apps/api/test/polymarket/paper/brokerstore.test.ts`
   (procure `LAG_GRACE`).
5. `migrations/0011_resolution_runtime_safety.sql` ~l. 214–240 — colunas de
   `resolution_runtime_state`. Não altere.
6. `apps/api/src/polymarket/resolution/runner.ts` — só ~l. 255–320 (`markBooting`,
   `markFailed`, `bootGenerationUnlocked`), ~l. 425–435 (`stateTickUnlocked`),
   ~l. 1083–1092 (`JOB_FAILED`).
7. **Só se P1 = ordem:** `apps/api/src/polymarket/portfolio/decisionrow.ts` ~l. 155–215.
8. **Só se P1 = sinal:** `apps/web/src/dicionario.ts` ~l. 15–22 (`Verbete`), ~l. 180–186.
9. `git log --oneline -15`, topo de `docs/HANDOFF.md` (40 linhas) e `CHECKLIST PRÉ-LIVE`
   (~l. 215): algo já entregue? Estado do PR-0?

Outro arquivo só com o motivo anotado no HANDOFF.

## Autorização e regras permanentes

Valem as convenções de `prompts/roadmap/README.md` §"Convenções" (SSH, deploy em três
passos, `release-sha`). Banco por `psql` direto (a API tem `statement_timeout` de 1 s); em
`portfolio_decisions` só o carimbo de `paper_order_id`.

- Invariantes (idênticas nos prompts 11–21): paper-only; fail-closed; gates não afrouxam; GET-only — nenhum endpoint de escrita novo (o único POST é o rearme do kill switch já existente), painel nunca escreve em tabela de decisão; money em texto decimal, nunca `number`; migrations aplicadas não mudam, migration nova só pelo protocolo do CD (`infra/migrations/apply.sh`); regressão verificada **falhando no HEAD anterior**; **RE-MEDIR antes de codar** — premissa caída ⇒ PARE e registre no HANDOFF.

## Estado medido (02–03/09/2026; re-verifique)

| Premissa | Número | Origem |
| --- | --- | --- |
| Tick da ponte / frescor `decision_ts` | 30 s / 30 s | `paper/runner.ts:51`; `bridge.ts:41`, `:88–95` |
| Lag `received_at − decision_ts` (44 aceitas) | p50 12,9 s, p90 20,6 s, max 33,3 s | `psql` |
| Aceites → ordem (corte A; corte B 45/37 na RFC) | 8 de 44; 3 × 409; 33 nunca vistas | `paper_order_id IS NULL`; `BRIDGE_DECISION_SKIPPED` |
| `BRIDGE_TICK` | `considered: 0, aged_out: 36–39` | `docker logs polymarket-paper` |
| Cancelamentos pós-#52 | 5 `NOT_READY` + 2 `GENERATION_MISMATCH`, 0 `LAGGING`; 1 fill em 8 | `paper_orders.resolution_cancel_reason` |
| Rajada sem deploy | 5 `NOT_READY` às 22:07:15Z de 01/09 + 1 `MISMATCH` 1,6 s depois; 21 `input_changes` no mesmo segundo | journal do host |
| Rotação em processo | `JOB_FAILED` 15:01:16Z → geração nova 15:01:31Z (02/09), sem restart; `started_at`/`updated_at` rescritos | `resolution/runner.ts:272`, `:284`, `:302`, `:313–316` |
| Saídas | 242 `EXIT ACCEPTED`, 242 sem ordem; `sizeShares: null` | `exitstore.ts:349` único leitor; `decisionrow.ts:204` |

Re-medir (`psql`, 24 h): lag das aceitas; `grep BRIDGE_TICK` (5 min); `paper_orders` por
`status, resolution_cancel_reason`; `EXIT ACCEPTED` sem `paper_order_id`.

## Escopo

**PR-1 — ponte (D1; depende de P3).** `PENDING_SQL`/`AGED_OUT_SQL` filtram por
`received_at > now − 60 s` (`MAX_RECEIVED_AGE_MS`, dois ticks) **e** `decision_ts > now −
90 s` (`MAX_DECISION_TS_AGE_MS`). Runner passa `bootAt` nas deps de `bridgeTick`; `aged_out`
conta só `received_at > bootAt`; `BRIDGE_TICK` ganha `boot_at`. `MAX_BOOK_AGE_MS` intocado.
Testes da RFC, incluindo "tick pulado uma vez". Rebuild: `polymarket-paper`.

**PR-2 — runtime (D2 + D3; D2 depende de P2).** Graça de 180 s para `NOT_READY` e
`GENERATION_MISMATCH` com **âncora monotônica** (RFC D2): primeiro instante em que o paper
viu ESTA ordem sob runtime falho, por `order_id` na memória do worker, mais teto duro
`ready_at IS NULL` por > 180 s mesmo com geração trocada (nunca `updated_at`/`started_at`:
rescritos a cada rotação, fail-open). `ResolutionRuntimeSnapshot` e o SELECT de
`loadLockedResolutionRuntime` ganham `ready_at`, `started_at`, `updated_at`,
`failure_reason`. O cancelamento pós-graça grava **`age_ms` e `grace_ms`** em
`resolution_cancel_details_json` (novas; sem elas o aceite passa por vazio). Adoção, logs, motivos sem graça, fills estritos: como na RFC.
`bootGenerationUnlocked` loga `RESOLUTION_GENERATION_ROTATED` com `failure_reason`. Sem
migration. Teste obrigatório: runtime alternando boot/falha a cada 20 s por 200 s →
cancela. Rebuild: `polymarket-paper` **e** `polymarket-resolution`.

**PR-3 — saídas (D4; depende de P1).** A: seletor de `EXIT` na ponte (RFC D4-A),
reutilizando `conservativeBound`; rebuild `polymarket-paper`. B: `consequencia` em
`TIPO_DECISAO.EXIT` e registro no HANDOFF; toca `apps/web`: rebuild/redeploy da imagem
`web` (não é de profile) e bundle novo conferido com hard reload — login in-app não
recarrega o SPA (lição de 31/08). Nunca os dois; nunca FAK.

Fora do escopo: FAK/taker (`taker_fee_bps` NULL em 1.195/1.195; RFC-028), disjuntor
`PARAM_CHANGE` (RFC-025), liquidação (PR-0 b, prompt 11 — sem ele fechamentos não medem),
rearme do kill switch.

## Verificação (produção, kill switch desarmado, 7 dias)

Tabela completa na RFC-022 §"Critérios de aceite". Números-alvo:

| Alvo | Consulta |
| --- | --- |
| `BRIDGE_TICK` com `aged_out ≈ 0` e `considered > 0` quando há aceite | `docker logs polymarket-paper \| grep BRIDGE_TICK` |
| ≥ 80 % das `ENTRY ACCEPTED` (fora kill switch) com `paper_order_id` | `portfolio_decisions LEFT JOIN paper_orders USING (decision_id) WHERE received_at > boot` |
| 0 cancelamentos `NOT_READY`/`MISMATCH` com `age_ms < 180000`; `age_ms` não nulo em 100 % | `resolution_cancel_details_json->>'age_ms'` (gravado pelo PR-2) |

## Entregável

Por PR: `make verify` verde, regressão vista falhando antes, `release-sha` nos containers
reconstruídos (PR-1/3-A: `paper`; PR-2: `paper` e `resolution`; PR-3-B: bundle `web` novo
no navegador), números-alvo reais. HANDOFF: premissas re-medidas, P1–P3 respondidas,
contagem de 7 dias de `RESOLUTION_GENERATION_ROTATED` por `failure_reason`. README do
roadmap, tabela "Ordem e status": linha 14 (atualize-a; crie-a se faltar).

## Condições de parada

- Ponte já vê aceites no HEAD (`aged_out = 0`, `considered > 0`).
- PR pedir gate, kill switch, `caps.*`, config versionada ou migration aplicada; fill
  precisar de graça; âncora depender de carimbo que o runtime rescreve.
- P1 sem resposta: PR-3 não começa. P2 sem resposta: PR-2 entrega só a D3.
- `make verify` vermelho ou regressão que passa no código anterior.
