# RFC-007 — Polymarket analytics e paper trading (CLOB V2)

**Status:** draft (atualizada pela emenda de PRD de 2026-08-15)
**Dependências:** RFC-001 e RFC-002  
**Habilita:** RFC-009 (execução live) somente após os gates desta RFC

## Prompt a executar

Você deve implementar a RFC-007 do Ganso Market: módulo Polymarket de analytics
e paper trading sobre a plataforma CLOB V2. Esta RFC é a fundação de dados,
calibração e simulação; a execução real fica na RFC-009 e não é implementada
aqui.

### Objetivo

Descobrir mercados, gravar livros/regras/trades desde o dia 1, estimar
probabilidade/edge com baseline transparente e calibração comprovada, gerar
sinais explicáveis e simular ordens realistas com o fee schedule V2 — sem
autenticação de trading e sem broadcast.

### Restrição não negociável

- Nesta RFC não implementar autenticação CLOB L1/L2 de trading, burn wallet,
  signer, bridge, relayer, depósito, approvals ou chamadas reais de ordem —
  isso é escopo da RFC-009.
- Não implementar proxy/VPN/spoofing/evasão de geoblock em nenhuma RFC. O acesso
  parte de infraestrutura real (servidor na Alemanha); presença física e
  elegibilidade legal do operador são responsabilidade do proprietário
  (risco jurisdicional aceito na emenda de PRD de 2026-08-15).
- `execution_mode` do módulo aceita somente `paper` nesta RFC.
- Não esconder código real de execução atrás de feature flag.
- UI exibe “SIMULAÇÃO — SEM EXECUÇÃO REAL” nesta fase.

### Regime de plataforma (Polymarket 2026 — verificar na doc oficial)

- CLOB V2 (cutover 28/abr/2026): contratos `ctf-exchange-v2`; SDKs atuais
  `py-sdk`/`ts-sdk` e `py-clob-client-v2`/`clob-client-v2`; os clientes V1 estão
  arquivados. Usar `polymarket-cli` (Rust) como referência de assinatura V2.
- Colateral é pUSD (ERC-20 na Polygon), não USDC.e.
- Taxas taker dinâmicas por categoria (pico perto de preço 0,50), makers a custo
  zero com rebates; geopolítica grátis. Versione o schedule como dado.
- negRisk usa verifyingContract próprio; ler o flag `neg_risk` antes de qualquer
  cálculo dependente de contrato.
- Tratar 28/abr/2026 como fronteira dura de regime em qualquer histórico.

### Orçamento

- 50–100 mercados / 100–200 token IDs.
- Até 40 GB do PostgreSQL.
- Aplicações Polymarket até 3 GB de RAM em carga.
- Sem Redis inicialmente; manter livro atual em memória com limites.
- Sem backup externo.
- Sem L2 bruto de todo o universo.
- Sem LLM local.

### Fontes permitidas

- Gamma API para catálogo/regras.
- CLOB REST público para snapshot, bid/ask, spread, tick e histórico.
- CLOB Market WebSocket para livro/trades/status.
- Data API pública para métricas necessárias.
- RTDS para mercados crypto selecionados.
- Dados públicos on-chain quando necessários.

Verifique documentação oficial atual antes de fixar endpoints/schemas.

### Universo inicial

- Categorias-alvo: crypto up/down, macro agendado e clima/temperatura (dados
  abertos ECMWF/Open-Meteo/NWS, baixa competição de latência).
- Excluir mercados de eleição, live sports, augmented neg-risk/Other, regras
  vazias/ambíguas e livros insuficientes.
- Gamma a cada 10 minutos.
- Snapshot REST no subscribe/reconnect.
- WebSocket somente do universo selecionado.
- Reconciliação periódica.
- Top-10 do livro persistido a cada 2–5 segundos, não cada delta de todo o mercado.

### Recorder primeiro (o gravador vem antes da estratégia)

- Não existe histórico L2 profundo barato e o `/prices-history` oficial degrada
  para ~12h em mercados resolvidos; portanto grave o firehose próprio (livro
  top-10, trades, status) desde o primeiro deploy do módulo.
- Backfill de metadados/resolução via Gamma + Dune (free tier); para calibrar o
  modelo de slippage, considerar um mês de um arquivo L2 de terceiros
  (ex.: DepthFeed) contra ladders reais.
- Persistir o schedule de fees vigente junto de cada decisão, para replay fiel.

### Tarefas

