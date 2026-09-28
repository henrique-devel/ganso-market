# Protocolo — Ganso 2.0 operacional

**Escopo vigente:** [decisão de 28/09](../../docs/SCOPE.md). Polymarket aposentada, retirada local e produtiva autorizada; JEV futuro. Referências à preservação abrangem BTC e dependências utilizadas. Não reabrir backlog Polymarket nem pedir novamente autorização para sua retirada delimitada.

Aplica-se a `prompts/ganso-2-operacao/*`. Pedido atual prevalece; [autorização contínua](../../docs/ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-ganso-20--entrega-com-registro-minimo-22092026), [RFC-053](../../docs/rfcs/RFC-053-ganso-2-prontidao-operacional.md) e [estado único](../../docs/roadmap/GANSO_2_EXECUTION_STATE.md).

## Entrada e fronteira

1. Conferir raiz/main/alterações/PRs e dependências. Checkout original pode estar antigo; preservar trabalho e reutilizar checkout apropriado, isolando quando necessário.
2. Ler um prompt, contrato comum e sua seção da RFC; consultar linha/dependências, não os 22 prompts nem HANDOFF completo. Alvo inicial até 1.500 palavras de contexto documental e 3–6 arquivos relevantes.
3. Revalidar fatos voláteis no ambiente e contratos externos na documentação oficial. Números de 27/09 são baseline histórica, não estado atual. Confirmar implementação existente antes de refazer.

## Autorização

Ao selecionar uma sessão, código → branch/commit/push → PR → checks/revisão → merge → produção aplicável seguem a autorização contínua, sem nova pergunta a cada etapa. Migrations aditivas, configuração, restart seletivo e operação paper explicitamente previstos continuam dentro do escopo e dos gates. Texto segue dispensa de deploy; leitura sem mudança não exige PR vazio.

O pedido de criar o pacote não seleciona todos os prompts nem autoriza sua execução automática. Credencial não autoriza consumo pago. Compra, custo novo, aumento de orçamento/caps, dados a descartar e perímetro exigem decisão específica quando não houver uma vigente. Preparar resultado concreto e concluir trabalho independente antes de pedir somente o que faltar; não solicitar novamente autorização já concedida.

Backup fica para depois do marco operacional, como decidido pelo proprietário; não introduzir backup, restauração ou contratação como pré-requisito. Preservação dos dados BTC, pins, ledger e reconciliação após reinício continuam obrigatórias; acervo exclusivo da Polymarket tem retirada autorizada.

## Implementação e gates

- Uma mudança coerente por fatia; referência de 3–6 arquivos de lógica e até uma migration. Se exceder por necessidade, delimitar subbloco no mesmo estado; não ativar stub para caber.
- Paper, US$1.000 fictícios por cenário, caps existentes e custos fixed-point. Não somar contas; não resetar saldo, início ou histórico para melhorar números.
- Fonte stale/gap bloqueia aumento de risco; saídas continuam sob seus contratos. Rearme explícito pela função de risco, dono/fence e precondições atuais, nunca UPDATE direto de checkpoint.
- Capacidade considera worker/SQL/filesystem, WAL, equity e replay. Não liberar HOLD, elevar tetos ou executar DELETE/prune por consequência de uma meta. Gate inviável gera decisão concreta, não mudança silenciosa da meta.
- SQL/testes financeiros em PostgreSQL descartável; jamais fabricar fixtures no banco produtivo. Casos de falha controlados ficam no ambiente apropriado. Dados produtivos de validação permanecem como história real da simulação.
- Rodar testes proporcionais, scan/diff e checks exigidos. Sem bypass de proteção. Após aprovação, repetir somente por mudança/falha/risco novo.
- Deploy seletivo com SHA/saúde/função conferidos; preservar PG compartilhado, dados BTC e gestão de posições. Código do coletor pode ser entregue desativado antes de capacidade admitida. Rollback precisa ser compatível com schema e dados.

## Registros e conclusão

No acompanhamento existente, atualizar somente linha da sessão e resumo/próximo passo quando necessário: **status; PR/SHA; validação curta; deploy/pendência**. Sem segundo tracker, recibo, screenshot ou dump obrigatório. Histórico financeiro, custo Jev e observações de equity são dados do produto, não burocracia de sessão.

Estados existentes continuam: pending, in-progress, code-verified, production-verified, observing, blocked e superseded. Uma ativação requerida ainda ausente deve ficar explicitamente pendente/bloqueada, mesmo se o código foi entregue. Dependência técnica pode ser satisfeita pelo artefato publicado quando o prompt distinguir operação posterior; não bloquear métricas por falta de sinal elegível no mercado.

Observação temporal incompleta fica observing, com início real e critério de retorno; não esperar dias, criar automação Codex ou remarcar datas para ocultar gaps. Uma interrupção preserva a janela anterior; nova janela é registrada prospectivamente. Pare no prompt selecionado. A resposta final informa resultado, validação, implantação e única pendência real, se houver.
