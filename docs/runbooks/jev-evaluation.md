# Avaliação contínua JEV

JE09 publica `jev.evaluation.v1`, `jev.episodes.v1` e `jev.duration-coverage.v1`.
Não admite contas, qualifica o motor, faz tuning, substitui perfil saudável nem envia ordens.

O worker singleton coleta uma prova do último minuto completo apenas para contas
admitidas por GJ12.2, independentemente de chamadas JEV. A cobertura usa a duração
calendária inteira, interseção dos canais book/context/trades e os relógios originais
de origem/recebimento. Book tem 2s de frescor, context 5s; os limites seguem os
contratos de decisão existentes. Gaps conhecidos, truncamento, reinício e períodos
sem capturas elegíveis não ganham cobertura por bordas, duplicação ou restart.
O minuto UTC aguarda 2s para receber o capture seguinte que comprova sua borda,
com `knowledge_at` limitado e explícito. Essa prova é recortada à janela original;
frescor começa apenas no máximo dos relógios de origem e recebimento. Um dado
recebido depois da borda não preenche o passado.
As provas copiam os captures originais em evidência protegida. Segmentos são
não sobrepostos e append-only; ausência de um segmento conta no denominador.
Não há backfill sintético. Limites de leitura recusam evidência excessiva sem aprovar.

Um episódio começa no primeiro fill e fecha ao retornar integralmente a zero.
Parciais não criam episódios adicionais; janelas e UTC não liquidam posições.
A projeção financeira usa toda a base vitalícia. Recortes históricos valorizam
cashflows por event-time, reconciliados no `knowledge_at` registrado, preservando
os eventos e seus receive-times. A sequência densa existe somente no reducer
de avaliação; o journal e seus IDs/seqs originais permanecem nos inputs.
Funding/custo incompletos, valorização ausente ou gap financeiro impedem aprovação.
PnL aberto positivo não ajuda o resultado conservador; negativo permanece debitado.
Infraestrutura continua fora do resultado e dos limites.

A avaliação ocorre no produto uma vez por dia UTC, após um minuto completo
para permitir a reconciliação da virada; o `knowledge_at` permanece explícito.
Esse atraso não presume funding/custo completo nem altera a borda UTC. Antes de 90 dias, exige pelo
menos 60 episódios em cada conta, 99% sem arredondar a fronteira, custos completos,
reconciliação e resultado conservador estritamente positivo em paper e stress.
Caixa/BTC ficam visíveis sem hurdle inicial. Uma prévia dos últimos 30 dias é
informacional e não substitui a elegibilidade inicial nem permite reotimização.

Após 90 dias de calendário, a janela desliza diariamente 90 dias, com patrimônio,
posições e benchmark original preservados. Exige o melhor caixa/BTC protegido mais
US$12,50 (5pp da base US$250); a margem exata é suficiente, empate com o benchmark
não é. A referência deve ter uma trajetória persistida observada até a borda final.
Sua valorização histórica só lê eventos/settlements e marcas originais: nunca
avança ordens, compra novamente, interpola ou reinicia a referência na borda.
Ausência de trajetória/funding/marca completos fica explícita e inconclusiva.

Os estados são `validating`, `eligible`, `inconclusive` e `failed`. A qualificação
observada de sete dias é um gate independente em `jev_engine_qualifications`,
sem seed ou escritor que certifique pelo boot. O contrato requer continuidade
financeira e execução/custos/funding/risco/recuperação comprovados com dependências.
GJ12.3 produz essa evidência na etapa própria. Gap financeiro invalida o gate;
reprovação comprovada de risco/economia em qualquer alternativa prevalece e
permanece para a mesma versão. Uma versão material nova recebe novas contas,
amostra e avaliação; não herda aprovação anterior.

`GET /trading/jev/evaluations?profile_id=...&profile_version=...` é autenticado,
restrito ao owner, READ ONLY, orçamento 1500ms e no-store. Retorna cuts imutáveis,
com `as_of` e fases explícitos; sem cut retorna `not_started`. Métodos de escrita
e caminhos descendentes ficam fechados no gateway. A leitura não captura dados.
Falhas da captura/avaliação são expostas no health do worker como `unavailable`,
sem interromper o loop independente de proteção nem fabricar um resultado novo.

A migration 0058 acrescenta índices e journals ao orçamento vigente; não altera
migrations aplicadas nem habilita executor. Reversão usa código compatível e
entradas pausadas, preservando proteção, ledger, evidência e reconciliação.
Fixtures verificam o avaliador e os guards, sem certificar sete dias, 60 episódios
prospectivos, cobertura observada, 90 dias ou qualificação live.
