# RFC-013 — Polymarket: motor de portfólio, critérios de entrada/saída e gates

**Status:** draft
**Dependências:** RFC-010 (modelo fundamental por categoria), RFC-011 (microestrutura e paper broker), RFC-012 (risco de resolução e grafo lógico) — todas sobre os dados gravados pela RFC-007
**Habilita:** RFC-009 (execução live) — somente após TODOS os gates desta RFC + aprovação explícita do proprietário

## Prompt a executar

Você deve implementar a RFC-013 do Ganso Market: o motor de portfólio do módulo
Polymarket (o 4º modelo do plano do dono). Ele consome `q` e intervalo do modelo
fundamental (RFC-010), features de microestrutura (RFC-011), score e vetos de
risco de resolução (RFC-012) e os dados gravados/versionados (RFC-007), e
decide: **se entra, quanto entra, quando sai e quando o sistema inteiro para**.
Toda a operação é paper (paper broker da RFC-011); esta RFC também define os
gates objetivos que habilitam a RFC-009.

### Objetivo

Consolidar EV por share, aplicar critério de entrada por limite inferior,
dimensionar posições com Kelly fracionário como TETO sujeito a limitadores
duros, impor controles de portfólio (exposição, correlação, catalisador,
liquidez, perdas, capital bloqueado), implementar os critérios de saída do
plano do dono, gerar o painel de oportunidade completo por mercado e medir os
gates que habilitam execução real — tudo explicável, versionado e reproduzível
por replay.

### Restrições não negociáveis

- `execution_mode` aceita somente `paper`. Nenhum caminho de execução real,
  auth de trading, wallet, signer ou approval nesta RFC (escopo da RFC-009).
- Sem proxy/VPN/spoofing/evasão de geoblock em nenhuma hipótese.
- **Sem promessa de stop-loss.** Um livro binário pode saltar de preço alto
  para perto de zero; o motor registra a perda potencial total no sizing, não
  finge que uma ordem de saída a protege. Nenhum texto de UI/doc pode sugerir
  proteção por stop.
- Kelly fracionário é **teto, nunca alvo**: o tamanho final é o `min()` de
  todos os limitadores; nenhum limitador pode ser desligado por flag.
- Entrada exige **limite inferior** da estimativa (nunca a média) superando o
  preço executável mais custos mais margem. Sem exceção "de alta convicção".
- Nenhum sinal com livro stale, regra ambígua vetada pela RFC-012, ou mercado
  em disputa UMA. **Nunca aumentar posição durante janela de disputa**
  (precedente de não-reembolso: Ucrânia-minerais US$ 7M, Zelensky ~US$ 160–237M,
  Strategy/BTC US$ 60M — assumir perda total possível em resolução manipulada).
- Liquidez medida por **profundidade e spread efetivo do book gravado, nunca
  por volume** (~25% do volume estimado como wash pela Columbia; crypto 3%,
  sports 45%).
- Preço executável vem de **book-walk sobre o book cru gravado**, nunca do
  midpoint da interface (site troca para last trade quando spread > $0,10).
- Todos os parâmetros numéricos desta RFC ficam em config versionada
  (`portfolio_config` com `valid_from`); toda decisão persiste o hash da config
  vigente. Mudança de parâmetro nunca reescreve decisões passadas.
- Nenhuma promessa de lucro em código, UI ou documentação. UI mantém
  "SIMULAÇÃO — SEM EXECUÇÃO REAL".

### Orçamento

- Dentro do orçamento do módulo (RFC-007): até 40 GB PostgreSQL, apps até 3 GB
  de RAM em carga.
- Motor de portfólio é event-driven sobre dados já gravados; sem novas
  conexões externas além das já autorizadas nas RFCs 010–012.
- Tabelas novas (decisões, exposições, snapshots de painel, medições de gate)
  com TTL/pruning na quota local; usam a reserva compartilhada de 6 GB das
  RFCs 010–013 definida na RFC-007; sem backup externo.

### Parâmetros default (config versionada — valores iniciais, ajustáveis só por nova versão de config)

