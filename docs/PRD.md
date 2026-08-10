# PRD v0.1 — Ganso Market

**Status:** escopo-base aprovado para desenvolvimento  
**Data:** 2026-08-10  
**Tipo:** ferramenta pessoal, single-user  
**Infraestrutura-alvo:** Hetzner CPX42  

## 1. Visão do produto

O Ganso Market é um painel pessoal para observar mercados, classificar oportunidades, simular operações e, quando os gates técnicos forem satisfeitos, executar operações limitadas com uma hot wallet exclusiva.

O produto deve transformar dados de mercado em decisões reproduzíveis e explicáveis. Ele não deve prometer lucro, perseguir taxa de acerto isolada nem tratar retorno de 200x como baixo risco.

## 2. Premissas imutáveis do MVP

- Existe somente um usuário proprietário.
- Não há cadastro público, organizações, tenants, cobrança ou compartilhamento.
- Todo capital é do proprietário.
- O sistema não recebe depósitos de terceiros e não presta serviço financeiro.
- A hot wallet esperada é `8qE2V1zbcui9RnNsKajVrJ1zS34bMFkumWA9h95Bx8AV`; o endereço foi validado sintaticamente como Base58 de 32 bytes.
- Esse endereço é público. Seed e private key são segredos e nunca devem aparecer no repositório ou nos dados da aplicação.
- O servidor CPX42 é consumidor de Yellowstone/Geyser; não hospeda validator/RPC Agave.
- O painel fica acessível pela internet usando somente o IP público e HTTPS.
- A autenticação é senha + access token + refresh token.
- Não haverá MFA ou passkey no MVP.
- Não haverá backup externo automático, HA, failover ou promessa de recuperação do histórico.
- Em falha definitiva do SSD, a perda dos dados locais é um risco aceito.
- A recuperação da hot wallet continua sendo responsabilidade do proprietário por meio de cópia offline mantida fora do servidor.
- Polymarket é analytics e paper trading somente enquanto a operação partir do Brasil.

## 3. Objetivos

### O-01 — Visibilidade

Exibir em um único painel:

- saúde dos feeds;
- saldo e exposição da hot wallet;
- candidatos e oportunidades;
- sinais aceitos e rejeitados;
- posições paper/live;
- P&L líquido de custos conhecidos;
- limites de risco;
- estado operacional e kill switch.

### O-02 — Pipeline Solana

Consumir Yellowstone filtrado para Pump e PumpSwap, normalizar eventos, manter estado de curvas/pools e selecionar candidatos sem indexar toda a Solana.

### O-03 — Decisão reproduzível

Toda decisão deve registrar dados usados, slot, commitment, features, versão da estratégia/modelo, limites avaliados e reason codes.

### O-04 — Paper trading realista

Simular curva, AMM, taxas, slippage, latência, falhas e indisponibilidade de saída. O sistema deve iniciar em paper e permanecer assim até aprovação manual dos gates.

### O-05 — Execução pessoal limitada

Permitir execução beta em Solana somente por uma hot wallet dedicada, dentro de uma allowlist e depois de simulação e validação integral da transação.

### O-06 — Polymarket research

Coletar dados públicos, estimar edge e executar paper trading sem implementar wallet, depósito ou envio real de ordens.

## 4. Não-objetivos

- SaaS, multiusuário ou multitenancy.
- KYC, AML, billing, assinatura, suporte ou backoffice.
- Custódia ou gestão de fundos de terceiros.
- Aplicativo móvel nativo.
- Saques ou transferências arbitrárias pelo painel.
- Validator/RPC Solana dentro do CPX42.
- Firehose integral da Solana.
- Sniping no primeiro slot ou HFT com SLA de microssegundos.
- Alavancagem, borrow, perp, short, martingale ou averaging down automático.
- LLM local, GPU ou treinamento deep learning no servidor.
- Kubernetes, Kafka, ClickHouse ou microserviços numerosos.
- Alta disponibilidade, réplica regional ou backup externo periódico.
- Execução real em Polymarket no Brasil ou contorno de geoblock.
- Garantia de lucro, retorno ou disponibilidade de stop-loss.

## 5. Usuário e ambiente

Há uma única persona: o proprietário-operador.

Ele acessa o painel pelo navegador, escolhe canais/estratégias, configura limites abaixo dos tetos do servidor, acompanha decisões, arma ou desarma o robô e pode ativar o kill switch.

### Infraestrutura

