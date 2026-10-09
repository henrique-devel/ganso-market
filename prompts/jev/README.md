# Prompts de implantação do Ganso Market com JEV

Formato aprovado em **07/10/2026**: **14 entregas agrupadas (JE01–JE14), 52 IDs rastreáveis e seis etapas operacionais separadas**. Os 43 itens de código e três diagnósticos passam a ser checkpoints das entregas. Os 16 blocos GJ00–GJ15 continuam descrevendo a arquitetura; cada ID preserva seu contrato e aceite. Uma sessão pode executar todo o grupo com checkpoints internos, sem novo prompt do proprietário a cada parte.

A preparação de 07/10 foi documental e não iniciou entregas. O [estado de execução](../../docs/roadmap/GANSO_JEV_EXECUTION_STATE.md) registra as implementações/publicações posteriores.

**Complemento de 09/10/2026:** [JE15–JE17](../../docs/roadmap/GANSO_JEV_LIVE_COMPLETION_PLAN.md) acrescentam três entregas/10 checkpoints para as lacunas de runtime, controles e painel live. Total atual: **17 entregas, 62 IDs rastreáveis e as mesmas seis etapas operacionais**. Os novos itens estão planned; este pedido prepara documentos, sem executar código/operação.

## Como executar

Selecione a entrega no quadro abaixo. O agente lê seu prompt, o [protocolo](00-protocolo.md), os checkpoints conforme avança e as linhas correspondentes no [estado](../../docs/roadmap/GANSO_JEV_EXECUTION_STATE.md). A autorização cobre alteração, PR, merge e publicação aplicável de todo o grupo; testes específicos acontecem durante a implementação, e revisão/PR/checks completos/implantação são consolidados no fechamento.

Comece por [JE01 — Base reconciliada](entregas/je-01-base-reconciliada.md). Pedido pronto:

```text
Leia e execute integralmente prompts/jev/entregas/je-01-base-reconciliada.md.
Conclua todos os checkpoints da entrega, avance entre eles sem novo pedido,
faça as validações e a publicação aplicável e atualize o estado de execução.
Encerre após JE01, respeitando os gates e a autorização registrada.
```

Depois, selecione a próxima entrega com dependências verificadas. Uma sequência só é executada se explicitamente solicitada; não criar chats/agentes por selecionar uma entrega. Um pedido restrito a um ID GJ continua restrito àquele contrato. Se o aceite já estiver entregue, verifique e registre reaproveitamento; não refaça código nem crie PR vazio.

## Entregas agrupadas

| Entrega executável | Resultado | Checkpoints incluídos | Depende de entregas |
| --- | --- | --- | --- |
| [JE01](entregas/je-01-base-reconciliada.md) | Base reconciliada | GJ00.1, GJ00.2 | Nenhuma |
| [JE02](entregas/je-02-contratos-e-manifestos.md) | Contratos e manifestos | GJ01.1, GJ01.2, GJ01.3, GJ02.1, GJ02.2 | JE01 |
| [JE03](entregas/je-03-retencao-e-viabilidade.md) | Retenção e viabilidade | GJ02.3, GJ02.4 | JE02 |
| [JE04](entregas/je-04-decisao-jev-integrada.md) | Decisão JEV integrada | GJ03.1, GJ03.2, GJ03.3, GJ03.4 | JE02 |
| [JE05](entregas/je-05-risco-e-dimensionamento.md) | Risco e dimensionamento | GJ04.1, GJ04.2, GJ04.3 | JE02 |
| [JE06](entregas/je-06-execucao-e-protecao.md) | Execução e proteção | GJ05.1, GJ05.2, GJ05.3, GJ06.1 | JE05 |
| [JE07](entregas/je-07-worker-e-cadencias.md) | Worker e cadências | GJ06.2, GJ06.3 | JE04, JE06 |
| [JE08](entregas/je-08-contabilidade-e-referencias.md) | Contabilidade e referências | GJ07.1, GJ07.2, GJ07.3 | JE03, JE07 |
| [JE09](entregas/je-09-avaliacao-continua.md) | Avaliação contínua | GJ08.1, GJ08.2, GJ08.3 | JE08 |
| [JE10](entregas/je-10-perfis-simultaneos.md) | Perfis simultâneos | GJ09.1, GJ09.2, GJ09.3 | JE09 |
| [JE11](entregas/je-11-painel-e-prontidao.md) | Painel e prontidão | GJ10.1, GJ10.2, GJ10.3, GJ12.1 | JE10 |
| [JE12](entregas/je-12-gerador-e-fila.md) | Gerador e fila | GJ11.1, GJ11.2, GJ11.3, GJ11.4 | JE11 |
| [JE13](entregas/je-13-adaptador-live-e-protecao-nativa.md) | Adaptador live e proteção nativa | GJ13.1, GJ13.2, GJ13.3, GJ13.4 | JE10 |
| [JE14](entregas/je-14-promocao-e-sucessao.md) | Promoção e sucessão | GJ14.1, GJ14.2, GJ14.3 | JE12, JE13 |

