---
id: EXEC-01
rfc: RFC-034
depends_on: [FIN-01]
mode: code
---

# EXEC-01 — Corrigir dupla incidência de custos

Execute somente este bloco. Leia `00-protocolo.md`, RFC-034/Um custo,
uma incidência e FIN-01 em `docs/roadmap/BTC_EXECUTION_STATE.md`.

## Contexto mínimo

- `apps/api/src/polymarket/portfolio/ev.ts`: `computeEv`, `bookWalk`.
- `apps/api/src/polymarket/portfolio/exitcycle.ts`: custos do unwind.
- `apps/api/src/polymarket/paper/policy.ts`: fee/preço maker-taker.
- `apps/api/test/polymarket/portfolio/ev.test.ts`: valores esperados.
- `apps/api/test/polymarket/portfolio/exitcycle.test.ts`: custos de saída.

## Um resultado

Corrigir a aritmética pura de EV para cada custo incidir uma única vez.
Não conectar ainda a verificação da ordem final ao broker.

1. Quando o preço-base é VWAP, preserve VWAP−melhor preço como diagnóstico,
   sem subtrair esse slippage novamente de `edgeNetScaled`.
2. Explicite fees, custo de capital, buffer e margem com suas unidades.
   Verifique o mesmo erro no unwind dentro dos arquivos listados.
3. Separe maker/taker pela evidência de preço/custo disponível. Fee
   desconhecida não se torna zero elegível para agressão.
4. Preserve campos de diagnóstico ou versione sua semântica explicitamente;
   não altere thresholds para manter testes artificialmente verdes.

## Verificação e aceite

Fixture manual: melhor ask 0,50, VWAP 0,55, payoff esperado 0,65,
demais custos zero ⇒ EV 0,10 e slippage diagnóstico 0,05.
Acrescente fee conhecida: somente ela reduz o resultado adicionalmente.
Teste maker, taker, NO com bound conservador e bookwalk incompleto.
Resultados esperados são constantes calculadas à mão, nunca retorno de helper
da implementação. Regressão deve falhar no trecho anterior relevante.
Execute testes focados e os checks previstos no protocolo comum.

## Limites

Sem migration, deploy, nova fee presumida, caps, mudança de gates ou live.
Não corrigir sizing/bridge neste bloco; EXEC-02 recebe o contrato puro.

## Encerramento

Atualize EXEC-01 no estado com fórmula, diagnóstico preservado e testes.
Informe a função que EXEC-02 deve chamar. Pare após este resultado.
