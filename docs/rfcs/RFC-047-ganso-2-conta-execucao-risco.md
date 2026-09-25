# RFC-047 — Conta perpétua, execução e risco

**Status:** accepted para execução de seus prompts quando selecionados. **Data:** 22/09/2026. **Marco:** G2-05. Criar esta RFC não implementa nem ativa o resultado.

**Fonte:** [PRD 2.0](../PRD-GANSO-2.0.md), seções 7 e 13. **Requisitos:** RF-04, RF-05, RF-07, RF-08, RF-09, RF-10. **Roteiro:** [prompts](../../prompts/ganso-2/README.md). **Acompanhamento:** [estado 2.0](../roadmap/GANSO_2_EXECUTION_STATE.md).

## Contrato comum

Cada conta experimental começa com evento próprio de US$ 1.000; não soma capital de cenários. No perpétuo, reserva de margem não é compra spot nem despesa. Saldo, PnL, taxas e funding são contabilizados uma vez, com precisão declarada. Publicação parcial permanece inativa para ordens até S10; mocks não demonstram transação concorrente ou reconciliação SQL.

A [autorização de entrega](../ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-ganso-20--entrega-com-registro-minimo-22092026) cobre código → PR → merge → produção no escopo do prompt. Verificar o resultado e registrar somente a linha de acompanhamento; sem recibo, screenshots ou dossiê obrigatório. Dados de negócio necessários ao ledger e ao replay continuam obrigatórios. Ler esta seção e apenas S correspondente ao prompt, não todas as sessões.

## S1

**G2-05.1 — Persistir contas e eventos do perpétuo.** [Prompt da sessão](../../prompts/ganso-2/g2-05-1-ledger-contas.md). Dependências: G2-03.2, G2-04.1.

**Entrega:** Ledger e identidade das contas persistidos; contrato consumível pelos próximos módulos.

**Contrato desta fatia:** Implementar conta/experimento/instrumento e ledger append-only para capital, fill, fee, funding e liquidação como eventos tipados. Criar projeção inicial de saldo e posição e chaves idempotentes. A gênese de cada cenário vale US$ 1.000; reiniciar experimento cria outro ID. Não converter histórico Polymarket nem presumir migração de saldo legado.

**Aceite proporcional:** SQL real de duplicata com mesmo conteúdo, colisão com conteúdo diferente, dois donos e replay ordenado. Eventos inválidos não deixam projeção parcial. Nenhuma escrita de teste em produção.

**Implantação:** PR/merge/migration aditiva e deploy com conta/ordens BTC ainda não ativadas.

## S2

**G2-05.2 — Calcular saldo, patrimônio e valor de encerramento.** [Prompt da sessão](../../prompts/ganso-2/g2-05-2-pnl-marcacao.md). Dependências: G2-05.1, G2-04.3.

**Entrega:** Visão financeira BTC correta por conta com qualidade da marca explícita.

**Contrato desta fatia:** Implementar custo-base/realizado long e short, não realizado e patrimônio. Separar mark/oracle de manutenção e valor executável de encerramento. Reserva não é taxa; slippage embutido no fill não é debitado de novo. Marca ausente/stale torna resultado indisponível ou degradado, nunca zero lucro ou patrimônio artificialmente seguro.

**Aceite proporcional:** Fixtures independentes long/short com ganho/perda, parcial, custos, marca ausente e sinais opostos entre donos. Replay e projeção concordam em unidade mínima; endpoint de leitura não altera cache.

**Implantação:** PR/merge/deploy de leitura/cálculo, sem ativar ordens.

## S3

**G2-05.3 — Reservar margem e capacidade sem concorrência indevida.** [Prompt da sessão](../../prompts/ganso-2/g2-05-3-reservas-atomicas.md). Dependências: G2-05.2.

**Entrega:** Contrato reserve/consume/release atômico, compartilhável por manual e estratégia.

**Contrato desta fatia:** Implementar aceitação+reserva na mesma transação e lock por dono, contabilizando ordens pendentes, taxas estimadas e margem. Separar redução de posição de abertura; reservas não expiram apenas pelo relógio sem transição efetiva. Não emprestar capital entre contas experimentais.

