---
id: GJ15.3
macro: GJ15
part: 3
depends_on: ["GJ08.3","GJ11.4","GJ15.1"]
operational_gates: []
mode: observacao
authorization: alteracoes-pr-merge-producao
tracking: docs/roadmap/GANSO_JEV_EXECUTION_STATE.md
context: uma-sessao-escopo-delimitado
---

# Verificar avaliação contínua e janela completa

Execute somente **GJ15.3**, parte 3 do bloco GJ15. Conclua o resultado abaixo e sua publicação aplicável; encerre sem iniciar outra sessão.

## Autorização explícita

Você está expressamente autorizado pelo proprietário a **alterar e implementar** o escopo desta sessão, criar branch `codex/`, commit/push, **criar e corrigir PR**, revisar o diff, acompanhar os checks obrigatórios, fazer **merge** após aprovação dos checks e proteções, e **publicar em produção** os componentes afetados. Inclui migrations aditivas, configuração e restart seletivo necessários. Prossiga sem pedir nova confirmação por etapa; respeite a [autorização registrada](../../docs/ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-jev-com-autonomia-por-bloco).

Esta autorização não compra API/infra nem aporta capital. Operação real segue os gates e a ativação autenticada inicial do operador; não a execute em nome dele. Publicar código desabilitado está autorizado enquanto os gates estiverem pendentes.

## Contexto mínimo

- Leia o [protocolo](00-protocolo.md) e somente a emenda de autorização acima.
- Consulte a linha GJ15.3 e GJ08.3, GJ11.4, GJ15.1 no [estado](../../docs/roadmap/GANSO_JEV_EXECUTION_STATE.md); confirme contratos/commits disponíveis sem reler o histórico.
- Leia somente [GJ15 Piloto observado e avaliação contínua](../../docs/roadmap/GANSO_JEV_IMPLEMENTATION_PLAN.md#gj15-piloto-observado-e-avaliacao-continua) do plano.
- Seções do PRD: [Qualificação e avaliação contínua](../../docs/PRD-GANSO-JEV.md#qualificacao-e-avaliacao-continua); [Sucessão e geração de propostas](../../docs/PRD-GANSO-JEV.md#sucessao-e-geracao-de-propostas); [Resultados e custos](../../docs/PRD-GANSO-JEV.md#resultados-e-custos).

Localize os símbolos relevantes nestas entradas; abra apenas os trechos necessários. Módulos novos derivados do contrato são propostas, não funcionalidades existentes:

- [apps/api/src/storage/metrics.ts](../../apps/api/src/storage/metrics.ts)
- [apps/api/src/storage/equity-replay.ts](../../apps/api/src/storage/equity-replay.ts)
- [apps/api/src/experiments-api.ts](../../apps/api/src/experiments-api.ts)
- [docs/roadmap/GANSO_JEV_EXECUTION_STATE.md](../../docs/roadmap/GANSO_JEV_EXECUTION_STATE.md)

## Resultado e limite

Consultar resultados contínuos de paper/stress/live e o avaliador rolling. Fechar avaliação completa só com 90d/99%/60 episódios por conta, custos JEV completos e margin 5pp sobre melhor benchmark. Se faltar tempo/dado, registrar observing/inconclusivo e condição para próxima leitura; sem esperar 90d nesta sessão, tuning ou agendamento automático.

Escolha detalhes técnicos rotineiros dentro do contrato e versione antes do experimento. Preserve trabalho alheio e contratos históricos. Alvo: 3–6 arquivos de lógica e uma migration aditiva; divida uma fronteira maior conforme o protocolo, sem declarar aceite parcial como concluído.

## Aceite

- Risk failure prevalece sobre amostra insuficiente.
- Infra não volta ao hurdle aos 90d.
- Reprovação preserva evidência e não força troca de perfil saudável por melhor reserva.

## Verificação

Conferir recorte, versões, custos/referências, episódios e motivos; corrigir divergência delimitada antes de afirmar resultado. Execute testes proporcionais ao diff e checks exigidos na base reconciliada. SQL usa banco descartável; não produção. Fixture não comprova operação prospectiva.

## Publicação e gates

Publicar registro/ajuste compatível e verificar componente afetado; sem escalar capital/moedas ou resetar avaliação. Revise o delta, publique PR, faça merge após checks e conclua o deploy aplicável. Verifique versão/saúde/persistência; para reversão, pause entradas, preserve proteção e use código compatível com o schema, sem apagar eventos.

Não há gate operacional adicional a cumprir para desenvolver esta sessão; permanecem os controles do protocolo. Observação pendente deve ser registrada, sem manter a sessão esperando.

## Fechamento

Atualize somente a linha GJ15.3 no estado: entrega, PR/SHA, validação observada e implantação/gate pendente. Se não houver delta, não crie PR vazio. Relate mudança, verificação e publicação ou bloqueio concreto; não invente teste/deploy/qualificação. Não execute o próximo prompt.
