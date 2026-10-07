---
id: GJ14.3
macro: GJ14
part: 3
depends_on: ["GJ14.2","GJ11.4"]
operational_gates: ["Piloto ativado e gates efetivos válidos"]
mode: codigo
authorization: alteracoes-pr-merge-producao
tracking: docs/roadmap/GANSO_JEV_EXECUTION_STATE.md
context: uma-sessao-escopo-delimitado
---

# Implementar sucessão live somente por reprovação

Execute somente **GJ14.3**, parte 3 do bloco GJ14. Conclua o resultado abaixo e sua publicação aplicável; encerre sem iniciar outra sessão.

## Autorização explícita

Você está expressamente autorizado pelo proprietário a **alterar e implementar** o escopo desta sessão, criar branch `codex/`, commit/push, **criar e corrigir PR**, revisar o diff, acompanhar os checks obrigatórios, fazer **merge** após aprovação dos checks e proteções, e **publicar em produção** os componentes afetados. Inclui migrations aditivas, configuração e restart seletivo necessários. Prossiga sem pedir nova confirmação por etapa; respeite a [autorização registrada](../../docs/ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-jev-com-autonomia-por-bloco).

Esta autorização não compra API/infra nem aporta capital. Operação real segue os gates e a ativação autenticada inicial do operador; não a execute em nome dele. Publicar código desabilitado está autorizado enquanto os gates estiverem pendentes.

## Contexto mínimo

- Leia o [protocolo](00-protocolo.md) e somente a emenda de autorização acima.
- Consulte a linha GJ14.3 e GJ14.2, GJ11.4 no [estado](../../docs/roadmap/GANSO_JEV_EXECUTION_STATE.md); confirme contratos/commits disponíveis sem reler o histórico.
- Leia somente [GJ14 Ativação do piloto e sucessão](../../docs/roadmap/GANSO_JEV_IMPLEMENTATION_PLAN.md#gj14-ativacao-do-piloto-e-sucessao) do plano.
- Seções do PRD: [Sucessão e geração de propostas](../../docs/PRD-GANSO-JEV.md#sucessao-e-geracao-de-propostas); [Risco e dimensionamento](../../docs/PRD-GANSO-JEV.md#risco-e-dimensionamento).

Localize os símbolos relevantes nestas entradas; abra apenas os trechos necessários. Módulos novos derivados do contrato são propostas, não funcionalidades existentes:

- [apps/api/src/storage/desk-worker.ts](../../apps/api/src/storage/desk-worker.ts)
- [apps/api/src/storage/recoverystore.ts](../../apps/api/src/storage/recoverystore.ts)
- [apps/api/src/storage/riskstore.ts](../../apps/api/src/storage/riskstore.ts)
- [apps/api/src/storage/ledgerstore.ts](../../apps/api/src/storage/ledgerstore.ts)

## Resultado e limite

Após reprovação comprovada do perfil ativo, cancelar entradas, encerrar/reconciliar live e só então selecionar reserva atualmente elegível respeitando prioridade. Perfil saudável não é trocado por ranking melhor. Reutilizar patrimônio/HWM do piloto e atribuição imutável dos eventos; bloqueio global tem precedência e não é reparado por sucessor.

Escolha detalhes técnicos rotineiros dentro do contrato e versione antes do experimento. Preserve trabalho alheio e contratos históricos. Alvo: 3–6 arquivos de lógica e uma migration aditiva; divida uma fronteira maior conforme o protocolo, sem declarar aceite parcial como concluído.

## Aceite

- Nenhuma nova estratégia antes de flat/reconciliado/protegido.
- Sucessão não cria gênese nem libera DD.
- Reservas continuam prospectivas; ausência de apta gera espera.

## Verificação

SQL e fixture de reproof paper/stress, redução residual, correção material, reserva inconclusiva/removida, crash e bloqueio global. Execute testes proporcionais ao diff e checks exigidos na base reconciliada. SQL usa banco descartável; não produção. Fixture não comprova operação prospectiva.

## Publicação e gates

Publicar sucessão condicionada à ativação já registrada e gates; sem ordenar operações reais para testá-la. Revise o delta, publique PR, faça merge após checks e conclua o deploy aplicável. Verifique versão/saúde/persistência; para reversão, pause entradas, preserve proteção e use código compatível com o schema, sem apagar eventos.

**Para operação efetiva:** Piloto ativado e gates efetivos válidos. Esses gates não impedem desenvolvimento e publicação desabilitada.

## Fechamento

Atualize somente a linha GJ14.3 no estado: entrega, PR/SHA, validação observada e implantação/gate pendente. Se não houver delta, não crie PR vazio. Relate mudança, verificação e publicação ou bloqueio concreto; não invente teste/deploy/qualificação. Não execute o próximo prompt.
