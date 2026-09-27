# RFC-053 — Ganso 2.0: estabilização e prontidão operacional

**Status:** roteiro solicitado em 27/09/2026; aceito para execução somente nas sessões selecionadas. **Escopo:** continuação G2-11–17, 22 prompts. Criar esta RFC não implementa nem ativa suas entregas.

[Roadmap](../roadmap/GANSO_2_OPERATIONAL_ROADMAP.md) · [Prompts](../../prompts/ganso-2-operacao/README.md) · [Protocolo](../../prompts/ganso-2-operacao/00-protocolo.md) · [Estado único](../roadmap/GANSO_2_EXECUTION_STATE.md).

## Contrato comum

Preservar o PRD 2.0 e contratos financeiros existentes. Separar software entregue, operação paper, integração Jev real e hipótese econômica. Sem novo capital real, aumento de risco, backup como pré-requisito, contratação implícita ou descarte genérico. Código/PR/merge/produção da sessão selecionada seguem a autorização contínua e seus gates; consumo pago exige cobertura explícita. Registro de uma linha, sem dossiê.

Os prompts contêm o delta de cada fatia; esta RFC fixa as fronteiras entre etapas e não reimplementa as RFCs 042–052. Fontes de produção são históricas e devem ser revalidadas. Uma mudança de dados/frescor, cobrança, período econômico ou métrica precisa de versão explícita e compatibilidade, nunca reinterpretação silenciosa de registros antigos.

## S1

**G2-11 — Estabilidade do coletor e da baseline.**

Corrigir causas observadas e preservar causa sanitizada. Lock timeout histórico não identifica o detentor; reproduzir antes de atribuir. Recuperação de rede não recupera continuidade passada. Correções podem ser publicadas contidas até capacidade admitida; não aumentar timeout/pool/restart irrestrito para mascarar falha.

- [G2-11.1](../../prompts/ganso-2-operacao/g2-11-1-diagnostico-e-erros.md) — Diagnóstico atual e erros sanitizados que identifiquem componente, etapa e causa.
- [G2-11.2](../../prompts/ganso-2-operacao/g2-11-2-locks-e-consumidor.md) — Ciclos de conta e persistência não se bloqueiam por trabalho evitável dentro de locks.
- [G2-11.3](../../prompts/ganso-2-operacao/g2-11-3-recuperacao-do-feed.md) — Feed suporta reconexões sustentáveis, com abstenção durante gaps e parada por falhas não recuperáveis.

**Aceite da etapa:** Código corrigido e testado; retomada produtiva ainda depende de capacidade.

## S2

**G2-12 — Capacidade e custo sustentáveis.**

Plano por dados protegidos/raw/índices/WAL e recursos efetivos. Manter piso de 25% + reserva operacional, alvo de lançamento de 40% e projeção de 90 dias conforme PRD; não confundir alvo e piso nem dispensar critério sem decisão explícita. Se acervo protegido tornar a meta impossível, resolver a decisão concreta em G2-12.1 antes de declarar lançamento. Redução de captura futura não autoriza apagar passado; HOLD/pins prevalecem.

- [G2-12.1](../../prompts/ganso-2-operacao/g2-12-1-plano-de-capacidade.md) — Plano executável de armazenamento/CPU para 7, 30 e 90 dias, com decisões externas claramente separadas.
- [G2-12.2](../../prompts/ganso-2-operacao/g2-12-2-persistencia-sustentavel.md) — Volume de novos dados e custo de persistência compatíveis com o plano aprovado.
- [G2-12.3](../../prompts/ganso-2-operacao/g2-12-3-admissao-e-retomada.md) — Coletor retomado sob capacidade comprovada e runtime seletivamente configurado.

**Aceite da etapa:** Coleta cabe no período planejado e preserva reserva, evidência e orçamento.

## S3

**G2-13 — Jornada paper e retomada controlada.**

Prontidão por consumidor/fonte/lease, não apenas HTTP. Jornadas paper conservam toda história. Rearme passa pelo contrato de risco; recuperação da fonte não o dispara automaticamente. Horizonte de 30 dias e eventuais períodos sucessores são explícitos, prospectivos e sem reset de capital. Operação automática sem candidato continua aguardando mercado, mas não bloqueia artefatos independentes.

- [G2-13.1](../../prompts/ganso-2-operacao/g2-13-1-prontidao-visivel.md) — Operador distingue API acessível de dados/contas realmente prontos.
- [G2-13.2](../../prompts/ganso-2-operacao/g2-13-2-jornada-manual.md) — Uma operação simulada legítima percorre ticket, execução, saída e extrato no ambiente ativo.
- [G2-13.3](../../prompts/ganso-2-operacao/g2-13-3-periodos-e-rearme.md) — Procedimento explícito e auditável para retomar a baseline e avaliar novos períodos sem reset de patrimônio.
- [G2-13.4](../../prompts/ganso-2-operacao/g2-13-4-baseline-operacional.md) — Baseline pronta, decisões prospectivas e gestão automática confirmadas sem depender de Jev.

