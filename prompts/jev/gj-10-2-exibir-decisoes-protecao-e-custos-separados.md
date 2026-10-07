---
id: GJ10.2
macro: GJ10
part: 2
depends_on: ["GJ10.1"]
operational_gates: []
mode: codigo
authorization: alteracoes-pr-merge-producao
tracking: docs/roadmap/GANSO_JEV_EXECUTION_STATE.md
context: uma-sessao-escopo-delimitado
---

# Exibir decisões proteção e custos separados

Execute somente **GJ10.2**, parte 2 do bloco GJ10. Conclua o resultado abaixo e sua publicação aplicável; encerre sem iniciar outra sessão.

## Autorização explícita

Você está expressamente autorizado pelo proprietário a **alterar e implementar** o escopo desta sessão, criar branch `codex/`, commit/push, **criar e corrigir PR**, revisar o diff, acompanhar os checks obrigatórios, fazer **merge** após aprovação dos checks e proteções, e **publicar em produção** os componentes afetados. Inclui migrations aditivas, configuração e restart seletivo necessários. Prossiga sem pedir nova confirmação por etapa; respeite a [autorização registrada](../../docs/ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-jev-com-autonomia-por-bloco).

Esta autorização não compra API/infra nem aporta capital. Operação real segue os gates e a ativação autenticada inicial do operador; não a execute em nome dele. Publicar código desabilitado está autorizado enquanto os gates estiverem pendentes.

## Contexto mínimo

- Leia o [protocolo](00-protocolo.md) e somente a emenda de autorização acima.
- Consulte a linha GJ10.2 e GJ10.1 no [estado](../../docs/roadmap/GANSO_JEV_EXECUTION_STATE.md); confirme contratos/commits disponíveis sem reler o histórico.
- Leia somente [GJ10 Painel do operador](../../docs/roadmap/GANSO_JEV_IMPLEMENTATION_PLAN.md#gj10-painel-do-operador) do plano.
- Seções do PRD: [Painel e operação](../../docs/PRD-GANSO-JEV.md#painel-e-operacao); [Resultados e custos](../../docs/PRD-GANSO-JEV.md#resultados-e-custos).

Localize os símbolos relevantes nestas entradas; abra apenas os trechos necessários. Módulos novos derivados do contrato são propostas, não funcionalidades existentes:

- [apps/web/src/Experiments.tsx](../../apps/web/src/Experiments.tsx)
- [apps/web/src/BtcOperations.tsx](../../apps/web/src/BtcOperations.tsx)
- [apps/web/src/btc-desk.css](../../apps/web/src/btc-desk.css)
- [apps/api/src/experiments-api.ts](../../apps/api/src/experiments-api.ts)

## Resultado e limite

Adicionar tape de decisão, versão, probabilidades diagnósticas/latência e motivo; ordens/fills/posição e estado real da proteção. Criar subgrupo de custos JEV, infraestrutura manual e despesa real total, distinguindo cobrança única de custo avaliativo por conta. Registro manual de infraestrutura usa backend autenticado/idempotente e não altera resultado.

Escolha detalhes técnicos rotineiros dentro do contrato e versione antes do experimento. Preserve trabalho alheio e contratos históricos. Alvo: 3–6 arquivos de lógica e uma migration aditiva; divida uma fronteira maior conforme o protocolo, sem declarar aceite parcial como concluído.

## Aceite

- Operador entende o que ocorreu automaticamente e o que está pendente.
- Infra nunca entra em hurdle/PnL da estratégia.
- Resumo JEV capturado não é apresentado como fatura completa se houver lacuna.

## Verificação

Estados known/unknown, requests compartilhados, erro provider, proteção sem ACK e componentes responsivos; teste de gravação manual autorizado. Execute testes proporcionais ao diff e checks exigidos na base reconciliada. SQL usa banco descartável; não produção. Fixture não comprova operação prospectiva.

## Publicação e gates

Publicar backend/web compatíveis e verificar leitura/escrita autenticada; sem fatura automática ou mensagem externa. Revise o delta, publique PR, faça merge após checks e conclua o deploy aplicável. Verifique versão/saúde/persistência; para reversão, pause entradas, preserve proteção e use código compatível com o schema, sem apagar eventos.

Não há gate operacional adicional a cumprir para desenvolver esta sessão; permanecem os controles do protocolo. Observação pendente deve ser registrada, sem manter a sessão esperando.

## Fechamento

Atualize somente a linha GJ10.2 no estado: entrega, PR/SHA, validação observada e implantação/gate pendente. Se não houver delta, não crie PR vazio. Relate mudança, verificação e publicação ou bloqueio concreto; não invente teste/deploy/qualificação. Não execute o próximo prompt.