Dependências acima são resumidas transitivamente. Os `depends_on` por ID no catálogo permanecem e devem ser conferidos. Contratos internos podem ser comprovados na mesma branch; contratos externos devem estar integrados ou comprovados na base de trabalho. O número da entrega identifica o grupo, sem obrigar ordem serial entre grupos independentes.

## Complemento JE15–JE17

Mesmo formato e protocolo do pacote original. Ordem JE15 → JE16 → JE17; entradas reais exigem todas integradas e os gates operacionais existentes. A preparação não executa os grupos.

| Entrega executável | Resultado | Checkpoints incluídos | Depende de entregas |
| --- | --- | --- | --- |
| [JE15](entregas/je-15-runtime-live-integrado.md) | Runtime live integrado | GJ16.1, GJ16.2, GJ16.3, GJ16.4 | JE07, JE13, JE14 |
| [JE16](entregas/je-16-pausa-e-emergencia-live.md) | Pausa e emergência live | GJ17.1, GJ17.2, GJ17.3 | JE11, JE15 |
| [JE17](entregas/je-17-painel-financeiro-e-operacional-live.md) | Painel financeiro e operacional live | GJ18.1, GJ18.2, GJ18.3 | JE08, JE11, JE15, JE16 |

Pedidos prontos e justificativa dos aceites no [plano complementar](../../docs/roadmap/GANSO_JEV_LIVE_COMPLETION_PLAN.md). Não iniciar outra entrega/chat/agente automaticamente.

## Etapas operacionais separadas

| Etapa executável | Condição e resultado |
| --- | --- |
| [GJ12.2](gj-12-2-admitir-paper-e-iniciar-observacao-tecnica.md) | Admitir paper com prontidão, capacidade, cobertura/tarifa e orçamento efetivos; iniciar observação. |
| [GJ12.3](gj-12-3-verificar-qualificacao-observada-do-motor.md) | Conferir sete dias operacionais válidos; registrar observing se ainda incompletos. |
| [GJ13.5](gj-13-5-validar-o-adaptador-em-ambiente-controlado-da-venue.md) | Ensaiar o adaptador na testnet dedicada, com identidade e fundos de teste existentes. |
| [GJ15.1](gj-15-1-conferir-readiness-do-piloto-e-ativacao-pelo-operador.md) | Conferir qualificação, validação da venue, elegibilidade atual e ato autenticado do operador. |
| [GJ15.2](gj-15-2-verificar-piloto-ativo-e-reconciliacao-observada.md) | Observar piloto efetivamente ativo, proteção, custos e reconciliação. |
| [GJ15.3](gj-15-3-verificar-avaliacao-continua-e-janela-completa.md) | Conferir avaliação contínua e janela completa de 90 dias; registrar incompletude real. |

Sete dias, 60 episódios por conta e 90 dias são evidência prospectiva do produto. Código pronto pode ser publicado desativado enquanto esses gates estiverem pendentes. Fixtures, testes locais e status de deploy não os aprovam. As etapas de observação registram observing/inconclusivo e a condição de retorno quando faltar tempo/dado; não criam agendamento por conta própria.

## Contexto, validação e retomada

