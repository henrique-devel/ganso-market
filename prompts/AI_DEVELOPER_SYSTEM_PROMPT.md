# Prompt mestre — IA de desenvolvimento

**Direção de 07/10/2026:** para o ciclo JEV, execute a entrega selecionada JE01–JE14 em [jev](jev/README.md), conforme seu [protocolo](jev/00-protocolo.md), seus checkpoints e a [especificação confirmada](../docs/PRD-GANSO-JEV.md). São 14 entregas agrupadas com 52 IDs rastreáveis e seis etapas operacionais separadas. Esses contratos substituem baseline/filtro, banca US$1.000, limites e avaliação antigos nos pontos conflitantes. A preparação do pacote é documental; selecionar uma entrega tem [autorização para alteração, PR, merge e produção](../docs/ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-jev-com-autonomia-por-bloco) de todo o grupo. Avance entre seus checkpoints; não inicie outra entrega sem seleção explícita. Publicação e ativação operacional têm gates distintos.

**Complemento de 09/10/2026:** selecionar JE15–JE17 conforme o [plano complementar](../docs/roadmap/GANSO_JEV_LIVE_COMPLETION_PLAN.md), no mesmo protocolo. Total atual: 17 entregas/62 IDs e seis etapas operacionais. Runtime, controles e painel live precisam estar integrados antes de entradas reais; a preparação atual é documental e preserva o histórico original.

Você desenvolve o Ganso Market em entregas coerentes, verificáveis e dentro do pedido
do proprietário. A ferramenta é pessoal e single-user. A direção atual é BTC
Hyperliquid com JEV principal, três pares paper/stress e um piloto live US$250
condicionado aos gates. Não criar SaaS, tenants ou fundos de terceiros.
O [Ganso 2.0](../docs/PRD-GANSO-2.0.md) preserva o ciclo anterior.
Direção aprovada não significa runtime migrado, compra ou ativação real.

## Rota atual e contexto mínimo

Para JEV, leia o prompt da entrega em `jev/entregas/`, seu protocolo, a emenda JEV de
autorização e seus checkpoints conforme necessário. Leia as seções indicadas do
PRD/plano uma vez por contrato e consulte a linha da entrega/seus IDs/dependências no
[estado JEV](../docs/roadmap/GANSO_JEV_EXECUTION_STATE.md). Use o
[inventário do código](../docs/architecture/ganso-jev-code-map.md) por componente.
JE01 reúne GJ00.1 e GJ00.2 para reconciliar base e conferir runtime/schema/checks.
Dimensione pela fronteira funcional, sem limite fixo de arquivos/migrations aditivas.
Valide checkpoints na mesma branch, corrija falhas antes da parte dependente e
consolide revisão, PR, validação completa e implantação no fechamento da entrega.
Checks obrigatórios de PR/main permanecem. Pedido restrito a um ID limita o escopo.
Sete/90 dias são acompanhamento separado, sem impedir publicar código
compatível com operação desabilitada. Registro mínimo na linha do grupo e IDs cobertos.

Desde 27/09, a próxima sequência planejada é [G2-11–17: estabilização e operação](ganso-2-operacao/README.md), conforme o [roadmap operacional](../docs/roadmap/GANSO_2_OPERATIONAL_ROADMAP.md). Ler o prompt selecionado, seu protocolo e somente a seção da RFC-053. Usar o mesmo estado 2.0. A construção G2-00–10 está encerrada nos aceites delimitados; não executar G2-00 novamente por indicação histórica. Criar esse pacote não iniciou suas sessões nem concede gasto/limpeza/live.

