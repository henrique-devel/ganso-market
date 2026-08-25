# RFC-012 — Polymarket: risco de resolução e grafo lógico de mercados

**Status:** accepted; fases A–D + hardening final verificados localmente
(2026-08-24); revisão, merge, boot e soak em produção pendentes
**Dependências:** RFC-007 (recorder, registry versionado, timeline UMA e eventos de regra)
**Habilita:** RFC-013 (portfólio/sizing consome score, buffers e vetos do grafo); o veto de sanidade sobre `q` é aplicado à saída da RFC-010 na camada de sinais/portfólio

### Estado verificado das dependências (2026-08-24)

Verificação executada contra o código e a produção:

- **Prontos:** timeline UMA imutável com `outcomePrices` (polling Gamma +
  `pollPendingOnce`); regras versionadas por hash com evento `rule_change`
  imutável (o detector que a tarefa 2 consome); `uma_bond`/`uma_reward`/
  `custom_liveness`/`end_date`/`uma_end_date` em `polymarket_rule_versions`;
  grupos negRisk (`polymarket_events` + `polymarket_event_markets`);
  placeholders de augmented negRisk já descartados no registry (`gamma.ts`);
  concentração de holders (`top1_share`/`top5_share`); books/trades/fees/tick
  as-of; primitivas da RFC-011 reutilizáveis (book-walk executável,
  `feeRateFromBps`, `jump_count`, `frozen_markets` do kill switch);
  `q`/`q_lo` publicados para o veto de sanidade; auth da RFC-002 para o
  endpoint de arestas curadas; migration `0010` livre.
- **Não existem (escopo desta RFC):** qualquer infraestrutura onchain
  (nenhum RPC Polygon no projeto); classificação de clarificações; léxico de
  rule-precision; score `R`; grafo; dashboard.

**Decisões do proprietário (2026-08-24):**

1. **Disco:** a reserva de 6 GB estava 100% alocada. A quota de
   `fundamental_estimates` cai de 3,0 → 2,0 GB (na taxa medida de ~23 MB/dia
   a janela continua ~87 dias, acima do piso da cadeia de evidência),
   liberando **1,0 GB** para esta RFC: scores versionados 0,4 GB; grafo +
   violações 0,3 GB; timeline própria de disputas 0,2 GB; relatórios 0,1 GB.
2. **RAM:** novo container `polymarket-resolution` com **192 MiB**,
   financiado pela redução do estimador de 384 → 192 MiB (uso medido em
   produção: 39 MiB). O cap de 4 GiB do `check_compose_policy.py` permanece
   respeitado.
3. **Coletor onchain (tarefa 1) em duas fases:** a v1 do score usa a
   timeline Gamma **já gravada** (proposed/disputed/resolved); os eventos
   onchain do UMA Adapter (semântica de reset/2-requests, P1–P4 exatos)
   entram como parte 2 desta mesma RFC, via `eth_getLogs` em RPC público da
   Polygon (fetch nativo, **sem dependência nova**) — mesmo precedente do
   faseamento do `OrderFilled` na RFC-007. A verificação de ABI/endereço
   contra a documentação atual é feita no início do desenvolvimento
   (condição de parada permanece).

### Estado da implementação (2026-08-24)

- As 18 tarefas das fases A–D e o hardening de concorrência/falha fechada
  estão implementados na branch `claude/rfc-012-execucao-c254e1`.
- `make verify` passou; a API completa contra PostgreSQL 18.4 passou com
  **1.041/1.041 testes**, e o smoke Compose passou em volume novo.
- A migration 0010 contém o schema funcional original e permaneceu
  inalterada. As migrations aditivas 0011–0012 implementam o handshake
  durável do runtime (journal, geração, lease, freshness) e o histórico as-of
  de metadados/outcomes com token afirmativo explícito.
- O aceite/fill paper, kill switch, settlement e release terminal foram
  fechados transacionalmente. O circuit breaker só permite redução da
  exposição assinada sem cruzar zero; falha de estado/posição cancela sem
  fill.
