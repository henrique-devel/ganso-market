---
id: QA-01
rfc: RFC-038
depends_on: [FIN-01]
mode: code
---

# QA-01 — executar de verdade os testes PostgreSQL

Siga [00-protocolo.md](00-protocolo.md). Um bloco; nenhum deploy.
Consulte só sua linha/dependência em `docs/roadmap/BTC_EXECUTION_STATE.md`.

## Resultado

O CI roda os testes de banco usados para validar os contratos financeiros; testes
ignorados por falta de conexão não contam como aprovação.

## Leitura mínima

- `.github/workflows/ci-cd.yml`: jobs verify/integration e permissões.
- `Makefile`: test, verify e integration.
- `infra/migrations/apply.sh`: aplicação em banco novo.
- `apps/api/test/polymarket/portfolio/integration.pg.test.ts`: conexão/skipIf.
- `apps/api/test/polymarket/paper/bridge.pg.test.ts`: setup/teardown.
- `docs/rfcs/RFC-038-contabilidade-e-risco-por-payoff.md`: contrato a proteger.

## Escopo

1. Inventarie os arquivos pg-gated com `rg`; confirme `GANSO_TEST_DATABASE_URL`.
2. Configure PostgreSQL descartável e migrations no CI com a versão do projeto,
   credenciais efêmeras de teste e isolamento de jobs. Não imprimir URLs com senhas.
3. Execute as suítes relevantes e torne a ausência de conexão/execução um erro no
   job obrigatório de banco; o modo rápido local pode manter opt-out explícito.
4. Preserve os checks existentes; nenhuma mudança na rotina de deploy ou no broker.

## Aceite

- Um teste pg deliberadamente falhando torna o job vermelho; reverta a alteração
  experimental antes da entrega. Banco ausente também falha nesse job.
- Registre a lista e contagem realmente executadas, sem fixar “124” como eterno.
- Rode o fluxo em banco descartável. Se CI remoto não foi observado, registre
  validação local e o acompanhamento pendente; não afirme que o workflow passou.

## Fecho

Recibo QA-01 com comandos/contagens e mudança mínima; atualize só sua linha do estado.
FIN-07 e EXEC-05 usam esta evidência. Não execute esses blocos nesta sessão.
