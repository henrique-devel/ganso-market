# Ganso 2.0 — uma sessão por entrega

Pacote de desenvolvimento de 22/09/2026: **11 RFCs e 45 prompts pequenos**, derivados do [PRD aprovado](../../docs/PRD-GANSO-2.0.md). Roteiro criado; nenhum bloco de implementação foi executado por gerar estes arquivos.

## Como começar uma sessão

Por decisão do proprietário em 22/09, backup fica fora do ciclo até o sistema estar 100% operante. G2-02.2/3 foram retirados, sem implementação; os demais IDs permanecem estáveis. Nenhuma sessão depende desses blocos.

Abra somente o prompt escolhido. Exemplo de pedido:

> Execute somente `prompts/ganso-2/g2-00-1-base-reconciliada.md`. Siga o protocolo e conclua o escopo até PR, merge e implantação aplicável. Atualize a linha do acompanhamento e pare nesse bloco.

A [autorização contínua](../../docs/ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-ganso-20--entrega-com-registro-minimo-22092026) está repetida em cada prompt. Não pedir nova confirmação para código, PR, merge ou deploy cobertos. Validar o necessário e manter registro curto: **sem recibo, dossiê, screenshots ou export de evidências obrigatório por sessão**. Checks obrigatórios e verificações financeiras continuam válidos; não produzir prova artificial para encerrar.

Leia o [protocolo curto](00-protocolo.md), o contrato comum e a seção exata da RFC, além da linha selecionada no [acompanhamento único](../../docs/roadmap/GANSO_2_EXECUTION_STATE.md). Não ler o HANDOFF, todas as RFCs ou os 45 prompts. Alvo inicial: 3–6 arquivos de código e até 1.500 palavras documentais relevantes, expandindo só para uma dependência concreta.

## Ordem recomendada

1. **G2-00.1 → G2-01.1 → G2-01.2:** base e contenção. G2-01.1 também pode ser executado antes da reconciliação por ser leitura independente. Revalidar o risco de disco; os números de 22/09 são históricos.
2. **G2-00.2, G2-01.3/4 e G2-02.1:** destino do legado, falhas necessárias e classificação dos dados. Reparar serviço aposentado não é obrigação.
3. **G2-03.1/2/3/4 e G2-02.4:** núcleo/perfis e retenção. Ativação persistente depende da contenção, da política de retenção e da capacidade disponível.
4. **G2-04.1/2/3/4 → G2-05.1…10 → G2-06.1…4:** dados e operação manual. Algumas leituras/contratos podem ser feitos antes; conferir dependências de cada prompt.
5. **G2-07.1/2/3:** baseline. Depois **G2-08.1/2/3** para Jev e **G2-09.1…5** para comparação. Avaliação-base não depende de credencial Jev.
6. **G2-10.1…3:** custo e eventual migração quando o perfil estiver medido. G2-02.5 é limpeza condicional; não é pré-requisito artificial de todos os outros blocos.

A lista orienta prioridade; as dependências no frontmatter são o contrato exato. Cada sessão termina no próprio resultado. Não iniciar outras tarefas/agentes ou executar o próximo prompt automaticamente. Compartilhar arquivo, migration ou contrato exige coordenação se o proprietário solicitar sessões concorrentes.

## Escolha do prompt

### G2-00 — Base reconciliada e destino do legado

[RFC-042](../../docs/rfcs/RFC-042-ganso-2-base-e-passivo.md) · PRD seções 4 e 10.2 · RF-16.

| Sessão                                  | Depende de                              | Resultado                                |
| --------------------------------------- | --------------------------------------- | ---------------------------------------- |
| [G2-00.1](g2-00-1-base-reconciliada.md) | —                                       | Reconciliar a base de desenvolvimento    |
| [G2-00.2](g2-00-2-destino-do-legado.md) | [G2-00.1](g2-00-1-base-reconciliada.md) | Dar destino ao código e backlog herdados |

### G2-01 — Contenção e estabilidade do legado

[RFC-043](../../docs/rfcs/RFC-043-ganso-2-contencao-operacional.md) · PRD seções 2, 4 e 10.2 · RF-10, RF-15, RF-16.

| Sessão                                   | Depende de                                                                       | Resultado                                               |
| ---------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------- |
| [G2-01.1](g2-01-1-diagnostico-curto.md)  | —                                                                                | Diagnosticar capacidade e reinícios atuais              |
| [G2-01.2](g2-01-2-quiescencia-legado.md) | [G2-00.1](g2-00-1-base-reconciliada.md), [G2-01.1](g2-01-1-diagnostico-curto.md) | Conter coleta e quiescer serviços dispensáveis          |
| [G2-01.3](g2-01-3-falha-do-paper.md)     | [G2-01.2](g2-01-2-quiescencia-legado.md)                                         | Resolver a causa de reinícios que ainda afeta o produto |
| [G2-01.4](g2-01-4-transacoes-e-pools.md) | [G2-00.1](g2-00-1-base-reconciliada.md), [G2-01.1](g2-01-1-diagnostico-curto.md) | Prevenir transações ociosas e vazamento de conexões     |

