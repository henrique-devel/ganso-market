import { describe, expect, it } from "vitest";

import {
  DEFAULT_RELEASE_SHA_FILE,
  GIT_SHA_ENV,
  RELEASE_SHA_FILE_ENV,
  resolveGitSha,
} from "../../../src/polymarket/fundamental/provenance.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";

describe("resolveGitSha", () => {
  it("prefers an explicit environment override", async () => {
    const resolved = await resolveGitSha({
      env: { [GIT_SHA_ENV]: ` ${SHA} ` },
      readTextFile: () => Promise.reject(new Error("must not be read")),
    });
    expect(resolved).toBe(SHA);
  });

  it("reads the release file at the default path", async () => {
    const seen: string[] = [];
    const resolved = await resolveGitSha({
      env: {},
      readTextFile: (path) => {
        seen.push(path);
        return Promise.resolve(`${SHA}\n`);
      },
    });
    expect(seen).toEqual([DEFAULT_RELEASE_SHA_FILE]);
    expect(resolved).toBe(SHA);
  });

  it("honours a configured release file path", async () => {
    const seen: string[] = [];
    await resolveGitSha({
      env: { [RELEASE_SHA_FILE_ENV]: "/tmp/release-sha" },
      readTextFile: (path) => {
        seen.push(path);
        return Promise.resolve(SHA);
      },
    });
    expect(seen).toEqual(["/tmp/release-sha"]);
  });

  it("returns null for the unsubstituted git placeholder", async () => {
    // In a plain checkout `git archive` never ran, so the file still holds the
    // literal export-subst placeholder. That must resolve to "unknown", which
    // blocks every MODEL row rather than stamping a fake revision.
    const resolved = await resolveGitSha({
      env: {},
      readTextFile: () => Promise.resolve("$Format:%H$\n"),
    });
    expect(resolved).toBeNull();
  });

  it("returns null for a malformed or unreadable file", async () => {
    expect(
      await resolveGitSha({
        env: {},
        readTextFile: () => Promise.resolve("not-a-sha"),
      }),
    ).toBeNull();
    expect(
      await resolveGitSha({
        env: {},
        readTextFile: () => Promise.reject(new Error("ENOENT")),
      }),
    ).toBeNull();
    // A short hex string is not a commit SHA.
    expect(
      await resolveGitSha({
        env: { [GIT_SHA_ENV]: "abc123" },
        readTextFile: () => Promise.resolve("abc123"),
      }),
    ).toBeNull();
  });
});
