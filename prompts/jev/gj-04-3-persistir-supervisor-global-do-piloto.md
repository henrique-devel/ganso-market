---
id: GJ04.3
macro: GJ04
part: 3
depends_on: ["GJ04.1","GJ01.3"]
operational_gates: []
mode: codigo
authorization: alteracoes-pr-merge-producao
tracking: docs/roadmap/GANSO_JEV_EXECUTION_STATE.md
context: uma-sessao-escopo-delimitado
---

# Persistir supervisor global do piloto

Execute somente **GJ04.3**, parte 3 do bloco GJ04. Conclua o resultado abaixo e sua publicação aplicável; encerre sem iniciar outra sessão.

## Autorização explícita

Você está expressamente autorizado pelo proprietário a **alterar e implementar** o escopo desta sessão, criar branch `codex/`, commit/push, **criar e corrigir PR**, revisar o diff, acompanhar os checks obrigatórios, fazer **merge** após aprovação dos checks e proteções, e **publicar em produção** os componentes afetados. Inclui migrations aditivas, configuração e restart seletivo necessários. Prossiga sem pedir nova confirmação por etapa; respeite a [autorização registrada](../../docs/ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-jev-com-autonomia-por-bloco).

Esta autorização não compra API/infra nem aporta capital. Operação real segue os gates e a ativação autenticada inicial do operador; não a execute em nome dele. Publicar código desabilitado está autorizado enquanto os gates estiverem pendentes.

## Contexto mínimo

- Leia o [protocolo](00-protocolo.md) e somente a emenda de autorização acima.
- Consulte a linha GJ04.3 e GJ04.1, GJ01.3 no [estado](../../docs/roadmap/GANSO_JEV_EXECUTION_STATE.md); confirme contratos/commits disponíveis sem reler o histórico.
- Leia somente [GJ04 Supervisor de risco e tamanho](../../docs/roadmap/GANSO_JEV_IMPLEMENTATION_PLAN.md#gj04-supervisor-de-risco-e-tamanho) do plano.
- Seções do PRD: [Risco e dimensionamento](../../docs/PRD-GANSO-JEV.md#risco-e-dimensionamento); [Sucessão e geração de propostas](../../docs/PRD-GANSO-JEV.md#sucessao-e-geracao-de-propostas).

Localize os símbolos relevantes nestas entradas; abra apenas os trechos necessários. Módulos novos derivados do contrato são propostas, não funcionalidades existentes:

- [apps/api/src/storage/riskstore.ts](../../apps/api/src/storage/riskstore.ts)
- [apps/api/src/storage/recoverystore.ts](../../apps/api/src/storage/recoverystore.ts)
- [apps/api/src/storage/ledgerstore.ts](../../apps/api/src/storage/ledgerstore.ts)
- [apps/api/src/storage/desk-commandstore.ts](../../apps/api/src/storage/desk-commandstore.ts)

## Resultado e limite

Criar estado duradouro do piloto com capital admitido, HWM global, bloqueio e comandos de ativação/rearme ainda sem executor. Estado atravessa perfis/experimentos; diário não destrava DD global. Definir prioridade e locks/fencing com eventos financeiros e futuro singleton live.

Escolha detalhes técnicos rotineiros dentro do contrato e versione antes do experimento. Preserve trabalho alheio e contratos históricos. Alvo: 3–6 arquivos de lógica e uma migration aditiva; divida uma fronteira maior conforme o protocolo, sem declarar aceite parcial como concluído.

## Aceite

- US$270 fixa piso US$257,50 e patrimônio não reseta em sucessão.
- Bloqueio global impede promoção/entrada até decisão explícita do operador.
- Paper/stress continuam cenários próprios, sem somar HWM ao piloto.

## Verificação

SQL concorrente para checkpoint, rearm, dupla promoção simulada, restart e mudança de perfil; nenhum envio à venue. Execute testes proporcionais ao diff e checks exigidos na base reconciliada. SQL usa banco descartável; não produção. Fixture não comprova operação prospectiva.

## Publicação e gates

Aplicar estado aditivo compatível e publicar supervisor global inativo para live. Revise o delta, publique PR, faça merge após checks e conclua o deploy aplicável. Verifique versão/saúde/persistência; para reversão, pause entradas, preserve proteção e use código compatível com o schema, sem apagar eventos.

Não há gate operacional adicional a cumprir para desenvolver esta sessão; permanecem os controles do protocolo. Observação pendente deve ser registrada, sem manter a sessão esperando.

## Fechamento

Atualize somente a linha GJ04.3 no estado: entrega, PR/SHA, validação observada e implantação/gate pendente. Se não houver delta, não crie PR vazio. Relate mudança, verificação e publicação ou bloqueio concreto; não invente teste/deploy/qualificação. Não execute o próximo prompt.
