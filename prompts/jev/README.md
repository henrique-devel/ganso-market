# Prompts de implantação do Ganso Market com JEV

Pacote preparado em 07/10/2026: **16 blocos do plano, desdobrados em 52 sessões**. Cada arquivo é um prompt executável em uma sessão própria, sem precisar do histórico do grilling. Dependências de código permanecem explícitas; independência significa contexto e entrega delimitados, não execução fora de ordem.

A criação deste pacote é documental. Nenhum prompt foi executado, serviço implantado, crédito comprado ou piloto ativado por este registro.

## Como conduzir

Selecione uma sessão por vez. Entregue ao agente o arquivo do prompt e acesso à base reconciliada. Ele lê o [protocolo](00-protocolo.md), as seções indicadas e sua linha no [estado de execução](../../docs/roadmap/GANSO_JEV_EXECUTION_STATE.md). Cada prompt inclui autorização explícita para alteração, PR, merge e publicação em produção, após as verificações exigidas e dentro do escopo.

Comece por [GJ00.1](./gj-00-1-reconciliar-a-base-de-trabalho.md). Exemplo de pedido para a primeira sessão:

```text
Leia e execute integralmente prompts/jev/gj-00-1-reconciliar-a-base-de-trabalho.md.
Execute somente essa sessão até o resultado previsto e sua publicação aplicável,
respeitando a autorização, os checks e os gates do prompt.
```

Após o fechamento, escolha a próxima sessão cujas dependências de código estejam verificadas. O agente não deve executar o pacote inteiro nem criar chats automaticamente. Se o comportamento já estiver entregue, confira o aceite na base atual e registre reaproveitamento; não refaça código para cumprir um ID.

## Tamanho e retomada

Os prompts usam contexto mínimo, escopo único e critérios locais de aceite. Alvo de trabalho: 3–6 arquivos de lógica e uma migration aditiva. Evite anexar todos os documentos, logs ou RFCs. Abra arquivos por símbolo e seções por necessidade. O tamanho do código e das saídas de ferramentas varia; nenhum pacote pode garantir uma janela de contexto sem esse controle de leitura.

Se faltar espaço na sessão, deixe a menor unidade coerente validada e registre na linha do estado o contrato, o delta e a continuação necessária. Não declare um bloco concluído parcialmente nem habilite stubs. A sessão seguinte retoma esse ID antes de avançar.

## Dependências e ativação

`depends_on` aponta código/contratos disponíveis; o [plano macro](../../docs/roadmap/GANSO_JEV_IMPLEMENTATION_PLAN.md) explica a arquitetura. Os prompts refinam sua ordem por fronteira funcional. GJ13 pode ser desenvolvido durante a observação de GJ12; GJ14 publica gates fechados enquanto a qualificação estiver pendente.

`operational_gates` condiciona operação efetiva. Observar sete dias, ter 60 episódios por conta ou completar 90 dias não ocupa uma sessão de desenvolvimento. GJ12.3 e GJ15 encerram como observing/inconclusivo se faltar tempo/dado, com condição para nova avaliação. Não criam agendamento por conta própria.

Ativação paper fica em GJ12.2, com recursos/custos admitidos. Testnet fica em GJ13.5, com identidade e conta de teste existentes. Live exige qualificação, elegibilidade e ativação autenticada do operador. Autorizar produção não equivale a comprar API, aportar capital ou clicar nessa ativação pelo operador.

## Sessões

