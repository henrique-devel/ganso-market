# PRD v0.2 — Ganso Market

**Status:** escopo-base aprovado para desenvolvimento  
**Data:** 2026-08-10 (v0.1); caminho único Polymarket em 2026-08-18 (v0.2)  
**Tipo:** ferramenta pessoal, single-user  
**Infraestrutura-alvo:** Hetzner CPX42 — `178.105.65.251`

## Emenda operacional — bootstrap standalone (2026-08-14)

O servidor anterior foi reconstruído. A fundação atual, que expõe apenas a UI
inicial e healthchecks e ainda não possui autenticação, wallet ou execução, pode
rodar diretamente em `0.0.0.0:80`, sem firewall gerenciado pelo projeto, TLS,
domínio ou serviços auxiliares. Os requisitos de perímetro das seções
posteriores precisam ser revistos antes de adicionar login, tokens, dados
privados ou controles de execução.

## Emenda de escopo — atualização 2026 e execução Polymarket (2026-08-15)

Esta emenda incorpora o estudo
[`docs/research/direcao-e-roadmap-bots.md`](research/direcao-e-roadmap-bots.md)
e uma decisão do proprietário. Ela tem precedência sobre trechos anteriores
deste PRD que a contrariem, em especial a premissa de que a Polymarket
permaneceria "analytics e paper trading somente enquanto a operação partir do
Brasil".

**Decisão do proprietário — risco jurisdicional aceito.** A execução real na
Polymarket passa a ser objetivo do projeto, operada a partir de um servidor
dedicado na Alemanha e com uma _burn wallet_ (carteira descartável, capital
limitado, na rede Polygon). O proprietário assume expressamente o risco
jurisdicional e tributário desta escolha.

Registros factuais da pesquisa, mantidos por transparência e a validar com
assessoria jurídica/contábil — **não anulados pela localização do servidor**:

- a elegibilidade da ToS da Polymarket considera a localização/residência do
  usuário, não a do servidor; a seção 2.1.4 trata contorno de geoblock como
  violação autônoma;
- o Brasil está bloqueado pela Polymarket e pela regulação brasileira
  (Resolução CMN 5.298/2026, SPA/Fazenda, bloqueio Anatel) desde abr/mai 2026;
- residência fiscal brasileira tributa renda mundial até a Saída Definitiva
  formalizada; obrigações de reporte (IN 1888 → DeCripto a partir de jul/2026)
  valem mesmo sem imposto devido.

Estes são riscos residuais **aceitos**, não eliminados. A _burn wallet_ limita a
perda máxima por comprometimento ou congelamento; ela não é um mecanismo de
conformidade.

**Proibição técnica mantida.** O software continua proibido de implementar VPN,
proxy, spoofing de localização ou qualquer contorno técnico de geoblock. O
acesso deve partir de infraestrutura real; a presença física e a elegibilidade
legal do operador são responsabilidade do proprietário, fora do escopo do código.

**Atualização de plataforma (Polymarket 2026).** O módulo Polymarket assume
agora CLOB V2 (cutover 28/abr/2026), colateral pUSD (ERC-20 na Polygon, substitui
USDC.e), taxas taker por categoria com makers a custo zero recebendo rebates e
liquidity rewards, e os SDKs atuais (`py-sdk`/`ts-sdk`; `polymarket-cli` em Rust
como referência de assinatura V2). Estratégia preferida: maker-side
(rewards/rebates) e modelos de domínio (clima, macro agendado), com viés
estrutural anti-longshot; latency-taking é não-objetivo.

**Governança preservada.** A disciplina paper-first com gates objetivos
permanece obrigatória. A execução real na Polymarket é implementada pela
RFC-009 e só é liberada após os gates da RFC-007, com canário de capital
pequeno. Assumir o risco de jurisdição não autoriza pular gates de segurança,
contabilidade ou calibração.

## Emenda de escopo — caminho único Polymarket (2026-08-18)

**Decisão do proprietário:** o desenvolvimento passa a seguir um único caminho,
a Polymarket. O módulo Solana (ingestão Yellowstone, decoders Pump/PumpSwap,
hot wallet/signer Solana, paper e execução beta Solana) foi **removido do
escopo** e seus artefatos (RFC-001A, RFC-003, RFC-004, RFC-005, RFC-006,
RFC-008, código de ingestão/decoders do engine, probe e scripts associados)
foram removidos do repositório. O histórico permanece no git; uma retomada
futura exigiria novas RFCs.

Consequências práticas:

