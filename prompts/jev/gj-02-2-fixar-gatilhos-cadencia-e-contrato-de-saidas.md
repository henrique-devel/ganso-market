---
id: GJ02.2
macro: GJ02
part: 2
depends_on: ["GJ02.1"]
operational_gates: []
mode: codigo
authorization: alteracoes-pr-merge-producao
tracking: docs/roadmap/GANSO_JEV_EXECUTION_STATE.md
context: uma-sessao-escopo-delimitado
---

# Fixar gatilhos cadência e contrato de saídas

Execute somente **GJ02.2**, parte 2 do bloco GJ02. Conclua o resultado abaixo e sua publicação aplicável; encerre sem iniciar outra sessão.

## Autorização explícita

Você está expressamente autorizado pelo proprietário a **alterar e implementar** o escopo desta sessão, criar branch `codex/`, commit/push, **criar e corrigir PR**, revisar o diff, acompanhar os checks obrigatórios, fazer **merge** após aprovação dos checks e proteções, e **publicar em produção** os componentes afetados. Inclui migrations aditivas, configuração e restart seletivo necessários. Prossiga sem pedir nova confirmação por etapa; respeite a [autorização registrada](../../docs/ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-jev-com-autonomia-por-bloco).

Esta autorização não compra API/infra nem aporta capital. Operação real segue os gates e a ativação autenticada inicial do operador; não a execute em nome dele. Publicar código desabilitado está autorizado enquanto os gates estiverem pendentes.

## Contexto mínimo

- Leia o [protocolo](00-protocolo.md) e somente a emenda de autorização acima.
- Consulte a linha GJ02.2 e GJ02.1 no [estado](../../docs/roadmap/GANSO_JEV_EXECUTION_STATE.md); confirme contratos/commits disponíveis sem reler o histórico.
- Leia somente [GJ02 Manifestos contexto retenção e orçamento](../../docs/roadmap/GANSO_JEV_IMPLEMENTATION_PLAN.md#gj02-manifestos-contexto-retencao-e-orcamento) do plano.
- Seções do PRD: [Decisão JEV e supervisão independente](../../docs/PRD-GANSO-JEV.md#decisao-jev-e-supervisao-independente); [Risco e dimensionamento](../../docs/PRD-GANSO-JEV.md#risco-e-dimensionamento); [Detalhes a fixar antes dos experimentos](../../docs/PRD-GANSO-JEV.md#detalhes-a-fixar-antes-dos-experimentos).

Localize os símbolos relevantes nestas entradas; abra apenas os trechos necessários. Módulos novos derivados do contrato são propostas, não funcionalidades existentes:

- [apps/api/src/storage/baseline-manifest.ts](../../apps/api/src/storage/baseline-manifest.ts)
- [apps/api/src/storage/baseline-policy.ts](../../apps/api/src/storage/baseline-policy.ts)
- [apps/api/src/storage/baseline-exits.ts](../../apps/api/src/storage/baseline-exits.ts)
- [apps/api/src/trading/strategies/baseline.ts](../../apps/api/src/trading/strategies/baseline.ts)

## Resultado e limite

Versionar cadência padrão 60s e fast 2s somente com posição e gatilho de preço/risco. Fixar limiares ATR/proximidade do stop, permanência/cooldown, deadlines e limites de frescor. Definir âncora/arredondamento do stop 2ATR para parciais, prazo desde primeiro fill e faixas de variação do gerador. Resolver esses detalhes técnicos antes de dados prospectivos, preservando limites aprovados.

Escolha detalhes técnicos rotineiros dentro do contrato e versione antes do experimento. Preserve trabalho alheio e contratos históricos. Alvo: 3–6 arquivos de lógica e uma migration aditiva; divida uma fronteira maior conforme o protocolo, sem declarar aceite parcial como concluído.

## Aceite

- Sem fast por fluxo/liquidez ou conta sem posição.
- Alteração de parâmetro material muda versão, sem tuning durante janela.
- Stop/prazo/riscos não são variáveis do gerador.

## Verificação

Testes do contrato/manifesto e fronteiras de gatilho/frescor com relógio controlado; ainda sem scheduler de execução. Execute testes proporcionais ao diff e checks exigidos na base reconciliada. SQL usa banco descartável; não produção. Fixture não comprova operação prospectiva.

## Publicação e gates

Publicar contrato versionado inativo, compatível com consultas históricas. Revise o delta, publique PR, faça merge após checks e conclua o deploy aplicável. Verifique versão/saúde/persistência; para reversão, pause entradas, preserve proteção e use código compatível com o schema, sem apagar eventos.

Não há gate operacional adicional a cumprir para desenvolver esta sessão; permanecem os controles do protocolo. Observação pendente deve ser registrada, sem manter a sessão esperando.

## Fechamento

Atualize somente a linha GJ02.2 no estado: entrega, PR/SHA, validação observada e implantação/gate pendente. Se não houver delta, não crie PR vazio. Relate mudança, verificação e publicação ou bloqueio concreto; não invente teste/deploy/qualificação. Não execute o próximo prompt.
