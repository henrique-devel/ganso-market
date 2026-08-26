# Escopo do motor de portfólio (RFC-013) — sem execução real e sem stop-loss

**SIMULAÇÃO — SEM EXECUÇÃO REAL.** Este documento é a declaração explícita
exigida pelos artefatos da RFC-013: o módulo
`apps/api/src/polymarket/portfolio/` decide **se entra, quanto entra, quando
sai e quando o sistema inteiro para**, sempre sobre o paper broker da RFC-011 e
sobre dados já gravados pelo recorder (RFC-007). Ele **não contém nenhum
caminho de execução real** — nem desarmado, nem atrás de flag.

## Ausência de stop-loss — e por que isso é uma decisão, não uma omissão

A RFC-013 proíbe prometer stop-loss em qualquer artefato. O motivo é
estrutural, não conservadorismo genérico:

> Um livro binário pode saltar de preço alto para perto de zero sem passar
> pelos preços intermediários. Uma ordem de saída pendurada num nível não é
> executada nesse salto — ela simplesmente deixa de ter contraparte.

Em consequência, o motor **assume perda total da posição no sizing**: todo cap
de portfólio é consumido pelo notional inteiro, nunca por uma fração
"protegida". É o oposto de dimensionar contra um stop que não existe.

Os sete critérios de saída da tarefa 5 são **reavaliações de tese**, não
proteções de preço: edge residual capturado no bid, movimento do modelo,
invalidação da tese ou da fonte, deterioração de liquidez ou de regra,
aproximação de catalisador não coberto, capital bloqueado que deixou de
compensar o edge, e limites de portfólio atingidos. Nenhum deles promete um
preço de saída.

Nenhum texto de UI, API ou documentação deste módulo pode sugerir proteção por
stop.

## O que o módulo NÃO tem, e como isso é garantido

- **Nenhuma** autenticação CLOB L1/L2 de trading, API key/secret/passphrase,
  wallet, signer, private key, seed ou chamada a `POST /order` da CLOB.
- **Nenhum** struct EIP-712 de ordem.
- **Nenhum** identificador de stop-loss, trailing stop, leverage ou martingale.
- **Nenhuma** forma de desabilitar um cap ou limitador de sizing. Se qualquer
  limitador pudesse ser desligado por flag, o `min()` que limita toda posição
  seria uma sugestão — e a RFC trata isso como condição de parada.
- **Nenhuma** conexão de rede de saída: o motor é event-driven sobre o que já
  está no PostgreSQL.
- **Nenhuma** leitura de `closedTime`, cujo timestamp chega depois do desfecho
  público (mesma guarda de leakage das RFC-010/012).
- Escreve **somente** nas tabelas `portfolio_*` (lista fechada).

A verificação automática é
[`apps/api/test/polymarket/portfolio/scope.test.ts`](../../apps/api/test/polymarket/portfolio/scope.test.ts),
que varre todos os arquivos do módulo a cada `make verify` e no CI. Ele remove
comentários antes de procurar padrões proibidos — a própria RFC exige que a
ausência de stop-loss seja documentada, então escanear prosa faria a
documentação obrigatória reprovar a guarda que existe para exigi-la. Um teste
separado prova que essa prosa existe.

## Invariantes que o banco impõe, não só o código

A migration `0014_polymarket_portfolio_engine.sql` codifica o que não pode
depender de disciplina de quem escreve o código:

| Invariante | Como é imposto |
| --- | --- |
| Config e mapa de fatores imutáveis | trigger que rejeita `UPDATE`/`DELETE` |
| Decision log append-only | trigger; só `paper_order_id` pode ser carimbado, uma vez |
| Sem look-ahead | `CHECK (newest_input_ts <= decision_ts)` |
| Toda rejeição diz o porquê | `CHECK ((outcome = 'REJECTED') = (reason_code IS NOT NULL))` |
| Toda entrada aceita é dimensionada | `CHECK` de `size_shares` + `binding_constraint <> 'NOT_SIZED'` |
| Toda entrada aceita guarda o intervalo | `CHECK` de `q_lo`/`q_hi`/`exec_price` não nulos |
| `HALTED` sempre tem timestamp | `CHECK ((state = 'HALTED') = (halted_at IS NOT NULL))` |
| Transições auditadas | `portfolio_state_events` append-only |
| Gate que falha tem código de motivo | `CHECK (status = 'PASS' OR reason_code IS NOT NULL)` |
| Medições de gate imutáveis | trigger que rejeita `UPDATE`/`DELETE` |
| Painel nunca esconde um veto | `CHECK (vetoed = FALSE OR veto_reason IS NOT NULL)` e `CHECK (vetoed = FALSE OR entrable = FALSE)` |

A última linha é a tradução da exigência da tarefa 6: *"painel nunca exibe
oportunidade vetada como 'quase entrável' sem o motivo do veto"*.

## O critério de entrada, em uma linha

```
q_lo − preço_executável > taxas + slippage + custo_capital + margem_segurança
```

`q_lo` é o **limite inferior** do intervalo da RFC-010, nunca a média — e para
uma posição NO o limite conservador é `1 − q_hi`, não `1 − q_lo`: trocar de
lado troca qual ponta do intervalo é a pessimista. Não existe exceção "de alta
convicção" em lugar nenhum do módulo.

O preço executável vem sempre de **book-walk sobre o book cru gravado**, nunca
do midpoint: a interface da Polymarket troca para o último trade quando o
spread passa de $0,10, então um preço derivado do mid não é um preço em que
alguém poderia ter negociado.

## Kelly é teto, nunca alvo

O tamanho final é o `min()` de todos os limitadores, e o decision log sempre
registra qual deles foi o binding constraint. Kelly fracionário é apenas um
deles. `kelly_lambda` encolhe com a largura do intervalo da estimativa (Baker &
McHale: sob incerteza de estimativa a fração ótima diminui), e o teto de 0,5
depende de track record que já tenha passado o G1 — é um campo que o gate lê,
nunca um botão que um operador aperta.

## Fronteira com a RFC-009

Execução real (assinatura de ordem, auth de trading, wallet burn na Polygon) é
escopo **exclusivo** da RFC-009, que só se inicia após **todos** os gates
G1–G6 desta RFC passarem **e** aprovação escrita do proprietário. Falha de
qualquer gate registra o código de motivo, mantém paper e nunca "afrouxa" o
gate na mesma config — o parser de configuração recusa valores de gate abaixo
dos limiares da RFC (`PORTFOLIO_CONFIG_GATE_LOOSENED`).

A expectativa calibrada no relatório de gates é explícita: ~84% das carteiras
rastreáveis perdem dinheiro. O gate exige evidência de decil superior, não
"parece bom".