- O `market-engine` fica reduzido à fundação (runtime, configuração,
  health/readiness) até que exista lógica Polymarket que o utilize.
- A migration `0003_domain_events.sql` permanece aplicada; suas tabelas ficam
  dormentes e vazias (nada escreve nelas).
- A hot wallet Solana e sua prova de recuperação offline saem dos bloqueios do
  projeto. A única wallet prevista é a burn wallet Polygon da RFC-009.
- O perímetro de autenticação foi aplicado: firewall Hetzner restringindo a
  porta 80 ao IP do operador (modelo 1 do runbook), conta única `owner` criada
  por CLI e login validado em 2026-08-18.

## 1. Visão do produto

O Ganso Market é um painel pessoal para observar mercados da Polymarket,
classificar oportunidades, simular operações e, quando os gates técnicos forem
satisfeitos, executar ordens maker-side limitadas com uma burn wallet dedicada.

O produto deve transformar dados de mercado em decisões reproduzíveis e
explicáveis. Ele não deve prometer lucro, perseguir taxa de acerto isolada nem
tratar retorno de 200x como baixo risco.

## 2. Premissas imutáveis do MVP

- Existe somente um usuário proprietário.
- Não há cadastro público, organizações, tenants, cobrança ou compartilhamento.
- Todo capital é do proprietário.
- O sistema não recebe depósitos de terceiros e não presta serviço financeiro.
- O painel fica acessível em `http://178.105.65.251/` somente com a
  autenticação da RFC-002 e o perímetro aplicado (firewall Hetzner ou TLS).
- O bootstrap publica somente Nginx em IPv4/TCP 80, sem firewall gerenciado
  pelo projeto; a aplicação não publica IPv6 e não há HTTPS, domínio, Certbot
  ou porta 443 nessa etapa.
- A autenticação é senha + access token + refresh token.
- Não haverá MFA ou passkey no MVP.
- Não haverá backup externo automático, HA, failover ou promessa de
  recuperação do histórico.
- Em falha definitiva do SSD, a perda dos dados locais é um risco aceito.
- Polymarket: paper trading obrigatório até os gates; execução real autorizada
  pela emenda de 2026-08-15 (RFC-009), a partir de servidor na Alemanha e burn
  wallet dedicada na Polygon, com risco jurisdicional/tributário assumido pelo
  proprietário. Sem contorno técnico de geoblock.
- A burn wallet vive na Polygon, guarda apenas capital limitado (a perda máxima
  aceita) e sua chave segue disciplina de segredo de signer: nunca em Git,
  banco, logs, fixtures, métricas, frontend ou variáveis de ambiente.

## 3. Objetivos

### O-01 — Visibilidade

Exibir em um único painel:

- saúde dos feeds e do recorder;
- candidatos e oportunidades;
- sinais aceitos e rejeitados;
- posições paper (e live, quando a RFC-009 existir);
- P&L líquido de custos conhecidos;
- limites de risco;
- estado operacional e kill switch;
- saldo e exposição da burn wallet (quando a RFC-009 existir).

### O-03 — Decisão reproduzível

Toda decisão deve registrar dados usados, timestamps de origem e recebimento,
features, versão da estratégia/modelo, limites avaliados e reason codes.

### O-04 — Paper trading realista

Simular execução com custos V2 por categoria, book-walk, latência, falhas e
indisponibilidade de saída. O sistema deve iniciar em paper e permanecer assim
até aprovação manual dos gates.

### O-06 — Polymarket research, paper e execução maker-side

Coletar dados públicos, estimar edge com calibração comprovada, simular ordens
realistas (custos V2, book-walk, resolução/UMA) e — após os gates da RFC-007 —
executar ordens reais maker-first com uma burn wallet dedicada na Polygon,
conforme a RFC-009. Estratégias-alvo: market making para rewards/rebates e
modelos de domínio (clima, macro agendado), com viés anti-longshot.

## 4. Não-objetivos

- SaaS, multiusuário ou multitenancy.
- KYC, AML, billing, assinatura, suporte ou backoffice.
- Custódia ou gestão de fundos de terceiros.
- Aplicativo móvel nativo.
- Saques ou transferências arbitrárias pelo painel.
- Latency-taking ou HFT com SLA de microssegundos.
- Alavancagem, borrow, perp, short, martingale ou averaging down automático.
- LLM local, GPU ou treinamento deep learning no servidor.
- Kubernetes, Kafka, ClickHouse ou microserviços numerosos.
- Alta disponibilidade, réplica regional ou backup externo periódico.
- Contorno técnico de geoblock (VPN, proxy, spoofing de localização).
- Mercados de eleição na Polymarket (excluídos por risco regulatório e de
  oráculo).
