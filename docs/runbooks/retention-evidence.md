# DATA-02 — Proteção e manifesto

Contrato `data-02-v1`, RFC-041. Não contém executor, exportação ou autorização de
limpeza. O inventário [DATA-01](../test-results/btc/DATA-01.md) é evidência de seu
snapshot, não prova de ausência atual de ordens abertas ou de novos dados.

## Política inicial e fecho

`retention-policy.ts` enumera 69 tabelas de evidência/configuração. Todas ficam em
HOLD integral: ledger e idempotency keys; orders/positions/entries/decisions;
fills, marks, markouts e resoluções; configs/versões/hashes, gates, estratégias e
subcarteiras; metadados, labels, modelos, relatórios e seus insumos raw.
Isso preserva referências lógicas ausentes das FKs e também a proveniência que
`panel → decision ON DELETE SET NULL` poderia apagar sem erro. Estado fechado,
relatório, modelo ou agregado de 1 minuto não demonstram desuso do dado original.
Breakers fechados ainda são insumos de gates. Replay exige âncora L2 anterior,
deltas contínuos e timestamps source/received; não há horizonte seguro comprovado.

O pruner legado passa a monitorar catálogo em uma consulta, sem DELETE, ANALYZE,
varredura de coverage ou redução de TTL. Os orçamentos e TTLs declarados ficam
para comparação; TTL efetivo é nulo sob HOLD. Quota extrema gera alerta e revisão
de capacidade, nunca sobrepõe proteção. Diferença físico/vivo estimado não mede
bytes recuperáveis. `failedSteps=0` só descreve execução do monitor, não saúde.

Os quatro resíduos Solana têm inspeção dry-run permitida por nome/chave explícitos,
pois não foram encontrados consumidores no código da base DATA-01. Permanecem
protegidos no banco e no legado. Linhas novas exigem nova revisão de referências;
`executionAllowed:false` vale inclusive quando o manifesto encontra candidatos.

## Migration e pins

Migration aditiva `0023_retention_evidence_protection.sql`: guards de statement
recusam DELETE e TRUNCATE em 73 tabelas, inclusive comandos que atingiriam zero
linhas. Os triggers anteriores do ledger/strategy/configs permanecem intactos.
Não há bypass por quota, status, configuração ou remoção de pin. Auth e controle
de migrations não entram na política. `portfolio_exposures`, estado corrente,
zera buckets encerrados por UPDATE: preserva chave/id/cap/detalhe e evita falsa
violação de G3; a tela pode mostrar buckets zerados. Sizing continua em memória.

`retention_evidence_pins` fixa tabela inteira por `pin_id`, `dataset_id`,
`table_name`, `reason`, `artifact_sha256` e `created_at`. V1 é um superset seguro,
sem fingir que conhece token/janela/âncora exatos. INSERT/DELETE de pins geram
`retention_pin_events` na mesma transação; UPDATE/TRUNCATE de pins são recusados.
Remover um pin não libera o HOLD. Nenhum pin de produção é inventado pelo deploy.

Coordenação até commit usa advisory transaction lock `(741041,2)`: cada statement
INSERT/UPDATE de evidência obtém compartilhado; seletor/pins tentam exclusivo sem
fila e falham com `55P03` se houver escritor. Escritor que chega durante exclusivo
aguarda commit, sem rejeição deliberada. Adquirir exclusivo **antes** de escrever
qualquer referência/pin no mesmo transaction callback; evitar upgrade de lock.
Rollback desfaz pin e auditoria e libera locks. Nenhum escritor normal pode
ignorar os triggers. Um futuro executor deve manter essa mesma coordenação até
commit e reutilizar `selectRetentionCandidates`, revalidando todos os gates.

## Manifesto verificável

`createRetentionDryRun` abre READ ONLY / READ COMMITTED, obtém lock e só então lê
dados. Tem deadline de transação 2 s, statement 500 ms, lock 100 ms, sem retry.
Valida catálogo/guards de todos os objetos, inclusive controle/auditoria de pins,
e versão da política/migration23; registra checksums no hash sem compará-los aos
arquivos locais. Não programar varredura recorrente em produção.

Cada manifesto fixa formato, SHA do código, schema/hash, política/hash, objetos
allowlist (1–4), cutoff UTC, geração, expiração (máximo 15 min), chave estável,
watermark, contagens, pins, bytes e invariantes. Sem curingas/cutoff móvel.
O CLI exige arquivo novo (`wx`, modo0600); hash detecta alteração, não é assinatura
nem aprovação. `verifyRetentionManifest` valida integridade/validade, não concede
execução. O objeto retornado é congelado recursivamente.

