# Worker de execução JEV — JE07/JE10/JE12

O serviço `execution-worker` usa a imagem TypeScript existente e seu próprio pool
(quatro conexões, 256 MiB). A API serve leituras, autenticação, prévias e a fila de
comandos; não inicia decisão ou proteção. O coletor `btc-worker` continua separado,
opt-in e parado por padrão. A presença de credencial não admite contas.

O processo adquire uma geração persistente com lease de dez segundos. Cada
transação de escrita verifica o dono sob lock e valida o relógio do PostgreSQL
antes do commit. Uma geração expirada nunca retorna. HTTP JEV não mantém esse
lock: reserva/custo/original permanecem no journal JE04, e a proteção continua
em sua cadência independente. O heartbeat é do PID real do worker; saúde da API
não comprova saúde de execução.

As escritas do mesmo processo aguardam a fila local antes de `BEGIN`, para não
consumir o orçamento SQL disputando seu próprio lock. Os chamadores são limitados;
nenhuma inferência HTTP ocupa essa fila. Preâmbulos de isolamento/snapshot e
budgets precedem o primeiro fence, mas nenhuma consulta de dados ou comando
financeiro passa sem verificar o dono. O fence final e os limites SQL continuam
iguais. Falha libera a fila e conserva rollback integral.

`make up`/`make server-up` gravam o SHA do checkout na imagem. Um archive de
produção já carrega seu SHA imutável. Ao usar Compose diretamente num checkout,
informe `GANSO_RELEASE_SHA` com a revisão construída; o worker recusa stamp ausente
ou inválido em vez de declarar uma versão desconhecida.

As contas JEV não ganham controles ou admissão no boot. `jev_worker_controls`
começa vazio; seus defaults são `admitted=false` e `entries_paused=true`. Admissão
referenciada, tarifa/modelo fixado, orçamento, custo de funding, contexto completo
e reconciliação são requisitos distintos. A API não expõe edição dessas tabelas.
GJ12.2/12.3, GJ13.5 e GJ15.1–3 mantêm suas seleções próprias. Este código não
financia live nem arma signer.

O scheduler `jev.scheduler.v2` despacha até três perfis/versões do registry e
seis contas paper/stress, em até três lanes, inclusive durante preparo de contexto.
Contas do mesmo perfil compartilham o corte do lote e conservam decisões próprias.
Proteção usa três tarefas delimitadas, em cadência independente de um segundo;
falha local pausa a conta afetada e não impede tentativas de redução das demais.
Falha de fencing/persistência impede a publicação de saúde. Troca de registry não
ultrapassa o teto global de lanes nem cria dois donos ou um executor live. Aplica o contrato JE02 de 60s/2s e cooldown,
sem alterar o manifesto. Usa o cutoff original do coletor, capturas contínuas de
60s, timestamps originais e candles fechados. Não retimestampa dados para produzir
frescor. Uma lane pendente não aceita outra inferência. A aplicação revalida
lease/geração, request/corte/deadline/TTL, sequência financeira, posição, reservas,
proteção e revisão de controle. Falhas pausam entradas; saídas obrigatórias não
aguardam o JEV. O journal separa atraso da coleta, latência da decisão e execução.

A fila da mesa conserva intent assinado e hash de token, nunca token original.
O worker revalida sessão, acesso, assinatura, validade, livro, metadata e risco.
Tentativas recusadas ficam imutáveis e permitem nova tentativa; efeitos aceitos
usam o recibo financeiro idempotente original. Um crash entre efeito e confirmação
da fila é recuperado por esse recibo. Prioridade: proteção/reconciliação, pausa,
cancelamento/close e entrada.

## Pares e admissão de carga — JE10

Registro, ledger, reservas, liquidez, partial/cancel/IOC, risco e atribuição
conservadora de JEV reaproveitam JE02–JE09. Paper conserva latência de 1s; stress,
2s e trading fees dobradas. Funding mantém taxa e arredondamento próprios pela
quantidade assinada de cada conta; não duplica a taxa por ser stress.

