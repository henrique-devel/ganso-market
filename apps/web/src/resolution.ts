// Typed client for the RFC-012 resolution-risk dashboard endpoints.
// All validators degrade gracefully: missing or malformed fields become
// null / empty arrays and rows without a usable key are dropped. They never
// throw on garbage input.

export type ResolutionAction = "NONE" | "BUFFER" | "VETO" | "CIRCUIT_BREAKER";
export type DivergenceDirection = "rfc012_only" | "rfc011_only";

export interface ResolutionMarket {
  readonly condition_id: string;
  readonly question: string;
  readonly category: string | null;
  readonly neg_risk: boolean;
  readonly score: number | null;
  readonly score_version: string | null;
  readonly action: ResolutionAction | null;
  readonly effective_action: ResolutionAction | null;
  readonly resolution_buffer: number | null;
  readonly p_5050: number | null;
  readonly expected_lockup_s: number | null;
  readonly p95_lockup_s: number | null;
  readonly dispute_active: boolean;
  readonly suspect_jump: boolean;
  readonly hard_flags: readonly string[];
  readonly event_ids: readonly string[];
  readonly group_worst_score: number | null;
  readonly justification: string | null;
  readonly prior_kind: string | null;
  readonly computed_at: string | null;
}

export interface ResolutionRiskSnapshot {
  readonly markets: readonly ResolutionMarket[];
}

export interface LayerDivergence {
  readonly condition_id: string;
  readonly direction: DivergenceDirection | null;
  readonly rfc012_action: ResolutionAction | null;
  readonly rfc011_frozen: boolean;
  readonly position_held: boolean;
  readonly started_at: string | null;
  readonly last_seen_at: string | null;
  readonly ended_at: string | null;
}

export interface DivergenceSets {
  readonly active: readonly LayerDivergence[];
  readonly recent: readonly LayerDivergence[];
}

export interface ConfidenceInterval {
  readonly low: number;
  readonly high: number;
}

export interface CategoryReport {
  readonly category: string;
  readonly resolved: number | null;
  readonly disputed: number | null;
  readonly dispute_rate: number | null;
  readonly dispute_rate_ci: ConfidenceInterval | null;
  readonly p5050: number | null;
  readonly prior_in_use: string | null;
  readonly results: Readonly<Record<string, number>>;
  readonly lockup_median_s: number | null;
  readonly lockup_p95_s: number | null;
}

export interface BacktestReport {
  readonly n_resolved: number | null;
  readonly n_scored: number | null;
  readonly n_skipped_no_proposal: number | null;
  readonly disputed: number | null;
  readonly vetoed_disputed: number | null;
  readonly coverage: number | null;
  readonly coverage_ci: ConfidenceInterval | null;
  readonly clean: number | null;
  readonly vetoed_clean: number | null;
  readonly false_positive_rate: number | null;
  readonly false_positive_ci: ConfidenceInterval | null;
}

export interface MeasurementReport {
  readonly report_id: string;
  readonly generated_at: string | null;
  readonly categories: readonly CategoryReport[];
  readonly backtest: BacktestReport | null;
  readonly score_version: string | null;
}

export interface MeasurementReportSet {
  readonly reports: readonly MeasurementReport[];
}

export interface KillSwitchState {
  readonly engaged: boolean;
  readonly reason: string | null;
  readonly engaged_at: string | null;
  readonly rearmed_at: string | null;
  readonly frozen_markets: readonly string[];
}

export interface OpenOrder {
  readonly order_id: string;
  readonly token_id: string | null;
  readonly condition_id: string | null;
  readonly side: string | null;
  readonly order_type: string | null;
  readonly limit_price: number | null;
  readonly size: number | null;
  readonly filled_size: number | null;
  readonly status: string | null;
  readonly source: string | null;
  readonly created_at: string | null;
}

export interface PaperPosition {
  readonly token_id: string;
  readonly condition_id: string | null;
  readonly shares: number | null;
  readonly cost_usd: number | null;
  readonly realized_pnl_usd: number | null;
  readonly mark_value_usd: number | null;
  readonly mark_stale: boolean;
  readonly updated_at: string | null;
}

