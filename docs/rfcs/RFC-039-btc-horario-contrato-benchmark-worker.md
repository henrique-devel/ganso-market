# RFC-039 — BTC horário: contrato, benchmark e worker de pesquisa

**Status:** draft — documentação solicitada em 2026-09-10; nenhuma ativação autorizada por este documento.
**Objetivo:** comparar sinais com o contrato realmente negociado e produzir observações reproduzíveis.
**Dependências:** RFC-028 parte A existente; RFC-024 para cobertura; RFC-038/034/022 antes de ordens paper executáveis.
**Prompts:** `BTC-01` a `BTC-07`, em `prompts/roadmap/btc/`; dependências específicas no frontmatter.

## Problema e evidência

`fastpolicy.ts` e `fastbacktest.ts` usam `S0 = open(twap60)` e `St = close(twap30)`.
São proxies. O [contrato horário consultado](https://polymarket.com/event/bitcoin-up-or-down-september-10-2026-1am-et)
compara abertura e fechamento do candle Binance BTC/USDT de uma hora; empate corresponde a Up.
Essa regra pertence ao contrato consultado: não generalizar para outras durações, séries ou futuras versões.
O registro/configuração da parte A existe; o worker da parte B não foi encontrado na revisão de 2026-09-10.
Confirmar código/recibos; contagens antigas não são aceite presente.

## Decisões

1. **Adaptador de contrato.** Normalizar `condition_id`, tokens Up/Down, início/fim UTC,
   venue, símbolo, intervalo, regra de empate, versão/hash da regra e instante de captura.
   Verificar metadados e texto: regex do título é descoberta, não prova suficiente.
   Duração, fuso/DST, fonte ou mapeamento ambíguo tornam o mercado inelegível com motivo explícito.
   Nunca derivar instante de uma coluna que contenha apenas data.
2. **Benchmark com procedência.** Registrar abertura Binance do intervalo e preço corrente
   Binance disponível no instante da decisão. Manter TWAP como feature identificada.
   Guardar `source_ts`, `received_at`, janela do candle, origem e hash do payload.
   Em replay operacional, ambos os timestamps devem ser anteriores ou iguais ao cutoff.
   Candle final baixado posteriormente não comprova informação disponível antes do fechamento.
   Backfill sem recepção histórica verificável é retrospectivo.
   A abertura pode ser conhecida durante o candle; o fechamento final só após sua publicação.
   Rótulo oficial observado posteriormente serve à liquidação, separado das features.
3. **Versão nova.** Não modificar silenciosamente `fast.json` 0.1.0 ou seus resultados.
   Publicar identidade de fonte, versão de policy/config e contrato em cada observação.
   Fonte ausente, atrasada ou divergente não recebe substituição implícita por Chainlink/TWAP.
4. **Worker observacional isolado.** Mesmo repositório e banco; ciclo, configuração,
   ownership e métricas próprios. Em sombra não acessa criação de ordens nem altera
   `paper_orders`, posições, ledger, carteira ou evidência dos gates principais.
   Identidade contém experimento, conta simulada, estratégia, braço, mercado e slot programado.
   Contrato compatível com ownership da RFC-038; não reutilizar posição por token como conta.
   Reinício, concorrência e retry não duplicam decisões. Recusas transitórias não consomem
   antecipadamente o único slot de decisão útil; registrar tentativas separadamente.
5. **Validade por mercado e instante.** Julgar regra, benchmark, livro, atraso e warmup
   no intervalo observado. Kill switch de execução fica registrado, mas não impede
   pesquisa com dados próprios válidos e zero ordens. Dados inválidos excluem o instante,
   não apagam mercados válidos anteriores. Isto revisa a janela global da RFC-028.
   Sair de sombra exige RFC-038/034/022 concluídas e decisão específica de modo.
6. **Métricas limitadas.** Expor em CLI/GET a cobertura por etapa: esperados, descobertos,
   contrato validado, insumos válidos, decisões, fills simulados e resolvidos; deduplicar
   por mercado. Mostrar gaps, divergência Binance/TWAP, versões e reason codes.
   Consumir classificação central versionada de `DATA-02`: excluir testes sintéticos
   dos denominadores econômicos, preservando-os e mostrando sua contagem separada.
   A sombra não apresenta PnL hipotético como retorno de carteira.
7. **Operação e ponte paper.** `BTC-05` prepara rollout sombra e registra observação autorizada,
   independente de FIN/gates quando os dados são válidos. `BTC-06` conecta intent paper
   ao ownership reconciliado conta/estratégia/token, EV final, reservas, kill e saídas.
   `BTC-07` prepara rollout paper com mandato/alocação explícitos e default desabilitado.
   Configuração admite somente simulação. Recibos distinguem plano, aplicação e observação;
   plano pronto não comprova dados prospectivos nem paper executado.

## Aceite por bloco

| Bloco | Evidência necessária |
| --- | --- |
| BTC-01 | Fixtures de BTC1h, empate, DST, tokens invertidos e contrato incompatível |
| BTC-02 | Feature muda com preço conhecido; evento recebido depois nunca altera decisão passada |
| BTC-03 | Reinício idempotente; zero ordens/ledger; kill de execução não valida dado ruim nem bloqueia dado válido |
| BTC-04 | Denominadores reconciliados; exclusão localizada; mesma amostra não aumenta N por tick/braço |
| BTC-05 | Freeze anterior aos novos dados; recibo operacional com cobertura e zero ordens |
| BTC-06 | Intent idempotente, ownership e reservas reconciliados; default sem ordens |
| BTC-07 | Mandato/configuração conferidos; execução paper observada, ledger reconciliado ou pendência explícita |

## Limites e reversão

Desabilitar somente o novo worker preserva evidência e serviços existentes.
Migrations aditivas, número reservado no momento da implementação; histórico imutável.
Ativação/deploy não integra os prompts de código. O orçamento de pesquisa da RFC-032
é US$1.000 por cenário alternativo, sem alterar a reserva histórica de US$100 da 028.
Mudança para carteira paper requer ownership reconciliado e decisão explícita de alocação.
Não há garantia de lucro nem prazo inferido de número de decisões.
