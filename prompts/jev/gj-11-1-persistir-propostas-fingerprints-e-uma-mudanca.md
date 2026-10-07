---
id: GJ11.1
macro: GJ11
part: 1
depends_on: ["GJ01.3","GJ02.2","GJ08.3"]
operational_gates: []
mode: codigo
authorization: alteracoes-pr-merge-producao
tracking: docs/roadmap/GANSO_JEV_EXECUTION_STATE.md
context: uma-sessao-escopo-delimitado
---

# Persistir propostas fingerprints e uma mudança

Execute somente **GJ11.1**, parte 1 do bloco GJ11. Conclua o resultado abaixo e sua publicação aplicável; encerre sem iniciar outra sessão.

## Autorização explícita

Você está expressamente autorizado pelo proprietário a **alterar e implementar** o escopo desta sessão, criar branch `codex/`, commit/push, **criar e corrigir PR**, revisar o diff, acompanhar os checks obrigatórios, fazer **merge** após aprovação dos checks e proteções, e **publicar em produção** os componentes afetados. Inclui migrations aditivas, configuração e restart seletivo necessários. Prossiga sem pedir nova confirmação por etapa; respeite a [autorização registrada](../../docs/ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-jev-com-autonomia-por-bloco).

Esta autorização não compra API/infra nem aporta capital. Operação real segue os gates e a ativação autenticada inicial do operador; não a execute em nome dele. Publicar código desabilitado está autorizado enquanto os gates estiverem pendentes.

## Contexto mínimo

- Leia o [protocolo](00-protocolo.md) e somente a emenda de autorização acima.
- Consulte a linha GJ11.1 e GJ01.3, GJ02.2, GJ08.3 no [estado](../../docs/roadmap/GANSO_JEV_EXECUTION_STATE.md); confirme contratos/commits disponíveis sem reler o histórico.
- Leia somente [GJ11 Gerador fila e sucessoras](../../docs/roadmap/GANSO_JEV_IMPLEMENTATION_PLAN.md#gj11-gerador-fila-e-sucessoras) do plano.
- Seções do PRD: [Sucessão e geração de propostas](../../docs/PRD-GANSO-JEV.md#sucessao-e-geracao-de-propostas); [Detalhes a fixar antes dos experimentos](../../docs/PRD-GANSO-JEV.md#detalhes-a-fixar-antes-dos-experimentos).

Localize os símbolos relevantes nestas entradas; abra apenas os trechos necessários. Módulos novos derivados do contrato são propostas, não funcionalidades existentes:

- [apps/api/src/storage/baseline-manifest.ts](../../apps/api/src/storage/baseline-manifest.ts)
- [apps/api/src/storage/desk-commandstore.ts](../../apps/api/src/storage/desk-commandstore.ts)
- [apps/api/src/trading/replay.ts](../../apps/api/src/trading/replay.ts)

## Resultado e limite

Criar registro imutável de proposta, origem, versão/fingerprint e motivo. Validar contra templates/faixas aprovadas, alterando um componente por sucessora. Bloquear configuração idêntica reprovada/retirada reapresentada com outro ID; não bloquear variação material válida só por compartilhar ancestral. Código/riscos/execução ficam fora do espaço gerado.

Escolha detalhes técnicos rotineiros dentro do contrato e versione antes do experimento. Preserve trabalho alheio e contratos históricos. Alvo: 3–6 arquivos de lógica e uma migration aditiva; divida uma fronteira maior conforme o protocolo, sem declarar aceite parcial como concluído.

## Aceite

- Uma versão ativa não é alterada.
- Fingerprint canônico distingue mudança real de renomeação.
- Registros de retirada/reprovação são persistentes e auditáveis.

## Verificação

Fixtures do espaço permitido e diferença de um componente; SQL de duplicação/concorrência e histórico imutável. Execute testes proporcionais ao diff e checks exigidos na base reconciliada. SQL usa banco descartável; não produção. Fixture não comprova operação prospectiva.

## Publicação e gates

Publicar registro/gates sem iniciar geração ou admitir estratégia. Revise o delta, publique PR, faça merge após checks e conclua o deploy aplicável. Verifique versão/saúde/persistência; para reversão, pause entradas, preserve proteção e use código compatível com o schema, sem apagar eventos.

Não há gate operacional adicional a cumprir para desenvolver esta sessão; permanecem os controles do protocolo. Observação pendente deve ser registrada, sem manter a sessão esperando.

## Fechamento

Atualize somente a linha GJ11.1 no estado: entrega, PR/SHA, validação observada e implantação/gate pendente. Se não houver delta, não crie PR vazio. Relate mudança, verificação e publicação ou bloqueio concreto; não invente teste/deploy/qualificação. Não execute o próximo prompt.
