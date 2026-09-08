// Typed client for the RFC-013 portfolio endpoints. Same contract as the
// RFC-012 client: every validator degrades gracefully — missing or malformed
// fields become null / empty arrays, rows without a usable key are dropped, and
// nothing throws on garbage input.

import { authorizedGet } from "./resolution";
import type { ResolutionFetcher, ResolutionGetResult } from "./resolution";

/** Níveis de livro que a tela mostra por lado (RFC-026 D6). */
export const BOOK_LEVELS = 10;

export type PortfolioStateName = "NORMAL" | "REDUCE_ONLY" | "HALTED";
export type GateStatus = "PASS" | "FAIL" | "INSUFFICIENT_DATA";

export interface PanelLimiter {
  readonly constraint: string;
  readonly max_shares: string | null;
}

/**
 * Um nível do livro L2, como o motor grava: preço e tamanho em texto decimal.
 *
 * Texto e não `number` porque é o preço com que a conta do edge foi feita —
 * arredondar aqui produziria uma tela que discorda da decisão que ela explica.
 */
export interface BookLevel {
  readonly price: string;
  readonly size: string;
}

/** The RFC's task-6 fields, as the panel snapshot stores them. */
export interface OpportunityPanel {
  readonly market_bid: string | null;
  readonly market_ask: string | null;
  readonly microprice: string | null;
  readonly q: string | null;
  readonly q_lo: string | null;
  readonly q_hi: string | null;
  readonly estimate_source: string | null;
  readonly suggested_side: string | null;
  readonly spread: string | null;
  readonly edge_gross: string | null;
  readonly edge_net: string | null;
  readonly fee: string | null;
  readonly slippage: string | null;
  readonly capital: string | null;
  readonly resolution_buffer: string | null;
  readonly safety_margin: string | null;
  readonly max_size_shares: string | null;
  readonly binding_constraint: string | null;
  readonly limiters: readonly PanelLimiter[];
  readonly resolution_action: string | null;
  readonly p_5050: string | null;
  readonly expected_lockup_s: number | null;
  readonly entry_reason: string | null;
  readonly invalidation_condition: string | null;
  readonly book_age_ms: number | null;
  readonly estimate_age_ms: number | null;
  readonly resolution_age_ms: number | null;
  readonly worst_case: string | null;
  /**
   * RFC-026 D6: os dez níveis de cada lado que o motor grava e o parser
   * descartava desde a RFC-013 — só `book.spread` saía daqui.
   *
   * Medido em produção 2026-09-08 sobre os 200 snapshots mais recentes: o
   * máximo é 10 de cada lado, e um livro fino chega com menos (8 bids num
   * mercado observado). A lista vem na ordem do motor — melhor preço
   * primeiro — e é truncada em 10 para que um payload inesperado não estique
   * a tela.
   */
  readonly book_bids: readonly BookLevel[];
  readonly book_asks: readonly BookLevel[];
  /** Só o modo engenheiro mostra: trecho da regra e mercados correlacionados. */
  readonly rule_excerpt: string | null;
  readonly correlated_markets: readonly string[];
  readonly best_case: string | null;
  readonly likely_case: string | null;
  readonly fifty_fifty_case: string | null;
}

export interface Opportunity {
  readonly condition_id: string;
  readonly token_id: string;
  /**
   * RFC-026 D2: o nome do mercado, do registro (`polymarket_markets.question`).
   *
   * `null` significa que o mercado não tem linha no registro — a tela escreve
   * "sem nome" em cinza e mantém o `condition_id` no `title`. Nunca célula
   * vazia, nunca hash fazendo o papel de nome.
   */
  readonly question: string | null;
  readonly category: string | null;
  readonly computed_at: string | null;
  readonly entrable: boolean;
  readonly vetoed: boolean;
  readonly veto_reason: string | null;
  readonly config_version: string | null;
  /**
   * RFC-016 real end instant, versioned chain first (see the endpoint).
   *
   * `null` means the market has no recorded end instant at all — NOT that it
   * has no deadline. The "Rápidos" tab says so rather than sorting it last.
   */
  readonly end_ts: string | null;
  readonly panel: OpportunityPanel;
}

