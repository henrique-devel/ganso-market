import { readFile, stat } from "node:fs/promises";
import { SecretValue } from "../config.js";
import { quote, record, keys, type JevTariff } from "./jev-contract.js";

export interface ChallengerConfig {
  enabled: boolean;
  credentialPresent: boolean;
  key: SecretValue | null;
  tariff: JevTariff | null;
  provisionReference: string | null;
  billingBoundReference: string | null;
  reasons: string[];
}
export const disabledChallengerConfig = (): ChallengerConfig => ({
  enabled: false,
  credentialPresent: false,
  key: null,
  tariff: null,
  provisionReference: null,
  billingBoundReference: null,
  reasons: ["configuration_missing"],
});
/** Protected, optional backend files. No env key discovery, mock fallback,
 * default tariff, credit, or fatal API boot on a Jev configuration failure. */
export async function loadChallengerConfig(
  configPath = "/etc/ganso/jev/config.json",
  keyPath = "/run/secrets/jev_api_key",
): Promise<ChallengerConfig> {
  const result = disabledChallengerConfig();
  try {
    const s = await stat(keyPath);
    result.credentialPresent =
      s.isFile() && s.size > 0 && s.size <= 4096 && (s.mode & 0o077) === 0;
  } catch {
    /* Presence only when disabled. */
  }
  let raw: unknown;
  try {
    const s = await stat(configPath);
    if (!s.isFile() || s.size > 8192 || (s.mode & 0o022) !== 0)
      throw new Error();
    raw = JSON.parse(await readFile(configPath, "utf8"));
  } catch (e) {
    result.reasons = [
      (e as NodeJS.ErrnoException).code === "ENOENT"
        ? "configuration_missing"
        : "configuration_invalid",
    ];
    return result;
  }
  const c = record(raw);
  if (!c || typeof c.enabled !== "boolean") {
    result.reasons = ["configuration_invalid"];
    return result;
  }
  if (!c.enabled) {
    result.reasons = ["switch_disabled"];
    return result;
  }
  const ref = (v: unknown): v is string =>
    typeof v === "string" && /^[a-zA-Z0-9:._/-]{1,200}$/.test(v);
  const tariff = record(c.tariff);
  if (
    !keys(c, [
      "enabled",
      "tariff",
      "provision_reference",
      "billing_bound_reference",
    ]) ||
    !tariff ||
    !keys(tariff, [
      "version",
      "model",
      "valid_until",
      "input_usd6_per_million",
      "output_usd6_per_million",
      "max_billable_input_tokens",
    ]) ||
    !ref(c.provision_reference) ||
    !ref(c.billing_bound_reference) ||
    !quote(
      tariff as unknown as JevTariff,
      String(tariff.model),
      new Date().toISOString(),
    )
  ) {
    result.reasons = ["tariff_or_coverage_attestation_invalid"];
    return result;
  }
  result.enabled = true;
  result.tariff = Object.freeze({ ...tariff }) as unknown as JevTariff;
  result.provisionReference = c.provision_reference;
  result.billingBoundReference = c.billing_bound_reference;
  result.reasons = [];
  if (result.credentialPresent) {
    try {
      result.key = new SecretValue((await readFile(keyPath, "utf8")).trim());
    } catch {
      result.credentialPresent = false;
    }
  }
  return result;
}
