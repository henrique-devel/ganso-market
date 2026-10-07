---
id: GJ12.3
macro: GJ12
part: 3
depends_on: ["GJ12.2"]
operational_gates: []
mode: observacao
authorization: alteracoes-pr-merge-producao
tracking: docs/roadmap/GANSO_JEV_EXECUTION_STATE.md
context: etapa-operacional-separada
---

# Verificar qualificação observada do motor

Execute somente **GJ12.3**, parte 3 do bloco GJ12. Conclua o resultado abaixo e sua publicação aplicável; encerre sem iniciar outra sessão.

## Autorização explícita

Você está expressamente autorizado pelo proprietário a **alterar e implementar** o escopo desta sessão, criar branch `codex/`, commit/push, **criar e corrigir PR**, revisar o diff, acompanhar os checks obrigatórios, fazer **merge** após aprovação dos checks e proteções, e **publicar em produção** os componentes afetados. Inclui migrations aditivas, configuração e restart seletivo necessários. Prossiga sem pedir nova confirmação por etapa; respeite a [autorização registrada](../../docs/ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-jev-com-autonomia-por-bloco).

Esta autorização não compra API/infra nem aporta capital. Operação real segue os gates e a ativação autenticada inicial do operador; não a execute em nome dele. Publicar código desabilitado está autorizado enquanto os gates estiverem pendentes.

## Contexto mínimo

- Leia o [protocolo](00-protocolo.md) e somente a emenda de autorização acima.
- Consulte a linha GJ12.3 e GJ12.2 no [estado](../../docs/roadmap/GANSO_JEV_EXECUTION_STATE.md); confirme contratos/commits disponíveis sem reler o histórico.
- Leia somente [GJ12 Qualificação técnica do motor](../../docs/roadmap/GANSO_JEV_IMPLEMENTATION_PLAN.md#gj12-qualificacao-tecnica-do-motor) do plano.
- Seções do PRD: [Qualificação e avaliação contínua](../../docs/PRD-GANSO-JEV.md#qualificacao-e-avaliacao-continua); [Dados capacidade e recuperação](../../docs/PRD-GANSO-JEV.md#dados-capacidade-e-recuperacao).

Localize os símbolos relevantes nestas entradas; abra apenas os trechos necessários. Módulos novos derivados do contrato são propostas, não funcionalidades existentes:

- [apps/api/src/storage/operational-readiness.ts](../../apps/api/src/storage/operational-readiness.ts)
- [apps/api/src/experiments-api.ts](../../apps/api/src/experiments-api.ts)
- [docs/roadmap/GANSO_JEV_EXECUTION_STATE.md](../../docs/roadmap/GANSO_JEV_EXECUTION_STATE.md)

## Resultado e limite

Consultar a janela real e fechar qualificação somente com sete dias válidos, riscos/recuperação exercitados, capacidade/custos conhecidos e reconciliação. Recuperação permitida sem lacuna não apaga histórico. Se prazo/amostra faltar, registrar observing e data/condição mínima de nova avaliação; não manter sessão aguardando nem criar agendamento sem pedido. Correção material recebe subfatia e novo período conforme contrato.

Escolha detalhes técnicos rotineiros dentro do contrato e versione antes do experimento. Preserve trabalho alheio e contratos históricos. Dimensione pela fronteira funcional, sem limite fixo de arquivos ou migrations aditivas. Valide o comportamento afetado antes de avançar à parte dependente; não declare aceite parcial como concluído.

## Aceite

- Resultado observado separa qualificado/observing/falha.
- Fixtures não contam como 60 episódios prospectivos.
- Nenhuma elegibilidade live é inferida de retorno positivo isolado.

## Verificação

Leitura de timeline/versões, cobertura, custos, ledger, erros e checkpoints; reconciliar qualquer divergência antes de afirmar qualificação. Execute testes proporcionais ao diff e checks exigidos na base reconciliada. SQL usa banco descartável; não produção. Fixture não comprova operação prospectiva.

## Publicação e gates

Publicar registro resumido/ajustes delimitados; qualificar motor não ativa piloto. Revise o delta, publique PR, faça merge após checks e conclua o deploy aplicável. Verifique versão/saúde/persistência; para reversão, pause entradas, preserve proteção e use código compatível com o schema, sem apagar eventos.

Não há gate operacional adicional a cumprir para desenvolver esta sessão; permanecem os controles do protocolo. Observação pendente deve ser registrada, sem manter a sessão esperando.

## Fechamento

Atualize somente a linha GJ12.3 no estado: entrega, PR/SHA, validação observada e implantação/gate pendente. Se não houver delta, não crie PR vazio. Relate mudança, verificação e publicação ou bloqueio concreto; não invente teste/deploy/qualificação. Não execute o próximo prompt.
