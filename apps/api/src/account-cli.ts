import { assertPasswordPolicy, hashPassword } from "./auth/passwords.js";
import { ConfigError, loadConfig } from "./config.js";
import { createDatabasePool } from "./database.js";

const USERNAME_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;

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

function stripTrailingNewline(value: string): string {
  if (value.endsWith("\r\n")) {
    return value.slice(0, -2);
  }
  if (value.endsWith("\n")) {
    return value.slice(0, -1);
  }
  return value;
}

async function run(): Promise<void> {
  const command = process.argv[2];
  const username = process.argv[3];
  if ((command !== "create" && command !== "reset") || username === undefined) {
    throw new CliError(
      "USAGE",
      "usage: account <create|reset> <username> (password read from stdin)",
    );
  }
  if (!USERNAME_PATTERN.test(username)) {
    throw new CliError(
      "USERNAME_INVALID",
      "username must match ^[a-z][a-z0-9_.-]{0,63}$",
    );
  }

  const password = stripTrailingNewline(await readStdin());
  assertPasswordPolicy(password);
  const passwordHash = await hashPassword(password);

  const config = await loadConfig();
  const pool = createDatabasePool(config);
  try {
    if (command === "create") {
      const existing = await pool.query("SELECT 1 FROM auth_accounts LIMIT 1");
      if (existing.rowCount > 0) {
        throw new CliError(
          "ACCOUNT_EXISTS",
          "an account already exists; use reset to change the password",
        );
      }
      await pool.query(
        "INSERT INTO auth_accounts (username, password_hash) VALUES ($1, $2)",
        [username, passwordHash],
      );
    } else {
      await pool.transaction(async (tx) => {
        const updated = await tx.query(
          "UPDATE auth_accounts SET password_hash = $2, password_changed_at = CURRENT_TIMESTAMP WHERE username = $1",
          [username, passwordHash],
        );
        if (updated.rowCount === 0) {
          throw new CliError(
            "ACCOUNT_NOT_FOUND",
            "no account exists with that username",
          );
        }
        // A password change revokes every existing session (AUTH-09).
        await tx.query(
          "UPDATE auth_sessions SET revoked_at = CURRENT_TIMESTAMP, revoked_reason = 'PASSWORD_RESET' WHERE revoked_at IS NULL",
        );
        await tx.query(
          "UPDATE auth_refresh_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE revoked_at IS NULL",
        );
        await tx.query(
          "UPDATE auth_access_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE revoked_at IS NULL",
        );
      });
    }
    process.stdout.write(
      `${JSON.stringify({ status: "ok", command, username })}\n`,
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
        : "ACCOUNT_CLI_FAILED";
  const errorName = error instanceof Error ? error.name : "UnknownError";
  process.stderr.write(
    `${JSON.stringify({
      level: "error",
      service: "account-cli",
      reason_code: reasonCode,
      error_name: errorName,
      message: "account_cli_failed",
    })}\n`,
  );
  process.exitCode = 1;
});
