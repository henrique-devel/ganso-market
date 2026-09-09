// RFC-013 dashboard sections. Read-only: nothing here places an order, and the
// two manual state controls (halt/resume) are deliberately absent from the UI
// as well as from the Nginx perimeter — leaving HALTED should take a deliberate
// operator action from inside, not a button on a page.
//
// RFC-026 D5 turned this one tab into the body of three screens. The panel now
// takes the list of sections to render, and App.tsx composes them: Carteira
// (tela 2) = exposição + estado, Decisões (tela 3) = decisões + consulta,
// Sistema (tela 6) = gates. "Oportunidades" and "Rápidos" left for the Mesa
// (tela 1, `Mesa.tsx`), which is where the opportunity panel lives now — the
// horizon helpers and the round-trip cost stay exported here because that is
// where they were measured and tested.
//
// Only the sections asked for are fetched. A screen that shows exposure does
// not spend a request on the decision log it is not going to render, and the
// 20 req/min the RFC budgets stay for the screens that need them.
//
// One control DOES exist in the dashboard, and it is not here: the paper kill
// switch's rearm, on the Resolução tab, next to the state it acts on (owner
// decision, 2026-08-27). It is a different switch from these two — the RFC-011
// broker halt, not the RFC-013 portfolio state — and it is published as one
// exact path with a confirmation step. This tab's controls stay closed.
//
// The panel shows vetoed opportunities WITH their reason. Hiding them would let
// the page imply the universe is cleaner than it is; showing one without the
// reason is what the RFC forbids outright.

import { useCallback, useEffect, useRef, useState } from "react";

import {
  CATEGORIA,
  ESTADO_PORTFOLIO,
  GATILHO_TRANSICAO,
  GATE,
  LADO,
  LIMITADOR,
  MOTIVO_DECISAO,
  MOTIVO_GATE,
  NATUREZA_BLOQUEIO,
  RESULTADO_DECISAO,
  SITUACAO_GATE,
  STATUS_RFC009,
  TIPO_DECISAO,
  consequencia,
  dataDoRelogio,
  naturezaDoBloqueio,
  progressoDoGate,
  rotulo,
  type Progresso,
} from "./dicionario";
import { Badge } from "./Overview.tsx";
import { useModoEngenheiro } from "./modo.tsx";
import {
  fetchDecisions,
  fetchExposures,
  fetchGateMeasurements,
  fetchDecision,
  fetchGates,
  fetchLimits,
  fetchPortfolioState,
  type Decision,
  type Exposure,
  type GateMeasurementPage,
  type GateSnapshot,
  type PortfolioLimits,
  type PortfolioStateSnapshot,
} from "./portfolio";
import {
  STATUS_ABERTO,
  duracaoTexto,
  fetchPaperOrders,
  fetchPaperPositions,
  idadeTexto,
  quantidadeTexto,
  sinalTexto,
  usdTexto,
  type PaperOrder,
  type PaperPosition,
} from "./paper";

const REFRESH_MS = 30_000;
// The other tabs already bounded their polls; this one did not, so a stalled
// API left requests pending and the next tick piled another one on top.
const REQUEST_TIMEOUT_MS = 5_000;
// Client-side paging over the 200/500-row lists the endpoints return whole.
const ROWS_PER_PAGE = 25;

export type Section =
  | "posicoes"
  | "ordens"
  | "exposicao"
  | "estado"
  | "gates"
  | "consulta"
  | "decisoes";

const TODAS_AS_SECOES: readonly Section[] = [
  "posicoes",
  "ordens",
  "exposicao",
  "estado",
  "gates",
  "consulta",
  "decisoes",
];

const ROTULO_DA_SECAO: Readonly<Record<Section, string>> = {
  posicoes: "Posições",
  ordens: "Ordens",
  exposicao: "Exposição",
  estado: "Estado",
  gates: "Gates",
  consulta: "Consulta",
  decisoes: "Decisões",
};

const GATE_OPTIONS = ["G1", "G2", "G3", "G4", "G5", "G6"] as const;
const STATUS_OPTIONS = ["PASS", "FAIL", "INSUFFICIENT_DATA"] as const;
const PAGE_SIZE = 25;

interface MeasurementFilters {
  readonly gate: string;
  readonly status: string;
  readonly from: string;
  readonly to: string;
}

const NO_FILTERS: MeasurementFilters = {
  gate: "",
  status: "",
  from: "",
  to: "",
};

/**
 * A compact one-line summary of a measurement's metrics.
 *
 * Only scalars, and only the first few: the full object goes in the expandable
 * block below, so the table stays readable while nothing is hidden.
 */
function metricSummary(metrics: Readonly<Record<string, unknown>>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(metrics)) {
    if (parts.length >= 4) {
      break;
    }
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      parts.push(`${key}=${String(value)}`);
    }
  }
  return parts.length === 0 ? "—" : parts.join(" · ");
}

// ---------------------------------------------------------------------------
// RFC-026 D8 — Carteira: posições, ordens e uso dos caps
// ---------------------------------------------------------------------------

/** Uma posição está aberta quando o saldo de cotas não é zero — nos dois lados. */
export function posicaoAberta(posicao: PaperPosition): boolean {
  return (sinalTexto(posicao.shares) ?? 0) !== 0;
}

/**
 * O lado da posição, lido do SINAL das cotas.
 *
 * Não existe coluna "side" em `paper_positions`: o saldo é que diz. Zero não é
 * um lado, é uma posição encerrada, e a tela a rotula assim em vez de escolher
 * "comprado" por ser o caso mais comum.
 */
export function ladoDaPosicao(posicao: PaperPosition): string {
  const sinal = sinalTexto(posicao.shares);
  if (sinal === null) {
    return "não medido";
  }
  return sinal > 0 ? "Comprado" : sinal < 0 ? "Vendido" : "Encerrada";
}

