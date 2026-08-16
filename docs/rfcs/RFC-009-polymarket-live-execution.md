# RFC-009 — Execução Polymarket maker-side (CLOB V2)

**Status:** draft, não autorizado para implementação antecipada
**Dependências:** RFC-002, RFC-004 e RFC-007 implementadas + aprovação explícita
**Reaproveita:** contratos de risco/intent e disciplina de signer da RFC-005
**Habilitada por:** emenda de PRD de 2026-08-15 (risco jurisdicional aceito)

## Contexto e risco aceito

O proprietário decidiu operar execução real na Polymarket a partir de um servidor
dedicado na Alemanha, com uma *burn wallet* na Polygon (capital limitado, perda
máxima aceita). O risco jurisdicional e tributário é assumido pelo proprietário e
está registrado na emenda de PRD de 2026-08-15.

Fatos que **permanecem verdadeiros** e não são anulados pela localização do
servidor (a validar com assessoria, não com código):

- a elegibilidade da ToS considera a residência/localização do usuário, não a do
  servidor; contorno de geoblock é violação autônoma (ToS 2.1.4);
- o Brasil está bloqueado pela Polymarket e pela regulação brasileira;
- residência fiscal brasileira tributa renda mundial e exige reporte (DeCripto).

A *burn wallet* limita a perda; não é mecanismo de conformidade. Esta RFC não
implementa VPN, proxy, spoofing ou qualquer contorno técnico de geoblock: o
acesso parte de infraestrutura real.

## Pré-condição absoluta

Antes de editar:

1. Confirme os gates da RFC-007: recorder ativo, calibração com Brier/log loss em
   100+ mercados resolvidos, P&L simulado positivo **líquido de custos V2** por
   estratégia e por categoria, 14 dias de paper contínuo e reconciliação exata.
2. Confirme a decisão de jurisdição registrada e o parecer jurídico/tributário
   obtido pelo proprietário.
3. Confirme que a burn wallet existe na Polygon, com capital limitado e cópia de
   recuperação offline mantida pelo proprietário fora do servidor.
4. Solicite aprovação explícita do proprietário para iniciar o beta live.

Se qualquer evidência faltar, pare. Não crie bypass, mock ou flag temporária.

## Objetivo

Converter sinais maker aprovados pela RFC-007 em ordens reais na Polymarket CLOB
V2, assinar off-chain (EIP-712 V2), enviar, acompanhar fills pelo WebSocket de
usuário, reconciliar posições e P&L, e encerrar de forma ordenada quando um
circuit breaker disparar — priorizando o lado maker (fee zero + rebates).

## Identidade e segredo da burn wallet

- Rede Polygon (EVM); ativo de colateral é pUSD (ERC-20).
- A chave pública configurada da burn wallet aparece em UI/logs; seed e private
  key são segredos absolutos.
- O signer deriva o endereço do segredo desbloqueado e falha se não corresponder
  exatamente ao endereço configurado.
- Keyfile criptografado com biblioteca auditada; passphrase informada
  interativamente; descriptografia só em memória; bloqueado após todo restart.
- Private key/seed nunca em Git, banco, logs, fixtures, métricas, core dump,
  frontend ou variáveis de ambiente.
- A burn wallet guarda apenas capital limitado (a perda máxima aceita) mais um
  mínimo de POL para gas de operações on-chain (approval, split/merge, redeem).
- Sem auto-refill. O painel não oferece saque/transferência livre nem bridge
  arbitrária.

## Autenticação e assinatura (V2 — verificar na doc oficial)

- L1: uma assinatura EIP-712 única da wallet deriva apiKey/secret/passphrase.
- L2: header HMAC-SHA256 por request autenticado (timestamp em segundos Unix).
- Assinatura de ordem: struct EIP-712 do domínio Exchange versão "2" (campos V2:
  sem `nonce`/`feeRateBps`/`taker`; com `timestamp` em ms, `metadata`, `builder`).
- negRisk usa verifyingContract próprio; ler o flag `neg_risk` antes de assinar,
  ou a ordem é rejeitada.
- Tipos de ordem: GTC/GTD/FOK/FAK. Preferir ordens passivas (maker) por preço.

## Restrições

- Somente a burn wallet configurada na Polygon.
- Maker-first: modelar entradas como quotes passivas; taker apenas quando a
  política explicitamente permitir e o edge cobrir a taker fee da categoria.
- Sem leverage, perps, borrow, martingale, averaging down ou retry agressivo.
- Mercados de eleição excluídos; live sports fora do universo inicial.
- Live desligado após todo restart; signer manualmente desbloqueado; grant de
  sessão live só em memória, com TTL.
- O signer redecodifica a ordem e compara ao intent aprovado; não confia no
  resumo da estratégia.
- Custos versionados por categoria (taker fee dinâmica, spread, gas, buffer de
  resolução/UMA); ordem que perde edge após custos é rejeitada.
- Sem contorno de geoblock. Sem bridge/depósito automático de terceiros.
- Não adicionar HA, backup externo ou infraestrutura distribuída nesta RFC.

## State machine da ordem

- `proposed`
- `risk_rejected`
- `awaiting_arm`
- `approved`
- `signed`
- `submitted`
- `open`
- `partially_filled`
- `filled`
- `cancel_requested`
- `cancelled`
- `market_resolved`
- `redeemed`
- `reconciled`
- `failed`
- `expired`

## Risk guard (reaproveita contratos da RFC-005)

Aplicar antes de assinar, de forma determinística:

