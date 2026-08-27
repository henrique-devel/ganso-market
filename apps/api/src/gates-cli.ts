// RFC-013 task 9, gate G6: the owner's written review, recorded.
//
// Deliberately a CLI and not an endpoint. The RFC-013 perimeter publishes the
// portfolio surfaces GET-only, and the two things that stay closed at the edge
// are the ones that change what the system is allowed to do: leaving HALTED,
// and this. An approval reachable from outside is an approval that can be
// requested by something that is not the owner.
//
// Run inside the API container, with the written review on stdin:
//
//   docker compose exec -T api node dist/gates-cli.js show
//   docker compose exec -T api node dist/gates-cli.js approve 7 \
//     --reviewer owner --acknowledge-expectation < review.txt
//
// SIMULAÇÃO — SEM EXECUÇÃO REAL. A passing G6 unlocks nothing by itself:
// RFC-009 stays blocked until every gate is PASS and the owner starts it
// explicitly.

import { ConfigError, loadConfig } from "./config.js";
import { createDatabasePool } from "./database.js";
import {
  approvalRecord,
  checkApproval,
} from "./polymarket/portfolio/approval.js";
import { CALIBRATED_EXPECTATION } from "./polymarket/portfolio/gates.js";
import {
  loadGateReport,
  loadLatestGateReport,
  recordOwnerApproval,
} from "./polymarket/portfolio/gatestore.js";

class CliError extends Error {
  public readonly reasonCode: string;

  public constructor(reasonCode: string, message: string) {
    super(message);
    this.name = "CliError";
    this.reasonCode = reasonCode;
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk as Buffer));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function flagValue(argv: readonly string[], flag: string): string | null {
  const index = argv.indexOf(flag);
  if (index < 0) {
    return null;
  }
  return argv[index + 1] ?? null;
}

async function run(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  if (command !== "show" && command !== "approve") {
    throw new CliError(
      "USAGE",
      "usage: gates <show | approve <report_id> --reviewer <name> " +
        "--acknowledge-expectation>  (the written review is read from stdin)",
    );
  }

  // The note is read BEFORE the database is opened: an approve invoked without
  // a redirect would otherwise sit on an open pool waiting for a terminal.
  const note = command === "approve" ? await readStdin() : "";

  const config = await loadConfig();
  const pool = createDatabasePool(config);
  try {
    if (command === "show") {
      const report = await loadLatestGateReport(pool);
      process.stdout.write(
        `${JSON.stringify({
          status: "ok",
          command,
          report:
            report === null
              ? null
              : {
                  report_id: report.reportId,
                  overall_status: report.overallStatus,
                  gates: report.gates,
                  already_approved: report.alreadyApproved,
                },
          calibrated_expectation: CALIBRATED_EXPECTATION,
        })}\n`,
      );
      return;
    }

    const reportId = Number(argv[1]);
    if (!Number.isSafeInteger(reportId) || reportId <= 0) {
      throw new CliError(
        "INVALID_REPORT_ID",
        "report_id must be a positive integer",
      );
    }
    const request = {
      reportId,
      reviewer: flagValue(argv, "--reviewer") ?? "",
      note,
      acknowledgedExpectation: argv.includes("--acknowledge-expectation"),
    };

    const [report, latest] = await Promise.all([
      loadGateReport(pool, reportId),
      loadLatestGateReport(pool),
    ]);
    const check = checkApproval({
      request,
      report,
      currentReportId: latest?.reportId ?? null,
    });
    if (!check.ok) {
      throw new CliError(check.reasonCode, check.detail);
    }

    const reviewedAt = new Date();
    const written = await recordOwnerApproval(pool, {
      reportId,
      approval: approvalRecord({ request, reviewedAt }),
    });
    if (!written) {
      // The statement carries the same guard as the check above it. Losing here
      // means the report stopped being current, or acquired an approval,
      // between the two — a race whose safe answer is to refuse.
      throw new CliError(
        "APPROVAL_RACED",
        "the report changed between the check and the write; re-run against " +
          "the current report",
      );
    }
    process.stdout.write(
      `${JSON.stringify({
        status: "ok",
        command,
        report_id: reportId,
        reviewer: request.reviewer,
        reviewed_at: reviewedAt.toISOString(),
      })}\n`,
    );
  } finally {
    await pool.end();
  }
}

void run().catch((error: unknown) => {
  const reasonCode =
    error instanceof CliError
      ? error.reasonCode
      : error instanceof ConfigError
        ? error.reasonCode
        : "GATES_CLI_FAILED";
  process.stderr.write(
    `${JSON.stringify({
      level: "error",
      service: "gates-cli",
      reason_code: reasonCode,
      error_name: error instanceof Error ? error.name : "UnknownError",
      // Every refusal says WHAT it refused. A bare reason code would send the
      // operator back into the schema to find out why.
      detail: error instanceof Error ? error.message : undefined,
      message: "gates_cli_failed",
    })}\n`,
  );
  process.exitCode = 1;
});
