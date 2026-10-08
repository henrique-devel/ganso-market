# Worker de execução JEV — JE07

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

O scheduler integra um perfil; contas do mesmo perfil compartilham o corte do
lote e conservam decisões próprias. Aplica o contrato JE02 de 60s/2s e cooldown,
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

Para reversão, pause entradas e use uma imagem compatível com 0056, mantendo o
worker de proteção ativo. Não retornar ownership à API antiga com posição ou
reserva pendente. Transferência inversa só após flat/reconciliação e término do
dono atual; gerações e eventos anteriores permanecem. Não reverter migrations,
apagar volumes, reescrever ledger, liberar HOLD ou remover pins.
