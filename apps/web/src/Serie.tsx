// RFC-026 D10 (PR 3) — o primeiro gráfico de preço do painel, em SVG próprio.
//
// Sem biblioteca, por decisão P4 do proprietário: zero dependência nova em
// `apps/web`. São dois desenhos sobre a mesma série de `polymarket_series_1m`:
// o sparkline de 60 buckets que vai numa célula da Mesa, e o gráfico do detalhe
// com a banda `mid_low`/`mid_high` e as marcas do que o motor fez.
//
// Três regras que valem nos dois (D3):
//
//  - Ausência NUNCA é zero. Bucket sem mid é lacuna: a linha se parte, e uma
//    série inteira sem dado escreve "sem série" em cinza. Uma linha no zero
//    diria "o preço caiu a zero", que é uma frase diferente e falsa.
//  - Livro congelado é uma LINHA RETA, e ela aparece. É informação — o mercado
//    parou de se mover —, então o eixo ganha uma folga artificial para a reta
//    não colapsar na borda e sumir.
//  - Verde/vermelho só aqui e no PnL, e nunca só cor: quem lê o sparkline por
//    cor tem a mesma palavra no `aria-label` e no `title`.
//
// O dinheiro chega em TEXTO decimal e é convertido para número só para virar
// coordenada. A conversão morre dentro deste arquivo; nada daqui volta para a
// tela como número.

import type { Decision, SeriesPoint } from "./portfolio";
import type { PaperPosition } from "./paper";

/** Um ponto já reduzido a números, ou `null` se o bucket não tem mid. */
interface Ponto {
  readonly t: number;
  readonly close: number;
  readonly low: number;
  readonly high: number;
}

function numero(texto: string | null): number | null {
  if (texto === null) {
    return null;
  }
  const valor = Number(texto);
  return Number.isFinite(valor) ? valor : null;
}

/**
 * Converte a série em pontos desenháveis, descartando bucket sem `mid_close`.
 *
 * `mid_low`/`mid_high` caem para o próprio close quando faltam: a banda some
 * naquele ponto em vez de virar uma faixa até o zero.
 */
export function pontos(serie: readonly SeriesPoint[]): readonly Ponto[] {
  const saida: Ponto[] = [];
  for (const bucket of serie) {
    const close = numero(bucket.mid_close);
    const t = Date.parse(bucket.bucket_start);
    if (close === null || Number.isNaN(t)) {
      continue;
    }
    saida.push({
      t,
      close,
      low: numero(bucket.mid_low) ?? close,
      high: numero(bucket.mid_high) ?? close,
    });
  }
  return saida;
}

export type Direcao = "alta" | "baixa" | "estavel";

export function direcao(pts: readonly Ponto[]): Direcao {
  const primeiro = pts[0];
  const ultimo = pts[pts.length - 1];
  if (primeiro === undefined || ultimo === undefined) {
    return "estavel";
  }
  if (ultimo.close > primeiro.close) {
    return "alta";
  }
  return ultimo.close < primeiro.close ? "baixa" : "estavel";
}

interface Escala {
  readonly x: (t: number) => number;
  readonly y: (v: number) => number;
  readonly min: number;
  readonly max: number;
}

/**
 * Escala com folga mínima no eixo do preço.
 *
 * Sem a folga, uma série constante teria `min === max` e toda divisão viraria
 * `0/0`; com ela, o livro congelado desenha a reta no meio da caixa, que é
 * exatamente o que se quer ver.
 */