A migration 0059 acrescenta `capacity_evidence_id` nullable aos controles e um
journal de funding imutável; não insere contas, provas ou admissão. Antes de
preparar uma entrada flat e novamente antes do envio, o worker exige prova
`jev.dispatch-capacity.v1` original retida, com dependências preservadas, hash do
registry atual, modelo fixado, validade explícita e referências de recursos
sustentados, uso/fatura reconciliados e evidência protegida. Custo/capacidade ausente,
projeção 90d/retenção acima da parada existente, disco livre abaixo de 25%, custos
acima dos pools US$8/US$2 ou latência/proteção fora de 1500ms/1000ms bloqueiam novas
entradas. Posição existente continua protegida e pode receber decisão de saída;
nenhum gate de admissão suspende redução obrigatória. Prova da fixture não deve
ser provisionada em produção. GJ12.1/12.2 devem conferir e registrar medições reais.

`jev.funding.v1` faz no máximo uma consulta pública por ciclo de 30s, sem manter
fence SQL durante HTTP, e agrupa só a observação final de uma hora. A seleção
round-robin impede que uma lacuna histórica monopolize as contas. Cada participante
reconstitui sua quantidade econômica no cutoff, mantém funding/recibo/evidência
próprios e conserva idempotência sob concorrência. Reutiliza o modelo paper
`btc.funding.paper-precut.v2`, com snapshot HTTP recebido antes do cutoff;
preço de origem desconhecido continua explicitamente aproximado. Fonte/hora
ambígua, taxa inexata, snapshot ausente ou fill no mesmo instante ficam pendentes.
Correção divergente preserva o dinheiro anterior e registra conflito permanente;
custo ou risco não ficam completos através de um flat/restart. Referências:
[funding](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/funding) e
[info API](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint),
reconferidas em 08/10/2026.

Saúde interna inclui lanes/contas/proteções, falhas e skips, limites de dispatch,
fila e espera do fence, transações, custo/capacidade bloqueados e funding.
O ensaio PostgreSQL do delta mede CPU, crescimento físico, WAL, escrita e fontes
protegidas para seis contas com ciclos coincidentes. É carga delimitada de teste;
não comprova CPU sustentada, tarifa/usage real, cobertura prospectiva ou sete dias.

## Propostas e sucessão — JE12

`jev.proposal-lane.v1` inicia no máximo um ciclo por minuto, sem backlog nem
sobreposição. A tarefa é independente do heartbeat, da proteção, do funding e
da avaliação. HTTP de validação não retém o fence SQL. Desligamento cancela o
pedido e aguarda seu registro; uma geração expirada não pode finalizar. Pedido
incerto após crash permanece cobrado conservadoramente, abre circuito e não é
reenviado. A saúde interna expõe configuração, estado, ciclos e falhas desta tarefa.

Configuração protegida, credencial/tarifa e controles explicitamente admitidos
são gates separados. `jev_generator_controls` começa vazio, com `enabled=false`
por padrão; boot e deploy não provisionam controles, prova, crédito ou chave.
Sem esses gates o controlador permanece desligado. Aposentadoria revalida
controle e capacidade dentro da transação antes de pausar/cancelar entradas.
Contas com inventário/reservas/funding/reconciliação pendentes continuam sob a
proteção existente. Somente reprovação definitiva e encerramento reconciliado
liberam a vaga; perdas, bindings, manifestos, ledger e eventos antigos permanecem.

A retirada invalida a prova de capacidade do registry anterior. Geração exige
prova do registry corrente; admissão exige prova prospectiva da substituição,
fontes frescas e observação do worker. Esses originais devem ser comprovados no
fluxo operacional próprio, nunca copiados das fixtures. O controlador consome a
primeira proposta da fila vigente, com validação real positiva e custo conhecido,
antes de gerar outro append. Reordenação e remoção do operador usam revisão CAS;
a geração não muda a prioridade nem a versão ativa silenciosamente. Aptidão
JEV é técnica e não comprova qualificação econômica. GJ12.2/12.3, GJ13.5 e
GJ15.1–3 continuam fora desta entrega; nenhuma sucessão live é implementada aqui.