function CartaoPosicao({
  posicao,
  agoraMs,
}: Readonly<{ posicao: PaperPosition; agoraMs: number }>) {
  const sinalPnl = sinalTexto(posicao.unrealized_pnl_usd);
  const lado = ladoDaPosicao(posicao);
  return (
    <article
      className="cartao-posicao"
      data-lado={lado}
      // O hash nunca some: o dicionário exige que o código continue legível em
      // algum lugar, e aqui ele fica no title como em toda célula da RFC-026.
      title={`${posicao.token_id}${
        posicao.condition_id === null ? "" : ` · ${posicao.condition_id}`
      }`}
    >
      <header>
        <h4 className={posicao.question === null ? "sem-nome" : undefined}>
          {posicao.question ?? "sem nome"}
        </h4>
        <div className="cartao-selos">
          {/* Âmbar: a marca envelheceu, então o PnL abaixo é de antes. D3
              reserva âmbar para "envelhecido" e vermelho para "não sai
              sozinho" — e uma marca velha se resolve na próxima marcação. */}
          {posicao.mark_stale === true ? (
            <span className="badge badge--atencao">● marca envelhecida</span>
          ) : null}
          {/* Vermelho: a venue já resolveu e o paper ainda carrega a posição.
              Não sai sozinho — é a liquidação que falta (PR-0 b), e esta tela
              ROTULA o caso, não o corrige. */}
          {posicao.pending_settlement ? (
            <span className="badge badge--alerta">
              ● resolvido na venue, não liquidado
            </span>
          ) : null}
        </div>
      </header>

      <dl className="cartao-grade">
        <div>
          <dt>Lado</dt>
          <dd>{lado}</dd>
        </div>
        <div>
          <dt>Quantidade</dt>
          <dd>{quantidadeTexto(posicao.shares)}</dd>
        </div>
        <div>
          <dt>Custo</dt>
          <dd>{usdTexto(posicao.cost_usd)}</dd>
        </div>
        <div>
          <dt>Marca</dt>
          <dd>
            {usdTexto(posicao.mark_value_usd)}{" "}
            <span className="cartao-idade">
              {idadeTexto(posicao.marked_at, agoraMs)}
            </span>
          </dd>
        </div>
        <div>
          {/* O PnL não realizado vem CALCULADO do servidor. A tela não o
              recomputa: dois lugares calculando o mesmo número é a forma
              conhecida de os dois discordarem na hora errada. */}
          <dt>PnL não realizado</dt>
          <dd
            className={
              sinalPnl === null
                ? "valor-nao-medido"
                : sinalPnl > 0
                  ? "valor-ganho"
                  : sinalPnl < 0
                    ? "valor-perda"
                    : undefined
            }
          >
            {posicao.unrealized_pnl_usd === null
              ? "— (marca envelhecida)"
              : usdTexto(posicao.unrealized_pnl_usd)}
          </dd>
        </div>
        <div>
          <dt>Taxas pagas</dt>
          <dd>{usdTexto(posicao.fees_paid_usd)}</dd>
        </div>
        <div>
          <dt>Capital preso</dt>
          <dd>{duracaoTexto(posicao.current_lockup_s)}</dd>
        </div>
        <div>
          <dt>Vencimento</dt>
          <dd>
            {posicao.end_ts === null
              ? "sem vencimento registrado"
              : horizonLabel(horizonMs(posicao.end_ts, agoraMs))}
          </dd>
        </div>
      </dl>
    </article>
  );
}

/**
 * O texto do PnL não realizado somado da carteira.
 *
 * Uma posição sem marca fresca NÃO entra como zero: entra como uma marca
 * ausente, e o total sai acompanhado da contagem. Somar `null` como 0 daria um
 * total que parece medido e não é — o erro que a D3 chama de "ausência virando
 * zero", e que aqui apareceria como uma carteira no zero a zero.
 */
export function totalNaoRealizado(posicoes: readonly PaperPosition[]): {
  readonly texto: string;
  readonly envelhecidas: number;
} {
  const abertas = posicoes.filter(posicaoAberta);
  const envelhecidas = abertas.filter(
    (posicao) => posicao.unrealized_pnl_usd === null,
  ).length;
  const medidas = abertas.filter(
    (posicao) => posicao.unrealized_pnl_usd !== null,
  );
  if (medidas.length === 0) {
    return {
      texto:
        envelhecidas === 0
          ? "—"
          : `— (${String(envelhecidas)} marcas envelhecidas)`,
      envelhecidas,
    };
  }
  let centavos = 0n;
  for (const posicao of medidas) {
    // Soma em texto, via a mesma conversão exata que a impressão usa.
    const parcela = usdTexto(posicao.unrealized_pnl_usd);
    const numerico = parcela.replace("−", "-").replace("$", "");
    const [inteiro = "0", resto = "00"] = numerico.split(".");
    const negativo = inteiro.startsWith("-");
    const magnitude =
      BigInt(negativo ? inteiro.slice(1) : inteiro) * 100n + BigInt(resto);
    centavos += negativo ? -magnitude : magnitude;
  }
  const sinal = centavos < 0n ? "-" : "";
  const absoluto = (centavos < 0n ? -centavos : centavos)
    .toString()
    .padStart(3, "0");
  const texto = usdTexto(
    `${sinal}${absoluto.slice(0, -2)}.${absoluto.slice(-2)}`,
  );
  return {
    texto:
      envelhecidas === 0
        ? texto
        : `${texto} (${String(envelhecidas)} marcas envelhecidas fora da soma)`,
    envelhecidas,
  };
}

/** Uma barra de uso de cap, com o número ao lado — nunca só a barra. */
function BarraDeUso({
  rotulo: nome,
  chave,
  utilizacao,
  pior,
  cap,
}: Readonly<{
  rotulo: string;
  chave: string;
  utilizacao: number | null;
  pior: string;
  cap: string;
}>) {
  // Acima de 1 a barra satura visualmente mas o número continua dizendo a
  // verdade: um cap estourado não pode parecer exatamente cheio.
  const largura =
    utilizacao === null ? 0 : Math.max(0, Math.min(1, utilizacao)) * 100;
  const estourado = utilizacao !== null && utilizacao > 1;
  return (
    <div className="barra-uso" title={chave}>
      <div className="barra-uso-cabeca">
        <span className="barra-uso-rotulo">{nome}</span>
        <span
          className={
            estourado
              ? "barra-uso-valor barra-uso-valor--estourado"
              : "barra-uso-valor"
          }
        >
          {utilizacao === null ? "não medido" : pct(utilizacao)}
          {estourado ? " — acima do cap" : ""}
        </span>
      </div>
      <div
        className="barra-uso-trilho"
        role="img"
        aria-label={`${nome}: ${
          utilizacao === null ? "não medido" : pct(utilizacao)
        } do cap`}
      >
        <span
          className={
            estourado
              ? "barra-uso-preenchida barra-uso-preenchida--estourada"
              : "barra-uso-preenchida"
          }
          style={{ width: `${String(largura)}%` }}
        />
      </div>
      <p className="barra-uso-nota">
        {pior} de {cap}
      </p>
    </div>
  );
}

