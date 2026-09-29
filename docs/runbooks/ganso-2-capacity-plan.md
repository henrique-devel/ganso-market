# G2-12 — Plano de capacidade e custo

## Piloto aprovado — 28/09/2026

O proprietário aprovou o item 2 e ampliou os tetos do worker propostos no item 1
para **raw 4 / lógico 16 / físico 12 GiB**. A [decisão registrada](../ops/DEVELOPMENT_AUTHORIZATION.md)
substitui os 4/11/8 GiB da proposta histórica abaixo. O perfil é
`btc-pilot-4-16-12.v1`, somente com configuração v2 e início/fim UTC explícitos,
duração máxima de seis horas. Configuração v1 conserva 4/6/4 GiB.

**SQL inalterado:** raw 10/lógico 12/recusa física 14 GiB. O worker aplica o menor
teto por classe e publica `limits` versus `effective_limits`, além das quotas
observadas. Assim os limites efetivos são **4/12/12 GiB**, enquanto as quotas
SQL observadas forem estas. A aprovação não aumenta a quota SQL para 16 GiB.
Nenhuma migration, descarte, mudança de HOLD, banca ou risco integra a alteração.

Recalcular preflight com a ocupação atual, mínimo entre worker e SQL, margem de
20% do horizonte de pico e reserva de 4 GiB do filesystem. Usando apenas o corte
histórico da proposta: horizonte lógico 10,43h, físico 31,11h e raw 14,36h; 6h de
pico continuam cabendo, com totais projetados de 2,84/10,23/6,21 GiB. São contas
de referência, não a admissão real, que deve ser refeita depois do deploy.

Prazo absoluto persiste após restart; o timer do processo evita extensão por
recuo do relógio. Expiração recusa bootstrap e novas capturas/barras, fecha feed e
pool e publica `BTC_COLLECTOR_PILOT_EXPIRED`. SQL já iniciado conserva budgets
existentes de 5/6s e pode terminar depois do instante de corte: commit confirmado
é preservado, nunca reenviado nem descrito como rollback. Nenhuma nova transação
de captura/barras começa após detectar expiração. Falha real em voo continua
falha, não é mascarada como parada normal. Sem restart automático ou rearmar risco.

O [runbook do coletor](btc-collector.md) descreve configuração e validação. A
retomada e seus horários efetivos são registrados somente depois da observação
produtiva na linha G2-12.3. Aprovação não comprova execução nem sustentabilidade.


## Proposta histórica pós-Polymarket — decisão substituída pela aprovação acima

Preparada em **28/09/2026, 21:14–21:15 America/Sao_Paulo** (29/09 00:14–00:15 UTC),
a pedido do proprietário para iniciar G2-12.3 e apresentar as autorizações necessárias.
Base `97927d8`; release produtiva `09f7fdd`, schema 49. **Diagnóstico e proposta;
nenhum novo teto, perfil piloto ou início do coletor foi aplicado.** O plano v1
abaixo permanece histórico: falta de disco e compra de volume já não são a
premissa desta proposta. As medições detalhadas permanecem no diagnóstico local;
este registro contém somente agregados de capacidade e a decisão revisável.

### Medição e impedimento atual

Consultas SSH em READ ONLY, statement 1,5 s/lock 250 ms, catálogo e três últimas
decisões por índice. Sem dump, varredura do corpus, escrita, restart ou teste
financeiro produtivo. PostgreSQL preserva o início de 07/09; coletor está `created`,
sem start, `restart=no`. HOLD BTC ativo, zero triggers de usuário desabilitados.
Mount de capacidade e volume PG têm o mesmo dispositivo. Timers exclusivos do
legado foram retirados e estão inativos; não reconstruí-los para o piloto.