## Handoff inicial

O deploy compara a árvore publicada e seleciona API, migration e o novo worker.
Antes de substituir a API, pausa entradas antigas e exige contas antigas flat,
sem reservas ativas, sem recuperação bloqueada e sem execução JEV prévia não
reconciliada. Gate falho interrompe o handoff com entradas pausadas e proteção
anterior preservada. A API atualizada deve ficar saudável antes de iniciar o novo
dono; o worker reconcilia os leases antigos antes de renovar sua prontidão.

Verifique `make server-health`, o healthcheck do container e o arquivo interno
`/tmp/ganso-execution-health.json`: serviço, PID, geração, SHA da imagem, timestamp
recente e contadores. Compare versões/checksums de migrations, ledger, projeções,
reservas e pins capturados antes do deploy. A integração Compose encerra a API e
verifica que o mesmo worker continua saudável, com proteção progredindo.

## Restart e reversão

Restart descarta inferências pendentes sem reenviar consultas. Cadência, HWM,
âncoras, entradas, fills e custos não são zerados. Reserva paper sem send pode
ser liberada na recuperação; send/ACK/parcial/cancel são reconciliados pelo
journal de execução JE06. A proteção desde a primeira parcial conserva stop e
prazo de seis horas.

Para reversão, pause entradas e use uma imagem compatível com 0059, mantendo o
worker de proteção ativo. Não retornar ownership à API antiga com posição ou
reserva pendente. Transferência inversa só após flat/reconciliação e término do
dono atual; gerações e eventos anteriores permanecem. Não reverter migrations,
apagar volumes, reescrever ledger, liberar HOLD ou remover pins.

## Runtime live — JE15

O mesmo entrypoint publicado conecta o adaptador live, com uma tarefa independente
para reconciliação, proteção nativa, cancelamento e redução do residual. O dispatch
`jev.scheduler.v3` permite sete contas, três perfis e três participantes por lote.
Envios e reconciliação da mesma identidade compartilham essa tarefa limitada,
fora de locks SQL, para não tratar um envio ainda em curso como pedido perdido.
Essa serialização não aguarda inferência JEV nem acumula ticks de proteção.
Reserva de comando em curso pertence ao processo até encerrar o envio; não é
abandonada por um ciclo concorrente. Em flat comprovado, a tarefa cede ao comando
sem renovar admissão. Após restart, reserva sem intenção enviada expira sem replay.
O boot padrão fica sem signer, conexão live, admissão ou envios. Capacidade medida
deve corresponder ao registry atual, incluindo a promoção live; a versão anterior
do engine não qualifica automaticamente este workload. Os aceites históricos são
preservados. A saúde do processo não comprova admissão operacional.
Os motivos sanitizados `last_decision_reason` e `last_execution_reason` permitem
diagnosticar uma decisão recusada ou um comando vencido antes do envio, sem
publicar dados do signer, respostas privadas ou erros brutos do transporte.

A configuração pública opcional usa `GANSO_LIVE_RUNTIME_CONFIG_FILE` e exatamente
`version: jev.live-runtime.v1`, `environment: mainnet` e `identity_hash` da identidade
persistida. Não aceita chave, flag de ativação ou alteração de limites. Apenas o
executor recebe esse arquivo. O signer vem exclusivamente do arquivo protegido
`/run/secrets/jev_live_signer`, montado somente leitura no executor, fora de Git e
do frontend, sem symlink, com permissões 0400/0600 e acesso pelo usuário 1000 da
imagem. A chave nunca deve ser fornecida por chat, variável de ambiente, JSON de
runtime ou SQL. O operador provisiona esse segredo pelo mecanismo protegido do
servidor e registra o ato inicial autenticado; este deploy não o faz.

