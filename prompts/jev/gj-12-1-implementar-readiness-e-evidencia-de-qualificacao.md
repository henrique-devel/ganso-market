---
id: GJ12.1
macro: GJ12
part: 1
depends_on: ["GJ09.3","GJ10.3","GJ02.4"]
operational_gates: []
mode: codigo
authorization: alteracoes-pr-merge-producao
tracking: docs/roadmap/GANSO_JEV_EXECUTION_STATE.md
context: uma-sessao-escopo-delimitado
---

# Implementar readiness e evidência de qualificação

Execute somente **GJ12.1**, parte 1 do bloco GJ12. Conclua o resultado abaixo e sua publicação aplicável; encerre sem iniciar outra sessão.

## Autorização explícita

Você está expressamente autorizado pelo proprietário a **alterar e implementar** o escopo desta sessão, criar branch `codex/`, commit/push, **criar e corrigir PR**, revisar o diff, acompanhar os checks obrigatórios, fazer **merge** após aprovação dos checks e proteções, e **publicar em produção** os componentes afetados. Inclui migrations aditivas, configuração e restart seletivo necessários. Prossiga sem pedir nova confirmação por etapa; respeite a [autorização registrada](../../docs/ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-jev-com-autonomia-por-bloco).

Esta autorização não compra API/infra nem aporta capital. Operação real segue os gates e a ativação autenticada inicial do operador; não a execute em nome dele. Publicar código desabilitado está autorizado enquanto os gates estiverem pendentes.

## Contexto mínimo

- Leia o [protocolo](00-protocolo.md) e somente a emenda de autorização acima.
- Consulte a linha GJ12.1 e GJ09.3, GJ10.3, GJ02.4 no [estado](../../docs/roadmap/GANSO_JEV_EXECUTION_STATE.md); confirme contratos/commits disponíveis sem reler o histórico.
- Leia somente [GJ12 Qualificação técnica do motor](../../docs/roadmap/GANSO_JEV_IMPLEMENTATION_PLAN.md#gj12-qualificacao-tecnica-do-motor) do plano.
- Seções do PRD: [Qualificação e avaliação contínua](../../docs/PRD-GANSO-JEV.md#qualificacao-e-avaliacao-continua); [Dados capacidade e recuperação](../../docs/PRD-GANSO-JEV.md#dados-capacidade-e-recuperacao).

Localize os símbolos relevantes nestas entradas; abra apenas os trechos necessários. Módulos novos derivados do contrato são propostas, não funcionalidades existentes:

- [apps/api/src/storage/operational-readiness.ts](../../apps/api/src/storage/operational-readiness.ts)
- [apps/api/src/btc/runtime-diagnostics.ts](../../apps/api/src/btc/runtime-diagnostics.ts)
- [apps/api/src/storage/equity-history.ts](../../apps/api/src/storage/equity-history.ts)
- [apps/api/src/experiments-api.ts](../../apps/api/src/experiments-api.ts)

## Resultado e limite

Construir gate operacional que observe motor/worker, fontes, reconciliação, proteção, recursos e custo efetivo, distinguindo de health da API. Registrar período de qualificação/versão e interrupções recuperadas versus gap financeiro irrecuperável. Avaliar os sete dias no produto com evidência própria; amostragem de bordas de 15min não é comprovação. Confirmar admissão por carga/latência/usage reais quando cobertura existir.

Escolha detalhes técnicos rotineiros dentro do contrato e versione antes do experimento. Preserve trabalho alheio e contratos históricos. Alvo: 3–6 arquivos de lógica e uma migration aditiva; divida uma fronteira maior conforme o protocolo, sem declarar aceite parcial como concluído.

## Aceite

- Qualificação não nasce de fixture ou container Up.
- Mudança material/gap irrecuperável exige janela válida; recuperação permitida preserva evidência.
- Falta de tarifa/recurso bloqueia admissão, sem impedir publicação de código validado.

## Verificação

Readiness/SQL com timeline de interrupção, gaps internos, custo incerto, CPU/escrita insuficientes e reconciliação pendente. Execute testes proporcionais ao diff e checks exigidos na base reconciliada. SQL usa banco descartável; não produção. Fixture não comprova operação prospectiva.

## Publicação e gates

Publicar gate e telemetria; não rearmar/live nesta fatia. Revise o delta, publique PR, faça merge após checks e conclua o deploy aplicável. Verifique versão/saúde/persistência; para reversão, pause entradas, preserve proteção e use código compatível com o schema, sem apagar eventos.

Não há gate operacional adicional a cumprir para desenvolver esta sessão; permanecem os controles do protocolo. Observação pendente deve ser registrada, sem manter a sessão esperando.

## Fechamento

Atualize somente a linha GJ12.1 no estado: entrega, PR/SHA, validação observada e implantação/gate pendente. Se não houver delta, não crie PR vazio. Relate mudança, verificação e publicação ou bloqueio concreto; não invente teste/deploy/qualificação. Não execute o próximo prompt.
