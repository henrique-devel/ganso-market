import { readFile } from "node:fs/promises";
import { inspect } from "node:util";

export const API_CONFIG_FILE_ENV = "GANSO_CONFIG_FILE";
export const API_SECRET_FILE_ENV = "GANSO_POSTGRES_PASSWORD_FILE";
/**
 * RFC-029 D3. The directory the daily shadow-replay job writes and the API only
 * reads, bind-mounted `:ro` (`docker-compose.yml`, service `api`).
 *
 * Deliberately NOT part of `ApiConfig`: it is a switch, not a setting. Unset,
 * the API starts exactly as before and the two shadow-replay routes answer 404
 * to everything, which is the right answer on a machine where the job has never
 * run. Putting it in the config file would make an absent directory look like a
 * misconfiguration to be refused at boot.
 */
export const API_SHADOW_REPLAY_DIR_ENV = "GANSO_SHADOW_REPLAY_DIR";

const EXECUTION_MODES = ["paper"] as const;
const MAX_SECRET_FILE_BYTES = 4 * 1024;
const LOG_LEVELS = ["error", "warn", "info", "debug"] as const;

export type ExecutionMode = (typeof EXECUTION_MODES)[number];
export type LogLevel = (typeof LOG_LEVELS)[number];

export class SecretValue {
  readonly #value: string;

  public constructor(value: string) {
    if (value.length === 0) {
      throw new ConfigError(
        "SECRET_VALUE_EMPTY",
        "postgres_password must not be empty",
      );
    }
    this.#value = value;
    Object.freeze(this);
  }

  public use<T>(consumer: (value: string) => T): T {
    return consumer(this.#value);
  }

  public toString(): string {
    return "[REDACTED]";
  }

  public toJSON(): string {
    return "[REDACTED]";
  }

  public [inspect.custom](): string {
    return "SecretValue([REDACTED])";
  }
}

/**
 * RFC-023 D1. The per-endpoint statement budget, declared in
 * `services.api.statement_timeout_ms`.
 *
 * `ceiling` is what the pool itself gets, and no route may exceed it. It stays
 * at least 1 s below the edge's `proxy_read_timeout` (`infra/nginx/nginx.conf`)
 * so that a query which runs long is killed by PostgreSQL — which says
 * `pg_code 57014` in the log — and not by Nginx, which says 504 and nothing
 * else. `routes` maps a Fastify route url to its own budget; a route absent
 * from the map runs on `default`.
 */
export interface StatementBudgets {
  readonly ceilingMs: number;
  readonly defaultMs: number;
  readonly routes: Readonly<Record<string, number>>;
}

export interface ApiConfig {
  readonly executionMode: ExecutionMode;
  readonly server: Readonly<{
    host: string;
    port: number;
  }>;
  /**
   * Absent when `services.api.statement_timeout_ms` is not configured. It is
   * deliberately NOT defaulted: an implicit query budget is the defect this
   * RFC removes, so the absence has to be loud. `requireStatementBudgets`
   * turns it into QUERY_TIMEOUT_UNDECLARED at boot.
   */
  readonly statementBudgets?: StatementBudgets;
  readonly database: Readonly<{
    host: string;
    port: number;
    name: string;
    user: string;
    password: SecretValue;
    ssl: boolean;
    connectTimeoutMs: number;
  }>;
  readonly log: Readonly<{
    level: LogLevel;
  }>;
}

export class ConfigError extends Error {
  public readonly reasonCode: string;

  public constructor(reasonCode: string, message: string) {
    super(message);
    this.name = "ConfigError";
    this.reasonCode = reasonCode;
  }
}

type JsonObject = Record<string, unknown>;

interface PartialNonSecretConfig {
  executionMode?: ExecutionMode;
  server?: {
    host?: string;
    port?: number;
  };
  statementBudgets?: StatementBudgets;
  database?: {
    host?: string;
    port?: number;
    name?: string;
    user?: string;
    ssl?: boolean;
    connectTimeoutMs?: number;
  };
  logging?: {
    level?: LogLevel;
  };
}

export interface LoadConfigOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly readTextFile?: (path: string) => Promise<string>;
}

