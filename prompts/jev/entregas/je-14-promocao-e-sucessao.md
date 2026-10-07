---
id: JE14
mode: entrega-agrupada
checkpoints: ["GJ14.1", "GJ14.2", "GJ14.3"]
depends_on: ["JE12", "JE13"]
operational_gates: ["GJ12.3 com qualificação observada", "GJ13.5 com validação da venue", "Perfil elegível e ativação explícita do operador", "Gates de GJ14.1 cumpridos para habilitar ativação", "Piloto ativado e gates efetivos válidos"]
authorization: alteracoes-pr-merge-producao
tracking: docs/roadmap/GANSO_JEV_EXECUTION_STATE.md
context: entrega-com-checkpoints
---

# JE14 — Promoção e sucessão

Execute integralmente **JE14**, incluindo todos os checkpoints abaixo, até revisão, PR, merge e publicação aplicável. Avance dentro do grupo sem novo pedido. Encerre após esta entrega, salvo sequência expressamente selecionada pelo proprietário. Preparar este arquivo não inicia sua execução.

## Resultado e dependências

Ativação autenticada condicionada e sucessão live implementadas.

**Depende de código:** [JE12](je-12-gerador-e-fila.md), [JE13](je-13-adaptador-live-e-protecao-nativa.md). As dependências da entrega são resumidas transitivamente; os `depends_on` dos checkpoints continuam obrigatórios. Confirme dependências externas integradas ou já comprovadas na base. Dentro do grupo, um contrato validado na mesma branch libera a parte seguinte, sem PR intermediário. Preserve trabalho local alheio e reuse aceites já comprovados.

## Autorização e contexto

A [autorização JEV](../../../docs/ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-jev-com-autonomia-por-bloco) cobre alteração, migrations aditivas, branch `codex/`, commit/push, PR/correções, merge após revisão/checks/proteções e implantação seletiva de todo o grupo, sem reconfirmação por fase ou checkpoint. Compra de API/infra, aporte, ativação do signer/live pelo agente e alteração dos limites permanecem fora desse fluxo.

Leia uma vez o [protocolo](../00-protocolo.md), a emenda de autorização e as linhas do grupo/seus IDs no [estado](../../../docs/roadmap/GANSO_JEV_EXECUTION_STATE.md). Abra os checkpoints abaixo conforme a implementação avança; suas seções de contexto, resultado, aceite, verificação e gates são os contratos específicos. Consulte somente as seções necessárias do PRD/plano e símbolos do código. Não carregar todos os outros grupos nem reler contexto já disponível.

## Checkpoints na ordem interna

1. [GJ14.1 — Implementar promoção condicionada e singleton live](../gj-14-1-implementar-promocao-condicionada-e-singleton-live.md)
2. [GJ14.2 — Criar ativação explícita do piloto no painel](../gj-14-2-criar-ativacao-explicita-do-piloto-no-painel.md)
3. [GJ14.3 — Implementar sucessão live somente por reprovação](../gj-14-3-implementar-sucessao-live-somente-por-reprovacao.md)

Teste cada comportamento crítico quando for implementado, corrija a falha antes da parte dependente e continue no grupo. O tamanho segue a fronteira funcional; não dividir só por número de arquivos ou migrations. Se uma fronteira exigir entrega parcial segura, registre a continuação, mantenha a operação desativada e o grupo aberto. Não habilitar stub nem marcar aceite incompleto como concluído.

## Verificação integrada

Cobrir gates fechados, promoções concorrentes, singleton, patrimônio/HWM persistentes e encerramento antes da sucessora. Código pode ser publicado desativado enquanto GJ12.3/GJ13.5/elegibilidade/ato do operador estiverem pendentes.

Reaproveite as suítes existentes e execute testes específicos para o delta durante o trabalho. SQL exige PostgreSQL descartável. No fechamento, execute `make verify`, `make test-postgres` e checks exigidos na base reconciliada antes do merge; os checks obrigatórios de PR/main e a integração Compose permanecem. Não repetir a suíte completa entre checkpoints sem nova alteração/falha que justifique; não pular checks ou usar aprovação de revisão diferente como prova. JE01 sem delta de código registra a baseline e segue a dispensa de PR vazio/deploy por leitura ou texto.

## Publicação e gates operacionais

Prepare preferencialmente um PR coerente para o grupo, revise contratos/diff/segredos/compatibilidade, acompanhe checks, corrija, faça merge e publique os componentes afetados. Anexe todo PR criado à tarefa. Verifique versões, saúde, persistência e proteções; migrations aplicadas e eventos permanecem imutáveis. Reversão usa código compatível, pausa entradas e preserva proteção/reconciliação. Texto não exige reconstruir serviços.

Os gates abaixo condicionam **operação**, não a entrega de código desativado:

- GJ12.3 com qualificação observada
- GJ13.5 com validação da venue
- Perfil elegível e ativação explícita do operador
- Gates de GJ14.1 cumpridos para habilitar ativação
- Piloto ativado e gates efetivos válidos

Admissão paper é GJ12.2; observação técnica é GJ12.3; ensaio externo da venue é GJ13.5; readiness/piloto/avaliação observados ficam em GJ15.1–3. Não executar essas etapas pela seleção desta entrega. Sete dias, 60 episódios e 90 dias não são substituídos por fixtures nem mantêm a sessão de código aguardando.

## Fechamento e retomada

Atualize somente a linha JE14 e seus checkpoints verificados no estado: PR/SHA compartilhado quando houver, validação resumida e implantação/gate pendente. Código publicado não equivale a qualificação, validação externa ou operação ativa. Registre reaproveitamento sem refazer código. Se interrompido, registre base/branch, contratos validados, delta, falhas e próximo checkpoint no registro existente; não exigir relatório, recibo ou pasta separados.

Relate resultado, validações observadas, publicação ou bloqueio concreto. Não iniciar outra entrega, chat, agente ou agendamento automaticamente.
