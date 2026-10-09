import { HttpTransport } from "@nktkas/hyperliquid";
import {
  CancelByCloidRequest,
  OrderRequest,
} from "@nktkas/hyperliquid/api/exchange";
import {
  canonicalize,
  getWalletAddress,
  signL1Action,
  type AbstractWallet,
} from "@nktkas/hyperliquid/signing";
import {
  assertLiveGate,
  liveCheck,
  LIVE_URLS,
  validateLiveIdentity,
  LiveError,
  type LiveGate,
  type LiveIdentity,
  type LiveReservation,
} from "./live-contract.js";
import { jevHash } from "../../storage/jev-hash.js";
import { buildLiveAction, type LiveCommand } from "./live-execution.js";

export interface LiveWire {
  readonly isTestnet: boolean;
  request<T>(
    endpoint: "info" | "exchange",
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<T>;
}
/** No discovery of credentials, boot hook, subscription, retry or automatic activation.
 * JE14 must provide a verified operator gate; a wallet alone is never sufficient. */
export function createHyperliquidLiveBoundary(input: {
  identity: LiveIdentity;
  executor_enabled?: boolean;
  wallet?: AbstractWallet;
  wire?: LiveWire;
  gate: (reservation: LiveReservation) => Promise<LiveGate>;
  claim?: (reservation: LiveReservation) => Promise<boolean>;
  clock?: () => number;
}) {
  const identity = Object.freeze(structuredClone(input.identity));
  validateLiveIdentity(identity);
  const clock = input.clock ?? Date.now;
  const enabled = input.executor_enabled === true,
    wallet = input.wallet,
    gate = input.gate,
    claim = input.claim;
  const wire =
    input.wire ??
    new HttpTransport({
      apiUrl: LIVE_URLS[identity.environment],
      isTestnet: identity.environment === "testnet",
      timeout: 1500,
    });
  liveCheck(
    wire.isTestnet === (identity.environment === "testnet"),
    "TRANSPORT_ENVIRONMENT",
  );
  return {
    identity,
    executor_enabled: enabled,
    async info(
      type:
        | "clearinghouseState"
        | "frontendOpenOrders"
        | "userFillsByTime"
        | "userFunding"
        | "orderStatus"
        | "activeAssetData",
      params: Record<string, unknown> = {},
      signal?: AbortSignal,
    ): Promise<unknown> {
      liveCheck(
        !Object.hasOwn(params, "user") && !Object.hasOwn(params, "type"),
        "QUERY_OWNER",
      );
      liveCheck(
        [
          "clearinghouseState",
          "frontendOpenOrders",
          "userFillsByTime",
          "userFunding",
          "orderStatus",
          "activeAssetData",
        ].includes(type),
        "QUERY_TYPE",
      );
      try {
        return await wire.request(
          "info",
          { ...params, type, user: identity.account_address },
          signal,
        );
      } catch {
        throw new LiveError("READ_UNAVAILABLE");
      }
    },
    async submit(
      reservation: LiveReservation,
      signal?: AbortSignal,
    ): Promise<unknown> {
      liveCheck(enabled && wallet, "EXECUTOR_DISABLED");
      const r = structuredClone(reservation);
      assertLiveGate(identity, r, await gate(r), clock());
      liveCheck(
        jevHash(
          buildLiveAction(identity, r.request as LiveCommand, r.cloid, clock()),
        ) === jevHash(r.action),
        "ACTION_INTENT",
      );
      let address: string;
      try {
        address = await getWalletAddress(wallet);
      } catch {
        throw new LiveError("SIGNER_UNAVAILABLE");
      }
      liveCheck(address === identity.signer_address, "SIGNER_IDENTITY");
      liveCheck(
        r.action.type === (r.kind === "cancel" ? "cancelByCloid" : "order"),
        "ACTION_TYPE",
      );
      liveCheck(claim && (await claim(r)), "SEND_ALREADY_CLAIMED");
      const action =
        r.kind === "cancel"
          ? canonicalize(CancelByCloidRequest.entries.action, r.action)
          : canonicalize(OrderRequest.entries.action, r.action);
      // Signature order, environment and expiry are delegated to the pinned SDK.
      // The durable nonce must already be reserved before this call.
      try {
        const signature = await signL1Action({
          wallet,
          action,
          nonce: r.nonce,
          isTestnet: identity.environment === "testnet",
          ...(identity.vault_address
            ? { vaultAddress: identity.vault_address }
            : {}),
          expiresAfter: r.expires_after,
        });
        assertLiveGate(identity, r, await gate(r), clock());
        return await wire.request(
          "exchange",
          {
            action,
            signature,
            nonce: r.nonce,
            expiresAfter: r.expires_after,
            ...(identity.vault_address
              ? { vaultAddress: identity.vault_address }
              : {}),
          },
          signal,
        );
      } catch {
        throw new LiveError("SUBMISSION_UNCERTAIN");
      }
    },
  };
}
