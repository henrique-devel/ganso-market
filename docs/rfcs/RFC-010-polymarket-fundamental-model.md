# RFC-010 — Polymarket: modelo fundamental (q e incerteza)

**Status:** draft
**Dependências:** RFC-007 (recorder, market registry, versionamento de regras/fees e feeds externos crypto/macro)
**Habilita:** RFC-011 (o paper broker consome `q` e `q_lo`) e RFC-013 (sinais, portfólio e gates) — nunca execução real diretamente

## Prompt a executar

Você deve implementar a RFC-010 do Ganso Market: o modelo fundamental do módulo
Polymarket. Este componente estima, para cada mercado do universo selecionado,
a probabilidade `q` do desfecho YES **com intervalo de incerteza**, usando o
próprio mercado como prior e modelos estatísticos específicos por categoria.
Ele produz **apenas estimativas versionadas** gravadas em tabela própria,
consumidas pela RFC-011 (microestrutura/paper broker) e pela RFC-013
(portfólio e sinais). Nenhuma ordem — nem paper — é
criada por esta RFC.

### Objetivo

Responder, por mercado e por instante de decisão: "qual é a nossa probabilidade
estimada e qual é a incerteza dessa estimativa?" — de forma reprodutível,
auditável e calibrada. O mercado é um baseline brutalmente forte (Brier ~0,074
e termo de calibração ~0,0005 em 2024; BSS ≈ 0,231 vs climatologia em 24h;
livros de crypto de curto prazo empiricamente calibrados), então o objetivo
operacional não é "prever melhor sempre": é ter um pipeline que **prove**, por
categoria e em walk-forward, quando um modelo bate o próprio preço — e que caia
de volta ao preço, deterministicamente, quando não provar.

### Restrições não negociáveis

- Esta RFC **não executa nada**: sem ordens (nem paper), sem auth de trading,
  sem wallet, sem broadcast. Saída única: linhas em `fundamental_estimates`.
- **Nunca um modelo universal.** Cada modelo pertence a exatamente uma
  categoria (`crypto_updown`, `macro_scheduled`, ...). Categoria sem modelo
  ativo usa o fallback de mercado. É proibido treinar um modelo único
  cross-categoria "para simplificar".
- O baseline de mercado (microprice executável) **nunca é desligável** e está
  sempre disponível quando o livro é válido; o modelo só pode substituí-lo após
  passar o gate (abaixo).
- Validação **somente walk-forward temporal**; k-fold e shuffle são proibidos.
- **Nenhum dado posterior à decisão**: todo feature join é as-of pelo
  `source_ts` do dado, nunca pelo `received_ts` de ingestão nem por timestamps
  de resolução. Cuidado documentado com leakage de labels: o `closedTime`/status
  UMA chega **depois** de o desfecho ser público — o label só pode ser usado em
  métricas indexadas pelo instante de resolução final, nunca como feature.
- **Cada estimativa registra proveniência completa**: `model_id`,
  `model_version`, `feature_set_version`, `git_sha` do código, referências das
  janelas de dados usadas (`data_refs`) e flags de staleness. Estimativa sem
  proveniência completa é bug, não degradação aceitável.
- 28/abr/2026 (cutover CLOB V2) é **fronteira dura de regime**: nenhum treino
  ou calibração pode misturar dados pré e pós-V2 no mesmo conjunto sem flag
  explícito `regime_mix=true` no registro do modelo — e modelos com esse flag
  não são elegíveis a promoção.
- **Não assumir favorite-longshot bias como edge**: a evidência é conflitante
  (presente em Kalshi/corridas; ausente na Polymarket no único backtest com
  custos reais). Se algum modelo quiser explorá-lo, o viés deve ser medido por
  categoria no pipeline próprio antes.
- Sem LLM local; sem GPU; NLP de ambiguidade de regra é escopo do modelo de
  risco de resolução (RFC futura), não desta.
