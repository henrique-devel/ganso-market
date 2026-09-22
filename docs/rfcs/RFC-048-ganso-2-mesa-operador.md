# RFC-048 — Mesa e transações simuladas do operador

**Status:** accepted para execução de seus prompts quando selecionados. **Data:** 22/09/2026. **Marco:** G2-06. Criar esta RFC não implementa nem ativa o resultado.

**Fonte:** [PRD 2.0](../PRD-GANSO-2.0.md), seções 6 e 7. **Requisitos:** RF-06, RF-14, RF-01. **Roteiro:** [prompts](../../prompts/ganso-2/README.md). **Acompanhamento:** [estado 2.0](../roadmap/GANSO_2_EXECUTION_STATE.md).

## Contrato comum

Interface em português orientada a ações, com SIMULAÇÃO visível, conta e frescor claros. Comprar/vender, cancelar e encerrar são ações distintas e usam o mesmo backend financeiro. Origem da explicação é o registro que causou a decisão. Não somar cenários alternativos. APIs de leitura não escrevem estado financeiro.

A [autorização de entrega](../ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-ganso-20--entrega-com-registro-minimo-22092026) cobre código → PR → merge → produção no escopo do prompt. Verificar o resultado e registrar somente a linha de acompanhamento; sem recibo, screenshots ou dossiê obrigatório. Dados de negócio necessários ao ledger e ao replay continuam obrigatórios. Ler esta seção e apenas S correspondente ao prompt, não todas as sessões.

## S1

**G2-06.1 — Publicar leitura de contas, posições e ordens.** [Prompt da sessão](../../prompts/ganso-2/g2-06-1-consultas-da-mesa.md). Dependências: G2-05.2, G2-03.3.

**Entrega:** Backend de consulta pronto para a interface.

**Contrato desta fatia:** Adicionar consultas autenticadas e paginadas da conta selecionada, posição, ordens, saldo/margem, marca e frescor. Expor motivos estruturados sem transformar ausência em zero. Usar projeções eficientes, sem reconstruir todo ledger em cada refresh nem misturar patrimônio dos cenários.

**Aceite proporcional:** Conta sem marca, conta inexistente, acesso não autenticado, paginação e ausência de side effect financeiro. Contrato permite estado indisponível.

**Implantação:** PR/merge/deploy de leitura; perfis financeiros incompletos continuam sem rotas de transação ativas.

## S2

**G2-06.2 — Publicar comandos simulados idempotentes.** [Prompt da sessão](../../prompts/ganso-2/g2-06-2-comandos-autenticados.md). Dependências: G2-05.10, G2-06.1.

**Entrega:** API transacional paper segura e com recusas úteis.

**Contrato desta fatia:** Expor prévia de custo/reserva e comandos de enviar, cancelar, solicitar fechamento e pausar entradas. Intenções assinadas pela sessão lógica do owner e chaves de idempotência; o backend revalida preço, frescor e risco no aceite. Permitir somente rotas paper no perímetro atual, sem ampliar origem/rede.

**Aceite proporcional:** Duplo clique/retry não duplica ordem; CSRF/auth recusam; payload inválido, saldo insuficiente e corrida de fechamento mantêm contratos. Prévia não garante fill nem substitui revalidação.

**Implantação:** PR/merge/deploy com controles de ativação e cliente ainda a conectar; alteração de rota autenticada necessária ao PRD está no escopo.

## S3

**G2-06.3 — Entregar ticket e primeira operação manual completa.** [Prompt da sessão](../../prompts/ganso-2/g2-06-3-ticket-simulado.md). Dependências: G2-06.2, G2-04.4.

**Entrega:** Operador realiza e entende uma transação simulada de ponta a ponta.

**Contrato desta fatia:** Criar ticket BTC para compra/venda, quantidade/nocional, tipo, validade e proteção de preço, exibindo custo/reserva/risco. Integrar estados de parcial, cancelamento solicitado/efetivo e saída. Ativar somente a conta manual paper com gênese idempotente US$ 1.000; manual não contorna limites. Manter indicador de fonte real, saldo fictício e marca stale.

**Aceite proporcional:** Percorrer no ambiente apropriado abertura, parcial/cancelamento e fechamento; verificar retorno do saldo/posição no extrato. Testes do fluxo crítico e uma checagem de UI responsiva; sem exigir screenshots/relatório formal.

**Implantação:** PR/merge/deploy e ativação do ticket manual estão autorizados após dependências técnicas. Estratégias automáticas continuam desativadas.

## S4

**G2-06.4 — Organizar operações, motivos e acervo legado.** [Prompt da sessão](../../prompts/ganso-2/g2-06-4-operacoes-e-historico.md). Dependências: G2-06.3.

**Entrega:** Mesa compreensível e histórico acessível sem misturar mercados e cenários.

**Contrato desta fatia:** Organizar Mesa/Operações/Experimentos/Sistema, deixando acervo Polymarket identificado fora do fluxo BTC padrão. Mostrar ficha da operação com inputs, motivos, custos e execução efetiva. Diferenciar falta de sinal, veto, falha e coleta em warmup. Não preencher explicação causal com texto inventado após o resultado.

**Aceite proporcional:** Navegação, seleção de conta, dado ausente, motivo de recusa e drilldown até fill. Checagem de leitura sem mutações e sem painel que some as três contas.

**Implantação:** PR/merge/deploy da interface; preservar acesso ao histórico necessário e retirar controles mortos.