Dimensione pelo contrato funcional, sem teto de 3–6 arquivos ou uma migration por sessão. Leia cada contrato/seção uma vez e abra símbolos conforme necessário; não anexar todos os grupos, RFCs, logs ou histórico. Uma entrega maior preserva testes internos de risco, ledger, concorrência, cancel/fill, restart e proteção. Corrija falhas antes de avançar à parte dependente.

No fechamento de cada entrega, execute a validação completa e os checks obrigatórios da base/PR/main. Não repetir a suíte completa entre checkpoints sem motivo; não dispensar PostgreSQL real, integração Compose, revisão ou proteções. Use preferencialmente um PR coerente por grupo; divida apenas quando a fronteira funcional/compatibilidade exigir, mantendo o grupo aberto até todos os aceites.

Na retomada, registre base/branch, IDs validados, delta, falhas, próximo checkpoint e publicação no estado existente. Não habilitar stubs nem marcar grupo parcialmente concluído como pronto. Atualize a linha do grupo e apenas seus IDs; os mesmos PR/SHA podem cobrir vários checkpoints. Sem recibo, relatório ou pasta de evidência separados.

## Sequência para reduzir espera

Após JE02, JE03 (retenção/viabilidade), JE04 (JEV) e JE05 (risco) têm dependências de código independentes. JE07 integra JEV com execução/proteção; JE08–JE10 fecham avaliação e três pares. Após JE10, JE11 (painel/prontidão) e JE13 (adaptador desativado) podem avançar em frentes distintas. Partes de JE12 podem avançar após JE09, mas a fila/entrega completa depende de JE11; siga os `depends_on` de cada checkpoint.

Quando houver pedido de trabalho paralelo, começar com até duas frentes coordenadas, dono definido para arquivos/contratos e migrations numeradas sem colisão. Integração serial dos deltas e checks obrigatórios continuam. Não iniciar agentes automaticamente.

Após JE11/JE12 e gates reais, selecionar GJ12.2 para iniciar a observação; não esperar sete dias para desenvolver JE13/JE14 desativados. Selecionar GJ13.5 com conta testnet admissível. Qualificação/elegibilidade/ativação pelo operador condicionam o piloto; a janela completa de 90 dias não é requisito temporal inicial adicional. Otimização do executor PostgreSQL depende de medição posterior; este pacote não altera o pipeline nem promete tempo de execução.

## Catálogo dos 52 contratos e aceites

