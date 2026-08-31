# HOTFIX — `RESOLUTION_MARKET_METADATA_VERSION_MISSING` recorrente

Você vai achar a causa raiz e corrigir o erro recorrente do serviço de resolução, ATÉ O
FINAL: diagnóstico medido → código → testes → merge → CD → rebuild de profile → verificação
em produção → registro no HANDOFF. Um único PR.

## Autorização e regras permanentes

- **SSH autorizado pelo proprietário**: `ssh -i ~/.ssh/id_ed25519 root@178.105.65.251`
  (checkout em `/opt/ganso-market`). Leitura livre para diagnóstico (SQL somente-SELECT,
  logs, `docker inspect`). Escrita no servidor SOMENTE nos passos de deploy descritos aqui.
  Nunca copie código manualmente (merge na `main` → CD); nunca imprima secrets.
- Ordem de fontes: este prompt → RFC-012 → código. Leia `docs/HANDOFF.md` (seções da sessão
  2026-08-31) e o `git log` antes de editar; RE-MEÇA a taxa do erro antes de codar — se já
  foi corrigido por outra sessão, PARE e registre.
- Deploy são TRÊS passos; o CD NÃO troca imagem de profile (mas REINICIA os containers a
  cada merge); evidência de revisão é `cat /etc/ganso/release-sha` dentro do container.
- Invariantes: fail-closed fica — pontuação sem metadata continua NÃO inventando mapeamento
  (a migration 0012 falha fechado de propósito para payload ambíguo). Nada de migration sem
  necessidade comprovada; se precisar, é a **0017** (a 0016 já existe — índice da FK de
  panel_snapshots). `make verify` verde antes do PR.

## O sintoma, medido (2026-08-31)

- `RESOLUTION_MARKET_METADATA_VERSION_MISSING` apareceu como burst único em 28/08 21:51Z e
  virou **recorrente: ~63 ocorrências/dia, 91 mercados distintos, cada um 1 vez,
  auto-recuperado no ciclo seguinte** (medição registrada no HANDOFF da sessão 31/08).
- Comportamento atual é fail-closed correto (o mercado fica de fora daquele ciclo de score e
  volta no seguinte), mas a taxa indica um padrão sistemático, não um caso raro: algum
  caminho põe mercados no conjunto de pontuação ANTES de a primeira versão de metadata
  existir.
- Contexto de código: o serviço de resolução pontua o universo atual + os que saíram sem
  resolver em 7 dias; o mapeamento de token afirmativo vem de
  `polymarket_market_metadata_versions` (migration 0012, prospectiva); quem persiste
  observações de metadata é o recorder (registry + varredura de pendentes,
  `applyMarketMetadataObservation`).

## Tarefa

1. **Diagnóstico dirigido primeiro** (produção, read-only): dos mercados que dispararam o
   erro nas últimas 24 h, medir — instante de entrada no universo vs instante da primeira
   versão de metadata; se são recém-entrados, recém-saídos ou re-observados; qual job os
   pontuou (state_tick? recompute de boot?). A hipótese a testar: janela entre o mercado
   entrar no conjunto de pontuação e a primeira observação de metadata chegar (corrida entre
   registry/varredura e o ciclo de score). NÃO code antes de ter a causa medida.
2. **Correção conforme a causa** — candidatas, em ordem de preferência: persistir a
   observação de metadata no MESMO evento que põe o mercado no conjunto (como o #27 fez para
   a varredura de pendentes); ou tolerar explicitamente a primeira janela com um skip
   silencioso tipado (`warn` → `debug` com contador), se a medição mostrar que é
   transitório-por-construção. NUNCA inventar mapeamento de token — a direção fail-closed
   não muda.
3. **Carona (opcional, só se a causa for adjacente):** um `GET /polymarket/decisions`
   devolveu **500** em 31/08 18:21:11Z, no primeiro acesso à aba Portfólio após a primeira
   poda de `portfolio_decisions` (449 k linhas). O proprietário não priorizou; se você tocar
   o mesmo módulo, reproduza (read-only) e registre a causa; corrija apenas se for trivial e
   coberto por teste.

## Testes

1. Regressão da causa raiz encontrada (verificada FALHANDO no código anterior).
2. O fail-closed continua: mercado genuinamente sem metadata segue fora do ciclo, com evento
   tipado.
3. Suíte do módulo resolution + `make verify` verdes.

## Deploy e verificação

1. Merge com CI verde → CD → confirmar código no disco por grep → rebuild do
   `polymarket-resolution` (e do `polymarket-recorder`, se o fix tocar registry/varredura).
   Conferir `release-sha` nos containers.
2. Verificação em 24 h: taxa de `RESOLUTION_MARKET_METADATA_VERSION_MISSING` caindo de
   ~63/dia para ~0 (ou para o residual explicado pela causa); zero regressão em
   `SCORES_RECOMPUTED`/`GRAPH_BUILT`; zero erros novos.

## Encerramento (obrigatório)

- Atualizar `docs/HANDOFF.md`: causa raiz medida, correção, taxa antes/depois; status em
  `prompts/roadmap/README.md`.
- Condições de parada: causa não confirmada por medição; correção exigir afrouxar o
  fail-closed do mapeamento; `make verify` vermelho.
