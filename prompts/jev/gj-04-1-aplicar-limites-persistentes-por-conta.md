---
id: GJ04.1
macro: GJ04
part: 1
depends_on: ["GJ02.2","GJ01.2"]
operational_gates: []
mode: codigo
authorization: alteracoes-pr-merge-producao
tracking: docs/roadmap/GANSO_JEV_EXECUTION_STATE.md
context: uma-sessao-escopo-delimitado
---

# Aplicar limites persistentes por conta

Execute somente **GJ04.1**, parte 1 do bloco GJ04. Conclua o resultado abaixo e sua publicação aplicável; encerre sem iniciar outra sessão.

## Autorização explícita

Você está expressamente autorizado pelo proprietário a **alterar e implementar** o escopo desta sessão, criar branch `codex/`, commit/push, **criar e corrigir PR**, revisar o diff, acompanhar os checks obrigatórios, fazer **merge** após aprovação dos checks e proteções, e **publicar em produção** os componentes afetados. Inclui migrations aditivas, configuração e restart seletivo necessários. Prossiga sem pedir nova confirmação por etapa; respeite a [autorização registrada](../../docs/ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-jev-com-autonomia-por-bloco).

Esta autorização não compra API/infra nem aporta capital. Operação real segue os gates e a ativação autenticada inicial do operador; não a execute em nome dele. Publicar código desabilitado está autorizado enquanto os gates estiverem pendentes.

## Contexto mínimo

- Leia o [protocolo](00-protocolo.md) e somente a emenda de autorização acima.
- Consulte a linha GJ04.1 e GJ02.2, GJ01.2 no [estado](../../docs/roadmap/GANSO_JEV_EXECUTION_STATE.md); confirme contratos/commits disponíveis sem reler o histórico.
- Leia somente [GJ04 Supervisor de risco e tamanho](../../docs/roadmap/GANSO_JEV_IMPLEMENTATION_PLAN.md#gj04-supervisor-de-risco-e-tamanho) do plano.
- Seções do PRD: [Risco e dimensionamento](../../docs/PRD-GANSO-JEV.md#risco-e-dimensionamento).

Localize os símbolos relevantes nestas entradas; abra apenas os trechos necessários. Módulos novos derivados do contrato são propostas, não funcionalidades existentes:

- [apps/api/src/trading/risk.ts](../../apps/api/src/trading/risk.ts)
- [apps/api/src/storage/riskstore.ts](../../apps/api/src/storage/riskstore.ts)
- [apps/api/src/storage/reservationstore.ts](../../apps/api/src/storage/reservationstore.ts)

## Resultado e limite

Versionar política para US$250, risco 1%, exposição 50%, diário 2% e DD fixo US$12,50 desde pico observado. Persistir dia UTC, HWM e pausas; funding/fees/aberto entram no patrimônio de negociação, JEV/infra não. Não editar resultados ou policy v1 para fingir nova banca.

Escolha detalhes técnicos rotineiros dentro do contrato e versione antes do experimento. Preserve trabalho alheio e contratos históricos. Alvo: 3–6 arquivos de lógica e uma migration aditiva; divida uma fronteira maior conforme o protocolo, sem declarar aceite parcial como concluído.

## Aceite

- Rollover diário não zera HWM/DD.
- Pausa cancela aumentos e permite reduzir; retorno diário só com flat/reconciliado/fresco.
- Limite DD permanece em dólar ao subir patrimônio.

## Verificação

Risk fixtures e SQL com fronteiras, funding concorrente, restart, rollover, US$250→270 e perda de US$12,50 do pico. Execute testes proporcionais ao diff e checks exigidos na base reconciliada. SQL usa banco descartável; não produção. Fixture não comprova operação prospectiva.

## Publicação e gates

Publicar política/checkpoint novos sem rearmar contas históricas ou piloto. Revise o delta, publique PR, faça merge após checks e conclua o deploy aplicável. Verifique versão/saúde/persistência; para reversão, pause entradas, preserve proteção e use código compatível com o schema, sem apagar eventos.

Não há gate operacional adicional a cumprir para desenvolver esta sessão; permanecem os controles do protocolo. Observação pendente deve ser registrada, sem manter a sessão esperando.

## Fechamento

Atualize somente a linha GJ04.1 no estado: entrega, PR/SHA, validação observada e implantação/gate pendente. Se não houver delta, não crie PR vazio. Relate mudança, verificação e publicação ou bloqueio concreto; não invente teste/deploy/qualificação. Não execute o próximo prompt.
