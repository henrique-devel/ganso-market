# Escopo vigente — BTC/Hyperliquid

Decisão do proprietário em **28/09/2026**. Prevalece sobre orientações anteriores
que mandavam preservar ou desenvolver Polymarket e antecipar JEV.

## Produto atual

Ganso Market é uma ferramenta pessoal para pesquisa e operação **paper de BTC
perpétuo na Hyperliquid**, com dados públicos reais. Prioridades: capacidade e
coleta sustentável, mesa manual, estratégia-base, risco, execução simulada,
contabilidade, replay e avaliação. A referência é US$ 1.000 fictícios por cenário,
sem somar contas alternativas como uma banca única.

**JEV fica para uma evolução futura.** Integrações existentes podem permanecer
desativadas; preparar acesso, contratar consumo, ativar o challenger ou exigir
comparação com IA não faz parte do marco BTC atual. O aceite operacional e a
avaliação econômica atuais usam a baseline e referências BTC/caixa. G2-15.1–3
ficam adiados até seleção futura explícita. Comparadores existentes podem ser
mantidos genéricos, sem tornar JEV uma dependência de entrega.

## Aposentadoria da Polymarket

Polymarket sai definitivamente do produto e do backlog ativo. Ficam superadas
as decisões de manter adaptador, laboratório, telas históricas, coleta, modelos,
execução paper/live ou acervo obrigatório. Pendências exclusivas, inclusive a
issue 198 e as RFCs de execução binária, têm destino **superseded por retirada de
escopo**, sem afirmar que os defeitos foram corrigidos. Autorizações antigas de
live Polymarket não habilitam live Hyperliquid.

O histórico de decisões e implementação permanece consultável no Git e em
registros datados, fora da rota de trabalho atual. Texto histórico não é ordem
para reconstruir, reativar ou preservar o produto aposentado.

## Entregas e autorização

O proprietário autorizou alterações e remoções relacionadas ao legado desde o
ambiente local até produção, incluindo PR, merge e publicação. Não repetir
pedidos de autorização para as etapas cobertas. A execução é dividida em:

1. **Escopo (entregue no PR #302):** alinhar instruções, PRD, índices e roadmap;
   publicar os mesmos documentos no servidor, sem recriar serviços por texto.
2. **Código e operação:** inventariar e remover serviços, rotas, telas, timers,
   configurações, dependências e testes exclusivos. Extrair qualquer primitiva
   ainda usada por BTC antes de retirar sua origem. Validar build, contratos
   financeiros, auth e runtime BTC; impedir reativação por deploy/watchdog.
3. **Dados:** delimitar tabelas, datasets, arquivos e artefatos exclusivos da
   Polymarket, conferir referências e consumidores BTC, estimar espaço e executar
   o descarte autorizado. A antiga obrigação de preservar o acervo Polymarket
   deixa de ser justificativa para retê-lo. Proteções exclusivas podem ser
   retiradas de forma específica na entrega; não desligar HOLD/triggers globais
   nem apagar volume compartilhado. Migrations já aplicadas permanecem imutáveis;
   eventual retirada de schema usa nova migration revisada.

O inventário técnico delimita o conjunto autorizado; não exige nova aprovação
apenas por concluir a lista. Uma dependência BTC encontrada deve ser separada e
preservada antes do descarte. Código removido é recuperável pelo Git; dados
apagados não têm recuperação prometida. Backup continua fora do pré-requisito
atual, conforme decisão anterior.

A revisão de escopo do PR #302 foi documental. A PR #303 retirou o runtime
ativo e os dados produtivos Polymarket; a migration 0049 foi aplicada e os
componentes BTC/auth foram verificados. As imagens antigas de rollback autorizadas também foram removidas. O registro
único de entrega está no [estado de execução](roadmap/GANSO_2_EXECUTION_STATE.md).
Mudanças locais alheias à tarefa são preservadas, sem reset ou sobrescrita.

## Limites mantidos

Preservar dados, ledger, pins e dependências de replay do BTC, autenticação,
perímetro, limites de risco e orçamento existente. Não ativar dinheiro real,
comprar infraestrutura/IA, aumentar capital/caps, apagar evidência BTC ou
relaxar gates de capacidade como consequência desta decisão. Dados frescos e
operação retomada exigem verificação própria; espaço liberado sozinho não
comprova sustentabilidade.

Referências ativas: [PRD](PRD-GANSO-2.0.md),
[roadmap operacional](roadmap/GANSO_2_OPERATIONAL_ROADMAP.md),
[autorização](ops/DEVELOPMENT_AUTHORIZATION.md#aposentadoria-polymarket-28092026).