| Medida | Observado | Critério atual |
| --- | ---: | --- |
| Filesystem disponível / total | 291.040.284.672 / 322.302.373.888 B (90,30%) | Passa alvo de 40% e piso de 25% + reserva |
| Banco completo | 7.385.454.271 B | Não equivale ao contador lógico nem ao corpus físico do guard |
| Raw BTC | 2.147.899.519 B (2,00 GiB) | Abaixo do worker de 4 GiB |
| Lógico BTC | 8.417.131.678 B (7,84 GiB) | Acima do worker de 6 GiB |
| Físico das seis tabelas do guard | 5.186.740.224 B (4,83 GiB) | Acima do worker de 4 GiB |
| Quotas SQL / recusa física | 10 GiB raw / 12 GiB lógicos / 14 GiB físicos | Preservadas; independentes do worker |

Cada uma das três decisões recentes ainda cobra aproximadamente **19,99 MB
lógicos**; a evidência principal ocupa aproximadamente **12,93 MB**, embora a
projeção adicional já tenha caído para aproximadamente **1,25 kB**. Logo a redução
G2-12.2 não resolveu o crescimento total. A baseline continua produzindo evidência
mesmo em REDUCE_ONLY e com coleta parada. Aumento de teto dá uma janela finita;
não demonstra operação contínua. Última captura permanece em 26/09 22:07 UTC.

Recursos atuais: host 8 CPUs/15,24 GiB; limites PG 1 CPU/1 GiB, API 0,75/384 MiB,
web e gateway 0,25/128 MiB cada, worker 0,5/256 MiB. Com migration, orçamento de
3 CPUs/2 GiB; pools 7 + 8 conexões de reserva diante de max_connections=40.
Foram vistas 3 conexões e zero idle-in-transaction. Uma amostra encontrou API
47,17% CPU/248,3 MiB e PG 37,51%/299,2 MiB; não é p95 nem prova sob coleta.
**Não há justificativa atual para aumentar cgroups/pools/timeouts.**

### Duas decisões específicas solicitadas

1. **Perfil temporário do coletor com raw 4 / lógico 11 / físico 8 GiB**, válido
   somente na janela piloto aprovada. Altera os tetos de armazenamento do worker,
   sem alterar banca, risco ou quotas SQL. Preserva 1 GiB de diferença para a
   quota lógica SQL. Os limites padrão 4/6/4 permanecem para execução sem esse
   perfil; não criar aumento irrestrito por variável de ambiente.
2. **Piloto de até seis horas**, com prazo UTC absoluto e parada automática,
   antes do aceite de sustentabilidade de 90 dias e da comprovação da fatura
   total. É uma exceção somente para medição operacional no host existente,
   sem contratação/novo consumo pago autorizado. Não aprova lançamento contínuo,
   estabilidade de sete dias, avaliação econômica, ordens de teste ou rearme da
   baseline. Custo existente informado no PRD é US$80/mês; fatura discriminada
   continua necessária para o aceite do total, não presumida como zero.

