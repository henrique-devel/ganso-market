# Política baseline inativa — G2-07.2

Implementa `btc.baseline.trend.v1`, autenticada pelo manifesto
`sha256:1d9ebd2cd94246077f3a0f5eca826f028adc08896668ea364812aaeecb0b1b81`.
O [contrato congelado](../contracts/btc-baseline-manifest-v1.md) continua normativo.
Não há scheduler, cadastro de conta, capital live, chamada Jev ou consumidor
automático nesta entrega. Importar os módulos não executa I/O. Não há resultado
de alpha, backtest ou rentabilidade nesta fatia.

## Interface para o adaptador de persistência

- `trading/strategies/baseline.ts`: SMA estrita, rompimento, ATR simples com ceil
  e arredondamento ao preço válido, sem imports ou dependência de runtime.
- `storage/baseline-inputs.ts`: registro prospectivo e envelopes as-of de
  metadata, barras, dependências, conta, livro/contexto/captura e funding final.
  Hashes usam o JSON canônico do manifesto. A seleção de barras é end decrescente,
  primeira persistência crescente e object_id crescente; não usa revisão tardia
  nem substitui uma primeira barra inválida por uma revisão conveniente.
- `decideBaseline`: produz `btc.baseline-decision.v1`, com estado, todas as
  causas, candidato, referências e proposta de intenção `trading.v1`/comando IOC.
  `enabled` é uma entrada interna do futuro adaptador de ativação, não configuração
  HTTP nem ativação por credencial. O manifesto publicado continua desligado.
- `revalidateBaseline`: obrigatória na admissão e execução; conserva quantidade,
  stop, banda e deadline originais. Mudanças de risco, saldo, metadata, funding
  ou preço rejeitam; esperar a latência não prolonga os 5 segundos de TTL.
- `baselinePosition`: deriva stop e deadline do candidato e primeiro fill real
  do ledger. Exige o conjunto completo dos fills de entrada; parciais/restart
  não mudam a origem. `manageBaselineExit` retorna a memória atualizada, os IDs
  das reservas de aumento a cancelar e uma proposta de redução ou estado pendente.
  `revalidateBaselineExit` aplica a barreira de execução sem depender de entradas,
  warmup, Jev ou funding disponível. HALTED/recovery/accounting impedem execução.

Essas funções não gravam nem enviam ordens. O adaptador da próxima fatia deve,
na transação existente de retenção/conta, selecionar e autenticar os registros,
persistir uma decisão única por `decision_id` com seus pins, e devolver `previous`
em qualquer replay. O horário é o primeiro processamento real; não reabrir uma
janela perdida. O SHA implementador/metadata/conta é registrado antes do início.
`first_complete_start_at` é o início original observado de cada intervalo, não
um início novo escolhido após retenção, gap ou restart.

O snapshot de conta é produzido pelos leitores existentes de ledger/valuation,
`observeRiskTx`, funding coverage, reservas e recovery sob o mesmo lock e relógio
da decisão. Não aceitar equity, flags de autorização ou hashes vindos de cliente.
As referências transitivas das barras devem incluir IDs/hashes e os timestamps
originais de recebimento/persistência dos trades e capturas. O pin do snapshot
de conta deve preservar suas dependências de ledger/valuation/recovery/funding.
O contexto HTTP continua sem timestamp de atualização de preço comprovado.

Após persistir, chamar as revalidações e os contratos existentes de `applyIocTx`;
eles permanecem responsáveis por risco sob lock, margem/fees, profundidade líquida
por conta, fills, ledger, IOC parcial e cancelamento do restante. O comando e a
intenção são duas representações do mesmo candidato; não reconstruir termos a
partir do mercado atual. `baselineCosts` contém somente provisões de planejamento;
nunca lançar esse total no ledger. Fees/funding realizados já são contabilizados.

Persistir pedido de saída antes de tentar redução e cancelar aumentos. S7 mantém
prioridade sobre uma redução normal. Ao registrar um IOC aceito, guardar seu
order_id, book_key econômico e source_at; alimentar `attempts` com todos os
resultados/ordens persistidos. Só admitir outro IOC após o anterior terminar e
com livro mais novo. Não apagar a memória ao rebote de preço ou no restart.
Zerar posição/reservas e registrar a barra do último encerramento antes de aceitar
entrada numa barra posterior. Sem livro/metadados suficientes, a saída permanece
pendente com atraso; nunca há fill no preço do candle, stop ou mark.

## Verificação e implantação

As fixtures sintéticas cobrem os vetores normativos e falhas as-of, tamanho,
rounding, pausas, idempotência, precedência de saída e falta de profundidade.
Não representam uma amostra econômica. Não há migration nem mudança de schema.
A classificação seletiva dessa política afeta somente a API; não reinicia o
coletor nem PostgreSQL. Baseline/Jev seguem desligados. Rollback do código usa
o release anterior preservando schema 42, ledger, funding RATE18, pins e pausas.
