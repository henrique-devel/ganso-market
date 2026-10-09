# Worker de execução JEV — JE07/JE10

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
