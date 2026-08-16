# RFC-008 — Execução beta Solana

**Status:** draft, não autorizado para implementação antecipada  
**Dependências:** RFC-001 a RFC-006 implementadas e readiness aprovado  

## Prompt a executar

Você deve implementar a RFC-008 do Ganso Market: execução beta Pump/PumpSwap com capital limitado.

### Pré-condição absoluta

Antes de editar:

1. Leia os relatórios de aceite das RFC-001 a RFC-006.
2. Verifique `readiness-report.json`.
3. Confirme 14 dias de shadow, ledger conciliado, idempotência, signer e kill switch.
4. Solicite aprovação explícita do proprietário.

Se qualquer evidência faltar, pare. Não crie bypass, mock ou flag temporária.

### Objetivo

Converter intents aprovados em transações Pump/PumpSwap, simular, assinar, transmitir, confirmar e reconciliar com saídas prioritárias.

### Restrições

- Somente a hot wallet `8qE2V1zbcui9RnNsKajVrJ1zS34bMFkumWA9h95Bx8AV`.
- Pump/PumpSwap direto apenas.
- Sem Jupiter arbitrário, leverage, short, martingale ou retry agressivo.
- Nunca aumentar slippage automaticamente.
- Envio por caminho privado (bundle Jito e/ou conexão staked) contra ataque de
  sanduíche; slippage sempre com teto.
- Latência vem de swQoS/conexão staked, não de superpagar priority fee ou tip
  (estudo empírico: tamanho de fee/tip não melhora inclusão de forma relevante).
- Saldo limitado e sem auto-refill.
- Live desligado depois de todo restart.
- Signer precisa estar manualmente desbloqueado.
- Sessão live tem TTL e fica apenas em memória.
- Worker de saída é P0.
- Não adicionar backups, HA ou infraestrutura distribuída nesta RFC.

### State machine

- `proposed`
- `risk_rejected`
- `awaiting_arm`
- `approved`
- `built`
- `simulated`
- `signed`
- `submitted`
- `processed`
- `confirmed`
- `finalized`
- `failed`
- `expired`
- `reconciled`

### Tarefas

1. Implementar quote direto Pump/PumpSwap com slot recente.
2. Revalidar antes de assinar:
   - curve/pool e canonicidade;
   - reserves/vaults;
   - authorities/config;
   - liquidez e saída;
   - min-out/max-in;
   - fee/tip/compute;
   - saldo e reserva de SOL;
   - risk snapshot e intent hash.
3. Simular com contexto mínimo e comparar efeitos esperados.
4. Enviar bytes ao signer da RFC-005.
5. Implementar broadcast, confirmação, expiry e reconciliação.
6. Retry pode reenviar a mesma transação assinada; reconstruir exige novo quote e novo risk approval.
7. Criar exit worker/fila P0.
8. Criar circuit breakers para lag, stale data, fee spike, LP/authority change, saldo divergente, perda diária e falha de landing.
9. Criar arm/disarm:
   - unlock local do signer;
   - confirmação visual explícita;
   - grant em memória com TTL;
   - restart/kill/erro crítico revoga grant.
10. Criar rollout:
    - dry-run;
    - build+simulate;
    - devnet/test fixture;
    - canário mainnet manual;
    - micro-live;
    - rollback.
11. Exibir relatório completo de cada tentativa.

### Artefatos

- Executor Pump/PumpSwap.
- Order state machine persistida.
- Quote, build e simulation adapters.
- Integração com risk guard e signer.
- Broadcast/confirmation/reconciliation manager.
- Worker de saída P0.
- Circuit breakers.
- Controle arm/disarm com TTL.
- Dashboard e relatório por operação.
- Checklist de canário e rollback.
- Testes e runbook de incidente.

### Testes obrigatórios

- Bytes/instructions construídos.
- Alteração após aprovação.
- Stale blockhash/reserves.
- Min-out inválido.
- Duplicate submit.
- Confirmação tardia depois de timeout.
- Restart entre cada estado.
- Queda de RPC.
- Banco indisponível.
- Fee spike e slot lag.
- Kill switch.
- Live grant expirado.
- Signer locked.
- Saída preservada durante saturação de descoberta.

### Critérios de aceite

- Nenhuma transação sem intent, risk approval, decode e simulação.
- Duplicate não cria posição dupla.
- Restart nunca rearma live.
- Auditoria reproduz bytes, estado, quote, policy e resultado.
- Canário respeita limite absoluto definido pelo proprietário.
- Divergência contábil encerra novas entradas.

### Condições de parada

Não ative live se:

- readiness estiver incompleto;
- signer/segredo estiver exposto;
- transação não for totalmente decodificada;
- idempotência/reconciliação falhar;
- simulação divergir dos efeitos esperados;
- worker de saída competir sem prioridade;
- live persistir após restart;
- canário ultrapassar limites ou produzir ledger divergente.
