---
id: GJ13.5
macro: GJ13
part: 5
depends_on: ["GJ13.4","GJ12.1"]
operational_gates: ["Conta testnet dedicada, identidade validada e fundos de teste existentes"]
mode: validacao-venue
authorization: alteracoes-pr-merge-producao
tracking: docs/roadmap/GANSO_JEV_EXECUTION_STATE.md
context: etapa-operacional-separada
---

# Validar o adaptador em ambiente controlado da venue

Execute somente **GJ13.5**, parte 5 do bloco GJ13. Conclua o resultado abaixo e sua publicação aplicável; encerre sem iniciar outra sessão.

## Autorização explícita

Você está expressamente autorizado pelo proprietário a **alterar e implementar** o escopo desta sessão, criar branch `codex/`, commit/push, **criar e corrigir PR**, revisar o diff, acompanhar os checks obrigatórios, fazer **merge** após aprovação dos checks e proteções, e **publicar em produção** os componentes afetados. Inclui migrations aditivas, configuração e restart seletivo necessários. Prossiga sem pedir nova confirmação por etapa; respeite a [autorização registrada](../../docs/ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-jev-com-autonomia-por-bloco).

Esta autorização não compra API/infra nem aporta capital. Operação real segue os gates e a ativação autenticada inicial do operador; não a execute em nome dele. Publicar código desabilitado está autorizado enquanto os gates estiverem pendentes.

## Contexto mínimo

- Leia o [protocolo](00-protocolo.md) e somente a emenda de autorização acima.
- Consulte a linha GJ13.5 e GJ13.4, GJ12.1 no [estado](../../docs/roadmap/GANSO_JEV_EXECUTION_STATE.md); confirme contratos/commits disponíveis sem reler o histórico.
- Leia somente [GJ13 Adaptador live e proteção nativa](../../docs/roadmap/GANSO_JEV_IMPLEMENTATION_PLAN.md#gj13-adaptador-live-e-protecao-nativa) do plano.
- Seções do PRD: [Execução e proteção](../../docs/PRD-GANSO-JEV.md#execucao-e-protecao); [Qualificação e avaliação contínua](../../docs/PRD-GANSO-JEV.md#qualificacao-e-avaliacao-continua).

Localize os símbolos relevantes nestas entradas; abra apenas os trechos necessários. Módulos novos derivados do contrato são propostas, não funcionalidades existentes:

- [apps/api/src/venues/hyperliquid/public.ts](../../apps/api/src/venues/hyperliquid/public.ts)
- [apps/api/src/storage/recoverystore.ts](../../apps/api/src/storage/recoverystore.ts)
- [apps/api/src/storage/riskstore.ts](../../apps/api/src/storage/riskstore.ts)
- [docs/ops/SERVER_ACCESS.md](../../docs/ops/SERVER_ACCESS.md)

## Resultado e limite

Exercitar adaptador/proteção/reconciliação com fixtures e ensaio testnet delimitado, autorizado por este prompt quando houver conta dedicada, identidade validada e fundos de teste existentes. Conferir ambiente antes de enviar; testnet não é retorno real ou aprovação econômica. Se faltar conta/credencial/fundos de teste, concluir gates locais e registrar validação venue pendente; sem depósito/compra ou uso de mainnet como teste.

Escolha detalhes técnicos rotineiros dentro do contrato e versione antes do experimento. Preserve trabalho alheio e contratos históricos. Dimensione pela fronteira funcional, sem limite fixo de arquivos ou migrations aditivas. Valide o comportamento afetado antes de avançar à parte dependente; não declare aceite parcial como concluído.

## Aceite

- ALO→parcial→SL→cancel/IOC→reconciliação comprovados no ambiente identificado.
- Proteção não confirmada executa falha prevista.
- Code-verified é distinto de venue-verified; ausência de ensaio permanece explícita.

## Verificação

Casos long/short, latência, ACK incerto, erro por ordem, parcial e restart; observar os estados efetivos da venue no ensaio testnet autorizado. Execute testes proporcionais ao diff e checks exigidos na base reconciliada. SQL usa banco descartável; não produção. Fixture não comprova operação prospectiva.

## Publicação e gates

Publicar correções e resultado do gate; produção continua sem entradas reais até ativação pelo operador. Revise o delta, publique PR, faça merge após checks e conclua o deploy aplicável. Verifique versão/saúde/persistência; para reversão, pause entradas, preserve proteção e use código compatível com o schema, sem apagar eventos.

**Para operação efetiva:** Conta testnet dedicada, identidade validada e fundos de teste existentes. Esses gates não impedem desenvolvimento e publicação desabilitada.

## Fechamento

Atualize somente a linha GJ13.5 no estado: entrega, PR/SHA, validação observada e implantação/gate pendente. Se não houver delta, não crie PR vazio. Relate mudança, verificação e publicação ou bloqueio concreto; não invente teste/deploy/qualificação. Não execute o próximo prompt.
