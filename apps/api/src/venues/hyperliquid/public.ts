import { HttpTransport } from "@nktkas/hyperliquid";
import { meta } from "@nktkas/hyperliquid/api/info";
import {
  HYPERLIQUID_API_URL,
  HyperliquidMetadataError,
  parseHyperliquidBtcMetadata,
} from "./metadata.js";

/** Inert until explicitly called. One public request, no retries, subscriptions,
 * environment/credentials, wallet, exchange client or background collection.
 */
export function createHyperliquidPublicAdapter() {
  const transport = new HttpTransport({
    apiUrl: HYPERLIQUID_API_URL,
    isTestnet: false,
    timeout: 8000,
  });
  return {
    async getBtcMetadata(signal?: AbortSignal) {
      let response: unknown;
      try {
        response = await meta({ transport }, { dex: "" }, signal);
      } catch {
        // Do not leak raw transport payloads or present fallback metadata as current.
        throw new HyperliquidMetadataError(
          "unavailable",
          "Public Hyperliquid metadata unavailable",
        );
      }
      return parseHyperliquidBtcMetadata(response, new Date().toISOString());
    },
  };
}
