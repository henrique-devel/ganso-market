---
id: GJ00.2
macro: GJ00
part: 2
depends_on: ["GJ00.1"]
operational_gates: []
mode: diagnostico
authorization: alteracoes-pr-merge-producao
tracking: docs/roadmap/GANSO_JEV_EXECUTION_STATE.md
context: uma-sessao-escopo-delimitado
---

# Conferir runtime schema e checks da base

Execute somente **GJ00.2**, parte 2 do bloco GJ00. Conclua o resultado abaixo e sua publicação aplicável; encerre sem iniciar outra sessão.

## Autorização explícita

Você está expressamente autorizado pelo proprietário a **alterar e implementar** o escopo desta sessão, criar branch `codex/`, commit/push, **criar e corrigir PR**, revisar o diff, acompanhar os checks obrigatórios, fazer **merge** após aprovação dos checks e proteções, e **publicar em produção** os componentes afetados. Inclui migrations aditivas, configuração e restart seletivo necessários. Prossiga sem pedir nova confirmação por etapa; respeite a [autorização registrada](../../docs/ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-jev-com-autonomia-por-bloco).

Esta autorização não compra API/infra nem aporta capital. Operação real segue os gates e a ativação autenticada inicial do operador; não a execute em nome dele. Publicar código desabilitado está autorizado enquanto os gates estiverem pendentes.

## Contexto mínimo

- Leia o [protocolo](00-protocolo.md) e somente a emenda de autorização acima.
- Consulte a linha GJ00.2 e GJ00.1 no [estado](../../docs/roadmap/GANSO_JEV_EXECUTION_STATE.md); confirme contratos/commits disponíveis sem reler o histórico.
- Leia somente [GJ00 Reconciliação da base e superfícies de implantação](../../docs/roadmap/GANSO_JEV_IMPLEMENTATION_PLAN.md#gj00-reconciliacao-da-base-e-superficies-de-implantacao) do plano.
- Seções do PRD: [Dados capacidade e recuperação](../../docs/PRD-GANSO-JEV.md#dados-capacidade-e-recuperacao).

Localize os símbolos relevantes nestas entradas; abra apenas os trechos necessários. Módulos novos derivados do contrato são propostas, não funcionalidades existentes:

- [docker-compose.yml](../../docker-compose.yml)
- [Makefile](../../Makefile)
- [deploy/healthcheck.sh](../../deploy/healthcheck.sh)
- [docs/ops/SERVER_ACCESS.md](../../docs/ops/SERVER_ACCESS.md)
- [docs/runbooks/btc-postgres-capacity.md](../../docs/runbooks/btc-postgres-capacity.md)

## Resultado e limite

Observar versões efetivas, schema, modo, componentes BTC, posições/reservas pendentes e capacidade usando a identidade SSH registrada. Levantar baseline dos checks na base reconciliada e separar defeitos atuais de divergências históricas. Fazer correções pontuais de compatibilidade/configuração desse diagnóstico; reparos extensos recebem subfatia delimitada. Não ativar coleta, JEV ou ordens nesta sessão.

Escolha detalhes técnicos rotineiros dentro do contrato e versione antes do experimento. Preserve trabalho alheio e contratos históricos. Alvo: 3–6 arquivos de lógica e uma migration aditiva; divida uma fronteira maior conforme o protocolo, sem declarar aceite parcial como concluído.

## Aceite

- Base de checks e compatibilidade registradas com ambiente/data.
- Pendências reais delimitadas; ledger/pins e perímetro preservados.
- Ausência de capacidade não é curada aumentando quota ou excluindo protegido.

## Verificação

Checks existentes pertinentes; PostgreSQL somente descartável. Verificar leitura de versões/estado sem expor segredos; não usar produção como suíte. Execute testes proporcionais ao diff e checks exigidos na base reconciliada. SQL usa banco descartável; não produção. Fixture não comprova operação prospectiva.

## Publicação e gates

Publicar correções necessárias e verificar apenas componentes afetados; diagnóstico sem código segue publicação textual. Revise o delta, publique PR, faça merge após checks e conclua o deploy aplicável. Verifique versão/saúde/persistência; para reversão, pause entradas, preserve proteção e use código compatível com o schema, sem apagar eventos.

Não há gate operacional adicional a cumprir para desenvolver esta sessão; permanecem os controles do protocolo. Observação pendente deve ser registrada, sem manter a sessão esperando.

## Fechamento

Atualize somente a linha GJ00.2 no estado: entrega, PR/SHA, validação observada e implantação/gate pendente. Se não houver delta, não crie PR vazio. Relate mudança, verificação e publicação ou bloqueio concreto; não invente teste/deploy/qualificação. Não execute o próximo prompt.