| ID | Entrega | Contrato | Depende de código | Resultado |
| --- | --- | --- | --- | --- |
| GJ00.1 | [JE01](entregas/je-01-base-reconciliada.md) | [Reconciliar a base de trabalho](gj-00-1-reconciliar-a-base-de-trabalho.md) | Nenhuma | Base ou viabilidade verificadas |
| GJ00.2 | [JE01](entregas/je-01-base-reconciliada.md) | [Conferir runtime schema e checks da base](gj-00-2-conferir-runtime-schema-e-checks-da-base.md) | GJ00.1 | Base ou viabilidade verificadas |
| GJ01.1 | [JE02](entregas/je-02-contratos-e-manifestos.md) | [Versionar contratos de perfis e contas](gj-01-1-versionar-contratos-de-perfis-e-contas.md) | GJ00.2 | Aceite verificado na entrega |
| GJ01.2 | [JE02](entregas/je-02-contratos-e-manifestos.md) | [Adaptar gênese e replay ao capital explícito](gj-01-2-adaptar-genese-e-replay-ao-capital-explicito.md) | GJ01.1 | Aceite verificado na entrega |
| GJ01.3 | [JE02](entregas/je-02-contratos-e-manifestos.md) | [Persistir registro de perfis e pares de contas](gj-01-3-persistir-registro-de-perfis-e-pares-de-contas.md) | GJ01.2 | Aceite verificado na entrega |
| GJ02.1 | [JE02](entregas/je-02-contratos-e-manifestos.md) | [Computar contexto e manifestos iniciais](gj-02-1-computar-contexto-e-manifestos-iniciais.md) | GJ01.3 | Aceite verificado na entrega |
| GJ02.2 | [JE02](entregas/je-02-contratos-e-manifestos.md) | [Fixar gatilhos cadência e contrato de saídas](gj-02-2-fixar-gatilhos-cadencia-e-contrato-de-saidas.md) | GJ02.1 | Aceite verificado na entrega |
| GJ02.3 | [JE03](entregas/je-03-retencao-e-viabilidade.md) | [Definir evidência mínima e retenção protegida](gj-02-3-definir-evidencia-minima-e-retencao-protegida.md) | GJ02.2 | Aceite verificado na entrega |
| GJ02.4 | [JE03](entregas/je-03-retencao-e-viabilidade.md) | [Admitir viabilidade inicial de capacidade e JEV](gj-02-4-admitir-viabilidade-inicial-de-capacidade-e-jev.md) | GJ00.2, GJ02.3 | Base ou viabilidade verificadas |
| GJ03.1 | [JE04](entregas/je-04-decisao-jev-integrada.md) | [Definir escolhas JEV e vínculo por conta](gj-03-1-definir-escolhas-jev-e-vinculo-por-conta.md) | GJ02.2 | Aceite verificado na entrega |
| GJ03.2 | [JE04](entregas/je-04-decisao-jev-integrada.md) | [Persistir pools e reserva de custo JEV](gj-03-2-persistir-pools-e-reserva-de-custo-jev.md) | GJ03.1 | Aceite verificado na entrega |
| GJ03.3 | [JE04](entregas/je-04-decisao-jev-integrada.md) | [Integrar transporte de lotes por perfil](gj-03-3-integrar-transporte-de-lotes-por-perfil.md) | GJ03.2 | Aceite verificado na entrega |
| GJ03.4 | [JE04](entregas/je-04-decisao-jev-integrada.md) | [Registrar decisões e replay das respostas originais](gj-03-4-registrar-decisoes-e-replay-das-respostas-originais.md) | GJ03.3 | Aceite verificado na entrega |
| GJ04.1 | [JE05](entregas/je-05-risco-e-dimensionamento.md) | [Aplicar limites persistentes por conta](gj-04-1-aplicar-limites-persistentes-por-conta.md) | GJ02.2, GJ01.2 | Aceite verificado na entrega |
| GJ04.2 | [JE05](entregas/je-05-risco-e-dimensionamento.md) | [Dimensionar entradas com stop e tolerância nativa](gj-04-2-dimensionar-entradas-com-stop-e-tolerancia-nativa.md) | GJ04.1 | Aceite verificado na entrega |
| GJ04.3 | [JE05](entregas/je-05-risco-e-dimensionamento.md) | [Persistir supervisor global do piloto](gj-04-3-persistir-supervisor-global-do-piloto.md) | GJ04.1, GJ01.3 | Aceite verificado na entrega |
| GJ05.1 | [JE06](entregas/je-06-execucao-e-protecao.md) | [Unificar contratos de liquidez maker e IOC](gj-05-1-unificar-contratos-de-liquidez-maker-e-ioc.md) | GJ04.2 | Aceite verificado na entrega |
| GJ05.2 | [JE06](entregas/je-06-execucao-e-protecao.md) | [Implementar cotação chegada e fila maker](gj-05-2-implementar-cotacao-chegada-e-fila-maker.md) | GJ05.1, GJ02.2 | Aceite verificado na entrega |
| GJ05.3 | [JE06](entregas/je-06-execucao-e-protecao.md) | [Integrar cancelamento parcial e saída IOC](gj-05-3-integrar-cancelamento-parcial-e-saida-ioc.md) | GJ05.2 | Aceite verificado na entrega |
| GJ06.1 | [JE06](entregas/je-06-execucao-e-protecao.md) | [Extrair supervisor de proteção dos perfis](gj-06-1-extrair-supervisor-de-protecao-dos-perfis.md) | GJ05.3, GJ04.3 | Aceite verificado na entrega |
| GJ06.2 | [JE07](entregas/je-07-worker-e-cadencias.md) | [Separar worker de execução da API](gj-06-2-separar-worker-de-execucao-da-api.md) | GJ06.1, GJ03.4 | Aceite verificado na entrega |
| GJ06.3 | [JE07](entregas/je-07-worker-e-cadencias.md) | [Integrar cadências e descartar decisões obsoletas](gj-06-3-integrar-cadencias-e-descartar-decisoes-obsoletas.md) | GJ06.2 | Aceite verificado na entrega |
| GJ07.1 | [JE08](entregas/je-08-contabilidade-e-referencias.md) | [Separar despesa real e custo de avaliação](gj-07-1-separar-despesa-real-e-custo-de-avaliacao.md) | GJ03.4, GJ02.3 | Aceite verificado na entrega |
| GJ07.2 | [JE08](entregas/je-08-contabilidade-e-referencias.md) | [Publicar PnL e resultado conservador](gj-07-2-publicar-pnl-e-resultado-conservador.md) | GJ07.1, GJ06.3 | Aceite verificado na entrega |
| GJ07.3 | [JE08](entregas/je-08-contabilidade-e-referencias.md) | [Construir referências caixa e BTC protegido](gj-07-3-construir-referencias-caixa-e-btc-protegido.md) | GJ05.3, GJ04.1, GJ02.3 | Aceite verificado na entrega |
| GJ08.1 | [JE09](entregas/je-09-avaliacao-continua.md) | [Contar episódios e medir cobertura real](gj-08-1-contar-episodios-e-medir-cobertura-real.md) | GJ07.2 | Aceite verificado na entrega |
| GJ08.2 | [JE09](entregas/je-09-avaliacao-continua.md) | [Avaliar elegibilidade inicial e estados do perfil](gj-08-2-avaliar-elegibilidade-inicial-e-estados-do-perfil.md) | GJ08.1, GJ07.3, GJ04.3 | Aceite verificado na entrega |
| GJ08.3 | [JE09](entregas/je-09-avaliacao-continua.md) | [Implementar avaliação rolling de 90 dias](gj-08-3-implementar-avaliacao-rolling-de-90-dias.md) | GJ08.2 | Aceite verificado na entrega |
| GJ09.1 | [JE10](entregas/je-10-perfis-simultaneos.md) | [Generalizar registro e dispatch de três perfis](gj-09-1-generalizar-registro-e-dispatch-de-tres-perfis.md) | GJ08.3 | Aceite verificado na entrega |
| GJ09.2 | [JE10](entregas/je-10-perfis-simultaneos.md) | [Integrar stress prospectivo independente](gj-09-2-integrar-stress-prospectivo-independente.md) | GJ09.1 | Aceite verificado na entrega |
| GJ09.3 | [JE10](entregas/je-10-perfis-simultaneos.md) | [Validar carga e ciclo integrado dos pares](gj-09-3-validar-carga-e-ciclo-integrado-dos-pares.md) | GJ09.2, GJ02.4 | Aceite verificado na entrega |
| GJ10.1 | [JE11](entregas/je-11-painel-e-prontidao.md) | [Exibir perfis PnL e limites](gj-10-1-exibir-perfis-pnl-e-limites.md) | GJ09.3 | Aceite verificado na entrega |
| GJ10.2 | [JE11](entregas/je-11-painel-e-prontidao.md) | [Exibir decisões proteção e custos separados](gj-10-2-exibir-decisoes-protecao-e-custos-separados.md) | GJ10.1 | Aceite verificado na entrega |
| GJ10.3 | [JE11](entregas/je-11-painel-e-prontidao.md) | [Implementar controles de pausa e emergência](gj-10-3-implementar-controles-de-pausa-e-emergencia.md) | GJ10.2, GJ04.3 | Aceite verificado na entrega |
| GJ11.1 | [JE12](entregas/je-12-gerador-e-fila.md) | [Persistir propostas fingerprints e uma mudança](gj-11-1-persistir-propostas-fingerprints-e-uma-mudanca.md) | GJ01.3, GJ02.2, GJ08.3 | Aceite verificado na entrega |
| GJ11.2 | [JE12](entregas/je-12-gerador-e-fila.md) | [Gerar por vaga e validar coerência com JEV](gj-11-2-gerar-por-vaga-e-validar-coerencia-com-jev.md) | GJ11.1, GJ03.4, GJ07.1 | Aceite verificado na entrega |
| GJ11.3 | [JE12](entregas/je-12-gerador-e-fila.md) | [Criar fila curta editável pelo operador](gj-11-3-criar-fila-curta-editavel-pelo-operador.md) | GJ11.2, GJ10.3 | Aceite verificado na entrega |
| GJ11.4 | [JE12](entregas/je-12-gerador-e-fila.md) | [Admitir sucessoras paper após encerramento](gj-11-4-admitir-sucessoras-paper-apos-encerramento.md) | GJ11.3, GJ09.3 | Aceite verificado na entrega |
| GJ12.1 | [JE11](entregas/je-11-painel-e-prontidao.md) | [Implementar readiness e evidência de qualificação](gj-12-1-implementar-readiness-e-evidencia-de-qualificacao.md) | GJ09.3, GJ10.3, GJ02.4 | Aceite verificado na entrega |
| GJ12.2 | Operacional | [Admitir paper e iniciar observação técnica](gj-12-2-admitir-paper-e-iniciar-observacao-tecnica.md) | GJ12.1, GJ11.4 | Paper admitido ou gate pendente |
| GJ12.3 | Operacional | [Verificar qualificação observada do motor](gj-12-3-verificar-qualificacao-observada-do-motor.md) | GJ12.2 | Estado observado ou condição para retorno |
| GJ13.1 | [JE13](entregas/je-13-adaptador-live-e-protecao-nativa.md) | [Preparar fronteira autenticada do adaptador live](gj-13-1-preparar-fronteira-autenticada-do-adaptador-live.md) | GJ09.3, GJ04.3 | Aceite verificado na entrega |
| GJ13.2 | [JE13](entregas/je-13-adaptador-live-e-protecao-nativa.md) | [Reconciliar posições ordens fills e funding da venue](gj-13-2-reconciliar-posicoes-ordens-fills-e-funding-da-venue.md) | GJ13.1, GJ07.2 | Aceite verificado na entrega |
| GJ13.3 | [JE13](entregas/je-13-adaptador-live-e-protecao-nativa.md) | [Submeter ALO e IOC com recibos idempotentes](gj-13-3-submeter-alo-e-ioc-com-recibos-idempotentes.md) | GJ13.2, GJ06.3 | Aceite verificado na entrega |
| GJ13.4 | [JE13](entregas/je-13-adaptador-live-e-protecao-nativa.md) | [Instalar proteção nativa desde o primeiro parcial](gj-13-4-instalar-protecao-nativa-desde-o-primeiro-parcial.md) | GJ13.3, GJ06.1 | Aceite verificado na entrega |
| GJ13.5 | Operacional | [Validar o adaptador em ambiente controlado da venue](gj-13-5-validar-o-adaptador-em-ambiente-controlado-da-venue.md) | GJ13.4, GJ12.1 | Adaptador validado ou ensaio pendente |
| GJ14.1 | [JE14](entregas/je-14-promocao-e-sucessao.md) | [Implementar promoção condicionada e singleton live](gj-14-1-implementar-promocao-condicionada-e-singleton-live.md) | GJ08.3, GJ12.1, GJ13.4 | Aceite verificado na entrega |
| GJ14.2 | [JE14](entregas/je-14-promocao-e-sucessao.md) | [Criar ativação explícita do piloto no painel](gj-14-2-criar-ativacao-explicita-do-piloto-no-painel.md) | GJ14.1, GJ10.3 | Aceite verificado na entrega |
| GJ14.3 | [JE14](entregas/je-14-promocao-e-sucessao.md) | [Implementar sucessão live somente por reprovação](gj-14-3-implementar-sucessao-live-somente-por-reprovacao.md) | GJ14.2, GJ11.4 | Aceite verificado na entrega |
| GJ15.1 | Operacional | [Conferir readiness do piloto e ativação pelo operador](gj-15-1-conferir-readiness-do-piloto-e-ativacao-pelo-operador.md) | GJ14.3, GJ13.5, GJ16.4, GJ17.3, GJ18.3 | Estado observado ou condição para retorno |
| GJ15.2 | Operacional | [Verificar piloto ativo e reconciliação observada](gj-15-2-verificar-piloto-ativo-e-reconciliacao-observada.md) | GJ15.1 | Estado observado ou condição para retorno |
| GJ15.3 | Operacional | [Verificar avaliação contínua e janela completa](gj-15-3-verificar-avaliacao-continua-e-janela-completa.md) | GJ08.3, GJ11.4, GJ15.1 | Estado observado ou condição para retorno |

