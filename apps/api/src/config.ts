import { readFile } from "node:fs/promises";
import { inspect } from "node:util";

export const API_CONFIG_FILE_ENV = "GANSO_CONFIG_FILE";
export const API_SECRET_FILE_ENV = "GANSO_POSTGRES_PASSWORD_FILE";

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

export interface ApiConfig {
  readonly executionMode: ExecutionMode;
  readonly server: Readonly<{
    host: string;
    port: number;
  }>;
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
        ["bind_address", "port"],
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