Evidence HOLD retorna conjunto exato vazio, sem scan de dados. Nos resíduos,
um único seletor inspeciona primeiro até `limit+1` entradas de PK (padrão100,
teto1000) e só depois aplica cutoff à primeira fatia `limit`. `inspectionQuery`
registra essa inspeção; `predicate` publica a seleção exata pelas chaves/cutoff/
watermark e ausência de pin. `candidateCount` é exato na fatia; `entireCutoffCount`
é nulo se restar outra fatia. `tableRowsEstimate` é estatística, não COUNT exato.
Nenhum OFFSET ou scan temporal amplo. Chaves bigint ficam em texto; hash da linha
usa JSON textual sem arredondar bigint e timezone UTC. Bytes são tamanho lógico
da linha, não export, espaço físico ou promessa de recuperação.

Exemplo dentro do container com SHA embutido da release, apenas após migration:

```sh
node apps/api/dist/retention-dry-run-cli.js \
  --tables paper_orders,polymarket_book_deltas \
  --cutoff 2026-09-01T00:00:00Z --limit 100 \
  --output /tmp/data02-review.json
```

## Classificação sintética

`evidence-classification.ts` fixa `data-02-synthetic-v1`: `conditionId ===
"0xsonda"` é excluído com motivo/contagem, sem remover registro/trigger. Identidade
ausente é desconhecida/inelegível até resolver token→mercado. Outra string apenas
não casa com este sentinel; não prova origem real. O relatório preserva todas as
entradas e reconcilia total/elegíveis/sintéticos/desconhecidos. Integração dos
consumidores RFC033/039 fica fora deste bloco; métricas atuais não são anunciadas
como corrigidas e não há contagem sintética global comprovada em produção.

## Aplicação, verificação e limites

Após checks obrigatórios, a entrega autorizada aplica a migration pelo runner
transacional (lock500ms/statement5s). Conflito/timeout aborta a aplicação; não
repetir consultas pesadas nem desabilitar proteção para passar. Conferir checksum,
146 guards de evidência habilitados, guards de pins e os anteriores ledger/strategy
por catálogo, nunca por DELETE/TRUNCATE de teste em produção.

O deploy padrão atualiza o núcleo; reconstruir/recriar também os profiles afetados
`polymarket-recorder` e `polymarket-portfolio` com o SHA integrado. O portfolio
anterior usa DELETE de exposição e é incompatível com0023: suspender brevemente
somente esse profile antes da aplicação, retomar com o código compatível após a
migration e registrar a pausa. Recorder e demais escritores não precisam parar.
Conferir SHA embutido, logs dos ciclos,
persistência limitada e saúde. O rollback não deve reinstalar esse runner antigo
nem retirar guard; corrigir para frente mantendo HOLD ou conservar o runner
compatível. Se o deploy automático voltar ao código anterior após a migration,
tratar a compatibilidade do portfolio como gate pendente até recuperação.

Aplicação técnica não encerra soak/capacidade. HOLD pode aumentar ocupação; SSD
deve manter piso25%, sem alterar RAM/CPU/caps/paper/perímetro. Conforme a
[autorização vigente](../ops/DEVELOPMENT_AUTHORIZATION.md), a decisão aprovada é
**manter HOLD integral**. Novos dados e experimentos ficam condicionados a
orçamento demonstrável e ao fecho de evidência com proteção e preservação.
Esta atualização é documental: não implementa admissão ou limpeza, nem constitui
nova certificação de produção. A implementação de arquivos/admissão será tratada
no DATA-05. Horizontes/pins exatos continuam dependentes de âncoras/continuidade e
provas de preservação, sem custo externo adicional. Não liberar
raw só porque há agregado/modelo. DATA-03 pode preparar preservação usando este
contrato; poda continua proibida. Gates DB-02/03, Q4 e headroom DB-04 seguem
pendentes; ensaio DB-03 rejeitado não foi executado nem reencaminhado.

Referência técnica consultada em12/09/2026: [advisory transaction locks](https://www.postgresql.org/docs/18/functions-admin.html#FUNCTIONS-ADVISORY-LOCKS)
e [transaction_timeout](https://www.postgresql.org/docs/18/runtime-config-client.html#GUC-TRANSACTION-TIMEOUT), documentação oficial PostgreSQL18.
