import { useEffect, useState } from "react";
import { displayRaw } from "./btc-ticket.js";

type Access = { accessToken: string; onUnauthorized: () => void };
type Metric = {
  dataset_id: string;
  scope: { account_id: string; window: { start: string; end: string } };
  versions: {
    code_sha: string;
    strategy: string;
    manifest_hash: string;
    contracts: Record<string, string>;
  };
  capital_usd_raw: string;
  transfers_usd_raw: string;
  trading: {
    equity_usd_raw: string | null;
    net_pnl_usd_raw: string | null;
    realized_net_usd_raw: string;
    fees_usd_raw: string;
    funding_usd_raw: string;
    net_return_ppm: string | null;
  };
  drawdown: { max_usd_raw: string | null; max_ppm: string | null };
  equity_curve: {
    points: { at: string; equity_usd_raw: string | null }[];
    status: string;
  };
  operational_costs: {
    ai_usd_raw: string | null;
    infrastructure_usd_raw: string | null;
    captured_real_ai_usd_raw: string;
    captured_unknown_ai_calls: number;
  };
  after_operational_costs: { net_pnl_usd_raw: string | null };
  decisions: {
    count: number;
    by_state: Record<string, number>;
    by_reason: Record<string, number>;
    market_bar_clusters: string[];
    filter_vetoes: { real: number; mock: number };
  };
  turnover: { gross_notional_usd_raw: string };
  input_audit: string;
  late_funding_event_ids: string[];
};
export type ExperimentReport = {
  status: string;
  reason?: string;
  baseline: Metric;
  challenger: Metric | null;
  delta: {
    trading_usd_raw: string;
    after_operational_usd_raw: string | null;
  } | null;
};
type Catalog = {
  items: { dataset_id: string; account_id: string; captured_at: string }[];
  next_cursor: string | null;
};
export type ExperimentSystem = {
  as_of: string;
  operational?: {
    schema_version: string;
    status: string;
    account_scope: string;
    accounts_ready: boolean;
    channels: {
      channel: string;
      status: string;
      reasons: string[];
      freshness_at: string | null;
      received_at: string | null;
      limit_ms: number;
      timestamp_basis: string;
    }[];
    collector: {
      status: string;
      observed_at: string | null;
      capture_status: string;
      restarted_at_last_capture: boolean | null;
      history_truncated_at_last_capture: boolean | null;
    };
    resources: {
      scope: string;
      observed_at: string;
      rss_bytes: number;
      cpu_user_us: number;
      cpu_system_us: number;
      uptime_seconds: number;
    };
    history: {
      start_at: string;
      end_at: string;
      observed: number;
      incomplete: number;
      unavailable: number;
      intervals: { start_at: string; status: string }[];
    };
  };
  capacity: {
    hold: boolean;
    raw_bytes: string;
    total_bytes: string;
    raw_quota_bytes: string;
    total_quota_bytes: string;
    physical_bytes: string;
  } | null;
  worker_limits: {
    raw_bytes: string;
    total_bytes: string;
    physical_bytes: string;
  };
  feed: { status: string; last_capture_at: string | null; continuity: string };
  container_restarts: number | null;
  container_status: string;
  host_disk: null;
  recovery: {
    account_id: string;
    generation: string | null;
    consumer_at?: string | null;
    consumer_reason?: string | null;
    readiness?: { status: string; reasons: string[] };
    status: string;
    reason: string | null;
    lease_alive: boolean;
    checkpoint_at: string | null;
  }[];
  next_cursor: string | null;
};
export function useExperimentRead<T>(
  path: string | null,
  access: Access,
  revision = 0,
) {
  const [state, setState] = useState<{
    path: string;
    token: string;
    revision: number;
    value?: T;
    error?: string;
  }>();
  useEffect(() => {
    if (!path) return;
    let active = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    void (async () => {
      try {
        const response = await fetch(`/api/trading/${path}`, {
          headers: { authorization: `Bearer ${access.accessToken}` },
          cache: "no-store",
          signal: controller.signal,
        });
        if (response.status === 401) access.onUnauthorized();
        if (!response.ok)
          throw new Error(
            response.status === 404
              ? "Corte não encontrado ou acima do limite de leitura."
              : "Leitura indisponível. Verifique a seleção e tente novamente.",
          );
        const value = (await response.json()) as T;
        if (active)
          setState({ path, token: access.accessToken, revision, value });
      } catch (e) {
        if (active)
          setState({
            path,
            revision,
            token: access.accessToken,
            error: e instanceof Error ? e.message : "Leitura indisponível.",
          });
      } finally {
        clearTimeout(timer);
      }
    })();
    return () => {
      active = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [path, access.accessToken, access.onUnauthorized, revision]);
  return state?.path === path &&
    state.token === access.accessToken &&
    state.revision === revision
    ? state
    : undefined;
}
const money = (value: string | null) =>
  value === null ? "Não disponível" : `US$ ${displayRaw(value)}`;
const percent = (value: string | null) =>
  value === null ? "Não disponível" : `${displayRaw(value, 4)}%`;
const reasonText: Record<string, string> = {
  BTC_METRICS_COMPARISON_DATASETS:
    "Falta um manifesto válido vinculando os dois cortes. Resultados separados, sem delta.",
  BTC_METRICS_COMPARISON_WINDOW_OR_CONTRACT:
    "Janelas, instrumentos ou contratos contábeis diferentes. Selecione cortes compatíveis.",
  BTC_METRICS_COMPARISON_ACCOUNTS:
    "Os cortes pertencem à mesma conta. Escolha outro cenário para comparar.",
  BTC_METRICS_COMPARISON_VERSION_DECLARATION:
    "A versão mudou: declare exatamente as diferenças de código, estratégia e manifesto.",
  BTC_METRICS_COMPARISON_PROVENANCE:
    "As identidades de mercado ou risco não foram declaradas corretamente.",
};
const decisionReason: Record<string, string> = {
  book_unavailable: "Livro de ofertas indisponível",
  context_bars_unavailable: "Barras de contexto indisponíveis",
  context_unavailable: "Contexto de mercado indisponível",
  data_unavailable: "Dados insuficientes para decidir",
  decision_bars_unavailable: "Barras de decisão indisponíveis",
  metadata_unavailable: "Metadados do instrumento indisponíveis",
  risk_pause: "Entradas pausadas pelo risco",
  no_signal: "Sem sinal registrado",
};
export function EquityCurve({ metric }: { metric: Metric }) {
  const points = metric.equity_curve.points;
  const known = points.filter(
    (p): p is { at: string; equity_usd_raw: string } =>
      p.equity_usd_raw !== null,
  );
  const values = known.map((p) => BigInt(p.equity_usd_raw));
  const low = values.reduce((a, b) => (a < b ? a : b), values[0] ?? 0n);
  const high = values.reduce((a, b) => (a > b ? a : b), values[0] ?? 0n);
  const start = Date.parse(metric.scope.window.start),
    duration = Date.parse(metric.scope.window.end) - start;
  return (
    <figure className="experiment-curve">
      <figcaption>
        Patrimônio observado · {known.length} ponto(s) conhecidos de{" "}
        {points.length}
      </figcaption>
      <p>
        Somente limites de transações do ledger. Sem interpolação ou marcas
        históricas inventadas. Aportes e saques afetam o patrimônio; não são
        lucro.
      </p>
      {known.length > 0 ? (
        <>
          <svg
            viewBox="0 0 640 160"
            role="img"
            aria-label="Pontos conhecidos de patrimônio, sem linha contínua"
          >
            <title>
              Patrimônio entre {money(low.toString())} e{" "}
              {money(high.toString())}
            </title>
            <path
              d="M20 10V140H620"
              fill="none"
              stroke="currentColor"
              opacity="0.4"
            />
            {known.map((p, i) => (
              <circle
                key={i}
                cx={
                  20 +
                  Math.max(
                    0,
                    Math.min(1, (Date.parse(p.at) - start) / duration),
                  ) *
                    600
                }
                cy={
                  high === low
                    ? 75
                    : 130 -
                      Number(
                        ((BigInt(p.equity_usd_raw) - low) * 11000n) /
                          (high - low),
                      ) /
                        100
                }
                r="4"
                fill="currentColor"
              >
                <title>
                  {p.at}: {money(p.equity_usd_raw)}
                </title>
              </circle>
            ))}
          </svg>
          <p>
            Escala: {money(low.toString())} a {money(high.toString())}. Eixo
            temporal: início → corte UTC.
          </p>
        </>
      ) : (
        <p>Curva indisponível: nenhum ponto de patrimônio conhecido.</p>
      )}
      {metric.equity_curve.status === "missing_equity_history" && (
        <p role="note">
          Há exposição sem histórico de marcas. Curva incompleta e drawdown
          indisponível, inclusive após fechar a posição.
        </p>
      )}
      <details>
        <summary>Valores e horários dos pontos</summary>
        <div className="btc-table">
          <table>
            <thead>
              <tr>
                <th>Horário UTC</th>
                <th>Patrimônio</th>
              </tr>
            </thead>
            <tbody>
              {points.map((p, i) => (
                <tr key={i}>
                  <td>{p.at}</td>
                  <td>{money(p.equity_usd_raw)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
function MetricCard({ metric, label }: { metric: Metric; label: string }) {
  return (
    <article className="btc-status">
      <h3>
        {label} · {metric.scope.account_id}
      </h3>
      <p>
        Desde o início <time>{metric.scope.window.start}</time> até o corte{" "}
        <time>{metric.scope.window.end}</time> (UTC).
      </p>
      <div className="btc-balances">
        <p>
          Patrimônio no corte
          <strong>{money(metric.trading.equity_usd_raw)}</strong>
        </p>
        <p>
          Resultado de trading
          <strong>{money(metric.trading.net_pnl_usd_raw)}</strong>
        </p>
        <p>
          Retorno sobre capital inicial
          <strong>{percent(metric.trading.net_return_ppm)}</strong>
        </p>
        <p>
          Drawdown máximo
          <strong>
            {money(metric.drawdown.max_usd_raw)} ·{" "}
            {percent(metric.drawdown.max_ppm)}
          </strong>
        </p>
        <p>
          Taxas / funding do ledger
          <strong>
            {money(metric.trading.fees_usd_raw)} /{" "}
            {money(metric.trading.funding_usd_raw)}
          </strong>
        </p>
        <p>
          Após custos operacionais
          <strong>
            {money(metric.after_operational_costs.net_pnl_usd_raw)}
          </strong>
        </p>
      </div>
      <p>
        Capital inicial: {money(metric.capital_usd_raw)}. Transferências
        líquidas: {money(metric.transfers_usd_raw)}. Trading realizado (PnL +
        taxas + funding): {money(metric.trading.realized_net_usd_raw)}.
      </p>
      <p>
        Volume negociado: {money(metric.turnover.gross_notional_usd_raw)}.{" "}
        {metric.turnover.gross_notional_usd_raw === "0" &&
          "Sem trades neste corte; saldo preservado não comprova desempenho."}
      </p>
      <EquityCurve metric={metric} />
      <h4>Custos e influência Jev</h4>
      <p>
        IA alocada: {money(metric.operational_costs.ai_usd_raw)}. Infraestrutura
        alocada: {money(metric.operational_costs.infrastructure_usd_raw)}. Sem
        rateio completo declarado, o custo permanece desconhecido. Reservas não
        são despesas.
      </p>
      <p>
        Subtotal Jev real capturado na seleção:{" "}
        {money(metric.operational_costs.captured_real_ai_usd_raw)};{" "}
        {metric.operational_costs.captured_unknown_ai_calls} chamada(s) com
        custo desconhecido. Informativo, sem novo débito e sem provar custo zero
        da conta.
      </p>
      <p>
        Vetos Jev reais: {metric.decisions.filter_vetoes.real}; mock:{" "}
        {metric.decisions.filter_vetoes.mock}. Contribuição causal:
        inconclusiva. Vetos não significam perdas evitadas.
      </p>
      <h4>Amostra e falhas de dados</h4>
      <p>
        {metric.decisions.count} decisões selecionadas,{" "}
        {metric.decisions.market_bar_clusters.length} barras de mercado. Amostra
        independente desconhecida; decisões da mesma barra são correlacionadas.
        As finanças cobrem o ledger inteiro da conta.
      </p>
      <ul>
        {Object.entries(metric.decisions.by_state).map(([state, count]) => (
          <li key={state}>
            {state === "data_unavailable" ? "Dados indisponíveis" : state}:{" "}
            {count}
          </li>
        ))}
      </ul>
      <ul>
        {Object.entries(metric.decisions.by_reason).map(([reason, count]) => (
          <li key={reason}>
            {decisionReason[reason] ?? "Motivo registrado"}:{" "}
            <code>{reason}</code> · {count}
          </li>
        ))}
      </ul>
      <p>
        {metric.input_audit === "embedded_payloads_verified"
          ? "Objetos embutidos verificados; isso não certifica continuidade do mercado."
          : "Auditoria dos inputs externos pendente; referências retidas não foram resolvidas nesta leitura."}{" "}
        Gaps e cobertura integral não certificados. Zero no ledger não certifica
        cobertura de funding. Funding é aproximação paper;{" "}
        {metric.late_funding_event_ids.length} evento(s) tardio(s) conhecidos
        neste corte.
      </p>
      <details>
        <summary>Versões e proveniência deste corte</summary>
        <dl>
          <dt>Dataset</dt>
          <dd>{metric.dataset_id}</dd>
          <dt>Estratégia</dt>
          <dd>{metric.versions.strategy}</dd>
          <dt>Código</dt>
          <dd>{metric.versions.code_sha}</dd>
          <dt>Manifesto</dt>
          <dd>{metric.versions.manifest_hash}</dd>
          {Object.entries(metric.versions.contracts).map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      </details>
    </article>
  );
}
export function ExperimentResults({ report }: { report: ExperimentReport }) {
  const versions = report.challenger
    ? (["code_sha", "strategy", "manifest_hash"] as const).filter(
        (k) => report.baseline.versions[k] !== report.challenger!.versions[k],
      )
    : [];
  return (
    <>
      <div className="btc-status" aria-live="polite">
        <h3>Resultado inconclusivo</h3>
        <p>
          Validação do software, observação operacional e evidência econômica
          são distintas. Este corte não comprova maturidade de 7 ou 30 dias,
          alpha ou causalidade.
        </p>
        <p>
          {report.status === "challenger_absent"
            ? "Sem cenário desafiante selecionado. Próximo passo: observar dados válidos e selecionar um corte compatível quando existir."
            : report.status === "risk_or_capital_differs"
              ? "Risco, capital ou fluxos de capital diferentes: somente lado a lado, sem delta."
              : report.status === "observational_comparison"
                ? "Comparação observacional: mercado e risco declarados no manifesto, sem auditoria externa."
                : (reasonText[report.reason ?? ""] ??
                  "Comparação não validada. Revise os cortes e o manifesto.")}
        </p>
        {versions.length > 0 && (
          <p>
            Versões diferentes: {versions.join(", ")}. Reveja essas mudanças
            antes de escolher o próximo teste.
          </p>
        )}
        {report.delta && (
          <p>
            Desafiante menos base · trading:{" "}
            {money(report.delta.trading_usd_raw)}; após custos:{" "}
            {money(report.delta.after_operational_usd_raw)}. Cenários nunca são
            somados.
          </p>
        )}
      </div>
      <div className={report.challenger ? "experiment-comparison" : ""}>
        <MetricCard metric={report.baseline} label="Base selecionada" />
        {report.challenger && (
          <MetricCard metric={report.challenger} label="Cenário comparado" />
        )}
      </div>
    </>
  );
}
export function Experiments(props: Access & { accountId: string }) {
  const [cursor, setCursor] = useState("");
  const catalog = useExperimentRead<Catalog>(
    `experiment-datasets${cursor ? `?after=${encodeURIComponent(cursor)}` : ""}`,
    props,
  );
  const [dataset, setDataset] = useState("");
  const [challenger, setChallenger] = useState("");
  const [manifest, setManifest] = useState("");
  const [path, setPath] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const result = useExperimentRead<ExperimentReport>(path, props, revision);
  const cuts =
    catalog?.value?.items.filter((c) => c.account_id === props.accountId) ?? [];
  return (
    <section className="btc-desk">
      <h2>Experimentos BTC</h2>
      <p>
        SIMULAÇÃO · selecione cortes imutáveis. A janela disponível vai do
        início da conta até cada corte; não há recorte arbitrário nem captura
        automática ao abrir a tela.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const q = new URLSearchParams({
            account_id: props.accountId,
            dataset_id: dataset,
          });
          if (challenger) q.set("challenger_id", challenger);
          if (manifest.trim()) q.set("comparison", manifest.trim());
          setPath(`experiments?${q}`);
          setRevision((x) => x + 1);
        }}
      >
        <fieldset>
          <legend>Janela e cenários</legend>
          <label>
            Corte da conta {props.accountId}
            <select
              required
              value={dataset}
              onChange={(e) => {
                setDataset(e.target.value);
                setPath(null);
              }}
            >
              <option value="">Selecione um corte…</option>
              {cuts.map((c) => (
                <option key={c.dataset_id} value={c.dataset_id}>
                  {c.captured_at} · {c.dataset_id.slice(-12)}
                </option>
              ))}
            </select>
          </label>
          {catalog?.error && <p role="alert">{catalog.error}</p>}
          {!catalog && <p role="status">Lendo cortes disponíveis…</p>}
          {catalog?.value && cuts.length === 0 && (
            <p>
              Nenhum corte desta conta nesta página. Sem corte, métricas
              indisponíveis; a tela não cria datasets.
            </p>
          )}
          {catalog?.value?.next_cursor && (
            <button
              type="button"
              onClick={() => {
                setCursor(catalog.value!.next_cursor!);
                setDataset("");
                setPath(null);
              }}
            >
              Próxima página de cortes
            </button>
          )}
          {cursor && (
            <button
              type="button"
              onClick={() => {
                setCursor("");
                setDataset("");
                setPath(null);
              }}
            >
              Primeira página
            </button>
          )}
          <label>
            Comparar com dataset (opcional)
            <input
              value={challenger}
              maxLength={75}
              placeholder="btc-replay:…"
              onChange={(e) => {
                setChallenger(e.target.value);
                setPath(null);
              }}
              list="experiment-cuts"
            />
          </label>
          <datalist id="experiment-cuts">
            {catalog?.value?.items.map((c) => (
              <option key={c.dataset_id} value={c.dataset_id}>
                {c.account_id} · {c.captured_at}
              </option>
            ))}
          </datalist>
          <details>
            <summary>
              Manifesto de comparação (opcional para leitura lado a lado)
            </summary>
            <p>
              Para calcular delta, forneça o manifesto
              btc.economic-comparison.v1 com IDs dos datasets, hashes de mercado
              e risco e diferenças de versões declaradas. O manifesto é usado
              somente nesta leitura.
            </p>
            <label>
              Manifesto JSON
              <textarea
                rows={7}
                maxLength={2048}
                value={manifest}
                onChange={(e) => {
                  setManifest(e.target.value);
                  setPath(null);
                }}
                placeholder={
                  '{"schema_version":"btc.economic-comparison.v1","baseline_dataset_id":"btc-replay:…","challenger_dataset_id":"btc-replay:…","market_dataset_hash":"sha256:…","baseline_risk_hash":"sha256:…","challenger_risk_hash":"sha256:…","declared_version_differences":[]}'
                }
              />
            </label>
          </details>
          <button
            disabled={!dataset || (path !== null && !result)}
            type="submit"
          >
            Ler cortes selecionados
          </button>
        </fieldset>
      </form>
      {path && !result && (
        <p role="status">Calculando a projeção dos cortes selecionados…</p>
      )}
      {result?.error && <p role="alert">{result.error}</p>}
      {result?.value && <ExperimentResults report={result.value} />}
    </section>
  );
}
export function readinessReason(reason: string) {
  const labels: Record<string, string> = {
    consumer_not_enabled: "consumidor não habilitado",
    consumer_stale: "ciclo do consumidor desatualizado",
    consumer_unavailable: "ciclo do consumidor indisponível",
    consumer_future: "relógio do consumidor no futuro",
    consumer_not_ready: "consumidor em falha ou não pronto",
    reconciliation_not_ready: "reconciliação não pronta",
    lease_expired_or_absent: "lease expirado ou ausente",
    feed_gap_or_unavailable: "feed com gap ou indisponível",
    capture_precedes_event: "captura anterior ao evento",
    source_quality_unproven: "qualidade temporal não comprovada",
  };
  for (const [key, label] of [
    ["source", "fonte"],
    ["received", "recebimento"],
    ["capture", "captura"],
  ]) {
    labels[`${key}_stale`] = `${label} desatualizada`;
    labels[`${key}_unavailable`] = `${label} indisponível`;
    labels[`${key}_future`] = `${label} no futuro`;
  }
  return labels[reason] ?? reason;
}
export function ExperimentSystemView({ value }: { value: ExperimentSystem }) {
  const gb = (v: string) =>
    `${(Number((BigInt(v) * 100n) / 1073741824n) / 100).toLocaleString("pt-BR")} GiB`;
  const capacity = value.capacity;
  return (
    <>
      <p>
        Instantâneo observado em {value.as_of} (UTC). Atualize para uma nova
        leitura; o estado pode ter mudado desde esse corte.
      </p>
      <h3>Prontidão operacional</h3>
      <p>
        API acessível não significa dados ou contas prontos. Esta leitura não
        autoriza risco, não rearma contas e não executa reconciliação.
      </p>
      {value.operational ? (
        <>
          <p>
            {value.operational.status === "sources_recent" &&
            value.operational.accounts_ready
              ? "Fontes recentes e consumidores prontos nesta página; gates de risco e capacidade continuam independentes."
              : "Operação não pronta: consulte os motivos por fonte e conta abaixo."}
          </p>
          {value.operational.channels.map((c) => (
            <p key={c.channel}>
              <strong>
                {c.channel === "book" ? "Livro" : "Marca / contexto"}
              </strong>
              : {c.status === "fresh" ? "recente" : "não pronto"}. Limite:{" "}
              {c.limit_ms} ms. Referência temporal ({c.timestamp_basis}):{" "}
              {c.freshness_at ?? "indisponível"}. Recebido em:{" "}
              {c.received_at ?? "indisponível"}. Motivos:{" "}
              {c.reasons.map(readinessReason).join("; ") ||
                "nenhum nesta medição"}
              .
            </p>
          ))}
          <p>
            Processo do coletor: indisponível nesta fonte. Última captura
            registrou reinício de sessão:{" "}
            {value.operational.collector.restarted_at_last_capture === null
              ? "indisponível"
              : value.operational.collector.restarted_at_last_capture
                ? "sim"
                : "não"}
            . Isso não é contagem de reinícios do container nem prova de
            processo ativo.
          </p>
          <h3>Recursos medidos</h3>
          <p>
            Somente processo da API em {value.operational.resources.observed_at}
            : RAM RSS{" "}
            {(value.operational.resources.rss_bytes / 1048576).toFixed(1)} MiB;
            CPU acumulada desde o início{" "}
            {(
              (value.operational.resources.cpu_user_us +
                value.operational.resources.cpu_system_us) /
              1000000
            ).toFixed(1)}{" "}
            s; processo iniciado há{" "}
            {Math.floor(value.operational.resources.uptime_seconds)} s. CPU
            acumulada não é percentual de carga. CPU e RAM do host:
            indisponíveis.
          </p>
          <h3>Cobertura de dados — sete dias</h3>
          <p>
            {value.operational.history.start_at} até{" "}
            {value.operational.history.end_at}.{" "}
            {value.operational.history.observed} intervalos de captura sem
            lacuna conhecida maior que 60 s;{" "}
            {value.operational.history.incomplete} incompletos;{" "}
            {value.operational.history.unavailable} indisponíveis, de 672
            intervalos de 15 minutos. Ausência de registro não comprova parada.
            Esta história mede cadência de capturas, não continuidade de cada
            canal ou uptime, e não certifica sete dias estáveis.
          </p>
          <p>
            Evidência já retida e contabilizada em G2-12, sem nova cópia ou
            reset de histórico. Retenção futura continua sujeita à admissão de
            capacidade.
          </p>
          <details>
            <summary>Ver interrupções e intervalos indisponíveis</summary>
            <ul>
              {value.operational.history.intervals
                .filter((i) => i.status !== "observed_edges")
                .map((i) => (
                  <li key={i.start_at}>
                    {i.start_at}:{" "}
                    {i.status === "incomplete"
                      ? "borda sem captura recente"
                      : "evidência indisponível"}
                  </li>
                ))}
            </ul>
          </details>
        </>
      ) : (
        <p>Prontidão detalhada indisponível nesta versão da API.</p>
      )}
      <h3>Coleta e continuidade</h3>
      <p>
        {value.feed.status === "stale"
          ? "Coleta desatualizada: última captura há mais de 60 segundos. A causa pode ser parada ou falha; saúde da API não comprova feed saudável."
          : value.feed.status === "recent_capture"
            ? "Captura recente; isso não certifica continuidade nem frescor de cada canal."
            : "Coleta sem medição disponível."}
      </p>
      <p>
        Última captura: {value.feed.last_capture_at ?? "não disponível"}.
        Continuidade e ausência de gaps: não comprovadas.
      </p>
      <h3>Capacidade</h3>
      {capacity ? (
        <>
          <div className="btc-balances">
            <p>
              Raw / teto do worker
              <strong>
                {gb(capacity.raw_bytes)} / {gb(value.worker_limits.raw_bytes)}
              </strong>
            </p>
            <p>
              Lógico / teto do worker
              <strong>
                {gb(capacity.total_bytes)} /{" "}
                {gb(value.worker_limits.total_bytes)}
              </strong>
            </p>
            <p>
              Físico / teto do worker
              <strong>
                {gb(capacity.physical_bytes)} /{" "}
                {gb(value.worker_limits.physical_bytes)}
              </strong>
            </p>
          </div>
          <p>
            {BigInt(capacity.raw_bytes) >=
              BigInt(value.worker_limits.raw_bytes) ||
            BigInt(capacity.total_bytes) >=
              BigInt(value.worker_limits.total_bytes) ||
            BigInt(capacity.physical_bytes) >=
              BigInt(value.worker_limits.physical_bytes)
              ? "Teto do worker atingido. Capacidade insuficiente para retomada."
              : "Abaixo dos tetos de armazenamento do worker nesta leitura; disco do host ainda precisa ser verificado para retomada."}{" "}
            Tetos SQL: {gb(capacity.raw_quota_bytes)} raw /{" "}
            {gb(capacity.total_quota_bytes)} lógico. HOLD:{" "}
            {capacity.hold ? "ativo" : "inativo"}.
          </p>
        </>
      ) : (
        <p>Capacidade não disponível.</p>
      )}
      <p>
        Disco livre do host: não disponível nesta API. Sustentabilidade de 7/30
        dias não avaliada.
      </p>
      <h3>Reinícios e reconciliação</h3>
      <p>
        Estado do container e contagem de reinícios: não disponíveis nesta API.
        Uma geração de reconciliação não é contagem de reinícios do container.
      </p>
      {value.recovery.length === 0 && (
        <p>Reconciliação sem registros nesta página.</p>
      )}
      {value.recovery.map((r) => (
        <p key={r.account_id}>
          <strong>{r.account_id}</strong> · geração{" "}
          {r.generation ?? "indisponível"} ·{" "}
          {r.readiness && (
            <>
              Consumidor{" "}
              {r.readiness.status === "ready" ? "pronto" : "não pronto"}:{" "}
              {r.readiness.reasons.map(readinessReason).join("; ") ||
                "heartbeat, reconciliação e lease atuais"}
              . Último ciclo: {r.consumer_at ?? "indisponível"}. Motivo do
              ciclo: {r.consumer_reason ?? "indisponível"}.{" "}
            </>
          )}
          {r.status === "ready" && r.lease_alive
            ? "reconciliação pronta e lease vigente"
            : r.status === "blocked"
              ? "reconciliação bloqueada"
              : "lease expirado; prontidão atual não comprovada"}
          . Último checkpoint: {r.checkpoint_at ?? "não disponível"}.{" "}
          {r.reason && (
            <>
              Motivo registrado: <code>{r.reason}</code>.
            </>
          )}
        </p>
      ))}
    </>
  );
}
export function ExperimentSystem(props: Access) {
  const [cursor, setCursor] = useState("");
  const [revision, setRevision] = useState(0);
  // Explicit refresh remounts the reader; no polling or background replay timer.
  return (
    <SystemRefresh
      key={revision}
      props={props}
      cursor={cursor}
      setCursor={setCursor}
      refresh={() => setRevision((x) => x + 1)}
    />
  );
}
function SystemRefresh({
  props,
  cursor,
  setCursor,
  refresh,
}: {
  props: Access;
  cursor: string;
  setCursor: (v: string) => void;
  refresh: () => void;
}) {
  const value = useExperimentRead<ExperimentSystem>(
    `experiment-system${cursor ? `?after=${encodeURIComponent(cursor)}` : ""}`,
    props,
  );
  return (
    <>
      <button onClick={refresh}>Atualizar diagnóstico</button>
      {!value && <p role="status">Lendo diagnóstico…</p>}
      {value?.error && <p role="alert">{value.error}</p>}
      {value?.value && <ExperimentSystemView value={value.value} />}
      {value?.value?.next_cursor && (
        <button onClick={() => setCursor(value.value!.next_cursor!)}>
          Próximas contas
        </button>
      )}
      {cursor && (
        <button onClick={() => setCursor("")}>Primeiras contas</button>
      )}
    </>
  );
}
