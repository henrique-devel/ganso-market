---
id: GJ08.3
macro: GJ08
part: 3
depends_on: ["GJ08.2"]
operational_gates: []
mode: codigo
authorization: alteracoes-pr-merge-producao
tracking: docs/roadmap/GANSO_JEV_EXECUTION_STATE.md
context: uma-sessao-escopo-delimitado
---

# Implementar avaliação rolling de 90 dias

Execute somente **GJ08.3**, parte 3 do bloco GJ08. Conclua o resultado abaixo e sua publicação aplicável; encerre sem iniciar outra sessão.

## Autorização explícita

Você está expressamente autorizado pelo proprietário a **alterar e implementar** o escopo desta sessão, criar branch `codex/`, commit/push, **criar e corrigir PR**, revisar o diff, acompanhar os checks obrigatórios, fazer **merge** após aprovação dos checks e proteções, e **publicar em produção** os componentes afetados. Inclui migrations aditivas, configuração e restart seletivo necessários. Prossiga sem pedir nova confirmação por etapa; respeite a [autorização registrada](../../docs/ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-jev-com-autonomia-por-bloco).

Esta autorização não compra API/infra nem aporta capital. Operação real segue os gates e a ativação autenticada inicial do operador; não a execute em nome dele. Publicar código desabilitado está autorizado enquanto os gates estiverem pendentes.

## Contexto mínimo

- Leia o [protocolo](00-protocolo.md) e somente a emenda de autorização acima.
- Consulte a linha GJ08.3 e GJ08.2 no [estado](../../docs/roadmap/GANSO_JEV_EXECUTION_STATE.md); confirme contratos/commits disponíveis sem reler o histórico.
- Leia somente [GJ08 Avaliador prospectivo e estados](../../docs/roadmap/GANSO_JEV_IMPLEMENTATION_PLAN.md#gj08-avaliador-prospectivo-e-estados) do plano.
- Seções do PRD: [Qualificação e avaliação contínua](../../docs/PRD-GANSO-JEV.md#qualificacao-e-avaliacao-continua); [Sucessão e geração de propostas](../../docs/PRD-GANSO-JEV.md#sucessao-e-geracao-de-propostas).

Localize os símbolos relevantes nestas entradas; abra apenas os trechos necessários. Módulos novos derivados do contrato são propostas, não funcionalidades existentes:

- [apps/api/src/storage/baseline-periods.ts](../../apps/api/src/storage/baseline-periods.ts)
- [apps/api/src/storage/metrics.ts](../../apps/api/src/storage/metrics.ts)
- [apps/api/src/storage/equity-replay.ts](../../apps/api/src/storage/equity-replay.ts)
- [apps/api/src/experiments-api.ts](../../apps/api/src/experiments-api.ts)

## Resultado e limite

Implementar ciclo de 90d e avaliação diária dos últimos 90d, após custos JEV completos, 99% e 60 episódios por conta. Margem completa 5pp sobre o melhor caixa/BTC = US$12,50 sobre referência US$250. Manter posição/patrimônio/benchmarks sem reset na borda; separar prévia 30d. Decisão automática de avaliação ocorre no produto, não numa tarefa Codex aguardando meses.

Escolha detalhes técnicos rotineiros dentro do contrato e versione antes do experimento. Preserve trabalho alheio e contratos históricos. Alvo: 3–6 arquivos de lógica e uma migration aditiva; divida uma fronteira maior conforme o protocolo, sem declarar aceite parcial como concluído.

## Aceite

- Paper ou stress reprovado reprova perfil; gap/custo/amostra insuficientes são inconclusivos.
- Janela completa não exige liquidação artificial.
- Avaliar versão não permite tuning retrospectivo ou troca de perfil saudável.

## Verificação

Recortes independentes, borda da janela, 90d incompletos, empate/margem, custos e reproof persistente. Execute testes proporcionais ao diff e checks exigidos na base reconciliada. SQL usa banco descartável; não produção. Fixture não comprova operação prospectiva.

## Publicação e gates

Publicar avaliador inicialmente subordinado à admissão do motor; observação 90d é etapa posterior. Revise o delta, publique PR, faça merge após checks e conclua o deploy aplicável. Verifique versão/saúde/persistência; para reversão, pause entradas, preserve proteção e use código compatível com o schema, sem apagar eventos.

Não há gate operacional adicional a cumprir para desenvolver esta sessão; permanecem os controles do protocolo. Observação pendente deve ser registrada, sem manter a sessão esperando.

## Fechamento

Atualize somente a linha GJ08.3 no estado: entrega, PR/SHA, validação observada e implantação/gate pendente. Se não houver delta, não crie PR vazio. Relate mudança, verificação e publicação ou bloqueio concreto; não invente teste/deploy/qualificação. Não execute o próximo prompt.
