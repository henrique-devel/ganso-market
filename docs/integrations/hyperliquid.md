# Adaptador público Hyperliquid — G2-04.1

`createHyperliquidPublicAdapter().getBtcMetadata()` faz uma única chamada pública
`meta`, mainnet/dex padrão, com timeout de 8 s e cancelamento opcional. Não há
retry, conexão de conta, signer, executor, variável de segredo, subscription ou
registro no startup. A coleta contínua permanece desativada até G2-04.4.

O SDK comunitário MIT `@nktkas/hyperliquid@0.33.3` usa Node (versão fixada no
manifesto/lockfile). Seu método público `meta` fornece tipos mas não valida a
resposta. O adaptador valida os campos usados e rejeita incompatibilidades,
colateral diferente, BTC ausente/delistado e tabelas inconsistentes. Campos
aditivos sem significado para BTC não alteram a versão do instrumento.

O envelope `TradingInstrumentMetadata` estende os contratos `trading.v1` sem
alterá-los. `instrument_version` é hash das regras normalizadas, parser, SDK e
referência documental; tempo de recebimento e outros ativos não entram nele.
`response_hash` identifica a resposta completa. `meta` não oferece timestamp nem
revisão da venue: ambos ficam `null` na proveniência. O `origin` identifica uma
**observação local** (`meta-observation`), usa seu horário e qualidade `unknown`;
não certifica frescor. Nunca usar esse horário como evento de mercado.

`instrument.tick_size` é só o menor quantum decimal. Consumidores de ordens
devem chamar `assertInstrumentOrderConstraints` além dos validadores de intenção:
limite decimal, 5 algarismos significativos com exceção para inteiros, lote e
mínimo nocional são cumulativos. Não arredondar para fazer uma ordem passar.
O mínimo de US$ 10 é conservador, sem inferir exceção reduce-only.

A referência `hyperliquid-mainnet-btc.2026-09-23.1` foi conferida em 23/09/2026.
Cada origem fica também em `provenance.sources`:

- [Precisão](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/tick-and-lot-size) e [mínimo](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/error-responses): quantidade vem de `szDecimals`; preço usa `6 - szDecimals` casas, até 5 algarismos significativos, inteiros isentos.
- [Especificações](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/contract-specifications): BTC tem colateral USDC e oracle denominado USDT, com PnL convertido por paridade numérica, sem câmbio. USD nos contratos do núcleo é unidade contábil paper, não afirma equivalência econômica dos tokens. Impacto de funding: 20.000 USDC.
- [Taxas](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/fees): referência da faixa-base de perpétuos, maker 0,015% e taker 0,045%, sem descontos. Taxa efetiva da conta é explicitamente desconhecida, nunca zero; não consultamos wallet.
- [Margem](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/margining) e [faixas](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/margin-tiers): IDs/faixas são obtidos na resposta; ID abaixo de 50 tem a convenção documental de faixa única. Manutenção é representada como fração exata `1/(2*maxLeverage)`. A dedução cumulativa preserva continuidade entre faixas e será calculada no simulador G2-05.7. Nenhuma alavancagem é escolhida.
- [Funding](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/funding): intervalo de 1 h, fórmula de 8 h com juros de 0,01% e clamp de 0,05%, rate dividido por oito para pagamento horário; limite absoluto de 4%/h. Pagamento usa oracle, positivo pago por long. Rate do intervalo permanece desconhecido até o feed de G2-04.2.

Alterações documentais exigem revisão explícita e nova versão da referência;
o adaptador não promete que uma referência estática será sempre atual.

Para diagnóstico limitado após build (nenhum loop ou persistência):

```sh
node --input-type=module -e 'import {createHyperliquidPublicAdapter} from "./apps/api/dist/venues/hyperliquid/public.js"; const m=await createHyperliquidPublicAdapter().getBtcMetadata(); console.log(JSON.stringify(m));'
```

Não foi copiado código Jev, Aowang ou exemplos do SDK. O pacote instalado e suas
dependências mantêm as licenças originais em `node_modules`; o inventário está
em `docs/dependency-licenses.json` e o aviso MIT em `THIRD_PARTY_NOTICES.md`.
