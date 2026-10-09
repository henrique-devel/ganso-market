import { readCsrfCookie } from "./auth.js";
import { displayRaw } from "./btc-ticket.js";
import { useRef, useState } from "react";
import type { JevLivePanel } from "@ganso-market/contracts/trading";
type Props = {
  value: JevLivePanel;
  accessToken: string;
  onUnauthorized: () => void;
  refresh: () => void;
};
const usd = (raw: string | null) =>
  raw === null ? "Não confirmado" : `US$ ${displayRaw(raw)}`;
const reasons: Record<string, string> = {
  initial_capital_mismatch:
    "O patrimônio real precisa ser US$250 para a ativação inicial.",
  engine_not_qualified: "Motor ainda não qualificado por sete dias observados.",
  live_identity_missing: "Conta live ainda não vinculada.",
  pilot_supervisor_not_ready: "Patrimônio e supervisor ainda não confirmados.",
  global_drawdown_blocked:
    "Drawdown global bloqueado; exige nova decisão do operador.",
  daily_or_global_risk_paused: "Limite diário ou global impede novas entradas.",
  venue_not_verified: "Ensaio da venue ainda não validado.",
  live_reconciliation_pending: "Reconciliação da conta real pendente.",
  pilot_observation_pending: "Observação do patrimônio ainda pendente.",
  profile_not_currently_eligible:
    "Nenhum perfil com elegibilidade financeira atual.",
  flat_reconciliation_required:
    "Ordens, posição ou reservas ainda aguardam encerramento e reconciliação.",
};
export function JevLive(props: Props) {
  const [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const lock = useRef(false),
    intent = useRef<{
      key: string;
      body: unknown;
      action: "activate" | "rearm";
    } | null>(null);
  const rearming = props.value.activated && props.value.global_blocked;
  const available = rearming ? props.value.can_rearm : props.value.can_activate;
  async function activate() {
    if (lock.current || (!intent.current && (!confirmed || !available))) return;
    lock.current = true;
    setBusy(true);
    intent.current ??= {
      key: crypto.randomUUID(),
      action: rearming ? "rearm" : "activate",
      body: rearming
        ? {
            version: "jev.live-rearm.v1",
            confirmed_high_water_usd6: props.value.high_water_usd6,
            identity_hash: props.value.identity_hash,
            expected_pilot_sequence: props.value.pilot_sequence,
          }
        : {
            version: "jev.live-activation.v1",
            confirmed_capital_usd6: "250000000",
            identity_hash: props.value.identity_hash,
            expected_pilot_sequence: props.value.pilot_sequence,
          },
    };
    const c = new AbortController(),
      timer = setTimeout(() => c.abort(), 10000);
    try {
      const r = await fetch(`/api/trading/jev/${intent.current.action}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${props.accessToken}`,
          "Content-Type": "application/json",
          "x-csrf-token": readCsrfCookie() ?? "",
          "Idempotency-Key": intent.current.key,
        },
        body: JSON.stringify(intent.current.body),
        signal: c.signal,
      });
      if (r.status === 401) props.onUnauthorized();
      if (r.status === 409) {
        intent.current = null;
        setConfirmed(false);
        setMessage(
          "Os gates ou o patrimônio mudaram. Atualize os dados e confirme novamente.",
        );
        props.refresh();
        return;
      }
      if (!r.ok) throw new Error("pending");
      const rearmed = intent.current.action === "rearm";
      intent.current = null;
      setConfirmed(false);
      setMessage(
        rearmed
          ? "Rearmamento global registrado. Pico patrimonial e limite diário preservados."
          : "Ativação registrada. Entradas continuam sujeitas aos gates atuais e à reconciliação.",
      );
      props.refresh();
    } catch {
      setMessage(
        "Confirmação não recebida. Repita para consultar a mesma ativação.",
      );
    } finally {
      clearTimeout(timer);
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="btc-desk jev-account" aria-label="Piloto live">
      <h2>Piloto live — patrimônio real</h2>
      <p>
        Capital total: US$250 · Patrimônio confirmado:{" "}
        {usd(props.value.equity_usd6)} · Pico preservado:{" "}
        {usd(props.value.high_water_usd6)}
      </p>
      <p>
        Risco por entrada: 1% · Exposição máxima: 50% · Perda diária: 2% ·
        Drawdown global fixo: US$12,50 · Margem isolada 1×.
      </p>
      <p>
        {props.value.activated
          ? "Ativação do operador registrada."
          : "Ativação inicial ainda não registrada."}{" "}
        {props.value.promotion?.state === "draining"
          ? "Perfil reprovado; encerramento e reconciliação em andamento."
          : props.value.promotion?.state === "waiting"
            ? "Perfil encerrado; aguardando reserva elegível."
            : ""}
      </p>
      {props.value.promotion && (
        <p>
          Perfil live: {props.value.promotion.profile_id} · Versão{" "}
          {props.value.promotion.profile_version}
        </p>
      )}
      {props.value.reasons.length > 0 && (
        <ul>
          {props.value.reasons.map((r) => (
            <li key={r}>{reasons[r] ?? "Gate operacional pendente."}</li>
          ))}
        </ul>
      )}
      {(!props.value.activated || rearming) && (
        <>
          <label>
            <input
              type="checkbox"
              checked={confirmed}
              disabled={!available || busy}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            {rearming
              ? `Confirmo nova decisão de rearmar o bloqueio global, preservando o pico de ${usd(props.value.high_water_usd6)} e os limites acima.`
              : "Confirmo o patrimônio real de US$250 e os limites acima."}
          </label>
          <button
            disabled={busy || (!intent.current && (!confirmed || !available))}
            onClick={() => void activate()}
          >
            {busy
              ? "Registrando…"
              : intent.current
                ? "Repetir confirmação"
                : rearming
                  ? "Rearmar bloqueio global"
                  : "Ativar piloto live"}
          </button>
        </>
      )}
      {intent.current && props.value.activated && !rearming && (
        <button disabled={busy} onClick={() => void activate()}>
          Consultar confirmação pendente
        </button>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
