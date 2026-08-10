# RFC-007 — Polymarket analytics e paper trading

**Status:** draft  
**Dependências:** RFC-001, RFC-002 e RFC-004  
**Pode avançar em paralelo com:** RFC-005/RFC-006 após os contratos comuns  

## Prompt a executar

Você deve implementar a RFC-007 do Ganso Market: módulo Polymarket estritamente analytics e paper trading.

### Objetivo

Descobrir mercados, acompanhar livros/regras, estimar probabilidade/edge com baseline transparente, gerar sinais explicáveis e simular ordens sem autenticação de trading.

### Restrição não negociável

- Brasil está bloqueado para trading pela Polymarket:
  https://help.polymarket.com/en/articles/13364163-geographic-restrictions
- Não implementar CLOB auth L1/L2, wallet, signer, bridge, relayer, depósito, approvals ou chamadas reais de ordem.
- Não implementar proxy/VPN/evasão.
- `execution_mode` do módulo aceita somente `paper`.
- Não esconder código real atrás de feature flag.
- UI exibe “SIMULAÇÃO — SEM EXECUÇÃO REAL”.

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

- Uma ou duas categorias: crypto e macro agendado.
- Excluir live sports, augmented neg-risk/Other, regras vazias/ambíguas e livros insuficientes.
- Gamma a cada 10 minutos.
- Snapshot REST no subscribe/reconnect.
- WebSocket somente do universo selecionado.
- Reconciliação periódica.
- Top-10 do livro persistido a cada 2–5 segundos, não cada delta de todo o mercado.

### Tarefas

1. Criar market registry com IDs canônicos.
2. Versionar regras, fonte, datas, fees, tick, neg-risk e status.
3. Registrar source_ts e received_ts.
4. Reconstruir livro após reconnect.
5. Criar baseline:
   - probabilidade do mercado usando bid/ask/microprice executável;
   - regressão logística regularizada opcional;
   - calibração temporal;
   - fallback para mercado.
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

- a tarefa pedir execução real/geoblock bypass;
- API/schema oficial não puder ser verificado;
- o simulador precisar presumir fill otimista;
- modelo usar dado posterior à decisão;
- retenção ultrapassar quota local;
- algum componente solicitar private key ou trading credential.