**Aceite proporcional:** PostgreSQL real com duas ordens que somam mais que disponível, duas saídas sobre mesmo inventário, rollback, retry e troca parcial de reserva por posição. Ordem de locks evita deadlock previsível.

**Implantação:** PR/merge/migration aditiva e deploy inativo para novas ordens; risco completo ainda depende de S8.

## S4

**G2-05.4 — Executar IOC, parcial e cancelamento com custos.** [Prompt da sessão](../../prompts/ganso-2/g2-05-4-ioc-parcial-cancelamento.md). Dependências: G2-05.3, G2-04.3.

**Entrega:** Fluxo imediato e cancelamento preservam saldo, reserva e evidência de execução.

**Contrato desta fatia:** Implementar intenção executável com limite de preço, latência configurada, consumo de profundidade compartilhado e parcial IOC. Validar frescor e expiração antes do fill, aplicar fee uma vez e cancelar restante. Resolver corrida fill/cancelamento com estado efetivo; reduce-only nunca inverte posição. Não usar preços anteriores à decisão para preencher.

**Aceite proporcional:** Livro insuficiente, slippage limite, atraso, expiry durante processamento, fill/cancelamento concorrentes e profundidade disputada por ordens da mesma conta. SQL real para atomicidade; cenários alternativos usam mercados contrafactuais identificados.

**Implantação:** PR/merge/deploy do broker inativo para o operador até S10; sem ordens reais.

## S5

**G2-05.5 — Adicionar ordem passiva com fill conservador.** [Prompt da sessão](../../prompts/ganso-2/g2-05-5-ordens-passivas.md). Dependências: G2-05.4.

**Entrega:** Ordens passivas funcionam com limitação conservadora e auditável.

**Contrato desta fatia:** Implementar ordem post-only, validade e fila conservadora com hipóteses declaradas. Recusar ordem que cruzaria e exigir evidência posterior de execução, sem tratar toque no preço como fill garantido. Atualizações/cancelamento mantêm prioridade conforme modelo definido. Preservar dados mínimos que sustentam cada fill.

**Aceite proporcional:** Toque sem negociação não preenche; negociação insuficiente gera parcial ou zero conforme fila; cancelamento tardio, gap e restart não duplicam fill. Versionar modelo e identificar baixa fidelidade; comparar contra IOC apenas como cenário.

**Implantação:** PR/merge/deploy ainda sem ativar o fluxo manual. Não prometer posição de fila real da venue.

## S6

**G2-05.6 — Contabilizar funding com tempo e idempotência.** [Prompt da sessão](../../prompts/ganso-2/g2-05-6-funding.md). Dependências: G2-05.2, G2-04.3.

**Entrega:** Funding registrado uma vez e reconciliado por tempo econômico.

**Contrato desta fatia:** Aplicar funding observado no horário econômico e sobre a posição elegível naquele instante, com sinal correto long/short. Tratar chegada atrasada e reconciliação sem atribuir funding a posição aberta depois. Taxa ausente produz estado pendente, não custo zero silencioso. O funding altera saldo e métricas sem dupla incidência.

**Aceite proporcional:** Funding positivo/negativo, posição aberta/fechada junto ao corte, duplicata, atraso e restart. Replay chega ao mesmo saldo e risco diário inclui o efeito.

**Implantação:** PR/merge/deploy de componente ainda subordinado ao gate S10; sem consultas pagas.

