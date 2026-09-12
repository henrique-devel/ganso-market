import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertArchiveCapacity,
  DATA03_MAX_ARCHIVE_BYTES,
  readArchiveFile,
  withArchiveDestination,
  type ArchiveDestination,
} from "../../src/polymarket/retention-archive-storage.js";

const fixtures: string[] = [];
async function destination(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "data03-storage-")));
  fixtures.push(dir);
  await chmod(dir, 0o700);
  return dir;
}
afterEach(async () => {
  for (const path of fixtures.splice(0))
    await rm(path, { recursive: true, force: true });
});

describe("DATA-03 bounded artifact storage", () => {
  it("reserves 25% plus 64 MiB and rejects insufficient capacity before writing", () => {
    const mib = 1024 * 1024;
    expect(() =>
      assertArchiveCapacity(336 * mib, 1024 * mib, 16 * mib),
    ).not.toThrow();
    expect(() =>
      assertArchiveCapacity(336 * mib - 1, 1024 * mib, 16 * mib),
    ).toThrow("CAPACITY");
    expect(() => assertArchiveCapacity(-1, 1024 * mib, 1)).toThrow("CAPACITY");
    expect(() =>
      assertArchiveCapacity(400 * mib, 1024 * mib, Number.NaN),
    ).toThrow("CAPACITY");
  });

  it("writes durable private files once, cleans only its lock, and prohibits reuse", async () => {
    const dir = await destination();
    await withArchiveDestination(dir, 1024, async (output) => {
      await output.write("archive.json", {
        row: "9007199254740993",
        ts: ".123456Z",
      });
      await output.write("certificate.json", { verified: true });
    });
    expect(await readdir(dir)).toEqual(["archive.json", "certificate.json"]);
    expect((await stat(join(dir, "archive.json"))).mode & 0o777).toBe(0o600);
    expect(await readArchiveFile(join(dir, "archive.json"))).toEqual({
      row: "9007199254740993",
      ts: ".123456Z",
    });
    await expect(
      withArchiveDestination(dir, 1024, async () => undefined),
    ).rejects.toThrow("EMPTY_DIRECTORY");
  });

  it("rejects public directories, symlink destinations and symlink inputs", async () => {
    const dir = await destination();
    await chmod(dir, 0o755);
    await expect(
      withArchiveDestination(dir, 1024, async () => undefined),
    ).rejects.toThrow("PRIVATE_DIRECTORY");
    await chmod(dir, 0o700);
    const parent = await destination();
    const alias = join(parent, "alias");
    await symlink(dir, alias);
    await expect(
      withArchiveDestination(alias, 1024, async () => undefined),
    ).rejects.toThrow("SYMLINK");
    await writeFile(join(dir, "input.json"), "{}");
    const input = join(parent, "input.json");
    await symlink(join(dir, "input.json"), input);
    await expect(readArchiveFile(input)).rejects.toThrow("SYMLINK");
  });

  it("serializes sessions with an exclusive lock without deleting another lock", async () => {
    const dir = await destination();
    await withArchiveDestination(dir, 1024, async () => {
      await expect(
        withArchiveDestination(dir, 1024, async () => undefined),
      ).rejects.toThrow();
      expect(await readdir(dir)).toEqual([".data03.lock"]);
    });
    expect(await readdir(dir)).toEqual([]);
    await writeFile(join(dir, ".data03.lock"), "owned elsewhere");
    await expect(
      withArchiveDestination(dir, 1024, async () => undefined),
    ).rejects.toThrow();
    expect(await readFile(join(dir, ".data03.lock"), "utf8")).toBe(
      "owned elsewhere",
    );
  });

  it("counts UTF-8 and JSON escaping against cumulative quota, withholding certificate", async () => {
    const dir = await destination();
    const value = { text: '"\n😀' };
    const archiveBytes = Buffer.byteLength(`${JSON.stringify(value)}\n`);
    await expect(
      withArchiveDestination(dir, archiveBytes + 2, async (output) => {
        await output.write("archive.json", value);
        await output.write("certificate.json", {});
      }),
    ).rejects.toThrow("QUOTA");
    expect(await readdir(dir)).toEqual(["archive.json"]);
    await expect(
      readArchiveFile(join(dir, "archive.json"), archiveBytes - 1),
    ).rejects.toThrow("INPUT_INVALID");
  });

  it("rejects oversize quota and early certificates without invoking the callback", async () => {
    const dir = await destination();
    let called = false;
    await expect(
      withArchiveDestination(dir, DATA03_MAX_ARCHIVE_BYTES + 1, async () => {
        called = true;
      }),
    ).rejects.toThrow("BUDGET");
    expect(called).toBe(false);
    await withArchiveDestination(dir, 1024, async (output) => {
      await expect(output.write("certificate.json", {})).rejects.toThrow(
        "WRITE_ORDER",
      );
    });
    expect(await readdir(dir)).toEqual([]);
  });

  it("never overwrites a conflicting final path and leaves failed staging quarantined", async () => {
    const dir = await destination();
    await expect(
      withArchiveDestination(dir, 1024, async (output) => {
        await writeFile(join(dir, "archive.json"), "external");
        await output.write("archive.json", { archive: true });
      }),
    ).rejects.toThrow();
    expect(await readFile(join(dir, "archive.json"), "utf8")).toBe("external");
    expect(await readdir(dir)).toEqual([
      ".archive.json.partial",
      "archive.json",
    ]);
  });

  it("refuses symlink staging, invalid names and writes after the session", async () => {
    const dir = await destination();
    const other = await destination();
    const untouched = join(other, "untouched");
    await writeFile(untouched, "unchanged");
    let saved: ArchiveDestination | undefined;
    await expect(
      withArchiveDestination(dir, 1024, async (output) => {
        saved = output;
        await expect(
          output.write("../escape" as "archive.json", {}),
        ).rejects.toThrow("WRITE_ORDER");
        await symlink(untouched, join(dir, ".archive.json.partial"));
        await output.write("archive.json", {});
      }),
    ).rejects.toThrow();
    expect(await readFile(untouched, "utf8")).toBe("unchanged");
    await expect(saved!.write("archive.json", {})).rejects.toThrow(
      "WRITE_ORDER",
    );
    expect(await readdir(other)).toEqual(["untouched"]);
  });

  it("requires an already configured directory and rejects non-file inputs", async () => {
    const dir = await destination();
    await expect(
      withArchiveDestination(join(dir, "missing"), 1024, async () => undefined),
    ).rejects.toThrow();
    await mkdir(join(dir, "not-file"), { mode: 0o700 });
    await expect(readArchiveFile(join(dir, "not-file"))).rejects.toThrow(
      "INPUT_INVALID",
    );
  });
});