- Garantia de lucro, retorno ou disponibilidade de stop-loss.

## 5. Usuário e ambiente

Há uma única persona: o proprietário-operador.

Ele acessa o painel pelo navegador, acompanha o universo coletado, configura
limites abaixo dos tetos do servidor, acompanha decisões, arma ou desarma o
robô (quando existir execução) e pode ativar o kill switch.

### Infraestrutura

O CPX42 possui 8 vCPUs AMD compartilhadas, 16 GB de RAM e 320 GB de SSD. A
carga sustentada alvo é inferior a cinco vCPUs.

O registro operacional do host, acesso SSH e fingerprint informado fica em
[`docs/ops/SERVER_ACCESS.md`](ops/SERVER_ACCESS.md). O checkout de produção usa
`/opt/ganso-market`.

O sistema será um monorepo com poucos processos:

- `market-engine`: runtime fundacional (configuração, health/readiness);
  reservado para lógica de execução futura;
- `api`: autenticação, configuração, leitura do estado e recorder Polymarket;
- `model-worker`: inferência e jobs leves;
- `postgres`: estado operacional, auditoria e histórico recente;
- `web`: frontend estático;
- `nginx`: único proxy publicado no host, em IPv4/TCP 80 no modo standalone.

## 6. Requisitos funcionais

### 6.1 Autenticação

**AUTH-01** Não existe endpoint público de cadastro.  
**AUTH-02** A conta é criada ou recuperada por comando local.  
**AUTH-03** A senha é armazenada com Argon2id.  
**AUTH-04** O access token é opaco, aleatório, revogável e expira em até 15 minutos.  
**AUTH-05** O refresh token é opaco, rotacionado e expira em até sete dias.  
**AUTH-06** No servidor são armazenados somente hashes dos tokens.  
**AUTH-07** O refresh token usa cookie `HttpOnly` e `SameSite=Strict`; `Secure` fica desativado exclusivamente enquanto o beta operar em HTTP.
**AUTH-08** Reutilização de refresh token revoga a sessão.  
**AUTH-09** Logout, troca ou recuperação de senha revogam todas as sessões.  
**AUTH-10** Login possui atraso progressivo e bloqueio temporário.  
**AUTH-11** Operações mutáveis validam CSRF, `Origin` e `Host`.

### 6.2 HTTP no servidor standalone

**NET-01** O painel responde em `http://178.105.65.251/`.
**NET-02** Nginx é o único entrypoint público da aplicação e publica apenas a porta 80.
**NET-03** O bootstrap não instala nem gerencia firewall; Nginx faz bind IPv4 explícito em `0.0.0.0:80`. O perímetro do painel autenticado é responsabilidade do operador (firewall Hetzner ou TLS), conforme o runbook de perímetro.
**NET-04** Nenhum outro serviço ou porta da aplicação é publicado no host.
**NET-05** Não existem certificado, Certbot, ACME, domínio ou porta 443 no MVP.
**NET-06** PostgreSQL, engine, worker, signer e métricas permanecem internos.
**NET-07** Nginx rejeita Host inesperado e respostas aplicam CSP, `X-Content-Type-Options`, política de frame e referrer policy.
**NET-08** O perímetro deve estar aplicado enquanto login, tokens, dados privados ou controles de execução estiverem publicados.
**NET-09** Nginx/Docker não fazem bind em `[::]:80`.

HTTP não criptografa conteúdo. O risco é aceito enquanto houver um único
operador, IP de origem restrito por firewall e capital limitado em burn wallet.

### 6.3 Dados e estado

**DATA-01** Valores monetários usam inteiros/fixed-point ou string decimal canônica na fronteira JSON, nunca float.  
**DATA-02** Todo registro coletado guarda timestamp de origem (`source_ts`) e de recebimento (`received_at`), além da versão das regras de coleta/classificação.  
**DATA-03** Payload inesperado da origem é rejeitado com log estruturado; a coleta se recupera por reconexão, sem derrubar o processo.  
**DATA-04** O banco e arquivos obedecem limites de disco e TTL automáticos.

### 6.4 Oportunidades e modelos

