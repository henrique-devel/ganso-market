import type { JevPanelAccount } from "@ganso-market/contracts/trading";
import { displayRaw } from "./btc-ticket.js";
const usd = (v: string | null | undefined) =>
  v == null ? "Indisponível" : `US$ ${displayRaw(v)}`;
const states: Record<string, string> = {
  confirmed: "Proteção nativa confirmada",
  pending: "Proteção pendente; ainda sem confirmação nativa",
  flat: "Posição zero observada",
  unavailable: "Proteção indisponível",
  acknowledged: "Recebida pela venue",
  uncertain: "Confirmação incerta",
  filled: "Execução confirmada",
  cancelled: "Cancelamento confirmado",
  rejected: "Recusada",
  open: "Aberta",
  triggered: "Disparada",
  no_receipt: "Sem recibo",
};
const operations: Record<string, string> = {
  entry: "Entrada",
  close: "Redução",
  stop: "Stop nativo",
  cancel: "Cancelamento",
};
export const liveReasons: Record<string, string> = {
  LIVE_SOURCE_MISSING: "Sem observação da conta real.",
  LIVE_SOURCE_STALE: "Observação da venue vencida.",
  LIVE_HISTORY_GAP: "Histórico da venue incompleto.",
  LIVE_RECONCILIATION_GAP:
    "Reconciliação interrompida; aguardando uma nova observação válida.",
  LIVE_BALANCE_UNRECONCILED:
    "Saldo ainda sem reconciliação com fills e funding.",
  LIVE_JEV_COST_UNKNOWN:
    "Custo JEV ainda não confirmado; resultado após JEV indisponível.",
  LIVE_ACCOUNT_MODE_UNCONFIRMED: "Margem isolada 1x sem confirmação atual.",
};
export function JevLiveAccountState({
  account: a,
  onHistory,
}: {
  account: JevPanelAccount;
  onHistory?: ((cursor: string) => void) | undefined;
}) {
  const v = a.live_state;
  if (!v) return <p>Estado da execução real indisponível.</p>;
  return (
    <>
      <p>
        Fonte: Hyperliquid · Última observação:{" "}
        {v.source_as_of ?? "Indisponível"}. Posição efetiva:{" "}
        {v.position_btc_raw == null
          ? "Indisponível"
          : `${displayRaw(v.position_btc_raw, 8)} BTC`}
        .
      </p>
      <p>
        {states[v.protection.state]} · quantidade protegida:{" "}
        {v.protection.quantity_btc_raw == null
          ? "Indisponível"
          : `${displayRaw(v.protection.quantity_btc_raw, 8)} BTC`}{" "}
        · stop: {usd(v.protection.stop_price_usd6)} · prazo máximo:{" "}
        {v.protection.maximum_exit_at ?? "Indisponível"}. Última confirmação:{" "}
        {v.protection.observed_at ?? "Indisponível"}.
      </p>
      <p>
        Executor:{" "}
        {v.runtime?.current && v.runtime.connected
          ? "conectado e observado"
          : "confirmação atual indisponível"}{" "}
        · novas entradas:{" "}
        {v.runtime?.entries_ready ? "sujeitas aos gates atuais" : "bloqueadas"}.
        Última observação: {v.runtime?.observed_at ?? "Indisponível"}.
      </p>
      <table>
        <caption>
          Ordens observadas na venue ·{" "}
          {a.metrics?.quality === "fresh"
            ? "fonte atual"
            : "histórico; estado atual indisponível"}
        </caption>
        <thead>
          <tr>
            <th>Ordem</th>
            <th>Finalidade</th>
            <th>Quantidade BTC</th>
            <th>Preço limite</th>
          </tr>
        </thead>
        <tbody>
          {v.orders.map((o) => (
            <tr key={o.order_id}>
              <td>{o.order_id}</td>
              <td>
                {o.position_stop
                  ? "Stop nativo"
                  : o.reduce_only
                    ? "Redução"
                    : "Entrada"}{" "}
                · {o.side === "buy" ? "Compra" : "Venda"}
              </td>
              <td>{displayRaw(o.quantity_btc_raw, 8)}</td>
              <td>{usd(o.limit_price_usd6)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!v.orders.length && (
        <p>
          {a.metrics?.quality === "fresh"
            ? "Nenhuma ordem aberta na observação da venue."
            : "Ordens atuais indisponíveis."}
        </p>
      )}
      {v.orders_truncated && (
        <p>Exibindo as primeiras 20 ordens da observação.</p>
      )}
      <table>
        <caption>
          Últimos recibos live · ACK não comprova fill ou encerramento
        </caption>
        <thead>
          <tr>
            <th>Operação / perfil</th>
            <th>Estado</th>
            <th>Preenchido BTC</th>
            <th>Observação</th>
          </tr>
        </thead>
        <tbody>
          {v.receipts.map((r) => (
            <tr key={r.operation_id}>
              <td>
                {operations[r.kind] ?? "Operação"} ·{" "}
                {r.order_id ?? r.operation_id}
                <br />
                {r.profile_id} · {r.profile_version}
              </td>
              <td>{states[r.state] ?? r.state}</td>
              <td>
                {displayRaw(r.filled_btc_raw, 8)}
                {r.planned_btc_raw !== null
                  ? ` / ${displayRaw(r.planned_btc_raw, 8)}`
                  : ""}
              </td>
              <td>{r.observed_at ?? "Indisponível"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <table>
        <caption>Últimos fills reais reconciliados</caption>
        <thead>
          <tr>
            <th>Ordem / horário</th>
            <th>Execução</th>
            <th>Quantidade BTC</th>
            <th>Preço</th>
            <th>Taxa</th>
          </tr>
        </thead>
        <tbody>
          {a.fills?.map((f) => (
            <tr key={f.execution_id}>
              <td>
                {f.order_id}
                <br />
                {f.occurred_at}
              </td>
              <td>
                {f.kind} · {f.side === "buy" ? "Compra" : "Venda"}
              </td>
              <td>{displayRaw(f.quantity_btc_raw, 8)}</td>
              <td>{usd(f.price_usd_raw)}</td>
              <td>{usd(f.fee_usd_raw)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <details>
        <summary>Funding observado</summary>
        {v.funding.map((f) => (
          <p key={f.key}>
            {f.occurred_at} · {usd(f.amount_usd6)}
          </p>
        ))}
        {!v.funding.length && <p>Sem eventos de funding nesse histórico.</p>}
      </details>
      <details open>
        <summary>Histórico por perfil e versão</summary>
        <p>
          O acumulado da conta mantém todo o histórico. Estes recortes mostram
          realizado, taxas e funding após JEV, sem incluir PnL aberto positivo
          nem criar novo capital. Elegibilidade continua baseada em paper e
          stress.
        </p>
        <table>
          <thead>
            <tr>
              <th>Perfil / período</th>
              <th>Realizado</th>
              <th>Taxas</th>
              <th>Funding</th>
              <th>JEV atribuído</th>
              <th>Realizado após JEV</th>
            </tr>
          </thead>
          <tbody>
            {v.history.map((h) => (
              <tr key={h.experiment_id}>
                <td>
                  {h.profile_id} · {h.profile_version}
                  <br />
                  {h.start_at} → {h.end_at ?? "em andamento"}
                </td>
                <td>{usd(h.realized_usd6)}</td>
                <td>{usd(h.fees_usd6)}</td>
                <td>{usd(h.funding_usd6)}</td>
                <td>{usd(h.attributed_jev_usd6)}</td>
                <td>{usd(h.realized_after_jev_usd6)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {v.history_next_cursor && onHistory && (
          <button onClick={() => onHistory(v.history_next_cursor!)}>
            Ver perfis anteriores
          </button>
        )}
      </details>
    </>
  );
}