function escalar(
  pts: readonly Ponto[],
  largura: number,
  altura: number,
  margem: { readonly x: number; readonly y: number },
  usarBanda: boolean,
): Escala | null {
  const primeiro = pts[0];
  const ultimo = pts[pts.length - 1];
  if (primeiro === undefined || ultimo === undefined) {
    return null;
  }
  let min = Infinity;
  let max = -Infinity;
  for (const p of pts) {
    min = Math.min(min, usarBanda ? p.low : p.close);
    max = Math.max(max, usarBanda ? p.high : p.close);
  }
  const centro = (min + max) / 2;
  const meia = Math.max((max - min) / 2, 0.0005);
  min = centro - meia;
  max = centro + meia;

  const t0 = primeiro.t;
  const t1 = ultimo.t;
  const spanT = t1 - t0;
  const util = largura - margem.x * 2;
  const alturaUtil = altura - margem.y * 2;
  return {
    x: (t) => margem.x + (spanT === 0 ? util / 2 : ((t - t0) / spanT) * util),
    y: (v) => margem.y + (1 - (v - min) / (max - min)) * alturaUtil,
    min,
    max,
  };
}

/**
 * Quebra os pontos em trechos contíguos.
 *
 * Um buraco maior que `lacunaMs` vira um corte: o SVG desenha dois `polyline`
 * e não uma reta atravessando as horas em que a série não existiu.
 */
function trechos(
  pts: readonly Ponto[],
  lacunaMs: number,
): readonly (readonly Ponto[])[] {
  const saida: Ponto[][] = [];
  let atual: Ponto[] = [];
  let anterior: number | null = null;
  for (const p of pts) {
    if (anterior !== null && p.t - anterior > lacunaMs) {
      saida.push(atual);
      atual = [];
    }
    atual.push(p);
    anterior = p.t;
  }
  if (atual.length > 0) {
    saida.push(atual);
  }
  return saida;
}

function caminho(trecho: readonly Ponto[], escala: Escala): string {
  return trecho
    .map((p) => `${escala.x(p.t).toFixed(1)},${escala.y(p.close).toFixed(1)}`)
    .join(" ");
}

const SPARK_W = 84;
const SPARK_H = 22;
/** Dois buckets de 1 min: um buraco maior que isso é lacuna, não ruído. */
const LACUNA_MS = 2 * 60 * 1000;

/**
 * Sparkline de uma linha da Mesa: 60 buckets de `mid_close`, sem eixo.
 *
 * Decorativa para o leitor de tela — o `aria-label` diz a mesma coisa em
 * palavras, porque a cor sozinha não é informação (D3).
 */
export function Sparkline({
  serie,
  nome,
}: Readonly<{
  serie: readonly SeriesPoint[] | undefined;
  nome: string;
}>) {
  if (serie === undefined) {
    // Ainda não voltou do lote. Não é "sem série": é "ainda não sei".
    return <span className="spark spark--vazia">·</span>;
  }
  const pts = pontos(serie);
  if (pts.length === 0) {
    return (
      <span className="spark spark--vazia" title={`${nome}: sem série`}>
        sem série
      </span>
    );
  }
  const escala = escalar(pts, SPARK_W, SPARK_H, { x: 1, y: 3 }, false);
  if (escala === null) {
    return <span className="spark spark--vazia">sem série</span>;
  }
  const tom = direcao(pts);
  const primeiro = pts[0]?.close ?? 0;
  const ultimo = pts[pts.length - 1]?.close ?? 0;
  const variacao = (ultimo - primeiro).toFixed(4);
  const rotulo =
    pts.length === 1
      ? `${nome}: um bucket só`
      : `${nome}: ${tom}, ${variacao} em ${String(pts.length)} buckets`;
  return (
    <svg
      className={`spark spark--${tom}`}
      viewBox={`0 0 ${String(SPARK_W)} ${String(SPARK_H)}`}
      width={SPARK_W}
      height={SPARK_H}
      role="img"
      aria-label={rotulo}
    >
      <title>{rotulo}</title>
      {trechos(pts, LACUNA_MS).map((trecho, i) =>
        trecho.length === 1 ? (
          // Um ponto isolado não vira polyline: vira ponto, senão some.
          <circle
            key={i}
            cx={escala.x(trecho[0]?.t ?? 0)}
            cy={escala.y(trecho[0]?.close ?? 0)}
            r={1.4}
          />
        ) : (
          <polyline key={i} points={caminho(trecho, escala)} />
        ),
      )}
    </svg>
  );
}

