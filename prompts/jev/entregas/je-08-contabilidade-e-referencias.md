---
id: JE08
mode: entrega-agrupada
checkpoints: ["GJ07.1", "GJ07.2", "GJ07.3"]
depends_on: ["JE03", "JE07"]
operational_gates: []
authorization: alteracoes-pr-merge-producao
tracking: docs/roadmap/GANSO_JEV_EXECUTION_STATE.md
context: entrega-com-checkpoints
---

# JE08 — Contabilidade e referências

Execute integralmente **JE08**, incluindo todos os checkpoints abaixo, até revisão, PR, merge e publicação aplicável. Avance dentro do grupo sem novo pedido. Encerre após esta entrega, salvo sequência expressamente selecionada pelo proprietário. Preparar este arquivo não inicia sua execução.

## Resultado e dependências

Despesa real, custo conservador, PnL e benchmarks coerentes.

**Depende de código:** [JE03](je-03-retencao-e-viabilidade.md), [JE07](je-07-worker-e-cadencias.md). As dependências da entrega são resumidas transitivamente; os `depends_on` dos checkpoints continuam obrigatórios. Confirme dependências externas integradas ou já comprovadas na base. Dentro do grupo, um contrato validado na mesma branch libera a parte seguinte, sem PR intermediário. Preserve trabalho local alheio e reuse aceites já comprovados.

## Autorização e contexto

A [autorização JEV](../../../docs/ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-jev-com-autonomia-por-bloco) cobre alteração, migrations aditivas, branch `codex/`, commit/push, PR/correções, merge após revisão/checks/proteções e implantação seletiva de todo o grupo, sem reconfirmação por fase ou checkpoint. Compra de API/infra, aporte, ativação do signer/live pelo agente e alteração dos limites permanecem fora desse fluxo.

Leia uma vez o [protocolo](../00-protocolo.md), a emenda de autorização e as linhas do grupo/seus IDs no [estado](../../../docs/roadmap/GANSO_JEV_EXECUTION_STATE.md). Abra os checkpoints abaixo conforme a implementação avança; suas seções de contexto, resultado, aceite, verificação e gates são os contratos específicos. Consulte somente as seções necessárias do PRD/plano e símbolos do código. Não carregar todos os outros grupos nem reler contexto já disponível.

## Checkpoints na ordem interna

1. [GJ07.1 — Separar despesa real e custo de avaliação](../gj-07-1-separar-despesa-real-e-custo-de-avaliacao.md)
2. [GJ07.2 — Publicar PnL e resultado conservador](../gj-07-2-publicar-pnl-e-resultado-conservador.md)
3. [GJ07.3 — Construir referências caixa e BTC protegido](../gj-07-3-construir-referencias-caixa-e-btc-protegido.md)

Teste cada comportamento crítico quando for implementado, corrija a falha antes da parte dependente e continue no grupo. O tamanho segue a fronteira funcional; não dividir só por número de arquivos ou migrations. Se uma fronteira exigir entrega parcial segura, registre a continuação, mantenha a operação desativada e o grupo aberto. Não habilitar stub nem marcar aceite incompleto como concluído.

## Verificação integrada

Calcular trajetórias independentes com parciais, fees/funding/custo desconhecido e PnL aberto. Separar cobrança global única de custo integral do lote por conta; infraestrutura fica fora da aprovação.

Reaproveite as suítes existentes e execute testes específicos para o delta durante o trabalho. SQL exige PostgreSQL descartável. No fechamento, execute `make verify`, `make test-postgres` e checks exigidos na base reconciliada antes do merge; os checks obrigatórios de PR/main e a integração Compose permanecem. Não repetir a suíte completa entre checkpoints sem nova alteração/falha que justifique; não pular checks ou usar aprovação de revisão diferente como prova. JE01 sem delta de código registra a baseline e segue a dispensa de PR vazio/deploy por leitura ou texto.

## Publicação e gates operacionais

Prepare preferencialmente um PR coerente para o grupo, revise contratos/diff/segredos/compatibilidade, acompanhe checks, corrija, faça merge e publique os componentes afetados. Anexe todo PR criado à tarefa. Verifique versões, saúde, persistência e proteções; migrations aplicadas e eventos permanecem imutáveis. Reversão usa código compatível, pausa entradas e preserva proteção/reconciliação. Texto não exige reconstruir serviços.

Os gates abaixo condicionam **operação**, não a entrega de código desativado:

- Nenhum gate operacional adicional para desenvolver/publicar código desativado; os gates comuns do protocolo permanecem.

Admissão paper é GJ12.2; observação técnica é GJ12.3; ensaio externo da venue é GJ13.5; readiness/piloto/avaliação observados ficam em GJ15.1–3. Não executar essas etapas pela seleção desta entrega. Sete dias, 60 episódios e 90 dias não são substituídos por fixtures nem mantêm a sessão de código aguardando.

## Fechamento e retomada

Atualize somente a linha JE08 e seus checkpoints verificados no estado: PR/SHA compartilhado quando houver, validação resumida e implantação/gate pendente. Código publicado não equivale a qualificação, validação externa ou operação ativa. Registre reaproveitamento sem refazer código. Se interrompido, registre base/branch, contratos validados, delta, falhas e próximo checkpoint no registro existente; não exigir relatório, recibo ou pasta separados.

Relate resultado, validações observadas, publicação ou bloqueio concreto. Não iniciar outra entrega, chat, agente ou agendamento automaticamente.
