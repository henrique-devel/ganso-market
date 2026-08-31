# DADO + HARDENING — nowcasts no calendário macro e sync com retry

Você vai destravar a categoria macro (hoje o modelo `macro_scheduled` abstém em TODO mercado
por falta de consenso) e endurecer o sync do calendário, ATÉ O FINAL: dados de fonte oficial
→ config → código do sync → testes → merge → CD → rebuild → verificação → HANDOFF.

## Autorização e regras permanentes

- **SSH autorizado pelo proprietário**: `ssh -i ~/.ssh/id_ed25519 root@178.105.65.251`
  (checkout em `/opt/ganso-market`). Leitura livre; escrita no servidor SOMENTE nos passos de
  deploy. Nunca imprima secrets. Acesso à internet para as FONTES OFICIAIS de nowcast é
  parte da tarefa.
- Ordem de fontes: este prompt → RFC-010 → código. Leia `docs/HANDOFF.md` e `git log` antes;
  re-meça o estado (o `config/macro-calendar.json` pode já ter consenso) — se sim, PARE a
  parte de dados e avalie só o hardening.
- Deploy são TRÊS passos; o CD NÃO troca imagem de profile (mas REINICIA os containers a
  cada merge). **Este PR muda `config/` e possivelmente o código que a lê: os dois saem na
  MESMA janela** (lição do score_version 1.1.0). `make verify` verde antes do PR.
- Invariante da RFC-010: **os valores de consenso/nowcast vêm de fonte oficial, nunca de
  estimativa nossa**. Sem fonte confiável para uma entrada, a entrada fica sem consenso e o
  modelo continua abstendo nela — abster é o comportamento correto, não um bug.

## O estado, medido (28–31/08)

- `config/macro-calendar.json` não tem `consensus`/`nowcast` em nenhuma entrada →
  `macro_scheduled` abstém em tudo; **0 observações macro** no gate; 1 único mercado macro
  rotulado na história. O G2 exige **2 categorias** — sem macro produzir evidência, a segunda
  categoria depende só de entradas por baseline (raras).
- `parseMacroCalendar` guarda a entrada inteira em `payload_json`: acrescentar `consensus`
  (ou `nowcast`/`forecast`) e opcionalmente `consensus_std` é ADITIVO, sem migration.
- **Fragilidade conhecida (23/08), agora amplificada:** o sync do calendário roda SÓ no boot
  do recorder e SEM retry — e o CD reinicia os profiles a cada merge, então
  `MACRO_CALENDAR_SYNC_FAILED` recorre em todo boot que perde a corrida com o postgres. Se o
  arquivo mudar e o sync falhar, a mudança se perde em silêncio até o próximo restart.
  Correção natural já registrada no HANDOFF: agendar o sync junto do job `macro_releases`
  (10 min) em vez de só no boot.

## Tarefa

1. **Dados:** para cada entrada do calendário (CPI, FOMC etc.), buscar consenso/nowcast em
   fonte oficial — Cleveland Fed (inflation nowcasting) e CME FedWatch são as fontes que o
   HANDOFF já nomeia; cite a URL e a data de leitura de cada valor NO PRÓPRIO JSON (campo de
   proveniência) e no PR. Entradas sem fonte ficam sem consenso.
2. **Hardening:** sync do calendário agendado no job de 10 min (com o retry natural disso),
   mantendo o sync de boot; `MACRO_CALENDAR_SYNC_FAILED` deixa de ser terminal-até-o-próximo-
   restart. Teste: falha no boot + sucesso no ciclo seguinte → banco converge com o arquivo.
3. **Processo de atualização registrado:** nowcasts envelhecem. Registre no runbook
   (`docs/runbooks/polymarket-fundamental.md`) como e quando o proprietário atualiza os
   valores (manual, com fonte) — este prompt NÃO cria coleta automática de sites externos
   (dependência nova é decisão do proprietário).

## Deploy e verificação

1. Merge com CI verde → CD (config chega) → rebuild do `polymarket-recorder` (sync) na mesma
   janela; `polymarket-estimator` só se o código do modelo for tocado (não deveria).
2. Verificar: entradas com consenso no banco (`macro_*`); `macro_scheduled` passa a emitir
   estimativa (linhas `MODEL/shadow` macro em `fundamental_estimates`) nos mercados cujo
   release tem consenso — e continua abstendo nos demais; zero `MACRO_CALENDAR_SYNC_FAILED`
   não-recuperado em 24 h (o job de 10 min converge).
3. Registrar o efeito esperado no G2: macro começa a poder gerar evidência de modelo (a
   categoria tem ~22 mercados — volume baixo; anotar isso, não prometer milagre).

## Encerramento (obrigatório)

- HANDOFF atualizado (valores adicionados com fontes, hardening, primeira estimativa macro
  observada); status em `prompts/roadmap/README.md`.
- Condições de parada: tentação de inventar consenso sem fonte; dependência automática nova
  de site externo; migration.
