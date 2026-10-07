---
id: GJ13.4
macro: GJ13
part: 4
depends_on: ["GJ13.3","GJ06.1"]
operational_gates: []
mode: codigo
authorization: alteracoes-pr-merge-producao
tracking: docs/roadmap/GANSO_JEV_EXECUTION_STATE.md
context: uma-sessao-escopo-delimitado
---

# Instalar proteção nativa desde o primeiro parcial

Execute somente **GJ13.4**, parte 4 do bloco GJ13. Conclua o resultado abaixo e sua publicação aplicável; encerre sem iniciar outra sessão.

## Autorização explícita

Você está expressamente autorizado pelo proprietário a **alterar e implementar** o escopo desta sessão, criar branch `codex/`, commit/push, **criar e corrigir PR**, revisar o diff, acompanhar os checks obrigatórios, fazer **merge** após aprovação dos checks e proteções, e **publicar em produção** os componentes afetados. Inclui migrations aditivas, configuração e restart seletivo necessários. Prossiga sem pedir nova confirmação por etapa; respeite a [autorização registrada](../../docs/ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-jev-com-autonomia-por-bloco).

Esta autorização não compra API/infra nem aporta capital. Operação real segue os gates e a ativação autenticada inicial do operador; não a execute em nome dele. Publicar código desabilitado está autorizado enquanto os gates estiverem pendentes.

## Contexto mínimo

- Leia o [protocolo](00-protocolo.md) e somente a emenda de autorização acima.
- Consulte a linha GJ13.4 e GJ13.3, GJ06.1 no [estado](../../docs/roadmap/GANSO_JEV_EXECUTION_STATE.md); confirme contratos/commits disponíveis sem reler o histórico.
- Leia somente [GJ13 Adaptador live e proteção nativa](../../docs/roadmap/GANSO_JEV_IMPLEMENTATION_PLAN.md#gj13-adaptador-live-e-protecao-nativa) do plano.
- Seções do PRD: [Execução e proteção](../../docs/PRD-GANSO-JEV.md#execucao-e-protecao); [Risco e dimensionamento](../../docs/PRD-GANSO-JEV.md#risco-e-dimensionamento).

Localize os símbolos relevantes nestas entradas; abra apenas os trechos necessários. Módulos novos derivados do contrato são propostas, não funcionalidades existentes:

- [apps/api/src/storage/recoverystore.ts](../../apps/api/src/storage/recoverystore.ts)
- [apps/api/src/storage/riskstore.ts](../../apps/api/src/storage/riskstore.ts)
- [apps/api/src/storage/baseline-exits.ts](../../apps/api/src/storage/baseline-exits.ts)
- [apps/api/src/venues/hyperliquid/public.ts](../../apps/api/src/venues/hyperliquid/public.ts)

## Resultado e limite

Implementar SL market mark-trigger por posição desde primeiro parcial, separado de filhos da ordem de entrada. Revalidar tolerance/campos/estados atuais, preservar reserva integral 10% no sizing e reconciliar quantidade/proteção durante fills/cancel. Falta de confirmação bloqueia entrada, cancela restante e solicita IOC sem JEV; pending não vira flat.

Escolha detalhes técnicos rotineiros dentro do contrato e versione antes do experimento. Preserve trabalho alheio e contratos históricos. Alvo: 3–6 arquivos de lógica e uma migration aditiva; divida uma fronteira maior conforme o protocolo, sem declarar aceite parcial como concluído.

## Aceite

- Cancelar maker não remove proteção da posição parcial.
- Triggered não é filled; quantidade residual permanece conciliada.
- Stop/IOC simultâneos não abrem oposto nem duplicam close.

## Verificação

Fixtures de parent cancel/partial, SL não confirmado, outage, trigger sem fill e restart; validar contratos oficiais. Execute testes proporcionais ao diff e checks exigidos na base reconciliada. SQL usa banco descartável; não produção. Fixture não comprova operação prospectiva.

## Publicação e gates

Publicar proteção/controlador live desativados; nenhum teste com capital real por esta entrega. Revise o delta, publique PR, faça merge após checks e conclua o deploy aplicável. Verifique versão/saúde/persistência; para reversão, pause entradas, preserve proteção e use código compatível com o schema, sem apagar eventos.

Não há gate operacional adicional a cumprir para desenvolver esta sessão; permanecem os controles do protocolo. Observação pendente deve ser registrada, sem manter a sessão esperando.

## Fechamento

Atualize somente a linha GJ13.4 no estado: entrega, PR/SHA, validação observada e implantação/gate pendente. Se não houver delta, não crie PR vazio. Relate mudança, verificação e publicação ou bloqueio concreto; não invente teste/deploy/qualificação. Não execute o próximo prompt.
