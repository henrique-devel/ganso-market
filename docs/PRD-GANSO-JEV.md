# Especificação da operação contínua do Ganso Market com JEV

Direção aprovada em **07/10/2026**, ao concluir o grilling e confirmar seu consolidado na Q119. Esta especificação orienta a próxima versão: operação contínua, JEV como motor de decisão, três perfis em paper com stress independente e um piloto live de US$250. Infraestrutura fica sob responsabilidade do operador e fora do resultado e da aprovação das estratégias.

A consolidação e a preparação do [pacote de prompts](../prompts/jev/README.md) são documentais. Executar um prompt selecionado tem [autorização explícita para alteração, PR, merge e produção](ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-jev-com-autonomia-por-bloco) dentro de seu escopo. A aprovação do desenho ou publicação do código não compra consumo, deposita capital nem ativa trading/signer por consequência. O [plano de implementação e implantação](roadmap/GANSO_JEV_IMPLEMENTATION_PLAN.md) distingue entrega de código, qualificação técnica, evidência econômica e ativação pelo operador. A [comparação com o código atual](architecture/ganso-jev-code-map.md) delimita o reaproveitamento.

<a id="autoridade-e-decisoes-substituidas"></a>

## Autoridade e decisões substituídas

Esta direção prevalece sobre [SCOPE.md](SCOPE.md), o [PRD 2.0](PRD-GANSO-2.0.md) e prompts antigos nos pontos conflitantes. Os documentos e resultados anteriores permanecem como histórico; suas janelas, perdas, versões e contas não são reescritas.

| Tema | Direção anterior | Direção confirmada |
| --- | --- | --- |
| JEV | Futuro ou filtro opcional da baseline | Motor principal de direção e intenção |
| Estratégia de controle | Baseline de tendência e breakout | Aposentar essa baseline; comparar com caixa e BTC passivo |
| Banca paper | US$1.000 por cenário | US$250 por conta nova paper e stress |
| Perfis ativos | Manual, baseline e challenger | Três perfis paper, três stress e somente um live |
| Execução | Entrada e saída IOC na baseline | Entrada maker post-only e saída IOC reduce-only |
| Risco de entrada | 0,25% e exposição de 25% | 1% e exposição máxima de 50% |
| Perda diária | 1,5% | 2% do patrimônio no início do dia UTC |
| Drawdown | Percentual da política anterior | US$12,50 fixos desde o maior patrimônio observado |
| Avaliação | Manifesto atual de 30 dias e 95% de cobertura | Ciclo completo de 90 dias, 99% de dados elegíveis e mínimo de 60 operações por conta |
| Live inicial | Fora da versão anterior | Piloto limitado após qualificação e evidência, sem exigir esperar 90 dias |
| Infraestrutura | Dedução no resultado após custos operacionais | Excluída do PnL da estratégia e da aprovação desde o início |
| Geração | Sem gerador do novo desenho no runtime inspecionado | Sucessora altera um componente por versão, dentro de limites aprovados |

A contabilização de infraestrutura não volta automaticamente a bloquear estratégias após 90 dias. Uma visão de custo total da plataforma permanece separada. Polymarket continua aposentada; a evolução futura para outras moedas não inclui multiativos nesta primeira versão.

## Produto e contas

O produto é pessoal, de um único operador, inicialmente para o perpétuo padrão de BTC na Hyperliquid. API, banco, coleta, execução e painel mantêm responsabilidades separadas.

Cada perfil tem uma versão imutável de contexto, critérios, horizonte, regras de decisão e cadência. Provedor e versão do modelo são identificados separadamente. Alteração material cria nova versão e nova validação prospectiva; um conserto comprovadamente não financeiro não apaga a janela anterior.

| Conta | Quantidade | Capital e finalidade |
| --- | --- | --- |
| Paper principal | 3 | US$250 fictícios independentes por perfil |
| Stress | 3 | US$250 fictícios independentes; validação adversa de cada perfil |
| Live | No máximo 1 ativa | US$250 reais totais no piloto; sucessoras reutilizam o patrimônio efetivo |

São até sete contas de estratégia. Benchmarks são referências próprias e não aumentam o capital real. O painel não soma bancas alternativas como patrimônio disponível para operar.

Os três perfis iniciais recebem as mesmas informações e critérios JEV; variam somente o horizonte econômico de **1, 3 e 5 minutos**. Horizonte é o intervalo futuro sobre o qual o modelo julga a oportunidade; não é a frequência das consultas nem uma ordem de fechamento obrigatório.

