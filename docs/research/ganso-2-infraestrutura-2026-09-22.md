# Ganso 2.0 — infraestrutura, capacidade e custo

22/09/2026. Inspeção remota somente de leitura, preços públicos e orçamento informado pelo proprietário. Nenhum serviço foi parado, reiniciado, reconfigurado, comprado ou migrado; nenhum dado foi apagado. Este relatório integra o [PRD 2.0](../PRD-GANSO-2.0.md).

## Decisão

**Conter o crescimento do banco e resolver a instabilidade antes de ampliar a infraestrutura.** Começar a transição no host atual e, depois da contenção e medição do perfil 2.0, testar uma opção de menor custo. A primeira comparação deve ser entre planos da própria Hetzner; AWS Lightsail é a alternativa simples. Não há evidência de que GCP ou uma pilha de serviços gerenciados reduziriam o custo total deste projeto.

O proprietário informou **US$ 80/mês e ausência de backup**. Esse valor é a referência real; a tabela pública de CPX42 não substitui a fatura. O teto de planejamento é US$ 80/mês para todo o 2.0, incluindo IA. Por decisão posterior do proprietário, backup fica fora deste ciclo até o sistema estar 100% operante; não entra no orçamento ou nos critérios atuais. Faixa desejada após simplificação: US$ 30–50/mês, condicionada a cotação e capacidade.

## Evidência observada

Coleta estruturada: 22/09, 17:31:36–17:31:40 UTC. SSH com identidade fixada conforme o registro do projeto. SQL com transações somente de leitura, timeout de 2 s e timeout de lock de 500 ms; sem EXPLAIN ANALYZE, varredura de eventos ou carga induzida. [JSON integral da coleta](evidence/ganso-2-server-2026-09-22.json).

| Medida                     | Resultado                                                         | Interpretação                                                                                 |
| -------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Host                       | 8 CPUs; 16.366.653.440 bytes de RAM, aproximadamente 15,24 GiB    | Plano CPX42 é o registrado; não foi consultada a conta de faturamento                         |
| Memória disponível         | 14.381.608.960 bytes, aproximadamente 13,39 GiB                   | Folga pontual; não demonstra pico, latência ou ausência de pressão nos limites dos containers |
| Filesystem                 | 322.302.373.888 bytes, aproximadamente 300,17 GiB                 | Checkout e PGDATA observados no mesmo device; não somar espaço repetido                       |
| Disponível para uso        | 99.771.445.248 bytes, aproximadamente 92,92 GiB / 30,96%          | Usa `f_bavail`, que exclui reserva do filesystem; difere do percentual arredondado de `df`    |
| Folga acima do piso de 25% | 19.195.851.776 bytes, aproximadamente 17,88 GiB                   | Pequena em relação ao crescimento recente                                                     |
| Banco                      | 200.690.038.463 bytes, aproximadamente 186,91 GiB                 | Principal consumo de armazenamento                                                            |
| PostgreSQL                 | 18.4; limite do container 1 CPU / 1 GiB; 22 conexões de máximo 40 | Limite local do container é diferente da capacidade do host                                   |
| Transação ociosa           | Zero no instante consultado                                       | Não encerra a investigação de recorrência da issue 198                                        |
| Containers                 | Dez em execução; Python opcional ausente                          | Container em execução não equivale a estratégia saudável                                      |
| Reinícios paper            | 789 acumulados; última inicialização 17:29:55 UTC                 | P0 de diagnóstico; contador não identifica causa nem intervalo exato entre todos os reinícios |
| Reinícios recorder         | Seis acumulados; última inicialização 13:58:55 UTC                | Investigar com histórico; sem atribuir automaticamente ao mesmo problema do paper             |
| OOM flag                   | Falsa nos containers consultados                                  | Não permite concluir que nunca houve OOM ou estouro de heap em outra execução                 |
| Timers ativos              | Watchdog do recorder e replay diário                              | Precisam integrar o desligamento controlado do legado                                         |

Na captura inicial de 17:29, PostgreSQL marcou 25,28% de CPU na convenção Docker; isso não é a média sustentada do host. Evidência histórica de 12/09 já mostrou pressão no limite de 1 CPU/1 GiB do banco. A redução de consultas/serviços e a revisão medida de limites vêm antes de qualquer conclusão sobre compra de hardware.

### Concentração do banco

Os tamanhos abaixo incluem índices/TOAST da relação. Contagens de linhas retornadas pelo catálogo são estimativas; não foi executado `COUNT(*)` no corpus.

| Relação                          | GiB aproximados |
| -------------------------------- | --------------: |
| `polymarket_book_deltas`         |          139,70 |
| `polymarket_book_snapshots`      |           21,37 |
| `polymarket_book_snapshots_full` |            8,05 |
| `portfolio_panel_snapshots`      |            3,69 |
| `polymarket_trades`              |            3,52 |
| `paper_feature_windows`          |            3,00 |

