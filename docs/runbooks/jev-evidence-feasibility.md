# JE03 — Evidência protegida e viabilidade inicial

Contrato publicado desativado: `jev.evidence.v1`, política `jev-evidence-v1`, estimador `jev-feasibility-v1`. Não é admissão de operação. JE02 integrada pelos PRs 337/338; os contratos e manifestos 1/3/5min são reaproveitados. As migrations históricas não foram alteradas.

## Evidência e replay

`storeJevEvidence`/`storeJevEvidenceTx` persistem lotes atomicamente e verificam hashes, ownership, versões, relógio e idempotência. Guardar as entradas selecionadas completas com IDs, hashes e horários originais; contexto comum e estado próprio; pergunta/decisão inclusive **hold**; resposta original como string sem reformatar e modelo versionado; ordens/fila/parciais/cancelamento; fills, fees, funding assinado; cobertura/gaps/counters; falhas explícitas, custo desconhecido como indisponível e propostas aposentadas. Os validadores financeiros/da venue continuam nos respectivos escritores. O escritor de evidência não fabrica recibos financeiros nem transforma timeout em hold. Respostas de um lote podem servir paper/stress por participantes explícitos, registrados na mesma versão do perfil.

Cada contexto aponta para um bundle que contém todas as suas referências; cada decisão aponta para seu contexto e resposta recebida da mesma requisição. `readJevEvidence` devolve originais e closure transitiva de objetos/sources em snapshot consistente; não chama nem reinfere JEV. Versões/manifestos e ledger do registro JE02 continuam imutáveis e permanentes.

Dados de entrada podem ser snapshots selecionados autocontidos ou referências explícitas ao corpus BTC. `jev_evidence_sources` protege raw/bars/logs necessários por FK e guard SQL; o seletor BTC os exclui. A closure BTC original também é devolvida no replay. Raw irrelevante não é copiado nem pinado como exigência do modelo. Não desproteger pins históricos; eles continuam permanentes.

`closeJevEvidence` acrescenta um encerramento imutável, nunca anterior ao início ou à última evidência funcional, nem futuro. Isso registra encerramento evidenciário; não fecha posição nem admite sucessora. Novas evidências funcionais não podem trazer horário posterior ao encerramento. Ledger/resultados/versões posteriores continuam permanentes.

Expiração só ocorre após encerramento **+180 dias UTC**, com HOLD liberado, sem pin e sem nenhum dependente. Referências de experimento ativo, encerramento mais recente ou objeto permanente alongam a retenção transitivamente. `retainJevEvidence` é uma biblioteca explícita de dry-run/execução em até 500 folhas; não há rota, timer ou chamada de startup. O contrato de exclusão SQL exige versão/escopo, verifica as mesmas proteções e contabiliza a redução somente na transação concluída. Truncamento, atualização, alteração de edges e liberação de pin são bloqueados. **Nenhuma exclusão ou liberação de HOLD foi executada em produção por JE03.**

## Tetos e recursos revalidados

Os números 10/12GiB SQL e 4/6/4GiB coletor do desenho inicial descrevem configurações históricas. A base já contém a migration 0050 e política v3 `btc-storage-200gb-80pct.v1`, aprovadas anteriormente. JE03 **não aumenta limites**. A configuração v1 do repositório segue desabilitada; o overlay efetivo de produção é v3/enabled, mas seu processo está parado.

| Camada | Limite efetivo observado |
| --- | --- |
| SQL, quota raw/total e budget | 200.000.000.000 bytes (GB decimal); parada de coleta/admissão em 160.000.000.000 |
| Coletor v3 | raw/lógico/físico limitados ao menor teto SQL/160 GB; piso de disco 25% mais reserva 1GiB; oito conexões reservadas |
| Coletor v1 histórico | raw 4GiB/lógico 6GiB/físico 4GiB, permanece distinto do SQL |
| PostgreSQL | 1 CPU/1GiB, máximo 40 conexões; cinco client backends na captura |
| API / coletor | 0,75 CPU/384MiB e 0,5 CPU/256MiB; novo worker JEV não iniciado |
| Host | oito CPUs, 16.366.653.440 B RAM, MemAvailable 14.730.678.272 B, swap zero |
| Disco | 286.036.226.048 B livres/322.302.373.888 B totais (88,75%) |

