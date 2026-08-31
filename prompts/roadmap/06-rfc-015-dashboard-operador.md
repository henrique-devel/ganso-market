# RFC-015 — dashboard do operador: PnL no topo, visão geral, português, fim do "unknown"

Você vai transformar o painel de listas em um painel de operação, ATÉ O FINAL: RFC → código
→ testes → merge → CD → rebuild → verificação no navegador e no perímetro → HANDOFF.
Escopo aprovado pelo proprietário em 2026-08-28 (reposicionado DEPOIS da cobertura de
modelo, por decisão dele).

## Autorização e regras permanentes

- **SSH autorizado pelo proprietário**: `ssh -i ~/.ssh/id_ed25519 root@178.105.65.251`
  (checkout em `/opt/ganso-market`). Leitura livre; escrita SOMENTE em deploy. Nunca imprima
  secrets.
- Ordem de fontes: este prompt → decisões do proprietário → RFC-002 (perímetro) → código.
  Leia `docs/HANDOFF.md` e `git log` antes; re-verifique o estado do frontend.
- Deploy em TRÊS passos; `web` e `nginx` são serviços default (o CD os recria quando a
  config muda — foi assim no botão de rearme). `make verify` verde antes de cada PR.
- **Perímetro é a invariante central desta RFC:** GET-only + auth de sessão; locations
  EXATOS para tudo sob `/paper` (prefixo publicaria `POST /paper/intents`, que cria ordens);
  `scripts/tests/test_nginx_perimeter.py` é atualizado JUNTO de cada location novo. Nenhum
  endpoint de escrita novo.

## Estado medido (28/08; re-verifique)

- 3 abas (Status; Resolução com ~10 seções empilhadas; Portfólio com 6 sub-abas), listas de
  até 200–500 linhas sem paginação/virtualização, polling 15/30 s, tema escuro único, zero
  SSE/WebSocket (`proxy_read_timeout 5s` global mataria stream).
- **PnL existe e não aparece:** `GET portfolio/state` publica `realized_pnl_day_usd`/
  `week`, banca, equity, drawdown — o frontend PARSEIA (portfolio.ts) e nunca renderiza.
  `GET /polymarket/paper/performance` (3 colunas + não-realizado + fees) existe na API e
  está FECHADO no Nginx — **publicação aprovada pelo proprietário em 28/08** (location
  exato, padrão do rearm).
- 'unknown' visível vem de `COALESCE(category,'unknown')` no relatório por categoria
  (resolution/report.ts) renderizado cru; a causa raiz (categorias apagadas) foi corrigida
  no PR #49; os **308 terminais históricos são permanentes por design** (anti-look-ahead).
- Valores de domínio em inglês cru na tela: NORMAL/HALTED, PASS/INSUFFICIENT_DATA,
  VETO/CIRCUIT_BREAKER, reason codes, binding_constraint, categorias.
- Lição de 31/08 (incidente real): bundle antigo em memória fez o botão de rearme "não
  funcionar" — o login in-app não recarrega o SPA; `index.html` é no-store, um reload
  resolve. O painel precisa denunciar a própria versão.

## Escopo

1. **Faixa de PnL persistente** (todas as abas): PnL dia/semana (já publicados),
   não-realizado e fees (via `/paper/performance` publicado), equity/banca, drawdown com
   barra até o limite de 10%, badges de estado do portfólio e do kill switch, banner
   SIMULAÇÃO.
2. **Aba "Visão geral" (default):** cards por domínio (coleta, modelo/shadow, resolução,
   broker paper, gates G1–G6 + `rfc_009_status`, dados/disco) + **feed de eventos** via
   `GET /polymarket/events?after=<cursor>` novo (keyset sobre tabelas existentes — state
   events, decisões-mudança, ordens/fills, violações, divergências, kill switch — SEM
   migration), poll de 5 s. SSE fica explicitamente FORA (fase 2 futura, location dedicado).
3. **Endpoint agregador** `GET /polymarket/overview` (1 chamada no lugar de ~11 por ciclo).
4. **Dicionário PT** (módulo código→rótulo+frase de consequência: "HALTED → Parado — não sai
   sozinho; exige ação sua"), mantendo o código original em tooltip/`<code>` como evidência.
   Categorias: crypto→Cripto, macro→Macro, weather→Clima (legado), e o bucket histórico como
   **"Sem categoria (anterior a 25/08)"** — rótulo que explica, não esconde (troque o
   literal em report.ts por código estável tratado na UI, se preferir).
5. **Publicações no Nginx** (todas exatas, GET-only, com teste de perímetro): `location =
   /api/polymarket/paper/performance` (aprovada); `data-quality` SÓ depois de corrigir a
   definição do `budget_used_pct` (débito conhecido: físico de subconjunto vs vivo da lista
   completa — alinhar com a métrica do alarme pós-#50, é contrato de API).
6. **Tabelas compactas**: paginação client-side/linha expansível nas listas de 200–500;
   renderizar os campos de risco já publicados e invisíveis (invalidation, scenarios,
   limiters, idade dos dados).
7. **Caronas obrigatórias:** timeout/AbortController no polling do Portfólio (as outras
   abas têm, ela não); key estável nas decisões (hoje `Math.random()`); **release-sha/build
   visível no rodapé** + aviso "recarregue" quando a API reportar revisão ≠ bundle (lição
   de 31/08). Se o 500 de `GET /polymarket/decisions` (31/08 18:21Z) ainda não foi
   investigado (prompt 01), reproduza e corrija aqui.
8. **Aba "Rápidos"** (updown/barreira por janela real, spread, custo de ida-e-volta): SÓ se
   a RFC-016 estiver em produção (cheque); senão registre como fase 2 desta RFC.

## Verificação

- Nginx: cada location novo responde 401 sem sessão e 404 no método errado, de dentro do
  servidor; `test_nginx_perimeter.py` verde; POST /paper/intents segue 404.
- Navegador (login real do proprietário não é seu — use screenshots/preview local com API
  real quando possível): PnL visível em todas as abas; visão geral carrega com 1–2
  requisições; textos PT; zero 'unknown' cru.
- Zero migration. HANDOFF + status no README da pasta. Condições de parada: qualquer
  prefixo sob /paper no edge; endpoint de escrita novo; publicar `budget_used_pct` sem
  corrigir a definição.
