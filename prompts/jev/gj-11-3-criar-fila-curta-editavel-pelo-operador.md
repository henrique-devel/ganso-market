---
id: GJ11.3
macro: GJ11
part: 3
depends_on: ["GJ11.2","GJ10.3"]
operational_gates: []
mode: codigo
authorization: alteracoes-pr-merge-producao
tracking: docs/roadmap/GANSO_JEV_EXECUTION_STATE.md
context: uma-sessao-escopo-delimitado
---

# Criar fila curta editável pelo operador

Execute somente **GJ11.3**, parte 3 do bloco GJ11. Conclua o resultado abaixo e sua publicação aplicável; encerre sem iniciar outra sessão.

## Autorização explícita

Você está expressamente autorizado pelo proprietário a **alterar e implementar** o escopo desta sessão, criar branch `codex/`, commit/push, **criar e corrigir PR**, revisar o diff, acompanhar os checks obrigatórios, fazer **merge** após aprovação dos checks e proteções, e **publicar em produção** os componentes afetados. Inclui migrations aditivas, configuração e restart seletivo necessários. Prossiga sem pedir nova confirmação por etapa; respeite a [autorização registrada](../../docs/ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-jev-com-autonomia-por-bloco).

Esta autorização não compra API/infra nem aporta capital. Operação real segue os gates e a ativação autenticada inicial do operador; não a execute em nome dele. Publicar código desabilitado está autorizado enquanto os gates estiverem pendentes.

## Contexto mínimo

- Leia o [protocolo](00-protocolo.md) e somente a emenda de autorização acima.
- Consulte a linha GJ11.3 e GJ11.2, GJ10.3 no [estado](../../docs/roadmap/GANSO_JEV_EXECUTION_STATE.md); confirme contratos/commits disponíveis sem reler o histórico.
- Leia somente [GJ11 Gerador fila e sucessoras](../../docs/roadmap/GANSO_JEV_IMPLEMENTATION_PLAN.md#gj11-gerador-fila-e-sucessoras) do plano.
- Seções do PRD: [Sucessão e geração de propostas](../../docs/PRD-GANSO-JEV.md#sucessao-e-geracao-de-propostas); [Painel e operação](../../docs/PRD-GANSO-JEV.md#painel-e-operacao).

Localize os símbolos relevantes nestas entradas; abra apenas os trechos necessários. Módulos novos derivados do contrato são propostas, não funcionalidades existentes:

- [apps/api/src/trading-commandapi.ts](../../apps/api/src/trading-commandapi.ts)
- [apps/api/src/storage/desk-commandstore.ts](../../apps/api/src/storage/desk-commandstore.ts)
- [apps/web/src/Experiments.tsx](../../apps/web/src/Experiments.tsx)
- [apps/web/src/btc-desk.css](../../apps/web/src/btc-desk.css)

## Resultado e limite

Persistir fila de até três propostas esperando, separada dos três pares ativos. Publicar lista/motivos e comandos autenticados idempotentes de remover/reordenar. Prioridade do operador prevalece de forma persistente; remoção impede reinserção automática do mesmo fingerprint. Não alterar parâmetros/ordem das estratégias já ativas.

Escolha detalhes técnicos rotineiros dentro do contrato e versione antes do experimento. Preserve trabalho alheio e contratos históricos. Alvo: 3–6 arquivos de lógica e uma migration aditiva; divida uma fronteira maior conforme o protocolo, sem declarar aceite parcial como concluído.

## Aceite

- Fila nunca passa de três sob concorrência.
- Gerador não desfaz remoção/reordenação do operador.
- UI diferencia aptidão técnica e elegibilidade financeira.

## Verificação

SQL/API/UI: duplo clique, reorder/remove simultâneo com enqueue, fila vazia/cheia e restart. Execute testes proporcionais ao diff e checks exigidos na base reconciliada. SQL usa banco descartável; não produção. Fixture não comprova operação prospectiva.

## Publicação e gates

Publicar backend/web com contrato compatível e verificar auth/estado; não promover live pela fila. Revise o delta, publique PR, faça merge após checks e conclua o deploy aplicável. Verifique versão/saúde/persistência; para reversão, pause entradas, preserve proteção e use código compatível com o schema, sem apagar eventos.

Não há gate operacional adicional a cumprir para desenvolver esta sessão; permanecem os controles do protocolo. Observação pendente deve ser registrada, sem manter a sessão esperando.

## Fechamento

Atualize somente a linha GJ11.3 no estado: entrega, PR/SHA, validação observada e implantação/gate pendente. Se não houver delta, não crie PR vazio. Relate mudança, verificação e publicação ou bloqueio concreto; não invente teste/deploy/qualificação. Não execute o próximo prompt.
