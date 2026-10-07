---
id: GJ10.3
macro: GJ10
part: 3
depends_on: ["GJ10.2","GJ04.3"]
operational_gates: []
mode: codigo
authorization: alteracoes-pr-merge-producao
tracking: docs/roadmap/GANSO_JEV_EXECUTION_STATE.md
context: uma-sessao-escopo-delimitado
---

# Implementar controles de pausa e emergência

Execute somente **GJ10.3**, parte 3 do bloco GJ10. Conclua o resultado abaixo e sua publicação aplicável; encerre sem iniciar outra sessão.

## Autorização explícita

Você está expressamente autorizado pelo proprietário a **alterar e implementar** o escopo desta sessão, criar branch `codex/`, commit/push, **criar e corrigir PR**, revisar o diff, acompanhar os checks obrigatórios, fazer **merge** após aprovação dos checks e proteções, e **publicar em produção** os componentes afetados. Inclui migrations aditivas, configuração e restart seletivo necessários. Prossiga sem pedir nova confirmação por etapa; respeite a [autorização registrada](../../docs/ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-jev-com-autonomia-por-bloco).

Esta autorização não compra API/infra nem aporta capital. Operação real segue os gates e a ativação autenticada inicial do operador; não a execute em nome dele. Publicar código desabilitado está autorizado enquanto os gates estiverem pendentes.

## Contexto mínimo

- Leia o [protocolo](00-protocolo.md) e somente a emenda de autorização acima.
- Consulte a linha GJ10.3 e GJ10.2, GJ04.3 no [estado](../../docs/roadmap/GANSO_JEV_EXECUTION_STATE.md); confirme contratos/commits disponíveis sem reler o histórico.
- Leia somente [GJ10 Painel do operador](../../docs/roadmap/GANSO_JEV_IMPLEMENTATION_PLAN.md#gj10-painel-do-operador) do plano.
- Seções do PRD: [Painel e operação](../../docs/PRD-GANSO-JEV.md#painel-e-operacao); [Risco e dimensionamento](../../docs/PRD-GANSO-JEV.md#risco-e-dimensionamento).

Localize os símbolos relevantes nestas entradas; abra apenas os trechos necessários. Módulos novos derivados do contrato são propostas, não funcionalidades existentes:

- [apps/api/src/trading-commandapi.ts](../../apps/api/src/trading-commandapi.ts)
- [apps/api/src/storage/desk-commandstore.ts](../../apps/api/src/storage/desk-commandstore.ts)
- [apps/api/src/storage/desk-worker.ts](../../apps/api/src/storage/desk-worker.ts)
- [apps/web/src/BtcDesk.tsx](../../apps/web/src/BtcDesk.tsx)

## Resultado e limite

Implementar pausa/emergência idempotentes para contas/fluxo, com auditoria e passagem pelo supervisor/ownership. Cancelar entradas, solicitar redução e manter status pendente até reconciliação. UI mostra impacto na avaliação. Não incluir trade manual, edição de parâmetros ativos, aumento de capital ou ativação live neste controle.

Escolha detalhes técnicos rotineiros dentro do contrato e versione antes do experimento. Preserve trabalho alheio e contratos históricos. Alvo: 3–6 arquivos de lógica e uma migration aditiva; divida uma fronteira maior conforme o protocolo, sem declarar aceite parcial como concluído.

## Aceite

- Comando duplicado não duplica close/cancel.
- UI não declara flat por ACK sem fills/reconciliação.
- Auth/perímetro e evidência da intervenção permanecem.

## Verificação

Comandos concorrentes com JEV/fill/stop, erro de cancel e perda de resposta; testes backend SQL e UI. Execute testes proporcionais ao diff e checks exigidos na base reconciliada. SQL usa banco descartável; não produção. Fixture não comprova operação prospectiva.

## Publicação e gates

Publicar controles API/web/worker juntos por contrato compatível, verificar comando paper delimitado somente em conta admitida. Revise o delta, publique PR, faça merge após checks e conclua o deploy aplicável. Verifique versão/saúde/persistência; para reversão, pause entradas, preserve proteção e use código compatível com o schema, sem apagar eventos.

Não há gate operacional adicional a cumprir para desenvolver esta sessão; permanecem os controles do protocolo. Observação pendente deve ser registrada, sem manter a sessão esperando.

## Fechamento

Atualize somente a linha GJ10.3 no estado: entrega, PR/SHA, validação observada e implantação/gate pendente. Se não houver delta, não crie PR vazio. Relate mudança, verificação e publicação ou bloqueio concreto; não invente teste/deploy/qualificação. Não execute o próximo prompt.
