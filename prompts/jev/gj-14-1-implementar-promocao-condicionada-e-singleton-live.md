---
id: GJ14.1
macro: GJ14
part: 1
depends_on: ["GJ08.3","GJ12.1","GJ13.4"]
operational_gates: ["GJ12.3 com qualificação observada","GJ13.5 com validação da venue","Perfil elegível e ativação explícita do operador"]
mode: codigo
authorization: alteracoes-pr-merge-producao
tracking: docs/roadmap/GANSO_JEV_EXECUTION_STATE.md
context: uma-sessao-escopo-delimitado
---

# Implementar promoção condicionada e singleton live

Execute somente **GJ14.1**, parte 1 do bloco GJ14. Conclua o resultado abaixo e sua publicação aplicável; encerre sem iniciar outra sessão.

## Autorização explícita

Você está expressamente autorizado pelo proprietário a **alterar e implementar** o escopo desta sessão, criar branch `codex/`, commit/push, **criar e corrigir PR**, revisar o diff, acompanhar os checks obrigatórios, fazer **merge** após aprovação dos checks e proteções, e **publicar em produção** os componentes afetados. Inclui migrations aditivas, configuração e restart seletivo necessários. Prossiga sem pedir nova confirmação por etapa; respeite a [autorização registrada](../../docs/ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-jev-com-autonomia-por-bloco).

Esta autorização não compra API/infra nem aporta capital. Operação real segue os gates e a ativação autenticada inicial do operador; não a execute em nome dele. Publicar código desabilitado está autorizado enquanto os gates estiverem pendentes.

## Contexto mínimo

- Leia o [protocolo](00-protocolo.md) e somente a emenda de autorização acima.
- Consulte a linha GJ14.1 e GJ08.3, GJ12.1, GJ13.4 no [estado](../../docs/roadmap/GANSO_JEV_EXECUTION_STATE.md); confirme contratos/commits disponíveis sem reler o histórico.
- Leia somente [GJ14 Ativação do piloto e sucessão](../../docs/roadmap/GANSO_JEV_IMPLEMENTATION_PLAN.md#gj14-ativacao-do-piloto-e-sucessao) do plano.
- Seções do PRD: [Qualificação e avaliação contínua](../../docs/PRD-GANSO-JEV.md#qualificacao-e-avaliacao-continua); [Sucessão e geração de propostas](../../docs/PRD-GANSO-JEV.md#sucessao-e-geracao-de-propostas); [Risco e dimensionamento](../../docs/PRD-GANSO-JEV.md#risco-e-dimensionamento).

Localize os símbolos relevantes nestas entradas; abra apenas os trechos necessários. Módulos novos derivados do contrato são propostas, não funcionalidades existentes:

- [apps/api/src/storage/desk-worker.ts](../../apps/api/src/storage/desk-worker.ts)
- [apps/api/src/storage/ledgerstore.ts](../../apps/api/src/storage/ledgerstore.ts)
- [apps/api/src/storage/riskstore.ts](../../apps/api/src/storage/riskstore.ts)
- [apps/api/src/experiments-api.ts](../../apps/api/src/experiments-api.ts)

## Resultado e limite

Implementar decisão automática de promoção do primeiro perfil elegível, sem esperar os três, subordinada a motor/venue qualificados, 60+60/99%/custo/resultado conservador e piloto ativado pelo operador. Checar elegibilidade atual, singleton e patrimônio global sob transação. Publicar código mesmo enquanto observações forem pendentes, mantendo gate fechado.

Escolha detalhes técnicos rotineiros dentro do contrato e versione antes do experimento. Preserve trabalho alheio e contratos históricos. Alvo: 3–6 arquivos de lógica e uma migration aditiva; divida uma fronteira maior conforme o protocolo, sem declarar aceite parcial como concluído.

## Aceite

- Duas promoções concorrentes resultam em um live.
- Sem qualificação/ativação/custo completo nenhuma entrada real.
- Estado elegível não é ordem e não aumenta capital/caps.

## Verificação

SQL/fixtures de gates pendentes, stress reprovado, banco global bloqueado, dupla promoção e restart. Execute testes proporcionais ao diff e checks exigidos na base reconciliada. SQL usa banco descartável; não produção. Fixture não comprova operação prospectiva.

## Publicação e gates

Publicar controlador live desabilitado até gates operacionais, sem clique/ativação do operador em seu lugar. Revise o delta, publique PR, faça merge após checks e conclua o deploy aplicável. Verifique versão/saúde/persistência; para reversão, pause entradas, preserve proteção e use código compatível com o schema, sem apagar eventos.

**Para operação efetiva:** GJ12.3 com qualificação observada; GJ13.5 com validação da venue; Perfil elegível e ativação explícita do operador. Esses gates não impedem desenvolvimento e publicação desabilitada.

## Fechamento

Atualize somente a linha GJ14.1 no estado: entrega, PR/SHA, validação observada e implantação/gate pendente. Se não houver delta, não crie PR vazio. Relate mudança, verificação e publicação ou bloqueio concreto; não invente teste/deploy/qualificação. Não execute o próximo prompt.
