# Backend de decisões principais JEV — JE04

A migration 0053 e os módulos `models/jev-decision*` compõem contrato, transporte,
reserva, journal, leitura e replay. Não há scheduler, admissão paper ou executor
novo conectado por esta entrega. O filtro v1 permanece compatível para histórico.

`buildJevBatch` reúne somente participantes do mesmo dono/perfil/versão/manifesto,
com o mesmo corte e referências/valores de mercado. Cada conta traz posição e
estado próprios. Duas perguntas por conta selecionam direção long/short e intenção
open/hold/close. Seu texto vincula dono, conta, modo, experimento, posição, corte,
manifesto, horizonte, modelo e versão. IDs de perguntas são apenas chaves da API.

`loadJevDecisionBackend` usa os arquivos protegidos de `loadChallengerConfig`,
exige admissão explícita (default false), credencial, configuração e modelo fixado.
A existência de chave não habilita chamadas. Provisionamento mensal é separado:
`provisionJevCostPool` exige referências de cobertura existente e limite de cobrança
atestado. Não compra créditos nem é chamado na inicialização. A tarifa vem do
contrato protegido, sem preço público assumido como tarifa da conta.

Antes da primeira tentativa, modelo/versão de perguntas ficam imutavelmente
vinculados ao perfil por origem; reinício não permite trocá-los na mesma versão.

Pools por origem/mês UTC: US$8 operação e US$2 geração/validação, compartilhados
por todos os perfis. Mock nunca compõe fatura real. Uma mesma origem/request ID
não pode ser cobrada novamente nem migrar para outro propósito/perfil. Pools v1 e
principal não podem estar habilitados simultaneamente; histórico não é alterado.
A passagem de mês exige novo provisionamento explícito, sem liberar reservas antigas.
Custos de geração ficam globais, ligados à proposta quando identificável; atribuição
para aceites econômicos permanece pendente e não é inventada por JE04.

Antes do envio, persistir contextos com sua closure de originais no contrato JE03.
A reserva verifica contextos registrados e bindings; ausência/closure encerrada,
capacidade insuficiente, custo/tarifa desconhecidos ou orçamento indisponível
impedem envio. Requests, participantes e resultados são append-only, cobram bytes
no budget SQL existente e protegem seus contextos e fontes de descarte. Nenhum
lock/transação SQL atravessa o HTTP. Concorrência máxima: três tentativas por origem,
inclusive entre processos; request 64KiB, response 32KiB e até três participantes
(seis perguntas). Deadline até 1,5s desde corte e TTL de decisão 2s.

HTTP direto no endpoint fixo; zero retries, redirects ou fallback real→mock.
Status, original UTF-8, hash, timestamps, usage e tarifa permanecem no journal.
Usage é validado independentemente da decisão: erro localizado não contamina uma
conta válida e pode ser cobrado. Chaves de roteamento extras/duplicadas ou binding alterado recusam
lote; campos duplicados dentro de pergunta conhecida recusam somente sua conta. Escolha com baixa confiança válida é utilizável; confiança é diagnóstico.
Open com posição, close flat ou alteração da direção em hold/close são recusados.
Nenhuma resposta escolhe tamanho, risco, preço, margem ou proteção.

Timeout/cancelamento após envio e crash podem deixar custo desconhecido: null não
é zero, e a reserva integral permanece consumida. Resposta capturada antes do
prazo com finalização tardia conserva cobrança conhecida, mas nenhuma ação. Circuito
abre em custo desconhecido ou três falhas de lote sem conta válida; não há rearme
automático. Resolução tardia não escreve resultado nem reenvia. Confirmação de
commit perdida não libera reserva: retomada encontra o request durável.

`readJevDecision` e `replayJevDecision` reconstruem apenas originais/identidades
capturados, inclusive recusa sem consulta. Leituras auditáveis não executam HTTP.
`usableJevDecision` revalida origem real, propósito operacional, conta/posição,
recovery, pausas de entrada e validade; nunca fornece tamanho/ordem. O supervisor
independente das entregas seguintes continua responsável por risco e saídas.

`readJevCosts` soma request uma vez na fatura e, por conta operacional participante,
atribui o custo integral. A soma dessas atribuições não é despesa da plataforma.
A leitura agrega em SQL por mês/pool; custos desconhecidos aparecem explicitamente.
Infra e vida financeira do ledger ficam fora desses pools. Auth/perímetro existentes
não são ampliados; as funções de leitura exigem composição autenticada do chamador.

Publicar não é admitir operação. GJ12.2/12.3, GJ13.5 e GJ15.1–3 permanecem próprios;
viabilidade JE03 e cobertura efetiva continuam gates. Nenhuma chamada paga foi
necessária para desenvolver/verificar JE04. Reversão mantém migration/journal,
pausa entradas e usa código compatível, preservando proteção e reconciliação.

API oficial reconferida em 08/10/2026: [HTTP](https://docs.typesafe.ai/api),
[Choice](https://docs.typesafe.ai/primitives/choice),
[estado compartilhado](https://docs.typesafe.ai/concepts/state),
[modelos fixados](https://docs.typesafe.ai/models). Os limites de bytes/concorrência
acima são limites locais conservadores; não representam garantia de capacidade,
fatura, latência ou elegibilidade do provedor.
