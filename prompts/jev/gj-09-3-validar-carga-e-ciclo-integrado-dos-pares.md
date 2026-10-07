---
id: GJ09.3
macro: GJ09
part: 3
depends_on: ["GJ09.2","GJ02.4"]
operational_gates: []
mode: codigo
authorization: alteracoes-pr-merge-producao
tracking: docs/roadmap/GANSO_JEV_EXECUTION_STATE.md
context: uma-sessao-escopo-delimitado
---

# Validar carga e ciclo integrado dos pares

Execute somente **GJ09.3**, parte 3 do bloco GJ09. Conclua o resultado abaixo e sua publicação aplicável; encerre sem iniciar outra sessão.

## Autorização explícita

Você está expressamente autorizado pelo proprietário a **alterar e implementar** o escopo desta sessão, criar branch `codex/`, commit/push, **criar e corrigir PR**, revisar o diff, acompanhar os checks obrigatórios, fazer **merge** após aprovação dos checks e proteções, e **publicar em produção** os componentes afetados. Inclui migrations aditivas, configuração e restart seletivo necessários. Prossiga sem pedir nova confirmação por etapa; respeite a [autorização registrada](../../docs/ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-jev-com-autonomia-por-bloco).

Esta autorização não compra API/infra nem aporta capital. Operação real segue os gates e a ativação autenticada inicial do operador; não a execute em nome dele. Publicar código desabilitado está autorizado enquanto os gates estiverem pendentes.

## Contexto mínimo

- Leia o [protocolo](00-protocolo.md) e somente a emenda de autorização acima.
- Consulte a linha GJ09.3 e GJ09.2, GJ02.4 no [estado](../../docs/roadmap/GANSO_JEV_EXECUTION_STATE.md); confirme contratos/commits disponíveis sem reler o histórico.
- Leia somente [GJ09 Pares simultâneos e reservas](../../docs/roadmap/GANSO_JEV_IMPLEMENTATION_PLAN.md#gj09-pares-simultaneos-e-reservas) do plano.
- Seções do PRD: [Dados capacidade e recuperação](../../docs/PRD-GANSO-JEV.md#dados-capacidade-e-recuperacao); [Qualificação e avaliação contínua](../../docs/PRD-GANSO-JEV.md#qualificacao-e-avaliacao-continua).

Localize os símbolos relevantes nestas entradas; abra apenas os trechos necessários. Módulos novos derivados do contrato são propostas, não funcionalidades existentes:

- [apps/api/test/trading/acceptance.pg.test.ts](../../apps/api/test/trading/acceptance.pg.test.ts)
- [apps/api/test/trading/desk-consumer.pg.test.ts](../../apps/api/test/trading/desk-consumer.pg.test.ts)
- [apps/api/src/storage/operational-readiness.ts](../../apps/api/src/storage/operational-readiness.ts)
- [docker-compose.yml](../../docker-compose.yml)

## Resultado e limite

Validar ciclo integrado dos três pares com falhas relevantes, backlog/concurrency/CPU/escrita/pins e custo previsto. Instrumentar lacunas identificadas nos módulos afetados sem refatoração ampla. Ensaios de carga são delimitados e separados da evidência financeira prospectiva. Preparar limites de admissão real; não concluir sete dias nesta sessão.

Escolha detalhes técnicos rotineiros dentro do contrato e versione antes do experimento. Preserve trabalho alheio e contratos históricos. Alvo: 3–6 arquivos de lógica e uma migration aditiva; divida uma fronteira maior conforme o protocolo, sem declarar aceite parcial como concluído.

## Aceite

- Ciclo maker→parcial→proteção→close/funding/fees/replay fecha corretamente.
- Conta lenta/falha não bloqueia saídas das demais.
- Carga real não é admitida com custo/capacidade desconhecidos.

## Verificação

Aceite SQL independente, falha JEV, stale, perda de lease, recuperação e cenário de recursos insuficientes; checks exigidos pelo diff. Execute testes proporcionais ao diff e checks exigidos na base reconciliada. SQL usa banco descartável; não produção. Fixture não comprova operação prospectiva.

## Publicação e gates

Publicar correções/telemetria, inativo quando gate real faltar; ativação paper será GJ12.2. Revise o delta, publique PR, faça merge após checks e conclua o deploy aplicável. Verifique versão/saúde/persistência; para reversão, pause entradas, preserve proteção e use código compatível com o schema, sem apagar eventos.

Não há gate operacional adicional a cumprir para desenvolver esta sessão; permanecem os controles do protocolo. Observação pendente deve ser registrada, sem manter a sessão esperando.

## Fechamento

Atualize somente a linha GJ09.3 no estado: entrega, PR/SHA, validação observada e implantação/gate pendente. Se não houver delta, não crie PR vazio. Relate mudança, verificação e publicação ou bloqueio concreto; não invente teste/deploy/qualificação. Não execute o próximo prompt.