O overlay opcional `infra/compose/jev-live.yml` conecta somente esses dois arquivos
ao executor. Sua seleção é ato operacional posterior aos gates, com os caminhos
`GANSO_LIVE_PUBLIC_CONFIG_PATH` e `GANSO_LIVE_SIGNER_FILE_PATH` provisionados pelo
operador. Os binds são somente leitura e não criam arquivos faltantes. O Compose
padrão e o deploy desta entrega não selecionam esse overlay. Sua configuração
não ativa piloto nem habilita entradas por boot.

Só uma identidade já persistida e previamente ativada pode carregar o signer e
reconstruir o piloto. Configurar ou reiniciar não cria conta, capital, admissão ou
ativação. Ausência/divergência de identidade, ambiente, segredo ou ativação fecha
o adaptador. `live.capabilities` distingue implementação de runtime, intervenções
e painel financeiro. JE16/JE17 ainda fecham entradas por capacidade do código;
nenhuma configuração operacional contorna esse gate. Qualificação GJ12.3,
validação GJ13.5, elegibilidade, custos, cobertura e capacidade atuais continuam
necessários em suas etapas próprias. Fixtures não aprovam essas etapas.

No heartbeat interno, verificar `live.connected`, `signer_loaded`, `entries_ready`,
`reasons`, ciclos/falhas/duração e o SHA/geração. A projeção SQL `jev_live_runtime`
é limitada, pertence à geração corrente e expira para admissão após 1,5 s.
Snapshots, fills, funding assinado, fees, receipts e metadata originais permanecem
no journal imutável. Fonte stale, lacuna ou saldo divergente fecha entradas;
nenhuma leitura fabrica horário de origem ou patrimônio.

O contexto JEV usa snapshot, risco e proteção persistidos até o corte do coletor.
Uma observação posterior financeiramente idêntica não invalida o lote; alteração
de posição, ordens, fills, funding, HWM, bloqueios ou vínculo invalida a resposta.
Tempo original da venue pode anteceder o pedido, desde que fonte e consulta
continuem frescas. Ambos os relógios permanecem verificados sem reescrever fonte.

Na recuperação, primeiro reconstruir pedidos, reservas, ordens, stops, residual
financeiro e risco do piloto a partir dos journals e da venue. Pedido enviado sem
recibo é consultado por seu identificador; nunca reenviar por timeout. ACK de
cancelamento/IOC não é flat. Cancelamento expirado só admite nova intenção/nonce
quando uma consulta fresca
posterior à expiração comprova a ordem ainda aberta; o pedido anterior é imutável.
A primeira parcial fixa stop e prazo de seis horas;
quantidade protegida acompanha fills e reduções. JEV lento/indisponível, custo
incerto e pausa de entradas não suspendem reconciliação/proteção. Shutdown fecha
entradas antes de aguardar tarefas e mantém stops nativos. Geração antiga não pode
assinar nem confirmar depois de takeover; saída normal libera apenas seu lease.

Reprovação comprovada conduz a draining, cancelamento, IOC reduce-only e consulta
do residual. Sucessora só recebe o vínculo após confirmação financeira flat e
sem ordens/reservas, com elegibilidade atual. Estado inconclusivo ou lucro maior
de outra estratégia não troca o piloto. Capital, HWM, perda diária, bloqueios,
controles e autorização inicial são contínuos; não existe novo aporte por troca.

Publicação seletiva aplica 0068 e atualiza somente serviços afetados já ativos,
sem iniciar coletor ou montar signer. Verificar checksums, SHA da imagem, saúde,
leases, contagens de ativações e journals antes/depois. Para reversão, pausar
entradas e usar código compatível com 0068 que mantenha proteção/reconciliação
live. Não voltar à imagem anterior que só conhece paper com um piloto aberto.
Nunca desfazer migrations ou apagar ledger, pins, reservas e histórico financeiro.
A integração Compose executa o boot padrão fechado e o mesmo entrypoint com
PostgreSQL e transporte sintéticos em uma imagem de teste separada, sem acesso
à venue real ou a signer operacional.