Há uma posição líquida por conta, margem isolada e alavancagem de 1×. Não há pirâmide, aumento de posição, inversão direta nem aporte ou saque durante o piloto. O patrimônio real não é reiniciado quando muda o perfil.

<a id="decisao-jev-e-supervisao-independente"></a>

## Decisão JEV e supervisão independente

JEV escolhe direção long/short e intenção abrir/manter/encerrar. O código valida compatibilidade com a posição e converte uma resposta válida em ação permitida. Tamanho, preço representável, margem, risco, reservas, limites e saídas obrigatórias são calculados pelo sistema.

Uma escolha válida pode ser usada sem um limiar adicional de confiança. Probabilidades e confiança ficam disponíveis para diagnóstico; não são tratadas como probabilidade de lucro. O modelo pode encerrar uma posição com lucro antes do stop ou do prazo máximo.

A consulta padrão ocorre a cada **60 segundos**. O modo de **2 segundos** exige posição aberta e gatilho versionado de movimento favorável/adverso relativo ao ATR ou proximidade do stop. Fluxo de ordens e liquidez não são famílias de gatilho rápido nesta primeira versão. Limiares, permanência mínima e retorno ao modo lento são fixados antes de cada experimento.

Coleta, risco, reconciliação e atualização visual têm cadências próprias. A proteção não espera o próximo tick do JEV nem depende da disponibilidade da API de IA.

O contexto inclui livro e spread, profundidade, desequilíbrio, trades e fluxo calculado, retornos, indicadores, funding e estado da própria conta/posição, com unidades, horários de origem/recebimento e qualidade. As janelas e fórmulas entram no manifesto antes da observação. Não usar dados futuros, interpolação de gaps ou dados antigos com frescor artificial.

