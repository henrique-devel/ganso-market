---
id: EXP-01
rfc: RFC-033
depends_on: [BTC-01]
mode: code
---

# EXP-01 — Manifesto de experimento e controles

Implemente schema/validação e exemplo de pesquisa, sem iniciar experimento operacional.
Siga `00-protocolo.md`; consulte contrato publicado por BTC-01 no estado.

## Contexto mínimo

- `docs/rfcs/RFC-033-experimento-prospectivo-btc.md`: decisões 1–3 e 5.
- `config/fast.json`: baseline congelado atual.
- `apps/api/src/polymarket/paper/fastconfig.ts`: parse/hash e versões.
- `apps/api/src/polymarket/paper/fastpolicy.ts`: `controlOutcome`.
- `migrations/0020_fast_strategy_registry.sql`: imutabilidade existente.

## Escopo fechado

1. Manifesto: hipótese, BTC1h, versões/fontes, freeze/cutoff/holdout, métrica,
   braços/controle, semente, comparações, revisões e regras de parada.
2. Exija US$1.000 por cenário, risco por entrada, stop diário/perda total,
   simultaneidade e sizing; exemplo não muda a configuração em produção.
3. Separe contraste de mais oportunidades de contraste de mais tamanho
   sobre os mesmos sinais. Exemplos US$10/20/40 são pesquisa, não defaults.
4. Versione candidatos e registre limite de variantes/comparações e ajuste
   de seleção/revisões antes do holdout; parâmetros obrigatórios não têm chute.
5. Mudança após freeze exige novo ID/holdout futuro. Histórico exploratório
   permanece identificado e não pode se declarar prospectivo.

## Verificação necessária

- Rejeite holdout anterior ao freeze, riscos ausentes e versão mutada.
- Controle determinístico reproduz lado por mercado sem acessar rótulo.
- Contrastes inválidos e reutilização de holdout são detectados.
- Configuração 0.1.0 permanece inalterada.

## Entrega

- Schema/parser, testes e manifesto de exemplo explicitamente não ativado.
- Estado com contratos para EXP-02; campos ainda a preencher ficam explícitos.
- Documente quais critérios são proposta e quais invariantes já existem.

## Limite do bloco

Sem treino, varredura de parâmetros, alteração de gates ou início de paper/live.
Não invente política financeira final para fazer o exemplo passar.