/**
 * O filtro de Decisões, aplicado NO CLIENTE sobre as últimas 500.
 *
 * RFC-026 D9 pedia `?outcome=` e `?condition_id=` na rota, e a medição de
 * 08/09 em produção mandou o filtro para cá: com 184 370 linhas e nenhum
 * índice em `outcome`, `WHERE outcome = 'ACCEPTED'` custa 2 595 ms a frio —
 * acima do teto de 500 ms da RFC e acima do `statement_timeout` de 1 s da
 * API, o que faria a tela padrão devolver erro em vez de demorar. Filtrar
 * aqui é o fallback que a própria D9 nomeia, e a tela diz "das últimas 500"
 * para que ninguém leia esta lista como o histórico inteiro.
 *
 * O filtro de mercado casa por nome OU por hash, sem diferenciar maiúsculas:
 * quem lê a tela procura pelo nome, quem depura procura pelo `condition_id`.
 */
export function filtrarDecisoes(
  decisoes: readonly Decision[],
  resultado: "ACCEPTED" | "REJECTED" | "todas",
  mercado: string,
): readonly Decision[] {
  const alvo = mercado.trim().toLowerCase();
  return decisoes.filter((decisao) => {
    if (resultado !== "todas" && decisao.outcome !== resultado) {
      return false;
    }
    if (alvo === "") {
      return true;
    }
    return (
      (decisao.question ?? "").toLowerCase().includes(alvo) ||
      (decisao.condition_id ?? "").toLowerCase().includes(alvo)
    );
  });
}

export interface DecisionDetail {
  readonly decision_id: number;
  readonly campos: Readonly<Record<string, unknown>>;
}

interface Loaded {
  readonly exposures: readonly Exposure[];
  readonly state: PortfolioStateSnapshot | null;
  readonly gates: GateSnapshot | null;
  readonly decisions: readonly Decision[];
  readonly positions: readonly PaperPosition[];
  readonly orders: readonly PaperOrder[];
  readonly limits: PortfolioLimits | null;
}

const EMPTY: Loaded = {
  exposures: [],
  state: null,
  gates: null,
  decisions: [],
  positions: [],
  orders: [],
  limits: null,
};

