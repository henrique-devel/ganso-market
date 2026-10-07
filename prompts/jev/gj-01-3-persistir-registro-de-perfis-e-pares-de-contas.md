---
id: GJ01.3
macro: GJ01
part: 3
depends_on: ["GJ01.2"]
operational_gates: []
mode: codigo
authorization: alteracoes-pr-merge-producao
tracking: docs/roadmap/GANSO_JEV_EXECUTION_STATE.md
context: uma-sessao-escopo-delimitado
---

# Persistir registro de perfis e pares de contas

Execute somente **GJ01.3**, parte 3 do bloco GJ01. Conclua o resultado abaixo e sua publicação aplicável; encerre sem iniciar outra sessão.

## Autorização explícita

Você está expressamente autorizado pelo proprietário a **alterar e implementar** o escopo desta sessão, criar branch `codex/`, commit/push, **criar e corrigir PR**, revisar o diff, acompanhar os checks obrigatórios, fazer **merge** após aprovação dos checks e proteções, e **publicar em produção** os componentes afetados. Inclui migrations aditivas, configuração e restart seletivo necessários. Prossiga sem pedir nova confirmação por etapa; respeite a [autorização registrada](../../docs/ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-jev-com-autonomia-por-bloco).

Esta autorização não compra API/infra nem aporta capital. Operação real segue os gates e a ativação autenticada inicial do operador; não a execute em nome dele. Publicar código desabilitado está autorizado enquanto os gates estiverem pendentes.

## Contexto mínimo

- Leia o [protocolo](00-protocolo.md) e somente a emenda de autorização acima.
- Consulte a linha GJ01.3 e GJ01.2 no [estado](../../docs/roadmap/GANSO_JEV_EXECUTION_STATE.md); confirme contratos/commits disponíveis sem reler o histórico.
- Leia somente [GJ01 Contratos de contas perfis e capital](../../docs/roadmap/GANSO_JEV_IMPLEMENTATION_PLAN.md#gj01-contratos-de-contas-perfis-e-capital) do plano.
- Seções do PRD: [Produto e contas](../../docs/PRD-GANSO-JEV.md#produto-e-contas); [Sucessão e geração de propostas](../../docs/PRD-GANSO-JEV.md#sucessao-e-geracao-de-propostas).

Localize os símbolos relevantes nestas entradas; abra apenas os trechos necessários. Módulos novos derivados do contrato são propostas, não funcionalidades existentes:

- [apps/api/src/storage/ledgerstore.ts](../../apps/api/src/storage/ledgerstore.ts)
- [apps/api/src/storage/desk-commandstore.ts](../../apps/api/src/storage/desk-commandstore.ts)
- [apps/api/src/storage/desk-projection.ts](../../apps/api/src/storage/desk-projection.ts)
- [apps/api/src/storage/baseline-store.ts](../../apps/api/src/storage/baseline-store.ts)

## Resultado e limite

Criar registro append-only de perfis/versões e pareamento paper/stress, distinguindo estado técnico/financeiro. Representar vínculo duradouro do piloto e garantir singleton de conta real por restrição/lock. Reaproveitar criação e comandos existentes sem ativar execução. Usar nova migration delimitada se necessária.

Escolha detalhes técnicos rotineiros dentro do contrato e versione antes do experimento. Preserve trabalho alheio e contratos históricos. Alvo: 3–6 arquivos de lógica e uma migration aditiva; divida uma fronteira maior conforme o protocolo, sem declarar aceite parcial como concluído.

## Aceite

- Criar perfil/conta duas vezes não duplica patrimônio.
- Registro representa até três pares e um live sem consumidor novo ativo.
- Versão material não herda aprovação de outra; histórico não é reescrito.

## Verificação

SQL de concorrência, fingerprint, pareamento e singleton; fixtures de versões sem misturar resultados. Execute testes proporcionais ao diff e checks exigidos na base reconciliada. SQL usa banco descartável; não produção. Fixture não comprova operação prospectiva.

## Publicação e gates

Publicar registro e contratos compatíveis; controles de admissão permanecem fechados. Revise o delta, publique PR, faça merge após checks e conclua o deploy aplicável. Verifique versão/saúde/persistência; para reversão, pause entradas, preserve proteção e use código compatível com o schema, sem apagar eventos.

Não há gate operacional adicional a cumprir para desenvolver esta sessão; permanecem os controles do protocolo. Observação pendente deve ser registrada, sem manter a sessão esperando.

## Fechamento

Atualize somente a linha GJ01.3 no estado: entrega, PR/SHA, validação observada e implantação/gate pendente. Se não houver delta, não crie PR vazio. Relate mudança, verificação e publicação ou bloqueio concreto; não invente teste/deploy/qualificação. Não execute o próximo prompt.