1. Criar market registry com IDs canônicos.
2. Versionar regras, fonte, datas, fees, tick, neg-risk e status.
3. Registrar source_ts e received_ts.
4. Reconstruir livro após reconnect.
5. Criar baseline:
   - probabilidade do mercado usando bid/ask/microprice executável;
   - regressão logística regularizada opcional (walk-forward, nunca k-fold);
   - calibração temporal com Brier e log loss;
   - fallback para mercado;
   - o mercado é bem calibrado na média, então o modelo só é promovido se não
     piorar Brier/log loss no holdout; enquanto não houver track record
     (Brier < ~0,20 em 100+ mercados resolvidos), sinais dependentes de modelo
     ficam desabilitados e vale o baseline de mercado.
   - modelo de domínio para clima: probabilidade por bucket a partir de ensemble
     (GFS/ECMWF) vs preço de mercado.
6. Features:
   - spread/profundidade;
   - imbalance;
   - flow;
   - volatilidade;
   - volume/open interest;
   - tempo até resolução;
   - risco de regra/fonte;
   - relações lógicas entre mercados.
7. Calcular:
   - `EV_yes = q - ask_yes - custos - resolution_buffer`;
   - `EV_no = (1-q) - ask_no - custos - resolution_buffer`.
8. Sinal somente quando limite inferior ainda tiver edge após custos e vetos.
   - viés estrutural anti-longshot: rejeitar/penalizar compras de contratos
     muito baratos (ex.: < 10¢), que perdem em média; preferir favoritos/NO;
   - preferência maker: modelar o sinal como quote passiva (fee zero + rebates),
     não como taker, sempre que a estratégia permitir;
   - agrupar mercados correlacionados (mesmo evento/resolução) e limitar a
     exposição combinada do grupo (ex.: 20–25% da banca), dimensionando o grupo
     como uma aposta só (Kelly fracionário como teto).
9. Criar simulador:
   - book walk;
   - partial fills;
   - fee schedule versionado;
   - latência;
   - ordem passiva atrás da fila visível;
   - cancelamento;
   - resolução 0/1/0,5.
10. Criar ledger paper e posições marcadas pelo bid de liquidação.
11. Criar API/dashboard de mercados, sinais, posições, P&L e kill.
12. Implementar TTL local:

- L2/raw selecionado 7 dias;
- snapshots top-10 30 dias;
- agregados 1 min/regras/decisões até limite local;
- pruning quando atingir quota.

### API mínima

- `GET /polymarket/markets`
- `GET /polymarket/markets/{id}`
- `GET /polymarket/signals`
- `POST /polymarket/paper/orders`
- `DELETE /polymarket/paper/orders/{id}`
- `GET /polymarket/paper/positions`
- `GET /polymarket/paper/performance`
- `POST /polymarket/paper/kill-switch`

Nenhum endpoint de trading/wallet/deposit.

### Artefatos

- Collectors e registry.
- Rule versioning.
- Book cache.
- Feature/baseline pipeline.
- Simulador e ledger.
- API/dashboard paper.
- Fixtures.
- Relatório de calibração.
- Testes.
- Documento explícito de ausência de execução.

### Testes obrigatórios

- Snapshot+deltas recompõem livro.
- Reconnect, duplicate, out-of-order, 429/425/5xx.
- Fee, book walk, slippage e edge.
- Partial/passive fill conservador.
- YES, NO e resolução 50/50.
- Regra alterada/versionada.
- Look-ahead e survivorship.
- Boot falha se mode não for paper.
- Busca de código confirma ausência de auth/wallet/order real.
- Soak de 24 horas dentro do orçamento.

### Critérios de aceite

- Baseline de mercado sempre disponível quando o livro é válido.
- Modelo só é promovido se não piorar Brier/log loss no holdout.
- Falha da gate mantém baseline e registra `NO_EVIDENCE_OF_ALPHA`.
- Livro stale ou regra ambígua impede sinal.
- Não existe caminho de execução real.
- Sem backup externo ou retenção ilimitada.

### Condições de parada

Pare se:

- a tarefa pedir execução real nesta RFC (é escopo da RFC-009) ou qualquer
  contorno técnico de geoblock (VPN/proxy/spoofing);
- API/schema oficial V2 não puder ser verificado;
- o simulador precisar presumir fill otimista;
- modelo usar dado posterior à decisão;
- retenção ultrapassar quota local;
- algum componente solicitar private key ou trading credential nesta fase.
