import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { privateKeyToAccount } from "viem/accounts";
import type { AbstractWallet } from "@nktkas/hyperliquid/signing";
import {
  liveCheck,
  type LiveEnvironment,
} from "../venues/hyperliquid/live-contract.js";

export const JEV_LIVE_SIGNER_PATH = "/run/secrets/jev_live_signer";
export interface JevLiveConfig {
  version: "jev.live-runtime.v1";
  identity_hash: string;
  environment: LiveEnvironment;
}
/** Public configuration cannot contain private material or activation flags. */
export async function loadJevLiveConfig(): Promise<JevLiveConfig | null> {
  const path = process.env.GANSO_LIVE_RUNTIME_CONFIG_FILE;
  if (!path) return null;
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    liveCheck(stat.isFile() && stat.size <= 4096, "CONFIG_SIZE");
    const original = await file.readFile("utf8");
    liveCheck(Buffer.byteLength(original) <= 4096, "CONFIG_SIZE");
    const c = JSON.parse(original) as JevLiveConfig;
    liveCheck(
      Object.keys(c).sort().join() === "environment,identity_hash,version" &&
        c.version === "jev.live-runtime.v1" &&
        /^[a-f0-9]{64}$/.test(c.identity_hash) &&
        c.environment === "mainnet",
      "CONFIG_INVALID",
    );
    return Object.freeze(c);
  } catch {
    throw new Error("JEV_LIVE_CONFIG_INVALID");
  } finally {
    await file?.close();
  }
}
/** Called only after matching persisted identity and human activation. The file
 * is a protected server secret; no environment key, discovery, or wallet journal. */
export async function loadJevLiveSigner(): Promise<AbstractWallet> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(
      JEV_LIVE_SIGNER_PATH,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const stat = await file.stat();
    liveCheck(
      stat.isFile() && stat.size <= 128 && (stat.mode & 0o077) === 0,
      "SIGNER_FILE_PROTECTION",
    );
    const value = (await file.readFile("utf8")).trim();
    liveCheck(/^0x[a-f0-9]{64}$/.test(value), "SIGNER_FORMAT");
    const account = privateKeyToAccount(value as `0x${string}`);
    // Keep key material in the library closure, outside inspection/serialization.
    return Object.freeze({
      address: account.address.toLowerCase() as `0x${string}`,
      signTypedData: account.signTypedData,
    });
  } catch {
    throw new Error("JEV_LIVE_SIGNER_UNAVAILABLE");
  } finally {
    await file?.close();
  }
}
