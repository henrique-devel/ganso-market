import { useRef, useState } from "react";
import type { JevQueueSnapshot } from "@ganso-market/contracts/trading";
import { createTicketKey, displayRaw } from "./btc-ticket.js";
import { readCsrfCookie } from "./auth.js";
export function JevQueue(props: {
  value: JevQueueSnapshot;
  accessToken: string;
  onUnauthorized: () => void;
  refresh: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const inFlight = useRef(false);
  const attempt = useRef<{ body: string; key: string } | null>(null);
  async function send(request?: unknown) {
    if (inFlight.current) return;
    if (request)
      attempt.current = {
        body: JSON.stringify(request),
        key: createTicketKey(),
      };
    if (!attempt.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const r = await fetch("/api/trading/jev/queue", {
        method: "POST",
        headers: {
          authorization: `Bearer ${props.accessToken}`,
          "content-type": "application/json",
          "x-csrf-token": readCsrfCookie() ?? "",
          "idempotency-key": attempt.current.key,
        },
        body: attempt.current.body,
        cache: "no-store",
        signal: AbortSignal.timeout(5000),
      });
      if (r.status === 401) props.onUnauthorized();
      if (r.status === 409) {
        attempt.current = null;
        props.refresh();
        setMessage(
          "A fila mudou. Confira a ordem atual antes de editar novamente.",
        );
        return;
      }
      if (!r.ok) throw new Error();
      attempt.current = null;
      setMessage("Fila atualizada. A prioridade escolhida foi preservada.");
      props.refresh();
    } catch {
      setMessage(
        "Pedido ainda não confirmado. Você pode repetir a mesma tentativa.",
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  const q = props.value,
    disabled = busy || attempt.current !== null;
  return (
    <section className="btc-desk jev-account">
      <h3>Propostas esperando vaga · {q.proposals.length}/3</h3>
      <p>
        Aptidão técnica JEV permite esperar por uma vaga. A elegibilidade
        financeira depende do novo experimento em paper e stress.
      </p>
      {!q.proposals.length && (
        <p>
          Nenhuma proposta apta esperando. Falta de orçamento, veto ou
          indisponibilidade mantém a espera.
        </p>
      )}
      <ol>
        {q.proposals.map((p, index) => (
          <li key={p.proposal_id}>
            <h4>
              Proposta {index + 1} · horizonte {p.horizon_minutes} min
            </h4>
            <p>{p.reason}</p>
            <p>
              Aptidão técnica: {p.rank === 2 ? "forte" : "adequada"} ·{" "}
              {p.origin === "mock"
                ? "simulação, sem admissão automática"
                : "julgamento JEV"}{" "}
              · custo{" "}
              {p.cost_usd6 === null
                ? "desconhecido"
                : `US$ ${displayRaw(p.cost_usd6)}`}
              . Elegibilidade financeira ainda não avaliada.
            </p>
            <button
              disabled={disabled || index === 0}
              onClick={() => {
                const ids = [...q.proposal_ids];
                [ids[index - 1], ids[index]] = [ids[index]!, ids[index - 1]!];
                void send({
                  action: "reorder",
                  revision: q.revision,
                  proposal_ids: ids,
                });
              }}
            >
              Subir prioridade
            </button>
            <button
              disabled={disabled || index === q.proposals.length - 1}
              onClick={() => {
                const ids = [...q.proposal_ids];
                [ids[index], ids[index + 1]] = [ids[index + 1]!, ids[index]!];
                void send({
                  action: "reorder",
                  revision: q.revision,
                  proposal_ids: ids,
                });
              }}
            >
              Descer prioridade
            </button>
            <button
              disabled={disabled}
              onClick={() =>
                void send({
                  action: "remove",
                  revision: q.revision,
                  proposal_id: p.proposal_id,
                })
              }
            >
              Remover proposta
            </button>
            <details>
              <summary>Versão e configuração</summary>
              <p>
                {p.profile_id} · {p.profile_version} · {p.fingerprint}
              </p>
            </details>
          </li>
        ))}
      </ol>
      {attempt.current && !busy && (
        <button onClick={() => void send()}>Repetir pedido</button>
      )}
      <p role="status">{busy ? "Registrando alteração…" : message}</p>
    </section>
  );
}
