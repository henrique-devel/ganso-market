import { readFileSync } from "node:fs";

import type { AnySchema, ValidateFunction } from "ajv";
import Ajv2020Module from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { describe, expect, it } from "vitest";

const Ajv2020 = Ajv2020Module.default;
const addFormats = addFormatsModule.default;
type Ajv2020Instance = InstanceType<typeof Ajv2020>;

interface FixtureCase {
  readonly name: string;
  readonly schema_id: string;
  readonly data: unknown;
}

const schemaNames = [
  "execution-mode",
  "reason-code",
  "money-amount",
  "event-identity",
  "data-freshness",
  "service-health",
] as const;

function readJson(relativeUrl: string): unknown {
  return JSON.parse(
    readFileSync(new URL(relativeUrl, import.meta.url), "utf8"),
  );
}

function readFixtures(kind: "valid" | "invalid"): FixtureCase[] {
  return readJson(`../fixtures/v1/${kind}.json`) as FixtureCase[];
}

function createAjv(): Ajv2020Instance {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    validateFormats: true,
  });
  addFormats(ajv);

  for (const schemaName of schemaNames) {
    const schema = readJson(
      `../schemas/v1/${schemaName}.schema.json`,
    ) as AnySchema;
    ajv.addSchema(schema);
  }

  return ajv;
}

function validatorFor(
  ajv: Ajv2020Instance,
  schemaId: string,
): ValidateFunction {
  const validator = ajv.getSchema(schemaId);
  if (validator === undefined) {
    throw new Error(`Fixture references an unknown schema: ${schemaId}`);
  }
  return validator;
}

describe("v1 JSON Schema fixtures", () => {
  const ajv = createAjv();
  const validFixtures = readFixtures("valid");
  const invalidFixtures = readFixtures("invalid");

  for (const fixture of validFixtures) {
    it(`accepts valid fixture: ${fixture.name}`, () => {
      const validator = validatorFor(ajv, fixture.schema_id);
      expect(validator(fixture.data), JSON.stringify(validator.errors)).toBe(
        true,
      );
    });
  }

  for (const fixture of invalidFixtures) {
    it(`rejects invalid fixture: ${fixture.name}`, () => {
      const validator = validatorFor(ajv, fixture.schema_id);
      expect(validator(fixture.data)).toBe(false);
    });
  }

  it.each([
    "execution-mode-live",
    "execution-mode-unknown",
    "money-raw-json-float",
    "money-raw-exponent",
    "money-raw-leading-zero",
    "money-raw-negative-zero",
    "event-source-timestamp-not-utc",
    "event-received-at-without-timezone",
    "service-health-status-unknown",
    "service-health-live-execution-mode",
    "service-health-checked-at-not-utc",
    "service-health-invalid-correlation-id",
  ])(
    "contains and rejects mandatory unhappy-path fixture: %s",
    (fixtureName) => {
      const fixture = invalidFixtures.find(({ name }) => name === fixtureName);
      expect(fixture, `Missing mandatory fixture ${fixtureName}`).toBeDefined();

      const validator = validatorFor(ajv, fixture!.schema_id);
      expect(validator(fixture!.data)).toBe(false);
    },
  );
});