O CPX42 possui 8 vCPUs AMD compartilhadas, 16 GB de RAM e 320 GB de SSD. A carga sustentada alvo é inferior a cinco vCPUs, preservando margem para picos de ingestão e saídas.

O sistema será um monorepo com poucos processos:

- `market-engine`: Yellowstone, decoders, features, estratégias, risk guard e executor;
- `api`: autenticação, configuração e leitura do estado;
- `model-worker`: inferência e jobs leves;
- `postgres`: estado operacional, auditoria e histórico recente;
- `web`: frontend estático;
- `nginx`: TLS por IP e proxy.

## 6. Requisitos funcionais

### 6.1 Autenticação

**AUTH-01** Não existe endpoint público de cadastro.  
**AUTH-02** A conta é criada ou recuperada por comando local.  
**AUTH-03** A senha é armazenada com Argon2id.  
**AUTH-04** O access token é opaco, aleatório, revogável e expira em até 15 minutos.  
**AUTH-05** O refresh token é opaco, rotacionado e expira em até sete dias.  
**AUTH-06** No servidor são armazenados somente hashes dos tokens.  
**AUTH-07** O refresh token usa cookie `HttpOnly`, `Secure` e `SameSite=Strict`.  
**AUTH-08** Reutilização de refresh token revoga a sessão.  
**AUTH-09** Logout, troca ou recuperação de senha revogam todas as sessões.  
**AUTH-10** Login possui atraso progressivo e bloqueio temporário.  
**AUTH-11** Operações mutáveis validam CSRF, `Origin` e `Host`.  

### 6.2 HTTPS por IP

**NET-01** O painel responde apenas no IP público configurado.  
**NET-02** HTTP na porta 80 existe somente para ACME e redirecionamento.  
**NET-03** Todo acesso de aplicação usa HTTPS na porta 443.  
**NET-04** O certificado cobre o IP e é aceito por navegadores sem instalar CA privada.  
**NET-05** Certificados de IP do Let’s Encrypt são curtos; a renovação deve ser automática e monitorada.  
**NET-06** Somente 80/443 são públicas para a aplicação; PostgreSQL, signer e métricas internas não são expostos.  
**NET-07** Respostas aplicam HSTS, CSP, `X-Content-Type-Options` e política de frame.  

O Let’s Encrypt disponibiliza certificados públicos de IP com validade aproximada de seis dias. A implantação deve usar um cliente ACME compatível, como Certbot 5.4+, e recarregar o proxy depois da renovação:

- https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability.html
- https://letsencrypt.org/2026/03/11/shorter-certs-certbot

### 6.3 Ingestão Solana

**SOL-01** Assinar somente programas e contas em allowlist versionada.  
**SOL-02** O MVP cobre Pump e PumpSwap.  
**SOL-03** Não assinar globalmente Jupiter, Token Program, Token-2022 ou blocos completos.  
**SOL-04** Usar `processed` para descoberta, `confirmed` para candidatos/posições e `finalized` para reconciliação.  
**SOL-05** Deduplicar sem colapsar commitments diferentes.  
**SOL-06** Eventos críticos de posição e saída têm prioridade sobre descoberta.  
**SOL-07** Backpressure nunca bloqueia silenciosamente o receiver.  
**SOL-08** Feed stale ou lag excessivo coloca o sistema em `no-new-risk`.  

### 6.4 Dados e estado

**DATA-01** Valores monetários usam inteiros/fixed-point, nunca float.  
**DATA-02** Todo evento possui chave idempotente, slot, commitment, parser version e payload hash.  
**DATA-03** Real reserves e virtual reserves são campos distintos.  
**DATA-04** Conclusão de curva e migração de pool são estados distintos.  
**DATA-05** Evento desconhecido vai para quarantine e gera alerta.  
**DATA-06** Projeções podem ser reconstruídas a partir dos eventos locais ainda retidos.  
**DATA-07** O banco e arquivos obedecem limites de disco e TTL automáticos.  

### 6.5 Oportunidades e modelos

**MODEL-01** Hard vetoes são avaliados antes de qualquer score.  
**MODEL-02** O modelo não pode acessar chave ou assinar transação.  
**MODEL-03** Cada resultado informa confiança, freshness e reason codes.  
**MODEL-04** Não usar um único score “seguro”; separar token, liquidez, concentração, comportamento e execução.  
**MODEL-05** Os primeiros alvos são sellability, rug/drawdown, graduação e distribuição de retorno líquido.  
**MODEL-06** Modelo ausente, vencido ou não calibrado causa fallback determinístico ou veto explícito.  
**MODEL-07** LLM pode explicar uma decisão calculada, mas não inventar probabilidade, fill ou preço.  

