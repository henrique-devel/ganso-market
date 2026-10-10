import { createTicketKey } from "./btc-ticket.js";
import { readCsrfCookie } from "./auth.js";
type Command = { action: "pause" | "emergency"; account_id: string };
type Intent = { body: string; key: string };
/** Only public intent/key persist. Session credentials are never stored here.
 * A synchronous latch protects double clicks; reloads reuse uncertain requests. */
function browserStorage() {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}
export function createJevControlClient(
  accounts: string,
  storage: Pick<Storage, "getItem" | "setItem"> | null = browserStorage(),
  fetcher: typeof fetch = fetch,
) {
  const slot = `ganso:jev-control:${accounts}`;
  let busy = false,
    intent: Intent | null = null;
  try {
    const saved = JSON.parse(storage?.getItem(slot) ?? "null") as Intent | null;
    if (
      saved &&
      typeof saved.body === "string" &&
      typeof saved.key === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(saved.key)
    )
      intent = saved;
  } catch {
    /* Storage unavailable: in-page retries still preserve intent. */
  }
  return {
    get busy() {
      return busy;
    },
    async command(token: string, command: Command, unauthorized: () => void) {
      if (busy) return null;
      busy = true;
      try {
        const body = JSON.stringify(command);
        if (intent?.body !== body) intent = { body, key: createTicketKey() };
        try {
          storage?.setItem(slot, JSON.stringify(intent));
        } catch {
          /* No credentials or authoritative state in browser storage. */
        }
        const r = await fetcher("/api/trading/jev/control", {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "x-csrf-token": readCsrfCookie() ?? "",
            "idempotency-key": intent!.key,
          },
          body,
          cache: "no-store",
          signal: AbortSignal.timeout(5000),
        });
        if (r.status === 401) unauthorized();
        if (!r.ok)
          throw new Error(
            "Pedido não confirmado. Repetir preserva a mesma chave; consulte também o estado da conta.",
          );
        const result = (await r.json()) as { status: string };
        if (!["accepted", "duplicate"].includes(result.status))
          throw new Error("Pedido não confirmado. Consulte o estado da conta.");
        return result;
      } catch {
        throw new Error(
          "Pedido não confirmado. Repetir preserva a mesma chave; consulte também o estado da conta.",
        );
      } finally {
        busy = false;
      }
    },
  };
}