**MODEL-01** Hard vetoes são avaliados antes de qualquer score.  
**MODEL-02** O modelo não pode acessar chave ou assinar transação.  
**MODEL-03** Cada resultado informa confiança, freshness e reason codes.  
**MODEL-06** Modelo ausente, vencido ou não calibrado causa fallback determinístico ou veto explícito.  
**MODEL-07** LLM pode explicar uma decisão calculada, mas não inventar probabilidade, fill ou preço.

### 6.5 Paper trading

**PAPER-01** É o modo padrão em todo boot.  
**PAPER-02** Nunca acessa o signer.  
**PAPER-03** Usa o mesmo `TransactionIntent` e risk guard previstos para live.  
**PAPER-04** Simula custos por categoria, slippage/book-walk, latência, falha e ausência de saída.  
**PAPER-05** Replay com os mesmos inputs e configuração é determinístico.  
**PAPER-06** Nenhum dado posterior ao timestamp da decisão pode influenciar o sinal.

### 6.6 Risco

Defaults do beta, aplicados sobre o capital da burn wallet quando a RFC-009
for implementada:

- entrada máxima: 2%;
- exposição máxima por mercado: 5%;
- perda diária: 3%, seguida de `no-new-risk`;
- drawdown acumulado: 10%, seguido de `signer-denied`;
- nenhuma entrada sem saída simulada;
- sem leverage, martingale ou aumento automático de posição perdedora.

O painel pode reduzir os limites. Aumentos acima dos tetos exigem alteração
local, registro de auditoria e restart desarmado.

### 6.7 Polymarket

**POLY-01** A fase de pesquisa/paper (RFC-007) consome somente APIs públicas e WebSocket de mercado (CLOB V2, Gamma, Data API).
**POLY-02** Colateral é pUSD na Polygon; USDC.e está descontinuado. Assinatura de ordem segue EIP-712 V2 (domínio Exchange v2, auth L1 uma vez + L2 HMAC por request); negRisk usa o verifyingContract correto.
**POLY-03** `execution_mode` do módulo aceita `paper` por padrão; `live` só é habilitado pela RFC-009, depois dos gates, e inicia sempre desarmado após restart.
**POLY-04** A execução real usa uma burn wallet dedicada na Polygon, com capital limitado como perda máxima; a chave nunca aparece em Git, banco, logs, fixtures, métricas, frontend ou variáveis de ambiente.
**POLY-05** Estratégia é maker-first (liquidity rewards + rebates); latency-taking e mercados de eleição são excluídos; viés estrutural anti-longshot.
**POLY-06** A UI distingue claramente posições paper de live e exibe o modo e o kill switch.
**POLY-07** Proibido contorno técnico de geoblock (VPN, proxy, spoofing); o acesso parte do servidor real na Alemanha.
**POLY-08** Custos são modelados por categoria e versão (taker fee dinâmica, spread, gas Polygon, buffer de resolução/UMA); sinal só existe com edge após custos.

## 7. Fluxos principais

### Login

1. Operador acessa `http://<IP>` a partir de origem permitida pelo firewall.
2. Informa usuário e senha.
3. API emite access e refresh tokens.
4. Painel carrega saúde, estado e modo atual.

### Paper

1. O recorder grava mercados e snapshots de livro.
2. Vetos eliminam mercados fora do universo (eleições, longshots estruturais).
3. Estratégia/modelo gera um intent de ordem.
4. Risk guard aprova ou rejeita.
5. Paper broker simula execução com custos V2.
6. Painel exibe decisão, fill simulado e P&L.

### Ativação live (RFC-009)

1. Todas as gates documentadas estão aprovadas.
2. Operador desbloqueia manualmente o material de assinatura após boot.
3. Sistema continua `disarmed`.
4. Operador ativa uma sessão live limitada.
5. Cada intent passa por risk guard, build, validação e signer.
6. Reinício, kill switch ou gate crítica volta ao estado desarmado.

### Kill switch

1. Operador ou regra automática aciona o bloqueio.
2. Novas entradas são recusadas imediatamente.
3. Saídas permanecem permitidas apenas se passarem pelas políticas de saída.
4. Reativação exige ação manual e dados reconciliados.

## 8. Retenção e ausência de backup

Não haverá Object Storage, Storage Box, réplica ou backup automático de
aplicação no MVP.

Orçamento local:

- sistema, imagens e binários: 25 GB;
- PostgreSQL: até 75 GB;
- dados analíticos derivados: até 100 GB;
- logs, modelos e temporários: até 20 GB;
- reserva livre: mínimo de 75 GB.

TTL inicial (implementado pelo restante da RFC-007):

