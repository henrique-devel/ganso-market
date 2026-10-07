---
id: GJ06.3
macro: GJ06
part: 3
depends_on: ["GJ06.2"]
operational_gates: []
mode: codigo
authorization: alteracoes-pr-merge-producao
tracking: docs/roadmap/GANSO_JEV_EXECUTION_STATE.md
context: uma-sessao-escopo-delimitado
---

# Integrar cadências e descartar decisões obsoletas

Execute somente **GJ06.3**, parte 3 do bloco GJ06. Conclua o resultado abaixo e sua publicação aplicável; encerre sem iniciar outra sessão.

## Autorização explícita

Você está expressamente autorizado pelo proprietário a **alterar e implementar** o escopo desta sessão, criar branch `codex/`, commit/push, **criar e corrigir PR**, revisar o diff, acompanhar os checks obrigatórios, fazer **merge** após aprovação dos checks e proteções, e **publicar em produção** os componentes afetados. Inclui migrations aditivas, configuração e restart seletivo necessários. Prossiga sem pedir nova confirmação por etapa; respeite a [autorização registrada](../../docs/ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-jev-com-autonomia-por-bloco).

Esta autorização não compra API/infra nem aporta capital. Operação real segue os gates e a ativação autenticada inicial do operador; não a execute em nome dele. Publicar código desabilitado está autorizado enquanto os gates estiverem pendentes.

## Contexto mínimo

- Leia o [protocolo](00-protocolo.md) e somente a emenda de autorização acima.
- Consulte a linha GJ06.3 e GJ06.2 no [estado](../../docs/roadmap/GANSO_JEV_EXECUTION_STATE.md); confirme contratos/commits disponíveis sem reler o histórico.
- Leia somente [GJ06 Proteções e worker de execução](../../docs/roadmap/GANSO_JEV_IMPLEMENTATION_PLAN.md#gj06-protecoes-e-worker-de-execucao) do plano.
- Seções do PRD: [Decisão JEV e supervisão independente](../../docs/PRD-GANSO-JEV.md#decisao-jev-e-supervisao-independente); [Risco e dimensionamento](../../docs/PRD-GANSO-JEV.md#risco-e-dimensionamento).

Localize os símbolos relevantes nestas entradas; abra apenas os trechos necessários. Módulos novos derivados do contrato são propostas, não funcionalidades existentes:

- [apps/api/src/storage/desk-worker.ts](../../apps/api/src/storage/desk-worker.ts)
- [apps/api/src/storage/desk-consumer.ts](../../apps/api/src/storage/desk-consumer.ts)
- [apps/api/src/storage/recoverystore.ts](../../apps/api/src/storage/recoverystore.ts)
- [apps/api/src/models/jev.ts](../../apps/api/src/models/jev.ts)

## Resultado e limite

Integrar scheduler de um perfil às decisões JEV, execução e proteção: 60s padrão; 2s com posição+gatilho versionado; risco/reconciliação têm cadência independente e prioridade. Evitar backlog de inferências atrasadas e bloquear resposta cujo corte/deadline/posição mudou. Registrar latência de ciclo e métricas separadas de coleta/decisão/execução.

Escolha detalhes técnicos rotineiros dentro do contrato e versione antes do experimento. Preserve trabalho alheio e contratos históricos. Alvo: 3–6 arquivos de lógica e uma migration aditiva; divida uma fronteira maior conforme o protocolo, sem declarar aceite parcial como concluído.

## Aceite

- Sem posição não ativa fast; mudança de estado invalida resposta obsoleta.
- Falha/orçamento JEV pausa entradas e mantém saídas.
- Scheduler não acrescenta atraso fixo nem acumula decisões antigas.

## Verificação

Relógio controlado, provedor lento, conta fechando durante inferência, fast/cooldown e restart com lease. Execute testes proporcionais ao diff e checks exigidos na base reconciliada. SQL usa banco descartável; não produção. Fixture não comprova operação prospectiva.

## Publicação e gates

Publicar scheduler fechado para admissão até completar métricas/avaliação; não criar uma conta live por achar chave. Revise o delta, publique PR, faça merge após checks e conclua o deploy aplicável. Verifique versão/saúde/persistência; para reversão, pause entradas, preserve proteção e use código compatível com o schema, sem apagar eventos.

Não há gate operacional adicional a cumprir para desenvolver esta sessão; permanecem os controles do protocolo. Observação pendente deve ser registrada, sem manter a sessão esperando.

## Fechamento

Atualize somente a linha GJ06.3 no estado: entrega, PR/SHA, validação observada e implantação/gate pendente. Se não houver delta, não crie PR vazio. Relate mudança, verificação e publicação ou bloqueio concreto; não invente teste/deploy/qualificação. Não execute o próximo prompt.
