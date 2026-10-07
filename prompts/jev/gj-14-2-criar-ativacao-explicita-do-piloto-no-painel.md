---
id: GJ14.2
macro: GJ14
part: 2
depends_on: ["GJ14.1","GJ10.3"]
operational_gates: ["Gates de GJ14.1 cumpridos para habilitar ativação"]
mode: codigo
authorization: alteracoes-pr-merge-producao
tracking: docs/roadmap/GANSO_JEV_EXECUTION_STATE.md
context: uma-sessao-escopo-delimitado
---

# Criar ativação explícita do piloto no painel

Execute somente **GJ14.2**, parte 2 do bloco GJ14. Conclua o resultado abaixo e sua publicação aplicável; encerre sem iniciar outra sessão.

## Autorização explícita

Você está expressamente autorizado pelo proprietário a **alterar e implementar** o escopo desta sessão, criar branch `codex/`, commit/push, **criar e corrigir PR**, revisar o diff, acompanhar os checks obrigatórios, fazer **merge** após aprovação dos checks e proteções, e **publicar em produção** os componentes afetados. Inclui migrations aditivas, configuração e restart seletivo necessários. Prossiga sem pedir nova confirmação por etapa; respeite a [autorização registrada](../../docs/ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-jev-com-autonomia-por-bloco).

Esta autorização não compra API/infra nem aporta capital. Operação real segue os gates e a ativação autenticada inicial do operador; não a execute em nome dele. Publicar código desabilitado está autorizado enquanto os gates estiverem pendentes.

## Contexto mínimo

- Leia o [protocolo](00-protocolo.md) e somente a emenda de autorização acima.
- Consulte a linha GJ14.2 e GJ14.1, GJ10.3 no [estado](../../docs/roadmap/GANSO_JEV_EXECUTION_STATE.md); confirme contratos/commits disponíveis sem reler o histórico.
- Leia somente [GJ14 Ativação do piloto e sucessão](../../docs/roadmap/GANSO_JEV_IMPLEMENTATION_PLAN.md#gj14-ativacao-do-piloto-e-sucessao) do plano.
- Seções do PRD: [Painel e operação](../../docs/PRD-GANSO-JEV.md#painel-e-operacao); [Risco e dimensionamento](../../docs/PRD-GANSO-JEV.md#risco-e-dimensionamento).

Localize os símbolos relevantes nestas entradas; abra apenas os trechos necessários. Módulos novos derivados do contrato são propostas, não funcionalidades existentes:

- [apps/api/src/trading-commandapi.ts](../../apps/api/src/trading-commandapi.ts)
- [apps/api/src/storage/desk-commandstore.ts](../../apps/api/src/storage/desk-commandstore.ts)
- [apps/web/src/Experiments.tsx](../../apps/web/src/Experiments.tsx)
- [apps/api/src/experiments-api.ts](../../apps/api/src/experiments-api.ts)

## Resultado e limite

Disponibilizar ao operador controle autenticado/idempotente de ativação inicial US$250 e limites, com resultado dos gates e confirmação de patrimônio efetivo. Registrar ato humano e versão; rearm global após DD é nova decisão explícita. Não alterar assinatura/estado como se um clique tivesse ocorrido por deploy ou fixture.

Escolha detalhes técnicos rotineiros dentro do contrato e versione antes do experimento. Preserve trabalho alheio e contratos históricos. Alvo: 3–6 arquivos de lógica e uma migration aditiva; divida uma fronteira maior conforme o protocolo, sem declarar aceite parcial como concluído.

## Aceite

- Operador vê capital/risco e motivo de bloqueio antes de ativar.
- Configuração/credencial/PR não substitui ativação humana.
- Click duplicado não reinitializa banco/HWM ou cria outro live.

## Verificação

UI/API/SQL de ativação repetida, gate mudando durante clique, patrimônio inválido e DD global bloqueado. Execute testes proporcionais ao diff e checks exigidos na base reconciliada. SQL usa banco descartável; não produção. Fixture não comprova operação prospectiva.

## Publicação e gates

Publicar controle desabilitado quando gate faltar; verificar auth/DTO/bundle, sem ativar piloto nesta sessão. Revise o delta, publique PR, faça merge após checks e conclua o deploy aplicável. Verifique versão/saúde/persistência; para reversão, pause entradas, preserve proteção e use código compatível com o schema, sem apagar eventos.

**Para operação efetiva:** Gates de GJ14.1 cumpridos para habilitar ativação. Esses gates não impedem desenvolvimento e publicação desabilitada.

## Fechamento

Atualize somente a linha GJ14.2 no estado: entrega, PR/SHA, validação observada e implantação/gate pendente. Se não houver delta, não crie PR vazio. Relate mudança, verificação e publicação ou bloqueio concreto; não invente teste/deploy/qualificação. Não execute o próximo prompt.
