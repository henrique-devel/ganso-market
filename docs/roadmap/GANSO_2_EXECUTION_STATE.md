# Estado de execução — Ganso Market 2.0

Atualizado em **22/09/2026**. [PRD vigente](../PRD-GANSO-2.0.md) · [Roteiro dos prompts](../../prompts/ganso-2/README.md) · [Protocolo enxuto](../../prompts/ganso-2/00-protocolo.md).

Direção aprovada: BTC Hyperliquid, dados reais, US$ 1.000 fictícios por cenário e Jev opcional. Referência de custo informada: US$ 80/mês, sem backup. **11 RFCs e 45 prompts preparados; nenhum prompt de implementação foi executado nesta preparação.** Código→PR→merge→produção está autorizado quando a sessão for selecionada. Sem recibo ou evidência formal obrigatória por sessão.

## Como atualizar

Por decisão do proprietário em 22/09, backup fica fora do ciclo até o sistema estar 100% operante. G2-02.2/3 foram retirados, sem implementação; os demais IDs permanecem estáveis. Nenhuma sessão depende desses blocos.

Editar apenas a linha selecionada: estado e uma frase com PR/SHA, validação e deploy/pendência. Exemplo de formato, não resultado: `code-verified | PR <n>/SHA <sha>; testes focados/CI aprovados; deploy dispensado por texto`. Não criar um segundo tracker nem exigir arquivos de recibo.

Estados: `pending` não iniciado; `in-progress` em execução; `code-verified` código/artefato verificado (informar integração); `production-verified` implantação/ação efetivamente conferida; `observing` falta janela de observação; `blocked` impedimento real; `superseded` substituído/não aplicável com motivo. A ausência de relatório nunca determina bloqueio. Um marco está encerrado quando suas fatias aplicáveis estão concluídas no nível necessário; linhas condicionais podem terminar como superseded.

## Baseline e prioridade

Reconciliação G2-00.1 em **22/09/2026**: o repositório de trabalho é `ganso-market/ganso-market`, em `d04875aa2845081f8cd24f98fb10acc816fcb7c5`; a `main` remota consultada é `51621836ae5d90adeafeb915d4d664ce8d0b7900`, 84 commits à frente, sem commits exclusivos do HEAD local. A base da entrega é o checkout isolado `/private/tmp/ganso-g2-00-1`, branch `codex/g2-00-1-base-reconciliada`, criado nessa main. O repositório externo, em `a0792f6`, é outra superfície antiga e permanece intacto; suas exclusões aparentes não devem ser reaplicadas à base atual.

| Diferenças locais | Classificação / destino nesta sessão |
| --- | --- |
| 18 arquivos idênticos à main | Já integrados: CI/Makefile, parte das fixtures PG e registros EXEC-04/FIN-07; não reaplicar. |
| 19 arquivos fora do ciclo (10 diferentes da main e 9 só locais) | Preservar no checkout original: variantes QA-01/scripts PG, bridge/reads/resolution, estado BTC, estudo Monte Carlo e registros BTC-04/DB-01/EXEC-05. Não sobrescrever as versões mais novas da main. |
| 69 documentos do ciclo (6 alterações e 63 novos) | Delta útil publicado nesta entrega: PRD, pesquisas/coleta já existentes, RFCs 042–052, 45 prompts/protocolo/índice, estado e orientação/autorização 2.0; conservar a autorização pública já presente na main. |

Os 106 caminhos locais do repositório interno e 131 entradas do externo foram inventariados para conferir conteúdo, exclusões, HEAD e índice sem reset/stash; o trabalho permanece acessível nos diretórios originais. A publicação usa somente o delta documental acima.

Versões relidas via SSH com identidade fixada, às **23:07 UTC**: release em `/opt/ganso-market` e API/resolução `f2f5528`; paper/portfólio `6279457`; recorder `8132cd3`; estimator `da6d560`. Todas as referências existem no Git e são ancestrais da base. Entre a release `f2f5528` e a main `5162183` há apenas o fecho documental FIN-07; os demais SHAs refletem entregas seletivas anteriores. Nenhum serviço é afetado por esta entrega textual, sem reconstrução para uniformizar versões.