| ID | Prompt | Depende de código | Resultado |
| --- | --- | --- | --- |
| GJ00.1 | [Reconciliar a base de trabalho](gj-00-1-reconciliar-a-base-de-trabalho.md) | Nenhuma | Base ou viabilidade verificadas |
| GJ00.2 | [Conferir runtime schema e checks da base](gj-00-2-conferir-runtime-schema-e-checks-da-base.md) | GJ00.1 | Base ou viabilidade verificadas |
| GJ01.1 | [Versionar contratos de perfis e contas](gj-01-1-versionar-contratos-de-perfis-e-contas.md) | GJ00.2 | Código validado e publicação aplicável |
| GJ01.2 | [Adaptar gênese e replay ao capital explícito](gj-01-2-adaptar-genese-e-replay-ao-capital-explicito.md) | GJ01.1 | Código validado e publicação aplicável |
| GJ01.3 | [Persistir registro de perfis e pares de contas](gj-01-3-persistir-registro-de-perfis-e-pares-de-contas.md) | GJ01.2 | Código validado e publicação aplicável |
| GJ02.1 | [Computar contexto e manifestos iniciais](gj-02-1-computar-contexto-e-manifestos-iniciais.md) | GJ01.3 | Código validado e publicação aplicável |
| GJ02.2 | [Fixar gatilhos cadência e contrato de saídas](gj-02-2-fixar-gatilhos-cadencia-e-contrato-de-saidas.md) | GJ02.1 | Código validado e publicação aplicável |
| GJ02.3 | [Definir evidência mínima e retenção protegida](gj-02-3-definir-evidencia-minima-e-retencao-protegida.md) | GJ02.2 | Código validado e publicação aplicável |
| GJ02.4 | [Admitir viabilidade inicial de capacidade e JEV](gj-02-4-admitir-viabilidade-inicial-de-capacidade-e-jev.md) | GJ00.2, GJ02.3 | Base ou viabilidade verificadas |
| GJ03.1 | [Definir escolhas JEV e vínculo por conta](gj-03-1-definir-escolhas-jev-e-vinculo-por-conta.md) | GJ02.2 | Código validado e publicação aplicável |
| GJ03.2 | [Persistir pools e reserva de custo JEV](gj-03-2-persistir-pools-e-reserva-de-custo-jev.md) | GJ03.1 | Código validado e publicação aplicável |
| GJ03.3 | [Integrar transporte de lotes por perfil](gj-03-3-integrar-transporte-de-lotes-por-perfil.md) | GJ03.2 | Código validado e publicação aplicável |
| GJ03.4 | [Registrar decisões e replay das respostas originais](gj-03-4-registrar-decisoes-e-replay-das-respostas-originais.md) | GJ03.3 | Código validado e publicação aplicável |
| GJ04.1 | [Aplicar limites persistentes por conta](gj-04-1-aplicar-limites-persistentes-por-conta.md) | GJ02.2, GJ01.2 | Código validado e publicação aplicável |
| GJ04.2 | [Dimensionar entradas com stop e tolerância nativa](gj-04-2-dimensionar-entradas-com-stop-e-tolerancia-nativa.md) | GJ04.1 | Código validado e publicação aplicável |
| GJ04.3 | [Persistir supervisor global do piloto](gj-04-3-persistir-supervisor-global-do-piloto.md) | GJ04.1, GJ01.3 | Código validado e publicação aplicável |
| GJ05.1 | [Unificar contratos de liquidez maker e IOC](gj-05-1-unificar-contratos-de-liquidez-maker-e-ioc.md) | GJ04.2 | Código validado e publicação aplicável |
| GJ05.2 | [Implementar cotação chegada e fila maker](gj-05-2-implementar-cotacao-chegada-e-fila-maker.md) | GJ05.1, GJ02.2 | Código validado e publicação aplicável |
| GJ05.3 | [Integrar cancelamento parcial e saída IOC](gj-05-3-integrar-cancelamento-parcial-e-saida-ioc.md) | GJ05.2 | Código validado e publicação aplicável |
| GJ06.1 | [Extrair supervisor de proteção dos perfis](gj-06-1-extrair-supervisor-de-protecao-dos-perfis.md) | GJ05.3, GJ04.3 | Código validado e publicação aplicável |
| GJ06.2 | [Separar worker de execução da API](gj-06-2-separar-worker-de-execucao-da-api.md) | GJ06.1, GJ03.4 | Código validado e publicação aplicável |
| GJ06.3 | [Integrar cadências e descartar decisões obsoletas](gj-06-3-integrar-cadencias-e-descartar-decisoes-obsoletas.md) | GJ06.2 | Código validado e publicação aplicável |
| GJ07.1 | [Separar despesa real e custo de avaliação](gj-07-1-separar-despesa-real-e-custo-de-avaliacao.md) | GJ03.4, GJ02.3 | Código validado e publicação aplicável |
| GJ07.2 | [Publicar PnL e resultado conservador](gj-07-2-publicar-pnl-e-resultado-conservador.md) | GJ07.1, GJ06.3 | Código validado e publicação aplicável |
| GJ07.3 | [Construir referências caixa e BTC protegido](gj-07-3-construir-referencias-caixa-e-btc-protegido.md) | GJ05.3, GJ04.1, GJ02.3 | Código validado e publicação aplicável |
| GJ08.1 | [Contar episódios e medir cobertura real](gj-08-1-contar-episodios-e-medir-cobertura-real.md) | GJ07.2 | Código validado e publicação aplicável |
| GJ08.2 | [Avaliar elegibilidade inicial e estados do perfil](gj-08-2-avaliar-elegibilidade-inicial-e-estados-do-perfil.md) | GJ08.1, GJ07.3, GJ04.3 | Código validado e publicação aplicável |
| GJ08.3 | [Implementar avaliação rolling de 90 dias](gj-08-3-implementar-avaliacao-rolling-de-90-dias.md) | GJ08.2 | Código validado e publicação aplicável |
| GJ09.1 | [Generalizar registro e dispatch de três perfis](gj-09-1-generalizar-registro-e-dispatch-de-tres-perfis.md) | GJ08.3 | Código validado e publicação aplicável |
| GJ09.2 | [Integrar stress prospectivo independente](gj-09-2-integrar-stress-prospectivo-independente.md) | GJ09.1 | Código validado e publicação aplicável |
| GJ09.3 | [Validar carga e ciclo integrado dos pares](gj-09-3-validar-carga-e-ciclo-integrado-dos-pares.md) | GJ09.2, GJ02.4 | Código validado e publicação aplicável |
| GJ10.1 | [Exibir perfis PnL e limites](gj-10-1-exibir-perfis-pnl-e-limites.md) | GJ09.3 | Código validado e publicação aplicável |
| GJ10.2 | [Exibir decisões proteção e custos separados](gj-10-2-exibir-decisoes-protecao-e-custos-separados.md) | GJ10.1 | Código validado e publicação aplicável |
| GJ10.3 | [Implementar controles de pausa e emergência](gj-10-3-implementar-controles-de-pausa-e-emergencia.md) | GJ10.2, GJ04.3 | Código validado e publicação aplicável |
| GJ11.1 | [Persistir propostas fingerprints e uma mudança](gj-11-1-persistir-propostas-fingerprints-e-uma-mudanca.md) | GJ01.3, GJ02.2, GJ08.3 | Código validado e publicação aplicável |
| GJ11.2 | [Gerar por vaga e validar coerência com JEV](gj-11-2-gerar-por-vaga-e-validar-coerencia-com-jev.md) | GJ11.1, GJ03.4, GJ07.1 | Código validado e publicação aplicável |
| GJ11.3 | [Criar fila curta editável pelo operador](gj-11-3-criar-fila-curta-editavel-pelo-operador.md) | GJ11.2, GJ10.3 | Código validado e publicação aplicável |
| GJ11.4 | [Admitir sucessoras paper após encerramento](gj-11-4-admitir-sucessoras-paper-apos-encerramento.md) | GJ11.3, GJ09.3 | Código validado e publicação aplicável |
| GJ12.1 | [Implementar readiness e evidência de qualificação](gj-12-1-implementar-readiness-e-evidencia-de-qualificacao.md) | GJ09.3, GJ10.3, GJ02.4 | Código validado e publicação aplicável |
| GJ12.2 | [Admitir paper e iniciar observação técnica](gj-12-2-admitir-paper-e-iniciar-observacao-tecnica.md) | GJ12.1, GJ11.4 | Paper admitido ou gate pendente |
| GJ12.3 | [Verificar qualificação observada do motor](gj-12-3-verificar-qualificacao-observada-do-motor.md) | GJ12.2 | Estado observado ou condição para retorno |
| GJ13.1 | [Preparar fronteira autenticada do adaptador live](gj-13-1-preparar-fronteira-autenticada-do-adaptador-live.md) | GJ09.3, GJ04.3 | Código validado e publicação aplicável |
| GJ13.2 | [Reconciliar posições ordens fills e funding da venue](gj-13-2-reconciliar-posicoes-ordens-fills-e-funding-da-venue.md) | GJ13.1, GJ07.2 | Código validado e publicação aplicável |
| GJ13.3 | [Submeter ALO e IOC com recibos idempotentes](gj-13-3-submeter-alo-e-ioc-com-recibos-idempotentes.md) | GJ13.2, GJ06.3 | Código validado e publicação aplicável |
| GJ13.4 | [Instalar proteção nativa desde o primeiro parcial](gj-13-4-instalar-protecao-nativa-desde-o-primeiro-parcial.md) | GJ13.3, GJ06.1 | Código validado e publicação aplicável |
| GJ13.5 | [Validar o adaptador em ambiente controlado da venue](gj-13-5-validar-o-adaptador-em-ambiente-controlado-da-venue.md) | GJ13.4, GJ12.1 | Adaptador validado ou ensaio pendente |
| GJ14.1 | [Implementar promoção condicionada e singleton live](gj-14-1-implementar-promocao-condicionada-e-singleton-live.md) | GJ08.3, GJ12.1, GJ13.4 | Código validado e publicação aplicável |
| GJ14.2 | [Criar ativação explícita do piloto no painel](gj-14-2-criar-ativacao-explicita-do-piloto-no-painel.md) | GJ14.1, GJ10.3 | Código validado e publicação aplicável |
| GJ14.3 | [Implementar sucessão live somente por reprovação](gj-14-3-implementar-sucessao-live-somente-por-reprovacao.md) | GJ14.2, GJ11.4 | Código validado e publicação aplicável |
| GJ15.1 | [Conferir readiness do piloto e ativação pelo operador](gj-15-1-conferir-readiness-do-piloto-e-ativacao-pelo-operador.md) | GJ14.3, GJ13.5 | Estado observado ou condição para retorno |
| GJ15.2 | [Verificar piloto ativo e reconciliação observada](gj-15-2-verificar-piloto-ativo-e-reconciliacao-observada.md) | GJ15.1 | Estado observado ou condição para retorno |
| GJ15.3 | [Verificar avaliação contínua e janela completa](gj-15-3-verificar-avaliacao-continua-e-janela-completa.md) | GJ08.3, GJ11.4, GJ15.1 | Estado observado ou condição para retorno |

## Referências

- [Especificação aprovada](../../docs/PRD-GANSO-JEV.md)
- [Comparação com o código atual](../../docs/architecture/ganso-jev-code-map.md)
- [Plano de implementação e implantação](../../docs/roadmap/GANSO_JEV_IMPLEMENTATION_PLAN.md)
- [Autorização por sessão](../../docs/ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-jev-com-autonomia-por-bloco)
- [Registro mínimo de execução](../../docs/roadmap/GANSO_JEV_EXECUTION_STATE.md)
