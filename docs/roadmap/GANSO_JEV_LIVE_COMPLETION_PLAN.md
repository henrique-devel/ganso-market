# Plano complementar JEV — JE15 a JE17

Preparado em **09/10/2026**, após a auditoria das entregas JE01–JE14 e da produção. Este documento organiza **três lacunas de código em três entregas agrupadas e 10 checkpoints executáveis**, seguindo o mesmo protocolo, frontmatter, autorização, validação e acompanhamento do pacote original.

**Estado: preparação documental; JE15–JE17 estão `planned`.** Criar/publicar estes prompts não implementa suas entregas, não admite contas e não ativa live. O histórico de JE01–JE14 e dos 52 IDs originais permanece; a extensão acrescenta GJ16–GJ18, totalizando **17 entregas, 62 IDs e as mesmas seis etapas operacionais**.

## Base verificada e lacunas

A auditoria de 09/10/2026 examinou a main `3fe4e0f30b0a45339195c6c97ebc1c5d4f0a16d9` e a release funcional em produção `ff255dc977cfc482eba6e9de473054b74a91567a`, publicada pelo [PR 371](https://github.com/henrique-devel/ganso-market/pull/371). A observação ocorreu entre 16h43 e 16h47 de São Paulo. Confirme novamente main/runtime ao desenvolver; esses fatos não certificam uma revisão posterior.

| Lacuna | Evidência na base auditada | Resultado exigido |
| --- | --- | --- |
| Runtime live desconectado | [execution-worker.ts](../../apps/api/src/execution-worker.ts) constrói os ciclos paper/stress; [jev-worker-store.ts](../../apps/api/src/storage/jev-worker-store.ts) seleciona somente esses modos. [createLiveAdapter](../../apps/api/src/venues/hyperliquid/live-adapter.ts) existe como factory sem caller no runtime. | JE15 conecta admissão, decisão, execução, proteção/reconciliação e sucessão ao entrypoint publicado. |
| Pausa/emergência excluem live | [jev-operator.ts](../../apps/api/src/storage/jev-operator.ts) restringe comandos a paper/stress; [JevPanel.tsx](../../apps/web/src/JevPanel.tsx) exclui live da seleção. | JE16 aplica controle autenticado e durável à conta real e conclui a ação apenas por evidência reconciliada. |
| Painel live incompleto | [jev-panel.ts](../../apps/api/src/storage/jev-panel.ts) deixa métricas live nulas e lê o journal paper para execução/fills; [JevLive.tsx](../../apps/web/src/JevLive.tsx) apresenta promoção/limites, sem toda a visão econômica e operacional. | JE17 projeta fontes live reconciliadas e apresenta resultado, custos, ordens/fills, proteção, decisões e controles. |

JE13–JE14 entregaram componentes reutilizáveis de adaptador, proteção, promoção e sucessão. As novas entregas fecham a conexão entre esses componentes e a operação/painel; não autorizam refazer o núcleo já comprovado.

## Entregas e dependências

| Entrega | Checkpoints | Dependências externas | Condição de fechamento |
| --- | --- | --- | --- |
| [JE15 — Runtime live integrado](../../prompts/jev/entregas/je-15-runtime-live-integrado.md) | GJ16.1–4 | JE07, JE13, JE14 | Processo publicado integra o ciclo live com gates fechados por padrão, proteção independente e recuperação idempotente. |
| [JE16 — Pausa e emergência live](../../prompts/jev/entregas/je-16-pausa-e-emergencia-live.md) | GJ17.1–3 | JE11, JE15 | Comando autenticado chega ao worker/fronteira de envio; pausa conserva proteção e emergência confirma cancelamento/redução. |
| [JE17 — Painel financeiro e operacional live](../../prompts/jev/entregas/je-17-painel-financeiro-e-operacional-live.md) | GJ18.1–3 | JE08, JE11, JE15, JE16 | API/web mostram dados reais reconciliados, custos/qualidade e estado de intervenção, com histórico contínuo. |

**Ordem de execução: JE15 → JE16 → JE17.** A lista por checkpoint detalha dependências de contrato. Partes internas validadas liberam a próxima parte na mesma branch; dependências externas precisam estar integradas ou comprovadas. Cada seleção executa o grupo até revisão, PR, checks, merge e publicação aplicável, sem nova solicitação por checkpoint. Encerrar ao terminar a entrega selecionada, salvo sequência expressa.

JE15 pode ser integrada/publicada desativada antes das outras duas. A prontidão para novas entradas reais precisa exigir a integração e verificação de **todas as três entregas**, além dos gates operacionais existentes. Esse bloqueio de operação não cria dependência circular para desenvolver/publicar código.

## Prompts e critérios de aceite

| ID | Prompt | Resultado verificável |
| --- | --- | --- |
| GJ16.1 | [Admissão, configuração e ownership live](../../prompts/jev/gj-16-1-admissao-configuracao-e-ownership-live.md) | Configuração/identidade explícitas, signer protegido, boot sem ativação e ownership/fencing. |
| GJ16.2 | [Decisões JEV e execução live](../../prompts/jev/gj-16-2-decisoes-jev-e-execucao-live.md) | Dispatch JEV inclui live, com risco, custo, ALO/IOC e recibos idempotentes. |
| GJ16.3 | [Proteção, reconciliação e recuperação live](../../prompts/jev/gj-16-3-protecao-reconciliacao-e-recuperacao-live.md) | Proteção/reconciliação/funding contínuos, independentes de JEV, com recuperação após falha. |
| GJ16.4 | [Promoção, sucessão e integração do runtime](../../prompts/jev/gj-16-4-promocao-sucessao-e-integracao-do-runtime.md) | Promoção/sucessão integrada ao runtime, patrimônio contínuo e integração pelo entrypoint real. |
| GJ17.1 | [Controles live persistentes e autenticados](../../prompts/jev/gj-17-1-controles-live-persistentes-e-autenticados.md) | Pausa/emergência persistidas, autenticadas e verificadas antes de enviar entradas. |
| GJ17.2 | [Cancelamento e encerramento live pelo worker](../../prompts/jev/gj-17-2-cancelamento-e-encerramento-live-pelo-worker.md) | Cancelamento e redução residual pelo worker; confirmação flat sem retirar proteção cedo. |
| GJ17.3 | [Painel de intervenção live e fluxo integrado](../../prompts/jev/gj-17-3-painel-de-intervencao-live-e-fluxo-integrado.md) | Seleção live/all e estados de intervenção no painel, com retry idempotente. |
| GJ18.1 | [Projeção financeira live e custos atribuídos](../../prompts/jev/gj-18-1-projecao-financeira-live-e-custos-atribuidos.md) | PnL, fees, funding e JEV atribuídos por fontes live, com cálculo independente e qualidade. |
| GJ18.2 | [Snapshot live de execução, proteção e decisões](../../prompts/jev/gj-18-2-snapshot-live-de-execucao-protecao-e-decisoes.md) | Snapshot read-only limitado de execução/proteção/decisões, isolado por proprietário. |
| GJ18.3 | [Painel live completo e aceite integrado](../../prompts/jev/gj-18-3-painel-live-completo-e-aceite-integrado.md) | Painel real completo, compreensão dos custos e verificação integrada das três lacunas. |

Cada arquivo contém autorização, contexto mínimo, resultado/limite, checklist de aceite, testes, publicação/gates e fechamento. IDs GJ16–GJ18 evitam conflito com GJ15, que continua dedicado às etapas operacionais originais.

## Contratos preservados

- BTC/Hyperliquid perps; três perfis paper/stress e no máximo um piloto live. US$250 fictícios por conta paper/stress e US$250 reais **totais** do piloto; isolated 1x. Sucessão não reinicia capital/patrimônio/HWM.
- JEV escolhe abrir/manter/fechar e direção. Código determina tamanho, risco e proteção. Cadência 60s; 2s somente com posição aberta e gatilho aprovado. Proteção/redução urgente não esperam JEV.
- Entrada planejada 1% da equity de trading, exposição máxima 50%, perda diária 2% e drawdown fixo US$12,50 desde o pico. Stop 2 ATR com reserva integral da tolerância nativa de 10%; máximo 6h desde primeiro fill. Aplicar os contratos completos do [PRD](../PRD-GANSO-JEV.md), sem mudar fórmulas.
- Entrada maker post-only; após 2s do ACK, cancelar/reconciliar restante e não completar parcial. Saída IOC reduce-only sobre residual; ACK/timeout não prova fill/flat. Stop permanece confirmado desde o primeiro parcial.
- PnL de negociação = realizado + aberto − taxas + funding líquido assinado. Resultado após JEV desconta custo atribuído; conservador usa min(aberto,0). Infra não entra no PnL/aprovação nem no risco; card manual separado.
- Pools JEV mensais agregados US$8 operação e US$2 geração/validação. Request entra uma vez na fatura real; cada participante desconta o lote integral em sua avaliação. Valor desconhecido é indisponível, não zero.
- Pausa/emergência não admitem conta, não ativam signer, não liberam bloqueios nem resetam âncoras. Ativação inicial/rearme global continuam ações humanas específicas já contratadas; não criar trade manual ou retomada automática.
- Eventos/ledger/migrations aplicadas imutáveis; proteger evidência, pins, auth/sessões e perímetro. Nenhuma chave/segredo em Git, logs, banco, chat, fixture ou frontend.

## Validação e publicação

Dentro de cada grupo, implementar e testar os comportamentos críticos antes da parte dependente. Usar fixtures financeiras com resultados calculados independentemente, PostgreSQL descartável e transporte/provider controlados. Ensaios locais não enviam ordens reais nem consomem crédito contratado por este pacote.

No fechamento, cumprir `make verify`, `make test-postgres`, revisão e checks obrigatórios PR/main, incluindo Compose. O teste de integração deve atravessar o **entrypoint realmente publicado** até o adaptador, banco e API/web; somente chamar factories isoladas não comprova runtime conectado.

Cobrir concorrência JEV/fill/cancel/stop, perda de resposta, primeiro parcial, IOC residual, falha da proteção, JEV indisponível, custos desconhecidos, stale/gaps, dois workers, fencing, crash após envio e antes de recibo, restart e sucessão. Cada checkpoint detalha seu recorte; não repetir a suíte completa sem nova alteração/falha que justifique.

Preferir um PR coerente por entrega, com publicação seletiva e operação desativada enquanto gates faltarem. Conferir versão, saúde, persistência e proteções. Reversão pausa entradas e conserva stop/reconciliação, schema compatível e eventos. Texto segue a dispensa de redeploy de serviços.

## Etapas operacionais continuam separadas

| Etapa | Condição preservada |
| --- | --- |
| GJ12.2 | Admitir paper somente com prontidão, coleta/cobertura, capacidade e custo/orçamento admissíveis. |
| GJ12.3 | Comprovar sete dias operacionais válidos; incompletude permanece observing/inconclusiva. |
| GJ13.5 | Ensaio testnet delimitado com conta dedicada, identidade e fundos de teste existentes. Validação de adapter isolado não comprova integração do runtime. |
| GJ15.1 | Conferir JE15–JE17 integradas, qualificação, validação da venue, elegibilidade atual e ato inicial autenticado do operador. |
| GJ15.2 | Observar piloto efetivamente ativo, proteção, custos, controles e reconciliação. |
| GJ15.3 | Verificar janela completa de 90 dias e avaliação rolling sem fabricar observação. |

Elegibilidade inicial continua exigindo 60 episódios fechados em cada paper/stress, cobertura de 99%, contabilidade reconciliada e resultado conservador positivo em ambos. Os 90 dias não acrescentam espera inicial obrigatória ao piloto elegível. Não clicar na ativação em nome do operador.

Na observação de 09/10/2026, o backend JEV estava desativado, não havia contas/perfis/ativação live e o coletor BTC estava parado com gap. Resolver coleta, comprovar capacidade/orçamento, configurar/admitir JEV e cumprir as janelas seguem o roteiro operacional existente; não pertencem às três lacunas de código deste documento. Nenhum desses estados muda pela publicação dos prompts.

## Pedidos prontos para executar

**Começar pela primeira entrega:**

```text
Leia e execute integralmente prompts/jev/entregas/je-15-runtime-live-integrado.md.
Conclua GJ16.1–GJ16.4, avance entre checkpoints sem novo pedido,
faça revisão, PR, checks, merge e publicação aplicável e atualize o estado JEV.
Encerre após JE15. Preserve os gates; não ative signer/live nem execute etapas operacionais.
```

**Depois de JE15 integrada:**

```text
Leia e execute integralmente prompts/jev/entregas/je-16-pausa-e-emergencia-live.md.
Conclua GJ17.1–GJ17.3, com validação, PR, merge e publicação aplicável.
Atualize somente JE16 e seus IDs; encerre após a entrega, mantendo os gates operacionais.
```

**Depois de JE16 integrada:**

```text
Leia e execute integralmente prompts/jev/entregas/je-17-painel-financeiro-e-operacional-live.md.
Conclua GJ18.1–GJ18.3, com validação, PR, merge e publicação aplicável.
Comprove a integração das três lacunas, atualize JE17/seus IDs e encerre.
Não aprovar qualificação, testnet, elegibilidade temporal ou ativação por consequência.
```

## Registro e retomada

O [estado JEV](GANSO_JEV_EXECUTION_STATE.md) recebe JE15–JE17 e os 10 checkpoints como `planned`, sem PR/SHA de implementação. A publicação documental deste pacote não muda esses estados para code-verified/merged/deployed.

Ao desenvolver, atualizar apenas o grupo selecionado e seus IDs efetivamente verificados. Na interrupção, registrar base/branch, delta, testes/falhas e próximo checkpoint. Não criar relatório/recibo separado, novo chat/agente, mensagens externas ou agendamento automaticamente.

Referências: [índice de prompts](../../prompts/jev/README.md), [protocolo](../../prompts/jev/00-protocolo.md), [plano original](GANSO_JEV_IMPLEMENTATION_PLAN.md), [autorização JEV](../ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-jev-com-autonomia-por-bloco).

