# RFC-041 — Limpeza verificável e retenção sustentável

**Status:** draft — especificação solicitada em 2026-09-10; nenhuma limpeza executada.
**Prioridade:** paralela à recuperação; antes de aumentar geração de dados.
**Dependências:** RFC-007 (política atual), RFC-037 (custos); interface com RFC-032/033/038/039.
**Blocos:** DATA-01 a DATA-05. Os 110 GiB atuais são baseline, não nova recomendação.

## Objetivo e inventário — DATA-01

Recuperar capacidade de dados antigos, derivados regeneráveis e artefatos sem uso
comprovado sem destruir a cadeia de avaliação e contabilidade. Inventariar banco,
logs, imagens de deploy e exports específicos; não usar `docker system prune`.

Ler catálogo/estatísticas: tamanho heap, índices, TOAST e total físico; estimativa
de bytes vivos separada, dead tuples/bloat com método e incerteza; idade, janela,
taxa diária, consumidores, referências FK e referências lógicas no código. Contar
exatamente só recortes indexados com orçamento. `n_live_tup` não é contagem exata.
"Pouco usado" exige evidência de consultas/consumidores e idade, não nome da tabela.
Esquemas/migrations aplicados permanecem; inventariar apenas dados residuais Solana.
Não reintroduzir o código Solana removido do escopo nem presumir que ele ainda exista.

## Proteções e manifesto — DATA-02

A retenção atual pode podar ledger/orders por quota. Introduzir política versionada
com proteção efetiva dessas cadeias **antes de qualquer nova poda**, incluindo jobs
legados. Fixar datasets em uso impede que o pruner antigo os remova entre inventário
e execução; não depender apenas do manifesto do novo comando. Criação/remoção de
pins e referências protegidas compartilha coordenação transacional com a poda
(lock/serialização definida); nenhum escritor relevante pode ignorar esse contrato.

Proteger ledger, orders, fills/position_entries, posições abertas, versões de config,
regras/parâmetros, labels/resoluções, proveniência de modelos e evidências dos gates.
Mapear transitivamente referências não declaradas por FK. Raw de pesquisa precisa
de horizonte/pin por dataset; agregado 1m não substitui L2 para replay de execução.
Lacunas históricas já causadas pela quota antiga são declaradas, não reconstruídas
como se fossem observações. `0xsonda` é excluído auditoriamente de métricas com regra
central versionada e contagem de exclusões; preservar linha/trigger, sem TRUNCATE.

O dry-run produz manifesto imutável: hash/id, geração/expiração, SHA e esquema,
objetos allowlist, predicado exato, cutoff UTC, chave estável, watermark, estimativa
vs contagem do recorte, TTL/quota efetivos, motivo/evidência de desuso, pins, bytes,
referências e invariantes. Sem objeto curinga ou cutoff que avance ao executar.
Quota nunca sobrepõe proteção/pin ou cobertura mínima declarada; excesso vira
alerta/capacidade a decidir. Usar o mesmo seletor para dry-run e execução.

## Arquivo e restauração — DATA-03

Antes da remoção irreversível de dado cuja preservação seja necessária, exportar o
recorte/fecho de dependências definido, registrar formato/esquema, checksum,
contagens e destino com capacidade. Restaurar em ambiente isolado e verificar
integridade, reconciliação e replay representativo. Apenas arquivo existente não
é backup verificado. Se o export não couber, reduzir lote/escopo; não preencher o
disco para liberar espaço. Backups possuem quota, validade e regra de expiração;
não acumular cópias ilimitadas. Derivado descartável exige fonte retida e teste de
regeneração equivalente. Registrar quando não há dado suficiente para restauração.

## Execução limitada — DATA-04

Revalidar manifesto antes de iniciar e antes de cada lote: esquema/política,
watermark, proteção, referências novas e cobertura. Revalidar dentro da transação
do lote sob a coordenação compartilhada, mantida até DELETE/commit: SELECT seguido
de DELETE sem proteção contra escrita concorrente é insuficiente. Drift invalida o
plano e exige novo dry-run. Novas entradas nunca ampliam o conjunto autorizado.
DELETE por keyset estável e índice, lotes limitados em linhas/bytes/tempo, transação
curta, `statement_timeout`/`lock_timeout`, retries limitados, pausa por pressão de
I/O/lag e cursor persistido. Audit log/cursor atômicos; reexecutar não duplica efeito.

Testar crash entre lotes, timeout, manifesto vencido, reference drift, pin novo,
chave empatada, cobertura ausente e pin/referência criado entre leitura e DELETE.
Comandos reais ficam em plano executável
concreto e só são aplicados se o escopo estiver coberto pela autorização vigente.
Este pedido cria documentação; não dispara remoção nem manutenção em produção.

## Espaço e política contínua — DATA-05

DELETE + VACUUM permite reutilizar páginas; normalmente não reduz arquivo do OS.
Reportar vivo, físico, reutilizável e livre no filesystem antes/depois separadamente.
VACUUM FULL reescreve/bloqueia; repack/reindex exigem capacidade extra, WAL, locks,
compatibilidade, duração, janela e reversão documentados. Nenhuma extensão presumida
instalada. Limpeza de imagens/logs/export usa lista exata preservando release de
rollback e evidência; sem prune global e sem reduzir retenção forense por acidente.

Declarar TTL/quota por classe, janelas mínimas para L2/benchmark/replay, reserva para
experimentos e headroom operacional. Publicar GiB/dia e projeção 7/30/90 dias;
rotina incremental com limite por execução, alertas e auditoria de restauração.
Escassez não autoriza apagar evidência protegida. Aceite final reconcilia economia,
datasets e redução de capacidade ocupada sem prometer devolução física automática.

## Prompts

[DATA-01](../../prompts/roadmap/btc/data-01-inventario-capacidade.md) →
[DATA-02](../../prompts/roadmap/btc/data-02-protecao-e-manifesto.md) →
[DATA-03](../../prompts/roadmap/btc/data-03-export-e-restore-isolado.md) →
[DATA-04](../../prompts/roadmap/btc/data-04-poda-idempotente-limitada.md) →
[DATA-05](../../prompts/roadmap/btc/data-05-politica-e-manutencao.md).
