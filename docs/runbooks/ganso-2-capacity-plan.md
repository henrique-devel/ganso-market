# G2-12.1 — Plano de capacidade e custo

Contrato documental `g2-capacity-plan.v1`, 28/09/2026 UTC; base `7876aed`.
Escopo: [RFC-053/S2](../rfcs/RFC-053-ganso-2-prontidao-operacional.md#s2).
**Plano entregue; admissão bloqueada.** Manter o host provisionado e o coletor
contido. Nenhuma alternativa está aprovada para ativação. Priorizar redução de
novos dados e consultas, mas ela sozinha não recupera os 40% livres nem desfaz
ocupação lógica anterior. Não alterar HOLD, dados, quotas, host ou cobrança.

## 1. Medição e fronteira de validade

SSH autenticado conforme [identidade](../ops/SERVER_ACCESS.md), somente leitura,
28/09 **00:37:12.933–00:37:52.933 UTC**, três amostras separadas por 20 s.
Catálogo/tamanhos e contadores: READ ONLY, statement 1500 ms, lock 250 ms,
sem paralelismo SQL; sem COUNT de corpus, EXPLAIN ANALYZE, dump, varredura de
payload, ensaio de escrita ou carga. Conferência adicional por chave das três
últimas decisões: cortes 00:00/00:15/00:30 UTC. Schema 45; API imagem `0a46b3201227`
(revisão `9bad764`); publicação contida do worker `24698a8` já registrada em G2-11.3.

- Coletor exited/1 desde 26/09 22:07:29, zero restarts, `restart=no`; última captura
  22:07:26.306. Legado continua parado. HOLD BTC=true; zero triggers de usuário
  desabilitados, guards de DELETE/TRUNCATE do raw legado habilitados.
- API: três restarts acumulados, último início 27/09 23:22:28. A causa não foi
  investigada aqui. PG conserva início 07/09 22:59:17. Não declarar estabilidade.
- Filesystem PG real `/dev/sda1`, volume `ganso-market_postgres_data`, **C =
  322.302.373.888 B**. Disponível entre **87.262.253.056 e 87.270.510.592 B**;
  usar o menor A nos cálculos (**27,0747%**). Blocos reservados/indisponíveis:
  13.148.364.800 B. `C−A` inclui essa reserva, não apenas `df Used`.
- Banco `pg_database_size` **210.895.132.351 B**; relações públicas
  **210.881.052.672 B**, diferença 14.079.679 B (catálogos/outros arquivos).
  Todo o legado permanece protegido; objetos novos/desconhecidos também.

GB/MB são decimais, GiB/MiB binários (2^30/2^20 B). Contadores lógicos são
cobrança conservadora do envelope, payload e dependências; não são bytes de disco.
Tamanhos físicos incluem alocação, não somente linhas vivas. Não estimar economia
de DELETE, compactação ou transferência a partir deles.

### Classes físicas, sem dupla contagem

As nove classes legadas usam exatamente os conjuntos do
[mapa de dados](ganso-2-data-map.md#inventário-por-classe). As 35 tabelas BTC
completam as 121 públicas. Índices da tabela principal e TOAST são **subconjuntos**
do total; TOAST inclui seus próprios índices. Total também inclui heap/FSM/VM.
Não somar essas colunas ao total nem tratar índice como descartável.

| Classe | Tabelas | Total B | Índices principais B | TOAST com índices B |
| --- | ---: | ---: | ---: | ---: |
| F financeiro legado | 11 | 36.831.232 | 20.168.704 | 90.112 |
| D decisões/controle legado | 16 | 5.001.338.880 | 967.991.296 | 1.874.903.040 |
| L livro raw legado | 3 | 185.505.923.072 | 90.536.165.376 | 50.470.912 |
| R outros raw legados | 3 | 5.516.656.640 | 2.545.090.560 | 838.737.920 |
| P pesquisa/agregados | 12 | 8.105.558.016 | 3.289.980.928 | 434.176 |
| C contexto/proveniência | 29 | 717.914.112 | 126.115.840 | 237.568 |
| I pins legados | 2 | 40.960 | 24.576 | 16.384 |
| S resíduos preservados | 4 | 114.688 | 81.920 | 32.768 |
| O autenticação/schema | 6 | 393.216 | 229.376 | 49.152 |
| BTC corpus do guard | 6 | 3.947.839.488 | 769.155.072 | 2.378.137.600 |
| BTC decisões/registro/eventos baseline | 3 | 2.044.813.312 | 98.304 | 2.044.641.280 |
| BTC Jev | 3 | 81.920 | 57.344 | 24.576 |
| BTC demais contas/execução/controle | 23 | 3.547.136 | 614.400 | 2.015.232 |

Legado total **204.884.770.816 B**, BTC total **5.996.281.856 B**.
O corpus do guard é somente `btc_retention_{objects,dependencies,pins}` e
`btc_market_{records,bars,head}`; não é todo BTC. O financeiro/decisões também
possui evidências nesse corpus; sua cobrança lógica não pode ser somada ao raw
como se fossem bases independentes. `btc_retention_objects` ocupa 3.067.715.584 B,
dos quais 2.378.096.640 B são TOAST; `btc_baseline_decisions` ocupa 2.044.747.776 B,
dos quais 2.044.624.896 B são TOAST. As duas cópias de decisão são um alvo concreto
para reduzir **escritas futuras**, preservando bytes/hashes e leitura dos contratos antigos.

### WAL, temporários e crescimento

WAL residente: **805.306.368 B**, estável nos 40 s; geração +26.605 B (~665 B/s),
mesmo `stats_reset` de 17/08. WAL gerado não é acumulação permanente: segmentos
são reutilizados. Temporários PG presentes: 8.257.536 → 0 → 0 B; contador cumulativo
`temp_bytes`: 79.828.877.455.033 → 79.829.290.331.833 B, **+412.876.800 B/40 s
(~10,322 MB/s), +50 arquivos**. Isso é tráfego de I/O, não 79,8 TB ocupados nem
projeção de disco líquido. Não extrapolar a ocupação instantânea zero para pico zero.

`du` aparente limitado: `/tmp` 20.806.407 B; `/var/tmp` 0;
`/var/log` 1.605.102.179 B; `.deploy` 96.539.304 B. Não somar novamente ao df.
Nenhum desses diretórios oferece os 41,66 GB necessários por si só; nenhum
manifesto de descarte foi autorizado. Imagens/cache não foram classificados
como recuperáveis; economia por limpeza permanece desconhecida.

| Classe/medida | Delta observado | Intervalo e interpretação |
| --- | ---: | --- |
| Todas as 13 classes físicas acima | 0 B cada | 40,000235 s, coletor parado; não prova crescimento zero futuro |
| Raw lógico BTC | 0 B | 2.147.899.519 B nas três amostras e no registro de 27/09 |
| Lógico não raw | +2.780.292.283 B | 27/09 04:56:30 → 28/09 00:37:52.933, 19,6897 h; ~141,205 MB/h de calendário |
| Corpus físico do guard | +1.896.554.496 B | Mesmo intervalo; ~96,322 MB/h |
| BTC fora do guard | +1.867.218.944 B | Mesmo intervalo; diferença entre delta BTC total e corpus |
| BTC total / banco | +3.763.773.440 B cada | Mesmo intervalo; ~191,154 MB/h; legado total inalterado |
| Uso filesystem | +4.506.361.856 B | Baseline A=91.768.614.912 B → menor A atual; ~228,869 MB/h; inclui transitórios e outros usos |
| Captura histórica ativa | raw 74,769; lógico 132,754; corpus físico 68,914; filesystem 90,143759 MB/h | Amostra histórica de ~10 h em G2-10.1, não taxa medida com o coletor parado |

Os deltas de 19,6897 h incluem recuperação de decisões e regimes diferentes;
não são média estável nem atribuição causal completa. Nos 40 s só avançaram
contadores de UPDATE em `btc_desk_runtime` e `btc_recovery_heads` (+50 cada),
sem nova alocação. Séries diárias existentes de `capacity_series.py` terminam
em 19/09 (última amostra incompleta); não comprovam os sete dias atuais nem
crescimento por classe. Não reiniciar timer/série nesta sessão.

As três decisões recentes têm cobrança de **19.986.644–19.986.848 B/decisão** e
payload armazenado de **12.932.741–12.932.918 B/cópia** (`pg_column_size`, sem
exportar payload). Há gravação da decisão em retenção e em baseline, confirmada
em `baseline-store.ts`/`baseline-runtime.ts`. Para orçamento, quatro decisões/h
por conta dão **79.947.392 B/h lógicos** e **103.463.344 B/h físicos** em duas cópias,
antes de diferenças de índices/alocação. A segunda cópia usa como hipótese o
mesmo tamanho da primeira, não uma medição de cada objeto TOAST. Isso permanece
relevante mesmo com feed parado. O diagnóstico não autoriza apagar essas decisões.

## 2. Três gates independentes

| Gate | Medido / limite | Resultado |
| --- | --- | --- |
| Worker raw | 2.147.899.519 / 4.294.967.296 B | Folga 2.147.067.777 B (~28,72 h à taxa raw histórica) |
| Worker lógico | **6.536.828.030 / 6.442.450.944 B** | **Excedido em 94.377.086 B; horizonte admissível zero** |
| Worker físico, seis tabelas | 3.947.839.488 / 4.294.967.296 B | Só 347.127.808 B de folga; não todo o banco |
| Quotas SQL | raw 10 GiB; lógico 12 GiB; físico 14 GiB | Não substituem tetos worker nem reservam disco |
| Filesystem | A > 25% de C + 1 GiB | Passa agora, folga apenas **5.612.917.760 B** |
| Lançamento | A ≥ 40% de C | Falha: faltam **41.658.696.499,2 B** |

A aplicação consulta seis relações para o guard físico; o trigger SQL mede as
três de retenção. Financeiro/decisão podem ultrapassar a recusa SQL de dados não
essenciais para preservar evidência. Portanto quota SQL não é teto absoluto de
todo BTC. Guard consulta capacidade sem lock de escrita; triggers revalidam na
transação. HOLD/pins impedem TTL de liberar espaço. Reiniciar não zera contadores.
As **~20,23 h** históricas eram `(6 GiB − 3.756.535.747)/132.754.000`; essa folga
foi consumida por dados não raw. Hoje nenhum refinamento de captura futura faz
`6.536.828.030 < 6 GiB` sem uma decisão separada sobre o limite/armazenamento.

Com o host atual, taxa líquida máxima até piso+1GiB seria **33,410 / 7,796 /
2,599 MB/h** para 7/30/90 dias, antes de reserva extra de pico. Mesmo taxa zero
não passa lançamento. Manter tudo protegido já consome 204,885 GB só em relações
legadas, acima dos 193,381 GB (=60% de C), mesmo ignorando BTC, sistema e reservas.
Logo não há solução comprovada preservando a alocação atual no mesmo filesystem.

## 3. Cenários de 7, 30 e 90 dias

Projeção sem descarte, não previsão nem autorização. Normal de referência:
captura histórica + uma baseline no tamanho recente + equity/Jev abaixo.
A soma é conservadora e pode sobrepor parte da baseline presente no intervalo
histórico; não é uma taxa conjunta medida. Pico de planejamento = **2× normal
sustentado** (inclui segunda conta/maior captura); não é p95 observado nem limite
máximo do mercado. Sensibilidade residual: repetir captura + os 228,869 MB/h
residuais daria ~689,067 GB/90 dias, ainda abaixo dos 842,894 GB do pico escolhido.

| Crescimento por classe, GB adicionais | 7 dias | 30 dias | 90 dias |
| --- | ---: | ---: | ---: |
| Raw lógico, captura histórica | 12,561192 | 53,833680 | 161,501040 |
| Lógico total da captura (já inclui raw) | 22,302672 | 95,582880 | 286,748640 |
| Corpus físico da captura | 11,577552 | 49,618080 | 148,854240 |
| Decisão baseline lógica, uma conta | 13,431162 | 57,562122 | 172,686367 |
| Decisão baseline física, duas cópias | 17,381842 | 74,493608 | 223,480823 |
| Equity lógica: duas contas, 1/min, 4 KiB/observação | 0,082575 | 0,353894 | 1,061683 |
| Jev lógico: até 96/dia, 64 KiB por requisição+resposta/custo | 0,044040 | 0,188744 | 0,566231 |

Equity/Jev são **envelopes propostos**, não tamanhos contratados/medidos.
Orçar 2× seus bytes lógicos para tabelas/índices/dependências; se amostra futura
exceder, recalcular antes de admitir. Equity usa marca/qualidade/corte e também
eventos financeiros: o orçamento não permite omitir eventos ou reduzir resolução
requerida para caber. Jev maior/frequência extra não cabe automaticamente; sem
cobertura paga não há chamada. Sem budgets/calls Jev na conferência atual, custo
externo permanece desconhecido, não zero.

Replay: ler evidências existentes sem nova chamada Jev nem duplicar corpus;
um job, lotes por chave, checkpoint/cursor, até **1 GiB transitório** incluído
na reserva abaixo, não 1 GiB por dia. Os 2.880 cortes de 30 dias precisam todos
ser percorridos. Se saída materializada superar o envelope, streaming/destino
aprovado e novo orçamento são necessários; não truncar janela para caber.

`r_normal = 90.143.759,186 + 103.463.344 + 2×(491.520+262.144)
= 195.114.431,186 B/h`. `A(t)=A−r×24×dias`.
Reserva planejada adicional total **4 GiB**: 1 GiB WAL transitório, 1 GiB temp,
1 GiB replay e 1 GiB operação. Inclui o 1 GiB exigido pelo guard; não é quota
instalada nem afirma máximo de WAL/temp. WAL residente já está no footprint.

| Cenário | Crescimento GB 7/30/90 dias | A final GB 7/30/90 dias | Veredito no host |
| --- | --- | --- | --- |
| Normal de referência | 32,779 / 140,482 / 421,447 | 54,483 / −53,220 / −334,185 | Falha piso já em 7 dias e lançamento desde início |
| Pico 2× | 65,558 / 280,965 / 842,894 | 21,704 / −193,703 / −755,632 | Falha; números negativos significam cenário impossível, não escrita autorizada |
| Meta otimizada normal, 3 MB/h FS | 0,504 / 2,160 / 6,480 | 86,758 / 85,102 / 80,782 | Falha piso+1GiB em 90 dias e lançamento |
| Meta otimizada pico, 6 MB/h FS | 1,008 / 4,320 / 12,960 | 86,254 / 82,942 / 74,302 | Falha piso em 90 dias e lançamento |

Sem mover bytes, capacidade efetiva necessária é
`D ≥ (C−A)/0,60` para lançamento e
`D > (C−A + crescimento + 4 GiB)/0,75` para fim.
Triagem normal: 391,734 / 506,423 / **881,043 GB** em 7/30/90 dias;
pico: 406,525 / 693,733 / **1.442,973 GB**. Novo filesystem pode ter reservas
proporcionais e rendimento diferente: esses mínimos não são tamanhos de compra.

## 4. Trabalho independente no host e gates para as próximas fatias

Esta seção é especificação para sessões selecionadas posteriormente, não sua
execução. Nenhuma mudança de runtime foi feita aqui.

1. **Decisões/evidências primeiro:** eliminar expansão repetida de referências
   transitivas e segunda cópia grande nas novas versões, preservando hashes,
   identidade, fechamento transitivo e replay dos registros antigos. Os ~20 MB
   lógicos por decisão já tornam o problema independente da captura. Não reescrever
   histórico ou recobrar contadores antigos como se ocupação tivesse desaparecido.
2. **Captura futura:** evitar snapshots/metadata/envelopes idênticos, compartilhar
   evidência imutável por chave e persistir somente o necessário ao contrato
   declarado. Medir frequência × bytes + índices/arestas. Sampling que perde L2,
   trades, âncoras ou frescor necessários invalida o replay e deve ser recusado;
   reduzir escopo exige versão explícita, não simular continuidade.
3. **Consultas:** reutilizar leitura por IDs em lotes de 256 já entregue em G2-11.2;
   investigar geração recorrente de temporários e leitura das grandes decisões em
   PostgreSQL descartável representativo. Cursor/índice existente por conta/corte,
   sem desserializar toda história a cada tick; uma consulta limitada por vez.
   Preservar os budgets atuais e ordem de locks; não aumentar timeout/pool/cgroup.
4. **Orçamento candidato otimizado:** limites de projeto abaixo são condições de
   aceite a demonstrar, não promessa de redução. Cobrança inclui envelope/arestas;
   no físico usar inicialmente 2× lógico; medir e substituir pelo maior valor se
   necessário. Preservar todas as evidências obrigatórias mesmo se falhar o alvo.

| Classe futura | B/h lógicos, normal | Origem do envelope |
| --- | ---: | --- |
| Raw novo | 250.000 | Meta de redução de 99,666% frente à captura histórica; viabilidade ainda não provada |
| Barras/capturas/metadata/dependências restantes | 100.000 | Meta; inclui custos fixos, não só payload |
| Decisões/contas | 131.072 | 2 contas × 4 decisões/h × 16 KiB; inclui registros financeiros, se suficientes |
| Equity | 491.520 | 2 contas × 60/h × 4 KiB |
| Jev | 262.144 | 4/h × 64 KiB |
| **Total** | **1.234.736** | Pico 2.469.472 B/h; físico até 4.938.944 B/h no pico |

Saldo normal de filesystem até 3 MB/h deixa 530.528 B/h para logs/alocações
não incluídas; pico FS 6 MB/h. Em 90 dias de pico: raw acumulado 3.227.899.519 B;
lógico acumulado **11.870.887.550 B**; corpus físico conservador
**14.615.958.528 B** (conta todo incremento nesse corpus mesmo que parte fique fora).
Tetos worker atuais falham. Candidato **raw 4 / lógico 12 / físico 14 GiB**, SQL
10/12/14 GiB preservado, deixaria 1.014.014.338 B lógicos e 416.427.008 B físicos.
**Não autorizado/implementado:** essa revisão dos tetos só pode ser considerada
com armazenamento admitido e evidência de taxas/tamanhos; não é atalho para
levantar a coleta atual. Quotas continuam diferentes e as exceções financeiras
continuam exigindo medição de todo o banco.

### CPU e latência

Host 8 CPUs, RAM 16.366.653.440 B; memória disponível do host não é o orçamento
do container. Na amostra, MemAvailable **14.498.204 KiB**, swap zero; usar o valor
em KiB para reprodução. CPU não ociosa host **6,161%** (iowait 0,0125%).

| Serviço | Limite CPU / memória | Uso médio em 40 s | Throttling em 40 s |
| --- | --- | --- | --- |
| PostgreSQL | 1 CPU / 1 GiB | 0,250 core; memória 961.282.048–969.031.680 B | 4/248 períodos, 0,247 s throttled |
| API | 0,75 CPU / 384 MiB | 0,213 core; memória 277.405.696–285.097.984 B | 49/218 períodos, 4,847 s throttled |
| Web / Nginx | 0,25 CPU / 128 MiB cada | 0,0034 / ~0 core | zero observado |
| Coletor parado | 0,5 CPU / 256 MiB | não medido em execução | desconhecido |

`core = Δusage_usec / (1e6×Δsegundos)`; períodos throttled não são percentual
de CPU do host nem diretamente tempo de parede perdido. RAM cgroup inclui
cache. Folga do host não elimina throttle na API. Perfil com coletor: 3 CPUs,
2048 MiB, pools 7 + reserva 8; clientes observados 3/40, zero idle-in-transaction.
Não redistribuir limites nesta sessão.

Cinco sondas sequenciais cabeça/política: **89,94–108,08 ms** de parede docker/psql;
readiness HTTP 200 **1,806–74,407 ms**. Catálogo 107,51–197,07 ms. Não medem ticket,
fill, recovery completo ou replay; não são p95 de sete dias.
Gate futuro: fixture representativa descartável com decisões grandes, captura,
equity e um replay concorrente; medir latência, CPU por cgroup, wait/cancelamentos,
locks e temp_bytes, sem aumentar budgets. Após admissão, sete dias de p95 CPU/
latência e ausência de throttling sustentado prejudicial; ticket p95 <1 s e
frescor ≤5 s quando fonte disponível. Não certificar isso com a sondagem atual.

## 5. Alternativas externas concretas e custo

**Recomendação técnica condicional:** primeiro demonstrar o orçamento otimizado;
se for viável, avaliar **volume PG de 500 GB no host atual** e os tetos candidatos
acima. Sem isso, permanecer contido. Descarte autorizado é conjunto vazio;
compressão/rebuild de índices não possui economia, scratch, WAL e locks medidos.
Não usar suposta recuperação de 41,66 GB como fonte de capacidade.

Para comparar volumes separados, admitir conservadoramente 5% indisponíveis:
`A_novo = 0,95D − banco(210.895.132.351) − WAL(805.306.368)`.
Cada filesystem deve passar sozinho. Cópia antiga no root **não desaparece** com
anexação: o root segue abaixo de 40% até uma transferência verificada e liberação
específica da cópia duplicada, com autorização própria. Isso não é descarte do
corpus, mas tampouco está autorizado por esta sessão. Sem essa etapa o lançamento
continua bloqueado. Não somar espaços livres de mounts distintos.

| Alternativa | Bytes/90 dias e risco | Custo adicional de referência mensal |
| --- | --- | --- |
| A — Host atual, somente otimização | Nenhum byte recuperado; 40% e worker atual continuam falhando. Pode entregar código contido. | Sem nova contratação; fatura existente desconhecida |
| B — Mesmo host + volume **500.000.000.000 B**, otimização + revisão delimitada de tetos | A inicial volume 263,300 GB (52,66%); A90 pico otimizado, após reserva 4GiB: **246,045 GB (49,21%)**. Root exige transferência/liberação verificada. I/O remoto, formato novo e taxas precisam teste. | `500×p`; sensibilidade p=US$0,05/GB-mês: **US$25**, antes de tributos; total `T_atual+25+extras` só cabe se `T_atual+extras≤55` |
| C — Mesmo host + **1.000.000.000.000 B**, sem redução suficiente | Normal: A90 312,557 GB (31,26%); **pico falha**. Não resolve quotas worker/SQL. Não escolher para critério conservador. | `1000×p`; sensibilidade **US$50**, mais fatura atual/extras |
| D — Volume **1.600.000.000.000 B**, crescimento atual/pico | Pico: A90 461,110 GB (28,82%) depois da reserva; passa triagem de disco, mas requer quotas muito superiores, CPU/I/O e custo não admitidos. | `1600×p`; sensibilidade **US$80 só de volume**, sem compute/IP/IA/tributos: não cabe no teto total |
| E — Migração CX43 + volume 500 GB, orçamento otimizado | Mesmos gates de B, novo host/CPU shared, estoque, transferência, reconciliação e perímetro. Não há teste de destino. | Base pública US$18,49 + IP cotado + `500×p` + extras; com p=0,05: **US$43,49 antes de IP/extras**. Não comprova economia |

Consulta oficial em 28/09: [tabela Hetzner](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/)
publica CX43 US$18,49 e CPX42 US$81,99, ambos sem IPv4/tributos; não são fatura
existente. [CX43](https://www.hetzner.com/cloud/cost-optimized/) aparecia indisponível.
A página de [volumes](https://www.hetzner.com/cloud/block-storage/) confirmou disco
em rede e dimensionamento 10 GB–10 TB, mas não expôs tarifa numérica na consulta.
Assim **p=0,05 é sensibilidade baseada na referência histórica de G2-10.1,
não cotação vigente autenticada**. Não afirmar preço contratado ou compra disponível.

Nenhuma fatura foi encontrada no contexto/repositório; host não revela plano
faturado, tributos, câmbio, consumo mensal ou outros recursos cobrados. Custo
recorrente real continua **desconhecido**. Obter conta/fatura discriminada de
compute, volume, IP, tráfego, IA e tributos/FX; não pedir segredo de acesso.
`T = compute+disco+IP+egress+IA+tributos/taxas`. Para migração, exigir
`T_destino≤80` e `T_destino≤0,8×T_atual`; coexistência/transferência é custo novo
separado, `C_90 = 3×T_destino+C_origem(h)+transferência+temporários`, com h/cobrança
cotados. Desligar não encerra cobrança, conforme [faturamento oficial](https://docs.hetzner.com/cloud/billing/faq/);
não cancelar origem/IP nem alegar economia sem encerramento autorizado e observado.

**Decisão realmente ausente:** aceitar ou recusar a ampliação delimitada de
armazenamento e tetos de B (ou a migração E), preservando dados e critérios.
Preparado para revisão: 500 GB PG, worker 4/12/14 GiB, SQL inalterado, total
recorrente ≤US$80, teste do orçamento otimizado obrigatório. O valor máximo final
em moeda da fatura e o custo de transição só podem ser aprovados depois da fatura
atual/cotação autenticada. Não solicitar compra cega nem presumir que a
sensibilidade de US$25 cobre impostos. Recusa mantém contenção, não reduz metas.
A decisão externa não bloqueia código independente em uma próxima sessão
explicitamente selecionada; não executar G2-12.2/3 nesta entrega.

## 6. Reprodução e aceite documental

Para repetir a medição, usar identidade SSH e mount real já documentados;
três amostras de catálogo/cgroup em 40 s, com os budgets da seção 1. SQL abaixo
é leitura por catálogo, não teste financeiro. Não executar agregação de payloads.

```sql
SELECT c.relname, pg_total_relation_size(c.oid) AS total,
       pg_relation_size(c.oid) AS heap, pg_indexes_size(c.oid) AS indexes,
       CASE WHEN c.reltoastrelid=0 THEN 0
            ELSE pg_total_relation_size(c.reltoastrelid) END AS toast
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relkind='r'
ORDER BY c.relname LIMIT 180;
SELECT raw_bytes,total_bytes,raw_quota_bytes,total_quota_bytes,hold
FROM btc_retention_policy WHERE dataset_id='btc-paper-v1';
SELECT wal_bytes,stats_reset FROM pg_stat_wal;
SELECT temp_bytes,temp_files,stats_reset FROM pg_stat_database
WHERE datname=current_database();
```

Se atingir o limite de 180 relações, ou alterar mount/schema/conjunto, reclassificar
antes de comparar. `pg_total_relation_size` inclui índices/TOAST; `df/statvfs`
mede filesystem; `pg_stat_*` só compara contadores sem reset/restart. CPU vem de
`/proc/stat` e `cpu.stat/cpu.max` do cgroup obtido pelo PID do container; memória
vem de `memory.current/max`. Não confundir docker stats descontando cache.
Para WAL/temp residentes, somar tamanhos somente dos segmentos WAL e diretórios
`pgsql_tmp` do PGDATA confirmado; evitar `du` recursivo do corpus.

Cálculo puro reproduzível (sem rede/PG e sem nova coleta):

```python
from math import isclose
GiB = 2**30
C, A = 322302373888, 87262253056
L, raw, physical = 6536828030, 2147899519, 3947839488
reserve = 4*GiB
capture = dict(raw=74769000, logical=132754000,
               physical=68914000, filesystem=90143759.186)
decision_l, decision_p = 4*19986848, 2*4*12932918
equity, jev = 2*60*4096, 4*65536
normal = capture['filesystem']+decision_p+2*(equity+jev)
optimized = dict(raw=250000, bars=100000, decisions=2*4*16384,
                 equity=equity, jev=jev)
assert L-6*GiB == 94377086
assert A-C/4-GiB == 5612917760
assert isclose(.4*C-A, 41658696499.2)
for days in (7, 30, 90):
    hours = days*24
    print('classes capture GB', days,
          {k:v*hours/1e9 for k,v in capture.items()})
    print('classes extra logical GB', days,
          {k:v*hours/1e9 for k,v in
           dict(decision=decision_l,equity=equity,jev=jev).items()})
    for name, rate in [('normal',normal), ('pico',2*normal),
                       ('otimizado',3e6), ('otimizado-pico',6e6)]:
        growth = rate*hours
        minimum = max((C-A)/.6, (C-A+growth+reserve)/.75)
        print(days,name,'growth GB',growth/1e9,'A GB',(A-growth)/1e9,
              'D minimum GB',minimum/1e9)
peak_l = L+2*sum(optimized.values())*2160
peak_p = physical+4*sum(optimized.values())*2160
assert peak_l == 11870887550 and peak_l < 12*GiB
assert peak_p == 14615958528 and peak_p < 14*GiB
assert raw+2*optimized['raw']*2160 < 4*GiB
for D, rate in [(500e9,6e6), (1000e9,normal), (1600e9,2*normal)]:
    initial = .95*D-210895132351-805306368
    final = initial-rate*2160-reserve
    print('volume GB',D/1e9,'A0 GB',initial/1e9,'A90 GB',final/1e9)
    assert initial >= .4*D and final > .25*D
```

Validação desta fatia: contas e somas por classe conferidas, snippet executado,
links locais/scan/diff e checks obrigatórios do PR. Sem alteração de SQL financeiro
ou testes de escrita produtivos; fixtures de CI não demonstram capacidade de produção.
Deploy dispensado por documentação. **Aceite observado: diagnóstico e plano;
ativação, sete dias, 90 dias e custo completo não aceitos.**

### Contabilidade da prontidão visível — G2-13.1

A leitura `btc.operational-readiness.v1` reutiliza `btc_market_records` e os
registros de conta já contabilizados; não cria série SQL, arquivo ou cópia
retida adicional (crescimento persistente incremental da funcionalidade: zero).
O histórico faz duas buscas indexadas por intervalo, 672 intervalos de 15min
em sete dias, dentro do budget HTTP/SQL existente de 1,5s. Mede somente bordas
com tolerância de 60s: lacunas internas não são medidas e ausência de registro
continua desconhecida. Não substitui o aceite contínuo de sete dias.

CPU acumulada, RSS e uptime vêm do processo API, sem atribuir essas medidas ao
host. Não há produtor novo, timer, serviço contratado, leitura de docker.sock
ou reset de contadores. Fontes de host/container não compartilhadas com a API
ficam indisponíveis. A série histórica de `capacity_series.py` permanece
inativa/inalterada e não é reinterpretada como telemetria atual. Nenhuma destas
leituras admite coleta nem resolve a folga/fatura ainda bloqueadas em G2-12.