### 6.6 Paper trading

**PAPER-01** É o modo padrão em todo boot.  
**PAPER-02** Nunca acessa o signer.  
**PAPER-03** Usa o mesmo `TransactionIntent` e risk guard previstos para live.  
**PAPER-04** Simula fees, slippage, prioridade, tip, latência, falha e ausência de saída.  
**PAPER-05** Replay com os mesmos inputs e configuração é determinístico.  
**PAPER-06** Nenhum dado posterior ao timestamp da decisão pode influenciar o sinal.  

### 6.7 Hot wallet e execução

**WALLET-01** A chave pública configurada é `8qE2V1zbcui9RnNsKajVrJ1zS34bMFkumWA9h95Bx8AV`.  
**WALLET-02** Na inicialização, o signer deriva a chave pública do keyfile e exige correspondência exata.  
**WALLET-03** Private key/seed não aparecem em Git, banco, logs, fixtures, métricas, frontend ou variáveis de ambiente.  
**WALLET-04** A chave fica em keyfile criptografado, com permissões do usuário exclusivo do signer.  
**WALLET-05** O unlock é manual após todo restart; a chave descriptografada permanece somente em memória.  
**WALLET-06** Não há recarga automática. O saldo da hot wallet é o limite máximo de perda por comprometimento do host.  
**WALLET-07** A única cópia de recuperação da wallet é mantida offline pelo proprietário; a aplicação não a cria nem transmite.  
**WALLET-08** Toda estratégia produz apenas um `TransactionIntent`.  
**WALLET-09** O signer redecodifica os bytes e compara todas as instruções ao intent.  
**WALLET-10** Programa, mint, pool, destino, ALT ou instrução desconhecida é rejeitado.  
**WALLET-11** Toda transação é simulada imediatamente antes de assinar.  
**WALLET-12** Live inicia desarmado depois de restart e exige ativação manual.  
**WALLET-13** O painel não oferece saque ou transferência livre.  

### 6.8 Risco

Defaults do beta, aplicados sobre o patrimônio líquido da hot wallet:

- entrada máxima: 2%;
- exposição máxima por ativo: 5%;
- perda diária: 3%, seguida de `no-new-risk`;
- drawdown acumulado: 10%, seguido de `signer-denied`;
- slippage máximo: 2%;
- impacto estimado máximo: 1%;
- nenhuma entrada sem saída simulada;
- reserva mínima de SOL para taxas e saída;
- sem leverage, martingale ou aumento automático de posição perdedora.

O painel pode reduzir os limites. Aumentos acima dos tetos exigem alteração local, registro de auditoria e restart desarmado.

### 6.9 Polymarket

**POLY-01** Consumir somente APIs públicas e WebSocket de mercado.  
**POLY-02** Não implementar autenticação CLOB, wallet, bridge, relayer, depósito ou endpoint real de ordem.  
**POLY-03** `execution_mode` aceita somente `paper` no módulo Polymarket.  
**POLY-04** UI marca todas as posições como simulação.  
**POLY-05** Qualquer execução futura exige nova RFC e revisão de jurisdição.  

## 7. Fluxos principais

### Login

1. Operador acessa `https://<IP>`.
2. Informa usuário e senha.
3. API emite access e refresh tokens.
4. Painel carrega saúde, estado e modo atual.

### Paper

1. Engine recebe e normaliza eventos.
2. Vetos eliminam candidatos estruturalmente inválidos.
3. Estratégia/modelo gera um intent.
4. Risk guard aprova ou rejeita.
5. Paper broker simula execução.
6. Painel exibe decisão, fill simulado e P&L.

### Ativação live beta

1. Todas as gates documentadas estão aprovadas.
2. Operador desbloqueia manualmente o keyfile após boot.
3. Sistema continua `disarmed`.
4. Operador ativa uma sessão live limitada.
5. Cada intent passa por risk guard, build, decode, simulação e signer.
6. Reinício, kill switch ou gate crítica volta ao estado desarmado.

### Kill switch

1. Operador ou regra automática aciona o bloqueio.
2. Novas entradas são recusadas imediatamente.
3. Saídas permanecem permitidas apenas se passarem pelas políticas de saída.
4. Reativação exige ação manual e dados reconciliados.

## 8. Retenção e ausência de backup

Não haverá Object Storage, Storage Box, réplica ou backup automático de aplicação no MVP.