export interface PipelineSnapshot {
  readonly kill_switch: KillSwitchState | null;
  readonly open_orders: readonly OpenOrder[];
  readonly positions: readonly PaperPosition[];
  readonly divergences_active: number | null;
  readonly checked_at: string | null;
}

export interface ScoreFeature {
  readonly name: string;
  readonly value: number | null;
  readonly weight: number | null;
  readonly contribution: number | null;
  readonly note: string | null;
}

export interface UmaTimelineEntry {
  readonly request_index: number | null;
  readonly state: string | null;
  readonly result: string | null;
  readonly payouts: string | null;
  readonly bond: number | null;
  readonly source: string | null;
  readonly occurred_at: string | null;
}

export interface RuleClarification {
  readonly rule_version: string | null;
  readonly classification: string | null;
  readonly changed_fields: readonly string[];
  readonly valid_from: string | null;
}

export interface MarketDetail {
  readonly state: string | null;
  readonly features: readonly ScoreFeature[];
  readonly hard_flags: readonly string[];
  readonly justification: string | null;
  readonly prior_kind: string | null;
  readonly computed_at: string | null;
  readonly uma_timeline: readonly UmaTimelineEntry[];
  readonly clarifications: readonly RuleClarification[];
}

export interface GraphNode {
  readonly condition_id: string;
  readonly question: string;
  readonly action: ResolutionAction | null;
  readonly effective_action: ResolutionAction | null;
  readonly score: number | null;
}

export interface GraphEdge {
  readonly edge_key: string;
  readonly kind: string | null;
  readonly from_condition_id: string | null;
  readonly to_condition_id: string | null;
  readonly event_id: string | null;
  readonly members: readonly string[];
  readonly origin: string | null;
  readonly confidence: number | null;
  readonly author: string | null;
  readonly justification: string | null;
}

export interface MarketGraph {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
}

export interface GraphViolation {
  readonly edge_key: string;
  readonly kind: string | null;
  readonly started_at: string | null;
  readonly last_seen_at: string | null;
  readonly ended_at: string | null;
  readonly snapshots_count: number | null;
  readonly magnitude_net: number | null;
  readonly magnitude_bps: number | null;
  readonly executable_size: number | null;
  readonly executable_notional_usd: number | null;
  readonly tolerance: number | null;
  readonly suppressed: boolean;
  readonly signal_emitted: boolean;
  readonly half_life_s: number | null;
}

export interface ViolationSets {
  readonly active: readonly GraphViolation[];
  readonly recent: readonly GraphViolation[];
}

export interface SanityVeto {
  readonly condition_id: string;
  readonly token_id: string | null;
  readonly model_id: string | null;
  readonly estimate_status: string | null;
  readonly q: number | null;
  readonly edge_key: string | null;
  readonly kind: string | null;
  readonly neighbor_price: number | null;
  readonly tolerance: number | null;
  readonly magnitude: number | null;
  readonly started_at: string | null;
  readonly ended_at: string | null;
}

export interface VetoSets {
  readonly active: readonly SanityVeto[];
  readonly recent: readonly SanityVeto[];
}

export type ResolutionGetResult<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "error" };

type ResolutionResponse = Pick<Response, "ok" | "status" | "json">;
export type ResolutionFetcher = (
  input: string,
  init?: RequestInit,
) => Promise<ResolutionResponse>;

export async function authorizedGet<T>(
  path: string,
  accessToken: string,
  validate: (body: unknown) => T | null,
  fetcher: ResolutionFetcher = fetch,
  signal?: AbortSignal,
): Promise<ResolutionGetResult<T>> {
  let response: ResolutionResponse;
  try {
    response = await fetcher(path, {
      cache: "no-store",
      credentials: "include",
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
      },
      ...(signal === undefined ? {} : { signal }),
    });
  } catch {
    return { kind: "error" };
  }
  if (response.status === 401) {
    return { kind: "unauthorized" };
  }
  if (!response.ok) {
    return { kind: "error" };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { kind: "error" };
  }
  const value = validate(body);
  if (value === null) {
    return { kind: "error" };
  }
  return { kind: "ok", value };
}