Apenas os deltas representam cerca de 74,75% do banco. Isso identifica onde investigar finalidade e retenção; não demonstra que sejam apagáveis. Alguns intervalos podem sustentar replay, fills ou pesquisas e exigem preservação transitiva.

O Docker reportou 288 imagens, aproximadamente 946 MB de imagens e 1,48 GB de cache de build; volumes locais somavam aproximadamente 201 GB. As métricas de imagens/layers podem ter compartilhamento e não devem ser somadas ingenuamente. Mesmo assim, limpeza de imagens não resolveria o volume predominante do banco. Não executar `prune` global.

### Crescimento já registrado

A série finita DATA-01 terminou. Foram lidos seus oito arquivos, sem reinstalar ou reativar a coleta:

| Data UTC    | Banco em GiB | Disponível no filesystem em GiB | Qualidade                                                      |
| ----------- | -----------: | ------------------------------: | -------------------------------------------------------------- |
| 12/09 17:03 |        91,77 |                          188,12 | Completa                                                       |
| 13/09 17:03 |        93,00 |                          187,23 | Completa                                                       |
| 14/09 17:03 |        94,92 |                          185,13 | Completa                                                       |
| 15/09 17:03 |        97,05 |                          182,23 | Completa                                                       |
| 16/09 17:03 |       109,46 |                          170,70 | Completa                                                       |
| 17/09 17:03 |       116,62 |                          163,70 | Completa                                                       |
| 18/09 17:03 |       117,01 |                          163,29 | Completa                                                       |
| 19/09 17:03 |       117,40 |                          162,85 | Parcial: `CONTAINER_CHANGED`; não usar como intervalo validado |
| 22/09 17:31 |       186,91 |                           92,92 | Consulta atual independente                                    |

Entre 18/09 e 22/09: 4,0192 dias e redução líquida de espaço disponível de aproximadamente 70,37 GiB, equivalentes a **17,51 GiB/dia**. O filesystem manteve mesmo dispositivo/capacidade; a causa detalhada e a trajetória intradiária não foram observadas. Esse delta agrega banco, WAL, logs, builds e qualquer outra ocupação, não é uma taxa de ingestão pura.

Com 17,88 GiB até o piso, repetir esse consumo líquido implicaria aproximadamente **1,02 dia até 25% disponíveis**. Não é uma previsão de esgotamento total nem garantia de estabilidade até lá. A série é variável e a última amostra automática é parcial: a resposta é investigar/conter, não declarar uma curva sustentada ou aumentar disco automaticamente.

## Opções de hospedagem

Consulta pública em 22/09/2026. Valores nominais em USD, sem conversão cambial. Os planos têm CPU, disco, regiões e serviços diferentes; não constituem benchmark equivalente. Impostos, estoque, moeda da conta e itens adicionais precisam ser cotados antes de contratar.

| Opção                    | Capacidade de referência                      |        Preço base mensal | Avaliação para o Ganso                                                                    |
| ------------------------ | --------------------------------------------- | -----------------------: | ----------------------------------------------------------------------------------------- |
| Host atual CPX42         | Observado: 8 CPUs / ~16 GB / ~320 GB nominais |    **US$ 80 informados** | Manter durante contenção; já existe e não demanda migração imediata                       |
| Hetzner CX33             | 4 vCPU / 8 GB / 80 GB                         |                 US$ 9,99 | Candidato apenas com conjunto ativo muito menor; banco atual não cabe                     |
| Hetzner CX43             | 8 vCPU / 16 GB / 160 GB                       |                US$ 18,49 | Primeira opção após delimitar o conjunto necessário e transferir com margem de capacidade |
| Hetzner CX53             | 16 vCPU / 32 GB / 320 GB                      |                US$ 34,99 | Candidato preservando capacidade nominal de disco; CPU compartilhada precisa de teste     |
| AWS Lightsail Linux/IPv4 | 2 vCPU / 8 GB / 160 GB                        |                   US$ 44 | Alternativa simples após reduzir dados dispensáveis dentro do escopo autorizado           |
| AWS Lightsail Linux/IPv4 | 4 vCPU / 16 GB / 320 GB                       |                   US$ 84 | Base já supera o custo informado, antes de IA e adicionais                                |
| GCP E2 standard 2        | 2 vCPU / 8 GiB                                | ~US$ 48,92 só computação | Referência pública a US$ 0,06701142/h × 730; cotar região, disco, IP e tráfego            |
| GCP E2 standard 4        | 4 vCPU / 16 GiB                               | ~US$ 97,84 só computação | Referência pública a US$ 0,13402284/h × 730; base supera o teto                           |

