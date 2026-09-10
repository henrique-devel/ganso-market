# RFC-031 — Frescor comprovado do livro e validade antes do encerramento

**Status:** draft — especificação solicitada em 2026-09-10; não implementada por este documento.
**Prioridade:** BTC horário após recuperação do feed e consultas.
**Dependências:** RFC-021 e RFC-037. **Blocos:** FRESH-02 e FRESH-03.

## Problema

Um livro pode permanecer igual porque o mercado está quieto ou porque perdemos o
feed. O snapshot periódico de cache em `bookpipe.ts` não diferencia esses casos.
A policy genérica usa GTC quando não recebe TTL; ordens que sobrevivem ao fim do
mercado consomem capacidade sem representar execução disponível.

## Contrato de frescor — FRESH-02

- Distinguir `last_market_message_at`, instante de confirmação externa e instante
  de persistência. PING/PONG prova transporte; persistir cache prova gravação;
  nenhum deles sozinho prova atualidade do livro.
- Um heartbeat pode registrar livro inalterado somente após observação válida do
  token via WS ou resposta REST `/book` recente, com origem e horário preservados.
  Uma consulta REST reutiliza cliente, orçamento e backoff existentes.
- A proposta inicial de 20 s é teto de observação para tokens BTC elegíveis,
  condicionada à capacidade medida. Livros ilíquidos não exigem tráfego fictício.
- Separar idade da última mudança de preço da idade da última confirmação do
  livro. Replays usam apenas evidência conhecida no instante da decisão.
- Sem confirmação externa, manter bloqueio por idade. Lacunas de stream continuam
  registradas mesmo se uma consulta REST conseguir preencher um livro isolado.
  A nova evidência não rearma automaticamente um switch global sem suas guardas.

## Contrato de validade — FRESH-03

Para mercados com `end_ts` confiável, a validade máxima da ordem passiva é o menor
entre TTL da estratégia e tempo restante menos margem de cancelamento. Essa margem
inclui latência observada; registrar seus parâmetros/versionamento. Quando o prazo
não comporta envio e cancelamento, recusar nova entrada com razão explícita.

A aceitação e o broker revalidam `end_ts` e prazo: mudanças de metadados, relógio
avançado e fim antecipado não podem deixar ordem elegível por um TTL antigo.
Preservar semântica FAK/FOK/GTD e fills parciais. Expirar o saldo restante uma única
vez; não transformar cancelamento ou expiração em preenchimento. Saídas continuam
com risco e execução da RFC-034, sem obrigação de liquidar a qualquer preço.

## Aceite

FRESH-02: cache regravado e PONG sem livro permanecem stale; REST confirmado com
preço idêntico pode confirmar frescor; falha/reordenação/timeout conserva lacuna;
fixtures as-of não leem dados posteriores. Medir taxa de confirmações, carga REST,
idade observada e distribuição de `BOOK_STALE` antes/depois.

FRESH-03: ordem perto do fim recebe prazo menor; sem janela viável não nasce ordem;
TTL não ultrapassa `end_ts`; fill parcial seguido de expiração mantém saldo e
ledger consistentes; ticks repetidos não duplicam eventos. Comparar ordens que
chegam ao encerramento sem fill, com denominadores por mercado e tipo de ordem.

## Execução

1. [FRESH-02](../../prompts/roadmap/btc/fresh-02-evidencia-frescor-livro.md): contrato e produtor de evidência.
2. [FRESH-03](../../prompts/roadmap/btc/fresh-03-validade-ordens.md): validade consumida no caminho de ordens.

Cada bloco registra seu contrato no estado de execução. Migration nova, se
necessária, é proposta explicitamente e numerada somente após inspecionar a árvore.
Não reescrever migrations aplicadas. Fora: abrir gates, dispensar breakers,
restaurar dados ausentes por interpolação e inferir lucro da redução de bloqueios.
