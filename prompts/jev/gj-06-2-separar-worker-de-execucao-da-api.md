---
id: GJ06.2
macro: GJ06
part: 2
depends_on: ["GJ06.1","GJ03.4"]
operational_gates: []
mode: codigo
authorization: alteracoes-pr-merge-producao
tracking: docs/roadmap/GANSO_JEV_EXECUTION_STATE.md
context: uma-sessao-escopo-delimitado
---

# Separar worker de execução da API

Execute somente **GJ06.2**, parte 2 do bloco GJ06. Conclua o resultado abaixo e sua publicação aplicável; encerre sem iniciar outra sessão.

## Autorização explícita

Você está expressamente autorizado pelo proprietário a **alterar e implementar** o escopo desta sessão, criar branch `codex/`, commit/push, **criar e corrigir PR**, revisar o diff, acompanhar os checks obrigatórios, fazer **merge** após aprovação dos checks e proteções, e **publicar em produção** os componentes afetados. Inclui migrations aditivas, configuração e restart seletivo necessários. Prossiga sem pedir nova confirmação por etapa; respeite a [autorização registrada](../../docs/ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-jev-com-autonomia-por-bloco).

Esta autorização não compra API/infra nem aporta capital. Operação real segue os gates e a ativação autenticada inicial do operador; não a execute em nome dele. Publicar código desabilitado está autorizado enquanto os gates estiverem pendentes.

## Contexto mínimo

- Leia o [protocolo](00-protocolo.md) e somente a emenda de autorização acima.
- Consulte a linha GJ06.2 e GJ06.1, GJ03.4 no [estado](../../docs/roadmap/GANSO_JEV_EXECUTION_STATE.md); confirme contratos/commits disponíveis sem reler o histórico.
- Leia somente [GJ06 Proteções e worker de execução](../../docs/roadmap/GANSO_JEV_IMPLEMENTATION_PLAN.md#gj06-protecoes-e-worker-de-execucao) do plano.
- Seções do PRD: [Dados capacidade e recuperação](../../docs/PRD-GANSO-JEV.md#dados-capacidade-e-recuperacao); [Decisão JEV e supervisão independente](../../docs/PRD-GANSO-JEV.md#decisao-jev-e-supervisao-independente).

Localize os símbolos relevantes nestas entradas; abra apenas os trechos necessários. Módulos novos derivados do contrato são propostas, não funcionalidades existentes:

- [apps/api/src/main.ts](../../apps/api/src/main.ts)
- [apps/api/src/storage/desk-consumer.ts](../../apps/api/src/storage/desk-consumer.ts)
- [apps/api/src/storage/recoverystore.ts](../../apps/api/src/storage/recoverystore.ts)
- [docker-compose.yml](../../docker-compose.yml)
- [deploy/healthcheck.sh](../../deploy/healthcheck.sh)

## Resultado e limite

Criar entrypoint TS dedicado usando a imagem/runtime existentes. Mover ownership de decisão/execução da API, mantendo coletor separado. Planejar handoff reversível de contas existentes, quiescer entradas antigas e reconciliar posições/reservas sem remover histórico. Implementar health e lease/fencing com um dono efetivo; rollout inicia sem entradas novas.

Escolha detalhes técnicos rotineiros dentro do contrato e versione antes do experimento. Preserve trabalho alheio e contratos históricos. Alvo: 3–6 arquivos de lógica e uma migration aditiva; divida uma fronteira maior conforme o protocolo, sem declarar aceite parcial como concluído.

## Aceite

- Restart da API não desliga supervisor.
- Dois workers não comandam a mesma conta.
- Handoff preserva contas/pendências antigas e permite rollback compatível.

## Verificação

Falhas de processo/lease/commit, ownership concorrente, smoke Compose e health do processo correto; não medir só API. Execute testes proporcionais ao diff e checks exigidos na base reconciliada. SQL usa banco descartável; não produção. Fixture não comprova operação prospectiva.

## Publicação e gates

Publicar seletivamente API/worker/health; handoff somente com gates de reconciliação, sem ativação live. Revise o delta, publique PR, faça merge após checks e conclua o deploy aplicável. Verifique versão/saúde/persistência; para reversão, pause entradas, preserve proteção e use código compatível com o schema, sem apagar eventos.

Não há gate operacional adicional a cumprir para desenvolver esta sessão; permanecem os controles do protocolo. Observação pendente deve ser registrada, sem manter a sessão esperando.

## Fechamento

Atualize somente a linha GJ06.2 no estado: entrega, PR/SHA, validação observada e implantação/gate pendente. Se não houver delta, não crie PR vazio. Relate mudança, verificação e publicação ou bloqueio concreto; não invente teste/deploy/qualificação. Não execute o próximo prompt.
