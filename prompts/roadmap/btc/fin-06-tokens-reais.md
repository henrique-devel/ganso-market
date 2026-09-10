---
id: FIN-06
rfc: RFC-038
depends_on: [FIN-05]
mode: code
---

# FIN-06 — Entrar em YES/NO pelo token real

Execute somente este bloco. Leia `00-protocolo.md`, RFC-038/Contrato financeiro
e FIN-02/05 em `docs/roadmap/BTC_EXECUTION_STATE.md`.

## Contexto mínimo

- `apps/api/src/polymarket/portfolio/engine.ts`: seleção de lado/tamanho.
- `apps/api/src/polymarket/portfolio/decisionrow.ts`: token/order side.
- `apps/api/src/polymarket/paper/bridge.ts`: `conservativeBound`, ordem.
- `apps/api/src/polymarket/paper/brokerstore.ts`: inventário/reservas.
- `apps/api/src/polymarket/portfolio/store.ts`: metadata e livros.
- `apps/api/test/polymarket/paper/bridge.test.ts`: encaminhamento.

## Um resultado

Novas entradas paper compram o token real da alternativa selecionada,
preservando shorts existentes como legado mensurável.

1. Encaminhe BUY YES ou BUY NO com condition, outcome, token e dono
   consistentes. O bound de NO é `1-q_hi`, aplicado ao preço do próprio NO.
2. Carregue livro real daquele token e use sua profundidade/reserva.
   Livro ausente ou mapeamento ambíguo resulta em recusa explícita.
3. Não reutilize SELL YES como entrada NO. SELL novo só reduz inventário
   do dono; não abra short nem atravesse zero por uma entrada.
4. Preserve parsing/replay de ordens antigas pela versão do contrato;
   não traduza eventos históricos como se fossem compras de outro token.

## Verificação e aceite

Fixtures com livros YES e NO diferentes provam que o NO usa seu próprio livro.
Verifique bound conservador, token errado, metadata ausente e fill no dono certo.
Duas estratégias no mesmo token mantêm saldos separados; SELL sem inventário
é recusado mesmo que outra estratégia possua aquele token.
Saída do short legado permanece representável para EXEC-04; este bloco
não implementa a ponte D4. Não introduza novo contrato de EV: EXEC-02 integra.

## Limites

Não ativar worker ou mudar caps. Se surgir necessidade de migration adicional,
registre lacuna no contrato FIN-02 e divida antes de ampliar este bloco.
Execute testes focados e checks exigidos no protocolo comum.

## Encerramento

Atualize FIN-06 com versão da decisão/ordem e casos de compatibilidade.
Informe o contrato final de token/tamanho para EXEC-02. Pare aqui.