Leitura com SSH/identidade fixada em **07/10/2026 23:07–23:09 America/Sao_Paulo** (08/10 02:07–02:09 UTC). PostgreSQL 18.4: banco 11.919.226.559 B; corpus alocado 9.706.037.248 B; cobrança lógica 15.395.962.266 B/raw 2.859.111.294 B; HOLD=true e 4.338 pins. API/web/PG saudáveis; coletor `exited(1)` com diagnóstico anterior `BTC_COLLECTOR_WRITE_OR_CAPACITY_FAILED`/55P03, engine parado. Registro JEV vazio/executor off. Capacidade pontual livre não comprova throughput, cobertura, CPU/RAM sustentados, picos de conexões nem latência do provedor.

A migration 0052 inclui objetos/edges/pins/encerramentos JEV na cobrança lógica **compartilhada** e na leitura física `btc_storage_allocated_bytes`. Nenhum pool separado que contorne os limites. Admissão funcional para no teto de 160 GB; a reserva restante só permite evidência essencial (ledger/resultados/custos/encerramento/pins) até o budget de 200 GB. Uma falha reverte o lote; o consumidor futuro deve pausar entradas e preservar risco/proteção/reconciliação. Não fazer retry descartando dependências ou relabelando dados como essenciais.

## Estimativa reproduzível e limites

Fixture delimitada de três perfis/seis contas, 10 ciclos por perfil (30 lotes/720 objetos), usando `buildJevContext` de JE02: book top5, 60 trades selecionados, 15 barras fechadas e originais necessários, posições paper/stress distintas, holds, respostas compartilhadas, fila/parcial/cancelamento, funding, cobertura, timeout, custo desconhecido, proposta aposentada, ledger/resultados/versões. A fixture identifica sua origem; não prova resultado financeiro nem observação prospectiva. Replica snapshots por conta/ciclo deliberadamente; uma futura deduplicação só reduz estimativas após comprovar replay e fechamento. Não pressupor que o byte count seja corpus máximo da venue.

Medição no PostgreSQL 18.4 arm64 descartável **1 CPU/1GiB**: incremento lógico **8.912.730 B**, crescimento físico **2.555.904 B**, 30 lotes em aproximadamente 4,24s. Isso inclui overhead lógico e índices físicos; TOAST comprime repetições da fixture. Não projetar esse tempo como latência produtiva/JEV, nem crescimento físico como teto de WAL, bloat, manutenção ou novas fontes pinadas. Admitir somente após medir esses componentes no workload efetivo. O máximo do request JSON ilustrativo é **23.643 bytes UTF-8**. Perguntas futuras ainda precisam de contrato e medição efetivos; este payload não habilita transporte.

