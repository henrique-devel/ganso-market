# Estado de execução das sessões JEV

Pacote preparado em 07/10/2026. **Todas as sessões estão planejadas**; a tabela não certifica código, deploy, qualificação ou operação. O [índice](../../prompts/jev/README.md) contém os prompts, dependências e ordem. Não alterar estados do ciclo Ganso 2.0 por consequência deste pacote.

## Como atualizar

Atualizar somente a linha da sessão executada: estado de entrega, PR/SHA se houver, uma frase de validação/contrato e implantação ou gate pendente. Sem recibo ou relatório separado. Registrar reaproveitamento quando o aceite já estiver comprovado.

Entrega: `planned`, `in-progress`, `code-verified`, `merged`, `deployed`, `blocked` ou `not-applicable`. Observação: `not-started`, `observing`, `operational-qualified`, `venue-verified`, `ready-for-operator`, `active`, `inconclusive` ou `failed`. São dimensões distintas: código publicado pode continuar com operação não admitida.

Dependência de código é confirmada por contrato/commit/PR integrado, não por qualificação econômica. Um gate pendente não impede desenvolver os componentes seguintes compatíveis. Sete/90 dias e elegibilidade têm comprovação própria; nunca marcar por fixture. Se houver bloqueio real, indicar condição mínima para retomada.

## Sessões