/** Uma marca do que o motor fez, no instante em que fez. */
interface Marca {
  readonly t: number;
  readonly preco: number | null;
  readonly tipo: "aceite" | "ordem" | "fill";
  readonly texto: string;
}

const GLIFO: Readonly<Record<Marca["tipo"], string>> = {
  aceite: "▲",
  ordem: "□",
  fill: "●",
};

/**
 * As marcas de um mercado, a partir do que a Mesa JÁ carregou.
 *
 * Nada aqui pede uma requisição nova: aceites e ordens saem de `/decisions`, e
 * o fill sai de `opened_at` da posição em `/paper/positions` — que a Mesa lê
 * desde o PR 1 para a terceira frase da D7. O feed `/events` não entra: ele
 * roda só na tela Sistema, e trazê-lo para cá estouraria o teto de 20 req/min
 * do A5. O engate do kill switch vem de `overview.kill_switch`, que a faixa
 * fixa já lê.
 */
export function marcas(
  tokenId: string,
  decisoes: readonly Decision[],
  posicoes: readonly PaperPosition[],
): readonly Marca[] {
  const saida: Marca[] = [];
  for (const decisao of decisoes) {
    if (decisao.token_id !== tokenId || decisao.decision_ts === null) {
      continue;
    }
    const t = Date.parse(decisao.decision_ts);
    if (Number.isNaN(t)) {
      continue;
    }
    const preco = numero(decisao.exec_price);
    if (decisao.outcome === "ACCEPTED") {
      saida.push({ t, preco, tipo: "aceite", texto: "aceite" });
    }
    if (decisao.paper_order_id !== null) {
      saida.push({
        t,
        preco,
        tipo: "ordem",
        texto: `ordem ${String(decisao.paper_order_id)}`,
      });
    }
  }
  for (const posicao of posicoes) {
    if (posicao.token_id !== tokenId || posicao.opened_at === null) {
      continue;
    }
    const t = Date.parse(posicao.opened_at);
    if (!Number.isNaN(t)) {
      saida.push({ t, preco: null, tipo: "fill", texto: "posição aberta" });
    }
  }
  return saida;
}

const GRAF_W = 640;
const GRAF_H = 200;
const MARGEM = { x: 34, y: 12 };

function horaDe(t: number): string {
  return new Date(t).toISOString().slice(11, 16);
}

/**
 * O gráfico do detalhe: `mid_close` com a banda `mid_low`/`mid_high`.
 *
 * A janela é a da D10 reduzida para o que cabe no orçamento (12 h; ver
 * `CHART_WINDOW_MS`). Marcas e o engate do kill switch entram por cima, cada
 * um com glifo e palavra.
 */
