# RFC-018 — gates mensuráveis e calibração: as decisões de 27/08 viram código

Você vai implementar as três decisões de calibração pendentes do proprietário (27/08) e
fechar as lacunas mecânicas dos gates, ATÉ O FINAL: RFC → código → testes → merge → CD →
rebuild → verificação → HANDOFF.

## Autorização e regras permanentes

- **SSH autorizado pelo proprietário**: `ssh -i ~/.ssh/id_ed25519 root@178.105.65.251`
  (checkout em `/opt/ganso-market`). Leitura livre; escrita SOMENTE em deploy. Nunca
  imprima secrets.
- Ordem de fontes: este prompt → decisões no HANDOFF (seção "calibração da RFC-013",
  27/08) → RFC-013/RFC-012 → código. Leia HANDOFF e `git log`; re-meça antes de codar.
- Deploy em TRÊS passos; se um PR mudar `config/` e o código que a lê, MESMA janela
  (cunhagem de versão: o TTL 180→90 muda `retention.ts`, não config versionada — confira).
- Invariantes: parser recusa afrouxamento de gate (`PORTFOLIO_CONFIG_GATE_LOOSENED`);
  tabelas `protected` intocadas; guard de escopo dos módulos; `make verify` verde por PR.

## Escopo (um PR por item, na ordem)

### 1. Decision log: escrever a entrada só quando o veredito muda (decisão 1, itens b/c)

- **MEDIR PRIMEIRO o fator de redução real** no log de produção: trocas de assinatura
  (veredito + reason_code + binding constraint) por mercado por dia — a decisão exige
  medição, não estimativa. Registrar o número.
- O ciclo de ENTRADA passa a gravar quando a assinatura muda (o ciclo de saída já faz
  isso); heartbeat opcional de 1 linha/mercado/hora se a prova "o motor olhou" precisar
  viver no log (hoje já existe fora dele, em `portfolio_gate_measurements`).
- **Registrar a interpretação** (item c): "toda intenção persiste" = toda intenção
  DISTINTA — a mesma leitura já aprovada para a saída; sem esse registro, escrever menos
  seria afrouxamento silencioso da tarefa 7.
- Só então TTL 180→90 em `retention.ts` (mudá-lo antes não muda nada — a quota poda
  primeiro; com (b), o TTL de 90 passa a ser o limite que vale).
- Atenção cruzada: NUNCA deixar a varredura do shadow replay (RFC-017) atravessar o deploy
  desta mudança numa mesma janela de análise.

### 2. Chave do cap `fonteResolucao`: adapter → família de cláusula (decisão 3)

- Fato que motivou: o Gamma popula `resolutionSource` em 2/98; o fallback `resolved_by`
  colapsa 460/570 rule versions no bucket "UMA" — o cap de 25% vira teto global do livro
  (US$ 250 de US$ 1.000), e `binding_constraint` viraria ruído.
- O número FICA em 0,25 (decisão explícita). Muda a CHAVE do bucket: família de cláusula de
  regra (léxico da RFC-012, `config/resolution-lexicon.json` + `rule_version`), com
  **fallback NOMEADO** para cláusula não classificável — um "unknown" silencioso recriaria
  o bucket gigante com outro nome.
- Muda comportamento de sizing: teste de que duas cláusulas diferentes deixam de
  compartilhar bucket e duas iguais continuam compartilhando; a dimensão gravada em
  `portfolio_exposures` muda de valor, não de nome.

### 3. G3: exercitar os três breakers que faltam

- Estado medido: `UMA_PROPOSED_OR_DISPUTED`, `RULE_CLARIFICATION` e `DATA_STALENESS` nunca
  exercitados (o G3 exige TODOS). Desenhar o caminho de exercício em paper que a RFC-013
  aceite como evidência: cenário injetado auditável (evento real sintético no ambiente de
  produção NÃO — a evidência tem que vir de dado real ou de mecanismo aprovado na RFC;
  se a RFC-013 não definir, PROPOR na RFC-018 e obter aprovação do proprietário ANTES de
  implementar — é mudança de o que conta como evidência de gate).

### 4. Caminho de registro de versão de modelo

- Hoje só o catálogo do boot registra versões; treinar/promover uma versão calibrada exige
  um caminho operacional (runbook o registra como pendência). CLI no padrão `gates-cli`
  (fora do perímetro HTTP), com as mesmas garantias de imutabilidade por conteúdo.

### 5. Caronas pequenas (se ainda abertas — re-meça)

- `FEATURES_WINDOW_FAILED` do paper ainda sem mensagem de erro (aplicar o padrão do #37).
- `portfolio_panel_snapshots`: medir `pg_column_size` em produção e REDECLARAR o TTL
  honesto (etiqueta de 30 dias vs janela real) — redeclarar, não inventar quota.

## Verificação em produção

- Item 1: taxa de escrita do decision log caindo pelo fator medido; janela retida crescendo
  na direção do TTL de 90; `entryProvenanceFor` continua íntegro (a provenance mora em
  `portfolio_position_entries`, protected — não regride).
- Item 2: `portfolio_exposures` com buckets por família de cláusula; nenhum bucket residual
  gigante sem nome; decisões com `binding_constraint` diversificado.
- Zero regressão nos gates (6 medições/hora, replay OK).

## Encerramento

- HANDOFF (fator medido, interpretação registrada, buckets novos, TTLs) + status no README
  da pasta. Condições de parada: qualquer afrouxamento de gate/config sem cunhagem; item 3
  sem aprovação prévia do proprietário para o mecanismo de evidência; `make verify`
  vermelho.
