# Contabilidade e referências JEV — JE08

As rotas GET autenticadas `/trading/jev/metrics?account_id=…`,
`/trading/jev/benchmarks?account_id=…` e `/trading/jev/results?evidence_id=…`
usam o username da sessão autenticada como owner, leitura limitada e
`Cache-Control: no-store`. Sessão de outro proprietário recebe 404, inclusive
para cortes persistidos; a query não escolhe ou substitui owner.
GET não captura evidência, altera contas, chama JEV nem executa ordens.
O parâmetro opcional `origin=mock` seleciona exclusivamente o journal sintético;
o padrão é `real`. Os dois nunca são misturados.

## Custos e resultado

`jev.evaluation-costs.v1` conserva uma cobrança por request no global. Cada
participante recebe o request inteiro em sua avaliação, sem somar contas
alternativas para reconstruir a fatura. Geração/validação identificável é
atribuída integralmente a cada alternativa da mesma proposta/perfil/versão.
Geração sem proposta vinculada bloqueia o resultado econômico do proprietário.
Request sem cobrança final conhecida permanece `null`, incluindo falha/pendência;
reserva não comprova despesa. O contrato histórico `CostAllocation` permanece.

Infraestrutura manual é um campo separado e opcional, ausente por padrão.
Sua ausência deixa o total da plataforma indisponível, mas não impede o resultado
da estratégia. Ela não entra no patrimônio de risco nem na aprovação econômica.

`jev.metrics.v1` reutiliza o ledger e a valorização do risco, com custo médio
ponderado e resto preservado em fechamentos parciais. Publica realizado, aberto,
taxas positivas e funding assinado, após JEV e resultado conservador:
`realizado - taxas + funding + min(aberto, 0) - JEV`.
Slippage já está no preço do fill. Patrimônio de risco exclui JEV/infra.
Funding não reconciliado, marca desconhecida ou custo sem atribuição completa
deixam o resultado indisponível. Retorno usa o capital inicial da conta.

Cards e gráficos devem consumir o mesmo DTO/corte persistido. Janelas carregam
a base vitalícia e o PnL marcado na abertura, sem genesis novo; o conservador
subtrai o aberto integral da abertura e exclui somente lucro aberto no fim.
Não comparar cortes de contas, origens ou convenções diferentes.

## Referências virtuais e evidência

`jev.benchmark.v1` fixa caixa US$250 sem rendimento e BTC com US$125 de exposição
inicial, arredondada para o quantum da metadata. A quantidade alvo fica fixa.
Uma única IOC no ask inicial cancela a sobra, sem recomprar/rebalancear.
Execução usa livro observado após chegada, profundidade finita e claims próprios.
Paper usa latência de 1s/taxa pública; stress usa 2s/taxa dobrada, como o simulador.
Funding usa o modelo paper existente, taxa final observada e oracle original no
cutoff. Releitura da mesma taxa é idempotente; alteração conflitante permanece
indisponível e nunca reescreve o débito anterior.

O pico é observado antes e depois da primeira parcial. DD de US$12,50 desde o
pico solicita IOC reduce-only após a latência, continua tentando o residual em
parciais/gaps e termina em caixa sem reentrada. Funding pendente impede afirmar
equity/DD completo. Após cash terminal, só as horas potencialmente expostas
continuam exigindo reconciliação; horas posteriores não reabrem a referência.
Rolling windows usam os endpoints da mesma trajetória, sem nova compra/reset.

`captureJevMetrics` e `captureJevBenchmark` são escritores de biblioteca inativos,
sem chamada no boot, worker ou rota. Persistem original, fontes e cadeia de pais
sob o lock de retenção; retry repete o corte original. A migration 0057 cria
índice append-only, charges no orçamento existente e FKs de evidência protegida.
Falha no índice desfaz o envelope na mesma transação. Leituras/capturas recusam
mais de 20.000 eventos/requests; avanço de benchmark aceita até 24 horas por
comando. Limite não significa corte silencioso nem reset de histórico.

Publicação não admite paper, qualifica perfis, aporta capital ou arma signer.
As referências não reservam capital real nem transferem patrimônio virtual ao
live. GJ12.2/12.3, GJ13.5 e GJ15.1–3 permanecem etapas próprias. Para reversão,
pausar entradas e usar código compatível com 0057, preservando proteção,
reconciliação, ledger, migrations, HOLD e pins.
