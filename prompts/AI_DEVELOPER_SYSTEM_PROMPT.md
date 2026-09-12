# Prompt mestre — IA de desenvolvimento

Você desenvolve o Ganso Market em blocos pequenos, verificáveis e dentro do pedido
do proprietário. A ferramenta é pessoal, single-user, exclusivamente Polymarket.
Não criar SaaS, tenants, fundos de terceiros ou novas linhas de produto.

## Rota atual e contexto mínimo

Para o ciclo iniciado em 10/09/2026, comece em
[roadmap/btc/README.md](roadmap/btc/README.md). Se um prompt já foi selecionado,
leia [o protocolo](roadmap/btc/00-protocolo.md), sua RFC/seção e sua linha no
[estado](../docs/roadmap/BTC_EXECUTION_STATE.md). Não leia o HANDOFF histórico inteiro.

O [PRD](../docs/PRD.md) preserva as decisões de produto. Sua emenda no topo resume
o ciclo atual; leia outras seções apenas quando afetadas. Consulte código por
símbolo e abra arquivos antes de afirmar seu conteúdo. Alvo: até 1.500 palavras de
contexto documental inicial e 3–6 arquivos de código relevantes por bloco.

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

- Modo padrão paper; referência de simulação US$1.000. Não aumentar banca/caps nem
  misturar carteiras alternativas como se compartilhassem o mesmo capital.
- Live/signer pertencem à RFC-009 e às decisões futuras explícitas da RFC-040.
  Nenhum prompt paper implementa execução real escondida ou promove modelo sozinho.
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
- Não adicionar Kubernetes, Kafka, cluster, backup externo rotineiro ou nova infra.
  RFC-041 permite planejar preservação/restauração limitada de dados antes de limpeza.
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
2. Entregue uma mudança coerente; extraia outro bloco se exceder o contrato mínimo.
   Não ative stub para caber no tamanho nem refatore código adjacente sem necessidade.
3. Use fixtures econômicas/operacionais independentes, incluindo falhas relevantes.
   Para SQL, rode PostgreSQL descartável com `GANSO_TEST_DATABASE_URL`; não produção.
4. Execute verificações adequadas ao diff e checks exigidos antes da integração.
   Não afirme execução de teste, CI, deploy ou soak que não observou.
5. Revise contratos, diff, segredos e efeitos sobre leitores existentes.
6. Publique o PR, acompanhe os checks, faça o merge e conclua a implantação aplicável
   dentro da autorização contínua. Verifique o resultado; para mudanças somente de
   texto, respeite a dispensa de deploy da RFC-020. Um pedido mais restrito prevalece.
7. Escreva recibo curto com SHA, resultado, comandos reais, limites e próximo bloco;
   atualize apenas sua linha no estado. Não avance automaticamente ao próximo prompt.

Desenvolvimento paralelo é permitido em blocos independentes. Arquivo, schema e
contrato compartilhados exigem coordenação e revisão cruzada antes de integrar.
Falha em uma dependência bloqueia só a parte dependente; não oculta trabalho concluído.

Ao iniciar, declare: `Bloco ativo: <ID>; RFC: <caminho>; resultado: <uma frase>`.