function pct(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function usd(value: number | null): string {
  return value === null ? "—" : `$${value.toFixed(2)}`;
}

/**
 * Time from now until an instant, or null when there is no instant at all.
 *
 * A market with no recorded end is NOT a market with a distant end: it is one
 * whose deadline we do not know, and the Rápidos tab keeps the two apart.
 */
export function horizonMs(endTs: string | null, now: number): number | null {
  if (endTs === null) {
    return null;
  }
  const parsed = Date.parse(endTs);
  return Number.isNaN(parsed) ? null : parsed - now;
}

export function horizonLabel(ms: number | null): string {
  if (ms === null) {
    return "sem instante";
  }
  if (ms <= 0) {
    return "vencido";
  }
  if (ms < 3_600_000) {
    return `${(ms / 60_000).toFixed(0)} min`;
  }
  if (ms < 86_400_000) {
    return `${(ms / 3_600_000).toFixed(1)} h`;
  }
  return `${(ms / 86_400_000).toFixed(1)} d`;
}

function numeric(value: string | null): number | null {
  if (value === null || value.trim() === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Cost of entering and leaving immediately, per share.
 *
 * Buying at the ask and selling at the bid loses the spread once; fees and
 * slippage are charged on each leg. So: spread + 2x(fee + slippage). The
 * components are rendered next to the total precisely because this is an
 * arithmetic the operator should be able to check rather than trust — and
 * because in production today fee and slippage are 0.000000, which makes the
 * round trip exactly the spread, and that is worth being able to see.
 */
export function roundTripCost(panel: {
  spread: string | null;
  fee: string | null;
  slippage: string | null;
}): number | null {
  const spread = numeric(panel.spread);
  if (spread === null) {
    return null;
  }
  const fee = numeric(panel.fee) ?? 0;
  const slippage = numeric(panel.slippage) ?? 0;
  return spread + 2 * (fee + slippage);
}

/**
 * Client-side paging over a list the endpoint returns whole.
 *
 * The endpoints cap at 200 (panel, exposures) and 500 (decisions) and have no
 * cursor; paging here does not reduce what crosses the wire, it stops the page
 * from laying out 500 rows on every 30-second tick. The gate-measurement
 * history is the one list with real keyset paging, and it keeps it.
 */
function usePage<T>(rows: readonly T[]): {
  readonly page: readonly T[];
  readonly index: number;
  readonly pages: number;
  readonly setIndex: (next: number) => void;
} {
  const [index, setIndex] = useState(0);
  const pages = Math.max(1, Math.ceil(rows.length / ROWS_PER_PAGE));
  const clamped = Math.min(index, pages - 1);
  return {
    page: rows.slice(clamped * ROWS_PER_PAGE, (clamped + 1) * ROWS_PER_PAGE),
    index: clamped,
    pages,
    setIndex,
  };
}

/**
 * As barras "tem/precisa" de um gate (RFC-027 D5).
 *
 * Os pares vêm dos MESMOS caminhos de `metrics_json` que decidem a etiqueta —
 * não há um segundo mapa que possa divergir dela. A barra é a informação que
 * faltava para o operador distinguir "faltam 92 de 100" de "faltam 100 de 100":
 * as duas apareciam como "sem dado bastante".
 *
 * O número cru fica ao lado da barra sempre. Uma barra sozinha é uma proporção
 * sem escala, e a escala é o que se quer saber.
 */
function BarrasDoGate({ pares }: Readonly<{ pares: readonly Progresso[] }>) {
  if (pares.length === 0) {
    // Nada que conte. É o caso do G6, que não tem número nenhum — e uma barra
    // ali seria uma proporção inventada.
    return <span className="sem-nome">nada a contar</span>;
  }
  return (
    <ul className="gate-barras">
      {pares.map((par) => {
        const fracao = Math.min(par.tem / par.precisa, 1);
        return (
          <li key={par.chave}>
            <span className="gate-barra-rot" title={par.chave}>
              {par.chave}
            </span>
            <span className="bar" aria-hidden="true">
              <span
                className="bar-fill"
                style={{ width: `${String(fracao * 100)}%` }}
              />
            </span>
            <span className="gate-barra-val">
              {par.tem % 1 === 0
                ? String(par.tem)
                : par.tem.toFixed(1).replace(".", ",")}
              /{String(par.precisa)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function Pager({
  index,
  pages,
  total,
  onChange,
  label,
}: Readonly<{
  index: number;
  pages: number;
  total: number;
  onChange: (next: number) => void;
  label: string;
}>) {
  if (total === 0) {
    return null;
  }
  return (
    <nav className="pager" aria-label={label}>
      <button
        type="button"
        disabled={index === 0}
        onClick={() => {
          onChange(index - 1);
        }}
      >
        Anterior
      </button>
      <span>
        Página {String(index + 1)} de {String(pages)} · {String(total)} linhas
      </span>
      <button
        type="button"
        disabled={index >= pages - 1}
        onClick={() => {
          onChange(index + 1);
        }}
      >
        Próxima
      </button>
    </nav>
  );
}

export function PortfolioPanel({
  accessToken,
  onUnauthorized,
  sections = TODAS_AS_SECOES,
  rotulo: rotuloDaTela,
}: Readonly<{
  accessToken: string;
  onUnauthorized: () => void;
  /** Quais seções esta tela mostra — e, por consequência, o que ela busca. */
  sections?: readonly Section[];
  rotulo?: string;
}>) {
  const engenheiro = useModoEngenheiro();
  const primeira: Section = sections[0] ?? "exposicao";
  const [section, setSection] = useState<Section>(primeira);
  const [data, setData] = useState<Loaded>(EMPTY);
  const [failed, setFailed] = useState(false);
  const mounted = useRef(true);

  // The query space keeps its own state: it is a deliberate query, not part of
  // the 30-second refresh, so paging through months of measurements is not
  // yanked back to page one by a timer.
  const [filters, setFilters] = useState<MeasurementFilters>(NO_FILTERS);
  const [cursors, setCursors] = useState<readonly string[]>([]);
  const [measurements, setMeasurements] = useState<GateMeasurementPage | null>(
    null,
  );
  const [measurementsFailed, setMeasurementsFailed] = useState(false);

  const [filtroOrdens, setFiltroOrdens] = useState<
    "abertas" | "encerradas" | "todas"
  >("abertas");

  // RFC-026 D9/P5: o padrão é Aceitas. É o filtro que o proprietário aprovou
  // e é o único que torna a tela legível — no ritmo medido em 08/09 (143
  // aceites contra 18 931 recusas em 24 h) a lista sem filtro é recusa pura.
  const [filtroResultado, setFiltroResultado] = useState<
    "ACCEPTED" | "REJECTED" | "todas"
  >("ACCEPTED");
  const [filtroMercado, setFiltroMercado] = useState("");
  const [decisaoAberta, setDecisaoAberta] = useState<number | null>(null);
  const [detalhe, setDetalhe] = useState<DecisionDetail | null>(null);
  const [detalheFalhou, setDetalheFalhou] = useState(false);

  // Um relógio por tique de atualização, e não `Date.now()` dentro do render:
  // a idade impressa em cada cartão tem de ser a mesma para todos e tem de
  // mudar quando os dados mudam, não a cada repintura do React.
  const [agoraMs, setAgoraMs] = useState(() => Date.now());

  const ordensVisiveis = data.orders.filter((ordem) =>
    filtroOrdens === "todas"
      ? true
      : filtroOrdens === "abertas"
        ? STATUS_ABERTO.includes(ordem.status ?? "")
        : !STATUS_ABERTO.includes(ordem.status ?? ""),
  );

  const decisoesFiltradas = filtrarDecisoes(
    data.decisions,
    filtroResultado,
    filtroMercado,
  );

  const decisoes = usePage(decisoesFiltradas);

  const refresh = useCallback(async (): Promise<void> => {
    const controller = new AbortController();
    const timeout = window.setTimeout(
      () => controller.abort(),
      REQUEST_TIMEOUT_MS,
    );
    const signal = controller.signal;
    // Só o que a tela mostra. `estado` também carrega a exposição porque o
    // cabeçalho do estado mostra a banca contra os caps; o resto é um por um.
    const quer = (secao: Section): boolean => sections.includes(secao);
    // As barras de uso de cap ficam na seção de posições, então `/exposure` e
    // `/portfolio/limits` viajam com ela — e só com ela. A Carteira gasta 5
    // requisições por tique de 30 s (10/min); a Mesa gasta as outras, e as
    // duas nunca estão abertas ao mesmo tempo.
    const querBarras = quer("posicoes") || quer("exposicao");
    const [exposures, state, gates, decisions, positions, orders, limits] =
      await Promise.all([
        querBarras ? fetchExposures(accessToken, fetch, signal) : null,
        quer("estado") ? fetchPortfolioState(accessToken, fetch, signal) : null,
        quer("gates") ? fetchGates(accessToken, fetch, signal) : null,
        quer("decisoes") ? fetchDecisions(accessToken, fetch, signal) : null,
        quer("posicoes")
          ? fetchPaperPositions(accessToken, fetch, signal)
          : null,
        quer("ordens") ? fetchPaperOrders(accessToken, fetch, signal) : null,
        quer("posicoes") ? fetchLimits(accessToken, fetch, signal) : null,
      ]);
    window.clearTimeout(timeout);
    if (!mounted.current) {
      return;
    }
    const results = [
      exposures,
      state,
      gates,
      decisions,
      positions,
      orders,
      limits,
    ].filter((result) => result !== null);
    if (results.some((result) => result.kind === "unauthorized")) {
      onUnauthorized();
      return;
    }
    setFailed(
      results.length > 0 && results.every((result) => result.kind === "error"),
    );
    setAgoraMs(Date.now());
    setData((atual) => ({
      exposures: exposures?.kind === "ok" ? exposures.value : atual.exposures,
      state: state?.kind === "ok" ? state.value : atual.state,
      gates: gates?.kind === "ok" ? gates.value : atual.gates,
      decisions: decisions?.kind === "ok" ? decisions.value : atual.decisions,
      positions: positions?.kind === "ok" ? positions.value : atual.positions,
      orders: orders?.kind === "ok" ? orders.value : atual.orders,
      limits: limits?.kind === "ok" ? limits.value : atual.limits,
    }));
  }, [accessToken, onUnauthorized, sections]);

  const loadMeasurements = useCallback(async (): Promise<void> => {
    const cursor = cursors[cursors.length - 1];
    const controller = new AbortController();
    const timeout = window.setTimeout(
      () => controller.abort(),
      REQUEST_TIMEOUT_MS,
    );
    const result = await fetchGateMeasurements(
      accessToken,
      {
        ...(filters.gate === "" ? {} : { gate: filters.gate }),
        ...(filters.status === "" ? {} : { status: filters.status }),
        ...(filters.from === "" ? {} : { from: `${filters.from}T00:00:00Z` }),
        ...(filters.to === "" ? {} : { to: `${filters.to}T23:59:59Z` }),
        limit: PAGE_SIZE,
        ...(cursor === undefined ? {} : { cursor }),
      },
      fetch,
      controller.signal,
    );
    window.clearTimeout(timeout);
    if (!mounted.current) {
      return;
    }
    if (result.kind === "unauthorized") {
      onUnauthorized();
      return;
    }
    setMeasurementsFailed(result.kind === "error");
    setMeasurements(result.kind === "ok" ? result.value : null);
  }, [accessToken, cursors, filters, onUnauthorized]);

  useEffect(() => {
    if (section !== "consulta") {
      return;
    }
    void loadMeasurements();
  }, [section, loadMeasurements]);

  // O detalhe é uma leitura DELIBERADA, fora do tique de 30 s: abre quando se
  // escolhe uma decisão e não volta a bater na rota enquanto ela fica aberta.
  useEffect(() => {
    if (decisaoAberta === null) {
      setDetalhe(null);
      setDetalheFalhou(false);
      return;
    }
    let vivo = true;
    void (async () => {
      const resultado = await fetchDecision(accessToken, decisaoAberta);
      if (!vivo) {
        return;
      }
      if (resultado.kind === "unauthorized") {
        onUnauthorized();
        return;
      }
      setDetalheFalhou(resultado.kind === "error");
      setDetalhe(
        resultado.kind === "ok"
          ? { decision_id: decisaoAberta, campos: resultado.value }
          : null,
      );
    })();
    return () => {
      vivo = false;
    };
  }, [accessToken, decisaoAberta, onUnauthorized]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const interval = window.setInterval(() => {
      void refresh();
    }, REFRESH_MS);
    return () => {
      mounted.current = false;
      window.clearInterval(interval);
    };
  }, [refresh]);

  const stateRow = data.state?.state ?? null;

  return (
    <section
      className="panel"
      aria-label={rotuloDaTela ?? "Motor de portfólio"}
    >
      <p className="scope">
        <strong>SIMULAÇÃO — SEM EXECUÇÃO REAL.</strong> Nenhuma ordem real é
        criada. Não existe stop-loss: um livro binário pode saltar de preço alto
        para perto de zero sem negociar os níveis intermediários, então o
        dimensionamento assume perda total da posição.
      </p>

      {stateRow === null ? null : (
        <p className="scope" data-state={stateRow.state}>
          Estado do portfólio:{" "}
          <Badge codigo={stateRow.state} dicionario={ESTADO_PORTFOLIO} />
          {stateRow.reason === null ? "" : ` — ${stateRow.reason}`}. Banca{" "}
          {usd(stateRow.bankroll_usd)}, equity {usd(stateRow.equity_usd)},
          drawdown {pct(stateRow.drawdown)}. Os mesmos números estão na faixa
          acima, em todas as abas.
        </p>
      )}

      {sections.length < 2 ? null : (
        <nav className="tabs" aria-label="Seções desta tela">
          {sections.map((key) => (
            <button
              key={key}
              type="button"
              className={section === key ? "tab tab--active" : "tab"}
              onClick={() => {
                setSection(key);
              }}
            >
              {ROTULO_DA_SECAO[key]}
            </button>
          ))}
        </nav>
      )}

      {failed ? (
        <p className="scope">
          Não foi possível carregar os dados do portfólio. O motor pode não
          estar ativo ainda.
        </p>
      ) : null}

      {section === "posicoes" ? (
        <>
          <p className="scope">
            {(() => {
              const abertas = data.positions.filter(posicaoAberta);
              const total = totalNaoRealizado(data.positions);
              return (
                <>
                  <strong>{String(abertas.length)}</strong> posição(ões)
                  aberta(s) de {String(data.positions.length)} linha(s) na
                  carteira. PnL não realizado somado:{" "}
                  <strong>{total.texto}</strong>. O número vem do servidor
                  posição por posição; uma marca envelhecida fica fora da soma
                  em vez de entrar como zero.
                </>
              );
            })()}
          </p>

          {data.positions.length === 0 ? (
            <p className="scope">
              Nenhuma posição na carteira paper. A tabela existe e está vazia —
              não é falha de carregamento.
            </p>
          ) : (
            <div className="cartoes-posicao">
              {[...data.positions]
                // Abertas primeiro: uma posição encerrada é histórico, e
                // histórico não disputa o topo da tela com o que está de pé.
                .sort(
                  (a, b) => Number(posicaoAberta(b)) - Number(posicaoAberta(a)),
                )
                .map((posicao) => (
                  <CartaoPosicao
                    key={posicao.token_id}
                    posicao={posicao}
                    agoraMs={agoraMs}
                  />
                ))}
            </div>
          )}

          <h4 className="secao-titulo">Uso dos caps</h4>
          {data.exposures.length === 0 ? (
            <p className="scope">
              Nenhuma dimensão de exposição registrada — não medido.
            </p>
          ) : (
            <div className="barras-uso">
              {data.exposures.map((exposure) => (
                <BarraDeUso
                  key={`${exposure.dimension}:${exposure.dimension_key}`}
                  rotulo={exposure.dimension}
                  chave={exposure.dimension_key}
                  utilizacao={exposure.utilization}
                  pior={usd(exposure.worst_case_usd)}
                  cap={usd(exposure.cap_usd)}
                />
              ))}
            </div>
          )}
          <p className="scope">
            Todo valor de cap assume <strong>perda total</strong> da posição,
            nunca marcação a mercado.{" "}
            {data.limits?.config === null || data.limits === null ? (
              <>Os limites da config não foram medidos.</>
            ) : (
              <>
                Config vigente{" "}
                <code>{data.limits.config.config_version ?? "não medida"}</code>
                : edge mínimo {data.limits.config.edgeLiqMin ?? "não medido"},
                margem de segurança{" "}
                {data.limits.config.safetyMarginMin ?? "não medido"}.
              </>
            )}
          </p>
        </>
      ) : null}

      {section === "ordens" ? (
        <>
          <nav className="chips" aria-label="Filtro de ordens">
            {(["abertas", "encerradas", "todas"] as const).map((chave) => (
              <button
                key={chave}
                type="button"
                className={filtroOrdens === chave ? "chip chip--ativo" : "chip"}
                onClick={() => {
                  setFiltroOrdens(chave);
                }}
              >
                {chave === "abertas"
                  ? "Abertas"
                  : chave === "encerradas"
                    ? "Encerradas"
                    : "Todas"}
              </button>
            ))}
          </nav>
          <table className="grid grid--compacta">
            <caption>
              Ordens do broker paper. &quot;Fila à frente&quot; é o tamanho que
              estava na frente no momento do aceite, e é{" "}
              <strong>conservador</strong>: a ordem entra atrás de todo o
              tamanho visível no nível, e cancelamentos à frente nunca a
              melhoram.
            </caption>
            <thead>
              <tr>
                <th scope="col">Mercado</th>
                <th scope="col">Lado</th>
                <th scope="col">Tipo</th>
                <th scope="col">Preço limite</th>
                <th scope="col">Tamanho</th>
                <th scope="col">Executado</th>
                <th scope="col">Fila à frente</th>
                <th scope="col">Situação</th>
              </tr>
            </thead>
            <tbody>
              {ordensVisiveis.map((ordem) => (
                <tr key={ordem.order_id}>
                  <td
                    className={ordem.question === null ? "sem-nome" : undefined}
                    title={`${ordem.order_id}${
                      ordem.condition_id === null
                        ? ""
                        : ` · ${ordem.condition_id}`
                    }`}
                  >
                    {ordem.question ?? "sem nome"}
                  </td>
                  <td title={ordem.side ?? undefined}>
                    {rotulo(ordem.side, LADO)}
                  </td>
                  <td>{ordem.order_type ?? "—"}</td>
                  <td>{quantidadeTexto(ordem.limit_price)}</td>
                  <td>{quantidadeTexto(ordem.size)}</td>
                  <td>{quantidadeTexto(ordem.filled_size)}</td>
                  {/* "não medido" em cinza, nunca 0: uma fila desconhecida e
                      uma fila vazia levam a decisões opostas. */}
                  <td
                    className={
                      ordem.queue_ahead === null
                        ? "valor-nao-medido"
                        : undefined
                    }
                  >
                    {ordem.queue_ahead === null
                      ? "não medido"
                      : quantidadeTexto(ordem.queue_ahead)}
                  </td>
                  <td>{ordem.status ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {ordensVisiveis.length === 0 ? (
            <p className="scope">
              Nenhuma ordem neste filtro. A rota devolve no máximo 200 ordens,
              das mais recentes.
            </p>
          ) : null}
        </>
      ) : null}

      {section === "exposicao" ? (
        <table className="grid">
          <caption>
            Exposição por dimensão. Todo valor assume{" "}
            <strong>perda total</strong> da posição, nunca marcação a mercado.
          </caption>
          <thead>
            <tr>
              <th scope="col">Dimensão</th>
              <th scope="col">Chave</th>
              <th scope="col">Pior caso</th>
              <th scope="col">Cap</th>
              <th scope="col">Uso</th>
              <th scope="col">Posições</th>
              <th scope="col">Custo de unwind</th>
            </tr>
          </thead>
          <tbody>
            {data.exposures.map((exposure) => (
              <tr key={`${exposure.dimension}:${exposure.dimension_key}`}>
                <td>{exposure.dimension}</td>
                <td>{exposure.dimension_key.slice(0, 24)}</td>
                <td>{usd(exposure.worst_case_usd)}</td>
                <td>{usd(exposure.cap_usd)}</td>
                <td>{pct(exposure.utilization)}</td>
                <td>{exposure.position_count ?? "—"}</td>
                <td>{usd(exposure.unwind_cost_usd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      {section === "estado" ? (
        <>
          <table className="grid">
            <caption>Transições de estado (append-only).</caption>
            <thead>
              <tr>
                <th scope="col">De</th>
                <th scope="col">Para</th>
                <th scope="col">Motivo</th>
                <th scope="col">Gatilho</th>
                <th scope="col">Quando</th>
              </tr>
            </thead>
            <tbody>
              {(data.state?.transitions ?? []).map((transition, index) => (
                <tr key={`${transition.at ?? "?"}-${String(index)}`}>
                  <td>
                    <Badge
                      codigo={transition.from_state}
                      dicionario={ESTADO_PORTFOLIO}
                    />
                  </td>
                  <td>
                    <Badge
                      codigo={transition.to_state}
                      dicionario={ESTADO_PORTFOLIO}
                    />
                  </td>
                  <td>{transition.reason ?? "—"}</td>
                  <td title={transition.trigger_source ?? undefined}>
                    {rotulo(transition.trigger_source, GATILHO_TRANSICAO)}
                  </td>
                  <td>{transition.at ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {(data.state?.transitions ?? []).length === 0 ? (
            <p className="scope">
              Nenhuma transição registrada — o portfólio nunca saiu de{" "}
              <code>NORMAL</code>.
            </p>
          ) : null}
          <p className="scope">
            <code>HALTED</code> não sai sozinho: nem com drawdown recuperado,
            nem com janela expirada, nem com restart. Só com ação manual do
            proprietário, feita por dentro — o perímetro não publica o endpoint.
          </p>
        </>
      ) : null}

      {section === "gates" ? (
        <>
          <p className="scope">
            RFC-009:{" "}
            <Badge
              codigo={data.gates?.rfc009Status ?? "BLOCKED"}
              dicionario={STATUS_RFC009}
            />{" "}
            {data.gates?.calibratedExpectation ?? ""}
          </p>
          {/* RFC-027 D5. A coluna "Natureza" existe porque os seis gates
              apareciam com o mesmo rótulo — "Sem dado bastante" — por quatro
              razões diferentes, e a diferença muda o que o operador faz: um
              espera um relógio com data, outro espera uma correção, outro
              espera uma decisão dele. A etiqueta é decidida pelos NÚMEROS de
              `metrics_json`, nunca pelo nome do gate. */}
          <table className="grid">
            <caption>
              Gates G1–G6. <code>INSUFFICIENT_DATA</code> não é o mesmo que{" "}
              <code>FAIL</code>: um é &quot;ainda não medimos o bastante&quot;,
              o outro é &quot;medimos e não funcionou&quot;. A coluna{" "}
              <strong>Natureza</strong> diz o que destrava cada um.
            </caption>
            <thead>
              <tr>
                <th scope="col">Gate</th>
                <th scope="col">Situação</th>
                <th scope="col">Natureza</th>
                <th scope="col">Falta</th>
                <th scope="col">Motivo</th>
                <th scope="col">Medido em</th>
              </tr>
            </thead>
            <tbody>
              {(data.gates?.gates ?? []).map((gate) => {
                const g2Clock = data.gates?.g2Clock ?? [];
                const natureza = naturezaDoBloqueio(
                  gate.gate,
                  gate.status,
                  gate.metrics,
                  g2Clock,
                );
                const data_ = dataDoRelogio(gate.metrics, g2Clock);
                const reinicio = g2Clock.find(
                  (linha) => linha.last_reset_reason !== null,
                )?.last_reset_reason;
                return (
                  <tr key={gate.gate}>
                    <th scope="row" title={consequencia(gate.gate, GATE)}>
                      {rotulo(gate.gate, GATE)}
                    </th>
                    <td>
                      <Badge codigo={gate.status} dicionario={SITUACAO_GATE} />
                    </td>
                    <td>
                      {natureza === null ? (
                        "—"
                      ) : (
                        <>
                          <Badge
                            codigo={natureza}
                            dicionario={NATUREZA_BLOQUEIO}
                          />
                          {/* A data do relógio é o que separa "esperando" de
                              "travado". Ela vem de `clock_start + required_days`,
                              e some junto com o relógio. */}
                          {data_ === null ? null : (
                            <div className="gate-data">
                              até {data_.replace("T", " ").slice(0, 19)}Z
                              {reinicio === undefined || reinicio === null
                                ? ""
                                : ` · reiniciado por ${reinicio}`}
                            </div>
                          )}
                        </>
                      )}
                    </td>
                    <td>
                      <BarrasDoGate
                        pares={progressoDoGate(gate.gate, gate.metrics)}
                      />
                    </td>
                    <td title={consequencia(gate.reason_code, MOTIVO_GATE)}>
                      {rotulo(gate.reason_code, MOTIVO_GATE)}
                    </td>
                    <td>{gate.measured_at ?? "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      ) : null}

      {section === "consulta" ? (
        <>
          <p className="scope">
            Espaço de consulta do histórico de medições de gate. Substitui o
            relatório semanal: os mesmos números, consultados quando você
            quiser. A tabela <code>portfolio_gate_measurements</code> é imutável
            e nunca é podada — é a trilha de evidência de qualquer decisão
            futura sobre a RFC-009.
          </p>

          <form
            className="filters"
            aria-label="Filtros da consulta"
            onSubmit={(event) => {
              event.preventDefault();
              setCursors([]);
            }}
          >
            <label>
              Gate
              <select
                value={filters.gate}
                onChange={(event) => {
                  setCursors([]);
                  setFilters((current) => ({
                    ...current,
                    gate: event.target.value,
                  }));
                }}
              >
                <option value="">todos</option>
                {GATE_OPTIONS.map((gate) => (
                  <option key={gate} value={gate}>
                    {gate}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Situação
              <select
                value={filters.status}
                onChange={(event) => {
                  setCursors([]);
                  setFilters((current) => ({
                    ...current,
                    status: event.target.value,
                  }));
                }}
              >
                <option value="">todas</option>
                {STATUS_OPTIONS.map((status) => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ))}
              </select>
            </label>
            <label>
              De
              <input
                type="date"
                value={filters.from}
                onChange={(event) => {
                  setCursors([]);
                  setFilters((current) => ({
                    ...current,
                    from: event.target.value,
                  }));
                }}
              />
            </label>
            <label>
              Até
              <input
                type="date"
                value={filters.to}
                onChange={(event) => {
                  setCursors([]);
                  setFilters((current) => ({
                    ...current,
                    to: event.target.value,
                  }));
                }}
              />
            </label>
            <button
              type="button"
              onClick={() => {
                setCursors([]);
                setFilters(NO_FILTERS);
              }}
            >
              Limpar
            </button>
          </form>

          {measurementsFailed ? (
            <p className="scope">
              Não foi possível carregar o histórico de medições.
            </p>
          ) : null}

          <table className="grid">
            <caption>
              Medições de gate, da mais recente para a mais antiga.{" "}
              <code>INSUFFICIENT_DATA</code> não é <code>FAIL</code>: um é
              &quot;ainda não medimos o bastante&quot;, o outro é &quot;medimos
              e não funcionou&quot;.
            </caption>
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Gate</th>
                <th scope="col">Situação</th>
                <th scope="col">Motivo</th>
                <th scope="col">Números</th>
                <th scope="col">Janela</th>
                <th scope="col">Medido em</th>
                <th scope="col">Config</th>
              </tr>
            </thead>
            <tbody>
              {(measurements?.measurements ?? []).map((measurement) => (
                <tr
                  key={String(
                    measurement.measurement_id ??
                      `${measurement.gate}-${measurement.measured_at ?? "?"}`,
                  )}
                >
                  <td>{measurement.measurement_id ?? "—"}</td>
                  <td>{measurement.gate}</td>
                  <td>
                    <Badge
                      codigo={measurement.status}
                      dicionario={SITUACAO_GATE}
                    />
                  </td>
                  <td
                    title={consequencia(measurement.reason_code, MOTIVO_GATE)}
                  >
                    {rotulo(measurement.reason_code, MOTIVO_GATE)}
                  </td>
                  <td>
                    {/* RFC-027 D6/aceite 5: o resumo legível fica sempre; o
                        JSON cru passa a exigir o modo engenheiro (tecla `?`).
                        Nada se perde — este é o espaço de consulta e a
                        evidência continua a uma tecla de distância —, mas o
                        padrão da tela deixa de ser um despejo de JSON. */}
                    {engenheiro ? (
                      <details>
                        <summary>{metricSummary(measurement.metrics)}</summary>
                        <pre>
                          {JSON.stringify(measurement.metrics, null, 2)}
                        </pre>
                      </details>
                    ) : (
                      metricSummary(measurement.metrics)
                    )}
                  </td>
                  <td>
                    {measurement.window_from ?? "—"} →{" "}
                    {measurement.window_to ?? "—"}
                  </td>
                  <td>{measurement.measured_at ?? "—"}</td>
                  <td>{measurement.config_version ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <nav className="pager" aria-label="Paginação das medições">
            <button
              type="button"
              disabled={cursors.length === 0}
              onClick={() => {
                setCursors((current) => current.slice(0, -1));
              }}
            >
              Página anterior
            </button>
            <span>
              Página {String(cursors.length + 1)} ·{" "}
              {String((measurements?.measurements ?? []).length)} medições
            </span>
            <button
              type="button"
              disabled={(measurements?.nextCursor ?? null) === null}
              onClick={() => {
                const next = measurements?.nextCursor ?? null;
                if (next !== null) {
                  setCursors((current) => [...current, next]);
                }
              }}
            >
              Próxima página
            </button>
          </nav>

          <p className="scope">{measurements?.calibratedExpectation ?? ""}</p>
        </>
      ) : null}

      {section === "decisoes" ? (
        <>
          <p className="scope">
            Ordenado por <code>decision_id</code>, que é a ordem de inserção e é
            total. Ordenar por <code>decision_ts</code> varria a tabela inteira
            — não há índice só nele — e empatava entre decisões do mesmo ciclo.
            A medição que motivou a troca está na RFC-015 §3, com data.
          </p>

          <div className="filtros-decisao">
            <nav className="chips" aria-label="Filtro por resultado">
              {(["ACCEPTED", "REJECTED", "todas"] as const).map((chave) => (
                <button
                  key={chave}
                  type="button"
                  className={
                    filtroResultado === chave ? "chip chip--ativo" : "chip"
                  }
                  onClick={() => {
                    setFiltroResultado(chave);
                    setDecisaoAberta(null);
                  }}
                >
                  {chave === "todas"
                    ? "Todas"
                    : rotulo(chave, RESULTADO_DECISAO)}
                </button>
              ))}
            </nav>
            <label className="filtro-campo">
              <span>Mercado</span>
              <input
                type="search"
                value={filtroMercado}
                placeholder="nome ou condition_id"
                onChange={(evento) => {
                  setFiltroMercado(evento.target.value);
                  setDecisaoAberta(null);
                }}
              />
            </label>
          </div>

          {/* O aviso é obrigatório e não é decorativo: sem ele a tela deixa
              ler "3 aceites" como "3 aceites que existem", quando o que ela
              mostra é "3 nas últimas 500 decisões" — cerca de 26 min no ritmo
              atual. A medição que pôs o filtro no cliente está na D9. */}
          <p className="scope">
            Filtro aplicado <strong>no cliente</strong>, sobre as{" "}
            <strong>últimas {String(data.decisions.length)}</strong> decisões
            que a rota devolve —{" "}
            <strong>{String(decisoesFiltradas.length)}</strong> casam.{" "}
            <strong>Não é o histórico inteiro.</strong> Filtrar no servidor
            exigiria um índice em <code>outcome</code> que não existe; sem ele a
            consulta passa do limite de tempo da própria API e a tela devolveria
            erro em vez de demorar. A medição está na RFC-026 D9, com data.
          </p>
          <table className="grid grid--compacta">
            <caption>
              Decision log. Toda decisão registra o limitador que a limitou e o
              hash da config vigente.
            </caption>
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Tipo</th>
                <th scope="col">Mercado</th>
                <th scope="col">Lado</th>
                <th scope="col">Edge líq.</th>
                <th scope="col">Tamanho</th>
                <th scope="col">Limitador</th>
                <th scope="col">Resultado</th>
                <th scope="col">Motivo</th>
                <th scope="col">Ordem paper</th>
                <th scope="col">Detalhe</th>
              </tr>
            </thead>
            <tbody>
              {decisoes.page.map((decision, index) => (
                // decision_id is the primary key and is present on every row
                // the endpoint returns. The old fallback was Math.random(),
                // which gave every row a new key on every render and made React
                // rebuild the whole table 500 rows at a time; the index is a
                // stable fallback for the row that somehow has no id.
                <tr
                  key={
                    decision.decision_id === null
                      ? `sem-id-${String(index)}`
                      : String(decision.decision_id)
                  }
                >
                  <td>{decision.decision_id ?? "—"}</td>
                  <td title={decision.decision_kind ?? undefined}>
                    {rotulo(decision.decision_kind, TIPO_DECISAO)}
                  </td>
                  <td
                    className={
                      decision.question === null ? "sem-nome" : undefined
                    }
                    title={`${decision.condition_id ?? "sem condition_id"}${
                      decision.category === null
                        ? ""
                        : ` · ${rotulo(decision.category, CATEGORIA)}`
                    }`}
                  >
                    {decision.question ?? "sem nome"}
                  </td>
                  <td title={decision.market_side ?? undefined}>
                    {rotulo(decision.market_side, LADO)}
                  </td>
                  <td>{decision.edge_net ?? "—"}</td>
                  <td>{decision.size_shares ?? "—"}</td>
                  <td
                    title={consequencia(decision.binding_constraint, LIMITADOR)}
                  >
                    {rotulo(decision.binding_constraint, LIMITADOR)}
                  </td>
                  <td>
                    <Badge
                      codigo={decision.outcome}
                      dicionario={RESULTADO_DECISAO}
                    />
                  </td>
                  <td
                    title={consequencia(decision.reason_code, MOTIVO_DECISAO)}
                  >
                    {rotulo(decision.reason_code, MOTIVO_DECISAO)}
                  </td>
                  {/* Um aceite sem ordem é o caso que a D7 põe no bloco de
                      ação da Mesa; aqui ele fica explícito linha por linha.
                      Uma recusa não tem ordem por construção, e a célula fica
                      vazia em vez de dizer "sem ordem" e soar como defeito. */}
                  <td>
                    {decision.outcome === "ACCEPTED" ? (
                      decision.paper_order_id === null ? (
                        <span className="badge badge--atencao">sem ordem</span>
                      ) : (
                        String(decision.paper_order_id)
                      )
                    ) : (
                      ""
                    )}
                  </td>
                  <td>
                    {decision.decision_id === null ? (
                      "—"
                    ) : (
                      <button
                        type="button"
                        className="link-detalhe"
                        aria-expanded={decisaoAberta === decision.decision_id}
                        onClick={() => {
                          setDecisaoAberta(
                            decisaoAberta === decision.decision_id
                              ? null
                              : decision.decision_id,
                          );
                        }}
                      >
                        {decisaoAberta === decision.decision_id
                          ? "fechar"
                          : "abrir"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pager
            index={decisoes.index}
            pages={decisoes.pages}
            total={decisoesFiltradas.length}
            onChange={decisoes.setIndex}
            label="Paginação do decision log"
          />

          {decisaoAberta === null ? null : (
            <aside className="detalhe-decisao" aria-live="polite">
              <h4>Decisão {String(decisaoAberta)}</h4>
              {detalheFalhou ? (
                <p className="scope" role="alert">
                  Não foi possível carregar esta decisão.
                </p>
              ) : detalhe === null ? (
                <p className="scope">Carregando…</p>
              ) : (
                // Par a par, cru. As colunas de `portfolio_decisions` mudam
                // com as migrations, e uma lista fixa aqui esconderia em
                // silêncio toda coluna nova — que é justamente o que quem abre
                // o detalhe está procurando.
                <dl className="detalhe-grade">
                  {Object.entries(detalhe.campos).map(([chave, valor]) => (
                    <div key={chave}>
                      <dt>{chave}</dt>
                      <dd>
                        {valor === null
                          ? "—"
                          : typeof valor === "object"
                            ? JSON.stringify(valor)
                            : String(valor)}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
            </aside>
          )}
        </>
      ) : null}
    </section>
  );
}