**FIN-07** já integrado pelos PRs [197](https://github.com/henrique-devel/ganso-market/pull/197), [199](https://github.com/henrique-devel/ganso-market/pull/199) e [200](https://github.com/henrique-devel/ganso-market/pull/200), com contratos financeiros por dono e migration 0026 na main; os 319 testes do fecho são históricos. **EXEC-05** tem recibo/fixture/resultados preservados localmente, ausentes na main consultada; a falha antiga antecede a correção FIN-07 e não comprova falha atual nem novo aceite integrado. A [issue 198](https://github.com/henrique-devel/ganso-market/issues/198) continua aberta: PR 199 corrigiu a inicialização da resolução, mas a origem da transação ociosa ainda precisa de investigação. Esta sessão não executou nova prova financeira.

Banco ~186,91 GiB, disco 30,96% disponível e 789 reinícios do paper pertencem à coleta histórica: **revalidar capacidade em G2-01.1 e priorizar contenção G2-01.2**. Não são medições operacionais desta sessão.

O [estado BTC anterior](BTC_EXECUTION_STATE.md) fica como histórico. Não alterar suas linhas em massa para aparentar conclusão do 2.0. A [auditoria](../research/ganso-2-infraestrutura-2026-09-22.md) e a coleta existente são referências, não novos relatórios exigidos.

## Sessões

### G2-00 — Base reconciliada e destino do legado

[RFC-042](../rfcs/RFC-042-ganso-2-base-e-passivo.md).

| Sessão                                                        | Estado  | Entrega / validação / implantação                              |
| ------------------------------------------------------------- | ------- | -------------------------------------------------------------- |
| [G2-00.1](../../prompts/ganso-2/g2-00-1-base-reconciliada.md) | code-verified | [PR #201](https://github.com/henrique-devel/ganso-market/pull/201), base 5162183; 237 entradas locais/HEAD/índices preservados, 544 links e 45 dependências conferidos, diff/scan aprovados; integração e checks consultáveis no PR; deploy dispensado por texto. |
| [G2-00.2](../../prompts/ganso-2/g2-00-2-destino-do-legado.md) | pending | Dar destino ao código e backlog herdados; ainda não executado. |

### G2-01 — Contenção e estabilidade do legado

[RFC-043](../rfcs/RFC-043-ganso-2-contencao-operacional.md).

| Sessão                                                         | Estado  | Entrega / validação / implantação                                             |
| -------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------- |
| [G2-01.1](../../prompts/ganso-2/g2-01-1-diagnostico-curto.md)  | pending | Diagnosticar capacidade e reinícios atuais; ainda não executado.              |
| [G2-01.2](../../prompts/ganso-2/g2-01-2-quiescencia-legado.md) | pending | Conter coleta e quiescer serviços dispensáveis; ainda não executado.          |
| [G2-01.3](../../prompts/ganso-2/g2-01-3-falha-do-paper.md)     | pending | Resolver a causa de reinícios que ainda afeta o produto; ainda não executado. |
| [G2-01.4](../../prompts/ganso-2/g2-01-4-transacoes-e-pools.md) | pending | Prevenir transações ociosas e vazamento de conexões; ainda não executado.     |

### G2-02 — Retenção e proteção do histórico

[RFC-044](../rfcs/RFC-044-ganso-2-preservacao-retencao.md).

| Sessão                                                            | Estado  | Entrega / validação / implantação                                  |
| ----------------------------------------------------------------- | ------- | ------------------------------------------------------------------ |
| [G2-02.1](../../prompts/ganso-2/g2-02-1-manifesto-preservacao.md) | pending | Classificar dados protegidos e descartáveis; ainda não executado.  |
| [G2-02.4](../../prompts/ganso-2/g2-02-4-retencao-dados-novos.md)  | pending | Limitar persistência de novos dados BTC; ainda não executado.      |
| [G2-02.5](../../prompts/ganso-2/g2-02-5-descarte-legado.md)       | pending | Executar somente a limpeza legada delimitada; ainda não executado. |

### G2-03 — Núcleo neutro e perfil de serviços

[RFC-045](../rfcs/RFC-045-ganso-2-nucleo-perfis.md).

| Sessão                                                           | Estado  | Entrega / validação / implantação                                  |
| ---------------------------------------------------------------- | ------- | ------------------------------------------------------------------ |
| [G2-03.1](../../prompts/ganso-2/g2-03-1-contratos-neutros.md)    | pending | Definir tipos e fronteiras do núcleo BTC; ainda não executado.     |
| [G2-03.2](../../prompts/ganso-2/g2-03-2-extrair-primitivas.md)   | pending | Extrair primitivas financeiras reutilizáveis; ainda não executado. |
| [G2-03.3](../../prompts/ganso-2/g2-03-3-perfis-ci-deploy.md)     | pending | Preparar perfil BTC, CI e deploy seletivo; ainda não executado.    |
| [G2-03.4](../../prompts/ganso-2/g2-03-4-remover-base-sem-uso.md) | pending | Retirar stubs e dependências sem consumidor; ainda não executado.  |

### G2-04 — Dados públicos BTC e qualidade

[RFC-046](../rfcs/RFC-046-ganso-2-dados-hyperliquid.md).

| Sessão                                                          | Estado  | Entrega / validação / implantação                                               |
| --------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------- |
| [G2-04.1](../../prompts/ganso-2/g2-04-1-instrumento-e-sdk.md)   | pending | Integrar metadados do instrumento e adaptador público; ainda não executado.     |
| [G2-04.2](../../prompts/ganso-2/g2-04-2-feed-e-gaps.md)         | pending | Coletar livro, trades, mark e funding com gaps explícitos; ainda não executado. |
| [G2-04.3](../../prompts/ganso-2/g2-04-3-barras-persistencia.md) | pending | Persistir dados necessários e formar barras fechadas; ainda não executado.      |
| [G2-04.4](../../prompts/ganso-2/g2-04-4-ativar-coletor.md)      | pending | Ativar coleta BTC com limites no servidor; ainda não executado.                 |

### G2-05 — Conta perpétua, execução e risco

[RFC-047](../rfcs/RFC-047-ganso-2-conta-execucao-risco.md).

| Sessão                                                               | Estado  | Entrega / validação / implantação                                            |
| -------------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------- |
| [G2-05.1](../../prompts/ganso-2/g2-05-1-ledger-contas.md)            | pending | Persistir contas e eventos do perpétuo; ainda não executado.                 |
| [G2-05.2](../../prompts/ganso-2/g2-05-2-pnl-marcacao.md)             | pending | Calcular saldo, patrimônio e valor de encerramento; ainda não executado.     |
| [G2-05.3](../../prompts/ganso-2/g2-05-3-reservas-atomicas.md)        | pending | Reservar margem e capacidade sem concorrência indevida; ainda não executado. |
| [G2-05.4](../../prompts/ganso-2/g2-05-4-ioc-parcial-cancelamento.md) | pending | Executar IOC, parcial e cancelamento com custos; ainda não executado.        |
| [G2-05.5](../../prompts/ganso-2/g2-05-5-ordens-passivas.md)          | pending | Adicionar ordem passiva com fill conservador; ainda não executado.           |
| [G2-05.6](../../prompts/ganso-2/g2-05-6-funding.md)                  | pending | Contabilizar funding com tempo e idempotência; ainda não executado.          |
| [G2-05.7](../../prompts/ganso-2/g2-05-7-margem-liquidacao.md)        | pending | Simular margem isolada e liquidação; ainda não executado.                    |
| [G2-05.8](../../prompts/ganso-2/g2-05-8-limites-e-pausa.md)          | pending | Aplicar limites e estados operacionais às ordens; ainda não executado.       |
| [G2-05.9](../../prompts/ganso-2/g2-05-9-retomada-reconciliacao.md)   | pending | Recuperar ordens e reservas após falha; ainda não executado.                 |
| [G2-05.10](../../prompts/ganso-2/g2-05-10-aceite-financeiro.md)      | pending | Validar o ciclo financeiro integrado; ainda não executado.                   |

### G2-06 — Mesa e transações simuladas do operador

[RFC-048](../rfcs/RFC-048-ganso-2-mesa-operador.md).

| Sessão                                                            | Estado  | Entrega / validação / implantação                                         |
| ----------------------------------------------------------------- | ------- | ------------------------------------------------------------------------- |
| [G2-06.1](../../prompts/ganso-2/g2-06-1-consultas-da-mesa.md)     | pending | Publicar leitura de contas, posições e ordens; ainda não executado.       |
| [G2-06.2](../../prompts/ganso-2/g2-06-2-comandos-autenticados.md) | pending | Publicar comandos simulados idempotentes; ainda não executado.            |
| [G2-06.3](../../prompts/ganso-2/g2-06-3-ticket-simulado.md)       | pending | Entregar ticket e primeira operação manual completa; ainda não executado. |
| [G2-06.4](../../prompts/ganso-2/g2-06-4-operacoes-e-historico.md) | pending | Organizar operações, motivos e acervo legado; ainda não executado.        |

### G2-07 — Estratégia-base e experimento prospectivo

[RFC-049](../rfcs/RFC-049-ganso-2-estrategia-base.md).

| Sessão                                                              | Estado  | Entrega / validação / implantação                                            |
| ------------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------- |
| [G2-07.1](../../prompts/ganso-2/g2-07-1-manifesto-baseline.md)      | pending | Fechar a regra e o manifesto do primeiro experimento; ainda não executado.   |
| [G2-07.2](../../prompts/ganso-2/g2-07-2-politica-deterministica.md) | pending | Implementar sinal, tamanho e saídas da regra congelada; ainda não executado. |
| [G2-07.3](../../prompts/ganso-2/g2-07-3-ativar-baseline.md)         | pending | Ligar a conta-base automática com risco e dedup; ainda não executado.        |

### G2-08 — Jev como filtro opcional e medido

[RFC-050](../rfcs/RFC-050-ganso-2-jev-challenger.md).

| Sessão                                                        | Estado  | Entrega / validação / implantação                                   |
| ------------------------------------------------------------- | ------- | ------------------------------------------------------------------- |
| [G2-08.1](../../prompts/ganso-2/g2-08-1-adaptador-jev.md)     | pending | Integrar respostas tipadas e limites de custo; ainda não executado. |
| [G2-08.2](../../prompts/ganso-2/g2-08-2-filtro-challenger.md) | pending | Aplicar Jev ao mesmo candidato-base; ainda não executado.           |
| [G2-08.3](../../prompts/ganso-2/g2-08-3-ativar-challenger.md) | pending | Ativar comparação Jev dentro do orçamento; ainda não executado.     |

### G2-09 — Replay, avaliação e maturidade

[RFC-051](../rfcs/RFC-051-ganso-2-avaliacao-maturidade.md).

| Sessão                                                            | Estado  | Entrega / validação / implantação                                            |
| ----------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------- |
| [G2-09.1](../../prompts/ganso-2/g2-09-1-replay-dataset.md)        | pending | Reproduzir decisões e conta a partir de dataset pinado; ainda não executado. |
| [G2-09.2](../../prompts/ganso-2/g2-09-2-metricas-e-atribuicao.md) | pending | Calcular resultado líquido e contribuição do filtro; ainda não executado.    |
| [G2-09.3](../../prompts/ganso-2/g2-09-3-painel-experimentos.md)   | pending | Entregar comparação e diagnóstico na interface; ainda não executado.         |
| [G2-09.4](../../prompts/ganso-2/g2-09-4-prontidao-operacional.md) | pending | Conferir retomada e janela operacional; ainda não executado.                 |
| [G2-09.5](../../prompts/ganso-2/g2-09-5-diagnostico-economico.md) | pending | Concluir o primeiro ciclo econômico com honestidade; ainda não executado.    |

### G2-10 — Custo e eventual mudança de hospedagem

[RFC-052](../rfcs/RFC-052-ganso-2-custo-hospedagem.md).

| Sessão                                                             | Estado  | Entrega / validação / implantação                                          |
| ------------------------------------------------------------------ | ------- | -------------------------------------------------------------------------- |
| [G2-10.1](../../prompts/ganso-2/g2-10-1-orcamento-e-capacidade.md) | pending | Medir perfil e escolher manter ou migrar; ainda não executado.             |
| [G2-10.2](../../prompts/ganso-2/g2-10-2-preparar-migracao.md)      | pending | Preparar instalação, corte e rollback do destino; ainda não executado.     |
| [G2-10.3](../../prompts/ganso-2/g2-10-3-executar-migracao.md)      | pending | Migrar o ambiente aprovado e verificar o custo final; ainda não executado. |

## Destino do legado

Tabela a completar em G2-00.2, sem documento paralelo obrigatório. O PRD seção 12.1 já define a direção das famílias OPS/DB/DATA/FIN/EXEC/FRESH/BTC/REPLAY/EXP/GATE; confirmar somente o que muda com o código real.

| Componente / família  | Destino       | Bloco responsável / observação                                 |
| --------------------- | ------------- | -------------------------------------------------------------- |
| Inventário do passivo | A reconciliar | G2-00.2; preservar alterações locais e contratos já integrados |

Não considerar “arquivado” equivalente a corrigido. Se um prompt crescer, adicionar sublinha com escopo/dependência explícitos; não duplicar autorização, relatório ou tracker.
