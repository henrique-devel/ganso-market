Bloco: OPS-01 | RFC: RFC-021 | Data UTC: 2026-09-10T21:03:45Z
Estado: code-verified
Código: c528d5b0d74cc5cf8894ee953dd335df5f1e1b03; checkout inicialmente limpo; somente documentos novos/atualizados neste bloco.
Resultado: inventário concluído pelo fallback sem acesso; mapa local verificado, sem diagnóstico atual de produção.
Evidência: [OPS-01](../../test-results/btc/OPS-01.md).
Arquivos: docs/test-results/btc/OPS-01.md; este recibo; somente linha OPS-01 do estado.
Dependências verificadas: nenhuma (depends_on vazio).
Contratos/versões: RFC-021 emenda/D1–D3; D1/D2/D3 ausentes nesta base; guardas preexistentes preservadas.
Testes: npm run test --workspace @ganso-market/api -- test/polymarket/{orchestrator,rtds,paper/brokerstore}.test.ts — 120 passed.
Testes: npm run test --workspace @ganso-market/api -- test/polymarket/{dualws,bookpipe,quality}.test.ts — 69 passed.
Ambiente: Node v26.4.0, Vitest 4.1.10; mocks/fake timers, sem DB externo; 2026-09-10T21:02:46–21:02:54Z.
Aceite: tabela por série, relógios distintos, hipóteses com contraprova/limites e testes delimitados; saúde operacional não atestada.
Produção: não consultada; SHA por recorder/paper, últimos dados/erros/gaps, pools e switch não verificados.
Limite: Ed25519 local u6gqFKW4wplj8HZSAI6UjF1Bt00FRNf1unAoWOVEO2k difere do registro Qr1GY+n8sfQfQe6ZxHhHkUSZ3PzBtPAwkDQWnU/VV9Q; nenhum SSH executado.
Autorização operacional: protocolo + SERVER_ACCESS permitem consulta com host fixado; nenhuma escrita no servidor.
Próximo bloco: OPS-02, detector CLOB após primeiro livro, sem refazer both-down/RFC-024.
Delta OPS-03: snapshots-only, sem series/idades, sem rearme automático de 15 ticks; testar dependência do settlement.
Delta OPS-05: silêncio RTDS sem watchdog/relógios por série; gap best-effort pode sumir com falha de DB.
Continuidade: reconciliar identidade por canal independente e verificar release por processo antes de alegar estado de produção; usar símbolos/leituras limitadas da evidência.
