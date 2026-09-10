---
id: FIN-02
rfc: RFC-038
depends_on: [FIN-01]
mode: code
---

# FIN-02 — Persistir o dono de cada evento financeiro

Execute somente este bloco. Leia `00-protocolo.md`, a linha FIN-01 em
`docs/roadmap/BTC_EXECUTION_STATE.md` e a evidência FIN-01 indicada ali.
Leia RFC-038, seções Contrato financeiro e Persistência.

## Contexto mínimo

- `apps/api/src/polymarket/paper/ledger.ts`: `appendLedgerEvent` e tipos.
- `apps/api/src/polymarket/paper/brokerstore.ts`: produtores de eventos.
- `migrations/0008_polymarket_paper_broker.sql`: idempotência/append-only.
- `migrations/0020_fast_strategy_registry.sql`: estratégia e vinculação.
- `apps/api/test/polymarket/paper/ledger.test.ts`: replay existente.

## Um resultado

Implementar atribuição persistente verificável por conta/estratégia/token,
conforme o desenho FIN-01, mantendo leitores legados compatíveis.

1. Crie no máximo uma migration aditiva, com próximo número livre conferido.
2. Implemente escrita de evento + atribuição na mesma transação; retries
   preservam o mesmo dono e recusam conflito de titularidade.
3. Exponha leitura atribuída para FIN-03. Se necessário, extraia módulo
   pequeno proposto de ownership; não reestruture o broker inteiro.
4. Eventos antigos permanecem intactos. Atribuição histórica só com evidência;
   desconhecidos ficam explícitos no domínio legado, nunca na carteira BTC.

## Verificação e aceite

Teste duas estratégias no mesmo token; fill, fee e resolução devem carregar
o dono correto. Uma resolução pode precisar produzir eventos por dono.
Prove rollback quando atribuição falha e idempotência quando o evento já existe.
Use PostgreSQL real nos testes transacionais; reporte indisponibilidade sem
trocar integração por mock. Novos arquivos de teste são propostos, não existentes.
Execute testes focados e os checks exigidos pelo protocolo comum.

## Limites

Não calcular nova equity, mudar exposição, ativar consumidores ou redistribuir
cash neste bloco. Uma coluna em `paper_orders` sozinha não satisfaz o aceite.
Não fazer UPDATE de eventos históricos nem migration destrutiva.

## Encerramento

Registre migration, contrato exportado, evidência e resultado no estado FIN-02.
Informe a menor lista de arquivos que FIN-03 precisará ler. Pare aqui.
