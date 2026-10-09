import { useEffect, useState } from "react";
import type {
  JevPanelAccount,
  JevPanelSnapshot,
} from "@ganso-market/contracts/trading";
import { displayRaw, createTicketKey } from "./btc-ticket.js";
import "./jev-panel.css";
import { useRef } from "react";
import { readCsrfCookie } from "./auth.js";
type Access = { accessToken: string; onUnauthorized: () => void };
const usd = (v: string | null | undefined) =>
  v == null ? "Indisponível" : `US$ ${displayRaw(v)}`;
const evaluation: Record<string, string> = {
  validating: "Em validação",
  eligible: "Elegível",
  inconclusive: "Inconclusivo",
  failed: "Reprovado",
};
export function JevAccountCard({ account: a }: { account: JevPanelAccount }) {
  // Keep historical ledger components visible while current results/quotes are unavailable.
  const m =
    a.metrics && a.metrics.quality !== "fresh"
      ? {
          ...a.metrics,
          trading: { ...a.metrics.trading, open_usd6: null, pnl_usd6: null },
          risk_equity_usd6: null,
          strategy_after_jev_usd6: null,
          conservative_result_usd6: null,
        }
      : a.metrics;
  const components: [string, string | null | undefined][] = [
    ["Realizado", m?.trading.realized_usd6],
    ["Aberto", m?.trading.open_usd6],
    ["Taxas", m ? (-BigInt(m.trading.fees_usd6)).toString() : null],
    ["Funding", m?.trading.funding_usd6],
    [
      "JEV atribuído",
      m?.attributed_jev_usd6 == null
        ? null
        : (-BigInt(m.attributed_jev_usd6)).toString(),
    ],
  ];
  const known = components.every(([, v]) => v != null);
  const max = Math.max(
    1,
    ...components.map(([, v]) => (v == null ? 0 : Math.abs(Number(v)))),
  );
  return (
    <article className="jev-account">
      <div className="jev-heading">
        <h3>
          {a.profile_id} ·{" "}
          {a.mode === "stress"
            ? "Stress"
            : a.mode === "paper"
              ? "Paper"
              : "Live"}
        </h3>
        <span className="btc-badge">
          {a.mode === "live" ? "REAL · INDISPONÍVEL" : "SALDO FICTÍCIO"}
        </span>
      </div>
      <p>
        {a.admitted ? "Admitida" : "Sem admissão"} ·{" "}
        {a.entries_paused ? "Entradas pausadas" : "Entradas liberadas"} ·{" "}
        {a.evaluation
          ? (evaluation[a.evaluation.state] ?? a.evaluation.state)
          : "Avaliação não iniciada"}
      </p>
      {a.intervention && (
        <p role="status">
          Intervenção {a.intervention.action} registrada em{" "}
          {a.intervention.recorded_at}:{" "}
          {a.intervention.status === "reconciled_flat"
            ? "flat reconciliado"
            : "pendente de reconciliação"}
          . A intervenção torna a avaliação econômica inconclusiva, preservando
          falhas comprovadas.
        </p>
      )}
      <div className="jev-numbers">
        <p>
          Resultado após JEV<strong>{usd(m?.strategy_after_jev_usd6)}</strong>
        </p>
        <p>
          Resultado conservador
          <strong>{usd(m?.conservative_result_usd6)}</strong>
        </p>
        <p>
          Equity de risco<strong>{usd(m?.risk_equity_usd6)}</strong>
        </p>
      </div>
      <p>
        {m?.quality === "fresh"
          ? "Preço atual observado"
          : `Preço: ${m?.quality ?? "sem dados"}`}{" "}
        ·{" "}
        {m?.trading.funding_complete
          ? "Funding completo"
          : "Funding incompleto ou ausente"}
      </p>
      <table>
        <caption>Componentes do mesmo resultado</caption>
        <tbody>
          {components.map(([name, v]) => (
            <tr key={name}>
              <th scope="row">{name}</th>
              <td>{usd(v)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {known && m?.strategy_after_jev_usd6 != null ? (
        <div className="jev-chart-wrap">
          <svg
            className="jev-chart"
            viewBox="0 0 600 150"
            role="img"
            aria-label="Componentes do resultado após JEV, sem somar contas"
          >
            {components.map(([name, v], i) => (
              <g key={name}>
                <text x="0" y={i * 28 + 20}>
                  {name}
                </text>
                <rect
                  x="170"
                  y={i * 28 + 5}
                  width={(Math.abs(Number(v)) / max) * 175}
                  height="17"
                  fill={BigInt(v!) < 0n ? "#ef9c9c" : "#7ed6a5"}
                />
                <text x="355" y={i * 28 + 20}>
                  {usd(v)}
                </text>
              </g>
            ))}
          </svg>
        </div>
      ) : (
        <p>Gráfico indisponível enquanto houver componentes incompletos.</p>
      )}
      <details>
        <summary>Decisões automáticas e proteção</summary>
        <p>
          Proteção:{" "}
          {a.execution?.protection
            ? `simulada em paper/stress, ${displayRaw(a.execution.protection.quantity_btc_raw, 8)} BTC · stop ${usd(a.execution.protection.stop_price_raw)}`
            : "sem confirmação disponível"}
          .
        </p>
        <p>
          Ordem {a.execution?.maker?.order_id ?? "indisponível"}:{" "}
          {a.execution?.maker?.status ?? "sem recibo"} · preenchido{" "}
          {displayRaw(a.execution?.maker?.filled_btc_raw, 8)} /{" "}
          {displayRaw(a.execution?.maker?.planned_btc_raw, 8)} BTC. ACK não
          comprova fill.
        </p>
        <p>
          Saída:{" "}
          {a.execution?.close?.pending
            ? "pendente de fills e reconciliação"
            : "sem redução pendente confirmada"}
          . Solicitação não comprova encerramento.
        </p>
        <p>
          Última observação de execução:{" "}
          {a.execution?.observed_at ?? "indisponível"}. {a.execution?.reason}
        </p>
        {!!a.fills?.length ? (
          <div className="jev-chart-wrap">
            <table>
              <caption>
                Últimos fills observados · simulação paper/stress
              </caption>
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
                {a.fills.map((f) => (
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
          </div>
        ) : (
          <p>
            Sem fills observados para esta conta; ACK não cria recibo de
            execução.
          </p>
        )}
        {!a.decisions?.length && (
          <p>Sem decisões JEV capturadas para esta conta.</p>
        )}
        {a.decisions?.map((d) => (
          <details key={d.request_id}>
            <summary>
              {d.started_at} · {d.intent?.choice ?? d.reason} ·{" "}
              {d.direction?.choice ?? "direção indisponível"}
            </summary>
            <p>
              Modelo {d.model} · latência{" "}
              {d.latency_ms == null ? "indisponível" : `${d.latency_ms} ms`} ·
              custo atribuído {usd(d.attributed_cost_usd6)}.
            </p>
            <p>
              Motivo: {d.reason}. Contexto {d.context_id} · perguntas{" "}
              {d.questions_version} · request {d.request_id}.
            </p>
            {[
              ["Direção", d.direction],
              ["Intenção", d.intent],
            ].map(([name, c]) => {
              const choice = c as typeof d.direction;
              return (
                <p key={String(name)}>
                  {String(name)} · confiança{" "}
                  {choice
                    ? `${(choice.confidence * 100).toFixed(1)}%`
                    : "indisponível"}{" "}
                  ·{" "}
                  {choice
                    ? Object.entries(choice.probabilities)
                        .map(([k, v]) => `${k}: ${(v * 100).toFixed(1)}%`)
                        .join(" · ")
                    : "probabilidades indisponíveis"}
                </p>
              );
            })}
          </details>
        ))}
      </details>
      <details>
        <summary>Posições, limites e versão</summary>
        <p>
          Conta {a.account_id} · versão {a.profile_version} · horizonte{" "}
          {a.horizon_minutes} min.
        </p>
        <p>
          Capital de referência: {usd(m?.capital_usd6)}. Equity de risco inclui
          negociação, taxas e funding; JEV e infraestrutura ficam fora dos
          limites.
        </p>
        <p>
          Risco por entrada 1% · exposição 50% · perda diária 2% da equity
          inicial UTC · drawdown fixo US$ 12,50.
        </p>
        <p>
          Âncora diária: {usd(a.risk?.daily_anchor_usd_raw)} · pico:{" "}
          {usd(a.risk?.high_water_usd_raw)} · piso global:{" "}
          {usd(a.risk?.drawdown_floor_usd_raw)}.
        </p>
        <p>
          {a.risk?.daily_pause_day
            ? "Limite diário atingido"
            : "Bloqueio diário: " +
              (a.risk ? "não registrado" : "indisponível")}{" "}
          ·{" "}
          {a.risk?.drawdown_blocked
            ? "Drawdown bloqueado"
            : "Drawdown: " + (a.risk ? "não bloqueado" : "indisponível")}
          .
        </p>
        <p>
          {a.risk?.reasons.join(" · ") ||
            "Diagnóstico de risco sem motivos disponíveis"}
          . Última observação: {a.risk?.observed_at ?? "indisponível"}.
        </p>
        {m?.positions.map((p) => (
          <p key={p.position_id}>
            {p.position_id} ·{" "}
            {BigInt(p.quantity_btc_raw) > 0n
              ? "Long"
              : BigInt(p.quantity_btc_raw) < 0n
                ? "Short"
                : "Flat financeiro"}{" "}
            · {displayRaw(p.quantity_btc_raw, 8)} BTC
          </p>
        ))}
        <p>
          Manifesto: <code>{a.manifest_hash}</code>.{" "}
          {a.evaluation &&
            `Avaliação capturada em ${a.evaluation.as_of}; evidência ${a.evaluation.evidence_id}.`}
        </p>
      </details>
    </article>
  );
}
export function JevPanelView({ value }: { value: JevPanelSnapshot }) {
  return (
    <section className="btc-desk jev-panel">
      <h2>Painel JEV</h2>
      <p>
        Corte: {value.as_of}. Paper e stress são contas independentes; os saldos
        e custos atribuídos não se somam.
      </p>
      <p>
        Live indisponível. A publicação do painel não admite contas nem ativa o
        piloto.
      </p>
      {!value.accounts.length && (
        <p>
          Nenhum perfil JEV registrado. Resultados e limites ainda
          indisponíveis.
        </p>
      )}
      {value.platform && (
        <section className="jev-account">
          <h3>Custos da plataforma · {value.platform.month}</h3>
          <p>
            JEV conhecido: {usd(value.platform.known_jev_usd6)} ·{" "}
            {value.platform.captured_requests} requests capturados ·{" "}
            {value.platform.unknown_requests} custos desconhecidos.
          </p>
          <p>
            JEV capturado: {usd(value.platform.captured_jev_usd6)} ·
            Infraestrutura manual: {usd(value.platform.infrastructure_usd6)} ·
            Total capturado: {usd(value.platform.captured_total_usd6)}.
          </p>
          <p>
            Resumo dos requests principais capturados, não uma fatura completa.
            Cada request entra uma única vez; a atribuição integral das contas
            não se soma. Infraestrutura fica fora do PnL, aprovação e risco.
          </p>
        </section>
      )}
      {value.readiness && (
        <section className="jev-account">
          <h3>Prontidão técnica e qualificação</h3>
          <p>
            Motor:{" "}
            {value.readiness.status === "technical_ready"
              ? "condições técnicas atuais válidas"
              : "não pronto"}{" "}
            · qualificação:{" "}
            {value.readiness.qualification.qualified
              ? "sete dias comprovados"
              : "sete dias ainda não comprovados"}
            .
          </p>
          <p>
            {value.readiness.reasons.join(" · ") ||
              "Sem veto técnico nesta leitura"}
            . Última observação: {value.readiness.observed_at ?? "indisponível"}
            .
          </p>
          <p>
            Janela válida:{" "}
            {value.readiness.qualification.start_at ?? "não iniciada"} até{" "}
            {value.readiness.qualification.end_at ?? "indisponível"} ·{" "}
            {value.readiness.qualification.status}. Mudança material ou gap
            financeiro exige janela válida; interrupções e evidências anteriores
            permanecem registradas.
          </p>
          <details>
            <summary>Versão, recursos e evidência</summary>
            <p>
              {value.readiness.engine_version} · release{" "}
              {value.readiness.code_sha ?? "indisponível"} · evidência{" "}
              {value.readiness.qualification.evidence_id ?? "ausente"}.
            </p>
            <p>
              RAM do worker:{" "}
              {value.readiness.resources
                ? (value.readiness.resources.rss_bytes / 1048576).toFixed(1) +
                  " MiB"
                : "indisponível"}
              . CPU acumulada do processo:{" "}
              {value.readiness.resources
                ? (
                    (value.readiness.resources.cpu_user_us +
                      value.readiness.resources.cpu_system_us) /
                    1000000
                  ).toFixed(1) + " s"
                : "indisponível"}
              . Esses números não representam carga ou memória do host; a
              admissão exige a prova sustentada de recursos e uso tarifado.
            </p>
            <p>
              Caminhos observados:{" "}
              {value.readiness.qualification.exercised
                ? Object.entries(value.readiness.qualification.exercised)
                    .map(([k, v]) => `${k}: ${v ? "comprovado" : "pendente"}`)
                    .join(" · ")
                : "indisponíveis"}
              .
            </p>
          </details>
        </section>
      )}
      <div className="jev-accounts">
        {value.accounts.map((a) => (
          <JevAccountCard key={a.account_id} account={a} />
        ))}
      </div>
    </section>
  );
}
export function JevPanel(props: Access) {
  const [refresh, setRefresh] = useState(0),
    [state, setState] = useState<{
      value?: JevPanelSnapshot;
      error?: string;
    } | null>(null);
  useEffect(() => {
    let alive = true;
    setState(null);
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 5000);
    void fetch("/api/trading/jev/panel", {
      headers: { authorization: `Bearer ${props.accessToken}` },
      cache: "no-store",
      signal: c.signal,
    })
      .then(async (r) => {
        if (r.status === 401) props.onUnauthorized();
        if (!r.ok) throw new Error("Dados JEV indisponíveis nesta tentativa.");
        const value = (await r.json()) as JevPanelSnapshot;
        if (alive) setState({ value });
      })
      .catch(() => {
        if (alive)
          setState({ error: "Dados JEV indisponíveis nesta tentativa." });
      })
      .finally(() => clearTimeout(t));
    return () => {
      alive = false;
      c.abort();
      clearTimeout(t);
    };
  }, [props.accessToken, props.onUnauthorized, refresh]);
  return (
    <>
      <button onClick={() => setRefresh((x) => x + 1)}>
        Atualizar painel JEV
      </button>
      {!state && <p role="status">Lendo perfis JEV…</p>}
      {state?.error && <p role="alert">{state.error}</p>}
      {state?.value && (
        <>
          <JevPanelView value={state.value} />
          <JevControls
            {...props}
            value={state.value}
            refresh={() => setRefresh((x) => x + 1)}
          />
          <InfrastructureForm
            {...props}
            refresh={() => setRefresh((x) => x + 1)}
          />
        </>
      )}
    </>
  );
}

export function infrastructureRaw(value: string) {
  if (!/^(0|[1-9][0-9]{0,11})([.,][0-9]{1,6})?$/.test(value))
    throw new Error("Informe um valor em US$ com até seis casas decimais.");
  const [whole, decimal = ""] = value.replace(",", ".").split(".");
  return (
    BigInt(whole!) * 1000000n +
    BigInt(decimal.padEnd(6, "0"))
  ).toString();
}
function InfrastructureForm(props: Access & { refresh: () => void }) {
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7)),
    [amount, setAmount] = useState(""),
    [pending, setPending] = useState(false),
    [message, setMessage] = useState("");
  const attempt = useRef<{ body: string; key: string } | null>(null);
  return (
    <details className="btc-desk">
      <summary>Registrar custo mensal de infraestrutura</summary>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void (async () => {
            setPending(true);
            try {
              const body = JSON.stringify({
                month,
                usd6: infrastructureRaw(amount),
              });
              if (attempt.current?.body !== body)
                attempt.current = { body, key: createTicketKey() };
              const response = await fetch("/api/trading/jev/infrastructure", {
                method: "POST",
                headers: {
                  authorization: `Bearer ${props.accessToken}`,
                  "content-type": "application/json",
                  "x-csrf-token": readCsrfCookie() ?? "",
                  "idempotency-key": attempt.current!.key,
                },
                body,
                cache: "no-store",
                signal: AbortSignal.timeout(5000),
              });
              if (response.status === 401) props.onUnauthorized();
              if (!response.ok)
                throw new Error(
                  "Gravação não confirmada. Repetir preserva a mesma chave.",
                );
              setMessage(
                "Custo registrado. A avaliação da estratégia permanece independente.",
              );
              props.refresh();
            } catch (e) {
              setMessage(
                e instanceof Error ? e.message : "Gravação não confirmada.",
              );
            } finally {
              setPending(false);
            }
          })();
        }}
      >
        <label>
          Mês UTC
          <input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            disabled={pending}
          />
        </label>
        <label>
          Total mensal em US$
          <input
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            disabled={pending}
          />
        </label>
        <button disabled={pending || !amount}>
          {pending ? "Registrando…" : "Registrar infraestrutura"}
        </button>
        <p role="status">{message}</p>
        <p>
          Uma nova informação substitui o total exibido desse mês e preserva o
          histórico. Não modifica orçamento nem resultado da estratégia.
        </p>
      </form>
    </details>
  );
}

function JevControls(
  props: Access & { value: JevPanelSnapshot; refresh: () => void },
) {
  const [account, setAccount] = useState("all"),
    [pending, setPending] = useState(false),
    [message, setMessage] = useState("");
  const attempt = useRef<{ body: string; key: string } | null>(null),
    accounts = props.value.accounts.filter(
      (a) => a.admitted && a.mode !== "live",
    );
  async function command(action: "pause" | "emergency") {
    setPending(true);
    try {
      const body = JSON.stringify({ action, account_id: account });
      if (attempt.current?.body !== body)
        attempt.current = { body, key: createTicketKey() };
      const response = await fetch("/api/trading/jev/control", {
        method: "POST",
        headers: {
          authorization: `Bearer ${props.accessToken}`,
          "content-type": "application/json",
          "x-csrf-token": readCsrfCookie() ?? "",
          "idempotency-key": attempt.current!.key,
        },
        body,
        cache: "no-store",
        signal: AbortSignal.timeout(5000),
      });
      if (response.status === 401) props.onUnauthorized();
      if (!response.ok)
        throw new Error(
          "Comando não confirmado. Repetir preserva a mesma chave.",
        );
      setMessage(
        "Intervenção registrada; cancelamento e redução dependem do supervisor, fills e reconciliação.",
      );
      props.refresh();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Comando não confirmado.");
    } finally {
      setPending(false);
    }
  }
  return (
    <section className="btc-desk jev-account">
      <h3>Pausa e emergência</h3>
      <label>
        Contas admitidas
        <select
          value={account}
          disabled={pending || !accounts.length}
          onChange={(e) => setAccount(e.target.value)}
        >
          <option value="all">Todas as contas paper/stress admitidas</option>
          {accounts.map((a) => (
            <option key={a.account_id} value={a.account_id}>
              {a.account_id}
            </option>
          ))}
        </select>
      </label>
      <p>
        Pausa cancela novas entradas e mantém a proteção. Emergência também
        solicita redução da posição. As ações são registradas e tornam a
        avaliação econômica inconclusiva; falhas comprovadas permanecem.
      </p>
      <button
        disabled={pending || !accounts.length}
        onClick={() => void command("pause")}
      >
        Pausar entradas
      </button>
      <button
        disabled={pending || !accounts.length}
        onClick={() => void command("emergency")}
      >
        Emergência: cancelar e reduzir
      </button>
      <p role="status">
        {message ||
          (!accounts.length
            ? "Sem contas admitidas para intervenção."
            : "A confirmação do pedido não comprova cancelamento nem posição encerrada.")}
      </p>
    </section>
  );
}
