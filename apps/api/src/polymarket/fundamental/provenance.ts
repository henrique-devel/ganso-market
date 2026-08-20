// RFC-010 provenance: the git SHA of the code that produced an estimate.
// "Estimativa sem proveniência completa é bug, não degradação aceitável", so
// when the SHA cannot be established the models are not allowed to serve:
// the estimator degrades to MARKET_BASELINE with the explicit reason
// PROVENANCE_UNAVAILABLE, which is observable in the stored row.
//
// Resolution order:
//   1. GANSO_GIT_SHA (explicit override, used by local runs and tests);
//   2. the release SHA file (default /etc/ganso/release-sha), which the repo
//      ships as `deploy/release-sha` containing a git `export-subst`
//      placeholder — `git archive` rewrites it to the deployed commit, so the
//      production container always carries the exact revision it was built
//      from. In a plain git checkout the placeholder stays literal and this
//      step correctly yields "unknown".

import { readFile } from "node:fs/promises";

export const GIT_SHA_ENV = "GANSO_GIT_SHA";
export const RELEASE_SHA_FILE_ENV = "GANSO_RELEASE_SHA_FILE";
export const DEFAULT_RELEASE_SHA_FILE = "/etc/ganso/release-sha";

const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

export interface ResolveGitShaOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly readTextFile?: (path: string) => Promise<string>;
}

/** The 40-hex commit SHA of the running code, or null when unknown. */
export async function resolveGitSha(
  options: ResolveGitShaOptions = {},
): Promise<string | null> {
  const env = options.env ?? process.env;
  const readTextFile =
    options.readTextFile ?? ((path: string) => readFile(path, "utf8"));

  const fromEnv = env[GIT_SHA_ENV];
  if (typeof fromEnv === "string" && GIT_SHA_PATTERN.test(fromEnv.trim())) {
    return fromEnv.trim();
  }

  const path = env[RELEASE_SHA_FILE_ENV] ?? DEFAULT_RELEASE_SHA_FILE;
  try {
    const raw = await readTextFile(path);
    const candidate = raw.trim();
    return GIT_SHA_PATTERN.test(candidate) ? candidate : null;
  } catch {
    return null;
  }
}