- Nenhuma execução real foi adicionada. Merge, ativação no profile
  `polymarket`, boot do artefato final e soak de 24 h dependem de revisão e
  aprovação do proprietário.

## Prompt a executar

Você deve implementar a RFC-012 do Ganso Market: o modelo de risco de resolução
(Escopo A) e o grafo lógico entre mercados (Escopo B) do módulo Polymarket.
Ambos são camadas analíticas puras sobre os dados já gravados pela RFC-007
(registry Gamma versionado, snapshots de livro top-10, trades, status UMA).
Nenhuma execução real é implementada aqui; o output são scores, vetos, buffers
de EV e sinais de inconsistência consumidos pelo pipeline paper.

Justificativa (evidência da pesquisa 2026-08): o maior risco do motor não é
execução, é resolução — casos de US$ 7M (Ucrânia-minerais), ~US$ 160–237M
(Zelensky), US$ 16M (Clavicular) e US$ 60M (Strategy/BTC, já no regime V2),
com >50% dos votos de disputa concentrados nas 10 maiores carteiras UMA e
**precedente de não-reembolso** em resolução manipulada. 43% das disputas vêm
de wording ambíguo; a taxa de disputa varia por categoria (cripto-preço 0,6%,
politics-policy 3,4%, geopolítica 4,8%); uma disputa adiciona ~49h na mediana
ao lockup (mediana geral evento→resolução 41 min, P99 ~4d5h). Do lado do
grafo: arbitragem lógica em mercados líquidos está praticamente esgotada
(~US$ 560/mês no estudo NBA 2026), portanto o grafo é primariamente
**validador de sanidade e trigger defensivo**, e só secundariamente fonte de
edge — nunca a fonte primária de PnL.

### Objetivo

1. **Escopo A — score de risco de resolução por mercado**: um score contínuo
   `R ∈ [0,1]` por mercado, recomputado a cada versão de regra e a cada
   mudança de status UMA, composto por features mensuráveis e auditáveis.
   Mapeamento determinístico: risco alto ⇒ **veto** de entrada; risco médio ⇒
   `resolution_buffer` adicional subtraído do EV (o termo previsto na
   fórmula de EV da RFC-013); disputa ativa ⇒ circuit breaker.
2. **Escopo B — grafo lógico entre mercados**: nós = mercados/outcomes do
   universo gravado; arestas tipadas = relações lógicas declaradas ou
   inferidas (exclusividade mútua, implicação, equivalência, escada temporal,
   negRisk). Violações além da banda de tolerância (custos + spread) geram
   (i) `inconsistency_signal` explicável para o pipeline de sinais e
   (ii) **veto de sanidade** sobre o modelo fundamental quando a estimativa
   `q` contradiz uma restrição do grafo.

### Restrições não negociáveis

- Sem autenticação de trading, wallet, approvals ou ordens reais — escopo da
  RFC-009. `execution_mode` continua aceitando somente `paper`.
- Sem VPN/proxy/contorno de geoblock em nenhuma hipótese.
- Nenhuma feature pode usar dado posterior à decisão (look-ahead): o score e o
  grafo em cada timestamp `t` usam somente versões de regra, snapshots e
  status com `received_ts ≤ t`. Agregados de 1 min só podem ser usados quando
  o bucket inteiro fechou até `t`; no backtest, inclusive o prior medido por
  categoria é calculado no instante histórico da decisão, nunca no instante
  de geração do relatório. Atenção ao leakage conhecido: `closedTime` da UMA
  chega **depois** de o desfecho ser público — nunca usar como label temporal
  de treino/avaliação.
- O grafo **não** é fonte primária de PnL: `inconsistency_signal` só vira
  candidato a trade se sobreviver ao mesmo funil de custos/vetos da RFC-013
  (fees taker por categoria, spread efetivo, profundidade executável,
  settlement wedge). A função primária é veto/sanity-check.
- Direção de fluxo, se usada em qualquer feature, vem de `OrderFilled`
  on-chain, nunca do campo de direção do feed WS (concorda só ~59% com o
  agressor real).