export interface Exposure {
  readonly dimension: string;
  readonly dimension_key: string;
  readonly worst_case_usd: number | null;
  readonly cap_usd: number | null;
  readonly utilization: number | null;
  readonly position_count: number | null;
  readonly unwind_cost_usd: number | null;
}

export interface PortfolioStateRow {
  readonly state: PortfolioStateName;
  readonly reason: string | null;
  readonly bankroll_usd: number | null;
  readonly high_water_mark_usd: number | null;
  readonly equity_usd: number | null;
  readonly drawdown: number | null;
  readonly realized_pnl_day_usd: number | null;
  readonly realized_pnl_week_usd: number | null;
  readonly reduce_only_until: string | null;
  readonly halted_at: string | null;
  readonly manual_halt: boolean;
  readonly updated_at: string | null;
}

export interface StateTransition {
  readonly from_state: string | null;
  readonly to_state: string | null;
  readonly reason: string | null;
  readonly trigger_source: string | null;
  readonly at: string | null;
}

export interface PortfolioStateSnapshot {
  readonly state: PortfolioStateRow | null;
  readonly transitions: readonly StateTransition[];
  readonly openBreakers: readonly {
    readonly kind: string;
    readonly scope: string | null;
    readonly condition_id: string | null;
    readonly started_at: string | null;
  }[];
}

export interface Gate {
  readonly gate: string;
  readonly status: GateStatus | null;
  readonly reason_code: string | null;
  readonly metrics: Readonly<Record<string, unknown>>;
  readonly measured_at: string | null;
}

export interface GateSnapshot {
  readonly rfc009Status: string | null;
  readonly calibratedExpectation: string | null;
  readonly gates: readonly Gate[];
}

export interface Decision {
  readonly decision_id: number | null;
  readonly decision_kind: string | null;
  readonly condition_id: string | null;
  readonly token_id: string | null;
  readonly question: string | null;
  readonly category: string | null;
  readonly decision_ts: string | null;
  readonly market_side: string | null;
  readonly edge_net: number | null;
  readonly size_shares: number | null;
  readonly binding_constraint: string | null;
  readonly outcome: string | null;
  readonly reason_code: string | null;
  readonly portfolio_state: string | null;
  /**
   * Preço com que a decisão foi precificada, em texto decimal.
   *
   * É o que marca o nível no livro L2 da Mesa: sem ele, a tela mostraria dez
   * níveis e nenhuma indicação de onde a ordem sugerida cairia.
   */
  readonly exec_price: string | null;
  /**
   * A ordem paper que nasceu desta decisão, ou `null`.
   *
   * Um aceite com `null` aqui é uma decisão que não virou nada — o caso que a
   * RFC-026 D7 põe no bloco "O que eu faço agora?". Antes desta RFC a coluna
   * existia no banco (migration 0014) e não saía da API, então a tela mostrava
   * o aceite e não podia mostrar que ele morreu ali.
   */
  readonly paper_order_id: number | null;
}

// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asKey(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumeric(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asParsedJson(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  return value;
}