Orçamento local:

- sistema, imagens e binários: 25 GB;
- PostgreSQL: até 75 GB;
- Parquet normalizado: até 100 GB;
- WAL/spool/raw curto: até 25 GB;
- logs, modelos e temporários: até 20 GB;
- reserva livre: mínimo de 75 GB.

TTL inicial:

- raw geral: 1–4 horas;
- raw de candidatos: até 24 horas;
- eventos normalizados detalhados: 7 dias;
- agregados de 1 segundo: 7–14 dias;
- candles/features de 1 minuto: 90 dias;
- decisões, ordens e fills: até 1 ano ou até o limite local;
- logs técnicos: 7 dias.

O sistema deve impedir novas entradas quando o disco atingir 85%. Raw e telemetria não críticos podem ser descartados conforme prioridade.

Não fazer backup rotineiro não autoriza armazenar a private key sem recuperação. A cópia offline da wallet é um procedimento do proprietário, fora do software.

## 9. Requisitos não funcionais

- Meta de 100–300 transações Solana filtradas/s.
- Burst de 1.500 transações/s por 30 segundos sem perda de P0/P1.
- P95 entre evento upstream e normalização inferior a dois segundos no envelope-alvo.
- Memória total abaixo de 13 GB em carga normal.
- CPU sustentada abaixo de 65% do CPX42.
- Pelo menos 25% do SSD livre.
- Restart não duplica eventos, posições, intents ou ordens.
- Falha fechada em dados stale, schema desconhecido ou divergência contábil.
- Frontend nunca recebe secrets do signer.

## 10. Critérios de aceite do MVP

### Produto

- Login, logout e renovação de sessão funcionam pelo IP HTTPS.
- Dashboard apresenta feeds, oportunidades, risco, posições e decisões.
- Pump/PumpSwap são decodificados com fixtures verificadas.
- As duas estratégias iniciais funcionam em paper: pós-validação e graduação/reteste.
- Toda rejeição possui reason code.
- Polymarket funciona apenas em paper.

### Segurança

- Varredura encontra somente as portas públicas previstas.
- Certificado de IP é confiável e renovado automaticamente.
- Busca por padrões e revisão manual não encontram material secreto.
- O signer recusa keyfile cuja pubkey não corresponda ao endereço configurado.
- Transação alterada depois do risk approval é recusada.
- Paper não consegue chamar o signer.
- Restart volta a `disarmed`.

### Confiabilidade

- Replay determinístico.
- Ledger fecha exatamente.
- Duplicatas e forks não criam posição dupla.
- Queda de API, banco ou RPC não produz retry cego.
- Kill switch bloqueia nova exposição.
- Teste contínuo de 24 horas não apresenta crescimento ilimitado ou perda silenciosa de eventos críticos.

## 11. Gates para live beta

Live permanece indisponível até existir evidência de:

- pelo menos 14 dias contínuos de shadow/paper;
- contabilidade conciliada;
- zero duplicidade de intents/ordens;
- custos e slippage modelados;
- simulação de saída funcionando;
- hard vetoes e allowlists testados;
- signer e transaction decoder revisados;
- teste de restart e kill switch;
- canário manual com limite absoluto definido.

Resultados positivos de paper trading não são evidência suficiente de lucro futuro.

## 12. Riscos aceitos

- O CPX42 é ponto único de falha.
- CPU compartilhada pode introduzir jitter.
- Sem backup, uma falha de disco pode apagar histórico, configurações e modelos locais.
- Sem MFA, o comprometimento da senha/sessão pode expor o painel.
- Se o host e o signer forem comprometidos ao mesmo tempo, todo o saldo da hot wallet pode ser perdido.
- Stops podem não executar em tokens ilíquidos.

Esses riscos são aceitos apenas enquanto o sistema for pessoal, operar exclusivamente fundos próprios e manter capital limitado na hot wallet.

## 13. Referências verificadas

- CPX42 e recursos atuais: https://www.hetzner.com/cloud/regular-performance/
- CPU compartilhada da linha CPX: https://docs.hetzner.com/cloud/servers/faq/
- Requisitos que impedem usar o CPX42 como validator/RPC Agave: https://docs.anza.xyz/operations/requirements
- Certificados públicos de IP: https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability.html
- Certbot para certificado de IP: https://letsencrypt.org/2026/03/11/shorter-certs-certbot
- Restrição geográfica da Polymarket: https://help.polymarket.com/en/articles/13364163-geographic-restrictions