- Nenhuma promessa de lucro em código, docs ou UI. O gate exige apenas "não
  piorar o baseline"; passar o gate **não** implica edge líquido de custos —
  isso é decidido a jusante (sinais/portfólio).

### Barra do baseline (evidência que fixa os números do gate)

- Preço de mercado: Brier ~0,074 (2024, intervalos de 10min) com termo de
  calibração ~0,0005 — o erro do mercado é de refinamento, não de calibração.
- BSS ≈ 0,231 [0,215–0,246] vs climatologia em horizonte de 24h; incluir
  mercados degenerados (>0,99 / <0,01) infla métricas (BSS salta a ~0,428) —
  portanto as métricas headline **excluem** degenerados e reportam a versão
  com degenerados apenas como anexo.
- Miscalibração do mercado **cresce com tempo-até-expiração** (Page & Clemen,
  EJ 2013): a comparação modelo vs baseline deve ser estratificada por bucket
  de horizonte, e a expectativa a priori é que o modelo só tenha chance perto
  da resolução.
- Sinal candidato em crypto: thresholds de BTC negociaram 5,6–11pp acima da
  probabilidade implícita por opções (Binance/Deribit), com half-life de
  reversão ~4h — **dados de 2023, pré-V2**; é hipótese a revalidar, nunca
  premissa.
- Macro: sub-reação a sinal público (~0,64-por-1) com drift pós-anúncio —
  hipótese com suporte acadêmico, a validar no pipeline próprio.

### Orçamento

- Dentro do orçamento do módulo (RFC-007): até 40 GB de PostgreSQL no total do
  módulo e até 3 GB de RAM em carga para as aplicações. As tabelas desta RFC
  usam a reserva compartilhada de 6 GB das RFCs 010–013 definida na RFC-007.
- `fundamental_estimates`: no máximo 1 estimativa por token a cada 60 s em
  regime normal (universo de 50–100 mercados ⇒ ~150–300 k linhas/dia teto);
  reavaliação event-driven (novo book, release macro) permitida com rate limit
  por token. TTL: estimativas brutas 90 dias; agregados de calibração e
  relatórios são permanentes até a quota local.
- Treino e calibração rodam em batch no próprio servidor (CPX42), fora do
  caminho quente do recorder; sem GPU, sem serviço externo pago.

### Fontes de dados por categoria

Comuns (já gravadas pela RFC-007): `polymarket_markets` (regras versionadas,
fees, tick, negRisk, datas), `polymarket_book_snapshots` (top-10 a cada 2–5 s),
trades/último preço, status e resoluções.

**crypto_updown**

- Livro próprio gravado (prior de mercado).
- RTDS `crypto_prices` (Binance spot) e `crypto_prices_twap_thirty/sixty`
  (**Chainlink TWAP 30/60 s — o feed que resolve os mercados; usá-lo como
  insumo primário elimina basis risk**). Gravação contínua (RTDS não tem
  replay).
- Opcional, versionada como fonte: vol implícita de opções via API pública
  (ex.: Deribit). Atenção ao offset estrutural Binance↔Chainlink (~0,12% em
  ETH, documentado): medir e corrigir o offset antes de usar qualquer sinal
  cross-feed; um falso positivo por esse offset já foi documentado.

**macro_scheduled**

- Calendário oficial de releases (BLS/BEA/FOMC), valores oficiais na
  publicação e nowcasts públicos (Cleveland Fed, CME FedWatch): **gravados e
  versionados pela RFC-007** (tarefa de calendário macro); esta RFC apenas os
  consome como features as-of, preservando a saída única em
  `fundamental_estimates`.

Verificar documentação oficial atual antes de fixar endpoints/schemas.

### Tarefas