### G2-02 — Retenção e proteção do histórico

[RFC-044](../../docs/rfcs/RFC-044-ganso-2-preservacao-retencao.md) · PRD seções 10 e 11 · RF-15, RF-16.

| Sessão                                      | Depende de                                                                                                                     | Resultado                                    |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| [G2-02.1](g2-02-1-manifesto-preservacao.md) | [G2-00.2](g2-00-2-destino-do-legado.md), [G2-01.1](g2-01-1-diagnostico-curto.md)                                               | Classificar dados protegidos e descartáveis  |
| [G2-02.4](g2-02-4-retencao-dados-novos.md)  | [G2-02.1](g2-02-1-manifesto-preservacao.md), [G2-03.1](g2-03-1-contratos-neutros.md)                                           | Limitar persistência de novos dados BTC      |
| [G2-02.5](g2-02-5-descarte-legado.md)       | [G2-01.2](g2-01-2-quiescencia-legado.md), [G2-02.1](g2-02-1-manifesto-preservacao.md), [G2-00.2](g2-00-2-destino-do-legado.md) | Executar somente a limpeza legada delimitada |

### G2-03 — Núcleo neutro e perfil de serviços

[RFC-045](../../docs/rfcs/RFC-045-ganso-2-nucleo-perfis.md) · PRD seções 4.2 e 9 · RF-01, RF-04, RF-16.

| Sessão                                     | Depende de                                                                         | Resultado                                    |
| ------------------------------------------ | ---------------------------------------------------------------------------------- | -------------------------------------------- |
| [G2-03.1](g2-03-1-contratos-neutros.md)    | [G2-00.1](g2-00-1-base-reconciliada.md)                                            | Definir tipos e fronteiras do núcleo BTC     |
| [G2-03.2](g2-03-2-extrair-primitivas.md)   | [G2-03.1](g2-03-1-contratos-neutros.md), [G2-00.2](g2-00-2-destino-do-legado.md)   | Extrair primitivas financeiras reutilizáveis |
| [G2-03.3](g2-03-3-perfis-ci-deploy.md)     | [G2-03.2](g2-03-2-extrair-primitivas.md), [G2-01.2](g2-01-2-quiescencia-legado.md) | Preparar perfil BTC, CI e deploy seletivo    |
| [G2-03.4](g2-03-4-remover-base-sem-uso.md) | [G2-00.2](g2-00-2-destino-do-legado.md), [G2-03.3](g2-03-3-perfis-ci-deploy.md)    | Retirar stubs e dependências sem consumidor  |

### G2-04 — Dados públicos BTC e qualidade

[RFC-046](../../docs/rfcs/RFC-046-ganso-2-dados-hyperliquid.md) · PRD seções 7.3, 9 e 10.1 · RF-02, RF-03, RF-15.

| Sessão                                    | Depende de                                                                                                                  | Resultado                                                 |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| [G2-04.1](g2-04-1-instrumento-e-sdk.md)   | [G2-03.2](g2-03-2-extrair-primitivas.md)                                                                                    | Integrar metadados do instrumento e adaptador público     |
| [G2-04.2](g2-04-2-feed-e-gaps.md)         | [G2-04.1](g2-04-1-instrumento-e-sdk.md)                                                                                     | Coletar livro, trades, mark e funding com gaps explícitos |
| [G2-04.3](g2-04-3-barras-persistencia.md) | [G2-04.2](g2-04-2-feed-e-gaps.md), [G2-02.4](g2-02-4-retencao-dados-novos.md)                                               | Persistir dados necessários e formar barras fechadas      |
| [G2-04.4](g2-04-4-ativar-coletor.md)      | [G2-04.3](g2-04-3-barras-persistencia.md), [G2-03.3](g2-03-3-perfis-ci-deploy.md), [G2-01.2](g2-01-2-quiescencia-legado.md) | Ativar coleta BTC com limites no servidor                 |

### G2-05 — Conta perpétua, execução e risco

[RFC-047](../../docs/rfcs/RFC-047-ganso-2-conta-execucao-risco.md) · PRD seções 7 e 13 · RF-04, RF-05, RF-07, RF-08, RF-09, RF-10.

