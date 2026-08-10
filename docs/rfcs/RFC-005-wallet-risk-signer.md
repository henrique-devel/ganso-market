# RFC-005 — Hot wallet, risk guard e signer local

**Status:** draft  
**Dependências:** RFC-001 e RFC-004  
**Bloqueia:** RFC-008  

## Prompt a executar

Você deve implementar a RFC-005 do Ganso Market: proteção da hot wallet pessoal, risk guard determinístico e signer local isolado.

### Objetivo

Criar uma fronteira na qual estratégia e API somente produzem intents, enquanto um processo separado decodifica e valida cada transação antes de assinar. Nesta RFC não envie transações mainnet.

### Identidade da wallet

- Chave pública esperada: `8qE2V1zbcui9RnNsKajVrJ1zS34bMFkumWA9h95Bx8AV`, já validada sintaticamente como Base58 de 32 bytes.
- A chave pública é configuração e pode aparecer em UI/logs.
- Seed e private key são segredos absolutos.
- O signer deve derivar a pubkey do segredo desbloqueado e falhar se ela não for exatamente a esperada.

### Modelo local aceito

- Signer no mesmo CPX42, mas em processo e usuário Linux próprios.
- Comunicação por Unix domain socket com permissões mínimas.
- Keyfile criptografado usando formato/biblioteca existente e auditada; não invente criptografia.
- Passphrase informada interativamente, nunca em argumento de processo, env, banco ou arquivo de configuração.
- Descriptografia somente em memória.
- Depois de boot/restart, signer bloqueado até unlock manual.
- Não existe auto-unlock nem auto-refill.
- A recuperação offline da wallet é responsabilidade do proprietário e não é criada pela aplicação.

### Restrições

- Não armazenar segredo em PostgreSQL, Git, logs, fixtures, core dump, crash report ou frontend.
- Não usar o arquivo JSON plaintext padrão do Solana CLI como storage permanente.
- Não criar endpoint HTTP de assinatura.
- Não criar endpoint de saque/transferência arbitrária.
- Somente Pump/PumpSwap nesta fase.
- Sem Jupiter arbitrário, leverage, borrow, perp, martingale ou averaging down.
- O signer não confia no resumo da estratégia: redecodifica bytes, ALTs e contas.
- Mainnet broadcast permanece inexistente até RFC-008.
- Não adicionar HSM/MPC, remote signer ou multiusuário.

### Tarefas

1. Produzir threat model enxuto:
   - roubo de sessão web;
   - API comprometida;
   - strategy/model comprometido;
   - substituição de transação;
   - ALT maliciosa;
   - replay/duplicidade;
   - SSRF e exfiltração;
   - host comprometido;
   - core dump/log;
   - perda do SSD.
2. Definir contratos:
   - `TransactionIntent`;
   - `RiskSnapshot`;
   - `PolicyDecision`;
   - `UnsignedTransactionCandidate`;
   - `SignerRequest`;
   - `SignerResponse`.
3. Implementar state machine operacional:
   - `locked`;
   - `unlocked-disarmed`;
   - `paper`;
   - `no-new-risk`;
   - `signer-denied`.
4. Implementar importação única/local de secret para keyfile criptografado sem imprimir o segredo.
5. Implementar unlock via TTY/`systemd-ask-password` ou mecanismo equivalente sem plaintext intermediário.
6. Desabilitar core dumps no processo signer e aplicar permissões de arquivo/socket.
7. Validar pubkey esperada no unlock.
8. Criar risk guard determinístico com:
   - limite por trade;
   - exposição por token;
   - perda diária;
   - drawdown;
   - slippage;
   - price impact;
   - fee/tip;
   - reserva mínima de SOL;
   - limite de posições;
   - freshness;
   - allowlist de programa/mint/pool;
   - hard vetoes de authority/Token-2022/liquidez.
9. Antes de assinar, resolver e validar:
   - cluster;
   - fee payer;
   - blockhash/expiry;
   - program IDs;
   - todas as instructions e inner assumptions relevantes;
   - ALTs/endereço carregado;
   - writable accounts;
   - mints, pools e vaults;
   - transferências SOL/token;
   - compute limit/price e tip;
   - min-out/max-in;
   - gasto total;
   - hash do intent aprovado.
10. Criar idempotency key e proteção anti-replay.
11. Registrar audit log append-only sem bytes secretos.
12. Criar kill switch local e pela aplicação autenticada.
13. Manter paper completamente incapaz de conectar ao socket do signer.

### Defaults de risco

- trade: máximo 2% do patrimônio da hot wallet;
- ativo: máximo 5%;
- perda diária: 3% -> `no-new-risk`;
- drawdown: 10% -> `signer-denied`;
- slippage: máximo 2%;
- price impact estimado: máximo 1%;
- nenhuma compra sem venda simulada;
- reservar SOL para saída;
- limites podem ser reduzidos na UI;
- aumento acima do teto exige config local e restart desarmado.

### Artefatos

- Threat model.
- Contratos e reason codes.
- Keyfile/import/unlock.
- Signer process e Unix socket.
- Risk guard.
- Transaction decoder/policy.
- Audit log.
- Kill switch.
- Testes adversariais.
- Runbook de unlock, lock, rotação e perda do host.

### Testes obrigatórios

- Keyfile errado/corrompido.
- Pubkey derivada diferente de `8qE2V1zbcui9RnNsKajVrJ1zS34bMFkumWA9h95Bx8AV`.
- Busca em Git, banco, logs, processos e fixtures por material secreto.
- Programa, mint, pool, destino e instruction desconhecidos.
- ALT ausente/alterada.
- Bytes diferentes do intent.
- Risk snapshot stale.
- Fee, tip, slippage, impacto e gasto acima do teto.
- Intent duplicado/replay.
- Duas intents concorrentes gastando o mesmo saldo.
- Kill switch.
- Restart retorna a locked/disarmed.
- Paper não alcança o socket.
- Signer recusa broadcast nesta RFC.

### Critérios de aceite

- Apenas o processo signer manipula a chave em memória.
- Nenhum segredo é persistido em plaintext.
- Pubkey esperada é validada.
- Não existe HTTP de assinatura ou saque.
- Toda assinatura de teste depende de policy decision válida e bytes íntegros.
- Mainnet broadcast não existe.
- O risco residual de host comprometido está documentado: todo o saldo da hot wallet pode ser perdido.

### Condições de parada

Pare imediatamente se:

- for solicitado colocar segredo em env/banco/repositório;
- não houver biblioteca/formato criptográfico confiável;
- a transação não puder ser totalmente decodificada;
- existir instruction/ALT desconhecida;
- qualquer caminho contornar risk guard;
- paper puder chegar ao signer;
- live/broadcast for necessário para concluir esta RFC.