- Sem LLM local; NLP de ambiguidade é léxico/regra determinística (ver Tarefa
  3). Qualquer uso futuro de LLM externo é RFC separada.
- Tratar 28/abr/2026 (cutover V2) como fronteira dura de regime em qualquer
  estatística histórica de disputas.
- Precedente de não-reembolso é assumido: todo cap e cenário de perda usa
  **perda total** em resolução manipulada, sem crédito por "reembolso
  provável".

### Orçamento

- Dentro do orçamento da RFC-007: até 110 GB de PostgreSQL no total do módulo,
  aplicações até 3 GB de RAM em carga.
- Incremental desta RFC (**aprovado em 2026-08-24**): **1,0 GB** de
  PostgreSQL na reserva das RFCs 010–013 (scores 0,4 / grafo+violações 0,3 /
  timeline de disputas 0,2 / relatórios 0,1), liberado pela redução da quota
  de `fundamental_estimates` de 3,0 → 2,0 GB; container
  `polymarket-resolution` com 192 MiB, financiado pelo estimador
  (384 → 192 MiB; uso medido 39 MiB). Quota vence TTL, como em toda a
  retenção do módulo.
- Dentro dos 0,4 GB de scores, `resolution_scores` é uma série derivada com
  TTL de 180 dias e quota de 0,35 GB. Append-only significa que uma linha
  gravada não pode sofrer `UPDATE`; `DELETE` pelo job de retenção é permitido
  e necessário para que quota vença TTL. `resolution_score_versions` e as
  versões de regra ficam preservadas: podar a linha materializada não
  autoriza mudar sua definição. O replay exato depende de os inputs as-of
  ainda estarem na própria janela de retenção; depois dela, a decisão paper
  continua auditável pela trilha do broker, mas o score bruto podado deixa de
  ser consultável.
- Recomputação do score: event-driven (nova versão de regra, mudança de
  `umaResolutionStatus`) + varredura horária. Grafo: reavaliação a cada
  snapshot agregado de 1 min do universo, não a cada delta.
- Sem backfill pago; histórico de disputas vem do próprio pipeline (logs
  on-chain do UMA Adapter `0x6A9D...4F74` e polling Gamma), acumulado
  prospectivamente.

### Fontes permitidas

- Tabelas da RFC-007 (`polymarket_markets` versionado, `polymarket_book_snapshots`,
  trades, status) como fonte primária.
- Gamma API: campos `umaResolutionStatus(es)`, `umaBond`, `umaReward`,
  `umaEndDate`, `endDate`, `resolvedBy`, `resolutionSource`, `negRisk`,
  `negRiskOther`, `automaticallyResolved`, `customLiveness`, `description`,
  `updatedAt`, `events`/tags para agrupamento.
- Eventos on-chain públicos do UMA Adapter e do CTF (proposta, disputa,
  settle, `priceDisputed`) para o histórico próprio de disputas.
- `GET /book` (flag `neg_risk`) e `/clob-markets/{condition_id}` já coletados
  pela RFC-007.

### Tarefas

**Escopo A — risco de resolução**

1. **Ingestão de eventos UMA** (consome e estende a timeline de status já
   gravada pela RFC-007; o escopo novo aqui são os eventos on-chain do UMA
   Adapter e a semântica de reset/2 requests): persistir, por mercado,
   a linha do tempo `proposed → (disputed → reset) → (disputed → DVM vote) →
settled`, com timestamps e resultado (P1=NO, P2=YES, P3=50/50,
   P4=prematura). Persistir também `umaBond` (baseline ~US$ 750; bond acima
   disso é proxy de sensibilidade) e `customLiveness` (baseline 2h).
   Semânticas obrigatórias: a 1ª disputa **reseta** a questão (novo request,
   relógio reinicia); máximo 2 requests, depois só `resolveManually`.
2. **Classificação de clarificações**: consumir as versões de regra e o
   evento `rule_change` já emitidos pela RFC-007 (coletor e nome de evento
   únicos — sem polling paralelo); esta RFC adiciona a classificação do diff
   (clarificação material vs cosmética) como insumo do score. Não existe
   feed oficial de clarificações — o diff é o único detector.
