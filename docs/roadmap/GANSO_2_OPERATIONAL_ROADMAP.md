# Roadmap operacional — Ganso Market 2.0

Criado em **27/09/2026**, a pedido do proprietário, após análise de prontidão. **Sete etapas, 22 prompts; nenhuma executada por esta publicação.** O roteiro G2-00–10 encerrou a construção nos aceites delimitados; G2-11–17 tratam as lacunas para operar e avaliar.

[Abrir os prompts](../../prompts/ganso-2-operacao/README.md) · [Protocolo](../../prompts/ganso-2-operacao/00-protocolo.md) · [RFC-053](../rfcs/RFC-053-ganso-2-prontidao-operacional.md) · [Acompanhamento único](GANSO_2_EXECUTION_STATE.md).

## Ponto de partida

Main da análise: `7973976`; release funcional `980c66c`, schema 45. Consultas somente leitura de 27/09 09:49–09:53 UTC: API/web/PG ativos; coletor parado desde 26/09 22:07 UTC por 55P03 em capacity; baseline REDUCE_ONLY e consumidor indisponível, 250 falhas genéricas na janela de logs de 15 min. Duas gêneses de US$1.000 fictícios, zero ordens/comandos/fills; Jev sem configuração, chave montada, budgets ou chamadas. Banco aproximadamente 207,13 GB; filesystem com 28,46% livre. A taxa histórica sugeria cerca de 20h adicionais antes do teto lógico do worker, não duração garantida.

Código examinado mostrou: reconexões limitadas por sessão; equity/drawdown indisponíveis após exposição; relatório desde a gênese incompatível com início posterior do Jev; replay limitado por artefato a 256 decisões/4.096 eventos. Esses limites precisam ser revalidados ao selecionar cada sessão; não são prova de falha econômica. A main mais recente pode já conter correções.

## Ordem e marcos

| Etapa | Entregas | Aceite |
| --- | --- | --- |
| G2-11 — Estabilidade do coletor e da baseline | Diagnóstico → contenção/consumidor → recuperação do feed | Código corrigido e testado; retomada produtiva ainda depende de capacidade. |
| G2-12 — Capacidade e custo sustentáveis | Plano → persistência → admissão/retomada | Coleta cabe no período planejado e preserva reserva, evidência e orçamento. |
| G2-13 — Jornada paper e retomada controlada | Prontidão → manual → períodos/rearme → baseline | Operações e saídas reconciliadas; prontidão sem sinal não equivale a trade. |
| G2-14 — Avaliação completa | Equity → drawdown → janela comum → replay → painel/custos | Contas com inícios distintos são comparáveis e a janela não é truncada. |
| G2-15 — Jev real | Acesso/cobertura → configuração/orçamento → ativação | Resposta real, custo e origem comprovados; credencial ausente não é ativação. |
| G2-16 — Aceite operacional | Falhas/retomada → sete dias | Sete dias efetivos e critérios de prontidão aprovados no escopo declarado. |
| G2-17 — Diagnóstico econômico | Cobertura → decisão | Cerca de 30 dias futuros, custos completos e conclusão proporcional à amostra. |

Fluxo principal: **estabilidade → capacidade → jornada paper → avaliação → Jev → sete dias → diagnóstico econômico**. A prioridade segue essa ordem; dependências técnicas exatas estão nos prompts. Nenhuma sessão inicia a seguinte automaticamente.

**Primeiro prompt:** [G2-11.1 — diagnóstico e erros](../../prompts/ganso-2-operacao/g2-11-1-diagnostico-e-erros.md).

**Trabalho adiantável:** G2-15.1 e preparação de G2-15.2 podem começar após diagnóstico, sem cobrança. Código de métricas pode avançar com ambiente descartável se falta sinal de mercado/decisão externa; somente ativação e aceite dependentes ficam retidos. Sessões concorrentes exigem pedido e coordenação dos arquivos, não são criadas por este roteiro.

## Quando Jev entra

1. Preparar conta, chave por canal protegido, tarifa fixada, cobertura e limite em G2-15.1. A documentação oficial atual é revalidada nessa sessão; preço publicado não comprova saldo.
2. Entregar configuração/provisionamento e ciclo mensal em G2-15.2. O backend atual procura `/etc/ganso/jev/config.json` e `/run/secrets/jev_api_key`; não basta adicionar uma variável genérica. Chave não autoriza gasto.
3. Ativar em G2-15.3, depois de coleta/capacidade/jornada prontos e comparação por janela corrigida. Não esperar trinta dias nem lucro; não perguntar novamente por cobertura já explicitamente autorizada e disponível.
4. Preservar a mesma política-base e conta independente, com input/resposta/custo/origem/deadline. Erro bloqueia só nova entrada da variante; saída/risco continuam. Jev ausente não impede validar o núcleo sem IA, mas não permite declarar experiência com Jev concluída.