Preços Hetzner: [tabela oficial de reajuste, Alemanha/Finlândia](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/). Especificações CX: [catálogo oficial](https://www.hetzner.com/cloud/cost-optimized/). A página consultada mostrou indisponibilidade nos cards CX; isso **não comprova estoque para a conta/região**. Não adotar economia condicional como redução já obtida.

Valores AWS: [preços oficiais Lightsail](https://aws.amazon.com/lightsail/pricing/). GCP: [preços de VMs](https://cloud.google.com/products/compute/pricing/general-purpose). As tarifas GCP foram obtidas na indexação pública da tabela; a abertura integral falhou e não confirmou uma cotação de Frankfurt. Por isso são referências de comparação, não preço fechado para a região alemã. Disco é [cobrado separadamente](https://cloud.google.com/compute/disks-image-pricing?hl=en) e o IPv4 de VM padrão tem [tarifa publicada de US$ 0,005/h](https://cloud.google.com/vpc/pricing-announce-external-ips), equivalente a US$ 3,65 em 730 h.

### Composição do orçamento

`Total mensal = VM + disco adicional + IP + tráfego + logs/monitoramento + API de IA + impostos/câmbio aplicáveis`.

Exemplo **condicional**, antes de tributos e itens ainda não cotados: CX43 US$ 18,49 + teto Jev US$ 5 = US$ 23,49, aos quais faltam IP e qualquer armazenamento adicional. CX53 com o mesmo teto Jev seria US$ 39,99 antes desses adicionais. A cotação efetiva deve confirmar composição e disponibilidade.

Esses cenários orientam a faixa-alvo de US$ 30–50, mas só são viáveis se todo o histórico necessário, sistema e espaço de trabalho couberem com a reserva exigida. O banco atual não cabe no CX43; retirar backup do escopo não torna esse plano adequado nem autoriza apagar o acervo. Se não houver redução suficiente de dados dispensáveis, manter capacidade compatível. Usar o teto de US$ 80 e reduzir escopo antes de contratar mais serviços.

Na AWS de US$ 44, restariam US$ 36 até o teto para IA e adicionais; a viabilidade depende de caber em 160 GB e da cotação completa. Na GCP 8 GiB, computação e IPv4 de referência já somam cerca de US$ 52,57 antes de disco e demais adicionais. Não comparar esse subtotal com o pacote de disco/tráfego de outro provedor como se fossem produtos iguais.

Com uma referência futura de capital real de US$ 1.000, US$ 80 de operação equivaleriam a 8% do capital por mês antes de custos de trading. A conta é apenas uma forma de tornar visível o peso econômico da infraestrutura; não é meta de retorno nem usa o saldo fictício para pagar despesas reais.

## Requisitos para reduzir custo com segurança operacional

1. **Conter antes de migrar:** explicar crescimento e reinícios; quiescer produtores dispensáveis com tratamento de ordens/posições e timers; não ampliar coleta BTC no estado atual.
2. **Classificar e proteger:** histórico financeiro e dependências permanecem no banco; HOLD e pins respeitados. Delimitar somente dados dispensáveis para eventual descarte autorizado. Nenhuma remoção genérica de ledger ou volume.
3. **Medir perfil 2.0:** uma venue/um ativo, agregação no worker, persistência limitada de raw e queries servidas por projeções. Testar recursos durante coleta, ticket, estratégia e restart; builds fora do horário crítico e preferencialmente no CI.
4. **Selecionar destino:** comparar custo total e estoque com carga real. CX43 só se dados, sistema e espaço de trabalho couberem com ≥40% de reserva no lançamento. Não assumir migração para ARM sem validar imagens/dependências.
5. **Migrar de forma reversível:** cópia inicial, validação, suspensão de escritas na origem, cópia final, reconciliação, corte e observação; impedir dois writers para a mesma conta. Manter origem recuperável até critérios de aceite; definir reconciliação antes de rollback após novas escritas.
6. **Verificar resultado:** saldo/ledger/versões iguais no corte, latências e limites, custo final, projeção de 90 dias. Só então encerrar o recurso antigo com autorização aplicável.

A [documentação Hetzner](https://docs.hetzner.com/cloud/servers/faq/) explica restrições de redução de disco e mudança de arquitetura. Uma VM menor pode exigir nova instalação e transferência direta dos dados; não contar com rescale para encolher o filesystem atual. Um plano de 320 GB pode reduzir preço sem reduzir disco, mas seu estoque, desempenho e transição precisam de validação.

Nenhuma decisão de compra depende apenas desta amostra. A decisão que já pode orientar o desenvolvimento é: **reduzir processos e crescimento, manter o estado financeiro reconciliado e só depois escolher a hospedagem pelo custo total medido**.