const DEFAULTS = Object.freeze({
  executionMode: "paper" as const,
  server: Object.freeze({
    host: "127.0.0.1",
    port: 3000,
  }),
  database: Object.freeze({
    host: "postgres",
    port: 5432,
    name: "ganso_market",
    user: "ganso_market",
    ssl: false,
    connectTimeoutMs: 2_000,
  }),
  log: Object.freeze({
    level: "info" as const,
  }),
});

export async function loadConfig(
  options: LoadConfigOptions = {},
): Promise<ApiConfig> {
  const env = options.env ?? process.env;
  const readTextFile =
    options.readTextFile ?? ((path: string) => readFile(path, "utf8"));

  const nonSecretPath = optionalPath(
    env[API_CONFIG_FILE_ENV],
    API_CONFIG_FILE_ENV,
  );
  const nonSecret =
    nonSecretPath === undefined
      ? {}
      : parseNonSecretConfig(
          await readConfigFile(
            readTextFile,
            nonSecretPath,
            "CONFIG_FILE_UNREADABLE",
          ),
        );

  const secretPath = requiredPath(
    env[API_SECRET_FILE_ENV],
    API_SECRET_FILE_ENV,
  );
  const postgresPassword = parseSecretFile(
    await readConfigFile(readTextFile, secretPath, "SECRET_FILE_UNREADABLE"),
  );

  return Object.freeze({
    executionMode: nonSecret.executionMode ?? DEFAULTS.executionMode,
    server: Object.freeze({
      ...DEFAULTS.server,
      ...nonSecret.server,
    }),
    ...(nonSecret.statementBudgets === undefined
      ? {}
      : { statementBudgets: nonSecret.statementBudgets }),
    database: Object.freeze({
      ...DEFAULTS.database,
      ...nonSecret.database,
      password: new SecretValue(postgresPassword),
    }),
    log: Object.freeze({
      ...DEFAULTS.log,
      ...nonSecret.logging,
    }),
  });
}