export function fetchResolutionRisk(
  accessToken: string,
  fetcher: ResolutionFetcher = fetch,
  signal?: AbortSignal,
): Promise<ResolutionGetResult<ResolutionRiskSnapshot>> {
  return authorizedGet(
    "/api/polymarket/resolution-risk",
    accessToken,
    parseResolutionRisk,
    fetcher,
    signal,
  );
}

export function fetchDivergences(
  accessToken: string,
  fetcher: ResolutionFetcher = fetch,
  signal?: AbortSignal,
): Promise<ResolutionGetResult<DivergenceSets>> {
  return authorizedGet(
    "/api/polymarket/resolution-risk/divergences",
    accessToken,
    parseDivergences,
    fetcher,
    signal,
  );
}

export function fetchMeasurementReports(
  accessToken: string,
  fetcher: ResolutionFetcher = fetch,
  signal?: AbortSignal,
): Promise<ResolutionGetResult<MeasurementReportSet>> {
  return authorizedGet(
    "/api/polymarket/resolution-risk/reports",
    accessToken,
    parseReports,
    fetcher,
    signal,
  );
}

export function fetchPipeline(
  accessToken: string,
  fetcher: ResolutionFetcher = fetch,
  signal?: AbortSignal,
): Promise<ResolutionGetResult<PipelineSnapshot>> {
  return authorizedGet(
    "/api/polymarket/resolution-risk/pipeline",
    accessToken,
    parsePipeline,
    fetcher,
    signal,
  );
}

export function fetchMarketDetail(
  conditionId: string,
  accessToken: string,
  fetcher: ResolutionFetcher = fetch,
  signal?: AbortSignal,
): Promise<ResolutionGetResult<MarketDetail>> {
  return authorizedGet(
    `/api/polymarket/resolution-risk/${encodeURIComponent(conditionId)}`,
    accessToken,
    parseMarketDetail,
    fetcher,
    signal,
  );
}

export function fetchGraph(
  accessToken: string,
  fetcher: ResolutionFetcher = fetch,
  signal?: AbortSignal,
): Promise<ResolutionGetResult<MarketGraph>> {
  return authorizedGet(
    "/api/polymarket/graph",
    accessToken,
    parseGraph,
    fetcher,
    signal,
  );
}

export function fetchGraphViolations(
  accessToken: string,
  fetcher: ResolutionFetcher = fetch,
  signal?: AbortSignal,
): Promise<ResolutionGetResult<ViolationSets>> {
  return authorizedGet(
    "/api/polymarket/graph/violations",
    accessToken,
    parseViolations,
    fetcher,
    signal,
  );
}

export function fetchSanityVetoes(
  accessToken: string,
  fetcher: ResolutionFetcher = fetch,
  signal?: AbortSignal,
): Promise<ResolutionGetResult<VetoSets>> {
  return authorizedGet(
    "/api/polymarket/graph/vetoes",
    accessToken,
    parseVetoes,
    fetcher,
    signal,
  );
}

// ---------------------------------------------------------------------------
// Lenient parsing helpers.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asKey(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asBoolean(value: unknown): boolean {
  return value === true;
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

// Fields named *_json may arrive already parsed or as a JSON string.
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

function asStringArray(value: unknown): readonly string[] {
  const parsed = asParsedJson(value);
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter((item): item is string => typeof item === "string");
}

function asAction(value: unknown): ResolutionAction | null {
  return value === "NONE" ||
    value === "BUFFER" ||
    value === "VETO" ||
    value === "CIRCUIT_BREAKER"
    ? value
    : null;
}

function asDirection(value: unknown): DivergenceDirection | null {
  return value === "rfc012_only" || value === "rfc011_only" ? value : null;
}

function asInterval(value: unknown): ConfidenceInterval | null {
  if (!isRecord(value)) {
    return null;
  }
  const low = asNumeric(value.low);
  const high = asNumeric(value.high);
  if (low === null || high === null) {
    return null;
  }
  return { low, high };
}