| ID | Entrega | PR ou SHA | Validação e contrato | Publicação ou pendência operacional |
| --- | --- | --- | --- | --- |
| [GJ00.1](../../prompts/jev/gj-00-1-reconciliar-a-base-de-trabalho.md) | merged | [PR 333](https://github.com/henrique-devel/ganso-market/pull/333), `e79910c60a7687735f98bab7e06b5a5380b43d79` | Em 07/10/2026: raiz interna/HEAD `d04875a`, main/base `01d0e6d`; checkout isolado, status/hashes das 484 entradas locais preservados. Pacote JEV importado seletivamente; BTC/contratos/migrations até 0050 já integrados, sem reexecutar baseline/Polymarket. 798 links/âncoras sem ausências, 41 testes do classificador, scan/diff OK; [CI 37664353356](https://github.com/henrique-devel/ganso-market/actions/runs/37664353356) aprovou make verify, PostgreSQL descartável e Compose. | Publicação documental integrada na main; classificador `deploy=false` (62 arquivos de texto), deploy de serviços dispensado. Nenhuma alteração de runtime/config/schema nem medição atual de saúde/capacidade/qualificação; registros de setembro/02-10 históricos. GJ00.2 e gates operacionais permanecem não avaliados nesta sessão. |
| [GJ00.2](../../prompts/jev/gj-00-2-conferir-runtime-schema-e-checks-da-base.md) | planned | — | Não executada | not-started |
| [GJ01.1](../../prompts/jev/gj-01-1-versionar-contratos-de-perfis-e-contas.md) | planned | — | Não executada | not-started |
| [GJ01.2](../../prompts/jev/gj-01-2-adaptar-genese-e-replay-ao-capital-explicito.md) | planned | — | Não executada | not-started |
| [GJ01.3](../../prompts/jev/gj-01-3-persistir-registro-de-perfis-e-pares-de-contas.md) | planned | — | Não executada | not-started |
| [GJ02.1](../../prompts/jev/gj-02-1-computar-contexto-e-manifestos-iniciais.md) | planned | — | Não executada | not-started |
| [GJ02.2](../../prompts/jev/gj-02-2-fixar-gatilhos-cadencia-e-contrato-de-saidas.md) | planned | — | Não executada | not-started |
| [GJ02.3](../../prompts/jev/gj-02-3-definir-evidencia-minima-e-retencao-protegida.md) | planned | — | Não executada | not-started |
| [GJ02.4](../../prompts/jev/gj-02-4-admitir-viabilidade-inicial-de-capacidade-e-jev.md) | planned | — | Não executada | not-started |
| [GJ03.1](../../prompts/jev/gj-03-1-definir-escolhas-jev-e-vinculo-por-conta.md) | planned | — | Não executada | not-started |
| [GJ03.2](../../prompts/jev/gj-03-2-persistir-pools-e-reserva-de-custo-jev.md) | planned | — | Não executada | not-started |
| [GJ03.3](../../prompts/jev/gj-03-3-integrar-transporte-de-lotes-por-perfil.md) | planned | — | Não executada | not-started |
| [GJ03.4](../../prompts/jev/gj-03-4-registrar-decisoes-e-replay-das-respostas-originais.md) | planned | — | Não executada | not-started |
| [GJ04.1](../../prompts/jev/gj-04-1-aplicar-limites-persistentes-por-conta.md) | planned | — | Não executada | not-started |
| [GJ04.2](../../prompts/jev/gj-04-2-dimensionar-entradas-com-stop-e-tolerancia-nativa.md) | planned | — | Não executada | not-started |
| [GJ04.3](../../prompts/jev/gj-04-3-persistir-supervisor-global-do-piloto.md) | planned | — | Não executada | not-started |
| [GJ05.1](../../prompts/jev/gj-05-1-unificar-contratos-de-liquidez-maker-e-ioc.md) | planned | — | Não executada | not-started |
| [GJ05.2](../../prompts/jev/gj-05-2-implementar-cotacao-chegada-e-fila-maker.md) | planned | — | Não executada | not-started |
| [GJ05.3](../../prompts/jev/gj-05-3-integrar-cancelamento-parcial-e-saida-ioc.md) | planned | — | Não executada | not-started |
| [GJ06.1](../../prompts/jev/gj-06-1-extrair-supervisor-de-protecao-dos-perfis.md) | planned | — | Não executada | not-started |
| [GJ06.2](../../prompts/jev/gj-06-2-separar-worker-de-execucao-da-api.md) | planned | — | Não executada | not-started |
| [GJ06.3](../../prompts/jev/gj-06-3-integrar-cadencias-e-descartar-decisoes-obsoletas.md) | planned | — | Não executada | not-started |
| [GJ07.1](../../prompts/jev/gj-07-1-separar-despesa-real-e-custo-de-avaliacao.md) | planned | — | Não executada | not-started |
| [GJ07.2](../../prompts/jev/gj-07-2-publicar-pnl-e-resultado-conservador.md) | planned | — | Não executada | not-started |
| [GJ07.3](../../prompts/jev/gj-07-3-construir-referencias-caixa-e-btc-protegido.md) | planned | — | Não executada | not-started |
| [GJ08.1](../../prompts/jev/gj-08-1-contar-episodios-e-medir-cobertura-real.md) | planned | — | Não executada | not-started |
| [GJ08.2](../../prompts/jev/gj-08-2-avaliar-elegibilidade-inicial-e-estados-do-perfil.md) | planned | — | Não executada | not-started |
| [GJ08.3](../../prompts/jev/gj-08-3-implementar-avaliacao-rolling-de-90-dias.md) | planned | — | Não executada | not-started |
| [GJ09.1](../../prompts/jev/gj-09-1-generalizar-registro-e-dispatch-de-tres-perfis.md) | planned | — | Não executada | not-started |
| [GJ09.2](../../prompts/jev/gj-09-2-integrar-stress-prospectivo-independente.md) | planned | — | Não executada | not-started |
| [GJ09.3](../../prompts/jev/gj-09-3-validar-carga-e-ciclo-integrado-dos-pares.md) | planned | — | Não executada | not-started |
| [GJ10.1](../../prompts/jev/gj-10-1-exibir-perfis-pnl-e-limites.md) | planned | — | Não executada | not-started |
| [GJ10.2](../../prompts/jev/gj-10-2-exibir-decisoes-protecao-e-custos-separados.md) | planned | — | Não executada | not-started |
| [GJ10.3](../../prompts/jev/gj-10-3-implementar-controles-de-pausa-e-emergencia.md) | planned | — | Não executada | not-started |
| [GJ11.1](../../prompts/jev/gj-11-1-persistir-propostas-fingerprints-e-uma-mudanca.md) | planned | — | Não executada | not-started |
| [GJ11.2](../../prompts/jev/gj-11-2-gerar-por-vaga-e-validar-coerencia-com-jev.md) | planned | — | Não executada | not-started |
| [GJ11.3](../../prompts/jev/gj-11-3-criar-fila-curta-editavel-pelo-operador.md) | planned | — | Não executada | not-started |
| [GJ11.4](../../prompts/jev/gj-11-4-admitir-sucessoras-paper-apos-encerramento.md) | planned | — | Não executada | not-started |
| [GJ12.1](../../prompts/jev/gj-12-1-implementar-readiness-e-evidencia-de-qualificacao.md) | planned | — | Não executada | not-started |
| [GJ12.2](../../prompts/jev/gj-12-2-admitir-paper-e-iniciar-observacao-tecnica.md) | planned | — | Não executada | not-started |
| [GJ12.3](../../prompts/jev/gj-12-3-verificar-qualificacao-observada-do-motor.md) | planned | — | Não executada | not-started |
| [GJ13.1](../../prompts/jev/gj-13-1-preparar-fronteira-autenticada-do-adaptador-live.md) | planned | — | Não executada | not-started |
| [GJ13.2](../../prompts/jev/gj-13-2-reconciliar-posicoes-ordens-fills-e-funding-da-venue.md) | planned | — | Não executada | not-started |
| [GJ13.3](../../prompts/jev/gj-13-3-submeter-alo-e-ioc-com-recibos-idempotentes.md) | planned | — | Não executada | not-started |
| [GJ13.4](../../prompts/jev/gj-13-4-instalar-protecao-nativa-desde-o-primeiro-parcial.md) | planned | — | Não executada | not-started |
| [GJ13.5](../../prompts/jev/gj-13-5-validar-o-adaptador-em-ambiente-controlado-da-venue.md) | planned | — | Não executada | not-started |
| [GJ14.1](../../prompts/jev/gj-14-1-implementar-promocao-condicionada-e-singleton-live.md) | planned | — | Não executada | not-started |
| [GJ14.2](../../prompts/jev/gj-14-2-criar-ativacao-explicita-do-piloto-no-painel.md) | planned | — | Não executada | not-started |
| [GJ14.3](../../prompts/jev/gj-14-3-implementar-sucessao-live-somente-por-reprovacao.md) | planned | — | Não executada | not-started |
| [GJ15.1](../../prompts/jev/gj-15-1-conferir-readiness-do-piloto-e-ativacao-pelo-operador.md) | planned | — | Não executada | not-started |
| [GJ15.2](../../prompts/jev/gj-15-2-verificar-piloto-ativo-e-reconciliacao-observada.md) | planned | — | Não executada | not-started |
| [GJ15.3](../../prompts/jev/gj-15-3-verificar-avaliacao-continua-e-janela-completa.md) | planned | — | Não executada | not-started |
