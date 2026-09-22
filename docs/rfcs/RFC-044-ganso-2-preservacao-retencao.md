# RFC-044 — Retenção e proteção do histórico

**Status:** accepted para execução de seus prompts quando selecionados. **Data:** 22/09/2026. **Marco:** G2-02. Criar esta RFC não implementa nem ativa o resultado.

**Fonte:** [PRD 2.0](../PRD-GANSO-2.0.md), seções 10 e 11. **Requisitos:** RF-15, RF-16. **Roteiro:** [prompts](../../prompts/ganso-2/README.md). **Acompanhamento:** [estado 2.0](../roadmap/GANSO_2_EXECUTION_STATE.md).

## Contrato comum

Histórico financeiro e dependências de replay permanecem protegidos no banco. Não copiar segredo para Git/logs. Pins/HOLD prevalecem sobre quota. Implementar seletor e executor não autoriza qualquer conjunto destrutivo. O código de retenção nova pode ser entregue antes de apagar o legado; ausência de autorização de descarte não bloqueia todo o 2.0.

A [autorização de entrega](../ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-ganso-20--entrega-com-registro-minimo-22092026) cobre código → PR → merge → produção no escopo do prompt. Verificar o resultado e registrar somente a linha de acompanhamento; sem recibo, screenshots ou dossiê obrigatório. Dados de negócio necessários ao ledger e ao replay continuam obrigatórios. Ler esta seção e apenas S correspondente ao prompt, não todas as sessões.

## S1

**G2-02.1 — Classificar dados protegidos e descartáveis.** [Prompt da sessão](../../prompts/ganso-2/g2-02-1-manifesto-preservacao.md). Dependências: G2-00.2, G2-01.1.

**Entrega:** Mapa de dados protegidos, raw dispensável e limites de retenção.

**Contrato desta fatia:** Mapear o conjunto financeiro, versões, ordens, dados pinados e corpus de pesquisa que devem permanecer no banco. Classificar raw sem referências e sem consumidor como candidato a descarte, sem apagá-lo. Reaproveitar seletores e proteções DATA existentes, conferir dependências transitivas e estimar capacidade por classe. O mapa orienta retenção e eventual limpeza delimitada; é um registro operacional curto.

**Aceite proporcional:** Conferir fechamento transitivo de referências e estimativa por catálogo. Nenhum agregado é declarado substituto de L2 sem contrato. Dados necessários permanecem protegidos no banco.

**Implantação:** PR/merge documental; não comprar armazenamento nem remover HOLD nesta sessão.

## S4

**G2-02.4 — Limitar persistência de novos dados BTC.** [Prompt da sessão](../../prompts/ganso-2/g2-02-4-retencao-dados-novos.md). Dependências: G2-02.1, G2-03.1.

**Entrega:** Contrato de armazenamento disponível ao feed e proteção no limite de capacidade.

**Contrato desta fatia:** Criar contrato de TTL/quota/pins para raw, barras, decisões e financeiro do BTC, sem importar semântica binária. Defaults do PRD: raw não pinado até 7 dias/10 GiB; agregado 12 meses; logs 14 dias; ledger e decisões preservados. No limite, recusar escrita não essencial/novo experimento e sinalizar, nunca apagar pins para caber. Entregar seletores e execução restrita à política nova; descarte histórico fica separado.

**Aceite proporcional:** Fixtures de pin transitivo, quota cheia, retenção vencida, repetição e proteção financeira. SQL real quando houver persistência. Captura que não cabe é recusada sem degradação silenciosa de evidência.

**Implantação:** PR/merge/deploy com policy versionada; retenção destrutiva apenas no conjunto novo explicitamente configurado e coberto pelo procedimento, não no corpus legado.

## S5

**G2-02.5 — Executar somente a limpeza legada delimitada.** [Prompt da sessão](../../prompts/ganso-2/g2-02-5-descarte-legado.md). Dependências: G2-01.2, G2-02.1, G2-00.2.

**Entrega:** Conjunto exato tratado ou plano pronto aguardando somente autorização específica do descarte.

**Contrato desta fatia:** Preparar dry-run somente de raw classificado como dispensável, com objetos/cortes exatos, limite por lote, interrupção e espaço de trabalho. Manter no banco o histórico financeiro, pins e dados de pesquisa necessários; não incluir esses dados no descarte. Executar somente quando esse conjunto estiver coberto por autorização específica vigente; se não estiver, apresentar esse resultado pronto como única decisão pendente. Não desligar HOLD global, editar migration aplicada, apagar volume nem fazer prune genérico. Compactação é operação distinta, somente se couber e estiver coberta.

**Aceite proporcional:** Após cada lote, verificar proteção e espaço realmente recuperado, diferenciando DELETE de devolução física ao filesystem. Repetição é idempotente. Resultado cabe na linha de estado e no manifesto que orienta a ação.

**Implantação:** PR/merge do delta de código/procedimento e aplicação do conjunto autorizado; sem ação destrutiva implícita. Este prompt não bloqueia o núcleo se quota e capacidade já permitirem operar.