| Parâmetro                  | Default                                                                                      | Racional                                                                                           |
| -------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `kelly_lambda`             | 0,25 (máx 0,5 com track record ≥ G1)                                                         | Baker & McHale: sob incerteza de estimativa o Kelly ótimo é encolhido; meio-Kelly aproxima o ótimo |
| `margem_seguranca_min`     | max($0,01/share; 25% do edge bruto)                                                          | Degradação paper→live esperada de 20–50%                                                           |
| `custo_capital_anual`      | 12% a.a. sobre E[lockup]                                                                     | Settlement wedge elimina 48–88% do "edge" em quase-certezas; hurdle explícito                      |
| `slippage_max_pct_edge`    | 25% do edge bruto                                                                            | Slippage como proporção do edge (plano do dono)                                                    |
| `depth_take_pct`           | ≤ 15% da profundidade executável até o preço-limite                                          | Top-of-book carrega só ~13,6% do top-10; books finos em macro                                      |
| `cap_entrada`              | 2% da banca por entrada                                                                      | PRD §6.6                                                                                           |
| `cap_mercado`              | 5% da banca                                                                                  | Perda total assumida por mercado                                                                   |
| `cap_grupo_correlacionado` | 20% da banca (worst case por grupo negRisk/fator)                                            | Grupo dimensionado como uma aposta só; correlações moderadas a extremas no mesmo tema              |
| `cap_categoria`            | 35% da banca                                                                                 | —                                                                                                  |
| `cap_fonte_resolucao`      | 25% da banca por `resolutionSource`/oráculo                                                  | Cláusulas fallback idênticas em massa = risco correlacionado                                       |
| `cap_catalisador_janela`   | 25% da banca resolvendo na mesma janela de 24h / mesmo catalisador (ex.: uma decisão do Fed) | Concentração temporal                                                                              |
| `cap_capital_bloqueado`    | 60% da banca em posições não resolvidas                                                      | Lockup bimodal: mediana 41min–2h, cauda 49h–6 dias se disputado                                    |
| `perda_diaria_max`         | 3% da banca → `REDUCE_ONLY` até 00:00 UTC seguinte                                           | —                                                                                                  |
| `perda_semanal_max`        | 6% da banca → `REDUCE_ONLY` 7 dias                                                           | —                                                                                                  |
| `drawdown_max`             | 10% do high-water mark → `HALTED` + revisão manual                                           | Alinhado ao PRD §6.6                                                                               |
| `preco_min_compra`         | $0,10                                                                                        | Viés estrutural anti-longshot (RFC-007); FLB não é edge comprovado na Polymarket                   |
| `preco_max_compra`         | $0,95                                                                                        | Quase-certezas: edge é majoritariamente custo de capital                                           |
| `edge_liq_min`             | $0,02/share após todos os custos                                                             | Piso de spread ~1¢ observado; round-trip ~2% mata edges menores                                    |

### Tarefas

1. **Consolidação de EV por share.** Para cada mercado elegível (universo
   RFC-007/010, vetos RFC-012 aplicados):
   - `EV_yes = q − ask_exec_yes − custos`
   - `EV_no = (1 − q) − ask_exec_no − custos`
   - `q` e intervalo `[q_lo, q_hi]` vêm da RFC-010 (baseline de mercado quando
     modelo não promovido). `ask_exec` é o preço médio do book-walk para o
     tamanho candidato, do book gravado com idade ≤ TTL de staleness.
   - `custos = taxa_esperada + slippage_bookwalk + custo_capital + buffer_resolucao`, onde:
     - `taxa_esperada`: 0 para quote maker (`postOnly`); para taker, curva
       `C × feeRate × p × (1−p)` com `feeRate` do `feeSchedule` versionado
       (crypto 0,07 — pico ~$1,75/100 shares a p=0,5) e reconciliação posterior
       pelo `fee_rate_bps` do WS `last_trade_price`;
     - `slippage_bookwalk`: diferença entre preço médio executado e melhor
       nível, do book-walk;
     - `custo_capital = custo_capital_anual × E[lockup]/365`, com `E[lockup]`
       bimodal por categoria: caso base evento→resolução + cauda ponderada pela
       taxa de disputa da categoria (cripto-preço 0,6%/38min; politics-policy
       3,4%/4h22m; disputa adiciona ~49h na mediana, P99 4d+);
     - `buffer_resolucao` da RFC-012: payoff trinário com P(50/50) (cada share
       paga $0,50; impossível em negRisk — adapter reverte) + prêmio de
       adjudicação + penalidade do rule-precision score.
