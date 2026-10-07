---
id: GJ12.2
macro: GJ12
part: 2
depends_on: ["GJ12.1","GJ11.4"]
operational_gates: ["Readiness real GJ12.1 cumprida","Cobertura/tarifa JEV existentes e orçamento admitidos"]
mode: ativacao-paper
authorization: alteracoes-pr-merge-producao
tracking: docs/roadmap/GANSO_JEV_EXECUTION_STATE.md
context: uma-sessao-escopo-delimitado
---

# Admitir paper e iniciar observação técnica

Execute somente **GJ12.2**, parte 2 do bloco GJ12. Conclua o resultado abaixo e sua publicação aplicável; encerre sem iniciar outra sessão.

## Autorização explícita

Você está expressamente autorizado pelo proprietário a **alterar e implementar** o escopo desta sessão, criar branch `codex/`, commit/push, **criar e corrigir PR**, revisar o diff, acompanhar os checks obrigatórios, fazer **merge** após aprovação dos checks e proteções, e **publicar em produção** os componentes afetados. Inclui migrations aditivas, configuração e restart seletivo necessários. Prossiga sem pedir nova confirmação por etapa; respeite a [autorização registrada](../../docs/ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-jev-com-autonomia-por-bloco).

Esta autorização não compra API/infra nem aporta capital. Operação real segue os gates e a ativação autenticada inicial do operador; não a execute em nome dele. Publicar código desabilitado está autorizado enquanto os gates estiverem pendentes.

## Contexto mínimo

- Leia o [protocolo](00-protocolo.md) e somente a emenda de autorização acima.
- Consulte a linha GJ12.2 e GJ12.1, GJ11.4 no [estado](../../docs/roadmap/GANSO_JEV_EXECUTION_STATE.md); confirme contratos/commits disponíveis sem reler o histórico.
- Leia somente [GJ12 Qualificação técnica do motor](../../docs/roadmap/GANSO_JEV_IMPLEMENTATION_PLAN.md#gj12-qualificacao-tecnica-do-motor) do plano.
- Seções do PRD: [Qualificação e avaliação contínua](../../docs/PRD-GANSO-JEV.md#qualificacao-e-avaliacao-continua); [Dados capacidade e recuperação](../../docs/PRD-GANSO-JEV.md#dados-capacidade-e-recuperacao); [Resultados e custos](../../docs/PRD-GANSO-JEV.md#resultados-e-custos).

Localize os símbolos relevantes nestas entradas; abra apenas os trechos necessários. Módulos novos derivados do contrato são propostas, não funcionalidades existentes:

- [apps/api/src/storage/desk-worker.ts](../../apps/api/src/storage/desk-worker.ts)
- [apps/api/src/storage/operational-readiness.ts](../../apps/api/src/storage/operational-readiness.ts)
- [docker-compose.yml](../../docker-compose.yml)
- [docs/runbooks/btc-postgres-capacity.md](../../docs/runbooks/btc-postgres-capacity.md)

## Resultado e limite

Revalidar gates efetivos e cobertura JEV antes de iniciar o motor paper com três pares e geração por demanda. Ativação paper, restart seletivo e configuração estão autorizados neste escopo quando os gates forem cumpridos. Registrar início imutável da observação de sete dias; executar checagem breve de ciclo/proteção. Se faltar recurso/cobertura, publicar o que estiver validado e deixar ativação pendente.

Escolha detalhes técnicos rotineiros dentro do contrato e versione antes do experimento. Preserve trabalho alheio e contratos históricos. Alvo: 3–6 arquivos de lógica e uma migration aditiva; divida uma fronteira maior conforme o protocolo, sem declarar aceite parcial como concluído.

## Aceite

- Paper identificado e capital fictício correto; nenhum signer/live.
- Entradas só com frescor/reconciliação/custo/capacidade admitidos.
- Início real registrado; sessão termina observing sem dormir sete dias.

## Verificação

Checagem operacional breve de decisão/ordem/fill/fee/funding/proteção ou motivo de ausência; recursos e pool real verificados. Execute testes proporcionais ao diff e checks exigidos na base reconciliada. SQL usa banco descartável; não produção. Fixture não comprova operação prospectiva.

## Publicação e gates

Ativar somente paper admitido e manter monitoramento funcional do produto; sem contratar serviço ou criar agendamento Codex. Revise o delta, publique PR, faça merge após checks e conclua o deploy aplicável. Verifique versão/saúde/persistência; para reversão, pause entradas, preserve proteção e use código compatível com o schema, sem apagar eventos.

**Para operação efetiva:** Readiness real GJ12.1 cumprida; Cobertura/tarifa JEV existentes e orçamento admitidos. Esses gates não impedem desenvolvimento e publicação desabilitada.

## Fechamento

Atualize somente a linha GJ12.2 no estado: entrega, PR/SHA, validação observada e implantação/gate pendente. Se não houver delta, não crie PR vazio. Relate mudança, verificação e publicação ou bloqueio concreto; não invente teste/deploy/qualificação. Não execute o próximo prompt.