- snapshots de livro brutos: 30 dias;
- registry de mercados: sem TTL (upsert versionado);
- features/agregados: 90 dias;
- decisões, ordens e fills (paper e live): até 1 ano ou até o limite local;
- logs técnicos: 7 dias.

O sistema deve impedir novas entradas quando o disco atingir 85%.

Não fazer backup rotineiro não autoriza armazenar material de assinatura sem
recuperação. A guarda da burn wallet é procedimento do proprietário, fora do
software.

## 9. Requisitos não funcionais

- P95 entre mensagem da origem e persistência do snapshot inferior a dois
  segundos, respeitado o throttle configurado.
- Memória total abaixo de 13 GB em carga normal.
- CPU sustentada abaixo de 65% do CPX42.
- Pelo menos 25% do SSD livre.
- Restart não duplica eventos, posições, intents ou ordens.
- Falha fechada em dados stale, schema desconhecido ou divergência contábil.
- Frontend nunca recebe secrets do signer.

## 10. Critérios de aceite do MVP

### Produto

- Login, logout e renovação funcionam sob o perímetro aplicado.
- IPv4 chega somente ao gateway na porta 80; IPv6 não possui listener da aplicação.
- Dashboard apresenta feeds, oportunidades, risco, posições e decisões.
- O recorder coleta continuamente com TTL aplicado.
- Toda rejeição possui reason code.
- Polymarket opera apenas em paper até os gates da RFC-007 e a RFC-009.

### Segurança

- Varredura encontra somente as portas públicas previstas.
- O deploy publica somente Nginx em `0.0.0.0:80` e mantém serviços internos sem bind no host.
- Não existe serviço publicado na porta 443.
- Busca por padrões e revisão manual não encontram material secreto.
- Transação alterada depois do risk approval é recusada.
- Paper não consegue chamar o signer.
- Restart volta a `disarmed`.

### Confiabilidade

- Replay determinístico.
- Ledger fecha exatamente.
- Duplicatas não criam posição dupla.
- Queda de API, banco ou origem de dados não produz retry cego.
- Kill switch bloqueia nova exposição.
- Teste contínuo de 24 horas não apresenta crescimento ilimitado ou perda silenciosa de eventos críticos.

## 11. Gates para live

Live permanece indisponível até existir evidência de:

- pelo menos 14 dias contínuos de shadow/paper;
- contabilidade conciliada;
- zero duplicidade de intents/ordens;
- custos e slippage modelados;
- simulação de saída funcionando;
- hard vetoes testados;
- signer e validação de ordem revisados;
- teste de restart e kill switch;
- canário manual com limite absoluto definido.

Resultados positivos de paper trading não são evidência suficiente de lucro
futuro.

## 12. Riscos aceitos

- O CPX42 é ponto único de falha.
- CPU compartilhada pode introduzir jitter.
- Sem backup, uma falha de disco pode apagar histórico, configurações e modelos locais.
- Sem HTTPS, conteúdo pode ser interceptado por alguém com visibilidade do caminho de rede; o risco é mitigado pelo firewall de origem única e aceito pelo proprietário.
- Sem MFA, o comprometimento da senha/sessão pode expor o painel.
- Se o host e o signer forem comprometidos ao mesmo tempo, todo o saldo da burn wallet pode ser perdido.
- Stops podem não executar em mercados ilíquidos.

Esses riscos são aceitos apenas enquanto o sistema for pessoal, operar
exclusivamente fundos próprios e manter capital limitado na burn wallet.

## 13. Referências verificadas

- CPX42 e recursos atuais: https://www.hetzner.com/cloud/regular-performance/
- CPU compartilhada da linha CPX: https://docs.hetzner.com/cloud/servers/faq/
- Restrição geográfica da Polymarket: https://help.polymarket.com/en/articles/13364163-geographic-restrictions
- Estudo que fundamenta a emenda de 2026-08-15: [`docs/research/direcao-e-roadmap-bots.md`](research/direcao-e-roadmap-bots.md) e relatórios em [`docs/research/reports/`](research/reports/)
- Polymarket CLOB V2, pUSD e migração: https://docs.polymarket.com/v2-migration
- Reporte cripto DeCripto (IN RFB 2.291/2025): https://kpmg.com/us/en/taxnewsflash/news/2025/12/tnf-brazil-implementation-of-decripto-for-cryptoasset-reporting-under-carf.html
- Prediction markets no Brasil (CMN 5.298/2026 e SPA): https://igamingbusiness.com/legal-compliance/compliance/brazil-prediction-markets-illegal/
