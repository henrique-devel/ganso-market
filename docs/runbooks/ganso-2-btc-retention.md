# Retenção do corpus BTC novo — G2-02.4

Contrato `btc-retention-v1`, conjunto fechado `btc-paper-v1`, migration 0027.
As quatro tabelas `btc_retention_{policy,objects,dependencies,pins}` começam
vazias, exceto a política com `hold=true`. Nenhuma tabela legada é consultada
ou alterada pelo executor. Não importar o corpus legado para esse conjunto.
O módulo está disponível à futura persistência/feed BTC; não cria worker,
timer, conexão externa, contratação ou executor live.

## Contrato de escrita

Usar `storeRetentionObject` de `apps/api/src/trading/retentionstore.ts` com
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
| `raw` | 7 dias desde `recordedAt`; quota de 10 GiB, incluindo raw protegido |
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
e 1 KiB por referência; o cliente não informa bytes confiáveis. O orçamento total
de 12 GiB também limita barras/logs. A ocupação física das três tabelas de dados
(incluindo índices/TOAST) bloqueia admissão aos 14 GiB, mesmo após poda sem reclaim.
São tetos sobre o armazenamento já provisionado, não reserva de disco ou expansão.
`retentionCapacity` expõe quota, ocupação, HOLD e `nonessentialBlocked`.
Somente reduzir quotas é permitido nessa versão; acompanhar a margem real do host
antes de ativar o feed. Evidência financeira/decisões continua gravável acima do
teto lógico e sua resposta sinaliza `nonessentialBlocked=true`.

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