1. **Registry de modelos.** Tabela `fundamental_models`: `model_id`,
   `category`, `version` (semver), `git_sha`, `feature_set_version`,
   hiperparâmetros serializados, janelas de treino (com fronteira de regime),
   `status ∈ {shadow, active, retired}`, `regime_mix` (bool), timestamps e
   relatório de gate associado. Todo treino gera versão nova; versões são
   imutáveis.

2. **Tabela de estimativas.** `fundamental_estimates`: `market_id`,
   `token_id`, `decision_ts`, `q`, `q_lo`, `q_hi` (intervalo central 90%),
   `source ∈ {MODEL, MARKET_BASELINE}`, `model_id/model_version` (null quando
   baseline), `feature_set_version`, `git_sha`, `data_refs` (jsonb com
   source_ts do book, do feed externo e do calendário usados), flags
   (`book_stale`, `feed_stale`, `thin_book`, `rule_changed_recently`). Índice
   por (`market_id`, `decision_ts`).

3. **Prior de mercado (baseline e fallback).** Definir e implementar o
   **microprice executável**: mid ponderado pela profundidade do top-10 dentro
   de um tamanho de referência `S_ref` (default US$ 100, configurável),
   calculado do book cru gravado — nunca do preço da UI (que vira last trade
   quando spread > $0,10). Regras de invalidação: snapshot mais velho que 30 s,
   spread executável > 10¢, ou profundidade < `S_ref` em qualquer lado ⇒ book
   inválido ⇒ **nenhuma estimativa é emitida** (ausência explícita, não valor
   podre).

4. **Intervalo de incerteza.** `[q_lo, q_hi]` combina, de forma determinística
   e versionada:
   - meia-largura mínima estrutural = metade do spread executável a `S_ref`
     (o intervalo **nunca** pode ser mais estreito que isso);
   - dispersão do modelo (ensemble de seeds/janelas ou bootstrap em bloco dos
     resíduos de calibração da categoria);
   - alargamento multiplicativo por staleness de dados e por bucket de
     tempo-até-resolução (miscalibração cresce com horizonte);
   - truncamento a [0,001, 0,999] e garantia `q_lo ≤ q ≤ q_hi`.
     No fallback, o intervalo é o do baseline alargado (fator configurável,
     default 1,5×) — o fallback é sempre **mais** incerto, nunca menos.

5. **Modelo crypto_updown (primeiro protótipo).** Para mercados "preço do
   ativo acima/abaixo de K em T":
   - features: nível e retornos do TWAP Chainlink 30/60 s (feed resolutor),
     vol realizada EWMA em janelas múltiplas, distância log ao strike,
     tempo restante até T, e (opcional, versionado) vol implícita
     interpolada de opções;
   - mapeamento base: distribuição de retornos sem drift (normal e t de
     caudas pesadas como variantes versionadas) sobre o TWAP até T ⇒ q;
   - correção de calibração aprendida walk-forward (ex.: regressão logística
     regularizada sobre logit(q_base) + features, conforme a regra de
     promoção desta RFC);
   - a hipótese "sobrepreço vs opções" (5,6–11pp, half-life 4h, dados 2023)
     entra como feature candidata **somente** se revalidada pós-V2 no
     pipeline próprio.

6. **Modelo macro_scheduled (segundo protótipo).** Para CPI/payroll/decisão
   do Fed:
   - parser determinístico da regra versionada ⇒ variável oficial + limiar +
     fonte + data de release (mercados cuja regra não parseia de forma
     inequívoca são excluídos do modelo e ficam no baseline);
   - distribuição de consenso/nowcast sobre a variável ⇒ q por bucket;
   - regime pós-release: janela configurável após o `source_ts` oficial em
     que o modelo pode explorar a sub-reação (~0,64-por-1) — hipótese
     marcada como tal e validada separadamente do regime pré-release;
   - flag `thin_book` obrigatória (books finos documentados em macro): q é
     probabilidade pura, mas o consumidor precisa saber que o executável
     diverge do mid.