Tarifa pública de [`jev-1.13.0`](https://docs.typesafe.ai/models), reconferida em 07/10 local: **US$0,042/milhão de tokens de entrada**, output gratuito. Preço público não é tarifa verificada da credencial. Hipótese `ceil(bytes/4)` = **5.911 tokens/lote**; sensibilidade de um byte por token = 23.643. Nenhuma tokenização, custo ou latência reais foram medidos; custos desconhecidos permanecem indisponíveis, nunca zero.

| Cenário de planejamento, três lotes/perfis por ciclo | Lotes/mês (30d) | JEV/mês, hipótese 5.911 tokens | Corpus lógico 90d | Corpus físico 90d | Lógico 270d com sucessores |
| --- | ---: | ---: | ---: | ---: | ---: |
| Sempre 60s | 129.600 | US$32,174756 | 115,509 GB | 33,125 GB | 346,527 GB |
| Envelope rápido 30s + cooldown 60s (1/3 do tempo em 2s) | 1.382.400 | US$343,197389 | 1.232,096 GB | 353,329 GB | 3.696,287 GB |
| Sempre 2s, apenas stress de dimensionamento | 3.888.000 | US$965,242656 | 3.465,269 GB | 993,738 GB | 10.395,808 GB |

Um experimento encerrado no dia 90 conserva **o mesmo** corpus até o dia 270; não produz chamadas depois de encerrar. A coluna 270d dimensiona sucessores que continuam coletando enquanto predecessores seguem protegidos. Objetos permanentes não expiram após 270d e continuam acumulando; baseline/capacidade devem ser revalidados antes de cada admissão. A coorte única de 90d/60s + baseline ocupa cerca de 130,905 GB lógicos (<160 GB); sucessores e modo rápido falham na projeção. Pins adicionais/dependências maiores podem agravar o consumo.

O pool agregado **US$8 operação** suporta aproximadamente **32.224 lotes/mês** nessa hipótese, abaixo dos 129.600 para três perfis/60s; fração rápida admissível estimada = zero. A sensibilidade de um byte/token dá US$128,693578/mês já em 60s. O pool **US$2 geração/validação** é separado (até 11.904 chamadas com hipótese independente de 4.000 tokens, sem incluir retries/mudanças de tarifa). Não emprestar geração à operação nem somar o custo integral de lote atribuído a cada conta como fatura real. Infraestrutura fica fora do resultado/aprovação da estratégia; teto de planejamento US$80 preservado.

Para reproduzir, usar somente PostgreSQL descartável com o harness existente:

```sh
GANSO_JE03_ESTIMATE_PATH=/tmp/jev-fixture-estimate.json make test-postgres
npm run build --workspace @ganso-market/api
npm run jev-feasibility --workspace @ganso-market/api -- \
  /tmp/jev-fixture-estimate.json 15395962266 9706037248
```

O relatório opcional gerado é local, não um recibo obrigatório. Physical growth/elapsed variam por ambiente; o resultado identifica recurso medido ou harness sem limites explicitados. Fixtures/contagens/cálculos, versão de envelope e tarifa são rastreáveis no código e teste. O estimador aceita amostra e baseline explícitos, não acessa secrets/config/transport, declara `paid_calls=0`, `admitted=false` e tokens efetivos indisponíveis.

## Gates antes de admitir operação

GJ12.2 continua a seleção própria do proprietário. Antes dela: recuperar coletor, frescor e reconciliação; medir gaps internos/cobertura com denominador; confirmar credencial/modelo/tarifa e usage efetivos sem custo desconhecido; comprovar payload/custo dos três pares, holds/falhas e uso rápido dentro de US$8; medir deadline 1,5s/TTL 2s; dimensionar corpus protegido completo, pins, sucessores, permanente e headroom; medir CPU/RAM do cgroup, conexões (reserva de oito), escrita/COMMIT/WAL, bloat e disco ≥25% +1GiB sob carga real compatível. A atribuição econômica de geração/validação também permanece contrato futuro obrigatório. Nenhuma credencial/capacidade indisponível bloqueia a publicação técnica desativada; ambas bloqueiam ativação.

Não contratar API/infra, elevar quotas, apagar protegido, criar backup ou ativar signer/live para resolver a estimativa. Risco, saídas urgentes e reconciliação não dependem de chamadas JEV. A estimativa atual **reprova admissão**; otimização de payload/corpus e confirmação efetiva pertencem aos próximos contratos explicitamente selecionados, sem flexibilizar limites por JE03.

Rollback usa código compatível com o schema 0052 e com referências JEV nas fontes BTC. Pausar novas entradas e escritores se necessário, preservar proteção/reconciliação, eventos e pins; nunca reverter migration nem usar seletor BTC antigo que desconheça novos dependentes. Não religar coletor por consequência da publicação.
