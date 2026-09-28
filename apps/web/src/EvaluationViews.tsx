import { useState } from "react";
import { displayRaw } from "./btc-ticket.js";
import { EquityCurve } from "./Experiments.js";

const money = (v: string | null | undefined) =>
  v == null ? "Não disponível" : `US$ ${displayRaw(v)}`;
type Evaluation = {
  cost_status: string;
  cost_basis: string | null;
  input_hash: string | null;
  references: {
    kind: string;
    exposure_bps: number;
    capital_usd_raw: string;
    window: { start: string; end: string };
    net_pnl_usd_raw: string | null;
    fees_usd_raw: string | null;
    funding_usd_raw: string | null;
    source: string;
    fee_basis: string | null;
    funding_basis: string | null;
    missing: string[];
    prices: null | {
      start: { at: string; usd_raw: string; evidence_id: string };
      end: { at: string; usd_raw: string; evidence_id: string };
    };
  }[];
};
export function EvaluationSources({
  value,
}: {
  value?: Evaluation | undefined;
}) {
  if (!value) return null;
  return (
    <section className="btc-status">
      <h3>Custos e referências da mesma janela</h3>
      <p>
        {value.cost_status === "unknown"
          ? "Fatura e rateio ausentes: custo desconhecido."
          : "Rateio completo declarado pelo operador; fatura não auditada pelo sistema."}{" "}
        Reservas de IA não são faturas liquidadas. Cenários não são somados.
      </p>
      {value.cost_basis && (
        <p>Base do rateio: {value.cost_basis}. Aplicado uma vez por conta.</p>
      )}
      <p>
        Comparadores usam o capital inicial da janela selecionada. Caixa não
        rende juros; BTC é quantidade constante, sem rebalanceamento. Exposição
        e risco diferem da estratégia; diferenças não demonstram causalidade.
        Funding paper e fontes fornecidas não são auditoria da corretora. Sem
        preço, taxa ou funding, o resultado permanece desconhecido.
      </p>
      <div className="btc-table">
        <table>
          <thead>
            <tr>
              <th>Referência</th>
              <th>Janela UTC / capital</th>
              <th>Trading após taxas/funding</th>
              <th>Taxas / funding</th>
              <th>Fontes e limitações</th>
            </tr>
          </thead>
          <tbody>
            {value.references.map((r) => (
              <tr key={`${r.kind}:${r.exposure_bps}`}>
                <td>
                  {r.kind === "cash"
                    ? "Caixa"
                    : r.kind === "perpetual"
                      ? "BTC perpétuo passivo"
                      : "BTC spot (separado)"}{" "}
                  · {r.exposure_bps / 100}%
                </td>
                <td>
                  {r.window.start} → {r.window.end}
                  <br />
                  {money(r.capital_usd_raw)}
                </td>
                <td>{money(r.net_pnl_usd_raw)}</td>
                <td>
                  {money(r.fees_usd_raw)} / {money(r.funding_usd_raw)}
                </td>
                <td>
                  {r.source}
                  <br />
                  Taxa: {r.fee_basis ?? "desconhecida"}; funding:{" "}
                  {r.funding_basis ?? "desconhecido"}.
                  {r.prices && (
                    <details>
                      <summary>Preços e evidências</summary>
                      {[r.prices.start, r.prices.end].map((p, i) => (
                        <p key={i}>
                          {p.at}: {money(p.usd_raw)} · {p.evidence_id}
                        </p>
                      ))}
                    </details>
                  )}
                  {r.missing.length > 0 && (
                    <p>Dados faltantes: {r.missing.join(", ")}</p>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {value.input_hash && (
        <details>
          <summary>Versão das entradas privadas</summary>
          <code>{value.input_hash}</code>
        </details>
      )}
    </section>
  );
}
type Boundary = {
  equity_usd_raw: string | null;
  capital_usd_raw: string;
  reserved_usd_raw: string;
  unrealized_pnl_usd_raw: string | null;
  positions: { quantity_btc_raw: string }[];
};
type WindowMetric = {
  scope: {
    account_id: string;
    financial_start_at: string;
    window: { start: string; end: string };
  };
  opening: Boundary;
  closing: Boundary;
  trading: {
    net_pnl_usd_raw: string | null;
    unrealized_change_usd_raw: string | null;
    fees_usd_raw: string;
    funding_usd_raw: string;
  };
  operational_costs: {
    ai_usd_raw: string | null;
    infrastructure_usd_raw: string | null;
  };
  after_operational_costs: { net_pnl_usd_raw: string | null };
  prior_obligations_received: unknown[];
  equity_curve?: {
    points: { at: string; equity_usd_raw: string | null }[];
    status: string;
    basis: string;
  };
  drawdown?: {
    max_usd_raw: string | null;
    observed_max_usd_raw: string | null;
  };
};
export type WindowReport = {
  baseline: WindowMetric;
  challenger: WindowMetric;
  reasons?: string[];
  evaluation?: Evaluation;
  delta: {
    trading_usd_raw: string;
    after_operational_usd_raw: string | null;
  } | null;
};
export function WindowResults({ report }: { report: WindowReport }) {
  return (
    <>
      <h3>Janela comum prospectiva</h3>
      <p>
        Comparação observacional, sem contribuição causal. O início financeiro e
        obrigações anteriores foram preservados. Drawdown integral exige
        cobertura de equity nesta janela; a curva desde a gênese não o
        substitui.
      </p>
      {report.reasons?.length ? (
        <p>
          Comparação limitada: {report.reasons.join(", ")}. Sem delta para
          risco, capital ou exposição inicial diferentes.
        </p>
      ) : null}
      {[report.baseline, report.challenger].map((m) => (
        <article className="btc-status" key={m.scope.account_id}>
          <h4>{m.scope.account_id}</h4>
          <p>
            Início financeiro: {m.scope.financial_start_at}. Janela:{" "}
            {m.scope.window.start} → {m.scope.window.end}.
          </p>
          <p>
            Patrimônio inicial / final: {money(m.opening.equity_usd_raw)} /{" "}
            {money(m.closing.equity_usd_raw)}. Capital:{" "}
            {money(m.opening.capital_usd_raw)}.
          </p>
          <p>
            Posições iniciais / finais:{" "}
            {
              m.opening.positions.filter((p) => p.quantity_btc_raw !== "0")
                .length
            }{" "}
            /{" "}
            {
              m.closing.positions.filter((p) => p.quantity_btc_raw !== "0")
                .length
            }
            ; reservas: {money(m.opening.reserved_usd_raw)} /{" "}
            {money(m.closing.reserved_usd_raw)}. Reservas não são despesas.
          </p>
          <p>
            PnL aberto inicial / final:{" "}
            {money(m.opening.unrealized_pnl_usd_raw)} /{" "}
            {money(m.closing.unrealized_pnl_usd_raw)}. Resultado:{" "}
            {money(m.trading.net_pnl_usd_raw)}; taxas / funding:{" "}
            {money(m.trading.fees_usd_raw)} / {money(m.trading.funding_usd_raw)}
            .
          </p>
          <p>
            Infraestrutura: {money(m.operational_costs.infrastructure_usd_raw)};
            IA: {money(m.operational_costs.ai_usd_raw)}; após custos:{" "}
            {money(m.after_operational_costs.net_pnl_usd_raw)}. Obrigações
            anteriores recebidas: {m.prior_obligations_received.length}.
          </p>
          {m.equity_curve && (
            <EquityCurve
              metric={{ scope: m.scope, equity_curve: m.equity_curve }}
            />
          )}
          {m.drawdown && (
            <p>
              Drawdown completo: {money(m.drawdown.max_usd_raw)}; mínimo
              observado: {money(m.drawdown.observed_max_usd_raw)}. Gaps e
              extremos intrabar continuam desconhecidos.
            </p>
          )}
        </article>
      ))}
      {report.delta && (
        <p>
          Desafiante menos base: {money(report.delta.trading_usd_raw)}; após
          custos: {money(report.delta.after_operational_usd_raw)}.
        </p>
      )}
      <EvaluationSources value={report.evaluation} />
    </>
  );
}
export type PagedCoverage = {
  schema_version: "btc.paged-coverage.v1";
  dataset_id: string;
  window: { start_at: string; end_at: string };
  pages: number;
  counts: Record<string, number>;
  verified_page: { index: number; stream: string; rows: number } | null;
};
export function PagedCoverageView({
  value,
  selectPage,
}: {
  value: PagedCoverage;
  selectPage: (page: number) => void;
}) {
  const index = value.verified_page?.index ?? -1;
  return (
    <section className="btc-status">
      <h3>Cobertura paginada</h3>
      <p>
        Janela: {value.window.start_at} → {value.window.end_at}. {value.pages}{" "}
        páginas declaradas no manifesto. Manifesto verificado; métricas
        financeiras exigem replay completo fora da API. Contagens não comprovam
        continuidade, maturidade ou cobertura de mercado.
      </p>
      <p>
        {Object.entries(value.counts)
          .map(([k, n]) => `${k}: ${n}`)
          .join(" · ")}
      </p>
      {value.verified_page && (
        <p>
          Página {index + 1} verificada: {value.verified_page.stream},{" "}
          {value.verified_page.rows} registros. Esta leitura não certifica as
          demais páginas.
        </p>
      )}
      {index > 0 && (
        <button onClick={() => selectPage(index - 1)}>Página anterior</button>
      )}
      {index + 1 < value.pages && (
        <button onClick={() => selectPage(index + 1)}>
          Verificar próxima página
        </button>
      )}
    </section>
  );
}

type PagedReport = {
  schema_version: "btc.paged-evaluation.v1";
  mode: "paper";
  dataset_id: string;
  scope: { account_id: string; window: { start: string; end: string } };
  trading: {
    capital_usd_raw: string | null;
    equity_usd_raw: string | null;
    net_pnl_usd_raw: string | null;
  };
  drawdown: { max_usd_raw: string | null; observed_max_usd_raw: string | null };
  equity_curve: {
    points: { at: string; equity_usd_raw: string | null }[];
    status: string;
  };
  coverage: {
    pages_verified: number;
    expected_windows: number;
    expected_equity_slots: number;
    observed_equity_slots: number;
    complete: boolean;
  };
  after_operational_costs: { net_pnl_usd_raw: string | null };
  evaluation: Evaluation;
};
/** Treat imported output as operator-supplied, never as a server attestation. */
export function parsePagedReport(text: string, account: string): PagedReport {
  if (text.length > 8 * 1024 * 1024)
    throw new Error("Relatório acima do limite.");
  const p = JSON.parse(text) as PagedReport;
  if (
    p.schema_version !== "btc.paged-evaluation.v1" ||
    p.mode !== "paper" ||
    p.scope.account_id !== account ||
    !/^btc-replay-window:[a-f0-9]{64}$/.test(p.dataset_id)
  )
    throw new Error("Versão ou conta incompatível.");
  const amount = (v: unknown) =>
    v === null || (typeof v === "string" && /^(0|-?[1-9][0-9]{0,77})$/.test(v));
  const date = (v: string) =>
    typeof v === "string" &&
    Number.isFinite(Date.parse(v)) &&
    new Date(v).toISOString() === v;
  if (
    !date(p.scope.window.start) ||
    !date(p.scope.window.end) ||
    p.scope.window.start >= p.scope.window.end ||
    !Array.isArray(p.equity_curve.points) ||
    p.equity_curve.points.length > 30000 ||
    !p.equity_curve.points.every(
      (x) => date(x.at) && amount(x.equity_usd_raw),
    ) ||
    ![
      p.trading.capital_usd_raw,
      p.trading.equity_usd_raw,
      p.trading.net_pnl_usd_raw,
      p.drawdown.max_usd_raw,
      p.drawdown.observed_max_usd_raw,
      p.after_operational_costs.net_pnl_usd_raw,
    ].every(amount) ||
    ![
      p.coverage.pages_verified,
      p.coverage.expected_windows,
      p.coverage.expected_equity_slots,
      p.coverage.observed_equity_slots,
    ].every((x) => Number.isSafeInteger(x) && x >= 0) ||
    typeof p.coverage.complete !== "boolean"
  )
    throw new Error("Relatório inválido.");
  // Imported sources are displayed as text only; validate renderable shape.
  if (
    !Array.isArray(p.evaluation.references) ||
    p.evaluation.references.length > 8 ||
    !p.evaluation.references.every(
      (r) =>
        typeof r.source === "string" &&
        typeof r.kind === "string" &&
        Number.isSafeInteger(r.exposure_bps) &&
        date(r.window.start) &&
        date(r.window.end) &&
        typeof r.capital_usd_raw === "string" &&
        amount(r.capital_usd_raw) &&
        [r.net_pnl_usd_raw, r.fees_usd_raw, r.funding_usd_raw].every(amount) &&
        [r.fee_basis, r.funding_basis].every(
          (x) => x === null || typeof x === "string",
        ) &&
        Array.isArray(r.missing) &&
        r.missing.every((x) => typeof x === "string") &&
        (r.prices === null ||
          [r.prices.start, r.prices.end].every(
            (x) =>
              date(x.at) &&
              typeof x.usd_raw === "string" &&
              amount(x.usd_raw) &&
              typeof x.evidence_id === "string",
          )),
    ) ||
    [p.evaluation.cost_basis, p.evaluation.input_hash].some(
      (x) => x !== null && typeof x !== "string",
    ) ||
    typeof p.evaluation.cost_status !== "string"
  )
    throw new Error("Fontes inválidas.");
  return p;
}
export function OfflinePagedImport({ accountId }: { accountId: string }) {
  const [value, setValue] = useState<PagedReport>();
  const [error, setError] = useState("");
  return (
    <details>
      <summary>Abrir avaliação de replay completo</summary>
      <p>
        Selecione o relatório produzido pelo comando de avaliação offline após
        exportar todas as páginas. O arquivo permanece neste navegador, sem
        envio ao servidor. Um arquivo editado pode conter resultados falsos; a
        importação valida formato e conta, não reexecuta o replay nem atesta sua
        origem.
      </p>
      <input
        aria-label="Relatório de replay completo"
        type="file"
        accept="application/json,.json"
        onChange={async (e) => {
          setValue(undefined);
          setError("");
          const file = e.target.files?.[0];
          if (!file) return;
          try {
            if (file.size > 8 * 1024 * 1024)
              throw new Error("Relatório acima do limite.");
            setValue(parsePagedReport(await file.text(), accountId));
          } catch {
            setError("Relatório inválido ou incompatível com esta conta.");
          }
        }}
      />
      {error && <p role="alert">{error}</p>}
      {value?.scope.account_id === accountId && (
        <section className="btc-status">
          <h3>Avaliação offline fornecida pelo operador</h3>
          <p>
            {value.coverage.pages_verified} páginas verificadas pelo gerador;{" "}
            {value.coverage.expected_windows} janelas previstas. Equity:{" "}
            {value.coverage.observed_equity_slots} /{" "}
            {value.coverage.expected_equity_slots} amostras.{" "}
            {value.coverage.complete
              ? "Slots declarados completos, sem inferir extremo intrabar."
              : "Período incompleto; gaps preservados."}
          </p>
          <p>
            Patrimônio: {money(value.trading.equity_usd_raw)}; resultado:{" "}
            {money(value.trading.net_pnl_usd_raw)}; após custos:{" "}
            {money(value.after_operational_costs.net_pnl_usd_raw)}. Drawdown
            completo: {money(value.drawdown.max_usd_raw)}; mínimo observado:{" "}
            {money(value.drawdown.observed_max_usd_raw)}.
          </p>
          <EquityCurve metric={value} />
          <EvaluationSources value={value.evaluation} />
        </section>
      )}
    </details>
  );
}
