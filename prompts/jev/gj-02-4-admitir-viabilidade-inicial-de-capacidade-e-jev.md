---
id: GJ02.4
macro: GJ02
part: 4
depends_on: ["GJ00.2","GJ02.3"]
operational_gates: []
mode: diagnostico
authorization: alteracoes-pr-merge-producao
tracking: docs/roadmap/GANSO_JEV_EXECUTION_STATE.md
context: uma-sessao-escopo-delimitado
---

# Admitir viabilidade inicial de capacidade e JEV

Execute somente **GJ02.4**, parte 4 do bloco GJ02. Conclua o resultado abaixo e sua publicação aplicável; encerre sem iniciar outra sessão.

## Autorização explícita

Você está expressamente autorizado pelo proprietário a **alterar e implementar** o escopo desta sessão, criar branch `codex/`, commit/push, **criar e corrigir PR**, revisar o diff, acompanhar os checks obrigatórios, fazer **merge** após aprovação dos checks e proteções, e **publicar em produção** os componentes afetados. Inclui migrations aditivas, configuração e restart seletivo necessários. Prossiga sem pedir nova confirmação por etapa; respeite a [autorização registrada](../../docs/ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-jev-com-autonomia-por-bloco).

Esta autorização não compra API/infra nem aporta capital. Operação real segue os gates e a ativação autenticada inicial do operador; não a execute em nome dele. Publicar código desabilitado está autorizado enquanto os gates estiverem pendentes.

## Contexto mínimo

- Leia o [protocolo](00-protocolo.md) e somente a emenda de autorização acima.
- Consulte a linha GJ02.4 e GJ00.2, GJ02.3 no [estado](../../docs/roadmap/GANSO_JEV_EXECUTION_STATE.md); confirme contratos/commits disponíveis sem reler o histórico.
- Leia somente [GJ02 Manifestos contexto retenção e orçamento](../../docs/roadmap/GANSO_JEV_IMPLEMENTATION_PLAN.md#gj02-manifestos-contexto-retencao-e-orcamento) do plano.
- Seções do PRD: [Resultados e custos](../../docs/PRD-GANSO-JEV.md#resultados-e-custos); [Dados capacidade e recuperação](../../docs/PRD-GANSO-JEV.md#dados-capacidade-e-recuperacao).

Localize os símbolos relevantes nestas entradas; abra apenas os trechos necessários. Módulos novos derivados do contrato são propostas, não funcionalidades existentes:

- [apps/api/src/btc/collector.ts](../../apps/api/src/btc/collector.ts)
- [apps/api/src/storage/operational-readiness.ts](../../apps/api/src/storage/operational-readiness.ts)
- [docs/runbooks/btc-postgres-capacity.md](../../docs/runbooks/btc-postgres-capacity.md)
- [docs/roadmap/GANSO_JEV_IMPLEMENTATION_PLAN.md](../../docs/roadmap/GANSO_JEV_IMPLEMENTATION_PLAN.md)

## Resultado e limite

Estimar três pares, modo rápido, corpus protegido de 90d e 180d após encerramento com fixtures e preço documentado. Revalidar recursos disponíveis e diferentes tetos SQL/coletor. Delimitar gates e carga máxima a confirmar em runtime/JEV real; não confundir estimativa com consumo/latência medidos. Resolver contenção reversível autorizada; sem compra, limpeza genérica ou aumento de quota.

Escolha detalhes técnicos rotineiros dentro do contrato e versione antes do experimento. Preserve trabalho alheio e contratos históricos. Alvo: 3–6 arquivos de lógica e uma migration aditiva; divida uma fronteira maior conforme o protocolo, sem declarar aceite parcial como concluído.

## Aceite

- Estimativa rastreável e gates explícitos para admissão real.
- Orçamento agregado US$8 operacional/US$2 geração, infraestrutura fora do resultado da estratégia.
- Indisponibilidade de credencial/capacidade bloqueia ativação, preservando entrega técnica independente.

## Verificação

Leituras de recursos e estimativas reproduzíveis; carga apenas em ambiente descartável delimitado. Nenhuma chamada paga nesta estimativa. Execute testes proporcionais ao diff e checks exigidos na base reconciliada. SQL usa banco descartável; não produção. Fixture não comprova operação prospectiva.

## Publicação e gates

Publicar limites/diagnóstico e documentação; manter operação nova desabilitada. Revise o delta, publique PR, faça merge após checks e conclua o deploy aplicável. Verifique versão/saúde/persistência; para reversão, pause entradas, preserve proteção e use código compatível com o schema, sem apagar eventos.

Não há gate operacional adicional a cumprir para desenvolver esta sessão; permanecem os controles do protocolo. Observação pendente deve ser registrada, sem manter a sessão esperando.

## Fechamento

Atualize somente a linha GJ02.4 no estado: entrega, PR/SHA, validação observada e implantação/gate pendente. Se não houver delta, não crie PR vazio. Relate mudança, verificação e publicação ou bloqueio concreto; não invente teste/deploy/qualificação. Não execute o próximo prompt.
