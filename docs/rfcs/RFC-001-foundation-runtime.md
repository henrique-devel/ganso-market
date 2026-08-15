# RFC-001 — Fundação e runtime

**Status:** implemented

**Dependências:** nenhuma  
**Bloqueia:** todas as demais RFCs  

## Prompt a executar

Você deve implementar a RFC-001 do Ganso Market: fundação do repositório e runtime mínimo.

### Objetivo

Criar uma base pequena e executável para o projeto greenfield, pronta para receber autenticação, Yellowstone, modelos e paper trading sem antecipar a lógica dessas RFCs.

### Contexto obrigatório

- Leia `docs/PRD.md` e `prompts/AI_DEVELOPER_SYSTEM_PROMPT.md` integralmente.
- O alvo é um Hetzner CPX42: 8 vCPU compartilhadas, 16 GB RAM e 320 GB SSD.
- É uma ferramenta pessoal e single-user.
- O modo padrão e único nesta RFC é `paper`.
- Não há backup externo, HA, Kubernetes, Kafka, ClickHouse, GPU ou LLM local.
- O repositório está começando vazio; não invente compatibilidade retroativa.

### Arquitetura esperada

Crie um monorepo com poucos componentes:

- `services/market-engine`: Rust, inicialmente apenas bootstrap, contracts e health;
- `apps/api`: TypeScript com Fastify, autenticação ainda como stub inacessível;
- `apps/web`: React/Vite, tela mínima de status sem dados falsos;
- `workers/model-worker`: Python, somente estrutura e health, sem modelo inventado;
- `packages/contracts`: schemas compartilhados versionados;
- `infra`: Docker Compose, Nginx e configurações;
- `docs`: documentação técnica e runbooks.

Se o ambiente encontrado justificar stack diferente, pare antes de mudar a decisão e apresente evidência objetiva.

### Restrições

- Não implementar login, Yellowstone, estratégias, signer ou execução.
- Não adicionar Redis/NATS sem demonstrar necessidade.
- Não usar secrets reais ou criar exemplo parecido com private key.
- Não expor PostgreSQL ou métricas internas à internet.
- Não adicionar dependência sem versão fixada e licença identificada.
- Não fazer CI depender de rede externa.
- Não usar float em contracts de dinheiro.
- Não marcar health como saudável quando uma dependência obrigatória estiver indisponível.

### Tarefas

1. Inicializar workspaces e ferramentas de lint, format e teste.
2. Definir convenções de nomes, timestamps UTC, IDs, fixed-point e versionamento de schemas.
3. Criar `docker-compose.yml` com:
   - PostgreSQL;
   - market-engine;
   - API;
   - frontend estático;
   - model-worker em profile opcional;
   - Nginx preparado somente em loopback; publicação HTTP pertence à RFC-002.
4. Criar configuração tipada com precedência explícita:
   - defaults seguros;
   - arquivo de configuração não secreto;
   - secret files montados;
   - validação no boot.
5. Criar `.env.example` sem credenciais e deixar claro que private key nunca usa env.
6. Criar endpoints internos `/health/live`, `/health/ready` e `/metrics`.
7. Padronizar logs estruturados com correlation ID e redaction.
8. Criar migrations iniciais para:
   - `app_settings`;
   - `schema_versions`;
   - `audit_events`;
   - sem tabelas de domínio prematuras.
9. Criar shutdown gracioso e ordem de dependências.
10. Criar comandos únicos para:
    - instalar/verificar toolchains;
    - subir ambiente;
    - rodar lint;
    - rodar testes;
    - aplicar migrations;
    - derrubar ambiente sem apagar volumes por padrão.
11. Configurar budgets iniciais de container para não consumir todo o CPX42.
12. Documentar estrutura, fluxo de configuração e desenvolvimento local.

### Contratos mínimos

Defina, sem lógica de negócio:

- `MoneyAmount { raw: integer, decimals: integer, asset_id }`;
- `EventIdentity`;
- `DataFreshness`;
- `ReasonCode`;
- `ServiceHealth`;
- `ExecutionMode` aceitando somente `paper` nesta RFC.

### Artefatos

- Estrutura completa do monorepo.
- Docker Compose funcional.
- Migrations iniciais.
- Schemas compartilhados.
- Health/ready/metrics.
- Logging com redaction.
- Documentação para desenvolvimento.
- Registro de dependências e licenças.
- Testes e comandos reproduzíveis.

### Testes obrigatórios

- Unit tests de parsing/validação da configuração.
- Boot falha com configuração inválida.
- Secrets marcados são redigidos dos logs.
- `ExecutionMode` rejeita valores desconhecidos e `live`.
- API e engine respondem health.
- Readiness muda quando PostgreSQL fica indisponível.
- Shutdown não deixa processo órfão.
- Compose sobe em máquina limpa usando apenas arquivos versionados e secrets de teste.
- Busca automática não encontra chave privada, seed ou o conteúdo de secret files.

### Critérios de aceite

- Todos os componentes sobem dentro do orçamento de 4 GB de RAM sem carga.
- O frontend mostra somente estado real dos health checks; nenhum dado de mercado fictício.
- PostgreSQL não possui porta pública.
- Nenhum código de assinatura ou execução existe.
- Lint e testes passam com resultados registrados.
- Documentação permite a outro agente reproduzir o ambiente.

### Condições de parada

Pare e reporte se:

- a stack escolhida não estiver disponível no ambiente-alvo;
- alguma dependência exigir serviço externo não aprovado;
- a estrutura exigir mais de 4 GB em idle;
- for necessário inventar credenciais, endpoints ou schemas futuros;
- surgir conflito entre este prompt e o PRD;
- qualquer passo exigir apagar dados ou arquivos existentes.
