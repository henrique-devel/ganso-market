# RFC-012 — Polymarket: risco de resolução e grafo lógico de mercados

**Status:** draft (2026-08-19)
**Dependências:** RFC-007 (recorder, registry versionado, timeline UMA e eventos de regra)
**Habilita:** RFC-013 (portfólio/sizing consome score, buffers e vetos do grafo); o veto de sanidade sobre `q` é aplicado à saída da RFC-010 na camada de sinais/portfólio

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
  status com `received_ts ≤ t`. Atenção ao leakage conhecido: `closedTime`
  da UMA chega **depois** de o desfecho ser público — nunca usar como label
  temporal de treino/avaliação.
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

- Dentro do orçamento da RFC-007: até 40 GB de PostgreSQL no total do módulo,
  aplicações até 3 GB de RAM em carga.
- Estimativa incremental desta RFC: < 2 GB de PostgreSQL (scores versionados,
  arestas do grafo, log de violações, histórico de disputas do universo) e
  < 300 MB de RAM (grafo em memória para 50–100 mercados é trivial). Essas
  tabelas usam a reserva compartilhada de 6 GB das RFCs 010–013 definida na
  RFC-007.
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
   os scores antigos permanecem consultáveis (reprodutibilidade de decisões
   paper).
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
10. **Backtest de sanidade do buffer**: sobre os mercados já resolvidos no
    recorder, verificar que o veto teria bloqueado os mercados que entraram
    em disputa com antecedência mensurável, e reportar taxa de
    falso-positivo (mercados vetados que resolveram limpos). Sem meta de
    lucro — meta é cobertura/precisão do veto, reportada com intervalo.

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
- Painel no dashboard paper: score por mercado, disputas ativas, violações
  do grafo, vetos emitidos.
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
  paper no mercado e no grupo; liberação só após settle + recomputação.
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
  com `received_ts` anterior; teste automatizado com dado plantado no futuro
  falha se vazar; `closedTime` da UMA ausente de qualquer label.
- Reprodutibilidade: decisão paper antiga referencia `score_version` e
  versão de regra; recomputação com a mesma versão reproduz o mesmo score.
- Busca de código confirma ausência de auth/wallet/order real.
- Soak: recomputação horária + avaliação de grafo a cada 1 min por 24h
  dentro do orçamento incremental (< 2 GB PG, < 300 MB RAM).

### Critérios de aceite

- Todo mercado do universo tem score `R`, ação derivada e justificativa por
  feature, consultáveis via API, recomputados em ≤ 60 s após mudança de
  regra ou de status UMA.
- Disputa ativa nunca coexiste com sinal novo ou aumento de posição no
  mercado/grupo (invariante verificada em teste e em runtime).
- Nenhum sinal do modelo fundamental é emitido violando restrição ativa do
  grafo além da banda de custos.
- `inconsistency_signal` sempre reporta magnitude líquida de custos e
  tamanho executável por profundidade gravada; nunca usa midpoint.
- Scores, pesos, léxico e arestas curadas são versionados; qualquer decisão
  paper histórica é reproduzível.
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
- o custo incremental ultrapassar o orçamento (2 GB PG / 300 MB RAM) sem
  aprovação explícita do proprietário;
- a tolerância de violação precisar ser afrouxada além de custos medidos para
  "encontrar mais sinais" — isso é fabricação de edge, não detecção.
