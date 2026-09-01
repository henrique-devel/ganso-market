// RFC-017: the shadow replay CLI, in two modes.
//
// A CLI and not an endpoint, for the same reason `gates-cli` is one: the
// RFC-013 perimeter publishes portfolio surfaces GET-only, and this reads the
// whole decision log plus, in mode B, the estimate and label tables. A surface
// that streams the log to anything that can reach the edge is a surface worth
// not having.
//
// Run inside the API container:
//
//   docker compose exec -T api node apps/api/dist/shadow-replay-cli.js \
//     sweep costs.capitalCostAnnual --values 0.12,0.15,0.183,0.20,0.25,0.30,0.365,0.40
//   docker compose exec -T api node apps/api/dist/shadow-replay-cli.js source-replay
//
// The path is `apps/api/dist/...` and not `dist/...`: the image's WORKDIR is
// /workspace, the repository root, not the api workspace.
//
// SIMULAÇÃO — SEM EXECUÇÃO REAL. This tool decides nothing and writes nothing.
// The number mode A produces is an input to the owner's decision about config
// 1.3.0; minting a version stays his act. Mode B's counterfactual PnL feeds the
// promotion decision and does not replace it — the RFC-010 gate stays sovereign.

import { ConfigError, loadConfig } from "./config.js";
import { createDatabasePool } from "./database.js";
import {
  DEFAULT_PORTFOLIO_CONFIG,
  parsePortfolioConfig,
  portfolioConfigHash,
  type PortfolioConfig,
} from "./polymarket/portfolio/config.js";
import type { PersistedDecision } from "./polymarket/portfolio/replay.js";
import {
  baselineIsShadow,
  counterfactualPnl,
  decisionWithShadow,
  SourceReplayAccumulator,
  type CounterfactualEntry,
} from "./polymarket/portfolio/sourcereplay.js";
import {
  breakevenValue,
  configValueAt,
  parseValues,
  reachedArithmetic,
  rederive,
  SweepAccumulator,
  SweepError,
  sweepDecision,
  SWEEPABLE_KEYS,
  REFUSED_KEYS,
  assertSweepable,
  type Breakeven,
  type SweepTotals,
} from "./polymarket/portfolio/sweep.js";
import {
  anyModelPromoted,
  labelsFor,
  loadConfigsForWindow,
  readOnlyPool,
  shadowCoverage,
  shadowEstimatesAsOf,
  shadowKey,
  streamDecisions,
  summarizeWindow,
  type DecisionWindow,
} from "./polymarket/portfolio/sweepstore.js";
import { replayDecision } from "./polymarket/portfolio/replay.js";

/** One tick per taker share: the base column of the RFC-011 performance report. */
const BASE_DEGRADATION_PER_SHARE = 0.01;

/** Rows per keyset page. 500 x ~2.8 KB of JSON is ~1.4 MB resident. */
const DEFAULT_BATCH = 500;

/** How many near-miss decisions mode A solves a breakeven for. */
const BREAKEVEN_SAMPLE = 20;

class CliError extends Error {
  public readonly reasonCode: string;

  public constructor(reasonCode: string, message: string) {
    super(message);
    this.name = "CliError";
    this.reasonCode = reasonCode;
  }
}

function flagValue(argv: readonly string[], flag: string): string | null {
  const index = argv.indexOf(flag);
  if (index < 0) {
    return null;
  }
  return argv[index + 1] ?? null;
}

function parseInstant(raw: string | null, flag: string): Date | null {
  if (raw === null) {
    return null;
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new CliError("INVALID_WINDOW", `${flag} is not an ISO-8601 instant`);
  }
  return parsed;
}

function fixed(value: number | null, digits: number): string {
  return value === null ? "—" : value.toFixed(digits);
}

function pct(part: number, whole: number): string {
  return whole === 0 ? "—" : `${((100 * part) / whole).toFixed(3)}%`;
}

// ---------------------------------------------------------------------------
// Mode A.
// ---------------------------------------------------------------------------

interface SweepReport {
  readonly totals: SweepTotals;
  readonly breakevens: readonly Breakeven[];
  readonly breakevenSearched: number;
  readonly breakevenFound: number;
}

