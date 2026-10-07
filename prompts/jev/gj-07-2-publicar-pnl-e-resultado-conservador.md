---
id: GJ07.2
macro: GJ07
part: 2
depends_on: ["GJ07.1","GJ06.3"]
operational_gates: []
mode: codigo
authorization: alteracoes-pr-merge-producao
tracking: docs/roadmap/GANSO_JEV_EXECUTION_STATE.md
context: uma-sessao-escopo-delimitado
---

# Publicar PnL e resultado conservador

Execute somente **GJ07.2**, parte 2 do bloco GJ07. Conclua o resultado abaixo e sua publicação aplicável; encerre sem iniciar outra sessão.

## Autorização explícita

Você está expressamente autorizado pelo proprietário a **alterar e implementar** o escopo desta sessão, criar branch `codex/`, commit/push, **criar e corrigir PR**, revisar o diff, acompanhar os checks obrigatórios, fazer **merge** após aprovação dos checks e proteções, e **publicar em produção** os componentes afetados. Inclui migrations aditivas, configuração e restart seletivo necessários. Prossiga sem pedir nova confirmação por etapa; respeite a [autorização registrada](../../docs/ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-jev-com-autonomia-por-bloco).

Esta autorização não compra API/infra nem aporta capital. Operação real segue os gates e a ativação autenticada inicial do operador; não a execute em nome dele. Publicar código desabilitado está autorizado enquanto os gates estiverem pendentes.

## Contexto mínimo

- Leia o [protocolo](00-protocolo.md) e somente a emenda de autorização acima.
- Consulte a linha GJ07.2 e GJ07.1, GJ06.3 no [estado](../../docs/roadmap/GANSO_JEV_EXECUTION_STATE.md); confirme contratos/commits disponíveis sem reler o histórico.
- Leia somente [GJ07 PnL atribuição JEV e benchmarks](../../docs/roadmap/GANSO_JEV_IMPLEMENTATION_PLAN.md#gj07-pnl-atribuicao-jev-e-benchmarks) do plano.
- Seções do PRD: [Resultados e custos](../../docs/PRD-GANSO-JEV.md#resultados-e-custos); [Painel e operação](../../docs/PRD-GANSO-JEV.md#painel-e-operacao).

Localize os símbolos relevantes nestas entradas; abra apenas os trechos necessários. Módulos novos derivados do contrato são propostas, não funcionalidades existentes:

- [apps/api/src/storage/metrics.ts](../../apps/api/src/storage/metrics.ts)
- [apps/api/src/trading/metrics.ts](../../apps/api/src/trading/metrics.ts)
- [apps/api/src/experiments-api.ts](../../apps/api/src/experiments-api.ts)
- [apps/api/src/storage/equity-history.ts](../../apps/api/src/storage/equity-history.ts)

## Resultado e limite

Publicar PnL realizado/aberto/taxas/funding e após JEV, com convenção explícita de atribuição. Calcular elegibilidade usando realizado menos taxas mais funding mais min(aberto,0) menos JEV. Distinguir patrimônio de risco de resultado econômico. Adaptar DTO/rotas sem perder auth/ownership; gráficos e cards devem partir da mesma base.

Escolha detalhes técnicos rotineiros dentro do contrato e versione antes do experimento. Preserve trabalho alheio e contratos históricos. Alvo: 3–6 arquivos de lógica e uma migration aditiva; divida uma fronteira maior conforme o protocolo, sem declarar aceite parcial como concluído.

## Aceite

- Lucro aberto não qualifica, perda aberta desconta.
- Slippage embutido no fill não é debitado novamente.
- Cost unknown permanece indisponível; não somar bancos alternativos.

## Verificação

Métricas em trajetórias independentes com parciais, funding tardio, posição aberta/flat, custo duplicado somente avaliativo e DTO. Execute testes proporcionais ao diff e checks exigidos na base reconciliada. SQL usa banco descartável; não produção. Fixture não comprova operação prospectiva.

## Publicação e gates

Publicar métricas API compatíveis e verificar leitura protegida; frontend completo vem em GJ10. Revise o delta, publique PR, faça merge após checks e conclua o deploy aplicável. Verifique versão/saúde/persistência; para reversão, pause entradas, preserve proteção e use código compatível com o schema, sem apagar eventos.

Não há gate operacional adicional a cumprir para desenvolver esta sessão; permanecem os controles do protocolo. Observação pendente deve ser registrada, sem manter a sessão esperando.

## Fechamento

Atualize somente a linha GJ07.2 no estado: entrega, PR/SHA, validação observada e implantação/gate pendente. Se não houver delta, não crie PR vazio. Relate mudança, verificação e publicação ou bloqueio concreto; não invente teste/deploy/qualificação. Não execute o próximo prompt.