2. **Critério de entrada (gate por trade).** Emitir intenção de entrada SOMENTE
   quando:
   ```
   q_lo − preco_executavel > taxas + slippage + custo_capital + margem_seguranca
   ```
   (para NO, substituir `q_lo` por `1 − q_hi`). Adicionalmente: preço dentro de
   `[preco_min_compra, preco_max_compra]`; `edge_liq ≥ edge_liq_min`; nenhum
   veto da RFC-012 (regra subjetiva, disputa ativa, clarificação recente,
   fonte não objetiva); dados dentro do TTL de atualidade; livro válido.
   Preferência maker: a intenção default é quote passiva GTC+postOnly com
   probabilidade de fill modelada (fila visível à frente); taker (FAK/FOK com
   preço-limite obrigatório) somente quando `edge_liq` após fee taker + spread
   ainda supera o critério — lembrando o taker delay de 250ms com cancelamento
   bloqueado (adverse selection embutida no custo).
3. **Sizing: Kelly fracionário como TETO com limitadores duros.**
   - Teto: `f* = kelly_lambda × (q_lo − a) / (1 − a)` (compra a preço `a`;
     análogo para NO), com `kelly_lambda` encolhido pela variância da
     estimativa (shrinkage crescente na incerteza — Baker & McHale).
   - Tamanho final = `min(` teto Kelly; `depth_take_pct` da profundidade
     executável até o preço-limite (book-walk gravado, nunca mid);
     redução por incerteza (largura de `[q_lo, q_hi]`); redução por correlação
     (ver tarefa 4 — sizing no nível do fator); multiplicador ≤ 1 do
     rule-precision score da RFC-012; folga restante de TODOS os caps de
     portfólio assumindo perda total da posição; tamanho tal que
     `slippage ≤ slippage_max_pct_edge` `)`.
   - Registrar no decision log qual limitador foi o binding constraint.
4. **Controles de portfólio (estado contínuo).**
   - Exposição agregada por: mercado, evento (grupo negRisk como UMA aposta —
     worst case conjunto; herdam risco de resolução conjunta), categoria,
     `resolutionSource`/oráculo, fator econômico (preço do BTC, decisão do
     Fed — mercados do mesmo fator dimensionados como uma aposta só),
     catalisador temporal (janela de resolução).
   - Matriz de correlação por fator mantida explicitamente (mapeamento
     mercado→fator versionado; correlações entre mercados do mesmo
     tema/entidade tratadas como altas por default).
   - Liquidez agregada: soma do custo estimado de unwind de todas as posições
     (book-walk de saída) ≤ limite; alarme quando unwind estimado > X% do PnL
     aberto.
   - Perda diária/semanal/drawdown com máquina de estados
     `NORMAL → REDUCE_ONLY → HALTED` (inspirada no blueprint poly-maker);
     `HALTED` só sai com ação manual.
   - Capital bloqueado até resolução monitorado contra `cap_capital_bloqueado`,
     com projeção usando E[lockup] por categoria.
   - Circuit breakers (congelam novas entradas e forçam reavaliação de saída):
     (i) `umaResolutionStatus` = proposed/disputed em qualquer posição;
     (ii) salto de preço além de limiar sem catalisador conhecido (padrões
     17%→95% e 9%→100% documentados); (iii) diff de `description` (clarificação)
     em mercado com posição; (iv) mudança de fee schedule/tick/status;
     (v) staleness de dados além do TTL.
5. **Critérios de saída (do plano do dono, sem stop-loss).** Avaliação
   contínua por posição; gerar intenção de saída (paper) quando qualquer um:
   - o **bid executável** já captura a maior parte da vantagem
     (edge residual no bid < `edge_residual_min`, default $0,01/share);
   - a probabilidade do modelo mudou (q saiu da banda de entrada além de
     limiar);
   - a tese ou fonte foi invalidada (condição de invalidação registrada na
     entrada disparou; mudança de fonte/regra);
   - liquidez ou regra deteriorou (profundidade caiu abaixo de mínimo;
     rule-precision rebaixado; clarificação);
   - catalisador não coberto pelo modelo se aproxima (janela de blackout por
     categoria — alargar/puxar antes de releases, Glosten-Milgrom);
   - o capital bloqueado deixou de compensar o edge residual
     (`edge_residual < custo_capital` do lockup restante projetado);
   - limites do portfólio atingidos (`REDUCE_ONLY`/`HALTED`).
     Saída também preferencialmente maker; taker com limite quando a informação
     está desaparecendo. Em disputa UMA: congelar (não aumentar); a decisão
     manter-vs-sair usa o payoff trinário, nunca presume reembolso.
