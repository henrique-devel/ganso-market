# FIN-06 — entradas pelo token real

Contrato implementado sobre `33190a2` (FIN-05 integrado), em 16/09/2026 UTC.
Seis arquivos de lógica; nenhuma migration, alteração de caps ou ativação de worker.

## Contrato entregue a EXEC-02

- Novas decisões usam `inputs_json.entry_contract_version = 2`, repetido no
  bloco `replay`; o dono desta ponte portfolio é `paper/main`, explicitamente
  persistido em `account_id`/`strategy_id`. A atribuição financeira segue FIN-02.
- `condition_id` identifica o contrato binário. A versão de metadata deve ter
  exatamente dois tokens distintos, não vazios, incluindo `affirmative_token_id`.
  YES é esse token; NO é o outro. Ordem dos IDs no array não define o outcome.
- `market_side` é YES/NO; `token_id` é o token real escolhido; `order_side` é BUY.
  `q`, `q_lo`, `q_hi` continuam no espaço da probabilidade YES. O bound da compra
  é `q_lo` para YES e `1-q_hi` para NO, no espaço do preço do token comprado.
- O motor carrega os dois livros reais e usa asks/profundidade do token escolhido.
  Ausência/ambiguidade de mapeamento ou livro NO ausente/stale recusa a avaliação.
  Sem identidade YES, registra `FIN06_TOKEN_MAPPING_INVALID` sem inventar token
  para satisfazer o schema do decision log. Não há complemento sintético no v2.
- `book_json` guarda o livro escolhido; replay guarda os dois livros avaliados,
  inclusive idade do NO, para reproduzir seleção/tamanho após TTL dos dados brutos.
- `size_shares` é quantidade positiva de cotas do token escolhido, decimal de seis
  casas. A ponte passa esse teto como `draft.size`/`intent.size_max`; o validator
  existente arredonda **para baixo** às duas casas de quantidade. Preço segue tick.
  Reserva e fill usam o tamanho validado e o mesmo token/dono, nunca notional como cotas.
- A política existente cota sobre bids/asks reais desse token. A ponte recusa
  limite/worst price acima do bound conservador, inclusive no fallback passivo.
  EXEC-02 ainda deve integrar EV/custos da ordem final após política/arredondamento;
  FIN-06 não redefine EV, fees, margem ou caps.
- `order_accepted.payload_json.intent.order_contract_version = 2` identifica a
  ordem desta ponte; intent inclui versão da decisão, condition, token, outcome,
  dono, bound e teto de cotas. `acceptance_request`, `reservation-v1`,
  `ownership-v1`, `financial-v2` e `payoff-v1` permanecem compatíveis.

## Compatibilidade e fronteira EXEC-04

Decisão sem versão (ou v1) mantém o replay antigo: NO era SELL do token YES,
com livro complementar e bound `q_hi` no espaço YES. O replay não substitui
esse token por NO. Versão desconhecida recusa parsing. Uma decisão histórica
BUY YES ainda fresca pode entrar após validação do mapeamento; SELL/NO legado
pendente exige reavaliação, sem mutação do evento. A deduplicação prospectiva
considera somente v2, permitindo a primeira decisão nova após atualização.

Ordens/eventos existentes continuam no parser/fold original; nenhum ledger,
cache ou migration histórica foi reescrito. FIN-05 já impede novo SELL sem
inventário positivo do mesmo dono e impede atravessar zero. BUY de short
legado continua representável com `reservation.inventory_side = BUY`, limitado
às cotas negativas do dono; resolução permanece disponível. A ponte D4 e sua
integração reduce-only pertencem a EXEC-04 e não foram implementadas aqui.

## Evidência

- 479 testes de portfolio/bridge passed; 41 casos SQL dessa execução skipped,
  separados do resultado. Abrange runner, engine, replay e consumidores sweep.
- 46 casos PostgreSQL reais passed em banco descartável exclusivo `fin06_test`,
  migrations 0001–0025 e guards ativos: reservations, financial e ownership.
  O arquivo reservations foi repetido após ampliar a prova integrada: 20 passed.
- Livros distintos: YES 0,80/0,81 versus NO 0,39/0,40. Ponte e broker reais
  aceitam BUY de 10 NO a 0,40, reservam US$4 e atribuem o fill a `paper/main`.
- Duas estratégias com 10/20 NO a 0,40 ficam com cash 996/992 e saldos separados.
  Terceiro dono sem inventário não vende; dono de 10 não vende 11; vender suas
  10 cotas não reduz as 20 do outro. Legado short/redução e concorrência preservados.
- Fixtures também cobrem bound NO, fallback acima do bound, metadata ausente,
  tokens duplicados, token errado, dono errado, livro ausente e replay v1/v2.

Comandos: `npm test --workspace @ganso-market/api -- test/polymarket/portfolio
 test/polymarket/paper/bridge.test.ts`; testes SQL com `GANSO_TEST_DATABASE_URL`
no banco descartável e `--no-file-parallelism`; `make verify` como gate geral.
Publicação, resultado final dos gates e limites operacionais: [recibo](../receipts/FIN-06.md).
