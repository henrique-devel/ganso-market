# Handoff do projeto Ganso Market

- Última atualização: 2026-08-10
- Branch principal: `main`
- Modo permitido no runtime atual: `paper`

Este documento registra o ponto de continuidade entre sessões. Ele não
substitui a ordem de fontes de verdade: solicitação atual do proprietário,
`docs/PRD.md`, RFC ativa e somente depois código/configuração.

## Estado atual

- **FATO VERIFICADO:** RFC-001 implementada e verificada localmente.
- **FATO VERIFICADO:** runtime composto por PostgreSQL, market-engine Rust,
  API Fastify, web React/Vite, worker Python opcional e Nginx local.
- **FATO VERIFICADO:** somente Nginx publica porta, fixada em
  `127.0.0.1`; PostgreSQL, engine, worker e métricas permanecem internos.
- **FATO VERIFICADO:** auth, Yellowstone, modelos, estratégias, wallet,
  signer, ordens e execução não existem nesta entrega.
- **FATO VERIFICADO:** nenhum container está ativo; o volume local
  `ganso-market_postgres_data` está preservado.
- **FATO VERIFICADO:** existe uma alteração local anterior do proprietário em
  `prompts/AI_DEVELOPER_SYSTEM_PROMPT.md`. Ela não pertence à RFC-001 e não deve
  ser descartada, formatada ou incluída em outro commit sem decisão explícita.
- **BLOQUEIO/TODO:** não houve deploy ou teste operacional no Hetzner CPX42.

## Sequência de RFCs

| RFC | Estado de acompanhamento | Evidência/condição |
| --- | --- | --- |
| RFC-001 — Fundação e runtime | Implementada localmente | [`docs/test-results/RFC-001.md`](test-results/RFC-001.md) |
| RFC-002 — Auth e HTTPS por IP | Próxima candidata; não iniciada | Resolver HTTP público informado versus HTTPS obrigatório no PRD antes de publicar |
| RFC-003 — Yellowstone | Não iniciada | Não antecipar durante a RFC-002 |
| RFC-004 — Eventos e persistência | Não iniciada | Depende da RFC-003 |
| RFC-005 — Wallet, risco e signer | Não iniciada | Live continua proibido; depende das gates anteriores |
| RFC-006 — Paper e modelos | Não iniciada | Não existe simulador/modelo nesta fundação |
| RFC-007 — Polymarket paper | Não iniciada | Analytics/paper somente |
| RFC-008 — Execução beta Solana | Não iniciada | Proibida antes de todas as gates e aprovação explícita |

## Evidência mais recente

- `make verify`: sucesso; 94 testes TypeScript, 14 Rust e 16 Python,
  além de formatadores, linters, builds, scanner e política do Compose.
- `make integration`: sucesso com o volume preservado; 79.590.061 bytes
  agregados em seis containers.
- Smoke isolado com volume novo: sucesso; primeiro boot, migration,
  reaplicação idempotente, perda/recuperação do PostgreSQL e shutdown sem
  órfãos; 78.753.395 bytes agregados.
- Budget configurado: 2.684.354.560 bytes e 4 vCPU, incluindo worker opcional
  e migrador one-shot.
- Inventário determinístico: 289 dependências npm/Cargo de registro com
  versão e licença identificadas.

Os comandos e resultados completos estão em
[`docs/test-results/RFC-001.md`](test-results/RFC-001.md).

## Decisões e invariantes vigentes

1. `ExecutionMode` aceita exclusivamente `paper`.
2. Estratégia nunca acessa signer; nesta etapa sequer existe signer.
3. Secrets entram por arquivo montado. Private key e seed nunca usam env,
   Git, banco, logs, fixtures ou frontend.
4. Configuração falha fechada para modo/campo/arquivo desconhecido ou inválido.
5. Readiness depende de `SELECT 1`; liveness não mascara dependência ausente.
6. Money usa inteiro matemático exato: string decimal canônica na fronteira
   JSON e `bigint` internamente.
7. Logs de aplicação/access são JSON, têm correlation ID quando aplicável e
   não registram query string recebida.
8. `make down` e o smoke não removem volumes por padrão.
9. Nenhuma publicação HTTP externa é autorizada pela RFC-001.

## Decisões pendentes e riscos residuais

- **BLOQUEIO/TODO — exposição:** o contexto do proprietário menciona HTTP no
  IP público, enquanto o PRD exige HTTPS e reserva HTTP para ACME/redirect.
  Não publicar até o proprietário resolver o conflito.
- **BLOQUEIO/TODO — host:** CPU, RAM, SSD, arquitetura e toolchains do CPX42
  ainda não foram medidos/verificados por esta entrega.
- **RISCO:** não há backup externo automático, HA ou recuperação garantida do
  PostgreSQL, por decisão de escopo atual.
- **RISCO:** `ServiceHealth` é reproduzido manualmente entre linguagens; os
  schemas v1 são normativos, mas existe risco futuro de drift.
- **RISCO:** o market-engine tem endpoints testados, porém não possui
  `healthcheck` declarativo no Compose.
- **RISCO:** scanners de segredo são defesa em profundidade, não prova
  matemática de ausência de toda codificação possível.

## Próximo passo mínimo

1. O proprietário confirma qual RFC está ativa na próxima sessão.
2. Se for a RFC-002, resolver primeiro o conflito HTTP/HTTPS.
3. Ler integralmente PRD, RFC-002 e este handoff.
4. Verificar `git status` e preservar a mudança local do prompt.
5. Executar `make doctor` e `make verify` antes de alterar infraestrutura.
6. Implementar somente auth/HTTPS; não antecipar Yellowstone ou live.

## Como atualizar este handoff

Ao concluir cada atividade:

1. atualizar data, RFC ativa e estado da sequência;
2. registrar somente comandos realmente executados e resultados reais;
3. registrar decisões, bloqueios e riscos que continuam abertos;
4. apontar a evidência versionada correspondente;
5. declarar explicitamente o próximo passo mínimo;
6. nunca incluir conteúdo de secrets, credenciais ou material de wallet.

Para localizar o commit corrente sem manter hash autorreferente neste arquivo:

```sh
git log -1 --oneline
```