6. **Painel de oportunidade (API + dashboard).** Para cada oportunidade,
   TODOS os campos do plano do dono:
   1. probabilidade do mercado (do book cru: bid/ask/microprice);
   2. probabilidade estimada `q` e intervalo `[q_lo, q_hi]`;
   3. lado sugerido (YES/NO);
   4. bid/ask, spread e profundidade por nível (top-10);
   5. edge bruto e edge líquido;
   6. taxas e slippage esperado (decompostos);
   7. tamanho máximo executável (book-walk + caps — com o binding constraint);
   8. risco de resolução (score RFC-012 + flags: disputa, bond > $750,
      delta endDate/umaEndDate, clarificações);
   9. fonte oficial de resolução + trecho relevante da regra (versão vigente);
   10. mercados correlacionados/contraditórios (grafo lógico: exclusivos
       somam ~100%, A⇒B então P(A)≤P(B), escadas monotônicas, negRisk);
   11. motivo de entrada (template estruturado, legível);
   12. condição de invalidação (expressão avaliável, monitorada);
   13. atualidade dos dados (idade de book, trade, regra, fonte externa);
   14. cenários: resultado provável, melhor e pior (pior = perda total;
       incluir cenário 50/50 quando aplicável).
       Painel nunca exibe oportunidade vetada como "quase entrável" sem o motivo
       do veto.
7. **Decision log e replay.** Toda intenção (entrada/saída/veto/resize)
   persiste: inputs (q, book, fees, features), config hash, versão de regra,
   limitador binding, timestamp de dado mais antigo usado. Replay determinístico
   do log contra dados gravados reproduz as mesmas decisões (teste obrigatório).
8. **Medição contínua dos gates (tarefa 9)** com relatório semanal
   automático versionado.
9. **Gates objetivos que habilitam a RFC-009** (todos necessários; nenhum é
   substituível por julgamento):
   - **G1 — Calibração do modelo:** em ≥ 100 mercados resolvidos das categorias-alvo,
     walk-forward (nunca k-fold), o modelo promovido não piora Brier/log-loss
     vs o próprio preço (barra: preço tem Brier ~0,074 e BSS ~0,23) e o sinal
     usado nas entradas tem Brier < 0,20 (RFC-007). Labels sem leakage
     (`closedTime` chega depois do desfecho público — usar timestamp de
     desfecho verificável, não o da UMA).
   - **G2 — Paper com realismo:** ≥ 60 dias corridos de paper contínuo com
     simulador conservador (book-walk, fila passiva, latência, fills parciais,
     resolução 0/1/0,5), ≥ 100 posições fechadas em ≥ 30 mercados distintos e
     ≥ 2 categorias; PnL líquido com IC 95% por block-bootstrap acima de zero
     **após haircut de 50% no edge realizado** (degradação live esperada
     20–50%; template walk-forward + block-bootstrap do polymarket-edge).
   - **G3 — Sobrevivência de risco:** nenhum breach de cap não bloqueado
     automaticamente; drawdown máximo do paper < `drawdown_max`; todos os
     circuit breakers dispararam corretamente em cenários injetados (disputa,
     salto de preço, clarificação, staleness).
   - **G4 — Reconciliação e operação:** fee simulada vs `fee_rate_bps` real do
     WS com erro mediano < 5%; slippage simulado vs book real sem viés
     otimista; soak 30 dias dentro do orçamento de RAM/disco; kill switch e
     `REDUCE_ONLY`/`HALTED` exercitados.
   - **G5 — Frescor de regime:** os 60 dias do G2 são posteriores à última
     mudança relevante da venue (fees por categoria mudam; V2 matou estratégias
     vivas). Qualquer mudança de fee schedule/regras/protocolo durante o gate
     **reseta o relógio do G2** para as categorias afetadas.
   - **G6 — Aprovação:** revisão manual do proprietário sobre o relatório de
     gates, com registro escrito. Expectativa calibrada no relatório: ~84% das
     carteiras rastreáveis perdem; o gate exige evidência de decil superior,
     não "parece bom".
     Falha de qualquer gate: registrar `NO_EVIDENCE_OF_ALPHA` (ou o código do
     gate), manter paper, nunca "afrouxar" o gate na mesma config.

### API mínima