async function runSweep(input: {
  readonly pool: ReturnType<typeof readOnlyPool>;
  readonly path: string;
  readonly values: readonly number[];
  readonly window: DecisionWindow;
  readonly bracketHigh: number;
}): Promise<{ report: SweepReport; provenance: Record<string, unknown> }> {
  const { pool, path, values } = input;
  assertSweepable(path);

  const summary = await summarizeWindow(pool, input.window);
  if (summary.rows === 0) {
    throw new CliError("EMPTY_WINDOW", "the window holds no decisions");
  }
  // Close the window at the high-water mark the summary just reported, so the
  // rows swept are exactly the rows the provenance block names.
  const window: DecisionWindow = {
    ...input.window,
    maxDecisionId: summary.maxDecisionId,
  };
  const configs = await loadConfigsForWindow(
    pool,
    summary.configVersions,
    parsePortfolioConfig,
  );

  // The recorded value is read from the version the window actually names. With
  // more than one version in the window there is no single "recorded value", and
  // saying so beats printing whichever one sorted first.
  const versions = [...configs.keys()].sort();
  const soleConfig =
    versions.length === 1 ? configs.get(versions[0] as string) : undefined;
  const recordedValue =
    soleConfig === undefined ? null : configValueAt(soleConfig, path);

  const accumulator = new SweepAccumulator({
    path,
    recordedValue,
    values,
  });

  // Near-misses, kept for the breakeven pass, ranked by how much of their slack
  // the candidates actually consumed — NOT by how little slack they had.
  //
  // The two orderings are different and the difference matters. A decision with
  // a hair of slack and a 38-minute lockup needs a rate in the tens of thousands
  // of percent to flip; one with more slack and a longer lockup flips far
  // sooner. "How close did the biggest candidate get" is the quantity that
  // actually ranks decisions by their distance to a flip in the KEY's units,
  // which is what the breakeven is asked to report.
  //
  // Bounded, so a full window cannot turn the "keep only aggregates" rule into
  // a lie.
  const nearMisses: { decision: PersistedDecision; consumed: number }[] = [];

  await streamDecisions(pool, window, (batch) => {
    for (const decision of batch) {
      const config = configs.get(decision.configVersion);
      if (config === undefined) {
        accumulator.excluded(decision.conditionId, "CONFIG_UNAVAILABLE");
        continue;
      }
      const swept = sweepDecision({ decision, config, path, values });
      if (typeof swept === "string") {
        accumulator.excluded(decision.conditionId, swept);
        continue;
      }
      accumulator.add(swept);
      const consumed = swept.candidates.reduce(
        (best, candidate) => Math.max(best, candidate.slackConsumed ?? 0),
        swept.baselineAcceptSlack === null ? -1 : 0,
      );
      if (
        consumed >= 0 &&
        (nearMisses.length < BREAKEVEN_SAMPLE ||
          consumed > (nearMisses[nearMisses.length - 1]?.consumed ?? -Infinity))
      ) {
        nearMisses.push({ decision, consumed });
        nearMisses.sort((a, b) => b.consumed - a.consumed);
        nearMisses.length = Math.min(nearMisses.length, BREAKEVEN_SAMPLE);
      }
    }
  });

  // What turns "zero changed at every candidate" into a number: how far the key
  // would have to move before the nearest decision changes at all.
  const breakevens: Breakeven[] = [];
  let searched = 0;
  for (const near of nearMisses) {
    const config = configs.get(near.decision.configVersion);
    if (config === undefined) {
      continue;
    }
    searched += 1;
    const found = breakevenValue({
      decision: near.decision,
      config,
      path,
      bracketLow: configValueAt(config, path),
      bracketHigh: input.bracketHigh,
    });
    if (found !== null) {
      breakevens.push(found);
    }
  }
  breakevens.sort((a, b) => a.value - b.value);

  const shadow = await shadowCoverage(pool, window.from, window.to);
  return {
    report: {
      totals: accumulator.totals(),
      breakevens,
      breakevenSearched: searched,
      breakevenFound: breakevens.length,
    },
    provenance: {
      mode: "A",
      analysis_mode: "audit",
      reads: ["portfolio_decisions", "portfolio_config_versions"],
      window_requested: {
        from: window.from?.toISOString() ?? null,
        to: window.to?.toISOString() ?? null,
      },
      window_covered: {
        oldest: summary.oldest?.toISOString() ?? null,
        newest: summary.newest?.toISOString() ?? null,
        rows: summary.rows,
        markets: summary.markets,
        decision_id_range: [summary.minDecisionId, summary.maxDecisionId],
        closed_at_decision_id: summary.maxDecisionId,
        note:
          "the scan is pinned to this decision_id, so rows written during the " +
          "run are outside it and two runs over the same range agree",
      },
      config_versions: summary.configVersions,
      config_hashes: Object.fromEntries(
        [...configs.entries()].map(([version, config]) => [
          version,
          portfolioConfigHash(config),
        ]),
      ),
      engine_default_config_version: DEFAULT_PORTFOLIO_CONFIG.version,
      breakeven_bracket: [
        soleConfig === undefined ? null : configValueAt(soleConfig, path),
        input.bracketHigh,
      ],
      shadow_rows_in_window: shadow.rows,
    },
  };
}