function parseNonSecretConfig(text: string): PartialNonSecretConfig {
  const root = parseJsonObject(text, "CONFIG_FILE_INVALID_JSON");
  rejectUnknownKeys(
    root,
    ["schema_version", "execution_mode", "database", "services", "logging"],
    "config",
  );

  const result: PartialNonSecretConfig = {};

  if (root.schema_version !== undefined) {
    const schemaVersion = parseInteger(
      root.schema_version,
      "schema_version",
      1,
      1,
    );
    if (schemaVersion !== 1) {
      throw new ConfigError(
        "CONFIG_SCHEMA_UNSUPPORTED",
        "schema_version is unsupported",
      );
    }
  }
  if (root.execution_mode !== undefined) {
    result.executionMode = parseEnum(
      root.execution_mode,
      EXECUTION_MODES,
      "execution_mode",
    );
  }
  if (root.database !== undefined) {
    const database = requireObject(root.database, "database");
    rejectUnknownKeys(
      database,
      ["host", "port", "name", "user", "connect_timeout_ms"],
      "database",
    );
    const parsedDatabase: NonNullable<PartialNonSecretConfig["database"]> = {};
    if (database.host !== undefined) {
      parsedDatabase.host = parseNonEmptyString(database.host, "database.host");
    }
    if (database.port !== undefined) {
      parsedDatabase.port = parseInteger(
        database.port,
        "database.port",
        1,
        65_535,
      );
    }
    if (database.name !== undefined) {
      parsedDatabase.name = parseIdentifier(database.name, "database.name");
    }
    if (database.user !== undefined) {
      parsedDatabase.user = parseIdentifier(database.user, "database.user");
    }
    if (database.connect_timeout_ms !== undefined) {
      parsedDatabase.connectTimeoutMs = parseInteger(
        database.connect_timeout_ms,
        "database.connect_timeout_ms",
        100,
        30_000,
      );
    }
    result.database = parsedDatabase;
  }
  if (root.services !== undefined) {
    const services = requireObject(root.services, "services");
    rejectUnknownKeys(
      services,
      ["api", "market_engine", "model_worker"],
      "services",
    );
    for (const serviceName of [
      "api",
      "market_engine",
      "model_worker",
    ] as const) {
      if (services[serviceName] === undefined) {
        continue;
      }
      const service = requireObject(
        services[serviceName],
        `services.${serviceName}`,
      );
      rejectUnknownKeys(
        service,
        serviceName === "api"
          ? ["bind_address", "port", "statement_timeout_ms"]
          : ["bind_address", "port"],
        `services.${serviceName}`,
      );
      const parsedService: NonNullable<PartialNonSecretConfig["server"]> = {};
      if (service.bind_address !== undefined) {
        parsedService.host = parseNonEmptyString(
          service.bind_address,
          `services.${serviceName}.bind_address`,
        );
      }
      if (service.port !== undefined) {
        parsedService.port = parseInteger(
          service.port,
          `services.${serviceName}.port`,
          1,
          65_535,
        );
      }
      if (serviceName === "api") {
        result.server = parsedService;
        if (service.statement_timeout_ms !== undefined) {
          result.statementBudgets = parseStatementBudgets(
            service.statement_timeout_ms,
          );
        }
      }
    }
  }
  if (root.logging !== undefined) {
    const logging = requireObject(root.logging, "logging");
    rejectUnknownKeys(logging, ["level"], "logging");
    const parsedLogging: NonNullable<PartialNonSecretConfig["logging"]> = {};
    if (logging.level !== undefined) {
      parsedLogging.level = parseEnum(
        logging.level,
        LOG_LEVELS,
        "logging.level",
      );
    }
    result.logging = parsedLogging;
  }

  return result;
}

/**
 * RFC-023 D1. `100 <= ms <= ceiling <= STATEMENT_TIMEOUT_CEILING_MAX` for the
 * default and for every route, checked here rather than at the call site: a
 * budget that is only enforced where it is read is a budget that a new call
 * site forgets.
 *
 * The hard maximum exists because the edge gives up first otherwise. With
 * `proxy_read_timeout 5s` in `infra/nginx/nginx.conf`, a budget above 4 s can
 * never be the thing that fires — Nginx returns a 504 with no reason code and
 * the query keeps running on the server, which is exactly the mute failure
 * this RFC is about. Raising this constant without raising the edge first is
 * therefore not a tuning decision, it is a regression.
 */
export const STATEMENT_TIMEOUT_CEILING_MAX = 4_000;
const STATEMENT_TIMEOUT_MIN = 100;

function parseStatementBudgets(value: unknown): StatementBudgets {
  const field = "services.api.statement_timeout_ms";
  const object = requireObject(value, field);
  rejectUnknownKeys(object, ["ceiling", "default", "routes"], field);

  const ceilingMs = parseInteger(
    object.ceiling,
    `${field}.ceiling`,
    STATEMENT_TIMEOUT_MIN,
    STATEMENT_TIMEOUT_CEILING_MAX,
  );
  const defaultMs = parseInteger(
    object.default,
    `${field}.default`,
    STATEMENT_TIMEOUT_MIN,
    ceilingMs,
  );

  const routes: Record<string, number> = {};
  if (object.routes !== undefined) {
    const rawRoutes = requireObject(object.routes, `${field}.routes`);
    for (const [route, budget] of Object.entries(rawRoutes)) {
      if (!route.startsWith("/")) {
        throw new ConfigError(
          "CONFIG_FIELD_INVALID",
          `${field}.routes key must be a route path starting with "/"`,
        );
      }
      routes[route] = parseInteger(
        budget,
        `${field}.routes.${route}`,
        STATEMENT_TIMEOUT_MIN,
        ceilingMs,
      );
    }
  }

  return Object.freeze({
    ceilingMs,
    defaultMs,
    routes: Object.freeze(routes),
  });
}

