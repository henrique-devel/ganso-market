# RFC-046 — Dados públicos BTC e qualidade

**Status:** accepted para execução de seus prompts quando selecionados. **Data:** 22/09/2026. **Marco:** G2-04. Criar esta RFC não implementa nem ativa o resultado.

**Fonte:** [PRD 2.0](../PRD-GANSO-2.0.md), seções 7.3, 9 e 10.1. **Requisitos:** RF-02, RF-03, RF-15. **Roteiro:** [prompts](../../prompts/ganso-2/README.md). **Acompanhamento:** [estado 2.0](../roadmap/GANSO_2_EXECUTION_STATE.md).

## Contrato comum

Um instrumento perpétuo padrão BTC, usando dados públicos de produção, sem credencial de trading. Metadados e regras vêm da fonte atual, não de valores copiados de exemplos. Snapshots/subscriptions exigem contrato de continuidade: marcar lacunas, não inventar sequência ou frescor. Persistência contínua depende da contenção, da retenção e da capacidade disponível.

A [autorização de entrega](../ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-ganso-20--entrega-com-registro-minimo-22092026) cobre código → PR → merge → produção no escopo do prompt. Verificar o resultado e registrar somente a linha de acompanhamento; sem recibo, screenshots ou dossiê obrigatório. Dados de negócio necessários ao ledger e ao replay continuam obrigatórios. Ler esta seção e apenas S correspondente ao prompt, não todas as sessões.

## S1

**G2-04.1 — Integrar metadados do instrumento e adaptador público.** [Prompt da sessão](../../prompts/ganso-2/g2-04-1-instrumento-e-sdk.md). Dependências: G2-03.2.

**Entrega:** Instrumento e metadados versionados disponíveis ao núcleo.

**Contrato desta fatia:** Criar adaptador público fino e fixar versão do SDK adotado. Obter BTC, precisão/mínimos, colateral, taxas de referência e parâmetros de margem/funding com origem/versão. Registrar licença/notices de trechos efetivamente reutilizados. Não copiar default de wallet, alavancagem Jev ou runtime Bun.

**Aceite proporcional:** Testes de contrato com respostas válidas/incompatíveis e falha de rede; uma consulta pública limitada quando rede disponível. Taxa desconhecida não vira zero.

**Implantação:** PR/merge/deploy do adaptador desativado; nenhum cliente de execução real ou segredo.

## S2

**G2-04.2 — Coletar livro, trades, mark e funding com gaps explícitos.** [Prompt da sessão](../../prompts/ganso-2/g2-04-2-feed-e-gaps.md). Dependências: G2-04.1.

**Entrega:** Feed normalizado informa qualidade e falhas sem fabricar continuidade.

**Contrato desta fatia:** Implementar assinaturas necessárias para um BTC, reconexão limitada, dedup e source/received timestamps. Separar socket vivo de canal saudável e de instrumento negociando. Revalidar estado após reconexão conforme semântica real do canal; não supor IDs sequenciais que a API não oferece. Buffers em memória são limitados.

**Aceite proporcional:** Duplicata, evento fora de ordem, conexão viva silenciosa, snapshot após gap e retomada. Validação com stream público curto sem gravação irrestrita; sem induzir carga em produção.

**Implantação:** PR/merge/deploy inativo; persistência/ativação contínua ficam em G2-04.3/4.

## S3

**G2-04.3 — Persistir dados necessários e formar barras fechadas.** [Prompt da sessão](../../prompts/ganso-2/g2-04-3-barras-persistencia.md). Dependências: G2-04.2, G2-02.4.

**Entrega:** Dados/barras consultáveis com qualidade e política de espaço aplicada.

**Contrato desta fatia:** Persistir raw limitado, metadados e barras 15 min/1 h com identidade de origem e versão de construção. Não preencher lacunas como se houvesse negócios; warmup incompleto impede sinal. Registrar pin dos inputs referenciados e projeções eficientes para interface, evitando revarrer raw a cada refresh. Usar migration aditiva se necessário.

**Aceite proporcional:** Barras na fronteira UTC, atraso, dedup, gap e reinício; SQL real demonstra persistência idempotente e quota/pin. Estimar volume por captura curta, sem afirmar sustentabilidade de 90 dias a partir dela.

**Implantação:** PR/merge/deploy com gravação desabilitada até liberação do perfil no próximo bloco.

## S4

**G2-04.4 — Ativar coleta BTC com limites no servidor.** [Prompt da sessão](../../prompts/ganso-2/g2-04-4-ativar-coletor.md). Dependências: G2-04.3, G2-03.3, G2-01.2.

**Entrega:** Coleta BTC limitada em operação; maturidade/observação longa ficam em G2-09.

**Contrato desta fatia:** Revalidar espaço disponível, limites de retenção e orçamento combinado; ativar apenas coleta BTC com limites. Confirmar health por canal, escrita limitada, reconexão e contador de crescimento. Nenhuma estratégia/ordem é ligada. Se o host estiver abaixo do piso de 25%, não adicionar persistência: registrar a dependência exata e manter trabalho local pronto.

**Aceite proporcional:** Checagem breve de eventos reais, metadados e barras quando houver período fechado; diferenciar warmup pendente de falha. Não aguardar dias nesta sessão nem atribuir ausência de gaps futuros.

**Implantação:** PR/merge/configuração e ativação produtiva do coletor estão autorizados, usando host existente e sem compras.