- limite por ordem/mercado (dentro dos tetos do PRD);
- exposição por mercado e por **grupo correlacionado** (mesmo evento/resolução),
  cap combinado do grupo em ~20–25% da banca, dimensionado como uma aposta só;
- Kelly fracionário (¼–½) como teto, nunca alvo;
- viés anti-longshot (rejeitar/penalizar compras muito baratas);
- perda diária → `no-new-risk`; drawdown → `signer-denied`;
- edge mínimo após custos e buffer de resolução/UMA;
- reserva mínima de POL para gas e para redeem/saída;
- freshness do livro; livro stale ou regra ambígua impede ordem.

## Tarefas

1. Cliente CLOB V2 (auth L1/L2, assinatura EIP-712 V2, negRisk, tipos de ordem).
2. Adapter de burn wallet/signer isolado (Unix socket, keyfile, unlock manual).
3. Construção de ordem a partir do sinal maker aprovado, com hash de intent.
4. Revalidação pré-assinatura: mercado/condition id, `neg_risk`, preço/tamanho,
   fee estimada da categoria, saldo pUSD e POL, snapshot de risco, hash do intent.
5. Envio, acompanhamento por WebSocket de usuário (fills/cancels), expiry.
6. Cancelamento rápido (defesa contra adverse selection) e inventory caps.
7. Redeem/settle on-chain após resolução; reconciliação de posições e P&L.
8. Circuit breakers (seção abaixo) e kill switch local + pela aplicação autenticada.
9. Controle arm/disarm: unlock do signer, confirmação visual explícita, grant em
   memória com TTL; restart/kill/erro crítico revoga o grant.
10. Rollout: paridade com paper → canário de capital mínimo → micro-live → escala.
11. Relatório por ordem: intent, decisão de risco, assinatura, fills, custos,
    rebates/rewards e resultado.

## Circuit breakers

Disparam parada de novas entradas (saídas/cancelamentos preservados):

- livro stale ou lag excessivo;
- disputa/ambiguidade de resolução (risco de oráculo UMA) no mercado;
- mudança de schedule de fees ou de contrato (regime novo não versionado);
- divergência contábil entre estado interno e API;
- perda diária/drawdown acima do limite;
- **detecção de close-only/bloqueio da jurisdição**: se a plataforma mover o país
  para close-only ou bloquear a conta, entrar em wind-down ordenado (encerrar
  posições e sacar quando possível), sem novas entradas.

## Wind-down ordenado

A lista de países da Polymarket é volátil. O sistema deve, a qualquer momento,
ser capaz de: parar novas entradas, cancelar quotes abertas, encerrar posições
pelas políticas de saída e permitir saque — sem depender de o país permanecer
elegível. Não acumular capital grande na plataforma.

## API mínima

- `GET /polymarket/live/markets`
- `GET /polymarket/live/positions`
- `GET /polymarket/live/performance`
- `POST /polymarket/live/orders` (maker)
- `DELETE /polymarket/live/orders/{id}`
- `POST /polymarket/live/arm`
- `POST /polymarket/live/disarm`
- `POST /polymarket/live/kill-switch`
- `POST /polymarket/live/wind-down`

Nenhum endpoint de saque/transferência livre ou de assinatura por HTTP.

## Artefatos

- Cliente CLOB V2 e assinatura EIP-712 V2.
- Burn wallet/signer isolado e runbook de unlock/lock/rotação/perda.
- Risk guard integrado (contratos RFC-005).
- Order state machine persistida.
- Gestor de fills/cancel/redeem/reconciliação.
- Circuit breakers e wind-down.
- Controle arm/disarm com TTL.
- Dashboard live com distinção clara paper vs live.
- Checklist de canário e rollback.
- Testes adversariais e runbook de incidente.

## Testes obrigatórios

- Assinatura EIP-712 V2 válida; ordem alterada após aprovação é recusada.
- negRisk com verifyingContract correto vs incorreto.
- Endereço derivado diferente do configurado bloqueia o unlock.
- Busca em Git/banco/logs/processos/fixtures não encontra segredo.
- Livro stale, regra ambígua e disputa de resolução impedem ordem.
- Fee/edge abaixo do limite rejeita a ordem.
- Fill parcial, cancelamento e redeem pós-resolução reconciliam exatamente.
- Duplicate submit não cria posição dupla.
- Restart entre cada estado; live nunca rearma sozinho.
- Perda diária/drawdown/kill switch/grant expirado/signer locked.
- Simulação de close-only da jurisdição dispara wind-down.
- Paper e live compartilham o mesmo risk path.

## Critérios de aceite

- Nenhuma ordem sem sinal aprovado, risk approval, decode e revalidação.
- Live inicia sempre desarmado após restart e exige unlock + arm manual.
- Contabilidade fecha; duplicatas não criam posição dupla.
- Custos (taker fee, spread, gas, buffer de resolução) modelados e comparados ao
  paper; rebates/rewards contabilizados.
- Canário respeita o limite absoluto definido pelo proprietário.
- Wind-down funciona sem depender de elegibilidade contínua do país.
- Nenhum código de contorno de geoblock, saque livre ou bridge arbitrária.

## Condições de parada

Não ative live se:

- os gates da RFC-007 estiverem incompletos;
- faltar aprovação explícita do proprietário;
- segredo da burn wallet estiver exposto;
- a ordem não puder ser totalmente decodificada/revalidada;
- idempotência/reconciliação falhar;
- for solicitado contorno de geoblock, saque livre, leverage ou perps;
- o wind-down não estiver testado;
- o canário ultrapassar limites ou produzir ledger divergente.
