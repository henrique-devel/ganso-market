# Roadmap de prompts — do estado de 2026-08-31 até a execução real

Esta pasta contém os prompts operacionais, **um por sessão de IA**, que levam o projeto do
estado de 2026-08-31 até a execução real (RFC-009). Cada prompt é **autocontido**: carrega a
autorização de SSH, as regras de deploy e os fatos medidos de que precisa — pode ser colado
numa sessão nova sem nenhum outro contexto além do repositório.

Origem: diagnóstico completo de 2026-08-28 e as **7 decisões do proprietário** do mesmo dia
(registradas no HANDOFF): shadow replay com os dois modos; publicação de
`GET /paper/performance` aprovada (location exato); quota de `book_deltas` redeclarada
conscientemente; janela de pg_repack autorizada (executada); backup mínimo recusado (risco
mantido); fix do fingerprint G2/G5 autorizado (entregue); **prioridade invertida — alpha
primeiro, dashboard depois**.

## O que JÁ FOI FEITO (não há prompt para isso — não re-execute)

Bloco de hotfixes de 28/08, verificado e com soak fechado em 31/08 (PRs #50–#59):
medidor de quota em bytes vivos reais (#50); fingerprint do G2/G5 = schedule da venue (#51 —
**o piso de 60 dias conta desde 2026-08-28 20:38:47Z → melhor caso G2/G5 ≈ 2026-10-27**);
graça de 180 s no cancel por lag (#52); coletor onchain vivo (#53 — a causa real era
histórico podado do RPC); batch do DELETE orçado por bytes (#54); VACUUM FULL recuperou
78 GB (banco 116 → 38 GB); migration 0016 (índice da FK) destravou a poda de
`portfolio_decisions` (449 k linhas na primeira rodada). Kill switch rearmado pelo
proprietário em 31/08 18:21Z. Duas sessões já foram desperdiçadas re-recebendo prompts de
trabalho concluído — **todo prompt desta pasta manda re-medir antes de agir; honre a parada**.

## Como usar

1. Uma sessão por prompt, na ordem abaixo (∥ = pode rodar em paralelo/quando der).
2. Todo prompt começa mandando ler `docs/HANDOFF.md` e conferir `git log`: se outro prompt já
   entregou parte do escopo, a sessão adapta ou para.
3. O prompt mestre (`prompts/AI_DEVELOPER_SYSTEM_PROMPT.md`) continua sendo o sistema base;
   estes arquivos são o "pedido do proprietário" de cada sessão.
4. Ao concluir, a sessão atualiza o HANDOFF e a coluna de status abaixo.

## Ordem e status

| # | Prompt | Tipo | Depende de | Status |
|---|--------|------|------------|--------|
| 01 ∥ | [Metadata version missing recorrente](01-hotfix-metadata-version-missing.md) | hotfix | — | pendente |
| 02 ∥ | [Nowcasts no calendário macro + sync com retry](02-dados-nowcasts-macro.md) | dado + hardening | — | pendente |
| 03 | [RFC-016 — horizonte intradia](03-rfc-016-horizonte-intradia.md) | RFC | — | pendente |
| 04 | [RFC-019 — cobertura de modelo (barreira + updown)](04-rfc-019-cobertura-modelo.md) | RFC | 03 | pendente |
| 05 | [RFC-017 — shadow replay (dois modos)](05-rfc-017-shadow-replay.md) | RFC | ideal após 04 | pendente |
| 06 | [RFC-015 — dashboard do operador](06-rfc-015-dashboard-operador.md) | RFC | ideal após 03 | pendente |
| 07 | [RFC-018 — gates e calibração](07-rfc-018-gates-calibracao.md) | RFC | — | pendente |
| 08 | [Redeclaração da quota de book_deltas](08-redeclaracao-quota-book-deltas.md) | decisão + PR | dado fecha ~2026-09-04 | pendente |
| 09 | [Checklist pré-live](09-checklist-pre-live.md) | verificação | gates PASS | pendente |
| 10 | [RFC-009 — execução real](10-rfc-009-execucao-real.md) | RFC | 09 completo | pendente |
| ∥ | Trilha humana: parecer jurídico/tributário, capital real, burn wallet Polygon | proprietário | — | pendente — **pode começar hoje**; maior lead time do caminho |

Calendário: o piso de 60 dias do G2/G5 corre desde 28/08 20:38Z (melhor caso ≈ 27/10);
gates PASS realista ~novembro/2026; live ~dezembro/2026 — condicionado a um modelo com alpha
(prompt 04), o único item sem data mecânica.

## Convenções que todo prompt desta pasta carrega

- **Autorização de SSH** ao servidor de produção (leitura livre; escrita só nos passos de
  deploy/manutenção descritos no próprio prompt).
- Deploy em **três passos** (merge → CD → rebuild de profile); o CD reinicia os containers de
  profile a cada merge **sem trocar a imagem**; a evidência de revisão é
  `/etc/ganso/release-sha` dentro do container.
- Invariantes intocáveis (paper-only, fail-closed, gates não afrouxam, money em bigint,
  migrations aplicadas não mudam) e teste de regressão verificado falhando no código anterior.
- Re-medição antes de codar: os fatos citados foram medidos em 28–31/08 e podem ter mudado.