Consultas são agrupadas **por perfil**, reunindo somente contas desse perfil que precisam decidir naquele ciclo. Estado e critérios de perfis diferentes não são misturados. Todas as perguntas de uma chamada enxergam o mesmo estado; por isso o texto da pergunta deve vincular explicitamente conta, posição, instante e versão. O nome da pergunta não estabelece esse vínculo sozinho. [TypeSafe sobre estado](https://docs.typesafe.ai/concepts/state), [referência da API](https://docs.typesafe.ai/api).

Contas com posições ou estados diferentes recebem respostas próprias. Uma resposta inválida com vínculo confiável bloqueia a decisão daquela conta; transporte inválido ou vínculo ambíguo invalida o lote afetado. Timeout, indisponibilidade, orçamento insuficiente ou custo desconhecido pausam novas entradas, mantendo proteção e reconciliação. Não substituir silenciosamente JEV real por mock, nem converter falha em decisão de manter.

Modelo, perguntas, estado, resposta original, timestamps, tarifa e execução ficam registrados. Replay usa a resposta capturada; não consulta novamente o modelo nem promete respostas idênticas em inferências futuras. Usar modelo com versão fixada, evitando aliases móveis durante o experimento. [TypeSafe sobre modelos](https://docs.typesafe.ai/models).

## Risco e dimensionamento

Patrimônio de negociação inclui resultado realizado e aberto, taxas e funding. JEV e infraestrutura ficam fora da base matemática dos limites de negociação; JEV entra na avaliação econômica descrita adiante.

| Regra | Política confirmada |
| --- | --- |
| Risco planejado por entrada | Até 1% do patrimônio corrente |
| Exposição na entrada | Até 50% do patrimônio corrente, sem rebalanceamento forçado após valorização |
| Stop | Fixo, a 2×ATR; ATR de 14 períodos em barras fechadas de 15 minutos |
| Prazo máximo | 6 horas desde o primeiro preenchimento |
| Take profit e trailing | Sem alvo fixo e sem trailing na primeira versão |
| Perda diária | 2% do patrimônio no início do dia UTC, incluindo posição aberta, taxas e funding |
| Drawdown por teste | US$12,50 fixos desde seu maior patrimônio observado |
| Drawdown global live | US$12,50 fixos desde o maior patrimônio real observado, atravessando sucessoras |

Com US$250 iniciais, o risco planejado é US$2,50 e a pausa diária começa em US$5. Se o patrimônio real subir a US$270, o gatilho global fica em US$257,50. O orçamento de drawdown não cresce com os lucros e não é reiniciado por troca de estratégia.

O tamanho deve incluir distância ao stop, taxas estimadas, funding planejado e **reserva integral dos 10% de tolerância de slippage do stop market nativo**, dentro do mesmo limite de 1%. O teto de exposição não é uma meta de tamanho. Bloquear entradas que não caibam no orçamento de risco ou no mínimo/precisão da venue; nunca aumentar a ordem para fazê-la caber.

A documentação atual informa mínimo de US$10 para ordens perpétuas. Essa condição e as regras de preço/lote devem ser revalidadas na implementação. [Hyperliquid sobre erros de ordem](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/error-responses).

O gatilho diário cancela entradas pendentes, solicita encerramento e pausa entradas. Retoma no próximo dia UTC somente após ficar sem posição, reconciliar e verificar dados frescos e ausência de bloqueio global. Reprovação por risco preserva evidência mesmo quando a amostra econômica é insuficiente.

O bloqueio global live impede novas entradas e sucessão automática até nova decisão explícita do operador. Stops e limites solicitam fechamento; liquidez, gaps e execução podem levar a perdas maiores que o valor do gatilho.

<a id="execucao-e-protecao"></a>

## Execução e proteção

Entradas usam maker post-only. Para long, melhorar o melhor bid em um incremento mínimo válido; para short, melhorar o melhor ask. Se não couber dentro do spread, cotar no melhor preço do próprio lado. Se cruzar ao chegar à venue, rejeitar sem conversão para taker. A política é comum aos perfis. [Hyperliquid sobre tipos de ordem](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/order-types).

A espera maker dura **2 segundos após confirmação de aceitação**, além da latência de chegada. Ao expirar, cancelar o restante e reconciliar possíveis fills concorrentes. Um preenchimento parcial mantém somente a quantidade executada, sem completar automaticamente o lote. Nova tentativa exige nova decisão JEV válida.

Paper principal aplica latência de **1 segundo**; stress aplica **2 segundos** e **taxas de negociação duplicadas**. Cada conta mantém posição, funding, riscos e respostas JEV próprios. Simulação maker usa volume observado à frente, trades executados, prioridade e preenchimentos parciais; tocar no preço não basta. Não reivindicar reprodução exata de prioridade não observável. [Hyperliquid sobre prioridade no livro](https://hyperliquid.gitbook.io/hyperliquid-docs/hypercore/order-book).

Saídas usam IOC reduce-only, consumindo somente liquidez observada após a latência. Quantidade não executada permanece pendente; não inventar fechamento pelo último preço conhecido. O modelo novo integra maker e IOC na mesma conta, incluindo seus efeitos concorrentes sobre liquidez e reservas.

No live, instalar stop market nativo associado à posição **desde o primeiro preenchimento parcial**. TP/SL usa mark price como gatilho e tolerância de 10%; paper e stress devem reproduzir essa semântica de disparo. A proteção de uma posição parcial deve ser independente dos filhos de uma ordem de entrada cujo cancelamento pode removê-los. [Hyperliquid sobre TP e SL](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/take-profit-and-stop-loss-orders-tp-sl).

Se a instalação da proteção não for confirmada, bloquear entradas, cancelar o restante maker e solicitar fechamento IOC sem esperar JEV. Apenas declarar conta sem posição depois de confirmação e reconciliação. Reduções simultâneas nunca podem abrir posição oposta.

A nova política não usa a saída por invalidação de tendência da baseline. Stop, prazo máximo, risco e falhas financeiras permanecem supervisionados independentemente do modelo.

## Resultados e custos

O painel distingue quatro medidas:

| Medida | Conteúdo |
| --- | --- |
| PnL de negociação | Realizado + aberto − taxas + funding líquido com sinal |
| Resultado da estratégia após JEV | PnL de negociação − custo JEV atribuído, com convenção identificada |
| Resultado conservador para elegibilidade | Realizado − taxas + funding líquido + menor valor entre PnL aberto e zero − JEV atribuído |
| Despesa real da plataforma | Cada cobrança JEV uma única vez e infraestrutura informada pelo operador em subgrupo separado |

Para avaliar cada conta paper/stress, descontar **o custo integral de toda consulta compartilhada da qual ela participou**. O mesmo custo pode aparecer em avaliações alternativas, mas não é uma cobrança por pergunta nem pode ser somado como despesa real. No registro financeiro global, cada chamada é contabilizada uma única vez.

Custos desconhecidos são indisponíveis, não zero. A falha de uma resposta pode ter custo cobrado. A fórmula conservadora não exige encerrar uma posição somente para medir elegibilidade.

Infraestrutura não participa de nenhuma dessas fórmulas de estratégia nem de aprovação/reprovação. O operador pode registrar seu valor manualmente no card separado; automação de faturas e rateio de infraestrutura ficam fora da primeira versão.

O orçamento JEV é agregado entre todos os perfis e contas: **US$8/mês operacional e US$2/mês para geração, comparação e validação**. Reservar custo antes do envio; reconciliar consumo e tarifa efetivos. Mais perfis e modo rápido precisam caber no mesmo orçamento. A exclusão da infraestrutura do PnL não autoriza contratar serviços, elevar o orçamento anterior de planejamento de US$80/mês ou gastar automaticamente.

Custos de geração/validação devem permanecer no registro global JEV com vínculo à proposta quando identificável. A regra completa de atribuição desses custos à avaliação dos perfis ainda precisa ser explicitada no contrato de custos antes do primeiro aceite econômico; a Q117 resolveu consultas compartilhadas de decisão, não esse rateio. Essa pendência não autoriza omitir custos JEV ou tratá-los como zero.

<a id="qualificacao-e-avaliacao-continua"></a>

## Qualificação e avaliação contínua

A qualificação inicial do motor requer **sete dias operacionais contínuos**, exercitando execução, custos, funding, risco e recuperação. Interrupções recuperadas sem lacuna financeira não apagam evidência; gap financeiro irrecuperável invalida a qualificação. Novos perfis usam gates de contrato, configuração, risco e replay; não precisam repetir sete dias do mesmo motor sem alteração material.

Para elegibilidade inicial ao live, cada perfil exige pelo menos **60 episódios de posição integralmente encerrados em paper e 60 em stress**, configuração congelada, dados elegíveis de pelo menos 99%, contabilidade reconciliada e resultado conservador positivo em ambas. Fill parcial não é uma operação encerrada. Sessenta operações e lucro inicial são condições experimentais, não prova de rentabilidade.

O primeiro perfil que cumprir os critérios pode operar o piloto depois da ativação inicial pelo operador; não esperar os três terminarem. Na elegibilidade inicial, benchmarks são visíveis, mas não é obrigatório superá-los.

A avaliação econômica completa ocorre ao atingir **90 dias de calendário** e, depois, diariamente sobre os últimos 90 dias. Exige cobertura de 99%, mínimo de 60 operações encerradas por conta, custos JEV completos e ausência de lacuna financeira irrecuperável. Manter o patrimônio e as posições através dos limites da janela.

O critério completo é superar o melhor resultado entre caixa e BTC passivo em **5 pontos percentuais** sobre a referência inicial de US$250, equivalentes a US$12,50, após taxas, funding e JEV. Reprovação comprovada em paper ou stress reprova o perfil; amostra insuficiente ou custo/lacuna não resolvidos tornam o resultado inconclusivo. Uma falha de risco comprovada prevalece sobre a inconclusão econômica.

Uma prévia operacional de 30 dias não autoriza ajustar um perfil ativo nem reotimizar retrospectivamente. Correções materiais encerram a versão e exigem novo teste; perdas e reprovações permanecem registradas.

Caixa é US$250 não remunerados. BTC passivo começa com exposição de 50% e quantidade fixa, sem rebalanceamento; inclui suas taxas, funding e execução. Ao atingir US$12,50 de drawdown desde o pico, solicita encerramento e permanece em caixa, sem reentrada. Comparações usam os mesmos recortes temporais e convenções identificadas; não reiniciar a trajetória do benchmark a cada janela.

<a id="sucessao-e-geracao-de-propostas"></a>

## Sucessão e geração de propostas

Perfis de reserva continuam rodando em paper/stress. Sua condição pode passar de em validação a elegível, inconclusiva ou reprovada; não congelar um resultado favorável como aprovação permanente.

O live só muda automaticamente após **reprovação comprovada do perfil atual**. Um reserva com resultado melhor não substitui uma estratégia saudável nesta primeira versão. Antes da sucessão, cancelar ordens, encerrar posição e reconciliar; o bloqueio global do piloto tem precedência.

A fila mantém até **três propostas esperando vaga**, além dos três perfis em teste. O operador vê justificativas e pode remover ou mudar a prioridade da fila, sem alterar parâmetros de um perfil ativo. A remoção impede reinserção automática do mesmo fingerprint.

Gerar somente quando existir vaga, histórico encerrado suficiente e orçamento disponível. O gerador trabalha com templates e faixas aprovadas; não cria código arbitrário nem amplia regras de risco ou execução. A cada sucessora, alterar **um componente**: horizonte, janela dos dados, informações utilizadas ou critérios JEV.

Gates determinísticos validam a proposta e o JEV verifica coerência e aptidão técnica. Isso não é aprovação econômica. Veto, abstenção ou indisponibilidade impedem admissão automática. A ordenação inicial pode usar essa aptidão; a prioridade escolhida pelo operador é persistente.

Uma estratégia reprovada não renasce com novo identificador e configuração idêntica. Sem sucessora apta, permanecer aguardando, mantendo coleta, proteção necessária e painel.

<a id="painel-e-operacao"></a>

## Painel e operação

O operador deve conseguir ler o resultado econômico, posições e estado da automação sem conhecer detalhes de implementação. Apresentar, por perfil, paper, stress e live; distinguir patrimônio fictício do real e resultado aberto do realizado.

O painel mostra PnL após taxas, funding e JEV; componentes do resultado; limites diário/global; ordens/fills; proteção; decisões, probabilidades, latência e motivos; versões e qualidade dos dados; fila e estado de cada validação. Subgrupo separado mostra JEV, infraestrutura manual e despesa total, sem misturá-la com aprovação da estratégia.

Controles da primeira versão incluem ativação inicial do piloto com limites explícitos, pausa/emergência e edição da fila. Não oferecer negociação manual, alteração de parâmetros ativos ou aumento de capital como parte desse fluxo. Intervenções são registradas e podem tornar uma avaliação inconclusiva sem esconder falhas comprovadas.

Alertas ficam no painel. Não incluir envio externo de mensagens, múltiplos operadores ou produto SaaS.

<a id="dados-capacidade-e-recuperacao"></a>

## Dados capacidade e recuperação

Preservar decisões completas, respostas originais JEV, entradas que as fundamentam, ordens, fills, ledger, custos, versões e prova agregada de cobertura. Não conservar todo raw irrelevante como requisito de pesquisa.

Proteger evidência necessária durante o experimento e por **180 dias após seu encerramento**, ou mais enquanto houver dependências. Ledger, resultados e versões permanecem; expirar somente objetos dispensáveis e não protegidos. A aprovação de retenção não autoriza apagar evidência histórica existente.

Admissão exige demonstrar que janelas de 90 dias, perfis simultâneos, pins e retenção cabem nos recursos existentes. Sem espaço seguro, pausar e informar o operador; não ampliar quotas ou apagar protegidos automaticamente. Retomar coleta após recuperar capacidade, frescor e reconciliação.

Executar risco/decisão em worker TypeScript dedicado, separado da API e do coletor. Reutilizar isolamento por conta, idempotência, leases e fencing; impedir dois donos efetivos. Reinício não duplica chamada, ordem, fill ou custo e não zera âncoras. Risco e reconciliação têm prioridade sobre novas entradas e geração.

Backup, migração de host e compra de infraestrutura não são pré-requisitos novos desta entrega documental. Preservar autenticação e perímetro atuais.

## Detalhes a fixar antes dos experimentos

São contratos de implementação e calibração ainda sem valores medidos: limiares dos gatilhos rápidos e cooldown; fórmulas/janelas do contexto; âncora e arredondamento do stop diante de fills parciais; faixas permitidas ao gerador; deadlines/frescor por etapa; atribuição do JEV de geração/validação; representação de evidência necessária e estimativa de sua ocupação.

Esses detalhes devem ser explícitos e versionados antes do primeiro teste afetado. O plano não presume valores rentáveis, capacidade aprovada, equivalência entre lote e chamadas individuais ou tarifa efetiva apenas por existir preço público.

## Referências do desenho

Os projetos [aowang-ai/jev-trade](https://github.com/aowang-ai/jev-trade) e [jarrodwatts/jev-trader](https://github.com/jarrodwatts/jev-trader) orientaram o uso de JEV e ordens maker. Não são prova de lucro, aprovação automática ou fidelidade da nossa simulação. A implementação deve seguir esta especificação e documentação oficial atual.

Rastreabilidade das últimas decisões: Q99 e reafirmação na Q117, infraestrutura excluída; Q100, sem take profit fixo; Q101, banca e limites dos testes; Q102–107, cadência/gatilhos/horizontes; Q110 reformulada, três pares paper/stress e um live; Q111–112, primeira elegível e sucessão só por reprovação; Q113, benchmark protegido; Q114, lote por perfil; Q115, preço maker; Q116, perfis iniciais; Q117, desconto integral do lote por conta para avaliação; Q118, uma mudança por sucessora; Q119, confirmação do consolidado.