7. **Histórico comparável (label store).** Tabela de mercados resolvidos por
   categoria com label {0, 1, 0,5}, instante em que o desfecho ficou
   **publicamente conhecível** (para métricas honestas) e instante da
   resolução onchain; backfill via Gamma + recorder próprio. Excluir do
   headline mercados degenerados e mercados com disputa UMA (estes entram em
   análise separada). Mínimo antes de qualquer gate: 100 mercados resolvidos
   na categoria (regra de promoção desta RFC).

8. **Pipeline de calibração walk-forward.** Janelas temporais deslizantes
   (treino → validação sempre no futuro do treino); baseline = microprice
   executável **no mesmo `decision_ts`** de cada estimativa do modelo;
   métricas: Brier, log loss, curva de calibração (reliability), por
   categoria e por bucket de horizonte; incerteza das métricas por block
   bootstrap com CI 95% (template metodológico: walk-forward + block
   bootstrap, padrão "polymarket-edge"). Job batch diário + sob demanda.

9. **Gate de promoção (`NO_EVIDENCE_OF_ALPHA`).** Todo modelo novo nasce em
   `shadow` (estimativas gravadas com `status=shadow`, invisíveis ao
   consumidor). Promoção a `active` exige, na categoria:
   - N ≥ 100 mercados resolvidos cobertos em shadow/walk-forward;
   - Brier e log loss do modelo **não piores** que o baseline de mercado com
     CI 95% (bootstrap em bloco) — critério de não-inferioridade;
   - nenhuma fatia de horizonte com degradação grosseira (> 20% relativo);
   - relatório de calibração anexado e aprovação manual do operador.
     Falha em qualquer critério ⇒ gravar evento `NO_EVIDENCE_OF_ALPHA` com o
     relatório, manter/rebaixar para fallback. **Re-validação obrigatória**
     (volta a shadow) após qualquer mudança de venue, fee schedule ou regime —
     a migração V2 matou estratégias vivas em uma semana.

10. **Fallback determinístico.** Qualquer condição anômala — modelo sem
    versão ativa, feed externo stale, exceção, timeout, gate reprovado,
    disputa UMA ativa no mercado — degrada para `source=MARKET_BASELINE`
    (tarefa 3 + intervalo alargado) sem lançar erro ao consumidor. Se nem o
    baseline é válido (book inválido), não há estimativa e o consumidor trata
    ausência como veto. O caminho de fallback é código puro-função testável,
    sem I/O além da leitura do book.

11. **Relatório de calibração automatizado.** Job diário que materializa, por
    categoria e por modelo: Brier/log loss vs baseline com CI, reliability
    plot (dados para o dashboard paper da RFC-011), cobertura do intervalo (o
    intervalo 90% deve conter o desfecho ~90% das vezes — reportar cobertura
    empírica), taxa de fallback e motivos.

### API mínima

- `GET /polymarket/estimates?market_id=&from=&to=` — histórico de estimativas
  com proveniência completa.
- `GET /polymarket/estimates/latest?category=` — última estimativa válida por
  token do universo.
- `GET /polymarket/models` — registry com status e versões.
- `GET /polymarket/models/{id}/calibration` — último relatório (métricas, CI,
  cobertura de intervalo, resultado do gate).
- `POST /polymarket/models/{id}/promote` — só transiciona shadow→active se o
  último gate estiver PASS; caso contrário retorna 409 com o evento
  `NO_EVIDENCE_OF_ALPHA`.
- `POST /polymarket/models/{id}/demote` — kill manual imediato para fallback.

Nenhum endpoint cria ordens, sinais ou toca em wallet/trading.

### Artefatos

- Migrations de `fundamental_models`, `fundamental_estimates` e label store.
- Biblioteca do microprice executável + regras de invalidação (compartilhada
  com as RFC-011/013).
