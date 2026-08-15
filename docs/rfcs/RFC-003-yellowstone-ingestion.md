# RFC-003 — Ingestão Yellowstone filtrada

**Status:** draft  
**Dependências:** RFC-001 e RFC-001A
**Bloqueia:** RFC-004 e RFC-006  

## Prompt a executar

Você deve implementar a RFC-003 do Ganso Market: consumo resiliente e filtrado do endpoint Yellowstone/Geyser existente.

### Objetivo

Receber somente transações e account updates necessários ao MVP Pump/PumpSwap, atribuir identidade/idempotência e entregar mensagens a filas priorizadas sem bloquear o stream.

### Envelope de capacidade

- 100–300 transações relevantes/s sustentadas.
- Burst de 1.500 transações/s por 30 segundos.
- 200–800 account updates/s sustentados.
- Até 5.000 eventos/s em burst.
- Tráfego normal alvo de 0,5–3 MB/s.
- Lag P95 de normalização inferior a dois segundos.

Esses valores são hipóteses de engenharia. Capture 24–72 horas e reporte medições reais; não fabrique benchmark.

### Restrições

- O endpoint Yellowstone é externo ao CPX42.
- A RFC-001A deve ter validado o contrato e instalado os secret files mínimos;
  não recupere credenciais do checkout removido do Ganso-bot.
- Live trading permanece inexistente.
- Não assinar blocos completos.
- Não assinar globalmente Jupiter, Token Program, Token-2022 ou todas as contas.
- Usar filtros server-side e allowlist versionada.
- Não inventar program IDs. Verifique programas/IDLs oficiais e mantenha-os em configuração versionada.
- O receiver não espera PostgreSQL, modelo ou API externa.
- Não presumir replay ilimitado.
- Não imprimir endpoint token/credential.
- Não usar Kafka/Redpanda/NATS inicialmente; use channels limitados e WAL sequencial embutido.

### Assinaturas

Crie:

1. Stream `processed` para descoberta:
   - `vote=false`;
   - `failed=false`;
   - Pump/PumpSwap na allowlist;
   - slots e block metadata, sem full block.
2. Stream `confirmed` mais estreito para:
   - candidatos ativos;
   - posições da hot wallet;
   - mints, curves, pools, vaults, authorities e migrações.
3. Reconciliação `finalized` em lote.

Assinaturas dinâmicas devem adicionar/remover:

- mint;
- bonding curve/pool PDA;
- vaults;
- config;
- LP/locker;
- creator/contas críticas;
- contas da hot wallet.

### Tarefas

1. Implementar gRPC TLS, autenticação por secret file, keepalive e health.
2. Implementar reconnect exponencial com jitter e limite.
3. Implementar manager de filtros dinâmicos, com auditoria de mudanças.
4. Criar `RawEnvelope` versionado:
   - source;
   - slot;
   - commitment;
   - received_at;
   - kind;
   - signature/pubkey;
   - write_version;
   - payload hash;
   - payload opcional e sujeito a TTL.
5. Idempotência:
   - tx: `(slot, signature, instruction_index, inner_index, kind)`;
   - account: `(pubkey, slot, write_version)`;
   - commitment faz parte do ciclo e não deve ser apagado.
6. Criar ring buffer limitado a 256 MB.
7. Criar WAL segmentado, máximo de 20–25 GB, com checksum.
8. Criar prioridades:
   - P0: posições, saídas, authority/liquidity change, migração;
   - P1: candidatos;
   - P2: descoberta;
   - P3: raw/telemetria dispensável.
9. Garantir worker/fila exclusivos para P0.
10. Implementar backpressure:
    - lag >2 s ou fila >50%: pausar enriquecimento;
    - >5 s ou >60%: não admitir candidatos;
    - >15 s ou >80%: emitir `no-new-risk`;
    - >30 s ou disco >85%: descartar P3 e raw P2;
    - perda de P0: health crítico e trading impedido.
11. Expor métricas de slots, lag, throughput, bytes, reconnects, duplicatas, filas, WAL, drops e RSS.
12. Criar fixtures e gerador de carga offline.
13. Documentar reconnect, fork, falta de replay e reconstrução.

### Artefatos

- Receiver Yellowstone.
- Config schema sem credentials.
- Allowlist versionada.
- RawEnvelope.
- Filtros dinâmicos.
- WAL e queues.
- Health/metrics.
- Load generator.
- Fixtures.
- Testes unitários, integração e chaos.
- Relatório real de 24–72 horas quando o endpoint estiver disponível.

### Testes obrigatórios

- 300 tx/s durante 30 minutos sem perda P0/P1.
- Burst de 1.500 tx/s por 30 segundos.
- Reconnect e resume.
- Credencial inválida/expirada.
- Duplicata e evento fora de ordem.
- Commitments diferentes da mesma origem.
- Mensagem malformada.
- WAL cheio/corrompido.
- PostgreSQL indisponível não bloqueia receiver.
- Programa fora da allowlist não entra.
- RSS retorna ao patamar depois do burst.

### Critérios de aceite

- Receiver nunca perde P0 silenciosamente.
- Lag e drops são observáveis.
- Backpressure bloqueia novas oportunidades antes de comprometer saídas.
- Programas fora de escopo não entram.
- Nenhum segredo aparece em log/métrica.
- Consumo real cabe no orçamento do CPX42.

### Condições de parada

Pare se:

- o provedor não suportar filtros/commitments necessários;
- a solução exigir assinatura global de Token/Jupiter/blocos;
- P0 puder ser descartado;
- não houver checkpoint/idempotência;
- lag base permanecer acima de dois segundos;
- raw precisar de retenção incompatível com o SSD;
- program ID ou layout não puder ser verificado oficialmente.
