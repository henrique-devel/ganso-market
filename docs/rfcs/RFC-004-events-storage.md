# RFC-004 — Eventos de domínio, PostgreSQL e retenção

**Status:** draft  
**Dependências:** RFC-003  
**Bloqueia:** RFC-005 e RFC-006  

## Prompt a executar

Você deve implementar a RFC-004 do Ganso Market: decoders Pump/PumpSwap, event log operacional, projeções e retenção local.

### Objetivo

Transformar RawEnvelopes em eventos determinísticos e auditáveis, mantendo estado correto desde a criação do token até a curva, migração e pool PumpSwap canônico.

### Restrições

- Pump/PumpSwap somente.
- Mint/program/pool são identidade; ticker e nome não são.
- Nunca usar float.
- Real e virtual reserves são conceitos distintos.
- Curve complete e pool created são estados distintos.
- Estado `processed` não é irreversível.
- Unknown discriminator/layout vai para quarantine.
- Não guardar protobuf/raw indefinidamente.
- PostgreSQL fica no NVMe local.
- Não criar backup externo, PITR, réplica ou Object Storage.
- Não adicionar Timescale/ClickHouse sem nova RFC.
- Evitar JSONB como modelo primário.

### Eventos mínimos

- `TokenCreated`
- `CurveInitialized`
- `CurveBuy`
- `CurveSell`
- `CurveStateChanged`
- `CurveCompleted`
- `MigrationRequested`
- `CanonicalPoolCreated`
- `LiquidityInitialized`
- `PoolSwap`
- `VaultBalanceChanged`
- `AuthorityChanged`
- `FeeConfigChanged`
- `EventPromoted`
- `EventOrphaned`

### DomainEventEnvelope

Inclua:

- schema_version;
- event_id determinístico;
- slot, block_time e commitment;
- signature e instruction indices;
- program ID e parser version;
- mint, curve e pool quando aplicável;
- source/received/normalized timestamps;
- payload hash;
- reason de promoção/orphan.

### Tarefas

1. Obter IDLs/layouts de fonte oficial e registrar hash/versão.
2. Criar golden fixtures de transações reais sanitizadas, sem secrets.
3. Implementar decoders determinísticos.
4. Modelar:
   - real token/quote reserves;
   - virtual reserves;
   - creator separado de payer;
   - curve complete;
   - migration requested;
   - pool canônico e configuração;
   - vault balances;
   - authority/config changes.
5. Criar máquina de estados com transições válidas, promoção de commitment e orphan.
6. Criar projeções:
   - token lifecycle;
   - curve state;
   - pool/liquidity state;
   - authority/config;
   - creator history básico;
   - candidate current state.
7. Criar migrations PostgreSQL e partições diárias para eventos.
8. Usar microbatch/COPY; nunca commit por evento.
9. Criar ferramenta de rebuild das projeções.
10. Criar compactação local Parquet/Zstd para agregados.
11. Implementar TTL:
    - raw geral: 1–4 horas;
    - raw candidato: 24 horas;
    - detalhe normalizado: 7 dias;
    - agregados 1 s: 14 dias;
    - features/candles 1 min: 90 dias;
    - decisões/ordens/fills: até 1 ano.
12. Aplicar quotas:
    - PostgreSQL máximo 75 GB;
    - Parquet máximo 100 GB;
    - disco mínimo livre 25%;
    - 85% usado aciona no-new-risk e limpeza de P3/P2 raw.
13. Criar data dictionary e reason codes.
14. Expor métricas de decode, quarantine, transição inválida, partições, tamanho e TTL.

### Ausência de backup

Não implemente backup automático. Documente explicitamente:

- falha de disco pode apagar banco, Parquet, configurações e modelos;
- dados podem ser recoletados apenas quando a fonte permitir;
- a aplicação não oferece recuperação garantida;
- a cópia offline da hot wallet é externa a este sistema e não faz parte do banco.

Uma migration destrutiva exige export manual opcional e aprovação do proprietário; não crie rotina permanente de backup.

### Artefatos

- Schemas de eventos.
- Migrations/partições.
- Decoders.
- Máquina de estados.
- Projeções.
- Quarantine.
- Golden fixtures.
- Rebuild tool.
- Compactador/TTL.
- Data dictionary.
- Testes e métricas.

### Testes obrigatórios

- Golden tests para create, buy, sell, complete, migrate, pool e swap.
- Mesma entrada gera o mesmo evento.
- Duplicata não altera reserva duas vezes.
- Eventos fora de ordem convergem depois da reconciliação.
- Orphan invalida estado processed.
- Nenhuma reserva/saldo fica negativo.
- Rebuild produz hashes equivalentes.
- Evento desconhecido entra em quarantine.
- TTL remove apenas classes autorizadas.
- Limite de disco impede nova entrada antes de esgotar SSD.
- Crescimento diário é medido, não estimado sem evidência.

### Critérios de aceite

- Estado projetado corresponde a amostras on-chain.
- Canonicidade do pool é demonstrável.
- Projeções sobrevivem a restart sem duplicar.
- Banco cabe no orçamento.
- Nenhum backup externo foi introduzido.
- Perda local e retenção limitada estão documentadas.

### Condições de parada

Pare se:

- IDL/layout não puder ser autenticado;
- reserves reais/virtuais não puderem ser diferenciadas;
- canonicidade do pool não puder ser provada;
- qualquer valor monetário depender de float;
- fork/out-of-order puder corromper estado sem detecção;
- volume exceder quotas sem política segura de descarte.