- Modelos `crypto_updown` e `macro_scheduled` com feature pipelines as-of.
- Pipeline walk-forward + bootstrap e gerador do relatório de calibração.
- Implementação do gate com evento `NO_EVIDENCE_OF_ALPHA` auditável.
- Fallback determinístico como função pura testável.
- Endpoints acima integrados à API/dashboard paper da RFC-011.
- Fixtures de mercados resolvidos (incluindo 50/50 e disputados).
- Documento curto "o que este módulo NÃO faz" (sem execução, sem promessa de
  lucro, sem modelo universal).

### Testes obrigatórios

- **Anti-leakage automatizado**: teste que varre todo feature join e falha se
  qualquer feature tiver `source_ts > decision_ts`; teste específico provando
  que `closedTime`/status UMA nunca entra como feature.
- **Determinismo**: mesma entrada + mesma versão de modelo ⇒ bytes idênticos
  de (`q`, `q_lo`, `q_hi`); seeds fixadas e registradas.
- **Intervalo**: nunca mais estreito que a meia-largura do spread executável;
  `q_lo ≤ q ≤ q_hi` sempre; fallback sempre mais largo que o baseline.
- **Fallback**: book stale, feed RTDS stale, exceção no modelo, modelo em
  shadow e disputa UMA ativa ⇒ `MARKET_BASELINE` sem erro; book inválido ⇒
  ausência de estimativa (e não valor default).
- **Gate**: fixture com modelo deliberadamente pior ⇒ `NO_EVIDENCE_OF_ALPHA`
  e promoção bloqueada (409 no endpoint); fixture não-inferior ⇒ PASS.
- **Fronteira de regime**: tentativa de treinar cruzando 28/abr/2026 sem
  `regime_mix` falha; modelo com `regime_mix=true` é inelegível a promoção.
- **Labels**: resolução 0, 1 e 0,5; mercado disputado só ganha label após
  resolução final; degenerados excluídos do headline.
- **Parser macro**: regra inequívoca parseia; regra ambígua é excluída do
  modelo (vai a baseline), com teste de ambos os casos.
- **Proveniência**: toda linha de `fundamental_estimates` com `source=MODEL`
  tem model_version/feature_set_version/git_sha/data_refs não nulos
  (constraint + teste).
- **Orçamento**: soak de 24 h com o universo cheio dentro de 3 GB de RAM e da
  taxa máxima de estimativas; volumetria projetada de 90 dias cabe na quota.
- Busca de código confirma ausência de auth de trading/wallet/ordem real.

### Critérios de aceite

- Para todo token do universo com book válido existe estimativa (`MODEL` ou
  `MARKET_BASELINE`) com intervalo e proveniência completa.
- Nenhum modelo serve estimativa `active` sem gate PASS registrado; falha de
  gate produz `NO_EVIDENCE_OF_ALPHA` auditável e o sistema segue no baseline.
- Relatório de calibração reproduzível a partir das tabelas (sem estado
  oculto), com Brier/log loss vs baseline, CI 95% e cobertura do intervalo.
- Mudança de fee schedule, regra do mercado ou regime dispara re-validação
  (modelo volta a shadow) automaticamente.
- Nenhum caminho de execução real ou paper é criado por esta RFC.
- Retenção dentro da quota local; sem backup externo.

### Condições de parada

Pare se:

- a tarefa evoluir para criar ordens, sinais de execução ou tocar em
  auth/wallet (escopo das RFC-011/009);
- alguém pedir um modelo universal cross-categoria ou validação k-fold;
- o modelo precisar de dado posterior à decisão ou de label não disponível no
  recorder/Gamma sem fonte paga;
- o gate for enfraquecido para "quase não piorar" ou o fallback determinístico
  for removido/condicionado;
- a fronteira de regime de 28/abr/2026 precisar ser ignorada para "ter mais
  dados";
- o orçamento de RAM/storage do módulo for excedido pelo treino ou pelas
  estimativas;
- qualquer componente solicitar private key ou trading credential.
