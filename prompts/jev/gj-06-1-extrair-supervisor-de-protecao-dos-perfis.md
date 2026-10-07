---
id: GJ06.1
macro: GJ06
part: 1
depends_on: ["GJ05.3","GJ04.3"]
operational_gates: []
mode: codigo
authorization: alteracoes-pr-merge-producao
tracking: docs/roadmap/GANSO_JEV_EXECUTION_STATE.md
context: uma-sessao-escopo-delimitado
---

# Extrair supervisor de proteção dos perfis

Execute somente **GJ06.1**, parte 1 do bloco GJ06. Conclua o resultado abaixo e sua publicação aplicável; encerre sem iniciar outra sessão.

## Autorização explícita

Você está expressamente autorizado pelo proprietário a **alterar e implementar** o escopo desta sessão, criar branch `codex/`, commit/push, **criar e corrigir PR**, revisar o diff, acompanhar os checks obrigatórios, fazer **merge** após aprovação dos checks e proteções, e **publicar em produção** os componentes afetados. Inclui migrations aditivas, configuração e restart seletivo necessários. Prossiga sem pedir nova confirmação por etapa; respeite a [autorização registrada](../../docs/ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-jev-com-autonomia-por-bloco).

Esta autorização não compra API/infra nem aporta capital. Operação real segue os gates e a ativação autenticada inicial do operador; não a execute em nome dele. Publicar código desabilitado está autorizado enquanto os gates estiverem pendentes.

## Contexto mínimo

- Leia o [protocolo](00-protocolo.md) e somente a emenda de autorização acima.
- Consulte a linha GJ06.1 e GJ05.3, GJ04.3 no [estado](../../docs/roadmap/GANSO_JEV_EXECUTION_STATE.md); confirme contratos/commits disponíveis sem reler o histórico.
- Leia somente [GJ06 Proteções e worker de execução](../../docs/roadmap/GANSO_JEV_IMPLEMENTATION_PLAN.md#gj06-protecoes-e-worker-de-execucao) do plano.
- Seções do PRD: [Execução e proteção](../../docs/PRD-GANSO-JEV.md#execucao-e-protecao); [Risco e dimensionamento](../../docs/PRD-GANSO-JEV.md#risco-e-dimensionamento).

Localize os símbolos relevantes nestas entradas; abra apenas os trechos necessários. Módulos novos derivados do contrato são propostas, não funcionalidades existentes:

- [apps/api/src/storage/baseline-exits.ts](../../apps/api/src/storage/baseline-exits.ts)
- [apps/api/src/storage/baseline-policy.ts](../../apps/api/src/storage/baseline-policy.ts)
- [apps/api/src/trading/strategies/baseline.ts](../../apps/api/src/trading/strategies/baseline.ts)
- [apps/api/src/storage/riskstore.ts](../../apps/api/src/storage/riskstore.ts)

## Resultado e limite

Extrair ATR/proteções sem reaproveitar sinal de entrada da baseline. Implementar stop 2ATR com mark-trigger para paper/stress, relógio 6h desde primeiro fill e saídas obrigatórias por risco. Remover trend exit da política nova; permitir close voluntário JEV subordinado à redução segura. Proteger desde a primeira parcial.

Escolha detalhes técnicos rotineiros dentro do contrato e versione antes do experimento. Preserve trabalho alheio e contratos históricos. Alvo: 3–6 arquivos de lógica e uma migration aditiva; divida uma fronteira maior conforme o protocolo, sem declarar aceite parcial como concluído.

## Aceite

- Proteção não depende de resposta JEV.
- Parcial/restart não renova prazo ou aumenta risco.
- Stop por mark diverge corretamente de bid/ask; sem TP/trailing.

## Verificação

Fixtures de primeiro fill, 6h, mark cruzando com bid/ask diferente, redução parcial e prioridade diária/global. Execute testes proporcionais ao diff e checks exigidos na base reconciliada. SQL usa banco descartável; não produção. Fixture não comprova operação prospectiva.

## Publicação e gates

Publicar supervisor compatível e validar antes de qualquer admissão de contas novas. Revise o delta, publique PR, faça merge após checks e conclua o deploy aplicável. Verifique versão/saúde/persistência; para reversão, pause entradas, preserve proteção e use código compatível com o schema, sem apagar eventos.

Não há gate operacional adicional a cumprir para desenvolver esta sessão; permanecem os controles do protocolo. Observação pendente deve ser registrada, sem manter a sessão esperando.

## Fechamento

Atualize somente a linha GJ06.1 no estado: entrega, PR/SHA, validação observada e implantação/gate pendente. Se não houver delta, não crie PR vazio. Relate mudança, verificação e publicação ou bloqueio concreto; não invente teste/deploy/qualificação. Não execute o próximo prompt.