| Sessão                                         | Depende de                                                                                                             | Resultado                                              |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| [G2-05.1](g2-05-1-ledger-contas.md)            | [G2-03.2](g2-03-2-extrair-primitivas.md), [G2-04.1](g2-04-1-instrumento-e-sdk.md)                                      | Persistir contas e eventos do perpétuo                 |
| [G2-05.2](g2-05-2-pnl-marcacao.md)             | [G2-05.1](g2-05-1-ledger-contas.md), [G2-04.3](g2-04-3-barras-persistencia.md)                                         | Calcular saldo, patrimônio e valor de encerramento     |
| [G2-05.3](g2-05-3-reservas-atomicas.md)        | [G2-05.2](g2-05-2-pnl-marcacao.md)                                                                                     | Reservar margem e capacidade sem concorrência indevida |
| [G2-05.4](g2-05-4-ioc-parcial-cancelamento.md) | [G2-05.3](g2-05-3-reservas-atomicas.md), [G2-04.3](g2-04-3-barras-persistencia.md)                                     | Executar IOC, parcial e cancelamento com custos        |
| [G2-05.5](g2-05-5-ordens-passivas.md)          | [G2-05.4](g2-05-4-ioc-parcial-cancelamento.md)                                                                         | Adicionar ordem passiva com fill conservador           |
| [G2-05.6](g2-05-6-funding.md)                  | [G2-05.2](g2-05-2-pnl-marcacao.md), [G2-04.3](g2-04-3-barras-persistencia.md)                                          | Contabilizar funding com tempo e idempotência          |
| [G2-05.7](g2-05-7-margem-liquidacao.md)        | [G2-05.3](g2-05-3-reservas-atomicas.md), [G2-05.6](g2-05-6-funding.md), [G2-05.4](g2-05-4-ioc-parcial-cancelamento.md) | Simular margem isolada e liquidação                    |
| [G2-05.8](g2-05-8-limites-e-pausa.md)          | [G2-05.7](g2-05-7-margem-liquidacao.md)                                                                                | Aplicar limites e estados operacionais às ordens       |
| [G2-05.9](g2-05-9-retomada-reconciliacao.md)   | [G2-05.5](g2-05-5-ordens-passivas.md), [G2-05.8](g2-05-8-limites-e-pausa.md)                                           | Recuperar ordens e reservas após falha                 |
| [G2-05.10](g2-05-10-aceite-financeiro.md)      | [G2-05.9](g2-05-9-retomada-reconciliacao.md)                                                                           | Validar o ciclo financeiro integrado                   |

### G2-06 — Mesa e transações simuladas do operador

[RFC-048](../../docs/rfcs/RFC-048-ganso-2-mesa-operador.md) · PRD seções 6 e 7 · RF-06, RF-14, RF-01.

| Sessão                                      | Depende de                                                                         | Resultado                                           |
| ------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------- |
| [G2-06.1](g2-06-1-consultas-da-mesa.md)     | [G2-05.2](g2-05-2-pnl-marcacao.md), [G2-03.3](g2-03-3-perfis-ci-deploy.md)         | Publicar leitura de contas, posições e ordens       |
| [G2-06.2](g2-06-2-comandos-autenticados.md) | [G2-05.10](g2-05-10-aceite-financeiro.md), [G2-06.1](g2-06-1-consultas-da-mesa.md) | Publicar comandos simulados idempotentes            |
| [G2-06.3](g2-06-3-ticket-simulado.md)       | [G2-06.2](g2-06-2-comandos-autenticados.md), [G2-04.4](g2-04-4-ativar-coletor.md)  | Entregar ticket e primeira operação manual completa |
| [G2-06.4](g2-06-4-operacoes-e-historico.md) | [G2-06.3](g2-06-3-ticket-simulado.md)                                              | Organizar operações, motivos e acervo legado        |

### G2-07 — Estratégia-base e experimento prospectivo

[RFC-049](../../docs/rfcs/RFC-049-ganso-2-estrategia-base.md) · PRD seções 8.1 e 8.3 · RF-11, RF-13, RF-09.

| Sessão                                        | Depende de                                                                                                                     | Resultado                                              |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| [G2-07.1](g2-07-1-manifesto-baseline.md)      | [G2-05.10](g2-05-10-aceite-financeiro.md)                                                                                      | Fechar a regra e o manifesto do primeiro experimento   |
| [G2-07.2](g2-07-2-politica-deterministica.md) | [G2-07.1](g2-07-1-manifesto-baseline.md), [G2-04.3](g2-04-3-barras-persistencia.md)                                            | Implementar sinal, tamanho e saídas da regra congelada |
| [G2-07.3](g2-07-3-ativar-baseline.md)         | [G2-07.2](g2-07-2-politica-deterministica.md), [G2-06.3](g2-06-3-ticket-simulado.md), [G2-01.4](g2-01-4-transacoes-e-pools.md) | Ligar a conta-base automática com risco e dedup        |

