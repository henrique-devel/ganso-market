import type {
  DeskCommand,
  DeskCommandPreview,
  DeskCommandReceipt,
} from "@ganso-market/contracts/trading";
import { readCsrfCookie } from "./auth.js";
export function decimalRaw(value: string, decimals: number): string {
  if (!/^\d+(?:[.,]\d+)?$/.test(value.trim()))
    throw new Error("Informe um número positivo, sem separador de milhar.");
  const [whole, fraction = ""] = value.trim().replace(",", ".").split(".");
  if (fraction.length > decimals)
    throw new Error(`Use no máximo ${decimals} casas decimais.`);
  const n =
    BigInt(whole!) * 10n ** BigInt(decimals) +
    BigInt(fraction.padEnd(decimals, "0"));
  if (n <= 0n) throw new Error("O valor deve ser maior que zero.");
  return n.toString();
}
export function displayRaw(
  raw: string | null | undefined,
  decimals = 6,
): string {
  if (raw == null) return "indisponível";
  const n = BigInt(raw),
    a = n < 0n ? -n : n,
    scale = 10n ** BigInt(decimals);
  return `${n < 0n ? "−" : ""}${(a / scale).toLocaleString("pt-BR")},${(a % scale).toString().padStart(decimals, "0").replace(/0+$/, "") || "00"}`;
}
export function inputRaw(raw: string, decimals = 6): string {
  const n = BigInt(raw),
    s = 10n ** BigInt(decimals);
  return `${n / s}.${(n % s).toString().padStart(decimals, "0")}`;
}
export function quantityFromNotional(
  usd: string,
  price: string,
  step: string,
): string {
  const s = BigInt(step),
    q = ((BigInt(usd) * 100000000n) / BigInt(price) / s) * s;
  if (q <= 0n) throw new Error("O nocional está abaixo da quantidade mínima.");
  return q.toString();
}
export class TicketError extends Error {
  constructor(
    readonly code: string,
    readonly ambiguous: boolean,
  ) {
    super(code);
  }
}
export async function deskPost<T>(
  token: string,
  action: string,
  body: unknown,
  key: string,
  fetcher = fetch,
): Promise<T> {
  let response: Response;
  try {
    response = await fetcher(`/api/trading/${action}`, {
      method: "POST",
      credentials: "include",
      signal: AbortSignal.timeout(10000),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "x-csrf-token": readCsrfCookie() ?? "",
        "idempotency-key": key,
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new TicketError("CONEXAO_INDETERMINADA", true);
  }
  const value = await response.json().catch(() => null);
  if (!response.ok)
    throw new TicketError(
      value?.reason_code ?? `HTTP_${response.status}`,
      response.status >= 500,
    );
  if (!value) throw new TicketError("RESPOSTA_INDETERMINADA", true);
  return value as T;
}
export type PendingTicket = {
  key: string;
  command: DeskCommand;
  attempted: boolean;
  ambiguous?: boolean;
};
export async function previewTicket(token: string, pending: PendingTicket) {
  return deskPost<DeskCommandPreview>(
    token,
    "preview",
    pending.command,
    pending.key,
  );
}
export async function sendTicket(
  token: string,
  pending: PendingTicket,
  preview: DeskCommandPreview,
) {
  return deskPost<DeskCommandReceipt>(
    token,
    pending.command.action,
    { intent: preview.intent },
    pending.key,
  );
}