3. **Rule-precision score (NLP determinístico)**: score léxico do texto da
   regra, sem ML, com componentes documentados e testáveis:
   - fonte de verificação: única/objetiva (feed de preço, dado on-chain,
     publicação oficial datada) vs múltipla vs subjetiva ("credible
     reporting", "consensus", "significant", "officially", "agrees to");
   - contagem de condições encadeadas e exceções ("unless", "except",
     "provided that");
   - dependência ocorrência-vs-disclosure (padrão do caso Strategy/BTC:
     execução em maio vs 8-K em junho);
   - forma "by DATE" (elegível a resolução antecipada e a P4);
   - inconsistência título vs regra: divergência entre entidades/datas/limiares
     extraídos do `question` e da `description`;
   - cláusula fallback ("cannot be determined → NO") como flag de risco
     correlacionado.
     O léxico é configuração versionada (arquivo no repo), não hardcode.
4. **Prior de disputa por categoria**: iniciar com os números da pesquisa
   (cripto-preço 0,6%/38min; NBA 0,2%; politics-policy 3,4%; geopolítica
   4,8%; ~43% wording, 22% conflito de fontes, 14% reversão tardia) marcados
   como `prior_external`, e substituí-los progressivamente pela taxa medida
   no pipeline próprio (`prior_measured`) quando houver ≥ 200 resoluções
   observadas na categoria. Reportar sempre qual prior está em uso. Nota: há
   conflito entre fontes externas (polysyncer ~1% vs paper Economics Letters
   > 1.150 disputas em 1S/2026) — por isso a medição própria é obrigatória.
5. **Modelo de lockup**: distribuição bimodal de tempo até settle —
   caso-base por categoria (mediana ~41min–2h) e cauda condicional a disputa
   (+~49h mediana; P99 ~4d5h; DVM 4–6 dias) ponderada pela probabilidade de
   disputa do mercado. Output: `E[lockup]` e `P95[lockup]`, usados no hurdle
   de custo de capital do EV.
6. **Payoff trinário**: estimar `P(50/50)` (P3) por mercado a partir do
   rule-precision score e do histórico próprio; em mercados negRisk,
   `P(50/50) = 0` estruturalmente (o NegRiskAdapter **reverte** em `[1,1]`),
   mas registrar o risco de resolução conjunta do evento.
7. **Prêmio de adjudicação (feature de settlement window)**: quando o evento
   subjacente já é publicamente conhecido (proposta feita), a distância do
   preço a 0/1 mede o risco de adjudicação implícito pelo mercado. Persistir
   como série temporal.
8. **Composição do score `R`**: combinação ponderada e monotônica das
   features 1–7 + delta `endDate` vs `umaEndDate` + flag de clarificação
   recente + concentração de holders (`/holders`, share dos top-N). Pesos em
   configuração versionada; toda mudança de peso gera nova `score_version` e
   os scores antigos permanecem consultáveis e reproduzíveis dentro da janela
   de retenção. Depois do pruning, a versão continua imutável e a decisão
   paper mantém sua trilha própria, mas o score materializado deixa de ser
   consultável.
9. **Mapeamento score → ação** (determinístico, configurável):
   - `R ≥ r_veto` (default 0,7) **ou** qualquer flag dura (fonte subjetiva,
     clarificação nas últimas 24h, inconsistência título-regra) ⇒ `VETO`:
     mercado inelegível para novo sinal;
   - `r_buffer ≤ R < r_veto` ⇒ `resolution_buffer = f(R, P(50/50), E[lockup])`
     somado aos custos no EV da RFC-013 (`EV = q − ask − custos −
resolution_buffer`), incluindo o cenário 50/50 como perda de cauda;
   - **disputa ativa** (`umaResolutionStatus` = proposed-disputado ou em
     voto) ⇒ `CIRCUIT_BREAKER`: congelar novas entradas no mercado e no
     grupo de evento, reavaliar posições paper existentes, **proibido
     aumentar posição** durante a janela; salto de preço sem catalisador
     (padrões 17%→95%, 9%→100%) dispara o mesmo estado em modo suspeita.
     **Camadas e divergência (decisão de 2026-08-24):** o estado desta RFC é
     a fonte **autoritativa** que o aceite do paper broker consulta; o
     gatilho de disputa que a RFC-011 já implementa (`frozen_markets` do
     kill switch) **permanece ativo como redundância independente** — não é
     removido. Toda divergência entre as duas camadas (uma dispara e a outra
     não, em qualquer direção) é registrada como evento e exposta como
     métrica/painel para comparação do operador: a divergência é informação
     de decisão, não ruído a eliminar.
   - **liberação terminal:** `resolved`/`market_resolved` só libera o mercado
     e o grupo depois de nova recomputação. A recomputação deve carregar o
     mercado pelo ID mesmo que ele já tenha saído do universo, gravar ação
     própria `NONE` e refazer o acoplamento do evento para não deixar
     `VETO`/`CIRCUIT_BREAKER` terminal congelando os irmãos indefinidamente.
10. **Backtest de sanidade do buffer**: sobre os mercados já resolvidos no
    recorder, inclusive os que já saíram do universo, verificar que o veto
    teria bloqueado os mercados que entraram em disputa com antecedência
    mensurável e reportar taxa de falso-positivo (mercados vetados que
    resolveram limpos). Cada replay usa somente buckets totalmente fechados e
    o prior medido disponível no instante histórico da decisão, nunca
    estatísticas do instante do relatório. Sem meta de lucro — meta é
    cobertura/precisão do veto, reportada com intervalo.

**Escopo B — grafo lógico**

11. **Construção do grafo**: nós = tokens/outcomes do universo. Arestas:
    - `MUTEX(grupo)`: outcomes do mesmo evento negRisk ou grupo declarado
      mutuamente exclusivo ⇒ `Σ P(YESᵢ) ≈ 1`;
    - `IMPLIES(A→B)`: se A implica B ⇒ `P(A) ≤ P(B)`;
    - `EQUIV(A,B)`: mercados equivalentes (mesma pergunta, wording distinto)
      ⇒ convergência de preço dentro da banda;
    - `LADDER(série temporal ou de limiar)`: "X até março" ⊆ "X até junho";
      "BTC > 100k" ⊇ "BTC > 120k" ⇒ monotonicidade;
    - `NEGRISK(evento)`: relações econômicas do adapter — 1 NO de um mercado
      converte em 1 YES de todos os outros; `Σ asks(YES) < 1` e
      `Σ bids(YES) > 1` como testes de coerência econômica.
      Origem das arestas: (a) estruturais automáticas (flag `neg_risk` +
      agrupamento por `event` do Gamma; escadas por extração de data/limiar do
      título); (b) curadas manualmente em arquivo de configuração versionado,
      com autor e justificativa. Toda aresta inferida automaticamente carrega
      `confidence` e é revisável. Em **augmented negRisk**, somente outcomes
      nomeados entram no grafo; placeholders/"Other" são excluídos.
12. **Avaliação com preços executáveis**: toda checagem usa bid/ask e
    profundidade do book gravado (nunca midpoint da UI, que vira last-trade
    quando spread > $0,10). Banda de tolerância por relação:
    `tol = fees_taker(categoria, p) + spread_efetivo + ε_config` — violação
    só é declarada se persistir por `k` snapshots consecutivos (default 3)
    além da banda, para filtrar ruído e mensagens perdidas do WS.
13. **Sinal de inconsistência**: violação persistente gera
    `inconsistency_signal` com: arestas violadas, magnitude em bps líquida de
    custos, tamanho executável por book-walk (o estudo NBA mostra que 76,9%
    das violações combinatórias limitam-se a ~15 shares — reportar o valor
    executável real, não o teórico), e half-life observado. O sinal entra no
    funil normal da RFC-013 como candidato explicável; não há caminho
    privilegiado.
14. **Veto de sanidade sobre o modelo fundamental**: se a estimativa `q` de
    um mercado violar uma restrição do grafo contra os preços executáveis dos
    vizinhos além da banda (ex.: `q(A) > q(B) + tol` com `IMPLIES(A→B)`),
    o sinal dependente de modelo é bloqueado e o evento é logado com as
    arestas envolvidas. O fallback é o baseline de mercado da RFC-010.
15. **Acoplamento A↔B**: mercados sob `VETO`/`CIRCUIT_BREAKER` do Escopo A
    não geram `inconsistency_signal` acionável (uma "violação" durante
    disputa costuma refletir risco de adjudicação, não mispricing lógico);
    o grafo os mantém como nós somente-leitura. Grupos negRisk herdam o pior
    score `R` do evento para fins de cap conjunto (insumo da RFC-013).
16. **Exportação para RFC-010/013**: API e tabelas com score, ação, buffer,
    grupo de evento, arestas e violações ativas; RFC-013 usa o grupo do grafo
    como unidade de correlação/fator para sizing e caps (worst-case por grupo
    negRisk assumindo perda total).
17. **Aplicação imediata no paper broker (decisão de 2026-08-24)**: como a
    RFC-013 ainda não existe, os vetos ganham dentes já nesta RFC — o
    endpoint `POST /polymarket/paper/intents` (RFC-011) passa a consultar a
    ação corrente desta RFC antes de aceitar: `VETO` ou `CIRCUIT_BREAKER`
    (mercado ou grupo de evento) ⇒ intent recusado com a justificativa;
    `resolution_buffer` é devolvido na decisão para o chamador descontar do
    EV. Ordens manuais também são recusadas sob `CIRCUIT_BREAKER` (aumentar
    posição em disputa é proibido); sob `VETO` são aceitas apenas com flag
    explícita `override_veto` gravada no ledger (o operador pode discordar
    do score, mas a discordância fica auditável). O mesmo invariante vale para
    ordens que já estavam abertas quando o breaker disparou: o broker usa a
    posição **assinada** reconstruída do ledger e só deixa executar reduce-only,
    sem cruzar zero (`shares > 0`: `SELL`; `shares < 0`: `BUY`). Uma `FAK`
    maior que a capacidade é recortada exatamente até zero e tem o restante
    cancelado; `FOK`, `GTC` e `GTD` que atravessariam zero são canceladas sem
    fill. Posição zero, lado que aumenta exposição ou restante inválido também
    causam cancelamento efetivo e auditado. Falha ao ler o estado autoritativo
    ou a posição canônica cancela as ordens afetadas e não permite fill com
    base em estado desconhecido.
18. **Dashboard visual do processo de resolução (decisão de 2026-08-24)**: o
    proprietário operará por interface gráfica, não por API. Página no web
    app (React/Vite existente, atrás do login da RFC-002) mostrando, de
    forma gráfica e legível para o operador: score `R` por mercado com a
    decomposição por feature, ação corrente (VETO/BUFFER/CIRCUIT_BREAKER)
    com justificativa, disputas ativas e sua linha do tempo, violações do
    grafo com magnitude líquida e tamanho executável, vetos de sanidade
    emitidos, divergências entre as camadas de circuit breaker (tarefa 9) e
    o estado geral do pipeline paper (ordens abertas, posições, kill
    switch). **Implicação de perímetro (decisão implícita do proprietário):
    os endpoints read-only necessários passam a ser publicados pelo Nginx**,
    mantendo a auth de sessão da RFC-002 e o firewall Hetzner que já
    restringe a porta 80 ao IP do operador; nenhum endpoint de escrita além
    dos já definidos é publicado.

### API mínima

- `GET /polymarket/resolution-risk` — scores correntes do universo (score,
  ação, versão, features principais).
- `GET /polymarket/resolution-risk/{market_id}` — detalhe: features, versão
  do score, histórico de eventos UMA, diffs de regra.
- `GET /polymarket/resolution-risk/{market_id}/history` — série de scores e
  transições de estado (veto/buffer/circuit-breaker).
- `GET /polymarket/graph` — nós e arestas do universo (com origem e
  confidence).
- `GET /polymarket/graph/violations` — violações ativas e históricas, com
  magnitude líquida e tamanho executável.
- `GET /polymarket/graph/vetoes` — vetos de sanidade emitidos contra o modelo
  fundamental, com justificativa.
- `POST /polymarket/graph/edges` — inserir/revisar aresta curada (somente
  usuário autenticado da RFC-002; grava autor e justificativa).

Nenhum endpoint de trading/wallet/deposit.

### Artefatos

- Coletor de eventos UMA (on-chain + Gamma) e tabela de linha do tempo de
  resolução por mercado.
- Classificador de clarificações sobre o evento `rule_change` da RFC-007
  (extensão do registry).
- Biblioteca de rule-precision score com léxico versionado em arquivo.
- Pipeline de score `R` versionado + mapeamento score→ação configurável.
- Motor do grafo (construção estrutural + arquivo de arestas curadas +
  avaliador com bandas de custo).
- Emissor de `inconsistency_signal` e de vetos de sanidade integrado ao
  pipeline de sinais da RFC-013.
- Dashboard visual do processo de resolução no web app (tarefa 18): score e
  decomposição por mercado, ações e justificativas, disputas ativas,
  violações do grafo, vetos, divergências entre camadas e estado do pipeline
  paper — com a publicação dos endpoints read-only pelo Nginx atrás da auth.
- Arquivos de configuração versionados no padrão existente do repo
  (`config/*.json`, loader fail-closed): léxico de rule-precision, pesos do
  score, priors externos de disputa e arestas curadas (com autor e
  justificativa).
- Relatório de medição própria: taxa de disputa por categoria, distribuição
  P1–P4, frequência de 50/50, lockup observado — estatísticas que **não
  existem de forma independente** e que este pipeline passa a produzir.
- Fixtures e testes.

### Testes obrigatórios

- Diff de regra: edição de `description` gera versão nova, evento de
  clarificação e recomputação do score; regra idêntica não gera versão.
- Rule-precision: corpus de fixtures com regras reais anonimizadas dos casos
  documentados (Strategy/BTC, Zelensky-like "consensus", cripto Chainlink
  TWAP) — a regra objetiva de feed de preço deve pontuar melhor que a regra
  de consenso de mídia, de forma estável sob mudanças cosméticas de texto.
- Linha do tempo UMA: proposta → disputa → reset → 2ª disputa → DVM,
  incluindo P4 e P3; máquina de estados nunca pula estados nem duplica
  eventos em replay/out-of-order.
- Circuit breaker: disputa ativa bloqueia novo sinal e aumento de posição
  paper no mercado e no grupo; ordem já aberta só executa até reduzir a
  posição assinada sem cruzar zero, com clipping apenas para `FAK`, e as
  demais são canceladas; falha de leitura autoritativa não produz fill.
  Liberação só após
  settle + recomputação, inclusive se o mercado já saiu do universo.
- Buffer no EV: com `R` crescente, o EV líquido decresce monotonicamente;
  cenário 50/50 reduz EV de posições a preços altos (YES a 80¢ → payoff
  50¢) conforme esperado.
- Grafo: fixtures sintéticas para cada tipo de aresta com violação dentro e
  fora da banda de custos; violação intra-banda **não** gera sinal;
  persistência < k snapshots não gera sinal.
- negRisk: `Σ asks < 1` com profundidade limitada reporta tamanho executável
  correto por book-walk; resultado `[1,1]` em grupo negRisk é tratado como
  impossível; augmented negRisk ignora placeholders.
- Veto de sanidade: `q` violando `IMPLIES`/`LADDER` bloqueia sinal do modelo
  e mantém baseline de mercado.
- Look-ahead: recomputar score/grafo em timestamp passado usa somente dados
  com `received_ts` anterior e buckets de 1 min totalmente fechados; o
  backtest calcula priors no instante histórico. Teste automatizado com dado
  plantado no futuro falha se vazar; `closedTime` da UMA ausente de qualquer
  label.
- Reprodutibilidade: decisão paper antiga referencia `score_version` e
  versão de regra; dentro das janelas retidas, recomputação com a mesma versão
  e inputs as-of reproduz o mesmo score. Depois do pruning, a trilha paper e a
  definição da versão permanecem auditáveis, mas o score bruto podado não.
- Retenção: `UPDATE resolution_scores` é recusado; o job pode podar scores por
  TTL/quota sem apagar `resolution_score_versions` nem as referências de
  replay preservadas.
- Enforcement (tarefa 17): intent sob `VETO`/`CIRCUIT_BREAKER` é recusado
  com justificativa; ordem manual sob `CIRCUIT_BREAKER` recusada; `VETO`
  manual só com `override_veto` gravado no ledger. Para ordens já abertas,
  cobrir long/short, `FAK` recortada até zero, `FOK` sem partial, duas ordens
  concorrendo pela mesma exposição, tentativa de cruzar zero, cancelamento
  auditado e falha fechada de leitura.
- Divergência de camadas (tarefa 9): cenário em que só uma das camadas de
  circuit breaker dispara gera o evento de divergência — nas duas direções.
- Busca de código confirma ausência de auth/wallet/order real.
- Soak: recomputação horária + avaliação de grafo a cada 1 min por 24h
  dentro do orçamento incremental (1 GB PG, 192 MiB de container).
- Relatórios iniciais declaram o `n` real com intervalo: o histórico próprio
  de disputas tem dias de vida — `prior_external` vigora até 200 resoluções
  por categoria e o backtest do veto (tarefa 10) reporta a amostra que
  existir, sem meta mínima para entrega.

### Critérios de aceite

- Todo mercado do universo tem score `R`, ação derivada e justificativa por
  feature, consultáveis via API, recomputados em ≤ 60 s após mudança de
  regra ou de status UMA.
- Disputa ativa nunca coexiste com sinal novo ou aumento de posição no
  mercado/grupo: ordens abertas só podem reduzir a posição assinada sem
  cruzar zero, com clipping apenas de `FAK`; leitura autoritativa indisponível
  cancela as ordens abertas e não permite fill
  (invariante verificada em testes unitários e de integração PostgreSQL; a
  observação operacional fica para o soak pós-aprovação).
- Nenhum sinal do modelo fundamental é emitido violando restrição ativa do
  grafo além da banda de custos.
- `inconsistency_signal` sempre reporta magnitude líquida de custos e
  tamanho executável por profundidade gravada; nunca usa midpoint.
- Scores, pesos, léxico e arestas curadas são versionados; qualquer decisão
  paper histórica é reproduzível enquanto seus inputs as-of estiverem retidos.
  Scores materializados podem ser podados por TTL/quota; suas versões não
  podem ser mutadas nem podadas junto com a série, e a trilha paper permanece
  auditável sem prometer consulta ao score bruto já podado.
- Priors externos vs medidos são distinguíveis na API; a substituição por
  medição própria é automática ao atingir o limiar de amostra.
- Sem promessa de lucro: o critério de sucesso do Escopo B é a taxa de
  bloqueio correto (sanidade) e a honestidade do relatório de violações,
  não PnL.

### Condições de parada

Pare se:

- a tarefa pedir execução real, credencial de trading ou private key (escopo
  da RFC-009), ou qualquer contorno de geoblock;
- os campos UMA do Gamma (`umaResolutionStatus`, `umaBond`, `customLiveness`)
  ou os eventos on-chain do UMA Adapter não puderem ser verificados na
  documentação/ABI atual — não inventar schema;
- o rule-precision score exigir LLM para funcionar (redesenhar léxico ou
  abrir RFC própria);
- o grafo começar a ser usado como fonte primária de PnL sem passar pelo
  funil de custos/vetos, ou o sinal de inconsistência precisar presumir fill
  otimista;
- qualquer feature exigir dado posterior à decisão ou o label depender de
  `closedTime` da UMA;
- o custo incremental ultrapassar o orçamento aprovado (1 GB de PostgreSQL /
  192 MiB de container) sem aprovação explícita do proprietário;
- a tolerância de violação precisar ser afrouxada além de custos medidos para
  "encontrar mais sinais" — isso é fabricação de edge, não detecção.
