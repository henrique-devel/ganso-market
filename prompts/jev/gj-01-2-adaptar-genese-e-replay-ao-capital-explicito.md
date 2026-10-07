---
id: GJ01.2
macro: GJ01
part: 2
depends_on: ["GJ01.1"]
operational_gates: []
mode: codigo
authorization: alteracoes-pr-merge-producao
tracking: docs/roadmap/GANSO_JEV_EXECUTION_STATE.md
context: uma-sessao-escopo-delimitado
---

# Adaptar gênese e replay ao capital explícito

Execute somente **GJ01.2**, parte 2 do bloco GJ01. Conclua o resultado abaixo e sua publicação aplicável; encerre sem iniciar outra sessão.

## Autorização explícita

Você está expressamente autorizado pelo proprietário a **alterar e implementar** o escopo desta sessão, criar branch `codex/`, commit/push, **criar e corrigir PR**, revisar o diff, acompanhar os checks obrigatórios, fazer **merge** após aprovação dos checks e proteções, e **publicar em produção** os componentes afetados. Inclui migrations aditivas, configuração e restart seletivo necessários. Prossiga sem pedir nova confirmação por etapa; respeite a [autorização registrada](../../docs/ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-jev-com-autonomia-por-bloco).

Esta autorização não compra API/infra nem aporta capital. Operação real segue os gates e a ativação autenticada inicial do operador; não a execute em nome dele. Publicar código desabilitado está autorizado enquanto os gates estiverem pendentes.

## Contexto mínimo

- Leia o [protocolo](00-protocolo.md) e somente a emenda de autorização acima.
- Consulte a linha GJ01.2 e GJ01.1 no [estado](../../docs/roadmap/GANSO_JEV_EXECUTION_STATE.md); confirme contratos/commits disponíveis sem reler o histórico.
- Leia somente [GJ01 Contratos de contas perfis e capital](../../docs/roadmap/GANSO_JEV_IMPLEMENTATION_PLAN.md#gj01-contratos-de-contas-perfis-e-capital) do plano.
- Seções do PRD: [Produto e contas](../../docs/PRD-GANSO-JEV.md#produto-e-contas); [Dados capacidade e recuperação](../../docs/PRD-GANSO-JEV.md#dados-capacidade-e-recuperacao).

Localize os símbolos relevantes nestas entradas; abra apenas os trechos necessários. Módulos novos derivados do contrato são propostas, não funcionalidades existentes:

- [apps/api/src/trading/ledger.ts](../../apps/api/src/trading/ledger.ts)
- [apps/api/src/storage/ledgerstore.ts](../../apps/api/src/storage/ledgerstore.ts)
- [apps/api/src/storage/ledger-contract.ts](../../apps/api/src/storage/ledger-contract.ts)
- [apps/api/src/storage/replay-dataset.ts](../../apps/api/src/storage/replay-dataset.ts)
- [migrations/0029_btc_account_ledger.sql](../../migrations/0029_btc_account_ledger.sql)

## Resultado e limite

Introduzir capital explícito de US$250 nas contas novas e manter replay das gêneses v1 US$1.000. Separar vida da conta e janela experimental. Atribuir perfil a eventos sem alterar ownership histórico. Se necessário, criar uma migration aditiva compatível; a 0029 serve como referência e não pode ser editada.

Escolha detalhes técnicos rotineiros dentro do contrato e versione antes do experimento. Preserve trabalho alheio e contratos históricos. Alvo: 3–6 arquivos de lógica e uma migration aditiva; divida uma fronteira maior conforme o protocolo, sem declarar aceite parcial como concluído.

## Aceite

- Gênese idempotente e resultados antigos preservados.
- Replay v2 respeita capital e dono sem reset em recortes.
- Troca futura de perfil live não fabrica novo depósito de US$250.

## Verificação

Ledger/replay com fixtures independentes; PostgreSQL descartável para duplicação, rollback, ownership e compatibilidade. Execute testes proporcionais ao diff e checks exigidos na base reconciliada. SQL usa banco descartável; não produção. Fixture não comprova operação prospectiva.

## Publicação e gates

Aplicar migration nova antes dos leitores/escritores afetados; publicar ledger/replay sem admitir negociação nova. Revise o delta, publique PR, faça merge após checks e conclua o deploy aplicável. Verifique versão/saúde/persistência; para reversão, pause entradas, preserve proteção e use código compatível com o schema, sem apagar eventos.

Não há gate operacional adicional a cumprir para desenvolver esta sessão; permanecem os controles do protocolo. Observação pendente deve ser registrada, sem manter a sessão esperando.

## Fechamento

Atualize somente a linha GJ01.2 no estado: entrega, PR/SHA, validação observada e implantação/gate pendente. Se não houver delta, não crie PR vazio. Relate mudança, verificação e publicação ou bloqueio concreto; não invente teste/deploy/qualificação. Não execute o próximo prompt.