- `GET /polymarket/opportunities` — painel completo (campos da tarefa 6)
- `GET /polymarket/opportunities/{id}` — detalhe + histórico de decisão
- `GET /polymarket/portfolio/exposure` — por mercado/evento/categoria/fonte/fator/catalisador
- `GET /polymarket/portfolio/limits` — caps vigentes, consumo, binding constraints
- `GET /polymarket/portfolio/state` — `NORMAL | REDUCE_ONLY | HALTED` + motivo
- `POST /polymarket/portfolio/halt` — halt manual (idempotente)
- `POST /polymarket/portfolio/resume` — só de `HALTED` com confirmação
- `GET /polymarket/gates` — status G1–G6 com números e ICs
- `GET /polymarket/decisions` / `GET /polymarket/decisions/{id}` — decision log

Nenhum endpoint de trading/wallet/deposit. Endpoints de posição/ordem paper
permanecem os da RFC-011.

### Artefatos

- Motor de EV/entrada/sizing/saída com config versionada.
- Máquina de estados de portfólio + circuit breakers.
- Grafo de correlação por fator e grupos negRisk.
- Painel de oportunidade (API + dashboard).
- Decision log com replay determinístico.
- Pipeline de medição de gates + relatório semanal.
- Fixtures de cenários (disputa, 50/50, salto de preço, clarificação, book fino).
- Testes.
- Documento explícito de ausência de execução real e de ausência de stop-loss.

### Testes obrigatórios

- EV_yes/EV_no com decomposição de custos batendo caso a caso (maker vs taker,
  curva de fee por categoria, lockup bimodal).
- Entrada rejeitada quando `q_lo − preco ≤ custos + margem` mesmo com média
  favorável; rejeitada fora de `[preco_min, preco_max]`; rejeitada com veto
  RFC-012, livro stale ou disputa ativa.
- Sizing: cada limitador individualmente vira o binding constraint em fixture
  própria; tamanho nunca excede `depth_take_pct` do book-walk; grupo
  correlacionado nunca excede o cap conjunto (incluindo negRisk worst case).
- `REDUCE_ONLY`/`HALTED`: disparo por perda diária/semanal/drawdown; nenhum
  aumento de posição possível nesses estados; `HALTED` exige ação manual.
- Circuit breakers: disputa UMA congela entradas e bloqueia aumento; diff de
  regra e salto de preço geram reavaliação; posição em disputa avaliada com
  payoff trinário.
- Saída: cada um dos sete critérios do plano dispara em fixture dedicada;
  nenhum caminho de código implementa stop-loss automático prometido.
- Painel: os 14 campos presentes e consistentes com o decision log; campo de
  atualidade reflete staleness injetada.
- Replay do decision log reproduz decisões bit a bit; cada decisão persiste o
  trecho de book e os valores de entrada usados (replay independente do TTL
  dos dados crus).
- Gates: cálculo de Brier/log-loss walk-forward sem leakage (teste com label
  atrasado); block-bootstrap com semente fixa reproduzível; reset do G2 ao
  injetar mudança de fee schedule.
- Look-ahead e survivorship: motor nunca usa dado posterior à decisão.
- Busca de código confirma ausência de auth/wallet/order real.
- Soak de 24h dentro do orçamento.

### Critérios de aceite

- Nenhuma entrada sem passar o critério de limite inferior completo; nenhum
  tamanho acima do `min()` dos limitadores; binding constraint sempre logado.
- Estados `REDUCE_ONLY`/`HALTED` invioláveis por qualquer sinal.
- Painel completo (14 campos) para toda oportunidade exibida.
- Gates G1–G6 mensuráveis por endpoint, com números e ICs, sem intervenção
  manual no cálculo.
- RFC-009 permanece bloqueada enquanto qualquer gate falhar; falha registra
  código de motivo e mantém paper.
- Replay determinístico funciona sobre dados gravados reais.
- Sem promessa de lucro ou de stop-loss em qualquer artefato.

### Condições de parada

Pare se:

- a tarefa pedir execução real, credencial de trading, private key ou qualquer
  contorno de geoblock (VPN/proxy/spoofing);
- qualquer limitador de sizing ou cap precisar ser desabilitável por flag para
  "destravar" entradas;
- o critério de entrada precisar usar a média em vez do limite inferior, ou o
  simulador precisar presumir fill otimista para os gates passarem;
- os gates G1/G2 não puderem ser medidos sem leakage (labels, look-ahead) ou o
  block-bootstrap não for reproduzível;
- o motor precisar de dado que a RFC-010 não grava (não inventar fonte nova
  sem RFC);
- a retenção ultrapassar a quota local ou o orçamento de RAM for excedido no
  soak;
- surgir mudança de regime da venue no meio da implementação que invalide o
  fee schedule/semântica de ordens assumidos — parar e re-verificar a doc
  oficial antes de continuar.
