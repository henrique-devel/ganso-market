---
id: EXEC-02
rfc: RFC-034
depends_on: [EXEC-01, FIN-03, FIN-06]
mode: code
---

# EXEC-02 — Revalidar EV no tamanho e tipo finais

Execute somente este bloco. Leia `00-protocolo.md`, RFC-034/Contrato da ordem
final e as dependências em `docs/roadmap/BTC_EXECUTION_STATE.md`.

## Contexto mínimo

- `apps/api/src/polymarket/paper/bridge.ts`: ordem após policy.
- `apps/api/src/polymarket/paper/policy.ts`: `decideOrderType`.
- `apps/api/src/polymarket/portfolio/ev.ts`: contrato corrigido EXEC-01.
- `apps/api/src/polymarket/portfolio/sizing.ts`: quantidade final.
- `apps/api/src/polymarket/paper/fastpolicy.ts`: integração da policy fast.
- `apps/api/test/polymarket/paper/bridge.test.ts`: decisões/ordens.

## Um resultado

Antes de aceitar uma entrada, revalidar a economia exata da ordem que será
reservada: dono, token, lado, quantidade, tipo, preço, livro e fee.

1. Use contrato comum pequeno, extraído se necessário em arquivo proposto;
   adapte as duas policies sem criar fórmulas econômicas divergentes.
2. Bookwalk deve usar tamanho final e token real. Mudança para taker inclui
   fee verificada; fee null, livro insuficiente ou EV abaixo da margem recusam.
3. Persista breakdown/versionamento e razão vinculados à ordem/decisão pelos
   campos autorizados. Não reescreva decisões append-only.
4. Recotação que modifica qualquer entrada econômica exige revalidação.
   Não dê ao broker uma ordem diferente daquela avaliada.

## Verificação e aceite

Uma cota passa no primeiro nível e quantidade final maior falha no livro raso.
Conversão maker→taker muda fee/EV; bound de NO usa seu próprio token/livro.
Teste livro modificado entre cotação e aceite com recusa ou nova avaliação
identificável. Assertar somente que uma função foi chamada não prova economia.
Use fixtures numéricas FIN-01/EXEC-01 e teste integração da ponte com reserva.
Execute testes focados e checks do protocolo.

## Limites

Não criar política de expiry/frescor; RFC-031/FRESH-03 cuida dessa integração.
Não implementar saídas D4 nem aplicar gate de entrada a redução obrigatória.
Sem mudança de margem, caps, G4, live ou capital.

## Encerramento

Atualize EXEC-02 com contrato final e evidência de recusas corretas.
Informe ponto de integração para EXEC-03/04 e FRESH-03. Pare aqui.