**Emenda técnica de funding paper (25/09/2026):** o consumidor manual adota explicitamente `btc.funding.paper-precut.v2`: taxa final exata RATE18 e oracle de contexto HTTP recebido até 5000ms antes do corte, mantendo timestamp do preço desconhecido. É aproximação paper, não settlement exato da venue. O [contrato detalhado e limites](../runbooks/btc-manual-ticket.md#contrato-de-funding-para-posições-elegíveis) define seleção, evidência pinada, replay, empate no corte, pendências e campos que o manifesto deverá congelar. Envelope de recibo v1 e schema SQL42 preservados; recibos anteriores não são reescritos.

## S7

**G2-05.7 — Simular margem isolada e liquidação.** [Prompt da sessão](../../prompts/ganso-2/g2-05-7-margem-liquidacao.md). Dependências: G2-05.3, G2-05.6, G2-05.4.

**Entrega:** 1x tem manutenção e liquidação tratadas; patrimônio/reservas reconciliam.

**Contrato desta fatia:** Modelar margem isolada a1x com orçamento por posição, manutenção e gatilho por mark. Definir política conservadora de execução/custo da liquidação e déficit/gap; não equiparar stop a garantia. Bloquear abertura quando metadados ou marca não sustentarem o cálculo. Quantificar limitação do simulador sem fingir reproduzir detalhes não observados da venue.

**Aceite proporcional:** Long/short, aumento brusco de mark, funding que consome margem, parcial e gap além do nível. Liquidar não duplica fill/fee nem usa o caixa de outra conta; registrar saldo residual/deficit explicitamente.

**Implantação:** PR/merge/deploy inativo até S10; nenhuma alavancagem escolhida pela IA.

## S8

**G2-05.8 — Aplicar limites e estados operacionais às ordens.** [Prompt da sessão](../../prompts/ganso-2/g2-05-8-limites-e-pausa.md). Dependências: G2-05.7.

**Entrega:** Risco determinístico domina as intenções e permanece independente de Jev.

**Contrato desta fatia:** Implementar exposição 25%, risco planejado 0,25%, pausa diária 1,5% e drawdown 5% por conta, incluindo não realizado/fees/funding e reservas. Definir permissões de cancelamento/saída por estado e impedir inversão. Rearme exige condições e ação explícita, sem resetar âncoras. Manual e automático passam pela mesma avaliação.

**Aceite proporcional:** Limite atingido por marca/funding, duas entradas concorrentes, capital externo ajustando âncora, dados stale e saída durante pausa. Stop/slippage não são apresentados como perda máxima garantida.

**Implantação:** PR/merge/deploy de limites com broker ainda protegido pelo gate integrado; caps não são relaxados para gerar trades.

## S9

**G2-05.9 — Recuperar ordens e reservas após falha.** [Prompt da sessão](../../prompts/ganso-2/g2-05-9-retomada-reconciliacao.md). Dependências: G2-05.5, G2-05.8.

**Entrega:** Boot não duplica transações nem abre conta inconsistente.

**Contrato desta fatia:** Reconciliar ordens, posição, funding, reserva e estado de risco antes de aceitar novas intenções após boot. Persistir checkpoints necessários sem converter estado em memória em autoridade. Definir exclusão de dois workers para a mesma conta e replay de eventos atrasados. Falha na reconciliação mantém a conta fechada para aumento de risco.

**Aceite proporcional:** Queda antes/depois do commit de fill, funding, cancelamento e reserva; dois workers concorrentes; retry após resposta ambígua; projeção adulterada detectada/reconstruída. Usar PostgreSQL descartável.

**Implantação:** PR/merge/deploy e teste breve de restart controlado quando seguro, sem rearmar estratégias desativadas.

## S10

**G2-05.10 — Validar o ciclo financeiro integrado.** [Prompt da sessão](../../prompts/ganso-2/g2-05-10-aceite-financeiro.md). Dependências: G2-05.9.

**Entrega:** Ciclo financeiro integrado aprovado ou falha concreta identificada, sem confundir com rentabilidade.

**Contrato desta fatia:** Conectar os componentes e cobrir uma sequência long e uma short com parcial, cancelamento, saída, fee, funding, reserva e restart. Corrigir somente falhas de integração; se revelar mudança de contrato grande, declarar recorte em vez de reescrever tudo. Registrar prontidão técnica para o ticket; não exigir amostra de lucro.

**Aceite proporcional:** Gate SQL obrigatório sem skips, saldo/projeção/replay exatos após reinício e reconstrução das projeções. Reutilizar testes da suíte, sem repetir todos manualmente nem gerar relatório bruto/recibo separado.

**Implantação:** PR/merge/deploy com backend pronto; ativação de contas manuais ocorre com o ticket em G2-06.3. Falha técnica impede apenas a ativação dependente.
