// DATA-03 local, one-use destination. Failed staging files are quarantined.
import { constants } from "node:fs";
import {
  link,
  lstat,
  open,
  readdir,
  realpath,
  statfs,
  unlink,
} from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

export const DATA03_MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;
const RESERVE_BYTES = 64 * 1024 * 1024;
type ArchiveName = "archive.json" | "certificate.json";
export interface ArchiveDestination {
  write(name: ArchiveName, value: unknown): Promise<void>;
}

function budget(value: number): void {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > DATA03_MAX_ARCHIVE_BYTES
  )
    throw new Error("DATA03_STORAGE_BUDGET_INVALID");
}

/** Keep at least 25% of the filesystem plus a 64 MiB operational reserve. */
export function assertArchiveCapacity(
  freeBytes: number,
  totalBytes: number,
  requiredBytes: number,
): void {
  if (
    ![freeBytes, totalBytes, requiredBytes].every(Number.isSafeInteger) ||
    totalBytes <= 0 ||
    freeBytes < 0 ||
    freeBytes > totalBytes ||
    requiredBytes < 0 ||
    freeBytes - requiredBytes < Math.ceil(totalBytes / 4) + RESERVE_BYTES
  )
    throw new Error("DATA03_STORAGE_CAPACITY_INSUFFICIENT");
}

async function exactPath(path: string): Promise<void> {
  if (!isAbsolute(path) || (await realpath(path)) !== resolve(path))
    throw new Error("DATA03_STORAGE_SYMLINK_OR_PATH_INVALID");
}

async function capacity(directory: string, required: number): Promise<void> {
  const space = await statfs(directory, { bigint: true });
  assertArchiveCapacity(
    Number(space.bavail * space.bsize),
    Number(space.blocks * space.bsize),
    required,
  );
}

export async function withArchiveDestination<T>(
  directory: string,
  maxBytes: number,
  action: (destination: ArchiveDestination) => Promise<T>,
): Promise<T> {
  budget(maxBytes);
  await exactPath(directory);
  const original = await lstat(directory);
  if (!original.isDirectory() || (original.mode & 0o777) !== 0o700)
    throw new Error("DATA03_STORAGE_PRIVATE_DIRECTORY_REQUIRED");
  const lockPath = join(directory, ".data03.lock");
  const lock = await open(
    lockPath,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  const ownedLock = await lock.stat();
  let active = true;
  let writing = false;
  let used = 0;
  let archiveWritten = false;
  let failed = false;
  const written = new Set<ArchiveName>();
  const pending = new Set<Promise<void>>();
  async function checkDirectory(): Promise<void> {
    await exactPath(directory);
    const current = await lstat(directory);
    if (
      !current.isDirectory() ||
      current.ino !== original.ino ||
      current.dev !== original.dev ||
      (current.mode & 0o777) !== 0o700
    )
      throw new Error("DATA03_STORAGE_DESTINATION_CHANGED");
  }
  try {
    if ((await readdir(directory)).some((entry) => entry !== ".data03.lock"))
      throw new Error("DATA03_STORAGE_EMPTY_DIRECTORY_REQUIRED");
    await capacity(directory, maxBytes);
    const destination: ArchiveDestination = {
      async write(name, value) {
        if (
          !active ||
          writing ||
          failed ||
          written.has(name) ||
          (name !== "archive.json" && name !== "certificate.json") ||
          (name === "certificate.json" && !archiveWritten)
        )
          throw new Error("DATA03_STORAGE_WRITE_ORDER_INVALID");
        writing = true;
        try {
          await checkDirectory();
          const json = JSON.stringify(value);
          if (json === undefined)
            throw new Error("DATA03_STORAGE_JSON_REQUIRED");
          const bytes = Buffer.from(`${json}\n`, "utf8");
          if (bytes.length > maxBytes - used)
            throw new Error("DATA03_STORAGE_QUOTA_EXCEEDED");
          await capacity(directory, maxBytes - used);
          const partial = join(directory, `.${name}.partial`);
          const final = join(directory, name);
          const file = await open(
            partial,
            constants.O_WRONLY |
              constants.O_CREAT |
              constants.O_EXCL |
              constants.O_NOFOLLOW,
            0o600,
          );
          try {
            await file.writeFile(bytes);
            await file.sync();
          } finally {
            await file.close();
          }
          await checkDirectory();
          // link() publishes atomically and cannot replace an existing path.
          await link(partial, final);
          const directoryHandle = await open(directory, constants.O_RDONLY);
          try {
            await directoryHandle.sync();
            // Only remove this operation's completed staging link.
            await unlink(partial);
            await directoryHandle.sync();
          } finally {
            await directoryHandle.close();
          }
          used += bytes.length;
          written.add(name);
          archiveWritten ||= name === "archive.json";
        } catch (error) {
          failed = true;
          throw error;
        } finally {
          writing = false;
        }
      },
    };
    const write = destination.write.bind(destination);
    destination.write = (name, value) => {
      const operation = write(name, value);
      pending.add(operation);
      void operation.then(
        () => pending.delete(operation),
        () => pending.delete(operation),
      );
      return operation;
    };
    const result = await action(destination);
    await Promise.all([...pending]);
    if (failed) throw new Error("DATA03_STORAGE_SESSION_FAILED");
    return result;
  } finally {
    active = false;
    // A caller forgetting await cannot release the lock around an active write.
    await Promise.allSettled([...pending]);
    await lock.close();
    // Never remove somebody else's replacement lock or walk another directory.
    const current = await lstat(directory).catch(() => null);
    if (current?.ino === original.ino && current.dev === original.dev) {
      const currentLock = await lstat(lockPath).catch(() => null);
      if (
        currentLock?.ino === ownedLock.ino &&
        currentLock.dev === ownedLock.dev
      )
        await unlink(lockPath);
    }
  }
}

/** Bounded local JSON input; no credential discovery or automatic cleanup. */
export async function readArchiveFile(
  path: string,
  maxBytes = DATA03_MAX_ARCHIVE_BYTES,
): Promise<unknown> {
  budget(maxBytes);
  await exactPath(path);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size > maxBytes)
      throw new Error("DATA03_STORAGE_INPUT_INVALID");
    const bytes = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(
        bytes,
        length,
        bytes.length - length,
        null,
      );
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    if (length > maxBytes) throw new Error("DATA03_STORAGE_QUOTA_EXCEEDED");
    return JSON.parse(bytes.subarray(0, length).toString("utf8")) as unknown;
  } finally {
    await file.close();
  }
}