function nested(
  record: Record<string, unknown>,
  path: readonly string[],
): unknown {
  let current: unknown = record;
  for (const key of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

/** Até 10 níveis, na ordem em que o motor gravou; lixo vira lista vazia. */
function parseBookSide(raw: unknown): readonly BookLevel[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .flatMap((item): BookLevel[] => {
      if (!isRecord(item)) {
        return [];
      }
      const price = asKey(item.price);
      const size = asKey(item.size);
      return price === null || size === null ? [] : [{ price, size }];
    })
    .slice(0, BOOK_LEVELS);
}

function parseStrings(raw: unknown): readonly string[] {
  return Array.isArray(raw)
    ? raw.flatMap((item) => {
        const text = asKey(item);
        return text === null ? [] : [text];
      })
    : [];
}

function parsePanel(raw: unknown): OpportunityPanel {
  const record = isRecord(asParsedJson(raw))
    ? (asParsedJson(raw) as Record<string, unknown>)
    : {};
  const limitersRaw = nested(record, ["max_size", "limiters"]);
  const limiters = Array.isArray(limitersRaw)
    ? limitersRaw.flatMap((item): PanelLimiter[] => {
        if (!isRecord(item)) {
          return [];
        }
        const constraint = asKey(item.constraint);
        return constraint === null
          ? []
          : [{ constraint, max_shares: asString(item.max_shares) }];
      })
    : [];
  return {
    market_bid: asString(nested(record, ["market_probability", "bid"])),
    market_ask: asString(nested(record, ["market_probability", "ask"])),
    microprice: asString(nested(record, ["market_probability", "microprice"])),
    q: asString(nested(record, ["estimate", "q"])),
    q_lo: asString(nested(record, ["estimate", "q_lo"])),
    q_hi: asString(nested(record, ["estimate", "q_hi"])),
    estimate_source: asString(nested(record, ["estimate", "source"])),
    suggested_side: asString(record.suggested_side),
    spread: asString(nested(record, ["book", "spread"])),
    edge_gross: asString(nested(record, ["edge", "gross"])),
    edge_net: asString(nested(record, ["edge", "net"])),
    fee: asString(nested(record, ["costs", "fee"])),
    slippage: asString(nested(record, ["costs", "slippage"])),
    capital: asString(nested(record, ["costs", "capital"])),
    resolution_buffer: asString(nested(record, ["costs", "resolution_buffer"])),
    safety_margin: asString(nested(record, ["costs", "safety_margin"])),
    max_size_shares: asString(nested(record, ["max_size", "shares"])),
    binding_constraint: asString(
      nested(record, ["max_size", "binding_constraint"]),
    ),
    limiters,
    resolution_action: asString(nested(record, ["resolution_risk", "action"])),
    p_5050: asString(nested(record, ["resolution_risk", "p_5050"])),
    expected_lockup_s: asNumeric(
      nested(record, ["resolution_risk", "expected_lockup_s"]),
    ),
    entry_reason: asString(record.entry_reason),
    invalidation_condition: asString(record.invalidation_condition),
    book_age_ms: asNumeric(nested(record, ["data_freshness", "book_age_ms"])),
    estimate_age_ms: asNumeric(
      nested(record, ["data_freshness", "estimate_age_ms"]),
    ),
    resolution_age_ms: asNumeric(
      nested(record, ["data_freshness", "resolution_age_ms"]),
    ),
    worst_case: asString(nested(record, ["scenarios", "worst"])),
    book_bids: parseBookSide(nested(record, ["book", "bids"])),
    book_asks: parseBookSide(nested(record, ["book", "asks"])),
    rule_excerpt: asString(record.rule_excerpt),
    correlated_markets: parseStrings(record.correlated_markets),
    best_case: asString(nested(record, ["scenarios", "best"])),
    likely_case: asString(nested(record, ["scenarios", "likely"])),
    fifty_fifty_case: asString(nested(record, ["scenarios", "fifty_fifty"])),
  };
}

function parseOpportunity(row: unknown): Opportunity | null {
  if (!isRecord(row)) {
    return null;
  }
  const tokenId = asKey(row.token_id);
  const conditionId = asKey(row.condition_id);
  if (tokenId === null || conditionId === null) {
    return null;
  }
  return {
    condition_id: conditionId,
    token_id: tokenId,
    question: asKey(row.question),
    category: asKey(row.category),
    computed_at: asString(row.computed_at),
    entrable: row.entrable === true,
    vetoed: row.vetoed === true,
    veto_reason: asString(row.veto_reason),
    config_version: asString(row.config_version),
    end_ts: asString(row.end_ts),
    panel: parsePanel(row.panel_json),
  };
}

function mapRows<T>(value: unknown, parse: (row: unknown) => T | null): T[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((row) => {
    const parsed = parse(row);
    return parsed === null ? [] : [parsed];
  });
}

export function fetchOpportunities(
  accessToken: string,
  fetcher: ResolutionFetcher = fetch,
  signal?: AbortSignal,
): Promise<ResolutionGetResult<readonly Opportunity[]>> {
  return authorizedGet(
    "/api/polymarket/opportunities",
    accessToken,
    (body) =>
      isRecord(body) ? mapRows(body.opportunities, parseOpportunity) : null,
    fetcher,
    signal,
  );
}

// ---------------------------------------------------------------------------
// RFC-026 D10 (PR 3) — séries de preço
// ---------------------------------------------------------------------------

/**
 * Um bucket de 1 minuto de `polymarket_series_1m`.
 *
 * Os quatro mids ficam em TEXTO decimal, como o resto do dinheiro nesta tela:
 * quem desenha converte para número na hora de calcular a geometria, e a
 * conversão morre ali. `null` é "não coletado" — a coluna aceita nulo e ~6 %
 * dos buckets da última hora estão assim —, e nunca zero.
 */
export interface SeriesPoint {
  readonly bucket_start: string;
  readonly mid_open: string | null;
  readonly mid_high: string | null;
  readonly mid_low: string | null;
  readonly mid_close: string | null;
  readonly updates_count: number | null;
}

/** Teto do lote, igual ao da API (RFC-026 D10). */
export const SERIES_BATCH_MAX_TOKENS = 25;
/** Janela do sparkline: 60 buckets de 1 min. */
export const SPARKLINE_WINDOW_MS = 60 * 60 * 1000;
/**
 * Janela do gráfico do detalhe.
 *
 * A D10 pedia 24 h; medido em produção em 08/09, um token denso a 24 h dá p95
 * 700 ms (4 de 24 amostras acima do teto de 500 ms) e a 12 h dá p95 77,5 ms. A
 * API recusa janela maior com 400, então este número e o de lá são o mesmo
 * número — mudar um sem o outro produz uma tela que só sabe pedir 400.
 */
export const CHART_WINDOW_MS = 12 * 60 * 60 * 1000;

function parseSeriesPoint(row: unknown): SeriesPoint | null {
  if (!isRecord(row)) {
    return null;
  }
  const bucket = asKey(row.bucket_start);
  if (bucket === null) {
    return null;
  }
  return {
    bucket_start: bucket,
    mid_open: asString(row.mid_open),
    mid_high: asString(row.mid_high),
    mid_low: asString(row.mid_low),
    mid_close: asString(row.mid_close),
    updates_count: asNumeric(row.updates_count),
  };
}

/**
 * As séries da página visível da Mesa, em UMA requisição.
 *
 * `tokens` já vem cortado em `SERIES_BATCH_MAX_TOKENS` pelo chamador; passar
 * mais que isso é 400 na API, e não uma resposta truncada.
 */
export function fetchSeriesBatch(
  accessToken: string,
  tokens: readonly string[],
  from: Date,
  fetcher: ResolutionFetcher = fetch,
  signal?: AbortSignal,
): Promise<ResolutionGetResult<ReadonlyMap<string, readonly SeriesPoint[]>>> {
  const query = new URLSearchParams({
    tokens: tokens.join(","),
    metric: "ohlc",
    from: from.toISOString(),
  });
  return authorizedGet(
    `/api/polymarket/series?${query.toString()}`,
    accessToken,
    (body) => {
      if (!isRecord(body) || !isRecord(body.series)) {
        return null;
      }
      const series = body.series;
      return new Map(
        Object.keys(series).map((token) => [
          token,
          mapRows(series[token], parseSeriesPoint) as readonly SeriesPoint[],
        ]),
      );
    },
    fetcher,
    signal,
  );
}

/** A série de um mercado, para o gráfico do detalhe. */
export function fetchSeries(
  accessToken: string,
  tokenId: string,
  from: Date,
  fetcher: ResolutionFetcher = fetch,
  signal?: AbortSignal,
): Promise<ResolutionGetResult<readonly SeriesPoint[]>> {
  const query = new URLSearchParams({
    metric: "ohlc",
    from: from.toISOString(),
  });
  return authorizedGet(
    `/api/polymarket/series/${encodeURIComponent(tokenId)}?${query.toString()}`,
    accessToken,
    (body) => (isRecord(body) ? mapRows(body.points, parseSeriesPoint) : null),
    fetcher,
    signal,
  );
}

function parseExposure(row: unknown): Exposure | null {
  if (!isRecord(row)) {
    return null;
  }
  const dimension = asKey(row.dimension);
  const key = asKey(row.dimension_key);
  if (dimension === null || key === null) {
    return null;
  }
  return {
    dimension,
    dimension_key: key,
    worst_case_usd: asNumeric(row.worst_case_usd),
    cap_usd: asNumeric(row.cap_usd),
    utilization: asNumeric(row.utilization),
    position_count: asNumeric(row.position_count),
    unwind_cost_usd: asNumeric(row.unwind_cost_usd),
  };
}

export function fetchExposures(
  accessToken: string,
  fetcher: ResolutionFetcher = fetch,
  signal?: AbortSignal,
): Promise<ResolutionGetResult<readonly Exposure[]>> {
  return authorizedGet(
    "/api/polymarket/portfolio/exposure",
    accessToken,
    (body) => (isRecord(body) ? mapRows(body.exposures, parseExposure) : null),
    fetcher,
    signal,
  );
}

function parseStateRow(raw: unknown): PortfolioStateRow | null {
  if (!isRecord(raw)) {
    return null;
  }
  const state = raw.state;
  if (state !== "NORMAL" && state !== "REDUCE_ONLY" && state !== "HALTED") {
    return null;
  }
  return {
    state,
    reason: asString(raw.reason),
    bankroll_usd: asNumeric(raw.bankroll_usd),
    high_water_mark_usd: asNumeric(raw.high_water_mark_usd),
    equity_usd: asNumeric(raw.equity_usd),
    drawdown: asNumeric(raw.drawdown),
    realized_pnl_day_usd: asNumeric(raw.realized_pnl_day_usd),
    realized_pnl_week_usd: asNumeric(raw.realized_pnl_week_usd),
    reduce_only_until: asString(raw.reduce_only_until),
    halted_at: asString(raw.halted_at),
    manual_halt: raw.manual_halt === true,
    updated_at: asString(raw.updated_at),
  };
}

export function fetchPortfolioState(
  accessToken: string,
  fetcher: ResolutionFetcher = fetch,
  signal?: AbortSignal,
): Promise<ResolutionGetResult<PortfolioStateSnapshot>> {
  return authorizedGet(
    "/api/polymarket/portfolio/state",
    accessToken,
    (body) => {
      if (!isRecord(body)) {
        return null;
      }
      return {
        state: parseStateRow(body.state),
        transitions: mapRows(body.transitions, (row) =>
          isRecord(row)
            ? {
                from_state: asString(row.from_state),
                to_state: asString(row.to_state),
                reason: asString(row.reason),
                trigger_source: asString(row.trigger_source),
                at: asString(row.at),
              }
            : null,
        ),
        openBreakers: mapRows(body.open_circuit_breakers, (row) => {
          if (!isRecord(row)) {
            return null;
          }
          const kind = asKey(row.kind);
          return kind === null
            ? null
            : {
                kind,
                scope: asString(row.scope),
                condition_id: asString(row.condition_id),
                started_at: asString(row.started_at),
              };
        }),
      };
    },
    fetcher,
    signal,
  );
}

export function fetchGates(
  accessToken: string,
  fetcher: ResolutionFetcher = fetch,
  signal?: AbortSignal,
): Promise<ResolutionGetResult<GateSnapshot>> {
  return authorizedGet(
    "/api/polymarket/gates",
    accessToken,
    (body) => {
      if (!isRecord(body)) {
        return null;
      }
      return {
        rfc009Status: asString(body.rfc_009_status),
        calibratedExpectation: asString(body.calibrated_expectation),
        gates: mapRows(body.gates, (row) => {
          if (!isRecord(row)) {
            return null;
          }
          const gate = asKey(row.gate);
          if (gate === null) {
            return null;
          }
          const status = row.status;
          const metrics = asParsedJson(row.metrics_json);
          return {
            gate,
            status:
              status === "PASS" ||
              status === "FAIL" ||
              status === "INSUFFICIENT_DATA"
                ? status
                : null,
            reason_code: asString(row.reason_code),
            metrics: isRecord(metrics) ? metrics : {},
            measured_at: asString(row.measured_at),
          };
        }),
      };
    },
    fetcher,
    signal,
  );
}

export function fetchDecisions(
  accessToken: string,
  fetcher: ResolutionFetcher = fetch,
  signal?: AbortSignal,
): Promise<ResolutionGetResult<readonly Decision[]>> {
  return authorizedGet(
    "/api/polymarket/decisions",
    accessToken,
    (body) =>
      isRecord(body)
        ? mapRows(body.decisions, (row) => {
            if (!isRecord(row)) {
              return null;
            }
            return {
              decision_id: asNumeric(row.decision_id),
              decision_kind: asString(row.decision_kind),
              condition_id: asString(row.condition_id),
              token_id: asString(row.token_id),
              question: asKey(row.question),
              category: asKey(row.category),
              decision_ts: asString(row.decision_ts),
              market_side: asString(row.market_side),
              edge_net: asNumeric(row.edge_net),
              size_shares: asNumeric(row.size_shares),
              binding_constraint: asString(row.binding_constraint),
              outcome: asString(row.outcome),
              reason_code: asString(row.reason_code),
              portfolio_state: asString(row.portfolio_state),
              exec_price: asString(row.exec_price),
              paper_order_id: asNumeric(row.paper_order_id),
            };
          })
        : null,
    fetcher,
    signal,
  );
}

// ---------------------------------------------------------------------------
// Limites: os quatro números que explicam a recusa (RFC-026 D6)
//
// `/portfolio/limits` já era publicado pelo perímetro e não tinha nenhum
// consumidor (`grep` da RFC: 0 ocorrências). O bloco `config` que o PR 1 desta
// RFC acrescentou é o que permite a tela dizer "faltam 0,004 para aceitar" sem
// fixar 0,02 no front — e, por consequência, é o que faz a tela continuar certa
// quando a config do motor mudar.
// ---------------------------------------------------------------------------

export interface LimitsConfig {
  readonly config_version: string | null;
  /** Piso de edge da config, em texto decimal exatamente como o motor gravou. */
  readonly edgeLiqMin: string | null;
  readonly safetyMarginMin: string | null;
  readonly bookMaxAgeMs: number | null;
  readonly estimateMaxAgeMs: number | null;
}

export interface LimitsCap {
  readonly dimension: string;
  readonly dimension_key: string;
  readonly worst_case_usd: string | null;
  readonly cap_usd: string | null;
  readonly utilization: number | null;
}

export interface PortfolioLimits {
  readonly caps: readonly LimitsCap[];
  readonly bindingConstraints24h: readonly {
    readonly binding_constraint: string | null;
    readonly decisions: number | null;
  }[];
  /**
   * `null` quando a API não sabe dizer os limites (nenhuma versão de config
   * registrada). A tela escreve "não medido" em cinza: um limite inventado no
   * cliente é a coisa que a D6 existe para impedir.
   */
  readonly config: LimitsConfig | null;
}

function parseLimitsConfig(raw: unknown): LimitsConfig | null {
  if (!isRecord(raw)) {
    return null;
  }
  return {
    config_version: asKey(raw.config_version),
    edgeLiqMin: asKey(raw.edgeLiqMin),
    safetyMarginMin: asKey(raw.safetyMarginMin),
    bookMaxAgeMs: asNumeric(raw.bookMaxAgeMs),
    estimateMaxAgeMs: asNumeric(raw.estimateMaxAgeMs),
  };
}

export function fetchLimits(
  accessToken: string,
  fetcher: ResolutionFetcher = fetch,
  signal?: AbortSignal,
): Promise<ResolutionGetResult<PortfolioLimits>> {
  return authorizedGet(
    "/api/polymarket/portfolio/limits",
    accessToken,
    (body) => {
      if (!isRecord(body)) {
        return null;
      }
      return {
        caps: mapRows(body.caps, (row) => {
          if (!isRecord(row)) {
            return null;
          }
          const dimension = asKey(row.dimension);
          const key = asKey(row.dimension_key);
          return dimension === null || key === null
            ? null
            : {
                dimension,
                dimension_key: key,
                worst_case_usd: asString(row.worst_case_usd),
                cap_usd: asString(row.cap_usd),
                utilization: asNumeric(row.utilization),
              };
        }),
        bindingConstraints24h: mapRows(body.binding_constraints_24h, (row) =>
          isRecord(row)
            ? {
                binding_constraint: asString(row.binding_constraint),
                decisions: asNumeric(row.decisions),
              }
            : null,
        ),
        config: parseLimitsConfig(body.config),
      };
    },
    fetcher,
    signal,
  );
}

/**
 * Folga para aceitar: `edge.net − max(costs.safety_margin, edgeLiqMin)`
 * (RFC-026 D6).
 *
 * Positiva significa que o edge líquido já passa do piso; negativa é o quanto
 * falta, e é o número que a tela escreve como "faltam 0,004 para aceitar".
 *
 * `valor: null` é "não medido", e é o resultado sempre que QUALQUER das três
 * entradas falta — inclusive quando só uma metade do piso é conhecida. Isso é
 * deliberado e é a direção segura: com `safety_margin` ausente, tomar o piso
 * como `edgeLiqMin` sozinho o subestimaria, e a tela anunciaria folga positiva
 * num mercado que o motor recusa. "Não medido" em cinza nunca mente; um número
 * otimista mente.
 */
export interface Folga {
  readonly valor: number | null;
  readonly piso: number | null;
  /** Quais entradas faltaram, para a tela dizer o que falta medir. */
  readonly faltando: readonly string[];
}

export function folgaParaAceitar(
  panel: Pick<OpportunityPanel, "edge_net" | "safety_margin">,
  config: LimitsConfig | null,
): Folga {
  const edge = numeroDecimal(panel.edge_net);
  const margem = numeroDecimal(panel.safety_margin);
  const pisoConfig = numeroDecimal(config?.edgeLiqMin ?? null);
  const faltando: string[] = [];
  if (edge === null) {
    faltando.push("edge líquido");
  }
  if (margem === null) {
    faltando.push("margem de segurança");
  }
  if (pisoConfig === null) {
    faltando.push("piso de edge da config");
  }
  if (edge === null || margem === null || pisoConfig === null) {
    return { valor: null, piso: null, faltando };
  }
  const piso = Math.max(margem, pisoConfig);
  return { valor: edge - piso, piso, faltando: [] };
}

function numeroDecimal(value: string | null): number | null {
  if (value === null || value.trim() === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// ---------------------------------------------------------------------------
// Espaço de consulta: histórico paginado das medições de gate.
//
// Substitui o relatório semanal da RFC (decisão do proprietário, 2026-08-26):
// os mesmos números, consultados quando alguém quiser, em vez de um documento
// gerado por timer. A paginação é por cursor (keyset) porque a tabela é
// append-only e nunca é podada — uma página por OFFSET ficaria mais lenta a
// cada semana e poderia repetir ou pular uma linha quando uma medição nova
// entrasse no meio da listagem.
// ---------------------------------------------------------------------------

export interface GateMeasurement {
  readonly measurement_id: number | null;
  readonly gate: string;
  readonly status: GateStatus | null;
  readonly reason_code: string | null;
  readonly metrics: Readonly<Record<string, unknown>>;
  readonly config_version: string | null;
  readonly window_from: string | null;
  readonly window_to: string | null;
  readonly measured_at: string | null;
}

export interface GateMeasurementPage {
  readonly measurements: readonly GateMeasurement[];
  readonly nextCursor: string | null;
  readonly calibratedExpectation: string | null;
}

export interface GateMeasurementQuery {
  readonly gate?: string;
  readonly status?: string;
  readonly from?: string;
  readonly to?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

/** Only the parameters the endpoint accepts, and only when actually set. */
function measurementQueryString(query: GateMeasurementQuery): string {
  const params = new URLSearchParams();
  if (query.gate !== undefined && query.gate !== "") {
    params.set("gate", query.gate);
  }
  if (query.status !== undefined && query.status !== "") {
    params.set("status", query.status);
  }
  if (query.from !== undefined && query.from !== "") {
    params.set("from", query.from);
  }
  if (query.to !== undefined && query.to !== "") {
    params.set("to", query.to);
  }
  if (query.limit !== undefined) {
    params.set("limit", String(query.limit));
  }
  if (query.cursor !== undefined && query.cursor !== "") {
    params.set("cursor", query.cursor);
  }
  const text = params.toString();
  return text === "" ? "" : `?${text}`;
}

function parseGateMeasurement(row: unknown): GateMeasurement | null {
  if (!isRecord(row)) {
    return null;
  }
  const gate = asKey(row.gate);
  if (gate === null) {
    return null;
  }
  const status = row.status;
  const metrics = asParsedJson(row.metrics_json);
  return {
    measurement_id: asNumeric(row.measurement_id),
    gate,
    status:
      status === "PASS" || status === "FAIL" || status === "INSUFFICIENT_DATA"
        ? status
        : null,
    reason_code: asString(row.reason_code),
    metrics: isRecord(metrics) ? metrics : {},
    config_version: asString(row.config_version),
    window_from: asString(row.window_from),
    window_to: asString(row.window_to),
    measured_at: asString(row.measured_at),
  };
}

export function fetchGateMeasurements(
  accessToken: string,
  query: GateMeasurementQuery = {},
  fetcher: ResolutionFetcher = fetch,
  signal?: AbortSignal,
): Promise<ResolutionGetResult<GateMeasurementPage>> {
  return authorizedGet(
    `/api/polymarket/gates/measurements${measurementQueryString(query)}`,
    accessToken,
    (body) => {
      if (!isRecord(body)) {
        return null;
      }
      const page = isRecord(body.page) ? body.page : {};
      return {
        measurements: mapRows(body.measurements, parseGateMeasurement),
        nextCursor: asString(page.next_cursor),
        calibratedExpectation: asString(body.calibrated_expectation),
      };
    },
    fetcher,
    signal,
  );
}

/**
 * Uma decisão inteira, com toda entrada que ela usou (`/decisions/:id`).
 *
 * Devolve o registro CRU: a rota faz `SELECT *` e as colunas mudam com as
 * migrations, então fixar um tipo aqui daria uma lista que envelhece em
 * silêncio. A tela imprime par a par, o que também é o que o modo engenheiro
 * quer ver.
 */
export function fetchDecision(
  accessToken: string,
  decisionId: number,
  fetcher: ResolutionFetcher = fetch,
  signal?: AbortSignal,
): Promise<ResolutionGetResult<Readonly<Record<string, unknown>>>> {
  return authorizedGet(
    `/api/polymarket/decisions/${String(decisionId)}`,
    accessToken,
    (body) =>
      isRecord(body) && isRecord(body.decision) ? body.decision : null,
    fetcher,
    signal,
  );
}
