# RFC-045 — Núcleo neutro e perfil de serviços

**Status:** accepted para execução de seus prompts quando selecionados. **Data:** 22/09/2026. **Marco:** G2-03. Criar esta RFC não implementa nem ativa o resultado.

**Fonte:** [PRD 2.0](../PRD-GANSO-2.0.md), seções 4.2 e 9. **Requisitos:** RF-01, RF-04, RF-16. **Roteiro:** [prompts](../../prompts/ganso-2/README.md). **Acompanhamento:** [estado 2.0](../roadmap/GANSO_2_EXECUTION_STATE.md).

## Contrato comum

Extrair o que é compartilhável da versão financeira realmente integrada; não reconstruir FIN-07 a partir de checkout antigo. BTC não importa tipos de resultado binário. Módulos propostos não existem até serem implementados. Dinheiro é fixed-point, identidade inclui conta/experimento/instrumento. Nenhuma chave de ambiente transforma paper em live.

A [autorização de entrega](../ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-ganso-20--entrega-com-registro-minimo-22092026) cobre código → PR → merge → produção no escopo do prompt. Verificar o resultado e registrar somente a linha de acompanhamento; sem recibo, screenshots ou dossiê obrigatório. Dados de negócio necessários ao ledger e ao replay continuam obrigatórios. Ler esta seção e apenas S correspondente ao prompt, não todas as sessões.

## S1

**G2-03.1 — Definir tipos e fronteiras do núcleo BTC.** [Prompt da sessão](../../prompts/ganso-2/g2-03-1-contratos-neutros.md). Dependências: G2-00.1.

**Entrega:** Contrato neutro exportado com fronteiras explícitas para próximos prompts.

**Contrato desta fatia:** Definir instrumento, conta, experimento, intenção, ordem, execução e origem de dados/decisão em tipos/validação. Separar BTC, USD, preço, taxa e probabilidade; declarar escala/arredondamento/UTC e IDs idempotentes. Fixar forma de ledger perpétuo sem implementar banco ou broker. Manter contratos Polymarket existentes.

**Aceite proporcional:** Validar unidades trocadas, quantização, dados sem identidade e modos inválidos. Nenhum valor de private key altera modo. Pequenas fixtures de contratos, sem simular uma corretora inteira.

**Implantação:** PR/merge; biblioteca pode ser implantada sem consumidor ativo. Não ligar worker neste bloco.

## S2

**G2-03.2 — Extrair primitivas financeiras reutilizáveis.** [Prompt da sessão](../../prompts/ganso-2/g2-03-2-extrair-primitivas.md). Dependências: G2-03.1, G2-00.2.

**Entrega:** Primitivas compartilhadas pequenas e dependências de domínio separadas.

**Contrato desta fatia:** Extrair helpers realmente neutros de dinheiro, identidade, fingerprints e ordenação/replay; preservar regras binárias dentro do legado. Adaptar consumidores necessários sem copiar um segundo financeiro divergente. Não transportar q−preço, Kelly binário, token YES/NO nem funding fictício de stub.

**Aceite proporcional:** Fixtures financeiras existentes permanecem iguais depois da extração; nenhum consumidor legado muda PnL. Testes focados de fronteiras/imports e checks obrigatórios; não retestar todo o histórico manualmente.

**Implantação:** PR/merge/deploy dos consumidores afetados, com regressão de compatibilidade. Fluxo BTC ainda desativado.

## S3

**G2-03.3 — Preparar perfil BTC, CI e deploy seletivo.** [Prompt da sessão](../../prompts/ganso-2/g2-03-3-perfis-ci-deploy.md). Dependências: G2-03.2, G2-01.2.

**Entrega:** Caminho de entrega BTC preparado sem processo de negócio incompleto ativo.

**Contrato desta fatia:** Criar perfil/configuração BTC ainda inativo, entrada de worker e isolamento do legado; não usar stub ativo como serviço pronto. Atualizar classificador de deploy e verificações para os serviços que realmente rodam. Preservar PostgreSQL no deploy, orçamento combinado de recursos e reserva de conexões. Engine Rust deixa de ser dependência de readiness quando não houver consumidor.

**Aceite proporcional:** Smoke Compose do perfil efetivo, deploy de texto dispensado, mudança de worker atinge worker, banco não é recriado indevidamente. Limites continuam verificáveis; remover cap 4 GiB só com matriz coerente ao PRD e ensaio correspondente.

**Implantação:** PR/merge/deploy do perfil desativado e health compatível; não habilitar coleta até G2-04.4.

## S4

**G2-03.4 — Retirar stubs e dependências sem consumidor.** [Prompt da sessão](../../prompts/ganso-2/g2-03-4-remover-base-sem-uso.md). Dependências: G2-00.2, G2-03.3.

**Entrega:** Perfil padrão e cadeia de desenvolvimento usam apenas componentes necessários.

**Contrato desta fatia:** Remover do perfil padrão engine/worker sem função de negócio e seus acoplamentos de build/health. Apagar código e dependências somente quando inventário confirmar ausência de consumidores; preservar histórico Git e contratos reutilizados. Atualizar rotas documentais, scripts e CI para não deixar comandos órfãos. Não apagar migrations ou dados dormentes junto do código.

**Aceite proporcional:** Referências dos componentes retirados têm destino; aplicação sobe sem eles, auth/ready continuam corretos, checks de toolchain não exigem runtime retirado. Não escrever testes triviais só de nomes de arquivo.

**Implantação:** PR/merge/deploy seletivo e parada dos containers aposentados; volumes e histórico preservados.
