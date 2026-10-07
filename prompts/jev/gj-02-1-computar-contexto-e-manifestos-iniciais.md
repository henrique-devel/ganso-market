---
id: GJ02.1
macro: GJ02
part: 1
depends_on: ["GJ01.3"]
operational_gates: []
mode: codigo
authorization: alteracoes-pr-merge-producao
tracking: docs/roadmap/GANSO_JEV_EXECUTION_STATE.md
context: uma-sessao-escopo-delimitado
---

# Computar contexto e manifestos iniciais

Execute somente **GJ02.1**, parte 1 do bloco GJ02. Conclua o resultado abaixo e sua publicação aplicável; encerre sem iniciar outra sessão.

## Autorização explícita

Você está expressamente autorizado pelo proprietário a **alterar e implementar** o escopo desta sessão, criar branch `codex/`, commit/push, **criar e corrigir PR**, revisar o diff, acompanhar os checks obrigatórios, fazer **merge** após aprovação dos checks e proteções, e **publicar em produção** os componentes afetados. Inclui migrations aditivas, configuração e restart seletivo necessários. Prossiga sem pedir nova confirmação por etapa; respeite a [autorização registrada](../../docs/ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-jev-com-autonomia-por-bloco).

Esta autorização não compra API/infra nem aporta capital. Operação real segue os gates e a ativação autenticada inicial do operador; não a execute em nome dele. Publicar código desabilitado está autorizado enquanto os gates estiverem pendentes.

## Contexto mínimo

- Leia o [protocolo](00-protocolo.md) e somente a emenda de autorização acima.
- Consulte a linha GJ02.1 e GJ01.3 no [estado](../../docs/roadmap/GANSO_JEV_EXECUTION_STATE.md); confirme contratos/commits disponíveis sem reler o histórico.
- Leia somente [GJ02 Manifestos contexto retenção e orçamento](../../docs/roadmap/GANSO_JEV_IMPLEMENTATION_PLAN.md#gj02-manifestos-contexto-retencao-e-orcamento) do plano.
- Seções do PRD: [Decisão JEV e supervisão independente](../../docs/PRD-GANSO-JEV.md#decisao-jev-e-supervisao-independente); [Produto e contas](../../docs/PRD-GANSO-JEV.md#produto-e-contas); [Detalhes a fixar antes dos experimentos](../../docs/PRD-GANSO-JEV.md#detalhes-a-fixar-antes-dos-experimentos).

Localize os símbolos relevantes nestas entradas; abra apenas os trechos necessários. Módulos novos derivados do contrato são propostas, não funcionalidades existentes:

- [apps/api/src/storage/baseline-inputs.ts](../../apps/api/src/storage/baseline-inputs.ts)
- [apps/api/src/storage/btc-marketstore.ts](../../apps/api/src/storage/btc-marketstore.ts)
- [apps/api/src/trading/bars.ts](../../apps/api/src/trading/bars.ts)
- [apps/api/src/venues/hyperliquid/metadata.ts](../../apps/api/src/venues/hyperliquid/metadata.ts)
- [config/trading/baseline.json](../../config/trading/baseline.json)

## Resultado e limite

Extrair somente agregações reutilizáveis e construir contexto compacto com livro/fluxo/retornos/indicadores/funding e estado da conta. Fixar fórmulas, janelas, unidades e proveniência antes da observação. Criar três manifestos com mesmas informações/critérios e horizontes 1/3/5min; retirar sinal SMA/breakout como dependência de entrada. Registrar escolhas de engenharia conservadoras sem declarar rentabilidade.

Escolha detalhes técnicos rotineiros dentro do contrato e versione antes do experimento. Preserve trabalho alheio e contratos históricos. Alvo: 3–6 arquivos de lógica e uma migration aditiva; divida uma fronteira maior conforme o protocolo, sem declarar aceite parcial como concluído.

## Aceite

- Somente dados conhecidos no corte e barras fechadas.
- Manifestos diferem apenas pelo horizonte econômico inicial.
- Estado próprio e qualidade são explícitos; gap não é interpolado.

## Verificação

Fixtures de corte temporal, janela incompleta, fonte stale e unidades; paridade das primitivas extraídas. Execute testes proporcionais ao diff e checks exigidos na base reconciliada. SQL usa banco descartável; não produção. Fixture não comprova operação prospectiva.

## Publicação e gates

Publicar construção de contexto/manifestos sem habilitar chamadas ou ordens. Revise o delta, publique PR, faça merge após checks e conclua o deploy aplicável. Verifique versão/saúde/persistência; para reversão, pause entradas, preserve proteção e use código compatível com o schema, sem apagar eventos.

Não há gate operacional adicional a cumprir para desenvolver esta sessão; permanecem os controles do protocolo. Observação pendente deve ser registrada, sem manter a sessão esperando.

## Fechamento

Atualize somente a linha GJ02.1 no estado: entrega, PR/SHA, validação observada e implantação/gate pendente. Se não houver delta, não crie PR vazio. Relate mudança, verificação e publicação ou bloqueio concreto; não invente teste/deploy/qualificação. Não execute o próximo prompt.