US$5/mês continua proposta de teto, não crédito. O teto total de planejamento é US$80/mês; fatura real e cobertura de IA devem caber nele. O limite total faturável por tentativa exigido no adaptador precisa de prova ou controle equivalente verificável; contexto máximo sozinho não basta. Sem contratação ou aumento de orçamento implícitos.

## Relógios e critérios de pronto

| Marco | Condição | O que não demonstra |
| --- | --- | --- |
| Código entregue | Testes proporcionais/checks e implantação aplicável | Dados frescos, ativação ou período observado |
| Paper utilizável | Dados/capacidade, jornada manual, baseline pronta, saídas e ledger reconciliados | Lucro ou sete dias estáveis |
| Operação automática demonstrada | Candidato legítimo percorreu entrada/execução/saída; sem forçar sinal | Vantagem da estratégia |
| Jev ativo | Cobertura e primeira resposta real identificada, conta/controle funcionando | Allow, fill ou benefício econômico automático |
| Prontidão operacional | Sete dias efetivos + jornadas + recuperação + custos/capacidade aprovados | Rentabilidade |
| Hipótese avaliada | Cerca de 30 dias, ≥2.736/2.880 janelas elegíveis, dados/custos/referências suficientes | Promoção automática para dinheiro real |

Não há estimativa responsável de dias de implementação antes de reproduzir a contenção. Warmup pode exigir 12 barras horárias válidas; tempo sem dados não aquece a estratégia. Sete dias começam no marco efetivo após os ensaios planejados; a janela econômica é registrada **antes** dos resultados e pode correr em paralelo. G2-17 apenas a avalia, não escolhe retrospectivamente seu início. Esperar sete dias antes de ativar IA não é requisito.

As datas antigas 03/10 e 26/10 eram retornos condicionais, não compromissos deste roteiro. Interrupções preservam a janela original; eventual período sucessor tem registro prospectivo, sem apagar perdas/gaps. O horizonte de entradas da baseline precisa comportar a janela comum com Jev; G2-13.3/14.3 resolvem isso sem reset ou extensão silenciosa. Nenhuma sessão espera dias em loop ou cria agendamento Codex sem pedido.

## Decisões que podem depender do proprietário

| Decisão concreta | Preparação responsável | Como seguir enquanto faltar |
| --- | --- | --- |
| Capacidade não cabe preservando acervo | G2-12.1 delimita bytes, alternativa, custo e gates; descarte exige conjunto exato | Publicar correções/código seguro; não retomar coleta sem capacidade |
| Acesso e consumo Jev | G2-15.1 confirma credencial/cobertura sem expor segredo; 15.2 entrega configuração | Baseline e avaliação sem IA continuam |
| Fatura/custo desconhecido | G2-12.1/14.5 identificam valores e método de rateio faltantes | Trading continua reportado; resultado após custos permanece desconhecido |
| Horizonte precisa novo período | G2-13.3 prepara registro prospectivo e continuidade sem capital novo | Preservar saídas/histórico e suspender novas entradas expiradas |

Reutilizar autorizações anteriores aplicáveis. Compra, migração, descarte, mudança de caps/perímetro e dinheiro real não estão aprovados por criar prompts. Backup continua fora do pré-requisito até o marco operacional, conforme decisão vigente. Não reativar Polymarket para concluir BTC.

## Registro e conclusão

Usar apenas o estado existente, agora com linhas G2-11–17. O bloco original de 45 sessões permanece histórico, com seus resultados e duas observações pendentes preservados; novo roadmap não converte esses aceites em 100%. A avaliação futura pode referenciar G2-09.4/5 sem alterar retroativamente seu histórico.

Cada sessão registra status, PR/SHA, uma frase de validação e deploy/pendência. Sem recibo ou dossiê obrigatório. Quando faltarem dias, usar observing; quando código existir mas ativação faltar, informar ambos. Fecho final distingue núcleo paper operante, Jev ativo e hipótese econômica avaliada. Live Hyperliquid exige outro marco e autorização específica.
