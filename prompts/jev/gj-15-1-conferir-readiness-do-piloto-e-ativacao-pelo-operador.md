---
id: GJ15.1
macro: GJ15
part: 1
depends_on: ["GJ14.3","GJ13.5"]
operational_gates: ["GJ12.3 operational-qualified","GJ13.5 venue-verified","Elegibilidade paper/stress atual","Ativação autenticada do operador para operar"]
mode: observacao
authorization: alteracoes-pr-merge-producao
tracking: docs/roadmap/GANSO_JEV_EXECUTION_STATE.md
context: uma-sessao-escopo-delimitado
---

# Conferir readiness do piloto e ativação pelo operador

Execute somente **GJ15.1**, parte 1 do bloco GJ15. Conclua o resultado abaixo e sua publicação aplicável; encerre sem iniciar outra sessão.

## Autorização explícita

Você está expressamente autorizado pelo proprietário a **alterar e implementar** o escopo desta sessão, criar branch `codex/`, commit/push, **criar e corrigir PR**, revisar o diff, acompanhar os checks obrigatórios, fazer **merge** após aprovação dos checks e proteções, e **publicar em produção** os componentes afetados. Inclui migrations aditivas, configuração e restart seletivo necessários. Prossiga sem pedir nova confirmação por etapa; respeite a [autorização registrada](../../docs/ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-jev-com-autonomia-por-bloco).

Esta autorização não compra API/infra nem aporta capital. Operação real segue os gates e a ativação autenticada inicial do operador; não a execute em nome dele. Publicar código desabilitado está autorizado enquanto os gates estiverem pendentes.

## Contexto mínimo

- Leia o [protocolo](00-protocolo.md) e somente a emenda de autorização acima.
- Consulte a linha GJ15.1 e GJ14.3, GJ13.5 no [estado](../../docs/roadmap/GANSO_JEV_EXECUTION_STATE.md); confirme contratos/commits disponíveis sem reler o histórico.
- Leia somente [GJ15 Piloto observado e avaliação contínua](../../docs/roadmap/GANSO_JEV_IMPLEMENTATION_PLAN.md#gj15-piloto-observado-e-avaliacao-continua) do plano.
- Seções do PRD: [Qualificação e avaliação contínua](../../docs/PRD-GANSO-JEV.md#qualificacao-e-avaliacao-continua); [Painel e operação](../../docs/PRD-GANSO-JEV.md#painel-e-operacao); [Risco e dimensionamento](../../docs/PRD-GANSO-JEV.md#risco-e-dimensionamento).

Localize os símbolos relevantes nestas entradas; abra apenas os trechos necessários. Módulos novos derivados do contrato são propostas, não funcionalidades existentes:

- [apps/api/src/experiments-api.ts](../../apps/api/src/experiments-api.ts)
- [apps/api/src/storage/operational-readiness.ts](../../apps/api/src/storage/operational-readiness.ts)
- [apps/api/src/storage/riskstore.ts](../../apps/api/src/storage/riskstore.ts)
- [docs/roadmap/GANSO_JEV_EXECUTION_STATE.md](../../docs/roadmap/GANSO_JEV_EXECUTION_STATE.md)

## Resultado e limite

Conferir estados efetivos: motor e venue qualificados, perfil 60+60/99%/positivo após JEV, custos/risco/posição reconciliados e capital admitido. Preparar resultado pronto para o operador ou motivos pendentes. Reconhecer ativação somente se registrada por ação autenticada do operador; não efetuar clique, depósito ou habilitação em seu lugar.

Escolha detalhes técnicos rotineiros dentro do contrato e versione antes do experimento. Preserve trabalho alheio e contratos históricos. Alvo: 3–6 arquivos de lógica e uma migration aditiva; divida uma fronteira maior conforme o protocolo, sem declarar aceite parcial como concluído.

## Aceite

- Verificação usa fonte real/versões, sem converter fixture em autorização.
- Pronto para ativar é distinto de ativo.
- US$250 e limites originais permanecem; nenhum gasto/capital novo.

## Verificação

Leitura de gates, ledger, evidência paper/stress e ato de ativação; não aguardar amostra dentro da sessão. Execute testes proporcionais ao diff e checks exigidos na base reconciliada. SQL usa banco descartável; não produção. Fixture não comprova operação prospectiva.

## Publicação e gates

Publicar registro/correção delimitada; encerramento ready-for-operator/observing se faltar o ato ou gate. Revise o delta, publique PR, faça merge após checks e conclua o deploy aplicável. Verifique versão/saúde/persistência; para reversão, pause entradas, preserve proteção e use código compatível com o schema, sem apagar eventos.

**Para operação efetiva:** GJ12.3 operational-qualified; GJ13.5 venue-verified; Elegibilidade paper/stress atual; Ativação autenticada do operador para operar. Esses gates não impedem desenvolvimento e publicação desabilitada.

## Fechamento

Atualize somente a linha GJ15.1 no estado: entrega, PR/SHA, validação observada e implantação/gate pendente. Se não houver delta, não crie PR vazio. Relate mudança, verificação e publicação ou bloqueio concreto; não invente teste/deploy/qualificação. Não execute o próximo prompt.