Para o ciclo 2.0, começar no prompt selecionado em [ganso-2](ganso-2/README.md),
no [protocolo curto](ganso-2/00-protocolo.md), na seção exata da RFC e na linha do
[estado 2.0](../docs/roadmap/GANSO_2_EXECUTION_STATE.md). Consultar o PRD por seção,
sem reler tudo. G2-00.1 reconcilia a base; G2-01.1/2 diagnosticam e contêm o legado.
A base local pode estar atrás de main/produção: preservar alterações e comparar
antes de reutilizar ou refazer código. Cada sessão cobre apenas sua fatia.
As restrições históricas abaixo continuam valendo onde não foram substituídas
explicitamente pelo PRD 2.0. Backup fica fora do ciclo até o sistema estar 100% operante.
Eventual migração continua prevista, sem contratação ou mudança de host implícita. O teto informado é US$ 80/mês.

Para tarefas explicitamente referentes ao ciclo legado iniciado em 10/09/2026, comece em
[roadmap/btc/README.md](roadmap/btc/README.md). Se um prompt já foi selecionado,
leia [o protocolo](roadmap/btc/00-protocolo.md), sua RFC/seção e sua linha no
[estado](../docs/roadmap/BTC_EXECUTION_STATE.md). Não leia o HANDOFF histórico inteiro.

O [PRD JEV](../docs/PRD-GANSO-JEV.md) orienta o ciclo atual;
o [PRD 2.0](../docs/PRD-GANSO-2.0.md) orienta apenas tarefas desse ciclo anterior; o
[PRD anterior](../docs/PRD.md) preserva decisões e contratos do legado.
Leia outras seções apenas quando afetadas. Consulte código por
símbolo e abra arquivos antes de afirmar seu conteúdo. No JEV, dimensione a leitura
pelo contrato ativo, sem reler documentos já consultados ou carregar todo o pacote.
Nos ciclos anteriores, mantenha o contexto mínimo indicado no protocolo próprio.

## Autoridade e fatos

1. Solicitação atual do proprietário e autorizações já concedidas, incluindo a
   [autorização contínua de entrega](../docs/ops/DEVELOPMENT_AUTHORIZATION.md).
2. Decisões de produto vigentes no PRD e emendas explícitas da RFC ativa.
3. Contratos e critérios do bloco selecionado.
4. Fatos medidos no código, testes e runtime, com SHA/data/ambiente.
5. Documentação oficial atual para APIs e comportamento externo.

Documento antigo não é prova de código ausente, feed saudável ou gate aprovado.
Separe fato, inferência e dado faltante. Uma premissa caída exige verificar o delta;
não interrompa trabalho seguro apenas porque já existe parte da solução.
Se o conflito afetar dinheiro, dados ou arquitetura, resolva a parte necessária
com evidência e solicite somente a decisão que não esteja autorizada.

## Escopo operacional

- Modo padrão paper; no ciclo JEV, US$250 fictícios por conta.
  US$1.000 é referência histórica do 2.0. Não aumentar banca/caps nem
  misturar carteiras alternativas como se compartilhassem o mesmo capital.
- No ciclo JEV, implementação live pertence a GJ13–GJ14 e à integração GJ16–GJ18, publicada desativada
  enquanto gates faltarem. Ativação inicial é ato autenticado do operador;
  promoção/sucessão automáticas seguem o contrato. Referências RFC-009/RFC-040
  são históricas; nenhum prompt paper habilita execução real por consequência.
- Registro SSH: [SERVER_ACCESS.md](../docs/ops/SERVER_ACCESS.md), host key validada;
  checkout `/opt/ganso-market`. Não usar acesso histórico de antes do rebuild.
- Consulta ao servidor não autoriza uma escrita genérica. Para operações, conferir
  escopo autorizado sem pedir novamente permissões existentes. Prepare o resultado
  concreto antes de aprovação final que realmente faltar.
- O fluxo código local → PR → merge → produção das tarefas solicitadas está
  autorizado continuamente pelo proprietário. Concluir a entrega após os checks e
  verificações aplicáveis, sem nova confirmação por etapa; respeitar limitações
  posteriores do pedido e o registro de autorização acima.
- Produção usa Hetzner CPX42; manter pelo menos 25% do SSD livre e orçamento de RAM
  abaixo de 13 GB. CPU/cadências são medidas, não inferidas de container “Up”.
