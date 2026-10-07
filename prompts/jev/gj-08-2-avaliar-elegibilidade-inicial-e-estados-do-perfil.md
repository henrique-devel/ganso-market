---
id: GJ08.2
macro: GJ08
part: 2
depends_on: ["GJ08.1","GJ07.3","GJ04.3"]
operational_gates: []
mode: codigo
authorization: alteracoes-pr-merge-producao
tracking: docs/roadmap/GANSO_JEV_EXECUTION_STATE.md
context: uma-sessao-escopo-delimitado
---

# Avaliar elegibilidade inicial e estados do perfil

Execute somente **GJ08.2**, parte 2 do bloco GJ08. Conclua o resultado abaixo e sua publicação aplicável; encerre sem iniciar outra sessão.

## Autorização explícita

Você está expressamente autorizado pelo proprietário a **alterar e implementar** o escopo desta sessão, criar branch `codex/`, commit/push, **criar e corrigir PR**, revisar o diff, acompanhar os checks obrigatórios, fazer **merge** após aprovação dos checks e proteções, e **publicar em produção** os componentes afetados. Inclui migrations aditivas, configuração e restart seletivo necessários. Prossiga sem pedir nova confirmação por etapa; respeite a [autorização registrada](../../docs/ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-jev-com-autonomia-por-bloco).

Esta autorização não compra API/infra nem aporta capital. Operação real segue os gates e a ativação autenticada inicial do operador; não a execute em nome dele. Publicar código desabilitado está autorizado enquanto os gates estiverem pendentes.

## Contexto mínimo

- Leia o [protocolo](00-protocolo.md) e somente a emenda de autorização acima.
- Consulte a linha GJ08.2 e GJ08.1, GJ07.3, GJ04.3 no [estado](../../docs/roadmap/GANSO_JEV_EXECUTION_STATE.md); confirme contratos/commits disponíveis sem reler o histórico.
- Leia somente [GJ08 Avaliador prospectivo e estados](../../docs/roadmap/GANSO_JEV_IMPLEMENTATION_PLAN.md#gj08-avaliador-prospectivo-e-estados) do plano.
- Seções do PRD: [Qualificação e avaliação contínua](../../docs/PRD-GANSO-JEV.md#qualificacao-e-avaliacao-continua); [Sucessão e geração de propostas](../../docs/PRD-GANSO-JEV.md#sucessao-e-geracao-de-propostas).

Localize os símbolos relevantes nestas entradas; abra apenas os trechos necessários. Módulos novos derivados do contrato são propostas, não funcionalidades existentes:

- [apps/api/src/storage/metrics.ts](../../apps/api/src/storage/metrics.ts)
- [apps/api/src/storage/operational-readiness.ts](../../apps/api/src/storage/operational-readiness.ts)
- [apps/api/src/experiments-api.ts](../../apps/api/src/experiments-api.ts)
- [apps/api/src/storage/riskstore.ts](../../apps/api/src/storage/riskstore.ts)

## Resultado e limite

Implementar estados em validação/elegível/inconclusiva/reprovada e evidência inicial: 60 episódios em cada paper/stress, 99%, custos/reconciliação completos e resultado conservador positivo. Consumir contrato de qualificação do motor como gate separado inicialmente não cumprido. Falha comprovada de risco prevalece; insuficiência não vira reprovação econômica.

Escolha detalhes técnicos rotineiros dentro do contrato e versione antes do experimento. Preserve trabalho alheio e contratos históricos. Alvo: 3–6 arquivos de lógica e uma migration aditiva; divida uma fronteira maior conforme o protocolo, sem declarar aceite parcial como concluído.

## Aceite

- Amostra/custo incompletos não promovem.
- Benchmark visível não é hurdle inicial obrigatório.
- Alteração material não herda aprovação; estado não envia ordens.

## Verificação

Fronteiras 59/60, coverage, custo desconhecido, aberto positivo/negativo, stress reprovado e motor não qualificado. Execute testes proporcionais ao diff e checks exigidos na base reconciliada. SQL usa banco descartável; não produção. Fixture não comprova operação prospectiva.

## Publicação e gates

Publicar estados/DTO de elegibilidade; promoção operacional vem em GJ14. Revise o delta, publique PR, faça merge após checks e conclua o deploy aplicável. Verifique versão/saúde/persistência; para reversão, pause entradas, preserve proteção e use código compatível com o schema, sem apagar eventos.

Não há gate operacional adicional a cumprir para desenvolver esta sessão; permanecem os controles do protocolo. Observação pendente deve ser registrada, sem manter a sessão esperando.

## Fechamento

Atualize somente a linha GJ08.2 no estado: entrega, PR/SHA, validação observada e implantação/gate pendente. Se não houver delta, não crie PR vazio. Relate mudança, verificação e publicação ou bloqueio concreto; não invente teste/deploy/qualificação. Não execute o próximo prompt.
