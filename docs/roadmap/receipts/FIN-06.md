Bloco: FIN-06 | RFC: RFC-038 | Data UTC: 2026-09-16
Estado: code-verified; código e reparos integrados; evidência operacional final preservada localmente.
Código: 999295c/base33190a2; merge original a61b5fe; reparo SQL em 9be7a72/PR184.
Resultado: novas entradas compram YES/NO real, com livro/profundidade e reserva do próprio token/dono.
Arquivos: engine/decisionrow/store/runner/replay/bridge; testes e evidência; nenhuma migration.
Dependências: FIN-02/0024 e FIN-05/0025 conferidos por código e recibos integrados.
Decisão: inputs_json.entry_contract_version=2; replay versionado; dono paper/main.
Ordem da ponte: intent.order_contract_version=2; condition/token/outcome/dono/bound/teto explícitos.
Contrato EXEC-02: BUY, size_shares em cotas do token real, seis casas; validator arredonda para baixo a duas.
Bound: YES=q_lo; NO=1−q_hi, no próprio preço; recusa inclusive fallback passivo acima do bound.
Compatibilidade: v1/ausente reexecuta SELL YES histórico sem converter token; pendência SELL exige reavaliação.
Legado: FIN-05 mantém BUY limitado para reduzir short; nenhuma ponte D4/EXEC-04 nova.
Teste focado: 479 passed/41 SQL skipped em portfolio+bridge, separados.
SQL real: 46 passed, banco descartável exclusivo/migrations reais; reservations ampliado repetido, 20 passed.
Aceite: YES/NO distintos; BUY10 NO×0,40 reserva4/fill paper/main; dois donos10/20 com cash996/992.
Recusas: metadata/token/dono/livro/bound; SELL sem inventário próprio e SELL acima do saldo.
Checks gerais: make verify passou; 2420 JS/257 skipped separados, 16 Rust/220 Python, build/scan/Compose.
Publicação: [PR181](https://github.com/henrique-devel/ganso-market/pull/181) e reparos182–184 integrados; source/Compose e Deploy production aprovados.
Implantação: fluxo CI/CD aprovado; verificação operacional detalhada do fecho mantida localmente.
Limites: sem EV final novo, live/signer, capital/caps, worker novo, migration ou bloco posterior.
Evidência/contrato: [FIN-06](../evidence/FIN-06-real-tokens.md).
Autorização: proprietário respondeu “Autorizado fazer o processo de publicação via PR”; recusa anterior superada.
Ajustes: PR182 lookup v2; PR183 universo dos breakers; [PR184](https://github.com/henrique-devel/ganso-market/pull/184) mids indexados, sem migration; 20PG/23runner passed.
Limite da evidência: não há aceite de reconciliação produtiva ou soak; não iniciar outro bloco.
Próximo elegível: FIN-07; EXEC-02/04 recebem contratos, nenhum foi iniciado.