### G2-08 — Jev como filtro opcional e medido

[RFC-050](../../docs/rfcs/RFC-050-ganso-2-jev-challenger.md) · PRD seções 8.2 e 8.3 · RF-12, RF-01, RF-15.

| Sessão                                  | Depende de                                                                           | Resultado                                     |
| --------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------- |
| [G2-08.1](g2-08-1-adaptador-jev.md)     | [G2-03.2](g2-03-2-extrair-primitivas.md), [G2-07.1](g2-07-1-manifesto-baseline.md)   | Integrar respostas tipadas e limites de custo |
| [G2-08.2](g2-08-2-filtro-challenger.md) | [G2-08.1](g2-08-1-adaptador-jev.md), [G2-07.3](g2-07-3-ativar-baseline.md)           | Aplicar Jev ao mesmo candidato-base           |
| [G2-08.3](g2-08-3-ativar-challenger.md) | [G2-08.2](g2-08-2-filtro-challenger.md), [G2-06.4](g2-06-4-operacoes-e-historico.md) | Ativar comparação Jev dentro do orçamento     |

### G2-09 — Replay, avaliação e maturidade

[RFC-051](../../docs/rfcs/RFC-051-ganso-2-avaliacao-maturidade.md) · PRD seções 8.3, 9.1 e 15 · RF-13, RF-14, RF-10.

| Sessão                                      | Depende de                                                                               | Resultado                                              |
| ------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| [G2-09.1](g2-09-1-replay-dataset.md)        | [G2-07.3](g2-07-3-ativar-baseline.md), [G2-02.4](g2-02-4-retencao-dados-novos.md)        | Reproduzir decisões e conta a partir de dataset pinado |
| [G2-09.2](g2-09-2-metricas-e-atribuicao.md) | [G2-09.1](g2-09-1-replay-dataset.md)                                                     | Calcular resultado líquido e contribuição do filtro    |
| [G2-09.3](g2-09-3-painel-experimentos.md)   | [G2-09.2](g2-09-2-metricas-e-atribuicao.md), [G2-06.4](g2-06-4-operacoes-e-historico.md) | Entregar comparação e diagnóstico na interface         |
| [G2-09.4](g2-09-4-prontidao-operacional.md) | [G2-09.3](g2-09-3-painel-experimentos.md)                                                | Conferir retomada e janela operacional                 |
| [G2-09.5](g2-09-5-diagnostico-economico.md) | [G2-09.3](g2-09-3-painel-experimentos.md), [G2-07.3](g2-07-3-ativar-baseline.md)         | Concluir o primeiro ciclo econômico com honestidade    |

### G2-10 — Custo e eventual mudança de hospedagem

[RFC-052](../../docs/rfcs/RFC-052-ganso-2-custo-hospedagem.md) · PRD seções 11 · RF-15.

| Sessão                                       | Depende de                                                                                                                      | Resultado                                            |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| [G2-10.1](g2-10-1-orcamento-e-capacidade.md) | [G2-03.3](g2-03-3-perfis-ci-deploy.md), [G2-01.2](g2-01-2-quiescencia-legado.md), [G2-04.4](g2-04-4-ativar-coletor.md)          | Medir perfil e escolher manter ou migrar             |
| [G2-10.2](g2-10-2-preparar-migracao.md)      | [G2-10.1](g2-10-1-orcamento-e-capacidade.md)                                                                                    | Preparar instalação, corte e rollback do destino     |
| [G2-10.3](g2-10-3-executar-migracao.md)      | [G2-10.2](g2-10-2-preparar-migracao.md), [G2-05.10](g2-05-10-aceite-financeiro.md), [G2-09.4](g2-09-4-prontidao-operacional.md) | Migrar o ambiente aprovado e verificar o custo final |

## Limites já definidos

Paper BTC com US$ 1.000 fictícios por cenário; dados reais; Jev opcional; custo atual US$ 80/mês sem backup, teto total de planejamento US$ 80. Deploy não contrata servidor/API nem apaga conjunto produtivo desconhecido. Se faltar autorização específica para compra, descarte ou mudança de perímetro, concluir o trabalho independente e deixar proposta concreta antes de pedir somente a decisão restante. Não reabrir autorizações já existentes.

Sete dias operacionais e a janela econômica de cerca de 30 dias pertencem aos prompts G2-09.4/5. Não esperar essas janelas em cada entrega nem confundir registro enxuto com lucro, execução ou observação que não aconteceram.
