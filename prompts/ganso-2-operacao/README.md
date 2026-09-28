# Ganso 2.0 — estabilização e operação

**Escopo de 28/09/2026:** [BTC/Hyperliquid atual; JEV futuro](../../docs/SCOPE.md). G2-15.1–3 estão adiados; G2-14/16/17 avaliam a baseline sem exigir IA. Polymarket aposentada, com retirada autorizada.

Pacote solicitado em 27/09/2026: **sete etapas e 22 prompts**, continuação do ciclo de construção G2-00–10. Esta entrega cria o plano; nenhuma correção, ativação, observação ou chamada paga ocorreu por gerar estes arquivos.

[Roadmap e critérios](../../docs/roadmap/GANSO_2_OPERATIONAL_ROADMAP.md) · [Protocolo](00-protocolo.md) · [RFC-053](../../docs/rfcs/RFC-053-ganso-2-prontidao-operacional.md) · [Estado único](../../docs/roadmap/GANSO_2_EXECUTION_STATE.md).

## Como usar

Escolha a fatia pendente no acompanhamento atual; não reinicie G2-11.1. Exemplo de pedido (substitua o caminho pelo bloco escolhido):

> Execute somente `prompts/ganso-2-operacao/g2-11-1-diagnostico-e-erros.md`. Siga o protocolo, revalide a main e o estado atual, conclua o escopo até PR, merge e implantação aplicável, atualize a linha no acompanhamento e pare nesse bloco. Preserve alterações locais e não execute o próximo prompt automaticamente.

Nos próximos pedidos, substitua o caminho pelo prompt selecionado abaixo. Não é necessário copiar todos os documentos na conversa. A autorização contínua de entrega permanece; registre apenas uma linha, sem recibo obrigatório. Não criar chats/agentes/automação nem iniciar execução em lote só por ler o roteiro.

## Ordem recomendada

**G2-11 → G2-12 → G2-13 → G2-14 → G2-16 → G2-17** (G2-15 adiado), por resultado e gates, não por prazo prometido.

A lista abaixo preserva essa ordem de trabalho. O frontmatter declara dependências técnicas, permitindo que entregas independentes continuem se faltar uma decisão externa ou sinal de mercado. G2-15 fica adiado; não antecipar preparação de acesso, orçamento ou ativação. Sessões concorrentes só quando solicitadas e com arquivos/contratos coordenados.

Quando selecionado no futuro, G2-15.3 exige a operação preparada e comparação corrigida; não espera sete/trinta dias nem lucro da baseline. G2-16/17 aceitam Jev ausente com escopo explícito e não concluem a experiência com IA nesse caso. A janela econômica é pré-registrada antes dos resultados; pode correr durante a observação operacional. Falta de trade elegível não bloqueia código independente, mas impede afirmar ciclo automático demonstrado.

| Sessão | Resultado | Dependências técnicas |
| --- | --- | --- |
| [G2-11.1](g2-11-1-diagnostico-e-erros.md) | Revalidar a operação e tornar falhas diagnosticáveis | — |
| [G2-11.2](g2-11-2-locks-e-consumidor.md) | Corrigir contenção e falhas do consumidor baseline | G2-11.1 |
| [G2-11.3](g2-11-3-recuperacao-do-feed.md) | Recuperar falhas transitórias sem inventar continuidade | G2-11.1 |
| [G2-12.1](g2-12-1-plano-de-capacidade.md) | Fechar a solução de capacidade e custo | G2-11.1 |
| [G2-12.2](g2-12-2-persistencia-sustentavel.md) | Implementar persistência sustentável preservando evidências | G2-11.2, G2-12.1 |
| [G2-12.3](g2-12-3-admissao-e-retomada.md) | Admitir capacidade e retomar o coletor | G2-11.2, G2-11.3, G2-12.2 |
| [G2-13.1](g2-13-1-prontidao-visivel.md) | Expor prontidão operacional e telemetria útil | G2-11.1, G2-12.3 |
| [G2-13.2](g2-13-2-jornada-manual.md) | Validar a jornada manual paper ponta a ponta | G2-13.1 |
| [G2-13.3](g2-13-3-periodos-e-rearme.md) | Tratar horizonte do experimento e rearme controlado | G2-11.2, G2-12.3 |
| [G2-13.4](g2-13-4-baseline-operacional.md) | Retomar a baseline e demonstrar o ciclo automático | G2-13.2, G2-13.3 |
| [G2-14.1](g2-14-1-historico-de-patrimonio.md) | Persistir patrimônio com marcação temporal verificável | G2-12.2, G2-13.3 |
| [G2-14.2](g2-14-2-curva-e-drawdown.md) | Calcular curva, PnL aberto e drawdown | G2-14.1 |
| [G2-14.3](g2-14-3-janela-comum.md) | Comparar baseline e Jev com inícios diferentes | G2-13.3, G2-14.2 |
| [G2-14.4](g2-14-4-replay-da-janela.md) | Cobrir a janela completa sem truncar replay | G2-14.3 |
| [G2-14.5](g2-14-5-custos-referencias-painel.md) | Completar custos, referências e painel de avaliação | G2-14.2, G2-14.3, G2-14.4, G2-13.1 |
| Adiado — [G2-15.1](g2-15-1-preparar-acesso-jev.md) | Preparar acesso, tarifa e cobertura Jev | G2-11.1 |
| Adiado — [G2-15.2](g2-15-2-configuracao-e-orcamento-jev.md) | Entregar configuração e ciclo de orçamento Jev | G2-15.1 |
| Adiado — [G2-15.3](g2-15-3-ativar-jev-real.md) | Ativar e validar a comparação Jev real | G2-13.4, G2-14.5, G2-15.2 |
| [G2-16.1](g2-16-1-falhas-e-janela-operacional.md) | Verificar recuperação e iniciar observação operacional | G2-13.4, G2-14.5 |
| [G2-16.2](g2-16-2-aceite-sete-dias.md) | Concluir o aceite de sete dias de estabilidade | G2-16.1 |
| [G2-17.1](g2-17-1-cobertura-economica.md) | Verificar cobertura da janela econômica prospectiva | G2-14.5, G2-16.1 |
| [G2-17.2](g2-17-2-decisao-economica.md) | Concluir o experimento e delimitar a próxima hipótese | G2-17.1, G2-16.2 |

## Decisões e tempo

US$5 de Jev é teto proposto, não saldo ou compra autorizada. Backup permanece fora do pré-requisito atual. Sem novo capital real, descarte genérico, reset de histórico ou alteração de risco para obter atividade. Reutilizar decisões já concedidas; pedir só a decisão concreta que realmente faltar.

G2-16.2 e G2-17.1/2 são sessões de retorno: não esperar sete/trinta dias em loop e não criar agendamento sem pedido. O prazo começa no marco efetivo registrado, com gaps preservados. Consulte no roadmap a diferença entre código entregue, paper operante, Jev ativo e hipótese econômica avaliada.