A seleção de G2-12.3 já cobre implementação, testes, PR/merge, deploy aplicável,
configuração e start seletivo após os gates. Não pedir essas permissões novamente.
A [RFC-053/S2](../rfcs/RFC-053-ganso-2-prontidao-operacional.md#s2) exige decisão
explícita para dispensar o critério de 90 dias; o [escopo vigente](../SCOPE.md)
não autoriza aumentar caps. **As duas decisões acima continuam pendentes.**
Não é necessário autorizar compra de volume, migração, remoção de dados BTC,
liberação de HOLD, Jev, dinheiro real ou backup para este piloto.

### Dimensionamento reproduzível da janela proposta

Taxas de captura são referências históricas, não medições com o worker atual.
Uma baseline, Jev zero, sem export/replay volumoso e sem novas ordens provocadas.
Reserva lógica de 491.520 B/h para equity e 1 MiB/h para demais eventos/controle;
reservas são envelopes de planejamento, não redução autorizada dos contratos.
A projeção física usa uma cópia grande por decisão e 2x dos envelopes auxiliares.
O pico é **2x a referência**, uma sensibilidade, não máximo garantido de mercado.
Os guards independentes e o prazo encerram o piloto antes se houver excesso.

| Classe | Referência B/h | Pico B/h | Total projetado após 6h de pico | Teto piloto |
| --- | ---: | ---: | ---: | ---: |
| Raw | 74.769.000 | 149.538.000 | 3.045.127.519 B / 2,84 GiB | 4 GiB |
| Lógico | 214.241.488 | 428.482.976 | 10.988.029.534 B / 10,23 GiB | 11 GiB |
| Físico do guard | 123.725.888 | 247.451.776 | 6.671.450.880 B / 6,21 GiB | 8 GiB |

Lógico/h = 132.754.000 + 4x19.986.848 + 491.520 + 1.048.576.
Físico/h = 68.914.000 + 4x12.932.924 + 2x(491.520 + 1.048.576).
Filesystem/h = 90.143.759,186 + 4x12.932.924 + 2x(491.520 + 1.048.576).
Depois de 6h a 2x e reserva adicional de **4 GiB** para WAL/temp/operação,
restariam aproximadamente **285,01 GB disponíveis**, acima do piso e do alvo.
Reserva não é espaço bloqueado nem afirma máximo de WAL/temporários. Sua ocupação
real e a de todo o banco precisam ser amostradas junto do corpus do guard.

Horizonte linear de pico: raw 14,36h, lógico **7,92h**, físico 13,75h no corte.
Antes do start, recalcular tudo; escolher duração <= min(6h, 80% do menor horizonte
positivo), arredondada para baixo em minutos. Se não couber sequer 1h, não iniciar
nem aumentar novamente o teto. Contadores continuam crescendo enquanto se aguarda.
Assim a aprovação de até 6h não promete seis horas a partir de uma medição vencida.

O mesmo cenário de filesystem em 30 dias deixaria 78,01 GB após a reserva,
abaixo do piso; em 90 dias não cabe. As quotas internas acabariam muito antes.
**A meta de 90 dias permanece não demonstrada.** Prioridade posterior: reduzir a
evidência total por decisão e comprovar cadência/tamanho da captura, preservando
ledger, pins, referências e compatibilidade. Comprar espaço não resolve sozinho
as quotas, a amplificação de escrita ou o custo das consultas.

### Sequência de execução após a decisão

- Implementar e testar o perfil piloto com prazo absoluto, compatibilidade da
  configuração anterior e recusa de prazo ausente/vencido, perfil desconhecido
  ou duração excessiva. Expiração precisa interromper coleta e persistência,
  ser visível no health e continuar válida após restart; nunca renovar por boot.
  Testar fronteiras raw/lógico/físico, quota SQL, disco e encerramento sem retry.
  Esse mecanismo ainda não foi implementado por esta revisão documental.
- Revalidar preflight, versão/identidade, transações/CPU/RAM/temporários, HOLD,
  quotas e hashes/contagens de controle; anotar IDs/inícios dos serviços. Sem
  elevar pools/cgroups/timeouts ou reiniciar PG. Preservar REDUCE_ONLY da baseline.
- Publicar pelo fluxo autorizado com coletor ainda parado. Só então configurar
  a janela concreta, validar o Compose efetivo e iniciar somente `btc-worker`.
- Checagem inicial por amostras independentes: commits/canais reais, livro <=2s,
  contexto <=5s quando a fonte disponível, gaps registrados, taxas de crescimento,
  CPU/RAM/locks/temp/WAL e serviços não afetados preservados. Falha terminal,
  inconsistência ou projeção sem margem encerram a tentativa; sem loops de restart.
- Janela expira mesmo sem chat aberto. No retorno, conferir parada, resultado,
  crescimento e próxima ação; nada de extensão automática ou relógio de sete dias
  iniciado por antecipação. A parada do coletor não promete parar evidências
  financeiras/decisões independentes produzidas pela API.

**Validação desta revisão:** cálculos determinísticos e margens conferidos,
leituras produtivas limitadas e confirmação dos limites no código instalado.
Sem teste de carga/fill produtivo. G2-12.3 continua `blocked` para start até a
aprovação específica, implementação dos controles e preflight final.

---

# Plano v1 de G2-12.1 — histórico anterior à retirada da Polymarket

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