function renderSweepTable(
  report: SweepReport,
  provenance: Record<string, unknown>,
): string {
  const t = report.totals;
  const lines: string[] = [];
  lines.push(`# RFC-017 mode A — sweep of ${t.path}`);
  lines.push("");
  lines.push("## Population (the denominator, stated three ways)");
  lines.push("");
  lines.push(`  decisions in window           ${String(t.decisionsSeen)}`);
  lines.push(
    `  admitted (baseline MATCHED)   ${String(t.decisionsAdmitted)}  ${pct(t.decisionsAdmitted, t.decisionsSeen)}`,
  );
  lines.push(
    `  reached the arithmetic        ${String(t.decisionsReachingArithmetic)}  ${pct(t.decisionsReachingArithmetic, t.decisionsSeen)}   <- the only rows a cost key can move`,
  );
  lines.push(
    `  markets: seen / admitted / reaching   ${String(t.marketsSeen)} / ${String(t.marketsAdmitted)} / ${String(t.marketsReachingArithmetic)}`,
  );
  lines.push("");
  lines.push("  exclusions:");
  for (const [reason, count] of Object.entries(t.exclusions)) {
    lines.push(`    ${reason.padEnd(28)} ${String(count)}`);
  }
  lines.push("");
  lines.push(
    `  recorded value: ${
      t.recordedValue === null
        ? "unknown — the window spans more than one config version"
        : String(t.recordedValue)
    }`,
  );
  lines.push("");
  lines.push("## Per candidate");
  lines.push("");
  lines.push(
    "  ACTION = ACCEPTED<->REJECTED. REASON = the label moved, the action did not.",
  );
  lines.push("");
  lines.push(
    "  value      action(ln/mkt)  reason(ln/mkt)  side  binding  cap>0   med d(edge_net)  max slack used",
  );
  for (const c of t.candidates) {
    lines.push(
      "  " +
        c.value.toFixed(4).padEnd(11) +
        `${String(c.linesOutcomeChanged)}/${String(c.marketsOutcomeChanged)}`.padEnd(
          16,
        ) +
        `${String(c.linesReasonChanged)}/${String(c.marketsReasonChanged)}`.padEnd(
          16,
        ) +
        String(c.linesSideChanged).padEnd(6) +
        String(c.linesBindingChanged).padEnd(9) +
        String(c.capitalCostBecamePositive).padEnd(8) +
        fixed(c.medianDeltaEdgeNet, 9).padStart(15) +
        (c.maxSlackConsumed === null
          ? "—"
          : `${(100 * c.maxSlackConsumed).toFixed(4)}%`
        ).padStart(16),
    );
  }
  lines.push("");
  lines.push(
    `  Counts are absolute. The denominator for ACTION and REASON is the ` +
      `${String(t.decisionsReachingArithmetic)} rows / ` +
      `${String(t.marketsReachingArithmetic)} markets that reached the ` +
      `arithmetic, NOT the ${String(t.decisionsSeen)} rows in the window.`,
  );
  lines.push("");
  for (const c of t.candidates) {
    const transitions = Object.entries(c.verdictTransitions).sort(
      (a, b) => b[1] - a[1],
    );
    if (transitions.length > 0) {
      lines.push(`  side/verdict transitions at ${String(c.value)}:`);
      for (const [key, count] of transitions.slice(0, 8)) {
        lines.push(`    ${String(count).padStart(8)}  ${key}`);
      }
    }
    const binding = Object.entries(c.bindingTransitions);
    if (binding.length > 0) {
      lines.push(`  binding transitions at ${String(c.value)}:`);
      for (const [key, count] of binding.slice(0, 8)) {
        lines.push(`    ${String(count).padStart(8)}  ${key}`);
      }
    }
  }
  lines.push("");
  lines.push("## Margin — what a row of zeros actually means");
  lines.push("");
  lines.push(
    `  breakeven searched on the ${String(report.breakevenSearched)} decisions whose slack the candidates consumed most; found ${String(report.breakevenFound)}.`,
  );
  if (report.breakevens.length === 0) {
    lines.push(
      `  No verdict changes anywhere in the bracket ${JSON.stringify(provenance.breakeven_bracket)}.`,
    );
    lines.push(
      "  Read with the 'max slack used' column: a max near zero means the key is",
    );
    lines.push(
      "  arithmetically incapable in this population, NOT that the candidates are safe.",
    );
  } else {
    for (const b of report.breakevens.slice(0, 5)) {
      lines.push(
        `  decision ${String(b.decisionId)}: ${b.fromOutcome} -> ${b.toOutcome} at ${t.path} = ${b.value.toPrecision(6)}`,
      );
    }
  }
  lines.push("");
  lines.push("## Provenance");
  lines.push("");
  lines.push(JSON.stringify(provenance, null, 2));
  lines.push("");
  lines.push("SIMULAÇÃO — SEM EXECUÇÃO REAL. Nothing was written.");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Mode B.
// ---------------------------------------------------------------------------

async function runSourceReplay(input: {
  readonly pool: ReturnType<typeof readOnlyPool>;
  readonly window: DecisionWindow;
}): Promise<{ report: unknown; provenance: Record<string, unknown> }> {
  const { pool } = input;
  const summary = await summarizeWindow(pool, input.window);
  if (summary.rows === 0) {
    throw new CliError("EMPTY_WINDOW", "the window holds no decisions");
  }
  const window: DecisionWindow = {
    ...input.window,
    maxDecisionId: summary.maxDecisionId,
  };
  const configs = await loadConfigsForWindow(
    pool,
    summary.configVersions,
    parsePortfolioConfig,
  );
  const promoted = await anyModelPromoted(pool);
  const coverage = await shadowCoverage(pool, window.from, window.to);

  const accumulator = new SourceReplayAccumulator();
  const entries: CounterfactualEntry[] = [];
  const tokens = new Set<string>();

  await streamDecisions(pool, window, async (batch) => {
    const entryLike = batch.filter(
      (decision) =>
        decision.decisionKind === "ENTRY" || decision.decisionKind === "VETO",
    );
    if (entryLike.length === 0) {
      return;
    }
    const shadows = await shadowEstimatesAsOf(
      pool,
      entryLike.map((decision) => ({
        tokenId: decision.tokenId,
        at: decision.decisionTs,
      })),
      staleness(configs, entryLike),
    );

    for (const decision of entryLike) {
      const config = configs.get(decision.configVersion);
      if (config === undefined) {
        accumulator.excluded(decision.conditionId, "BASELINE_MISMATCH");
        continue;
      }
      if (baselineIsShadow({ decision, anyModelPromoted: promoted })) {
        // Premise 3 of the RFC: this decision's recorded source was ALREADY a
        // shadow row. Substituting the shadow into it would compare a thing
        // against itself and report agreement that means nothing.
        accumulator.excluded(decision.conditionId, "BASELINE_ALREADY_SHADOW");
        continue;
      }
      const admission = replayDecision({ decision, config });
      if (!admission.matched) {
        accumulator.excluded(
          decision.conditionId,
          admission.failure === "NO_REPLAY_BLOCK"
            ? "NO_REPLAY_BLOCK"
            : admission.failure === "UNSUPPORTED_KIND"
              ? "UNSUPPORTED_KIND"
              : "BASELINE_MISMATCH",
        );
        continue;
      }
      const shadow = shadows.get(
        shadowKey(decision.tokenId, decision.decisionTs),
      );
      if (shadow === undefined) {
        accumulator.excluded(decision.conditionId, "SHADOW_MISSING");
        continue;
      }
      const swapped = decisionWithShadow({ decision, shadow });
      if (swapped === null) {
        accumulator.excluded(decision.conditionId, "NO_REPLAY_BLOCK");
        continue;
      }
      const baselineRederived = rederive({ decision, config });
      const shadowRederived = rederive({ decision: swapped, config });
      if (baselineRederived === null || shadowRederived === null) {
        accumulator.excluded(decision.conditionId, "NO_REPLAY_BLOCK");
        continue;
      }
      const baselineRow = baselineRederived.row;
      const shadowRow = shadowRederived.row;
      accumulator.add({
        conditionId: decision.conditionId,
        decisionTs: decision.decisionTs,
        modelId: shadow.modelId,
        baselineOutcome: baselineRow.outcome,
        baselineReason: baselineRow.reasonCode,
        shadowOutcome: shadowRow.outcome,
        shadowReason: shadowRow.reasonCode,
        // A VETO refused upstream of the estimate replays and finds its shadow
        // row, and no estimate could have changed it. It stays in the sample and
        // out of the denominator that the question actually applies to.
        reachedEstimate: reachedArithmetic(baselineRow),
      });
      if (
        shadowRow.outcome === "ACCEPTED" &&
        shadowRow.execPrice !== null &&
        shadowRow.costsTotal !== null &&
        shadowRow.sizeShares !== null
      ) {
        tokens.add(decision.tokenId);
        entries.push({
          decisionId: decision.decisionId,
          conditionId: decision.conditionId,
          tokenId: decision.tokenId,
          marketSide: shadowRow.marketSide,
          execPrice: Number.parseFloat(shadowRow.execPrice),
          costsTotal: Number.parseFloat(shadowRow.costsTotal),
          sizeShares: Number.parseFloat(shadowRow.sizeShares),
        });
      }
    }
  });

  const labels = await labelsFor(pool, [...tokens]);
  const pnl = counterfactualPnl({
    entries,
    labels,
    degradationPerShare: BASE_DEGRADATION_PER_SHARE,
  });

  return {
    report: { totals: accumulator.totals(), counterfactual_pnl: pnl },
    provenance: {
      mode: "B",
      analysis_mode: "offline",
      reads: [
        "portfolio_decisions",
        "portfolio_config_versions",
        "fundamental_estimates",
        "fundamental_labels",
        "fundamental_models",
      ],
      not_an_audit:
        "mode B reads market tables, so its window is bounded by their " +
        "retention and it does not survive the raw-data TTL the way mode A does",
      window_requested: {
        from: window.from?.toISOString() ?? null,
        to: window.to?.toISOString() ?? null,
      },
      decision_log_window: {
        oldest: summary.oldest?.toISOString() ?? null,
        newest: summary.newest?.toISOString() ?? null,
        rows: summary.rows,
        closed_at_decision_id: summary.maxDecisionId,
      },
      shadow_estimates_in_window: {
        rows: coverage.rows,
        tokens: coverage.tokens,
        oldest: coverage.oldest?.toISOString() ?? null,
        newest: coverage.newest?.toISOString() ?? null,
        model_ids: coverage.modelIds,
      },
      any_model_promoted: promoted,
      degradation_per_share: BASE_DEGRADATION_PER_SHARE,
      pnl_label: "hypothetical",
      gate_note:
        "feeds the RFC-010 promotion decision; does not replace it. No model " +
        "is promoted without a gate PASS and the owner's manual action.",
    },
  };
}

/** The estimate staleness TTL in force for the batch, from its own config. */
function staleness(
  configs: ReadonlyMap<string, PortfolioConfig>,
  batch: readonly PersistedDecision[],
): number {
  let max = 0;
  for (const decision of batch) {
    const config = configs.get(decision.configVersion);
    if (config !== undefined) {
      max = Math.max(max, config.staleness.estimateMaxAgeMs);
    }
  }
  return max === 0 ? DEFAULT_PORTFOLIO_CONFIG.staleness.estimateMaxAgeMs : max;
}

function renderSourceTable(
  report: {
    totals: ReturnType<SourceReplayAccumulator["totals"]>;
    counterfactual_pnl: ReturnType<typeof counterfactualPnl>;
  },
  provenance: Record<string, unknown>,
): string {
  const t = report.totals;
  const p = report.counterfactual_pnl;
  const lines: string[] = [];
  lines.push("# RFC-017 mode B — source replay (baseline -> shadow)");
  lines.push("");
  lines.push("OFFLINE ANALYSIS, not an audit: this mode reads market tables.");
  lines.push("");
  lines.push("## Population");
  lines.push("");
  lines.push(`  entry-path decisions seen     ${String(t.decisionsSeen)}`);
  lines.push(
    `  admitted (shadow found as-of) ${String(t.decisionsAdmitted)}  ${pct(t.decisionsAdmitted, t.decisionsSeen)}`,
  );
  lines.push(
    `  reached the estimate          ${String(t.decisionsReachingEstimate)}  ${pct(t.decisionsReachingEstimate, t.decisionsSeen)}   <- the only rows a source swap can move`,
  );
  lines.push(
    `  markets: seen / admitted / reaching  ${String(t.marketsSeen)} / ${String(t.marketsAdmitted)} / ${String(t.marketsReachingEstimate)}`,
  );
  lines.push(
    `  window covered                ${t.coveredFrom ?? "—"} .. ${t.coveredTo ?? "—"}`,
  );
  lines.push(`  shadow models used            ${t.modelIds.join(", ") || "—"}`);
  lines.push("");
  lines.push("  exclusions:");
  for (const [reason, count] of Object.entries(t.exclusions)) {
    lines.push(`    ${reason.padEnd(28)} ${String(count)}`);
  }
  lines.push("");
  lines.push("## What the shadow would have changed");
  lines.push("");
  lines.push(
    `  lines whose ACTION differs    ${String(t.linesOutcomeChanged)}  ${pct(t.linesOutcomeChanged, t.decisionsReachingEstimate)}`,
  );
  lines.push(
    `  markets whose ACTION differs  ${String(t.marketsOutcomeChanged)}  ${pct(t.marketsOutcomeChanged, t.marketsReachingEstimate)}`,
  );
  lines.push(
    `  lines whose REASON differs    ${String(t.linesReasonChanged)}  ${pct(t.linesReasonChanged, t.decisionsReachingEstimate)}`,
  );
  lines.push(
    `  accepted by baseline only     ${String(t.baselineOnlyAccepted)}`,
  );
  lines.push(`  accepted by shadow only       ${String(t.shadowOnlyAccepted)}`);
  lines.push("");
  const transitions = Object.entries(t.verdictTransitions).sort(
    (a, b) => b[1] - a[1],
  );
  if (transitions.length > 0) {
    lines.push("  top transitions:");
    for (const [key, count] of transitions.slice(0, 10)) {
      lines.push(`    ${String(count).padStart(8)}  ${key}`);
    }
    lines.push("");
  }
  lines.push("## Counterfactual PnL (HYPOTHETICAL)");
  lines.push("");
  lines.push(`  entries the shadow would take ${String(p.entriesConsidered)}`);
  lines.push(`  settled against a final label ${String(p.entriesSettled)}`);
  lines.push(
    `  without a final label         ${String(p.entriesWithoutFinalLabel)}`,
  );
  lines.push(
    `  wins / losses / halves        ${String(p.wins)} / ${String(p.losses)} / ${String(p.halves)}`,
  );
  lines.push(`  gross USD                     ${p.grossUsd.toFixed(6)}`);
  lines.push(`  engine costs USD              ${p.costsUsd.toFixed(6)}`);
  lines.push(`  conservative degradation USD  ${p.degradationUsd.toFixed(6)}`);
  lines.push(`  net USD                       ${p.netUsd.toFixed(6)}`);
  lines.push("");
  lines.push("## Provenance");
  lines.push("");
  lines.push(JSON.stringify(provenance, null, 2));
  lines.push("");
  lines.push("SIMULAÇÃO — SEM EXECUÇÃO REAL. Nothing was written.");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------

const USAGE =
  "usage:\n" +
  "  shadow-replay sweep <key.path> --values a,b,c [--from ISO] [--to ISO]\n" +
  "                      [--format table|json] [--batch N] [--bracket-high X]\n" +
  "  shadow-replay source-replay [--from ISO] [--to ISO] [--format table|json]\n" +
  "                      [--batch N]\n" +
  "  shadow-replay keys\n";

async function run(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (command === "keys") {
    process.stdout.write(
      `${JSON.stringify(
        {
          status: "ok",
          sweepable: SWEEPABLE_KEYS,
          refused: REFUSED_KEYS,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  if (command !== "sweep" && command !== "source-replay") {
    throw new CliError("USAGE", USAGE);
  }

  const format = flagValue(argv, "--format") ?? "table";
  if (format !== "table" && format !== "json") {
    throw new CliError("USAGE", "--format must be table or json");
  }
  const batchRaw = flagValue(argv, "--batch");
  const batchSize = batchRaw === null ? DEFAULT_BATCH : Number(batchRaw);
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0 || batchSize > 5000) {
    throw new CliError("USAGE", "--batch must be an integer in [1, 5000]");
  }
  const requested: DecisionWindow = {
    from: parseInstant(flagValue(argv, "--from"), "--from"),
    to: parseInstant(flagValue(argv, "--to"), "--to"),
    kinds: null,
    batchSize,
    // Pinned below, once the summary has named the log's high-water mark.
    maxDecisionId: null,
  };

  const config = await loadConfig();
  // A full pass reads hundreds of pages; the api default query timeout is the
  // 2 s connect timeout, which would abort the scan partway and report a
  // truncated population as if it were the window.
  const raw = createDatabasePool(config, {
    max: 2,
    queryTimeoutMs: 120_000,
    applicationName: "ganso-shadow-replay",
  });
  const pool = readOnlyPool(raw);
  try {
    if (command === "sweep") {
      const path = argv[1];
      if (path === undefined || path.startsWith("--")) {
        throw new CliError("USAGE", USAGE);
      }
      const valuesRaw = flagValue(argv, "--values");
      if (valuesRaw === null) {
        throw new CliError("USAGE", "--values is required for sweep");
      }
      const values = parseValues(valuesRaw);
      const bracketHighRaw = flagValue(argv, "--bracket-high");
      const bracketHigh =
        bracketHighRaw === null ? 1000 : Number(bracketHighRaw);
      if (!Number.isFinite(bracketHigh) || bracketHigh <= 0) {
        throw new CliError("USAGE", "--bracket-high must be a positive number");
      }
      const { report, provenance } = await runSweep({
        pool,
        path,
        values,
        window: requested,
        bracketHigh,
      });
      process.stdout.write(
        format === "json"
          ? `${JSON.stringify({ status: "ok", command, report, provenance }, null, 2)}\n`
          : `${renderSweepTable(report, provenance)}\n`,
      );
      return;
    }

    const { report, provenance } = await runSourceReplay({
      pool,
      window: requested,
    });
    process.stdout.write(
      format === "json"
        ? `${JSON.stringify({ status: "ok", command, report, provenance }, null, 2)}\n`
        : `${renderSourceTable(
            report as {
              totals: ReturnType<SourceReplayAccumulator["totals"]>;
              counterfactual_pnl: ReturnType<typeof counterfactualPnl>;
            },
            provenance,
          )}\n`,
    );
  } finally {
    await raw.end();
  }
}

void run().catch((error: unknown) => {
  const reasonCode =
    error instanceof CliError
      ? error.reasonCode
      : error instanceof SweepError
        ? error.reasonCode
        : error instanceof ConfigError
          ? error.reasonCode
          : "SHADOW_REPLAY_FAILED";
  process.stderr.write(
    `${JSON.stringify({
      level: "error",
      service: "shadow-replay-cli",
      reason_code: reasonCode,
      error_name: error instanceof Error ? error.name : "UnknownError",
      detail: error instanceof Error ? error.message : undefined,
      message: "shadow_replay_failed",
    })}\n`,
  );
  process.exitCode = 1;
});