/**
 * RFC-023 D1, fail-closed. The API and the CLIs do not start without a
 * declared budget: an inherited one — the connect timeout, for four months —
 * is what made every panel query share a 1 s ceiling nobody had chosen.
 */
export function requireStatementBudgets(config: ApiConfig): StatementBudgets {
  if (config.statementBudgets === undefined) {
    throw new ConfigError(
      "QUERY_TIMEOUT_UNDECLARED",
      "services.api.statement_timeout_ms must declare ceiling and default",
    );
  }
  return config.statementBudgets;
}

function parseSecretFile(text: string): string {
  if (Buffer.byteLength(text, "utf8") > MAX_SECRET_FILE_BYTES) {
    throw new ConfigError(
      "SECRET_FILE_INVALID",
      "postgres password secret exceeds 4096 bytes",
    );
  }
  const value = text.endsWith("\r\n")
    ? text.slice(0, -2)
    : text.endsWith("\n")
      ? text.slice(0, -1)
      : text;
  if (value.length === 0 || /[\r\n\0]/.test(value)) {
    throw new ConfigError(
      "SECRET_FILE_INVALID",
      "postgres password secret must be one non-empty line",
    );
  }
  return value;
}

async function readConfigFile(
  reader: (path: string) => Promise<string>,
  path: string,
  reasonCode: string,
): Promise<string> {
  try {
    return await reader(path);
  } catch {
    throw new ConfigError(reasonCode, "configured file could not be read");
  }
}

function parseJsonObject(text: string, reasonCode: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new ConfigError(reasonCode, "configured file is not valid JSON");
  }
  return requireObject(parsed, "root");
}

function requireObject(value: unknown, field: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigError("CONFIG_FIELD_INVALID", `${field} must be an object`);
  }
  return value as JsonObject;
}

function rejectUnknownKeys(
  object: JsonObject,
  allowed: readonly string[],
  field: string,
): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(object).find((key) => !allowedKeys.has(key));
  if (unknown !== undefined) {
    throw new ConfigError(
      "CONFIG_FIELD_UNKNOWN",
      `${field}.${unknown} is not allowed`,
    );
  }
}

function parseEnum<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  field: string,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value as T[number])) {
    throw new ConfigError(
      "CONFIG_FIELD_INVALID",
      `${field} contains an unsupported value`,
    );
  }
  return value as T[number];
}

function parseNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ConfigError(
      "CONFIG_FIELD_INVALID",
      `${field} must be a non-empty string`,
    );
  }
  return value;
}

function parseIdentifier(value: unknown, field: string): string {
  const identifier = parseNonEmptyString(value, field);
  if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(identifier)) {
    throw new ConfigError(
      "CONFIG_FIELD_INVALID",
      `${field} must be a PostgreSQL identifier`,
    );
  }
  return identifier;
}

function parseInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    throw new ConfigError(
      "CONFIG_FIELD_INVALID",
      `${field} must be an integer from ${minimum} through ${maximum}`,
    );
  }
  return value as number;
}

function requiredPath(value: string | undefined, variableName: string): string {
  const path = optionalPath(value, variableName);
  if (path === undefined) {
    throw new ConfigError(
      "SECRET_FILE_REQUIRED",
      `${variableName} must identify a mounted secret file`,
    );
  }
  return path;
}

function optionalPath(
  value: string | undefined,
  variableName: string,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value.length === 0 || value.trim() !== value) {
    throw new ConfigError(
      "CONFIG_PATH_INVALID",
      `${variableName} must be a non-empty exact path`,
    );
  }
  return value;
}