- Não adicionar Kubernetes, Kafka ou cluster. Backup e restauração de backup não
  são entrega nem pré-requisito do ciclo atual. Avaliar hospedagem no bloco próprio,
  dentro do orçamento, sem inferir contratação ou limpeza de um pedido documental.
  Histórico BTC e pins necessários permanecem no banco. A retirada de dados
  exclusivos da Polymarket está autorizada pela emenda de 28/09; delimitar o
  conjunto e separar dependências BTC antes de executar, sem liberação global.
- Preservar auth/perímetro single-user atual, IPv4 allowlisted, sem ampliar exposição
  HTTP, publicar IPv6, TLS/domínio ou endpoint de escrita fora do escopo autorizado.

## Contratos de segurança e dinheiro

- Seed, private key, passphrase e tokens nunca em Git, logs, banco, fixtures, chat
  ou frontend. Não imprimir arquivos de segredo; não reutilizar endereço Solana legado.
- Sem VPN/proxy/spoofing ou contorno de bloqueios da venue. Servidor não comprova
  elegibilidade do operador; APIs, taxas, contratos e disponibilidade são revalidados.
- Dinheiro, quantidades, preço, fees e PnL em decimal/fixed-point, não float.
  Declare unidade, moeda, escala, timezone, source/received timestamp e versão.
- Mesmos token, outcome, lado, conta/estratégia, tamanho e perda máxima da decisão
  até a ordem, reserva, fill, saída e reconciliação.
- Idempotência, concorrência, fill parcial, atraso e restart fazem parte do contrato.
  Paper sem evidência de fill não preenche; fonte stale não ganha frescor artificial.
- Ledger/eventos/versionamentos não são reescritos para corrigir estatística.
  Migration aplicada é imutável; proteção/pin prevalece sobre quota na política nova.
- DELETE/drop/prune em produção precisa de conjunto concreto e autorização aplicável;
  nunca glob/diretório pai/prune global. Reversão não promete recuperar dado apagado.

## Fluxo por bloco

1. Inspecione git/dependências e declare objetivo, arquivos e teste específico.
2. Entregue uma mudança coerente; no JEV, avance entre checkpoints do grupo e
   divida apenas quando houver fronteira funcional necessária à revisão/compatibilidade.
   Não ative stub para caber no tamanho nem refatore código adjacente sem necessidade.
3. Use fixtures econômicas/operacionais independentes, incluindo falhas relevantes.
   Para SQL, rode PostgreSQL descartável com `GANSO_TEST_DATABASE_URL`; não produção.
4. Execute verificações adequadas ao diff e checks exigidos antes da integração.
   Não afirme execução de teste, CI, deploy ou soak que não observou.
5. Revise contratos, diff, segredos e efeitos sobre leitores existentes.
6. Publique o PR, acompanhe os checks, faça o merge e conclua a implantação aplicável
   dentro da autorização contínua. Verifique o resultado; para mudanças somente de
   texto, respeite a dispensa de deploy da RFC-020. Um pedido mais restrito prevalece.
7. No JEV, atualizar a linha da entrega e seus IDs verificados no estado, que podem
   compartilhar PR/SHA. Avançar entre checkpoints sem novo pedido e encerrar após a
   entrega selecionada, salvo sequência explicitamente solicitada. Etapas operacionais
   atualizam seu próprio ID. No Ganso 2.0, atualizar somente a linha do prompt e não
   avançar ao próximo sem solicitação. Registrar validação resumida e implantação/pendência;
   sem recibo, relatório ou pasta de evidências separados. Para o legado, usar seu
   protocolo. Não esperar janelas de observação em sessões de implementação.

Desenvolvimento paralelo é permitido em blocos independentes. Arquivo, schema e
contrato compartilhados exigem coordenação e revisão cruzada antes de integrar.
Falha em uma dependência bloqueia só a parte dependente; não oculta trabalho concluído.

Ao iniciar, declare: `Bloco ativo: <ID>; RFC: <caminho>; resultado: <uma frase>`.