**Aceite da etapa:** Operações e saídas reconciliadas; prontidão sem sinal não equivale a trade.

## S4

**G2-14 — Avaliação completa.**

Equity usa informação conhecida no corte, com marca e qualidade temporal; drawdown observado não promete extremo intrabar. Comparação trata inícios distintos e posições preexistentes, com janela fixada antes do resultado. Replay cobre a janela inteira por cortes limitados, sem dupla incidência. Fatura, benchmark ou marca ausente são desconhecidos, não zero. Não alegar contribuição causal por diferença observacional.

- [G2-14.1](../../prompts/ganso-2-operacao/g2-14-1-historico-de-patrimonio.md) — Histórico de equity utilizável durante posições abertas e reproduzível no corte temporal.
- [G2-14.2](../../prompts/ganso-2-operacao/g2-14-2-curva-e-drawdown.md) — Relatório calcula patrimônio e drawdown em períodos com exposição, com incerteza explícita.
- [G2-14.3](../../prompts/ganso-2-operacao/g2-14-3-janela-comum.md) — Comparação prospectiva usa uma janela comum sem alterar gêneses ou fingir capital/risco iguais.
- [G2-14.4](../../prompts/ganso-2-operacao/g2-14-4-replay-da-janela.md) — Export/replay limitado por lote cobre 2.880 janelas de 15 min e seus eventos sem perda ou dupla contagem.
- [G2-14.5](../../prompts/ganso-2-operacao/g2-14-5-custos-referencias-painel.md) — Painel permite avaliar contas, janela e custos com fontes e limitações visíveis.

**Aceite da etapa:** Contas com inícios distintos são comparáveis e a janela não é truncada.

## S5

**G2-15 — Jev real.**

Jev só filtra a proposta exógena; direção/tamanho/risco/saídas pertencem ao código. Preparação de acesso pode começar cedo; ativação exige qualidade operacional e comparador prontos, não lucro ou trinta dias. Cobertura/teto de cobrança são reais e verificáveis, segredo só no backend. Uma chamada diagnóstico é rotulada e seu custo preservado; não é decisão econômica. Virada mensal não compra crédito nem limpa circuito automaticamente.

- [G2-15.1](../../prompts/ganso-2-operacao/g2-15-1-preparar-acesso-jev.md) — Checklist concreto de configuração com acesso/custo verificados ou lacuna específica identificada.
- [G2-15.2](../../prompts/ganso-2-operacao/g2-15-2-configuracao-e-orcamento-jev.md) — Provisionamento, rotação e reconciliação do orçamento são seguros, explícitos e testados.
- [G2-15.3](../../prompts/ganso-2-operacao/g2-15-3-ativar-jev-real.md) — Challenger real registrado prospectivamente e primeira resposta auditável dentro da cobertura disponível.

**Aceite da etapa:** Resposta real, custo e origem comprovados; credencial ausente não é ativação.

## S6

**G2-16 — Aceite operacional.**

Ensaio limitado de falha/restart e reconciliação, seguido de sete dias efetivos sem reinício inesperado/divergência. Gaps externos ficam visíveis e bloqueiam ações indevidas. Se falta observação, registrar observing; se falha, registrar causa e nova janela preservando a anterior. Aceite do núcleo pode ocorrer sem Jev, com essa limitação explícita.

- [G2-16.1](../../prompts/ganso-2-operacao/g2-16-1-falhas-e-janela-operacional.md) — Falhas/retomada demonstradas e início verificável de uma janela de estabilidade.
- [G2-16.2](../../prompts/ganso-2-operacao/g2-16-2-aceite-sete-dias.md) — Veredito operacional baseado na janela efetivamente observada.

**Aceite da etapa:** Sete dias efetivos e critérios de prontidão aprovados no escopo declarado.

## S7

**G2-17 — Diagnóstico econômico.**

Usar manifesto e janela predefinidos; trinta dias/95% de elegibilidade são requisitos atuais de cobertura, não prova de vantagem. Avaliar após custos, exposição e incerteza; permitir rejeitar ou inconclusivo. G2-17 não escolhe retrospectivamente o melhor período nem promove live. Tempo da observação econômica pode sobrepor estabilidade operacional quando identidade/dados forem compatíveis.

- [G2-17.1](../../prompts/ganso-2-operacao/g2-17-1-cobertura-economica.md) — Amostra econômica auditável, com janelas ausentes e custos contabilizados.
- [G2-17.2](../../prompts/ganso-2-operacao/g2-17-2-decisao-economica.md) — Decisão econômica clara: continuar, nova hipótese, rejeitar ou inconclusivo.

**Aceite da etapa:** Cerca de 30 dias futuros, custos completos e conclusão proporcional à amostra.