## Catálogo dos 10 checkpoints complementares

| ID | Entrega | Contrato | Depende de código | Resultado |
| --- | --- | --- | --- | --- |
| GJ16.1 | [JE15](entregas/je-15-runtime-live-integrado.md) | [Admissão, configuração e ownership live](gj-16-1-admissao-configuracao-e-ownership-live.md) | GJ06.2, GJ13.1, GJ14.2 | Aceite verificado na entrega |
| GJ16.2 | [JE15](entregas/je-15-runtime-live-integrado.md) | [Decisões JEV e execução live](gj-16-2-decisoes-jev-e-execucao-live.md) | GJ16.1, GJ03.4, GJ06.3, GJ13.3 | Aceite verificado na entrega |
| GJ16.3 | [JE15](entregas/je-15-runtime-live-integrado.md) | [Proteção, reconciliação e recuperação live](gj-16-3-protecao-reconciliacao-e-recuperacao-live.md) | GJ16.2, GJ06.1, GJ13.2, GJ13.4 | Aceite verificado na entrega |
| GJ16.4 | [JE15](entregas/je-15-runtime-live-integrado.md) | [Promoção, sucessão e integração do runtime](gj-16-4-promocao-sucessao-e-integracao-do-runtime.md) | GJ16.3, GJ14.3, GJ08.3 | Aceite verificado na entrega |
| GJ17.1 | [JE16](entregas/je-16-pausa-e-emergencia-live.md) | [Controles live persistentes e autenticados](gj-17-1-controles-live-persistentes-e-autenticados.md) | GJ10.3, GJ16.4 | Aceite verificado na entrega |
| GJ17.2 | [JE16](entregas/je-16-pausa-e-emergencia-live.md) | [Cancelamento e encerramento live pelo worker](gj-17-2-cancelamento-e-encerramento-live-pelo-worker.md) | GJ17.1, GJ16.3 | Aceite verificado na entrega |
| GJ17.3 | [JE16](entregas/je-16-pausa-e-emergencia-live.md) | [Painel de intervenção live e fluxo integrado](gj-17-3-painel-de-intervencao-live-e-fluxo-integrado.md) | GJ17.2, GJ14.2 | Aceite verificado na entrega |
| GJ18.1 | [JE17](entregas/je-17-painel-financeiro-e-operacional-live.md) | [Projeção financeira live e custos atribuídos](gj-18-1-projecao-financeira-live-e-custos-atribuidos.md) | GJ07.1, GJ07.2, GJ16.4 | Aceite verificado na entrega |
| GJ18.2 | [JE17](entregas/je-17-painel-financeiro-e-operacional-live.md) | [Snapshot live de execução, proteção e decisões](gj-18-2-snapshot-live-de-execucao-protecao-e-decisoes.md) | GJ18.1, GJ17.3, GJ10.2 | Aceite verificado na entrega |
| GJ18.3 | [JE17](entregas/je-17-painel-financeiro-e-operacional-live.md) | [Painel live completo e aceite integrado](gj-18-3-painel-live-completo-e-aceite-integrado.md) | GJ18.2 | Aceite verificado na entrega |

## Referências

- [Especificação aprovada](../../docs/PRD-GANSO-JEV.md)
- [Comparação com o código atual](../../docs/architecture/ganso-jev-code-map.md)
- [Plano de implementação e implantação](../../docs/roadmap/GANSO_JEV_IMPLEMENTATION_PLAN.md)
- [Autorização por entrega](../../docs/ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-jev-com-autonomia-por-bloco)
- [Registro mínimo de execução](../../docs/roadmap/GANSO_JEV_EXECUTION_STATE.md)