function asCompactJson(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function mapRows<T>(
  value: unknown,
  parse: (row: unknown) => T | null,
): readonly T[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const rows: T[] = [];
  for (const item of value) {
    const parsed = parse(item);
    if (parsed !== null) {
      rows.push(parsed);
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Endpoint validators.

function parseResolutionRisk(body: unknown): ResolutionRiskSnapshot {
  const markets = isRecord(body) ? mapRows(body.markets, parseMarket) : [];
  return { markets };
}

function parseMarket(row: unknown): ResolutionMarket | null {
  if (!isRecord(row)) {
    return null;
  }
  const conditionId = asKey(row.condition_id);
  if (conditionId === null) {
    return null;
  }
  return {
    condition_id: conditionId,
    question: asString(row.question) ?? "",
    category: asString(row.category),
    neg_risk: asBoolean(row.neg_risk),
    score: asNumeric(row.score),
    score_version: asString(row.score_version),
    action: asAction(row.action),
    effective_action: asAction(row.effective_action),
    resolution_buffer: asNumeric(row.resolution_buffer),
    p_5050: asNumeric(row.p_5050),
    expected_lockup_s: asNumeric(row.expected_lockup_s),
    p95_lockup_s: asNumeric(row.p95_lockup_s),
    dispute_active: asBoolean(row.dispute_active),
    suspect_jump: asBoolean(row.suspect_jump),
    hard_flags: asStringArray(row.hard_flags_json),
    event_ids: asStringArray(row.event_ids_json),
    group_worst_score: asNumeric(row.group_worst_score),
    justification: asString(row.justification),
    prior_kind: asString(row.prior_kind),
    computed_at: asString(row.computed_at),
  };
}

function parseDivergences(body: unknown): DivergenceSets {
  const record = isRecord(body) ? body : {};
  return {
    active: mapRows(record.active, parseDivergence),
    recent: mapRows(record.recent, parseDivergence),
  };
}

function parseDivergence(row: unknown): LayerDivergence | null {
  if (!isRecord(row)) {
    return null;
  }
  const conditionId = asKey(row.condition_id);
  if (conditionId === null) {
    return null;
  }
  return {
    condition_id: conditionId,
    direction: asDirection(row.direction),
    rfc012_action: asAction(row.rfc012_action),
    rfc011_frozen: asBoolean(row.rfc011_frozen),
    position_held: asBoolean(row.position_held),
    started_at: asString(row.started_at),
    last_seen_at: asString(row.last_seen_at),
    ended_at: asString(row.ended_at),
  };
}

function parseReports(body: unknown): MeasurementReportSet {
  const record = isRecord(body) ? body : {};
  return { reports: mapRows(record.reports, parseReport) };
}

function parseReport(row: unknown): MeasurementReport | null {
  if (!isRecord(row)) {
    return null;
  }
  const reportId = asKey(row.report_id);
  if (reportId === null) {
    return null;
  }
  const backtestRaw = asParsedJson(row.backtest_json);
  return {
    report_id: reportId,
    generated_at: asString(row.generated_at),
    categories: mapRows(asParsedJson(row.categories_json), parseCategory),
    backtest: isRecord(backtestRaw) ? parseBacktest(backtestRaw) : null,
    score_version: asString(row.score_version),
  };
}

function parseCategory(row: unknown): CategoryReport | null {
  if (!isRecord(row)) {
    return null;
  }
  const category = asKey(row.category);
  if (category === null) {
    return null;
  }
  const results: Record<string, number> = {};
  if (isRecord(row.results)) {
    for (const [key, value] of Object.entries(row.results)) {
      const numeric = asNumeric(value);
      if (numeric !== null) {
        results[key] = numeric;
      }
    }
  }
  return {
    category,
    resolved: asNumeric(row.resolved),
    disputed: asNumeric(row.disputed),
    dispute_rate: asNumeric(row.dispute_rate),
    dispute_rate_ci: asInterval(row.dispute_rate_ci),
    p5050: asNumeric(row.p5050),
    prior_in_use: asString(row.prior_in_use),
    results,
    lockup_median_s: asNumeric(row.lockup_median_s),
    lockup_p95_s: asNumeric(row.lockup_p95_s),
  };
}

function parseBacktest(row: Record<string, unknown>): BacktestReport {
  return {
    n_resolved: asNumeric(row.n_resolved),
    n_scored: asNumeric(row.n_scored),
    n_skipped_no_proposal: asNumeric(row.n_skipped_no_proposal),
    disputed: asNumeric(row.disputed),
    vetoed_disputed: asNumeric(row.vetoed_disputed),
    coverage: asNumeric(row.coverage),
    coverage_ci: asInterval(row.coverage_ci),
    clean: asNumeric(row.clean),
    vetoed_clean: asNumeric(row.vetoed_clean),
    false_positive_rate: asNumeric(row.false_positive_rate),
    false_positive_ci: asInterval(row.false_positive_ci),
  };
}

function parsePipeline(body: unknown): PipelineSnapshot {
  const record = isRecord(body) ? body : {};
  return {
    kill_switch: isRecord(record.kill_switch)
      ? {
          engaged: asBoolean(record.kill_switch.engaged),
          reason: asString(record.kill_switch.reason),
          engaged_at: asString(record.kill_switch.engaged_at),
          rearmed_at: asString(record.kill_switch.rearmed_at),
          frozen_markets: asStringArray(record.kill_switch.frozen_markets_json),
        }
      : null,
    open_orders: mapRows(record.open_orders, parseOrder),
    positions: mapRows(record.positions, parsePosition),
    divergences_active: asNumeric(record.divergences_active),
    checked_at: asString(record.checked_at),
  };
}

function parseOrder(row: unknown): OpenOrder | null {
  if (!isRecord(row)) {
    return null;
  }
  const orderId = asKey(row.order_id);
  if (orderId === null) {
    return null;
  }
  return {
    order_id: orderId,
    token_id: asString(row.token_id),
    condition_id: asString(row.condition_id),
    side: asString(row.side),
    order_type: asString(row.order_type),
    limit_price: asNumeric(row.limit_price),
    size: asNumeric(row.size),
    filled_size: asNumeric(row.filled_size),
    status: asString(row.status),
    source: asString(row.source),
    created_at: asString(row.created_at),
  };
}

function parsePosition(row: unknown): PaperPosition | null {
  if (!isRecord(row)) {
    return null;
  }
  const tokenId = asKey(row.token_id);
  if (tokenId === null) {
    return null;
  }
  return {
    token_id: tokenId,
    condition_id: asString(row.condition_id),
    shares: asNumeric(row.shares),
    cost_usd: asNumeric(row.cost_usd),
    realized_pnl_usd: asNumeric(row.realized_pnl_usd),
    mark_value_usd: asNumeric(row.mark_value_usd),
    mark_stale: asBoolean(row.mark_stale),
    updated_at: asString(row.updated_at),
  };
}

function parseMarketDetail(body: unknown): MarketDetail {
  const record = isRecord(body) ? body : {};
  const latest = isRecord(record.latest_score) ? record.latest_score : {};
  return {
    state: asString(record.state),
    features: parseFeatures(latest.features_json),
    hard_flags: asStringArray(latest.hard_flags_json),
    justification: asString(latest.justification),
    prior_kind: asString(latest.prior_kind),
    computed_at: asString(latest.computed_at),
    uma_timeline: mapRows(record.uma_timeline, parseUmaEntry),
    clarifications: mapRows(record.clarifications, parseClarification),
  };
}

function parseFeatures(value: unknown): readonly ScoreFeature[] {
  const parsed = asParsedJson(value);
  if (!isRecord(parsed)) {
    return [];
  }
  const features: ScoreFeature[] = [];
  for (const [name, entry] of Object.entries(parsed)) {
    if (!isRecord(entry)) {
      continue;
    }
    features.push({
      name,
      value: asNumeric(entry.value),
      weight: asNumeric(entry.weight),
      contribution: asNumeric(entry.contribution),
      note: asString(entry.note),
    });
  }
  return features;
}

function parseUmaEntry(row: unknown): UmaTimelineEntry | null {
  if (!isRecord(row)) {
    return null;
  }
  return {
    request_index: asNumeric(row.request_index),
    state: asString(row.state),
    result: asString(row.result),
    payouts: asCompactJson(asParsedJson(row.payouts_json)),
    bond: asNumeric(row.bond),
    source: asString(row.source),
    occurred_at: asString(row.occurred_at),
  };
}

function parseClarification(row: unknown): RuleClarification | null {
  if (!isRecord(row)) {
    return null;
  }
  return {
    rule_version: asString(row.rule_version),
    classification: asString(row.classification),
    changed_fields: asStringArray(row.changed_fields_json),
    valid_from: asString(row.valid_from),
  };
}

function parseGraph(body: unknown): MarketGraph {
  const record = isRecord(body) ? body : {};
  return {
    nodes: mapRows(record.nodes, parseGraphNode),
    edges: mapRows(record.edges, parseGraphEdge),
  };
}

function parseGraphNode(row: unknown): GraphNode | null {
  if (!isRecord(row)) {
    return null;
  }
  const conditionId = asKey(row.condition_id);
  if (conditionId === null) {
    return null;
  }
  return {
    condition_id: conditionId,
    question: asString(row.question) ?? "",
    action: asAction(row.action),
    effective_action: asAction(row.effective_action),
    score: asNumeric(row.score),
  };
}

function parseGraphEdge(row: unknown): GraphEdge | null {
  if (!isRecord(row)) {
    return null;
  }
  const edgeKey = asKey(row.edge_key);
  if (edgeKey === null) {
    return null;
  }
  return {
    edge_key: edgeKey,
    kind: asString(row.kind),
    from_condition_id: asString(row.from_condition_id),
    to_condition_id: asString(row.to_condition_id),
    event_id: asString(row.event_id),
    members: asStringArray(row.members_json),
    origin: asString(row.origin),
    confidence: asNumeric(row.confidence),
    author: asString(row.author),
    justification: asString(row.justification),
  };
}

function parseViolations(body: unknown): ViolationSets {
  const record = isRecord(body) ? body : {};
  return {
    active: mapRows(record.active, parseViolation),
    recent: mapRows(record.recent, parseViolation),
  };
}

function parseViolation(row: unknown): GraphViolation | null {
  if (!isRecord(row)) {
    return null;
  }
  const edgeKey = asKey(row.edge_key);
  if (edgeKey === null) {
    return null;
  }
  const details = asParsedJson(row.details_json);
  return {
    edge_key: edgeKey,
    kind: asString(row.kind),
    started_at: asString(row.started_at),
    last_seen_at: asString(row.last_seen_at),
    ended_at: asString(row.ended_at),
    snapshots_count: asNumeric(row.snapshots_count),
    magnitude_net: asNumeric(row.magnitude_net),
    magnitude_bps: asNumeric(row.magnitude_bps),
    executable_size: asNumeric(row.executable_size),
    executable_notional_usd: asNumeric(row.executable_notional_usd),
    tolerance: asNumeric(row.tolerance),
    suppressed: asBoolean(row.suppressed),
    signal_emitted: asBoolean(row.signal_emitted),
    half_life_s: isRecord(details) ? asNumeric(details.half_life_s) : null,
  };
}

function parseVetoes(body: unknown): VetoSets {
  const record = isRecord(body) ? body : {};
  return {
    active: mapRows(record.active, parseVeto),
    recent: mapRows(record.recent, parseVeto),
  };
}

function parseVeto(row: unknown): SanityVeto | null {
  if (!isRecord(row)) {
    return null;
  }
  const conditionId = asKey(row.condition_id);
  if (conditionId === null) {
    return null;
  }
  return {
    condition_id: conditionId,
    token_id: asString(row.token_id),
    model_id: asString(row.model_id),
    estimate_status: asString(row.estimate_status),
    q: asNumeric(row.q),
    edge_key: asString(row.edge_key),
    kind: asString(row.kind),
    neighbor_price: asNumeric(row.neighbor_price),
    tolerance: asNumeric(row.tolerance),
    magnitude: asNumeric(row.magnitude),
    started_at: asString(row.started_at),
    ended_at: asString(row.ended_at),
  };
}
