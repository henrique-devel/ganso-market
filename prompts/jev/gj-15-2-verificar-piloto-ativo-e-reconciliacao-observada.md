---
id: GJ15.2
macro: GJ15
part: 2
depends_on: ["GJ15.1"]
operational_gates: ["Piloto efetivamente ativado pelo operador e admitido"]
mode: observacao
authorization: alteracoes-pr-merge-producao
tracking: docs/roadmap/GANSO_JEV_EXECUTION_STATE.md
context: uma-sessao-escopo-delimitado
---

# Verificar piloto ativo e reconciliação observada

Execute somente **GJ15.2**, parte 2 do bloco GJ15. Conclua o resultado abaixo e sua publicação aplicável; encerre sem iniciar outra sessão.

## Autorização explícita

Você está expressamente autorizado pelo proprietário a **alterar e implementar** o escopo desta sessão, criar branch `codex/`, commit/push, **criar e corrigir PR**, revisar o diff, acompanhar os checks obrigatórios, fazer **merge** após aprovação dos checks e proteções, e **publicar em produção** os componentes afetados. Inclui migrations aditivas, configuração e restart seletivo necessários. Prossiga sem pedir nova confirmação por etapa; respeite a [autorização registrada](../../docs/ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-jev-com-autonomia-por-bloco).

Esta autorização não compra API/infra nem aporta capital. Operação real segue os gates e a ativação autenticada inicial do operador; não a execute em nome dele. Publicar código desabilitado está autorizado enquanto os gates estiverem pendentes.

## Contexto mínimo

- Leia o [protocolo](00-protocolo.md) e somente a emenda de autorização acima.
- Consulte a linha GJ15.2 e GJ15.1 no [estado](../../docs/roadmap/GANSO_JEV_EXECUTION_STATE.md); confirme contratos/commits disponíveis sem reler o histórico.
- Leia somente [GJ15 Piloto observado e avaliação contínua](../../docs/roadmap/GANSO_JEV_IMPLEMENTATION_PLAN.md#gj15-piloto-observado-e-avaliacao-continua) do plano.
- Seções do PRD: [Resultados e custos](../../docs/PRD-GANSO-JEV.md#resultados-e-custos); [Execução e proteção](../../docs/PRD-GANSO-JEV.md#execucao-e-protecao); [Risco e dimensionamento](../../docs/PRD-GANSO-JEV.md#risco-e-dimensionamento).

Localize os símbolos relevantes nestas entradas; abra apenas os trechos necessários. Módulos novos derivados do contrato são propostas, não funcionalidades existentes:

- [apps/api/src/storage/ledgerstore.ts](../../apps/api/src/storage/ledgerstore.ts)
- [apps/api/src/storage/fundingstore.ts](../../apps/api/src/storage/fundingstore.ts)
- [apps/api/src/storage/recoverystore.ts](../../apps/api/src/storage/recoverystore.ts)
- [apps/api/src/storage/riskstore.ts](../../apps/api/src/storage/riskstore.ts)

## Resultado e limite

Quando o piloto já estiver ativado e admitido, verificar um recorte breve das operações reais, fills/fees/funding, proteção, saldo e HWM. Comparar real/paper/stress sem misturar evidências. Corrigir defeito delimitado com pausa/reconciliação/rollout seguro; não abrir trade só para produzir prova, ampliar banca ou rearmar DD pelo agente.

Escolha detalhes técnicos rotineiros dentro do contrato e versione antes do experimento. Preserve trabalho alheio e contratos históricos. Alvo: 3–6 arquivos de lógica e uma migration aditiva; divida uma fronteira maior conforme o protocolo, sem declarar aceite parcial como concluído.

## Aceite

- Somente um live e capital efetivo preservado.
- Bloqueio/falha de proteção segue fluxo previsto.
- Ausência de trade/dado é registrada, sem lucro/fill inventado.

## Verificação

Reconciliar recibos/posições/proteção e custo efetivo; checks pertinentes se houver correção. Sem espera prolongada. Execute testes proporcionais ao diff e checks exigidos na base reconciliada. SQL usa banco descartável; não produção. Fixture não comprova operação prospectiva.

## Publicação e gates

Publicar correções do escopo e verificar seletivamente; registrar observing se ativação/amostra ainda faltar. Revise o delta, publique PR, faça merge após checks e conclua o deploy aplicável. Verifique versão/saúde/persistência; para reversão, pause entradas, preserve proteção e use código compatível com o schema, sem apagar eventos.

**Para operação efetiva:** Piloto efetivamente ativado pelo operador e admitido. Esses gates não impedem desenvolvimento e publicação desabilitada.

## Fechamento

Atualize somente a linha GJ15.2 no estado: entrega, PR/SHA, validação observada e implantação/gate pendente. Se não houver delta, não crie PR vazio. Relate mudança, verificação e publicação ou bloqueio concreto; não invente teste/deploy/qualificação. Não execute o próximo prompt.
