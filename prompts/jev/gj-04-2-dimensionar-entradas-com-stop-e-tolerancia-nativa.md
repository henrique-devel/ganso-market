---
id: GJ04.2
macro: GJ04
part: 2
depends_on: ["GJ04.1"]
operational_gates: []
mode: codigo
authorization: alteracoes-pr-merge-producao
tracking: docs/roadmap/GANSO_JEV_EXECUTION_STATE.md
context: uma-sessao-escopo-delimitado
---

# Dimensionar entradas com stop e tolerância nativa

Execute somente **GJ04.2**, parte 2 do bloco GJ04. Conclua o resultado abaixo e sua publicação aplicável; encerre sem iniciar outra sessão.

## Autorização explícita

Você está expressamente autorizado pelo proprietário a **alterar e implementar** o escopo desta sessão, criar branch `codex/`, commit/push, **criar e corrigir PR**, revisar o diff, acompanhar os checks obrigatórios, fazer **merge** após aprovação dos checks e proteções, e **publicar em produção** os componentes afetados. Inclui migrations aditivas, configuração e restart seletivo necessários. Prossiga sem pedir nova confirmação por etapa; respeite a [autorização registrada](../../docs/ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-jev-com-autonomia-por-bloco).

Esta autorização não compra API/infra nem aporta capital. Operação real segue os gates e a ativação autenticada inicial do operador; não a execute em nome dele. Publicar código desabilitado está autorizado enquanto os gates estiverem pendentes.

## Contexto mínimo

- Leia o [protocolo](00-protocolo.md) e somente a emenda de autorização acima.
- Consulte a linha GJ04.2 e GJ04.1 no [estado](../../docs/roadmap/GANSO_JEV_EXECUTION_STATE.md); confirme contratos/commits disponíveis sem reler o histórico.
- Leia somente [GJ04 Supervisor de risco e tamanho](../../docs/roadmap/GANSO_JEV_IMPLEMENTATION_PLAN.md#gj04-supervisor-de-risco-e-tamanho) do plano.
- Seções do PRD: [Risco e dimensionamento](../../docs/PRD-GANSO-JEV.md#risco-e-dimensionamento); [Execução e proteção](../../docs/PRD-GANSO-JEV.md#execucao-e-protecao).

Localize os símbolos relevantes nestas entradas; abra apenas os trechos necessários. Módulos novos derivados do contrato são propostas, não funcionalidades existentes:

- [apps/api/src/storage/baseline-policy.ts](../../apps/api/src/storage/baseline-policy.ts)
- [apps/api/src/trading/risk.ts](../../apps/api/src/trading/risk.ts)
- [apps/api/src/venues/hyperliquid/metadata.ts](../../apps/api/src/venues/hyperliquid/metadata.ts)
- [apps/api/src/trading/reservations.ts](../../apps/api/src/trading/reservations.ts)

## Resultado e limite

Extrair sizing independente da baseline e calcular maior lote válido dentro de 1%, somando distância 2ATR, taxas, funding e reserva integral de 10% de tolerância SL market. Respeitar exposição 50%, precisão e mínimo da venue; stress usa taxas duplicadas próprias. Fixar arredondamento e preço de referência pelo contrato GJ02.2.

Escolha detalhes técnicos rotineiros dentro do contrato e versione antes do experimento. Preserve trabalho alheio e contratos históricos. Alvo: 3–6 arquivos de lógica e uma migration aditiva; divida uma fronteira maior conforme o protocolo, sem declarar aceite parcial como concluído.

## Aceite

- Nunca elevar tamanho para satisfazer mínimo quando rompe risco.
- Quantidade igual entre decisão/reserva/ordem; sem pirâmide/reversão.
- Custos planejados de saída não viram débitos reais duplicados.

## Verificação

Fixtures independentes long/short, mínimo/precisão, ATR extremo, taxa/funding desconhecidos e orçamento insuficiente; revalidar regras oficiais da venue. Execute testes proporcionais ao diff e checks exigidos na base reconciliada. SQL usa banco descartável; não produção. Fixture não comprova operação prospectiva.

## Publicação e gates

Publicar sizing/reservas, mantendo novas entradas bloqueadas até ciclo integrado. Revise o delta, publique PR, faça merge após checks e conclua o deploy aplicável. Verifique versão/saúde/persistência; para reversão, pause entradas, preserve proteção e use código compatível com o schema, sem apagar eventos.

Não há gate operacional adicional a cumprir para desenvolver esta sessão; permanecem os controles do protocolo. Observação pendente deve ser registrada, sem manter a sessão esperando.

## Fechamento

Atualize somente a linha GJ04.2 no estado: entrega, PR/SHA, validação observada e implantação/gate pendente. Se não houver delta, não crie PR vazio. Relate mudança, verificação e publicação ou bloqueio concreto; não invente teste/deploy/qualificação. Não execute o próximo prompt.
