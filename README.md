> **07/10/2026 — direção atual:** [operação contínua com JEV](docs/PRD-GANSO-JEV.md), três perfis paper/stress e um piloto live de US$250, condicionado aos gates. [Plano de implementação e implantação](docs/roadmap/GANSO_JEV_IMPLEMENTATION_PLAN.md) · [comparação com o código atual](docs/architecture/ganso-jev-code-map.md) · [52 prompts por sessão](prompts/jev/README.md) · [estado de execução](docs/roadmap/GANSO_JEV_EXECUTION_STATE.md). O pacote é documental; nenhuma funcionalidade ou operação foi ativada. Cada prompt selecionado autoriza alteração, PR, merge e produção dentro de seu escopo.

> As descrições de implementação, transição e decisões do ciclo anterior abaixo são históricas e não comprovam o estado atual de produção. Polymarket permanece aposentada. A direção acima e o [escopo](docs/SCOPE.md) prevalecem sobre menções antigas a JEV futuro/filtro opcional, banca US$1.000 e preservação de Polymarket.

# Ganso Market

Ferramenta pessoal para pesquisa e operações simuladas de **BTC perpétuo na
Hyperliquid**, com dados reais e US$ 1.000 fictícios por cenário. O foco atual
é tornar coleta, mesa manual, baseline, risco, contabilidade e avaliação
operacionais. **JEV é uma evolução futura.**

A [decisão de escopo de 28/09/2026](docs/SCOPE.md) aposenta a Polymarket e
substitui a orientação de preservar seu módulo/acervo. A retirada de código e
dados será verificada nas entregas próprias; esta revisão trata do escopo.

## Desenvolvimento atual

Começar pelo [escopo vigente](docs/SCOPE.md),
[PRD](docs/PRD-GANSO-2.0.md),
[roadmap operacional](docs/roadmap/GANSO_2_OPERATIONAL_ROADMAP.md) e
[estado de execução](docs/roadmap/GANSO_2_EXECUTION_STATE.md).
Selecionar uma fatia em [prompts operacionais](prompts/ganso-2-operacao/README.md)
ou a entrega de retirada do legado. Não reiniciar o ciclo de construção nem
reativar backlog histórico.

O ciclo BTC entregou dados públicos, ledger, reservas, broker, margem, funding,
risco, mesa manual, baseline, replay e painel. Há integração JEV desativada.
Código entregue não comprova coleta ou operação disponíveis: os bloqueios de
capacidade e os aceites pendentes estão no acompanhamento único, com data.

A base usa Node/TypeScript, Fastify, React/Vite, PostgreSQL e Nginx. O modo é
`paper`; não há autorização de execução real Hyperliquid nesta entrega.

## Desenvolvimento local

```sh
make doctor
make install
make verify
make up
```

O gateway local usa `127.0.0.1:8080`. Consulte o
[runbook de desenvolvimento](docs/runbooks/development.md).
`make down` encerra containers sem apagar o volume PostgreSQL.

## Entrega e produção

O fluxo código → PR → checks → merge → produção está
[autorizado](docs/ops/DEVELOPMENT_AUTHORIZATION.md) para as tarefas solicitadas.
Mudanças documentais podem dispensar deploy de serviços; quando solicitada,
a sincronização dos documentos no host é verificada separadamente.

Produção: Hetzner CPX42, acesso conforme
[registro SSH](docs/ops/SERVER_ACCESS.md) e
[runbook](docs/runbooks/single-server.md).
Preservar perímetro single-user, auth e IPv4 allowlisted. Sem SaaS, fundos de
terceiros, live implícito ou aumento de orçamento. Teto de planejamento
US$ 80/mês; backup segue adiado até o marco operacional.

## Referências

- [Índice das RFCs ativas](docs/RFC_INDEX.md)
- [Prompt mestre](prompts/AI_DEVELOPER_SYSTEM_PROMPT.md)
- [Protocolo operacional](prompts/ganso-2-operacao/00-protocolo.md)
- [Dependências e licenças](docs/DEPENDENCIES.md)

Documentos anteriores são registros de sua época. A rota acima define o trabalho
atual; histórico não reabre funcionalidades aposentadas.
