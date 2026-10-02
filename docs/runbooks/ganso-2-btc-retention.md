# Retenção do corpus BTC novo — G2-02.4

Contrato `btc-retention-v1`, conjunto fechado `btc-paper-v1`, migrations 0027/0050.
As quatro tabelas `btc_retention_{policy,objects,dependencies,pins}` começam
vazias, exceto a política com `hold=true`. Nenhuma tabela legada é consultada
ou alterada pelo executor. Não importar o corpus legado para esse conjunto.
O módulo está disponível à futura persistência/feed BTC; não cria worker,
timer, conexão externa, contratação ou executor live.

## Contrato de escrita

Usar `storeRetentionObject` de `apps/api/src/storage/btc-retention.ts` com
um `DatabasePool` transacional. A identidade segue instrumento/versão de
`trading.v1`, sempre `mode=paper`; decisão e financeiro incluem conta/experimento.
O payload do feed deve conservar sua `TradingDataIdentity` completa, timestamps,
hash e conteúdo original. O adaptador determina um ID estável por evento e
referencia em `dependencies` toda a evidência: âncoras, deltas, gaps, metadados,
versões e demais insumos usados. As dependências já devem existir no conjunto
e pertencer ao mesmo instrumento. Ausência de evidência recusa a escrita inteira.
Recepção/parser/versão/conteúdo divergentes em um ID persistido produzem conflito;
o consumidor deve manter o envelope original nas retransmissões.

| Classe | TTL UTC / proteção |
| --- | --- |
| `raw` | 7 dias desde `recordedAt`; orçamento 200 GB/trava 160 GB, incluindo raw protegido |
| `bar` | 12 meses de calendário desde `recordedAt` |
| `log` | 14 dias desde `recordedAt` |
| `decision`, `financial` | Permanentes, com todas as dependências transitivas |
| `experiment` | Manifesto permanente; criação sujeita à admissão de capacidade |

Pins por objeto são permanentes na v1 e protegem o fecho transitivo. Dependências
de agregados ainda retidos também impedem remover seus insumos. Pins e financeiro
podem manter raw além de 7 dias: o sistema recusa nova captura em vez de liberar
essas referências. `pinRetentionObject` é idempotente pelo ID e conteúdo do pin.
Não há unpin, redução de evidência nem mudança de classe/TTL em uma linha existente.

O PostgreSQL calcula o custo conservador do JSON/envelope, mais 1 KiB por objeto
e 1 KiB por referência; o cliente não informa bytes confiáveis. A autorização de
02/10 e migration 0050 substituem os tetos antigos por **200 GB decimais**, com
recusa de captura aos **160 GB (80%)**, tanto lógicos quanto físicos. O físico
inclui seis relações BTC e índices/TOAST, mesmo após poda sem reclaim. Raw usa
esse mesmo orçamento. São tetos sobre o armazenamento provisionado, sem expansão.
`retentionCapacity` expõe quotas, orçamento/trava, ocupação, HOLD e
`nonessentialBlocked`. Quotas SQL menores continuam possíveis como contenção.
Evidência financeira/decisões pode usar a reserva de 20% acima da trava para
fechamento/contabilidade, mas não ultrapassar o orçamento de 200 GB. Não podar
nem desligar HOLD pela mudança; avaliar redução ou novo procedimento no futuro.


Escritas usam a mesma trava transacional que pins e poda. `BTC_RETENTION_CAPACITY_REFUSED`
recusa a captura inteira, sem remoção de pins, redução de payload ou escrita parcial.
O consumidor deve interromper novas capturas/experimentos e sinalizar o gap e o
motivo; nunca marcar a captura recusada como completa nem reenviar como financeiro.
Falhas de banco/timeout também exigem parar admissão até obter estado conhecido.
O mesmo ID/conteúdo retorna `duplicate`; mudança de conteúdo/identidade é erro.
Essas garantias de armazenamento não substituem a validação de sequência do feed.

## Execução restrita e retorno ao HOLD

A implantação desta fatia mantém HOLD e não executa DELETE em produção.
Para habilitar somente o conjunto novo depois de integrar seu consumidor:

1. Conferir `retentionCapacity`, o conjunto/versão e os pins/arestas completos.
2. Configurar explicitamente `hold=false` na única linha `btc-paper-v1` de
   `btc_retention_policy`, em transação. Isso não libera o legado.
3. Executar `retainBtcBatch(pool, {datasetId:'btc-paper-v1',
   policyVersion:'btc-retention-v1', limit:100, execute:false})` e conferir IDs/classes.
4. Usar os mesmos argumentos com `execute:true`. O executor seleciona novamente
   sob trava: nunca recebe IDs arbitrários de uma simulação anterior. Cada chamada
   remove no máximo 500 folhas vencidas, sem referência/pin/HOLD, em uma transação
   com timeout de statement de 5 s e trava de 2 s. Não há loop automático ilimitado.
5. Repetir apenas em lotes supervisionados. Remover uma folha pode liberar seu
   insumo vencido no próximo lote; repetir sem novos candidatos retorna lista vazia.

Restabelecer `hold=true` interrompe a poda; se houver problema na integração,
parar o consumidor BTC e voltar a imagem anterior, preservando schema e dados.
Não reverter migration, remover pins ou reiniciar workers Polymarket. O guard
SQL também recusa DELETE sem a versão da política, TTL, ausência de HOLD e
referências; UPDATE/TRUNCATE dos objetos e remoção de pins/arestas são bloqueados.
A validação destrutiva usa exclusivamente PostgreSQL descartável de testes.


## G2-12.2 — Projeção compartilhada de decisões futuras

Migration aditiva 0046 e escritor `btc.decision-projection.v1`: a decisão
completa permanece imutável/pinada em `btc_retention_objects`, com os mesmos
hashes, origens, timestamps, referências e arestas transitivas. A segunda cópia
em `btc_baseline_decisions.decision` passa a ser projeção sem `input_refs` e
`signal.input_refs`. O trigger compara a decisão recebida integralmente com a
evidência protegida, conta, ID, corte e pin antes de projetar; divergência aborta
a mesma transação. Escritores antigos continuam gravando o formato antigo.
Nenhum registro anterior, contador, pin, HOLD ou quota é reescrito.

Consumidores que precisam da decisão econômica completa usam
`btc_baseline_decisions_full`; consultas da tela permanecem na projeção.
Não entregar `decision` da tabela de projeções a um replay como se fosse o
contrato completo. Leitura mista devolve exatamente o payload original; versões
de captura, cálculo financeiro e hash da decisão não mudam. A projeção contém
apenas uma versão de armazenamento, que não entra no hash econômico.

Implantação em duas etapas: primeiro migration e leitores, com escritor antigo;
verificar essa release em produção e só então publicar o escritor que solicita
a projeção. Assim o rollback automático da segunda release encontra leitores
compatíveis. O coletor continua parado. **Rollback após
primeira projeção:** preservar schema 46 e estes leitores compatíveis, revertendo
somente a emissão de `storage_version` no escritor (hotfix reconstruído/testado).
Não retornar à imagem anterior sem o patch de leitura, pois ela interpreta a
tabela como decisões completas. Não apagar/reexpandir projeções ou desabilitar
triggers para rollback. Antes da primeira projeção, a imagem anterior pode
continuar operando com o schema aditivo.

A economia é exclusivamente da segunda cópia futura. A evidência integral e sua
cobrança lógica continuam iguais; a captura já coalesce snapshots ainda não
expostos e preserva todos os trades. Não reduzir mais a captura para perseguir
uma meta sem prova de replay/fill. Esta mudança **não comprova** 16 KiB totais
por decisão, 250 kB/h raw, 3 MB/h de filesystem ou 90 dias sustentáveis; não
recupera folga física nem os contadores históricos. Admissão permanece bloqueada
conforme o plano G2-12.1. Sem descarte delimitado autorizado, sem contratação,
sem consumo Jev ou mudança de teto. Custo novo desta implementação: zero;
fatura total existente continua não demonstrada.