export function GraficoSerie({
  serie,
  carregando,
  nome,
  marcasDoMercado,
  killSwitchEm,
}: Readonly<{
  serie: readonly SeriesPoint[] | null;
  carregando: boolean;
  nome: string;
  marcasDoMercado: readonly Marca[];
  killSwitchEm: string | null;
}>) {
  if (serie === null) {
    // `null` é "não perguntei ainda" — e é diferente de "perguntei e não há".
    // Escrever "sem série" aqui afirmaria uma ausência que ninguém mediu, que
    // é o mesmo erro de desenhar uma linha no zero, só em palavras.
    return (
      <p className="serie-vazia">
        {carregando ? "carregando a série…" : "série ainda não carregada"}
      </p>
    );
  }
  const pts = pontos(serie);
  if (pts.length === 0) {
    return (
      <p className="serie-vazia">
        sem série — nenhum bucket de preço para este mercado na janela
      </p>
    );
  }
  const escala = escalar(pts, GRAF_W, GRAF_H, MARGEM, true);
  if (escala === null) {
    return <p className="serie-vazia">sem série</p>;
  }
  const primeiro = pts[0];
  const ultimo = pts[pts.length - 1];
  if (primeiro === undefined || ultimo === undefined) {
    return <p className="serie-vazia">sem série</p>;
  }
  const tom = direcao(pts);
  const engate = killSwitchEm === null ? NaN : Date.parse(killSwitchEm);
  const engateVisivel =
    !Number.isNaN(engate) && engate >= primeiro.t && engate <= ultimo.t;
  const congelado = escala.max - escala.min <= 0.001;

  return (
    <figure className="serie">
      <svg
        className={`serie-svg serie-svg--${tom}`}
        viewBox={`0 0 ${String(GRAF_W)} ${String(GRAF_H)}`}
        role="img"
        aria-label={`Série de ${nome}: ${String(pts.length)} buckets, ${tom}`}
      >
        {/* Banda mid_low/mid_high por trecho contíguo, para a lacuna não virar
            uma faixa atravessando o buraco. */}
        {trechos(pts, LACUNA_MS).map((trecho, i) => {
          const cima = trecho.map(
            (p) => `${escala.x(p.t).toFixed(1)},${escala.y(p.high).toFixed(1)}`,
          );
          const baixo = [...trecho]
            .reverse()
            .map(
              (p) =>
                `${escala.x(p.t).toFixed(1)},${escala.y(p.low).toFixed(1)}`,
            );
          return (
            <polygon
              key={`banda-${String(i)}`}
              className="serie-banda"
              points={[...cima, ...baixo].join(" ")}
            />
          );
        })}
        {trechos(pts, LACUNA_MS).map((trecho, i) => (
          <polyline
            key={`linha-${String(i)}`}
            className="serie-linha"
            points={caminho(trecho, escala)}
          />
        ))}
        {engateVisivel ? (
          <line
            className="serie-engate"
            x1={escala.x(engate)}
            x2={escala.x(engate)}
            y1={MARGEM.y}
            y2={GRAF_H - MARGEM.y}
          >
            <title>kill switch engatado</title>
          </line>
        ) : null}
        {marcasDoMercado
          .filter((marca) => marca.t >= primeiro.t && marca.t <= ultimo.t)
          .map((marca, i) => (
            <text
              key={`marca-${String(i)}`}
              className={`serie-marca serie-marca--${marca.tipo}`}
              x={escala.x(marca.t)}
              // Marca sem preço (o fill não carrega um) fica na base, para não
              // fingir uma altura que não foi medida.
              y={
                marca.preco === null ? GRAF_H - MARGEM.y : escala.y(marca.preco)
              }
              textAnchor="middle"
            >
              {GLIFO[marca.tipo]}
              <title>{`${marca.texto} · ${horaDe(marca.t)}Z`}</title>
            </text>
          ))}
        <text className="serie-eixo" x={2} y={MARGEM.y + 4}>
          {escala.max.toFixed(3)}
        </text>
        <text className="serie-eixo" x={2} y={GRAF_H - MARGEM.y}>
          {escala.min.toFixed(3)}
        </text>
        <text className="serie-eixo" x={MARGEM.x} y={GRAF_H - 1}>
          {horaDe(primeiro.t)}Z
        </text>
        <text
          className="serie-eixo"
          x={GRAF_W - MARGEM.x}
          y={GRAF_H - 1}
          textAnchor="end"
        >
          {horaDe(ultimo.t)}Z
        </text>
      </svg>
      <figcaption className="serie-legenda">
        {String(pts.length)} buckets de 1 min · ▲ aceite · □ ordem · ● posição
        aberta
        {engateVisivel ? " · linha vermelha: kill switch engatado" : ""}
        {congelado
          ? " · livro parado na janela: a linha reta é o preço, não a falta dele"
          : ""}
      </figcaption>
    </figure>
  );
}
