// RFC-027 D1–D4: a tela Decisões deixa de ser a amostra e passa a ser o funil.
//
// O QUE ESTA TELA CORRIGE. Ela mostrava 500 linhas do decision log e nada mais.
// 500 linhas são ~23 minutos de log no ritmo medido em 2026-09-09 (21,6
// linhas/min), então qualquer contagem feita sobre elas responde "nos últimos 23
// minutos" a uma pergunta sobre as últimas 24 horas. A D1 é explícita: esta tela
// NÃO desenha funil de amostra. Ou existe o agregado do servidor, ou ela escreve
// "indisponível" e diz por quê.
//
// SÓ LEITURA. Nenhum gate afrouxa, nenhum disjuntor é fechado ou contornado,
// nenhuma tabela de decisão é escrita. As quatro seções são quatro GETs sobre
// rotas que já existiam.

import { useCallback, useEffect, useRef, useState } from "react";

import { Badge } from "./Overview.tsx";
import { PortfolioPanel, type Section } from "./Portfolio.tsx";
import { MOTIVO_DECISAO, TIPO_DISJUNTOR, consequencia } from "./dicionario";
import { useModoEngenheiro } from "./modo.tsx";
import type { Overview } from "./overview";
import {
  fetchLimits,
  fetchPortfolioState,
  type PortfolioLimits,
  type PortfolioStateSnapshot,
} from "./portfolio";

/** O mesmo tique das outras telas. Congeladas tem contagem regressiva, então
 * o relógio local anda mais rápido que o poll — sem gastar requisição. */
const REFRESH_MS = 30_000;
const TICK_MS = 1_000;
const REQUEST_TIMEOUT_MS = 5_000;

/**
 * As seções do painel de portfólio que esta tela monta.
 *
 * Constantes de módulo, não literais na renderização: `PortfolioPanel` busca em
 * função de `sections`, e um array novo a cada renderização reiniciaria o poll a
 * cada renderização.
 *
 * O aceite 4 exige que o carregamento PADRÃO desta tela não bata em
 * `/decisions`. É por isso que existem dois arrays e não um: com o filtro
 * desligado, a seção `decisoes` não é montada e a rota não é chamada.
 */
export const SECOES_PADRAO: readonly Section[] = ["consulta"];
export const SECOES_COM_CRUAS: readonly Section[] = ["decisoes", "consulta"];

/**
 * As buscas do carregamento padrão da tela Decisões (aceite 4).
 *
 * Exportada, e não embutida no efeito, para que o aceite possa ser verificado
 * a cada `npm test` em vez de na aba de rede: o teste chama ESTA função com um
 * `fetch` espião e afirma sobre as URLs pedidas. O componente não decide nada
 * que esta função não decida — ele a chama e guarda o resultado.
 *
 * Duas rotas, e só duas: `state` alimenta Congeladas e `limits` dá o piso de
 * edge do "Quase". O funil, o último ciclo e o "Quase" vêm do `/overview` que a
 * App já busca, então não custam requisição aqui. `/decisions` NÃO é uma
 * delas — ela devolve 500 linhas com um JOIN no registro de mercados, e
 * carregá-la a cada 30 s numa tela que abre em funil seria gastar a rota mais
 * cara do painel para mostrar o que a tela não está mostrando.
 */
export async function buscaDaTelaPadrao(
  accessToken: string,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<
  readonly [
    Awaited<ReturnType<typeof fetchPortfolioState>>,
    Awaited<ReturnType<typeof fetchLimits>>,
  ]
> {
  return Promise.all([
    fetchPortfolioState(accessToken, fetcher, signal),
    fetchLimits(accessToken, fetcher, signal),
  ]);
}

function instante(iso: string | null): string {
  if (iso === null) {
    return "—";
  }
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime())
    ? iso
    : `${parsed.toISOString().replace("T", " ").slice(0, 19)}Z`;
}

/** Duração legível a partir de milissegundos. Negativo vira "vencido". */
export function duracao(ms: number): string {
  if (ms <= 0) {
    return "vencido";
  }
  const horas = Math.floor(ms / 3_600_000);
  const minutos = Math.floor((ms % 3_600_000) / 60_000);
  const segundos = Math.floor((ms % 60_000) / 1_000);
  if (horas > 0) {
    return `${String(horas)} h ${String(minutos)} min`;
  }
  if (minutos > 0) {
    return `${String(minutos)} min ${String(segundos)} s`;
  }
  return `${String(segundos)} s`;
}

/**
 * A folga em centavos, formatada a partir do TEXTO decimal que o servidor
 * mandou.
 *
 * A tela formata; ela não calcula. A folga já veio pronta da API, que a
 * computou em `numeric` com o `edgeLiqMin` da config — o front não conhece
 * 0,02 e não vai conhecer.
 */
export function centavos(texto: string | null): string {
  if (texto === null) {
    return "—";
  }
  const valor = Number(texto);
  if (!Number.isFinite(valor)) {
    return texto;
  }
  return `${(Math.abs(valor) * 100).toFixed(1).replace(".", ",")} c`;
}

// ---------------------------------------------------------------------------

export function Decisoes({
  accessToken,
  onUnauthorized,
  overview,
}: Readonly<{
  accessToken: string;
  onUnauthorized: () => void;
  overview: Overview | null;
}>) {
  const [estado, setEstado] = useState<PortfolioStateSnapshot | null>(null);
  const [limites, setLimites] = useState<PortfolioLimits | null>(null);
  const [falhou, setFalhou] = useState(false);
  const [mostrarCruas, setMostrarCruas] = useState(false);
  const [agoraMs, setAgoraMs] = useState(() => Date.now());
  const montado = useRef(true);

  const refresh = useCallback(async (): Promise<void> => {
    const controller = new AbortController();
    const timeout = window.setTimeout(
      () => controller.abort(),
      REQUEST_TIMEOUT_MS,
    );
    const [state, limits] = await buscaDaTelaPadrao(
      accessToken,
      fetch,
      controller.signal,
    );
    window.clearTimeout(timeout);
    if (!montado.current) {
      return;
    }
    if (state.kind === "unauthorized" || limits.kind === "unauthorized") {
      onUnauthorized();
      return;
    }
    setFalhou(state.kind === "error" && limits.kind === "error");
    if (state.kind === "ok") {
      setEstado(state.value);
    }
    if (limits.kind === "ok") {
      setLimites(limits.value);
    }
  }, [accessToken, onUnauthorized]);

  useEffect(() => {
    montado.current = true;
    void refresh();
    const timer = window.setInterval(() => void refresh(), REFRESH_MS);
    return () => {
      montado.current = false;
      window.clearInterval(timer);
    };
  }, [refresh]);

  // O relógio da contagem regressiva. Não busca nada: só reimprime.
  useEffect(() => {
    const timer = window.setInterval(() => setAgoraMs(Date.now()), TICK_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, []);

  return (
    <section className="painel">
      <h2>Decisões</h2>
      {falhou ? (
        <p className="scope" role="alert">
          As duas leituras desta tela falharam na última tentativa. Os números
          abaixo são os da tentativa anterior.
        </p>
      ) : null}

      <Funil overview={overview} />
      <UltimoCiclo overview={overview} />
      <Quase overview={overview} limites={limites} />
      <Congeladas breakers={estado?.openBreakers ?? []} agoraMs={agoraMs} />

      <h3>Todas as decisões</h3>
      <p className="scope">
        {/* A D4: as 500 cruas saem da tela padrão e ficam atrás deste botão. O
            aviso do custo está aqui, ANTES do clique, porque é onde ele muda a
            decisão de quem lê. */}
        A tabela crua é a amostra mais recente do log, não a janela do funil
        acima. Ela só é carregada quando pedida.
      </p>
      <nav className="chips" aria-label="Amostra crua do log">
        <button
          type="button"
          className={mostrarCruas ? "chip chip--ativo" : "chip"}
          aria-pressed={mostrarCruas}
          onClick={() => {
            setMostrarCruas((atual) => !atual);
          }}
        >
          Todas (últimas 500)
        </button>
      </nav>
      {/* `key` distinto de propósito: `PortfolioPanel` decide a seção ativa no
          estado inicial, então trocar o array sem remontar deixaria a seção
          anterior selecionada. */}
      {mostrarCruas ? (
        <PortfolioPanel
          key="decisoes-com-cruas"
          accessToken={accessToken}
          onUnauthorized={onUnauthorized}
          sections={SECOES_COM_CRUAS}
          rotulo="Decisões"
        />
      ) : (
        <PortfolioPanel
          key="decisoes-padrao"
          accessToken={accessToken}
          onUnauthorized={onUnauthorized}
          sections={SECOES_PADRAO}
          rotulo="Consulta"
        />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Funil (D1)
//
// Os quatro blocos abaixo são exportados e PUROS — recebem dado, devolvem
// marcação, não buscam nada. É o que permite ao teste renderizá-los com um
// fixture e afirmar sobre o TEXTO que aparece na tela, que é onde os aceites
// 1, 3 e 5 estão escritos.
// ---------------------------------------------------------------------------

export function Funil({ overview }: Readonly<{ overview: Overview | null }>) {
  const funil = overview?.funnel_24h ?? null;
  if (funil === null) {
    return (
      <>
        <h3>Funil</h3>
        <p className="scope" role="status">
          <strong>Funil indisponível.</strong> O agregado por hora que esta
          seção lê é escrito pelo worker de portfólio ao fim de cada ciclo; ele
          ainda não tem nenhuma hora gravada. Esta tela{" "}
          <strong>não desenha o funil sobre a amostra de 500 linhas</strong>: a
          amostra cobre minutos, e o rótulo diria 24 horas.
        </p>
      </>
    );
  }

  const aceitas = funil.steps
    .filter((step) => step.outcome === "ACCEPTED")
    .reduce((soma, step) => soma + step.decisions, 0);
  const avaliadas = funil.steps.reduce(
    (soma, step) => soma + step.decisions,
    0,
  );
  const recusas = funil.steps
    .filter((step) => step.outcome !== "ACCEPTED")
    .sort((esquerda, direita) => direita.decisions - esquerda.decisions);
  const maior = recusas[0]?.decisions ?? 1;

  return (
    <>
      <h3>Funil</h3>
      {/* O aceite 1: uma linha legível com os quatro degraus. Os dois últimos
          vêm do ledger e têm a janela DELES, que é dita ao lado — 24 h de
          decisão e 24 h de fill não são a mesma população. */}
      <p className="funil-linha">
        <strong>{avaliadas.toLocaleString("pt-BR")}</strong> avaliadas →{" "}
        <strong>{aceitas.toLocaleString("pt-BR")}</strong> aceitas →{" "}
        <strong>{String(overview?.paper.open_orders ?? 0)}</strong> ordens
        abertas → <strong>{String(overview?.paper.fills_24h ?? 0)}</strong>{" "}
        fills
      </p>
      <p className="scope">
        Janela: <strong>{instante(funil.window_from)}</strong> até{" "}
        <strong>{instante(funil.window_to)}</strong>. Fonte:{" "}
        <strong>
          {funil.source === "hourly"
            ? "agregado por hora"
            : (funil.source ?? "—")}
        </strong>
        . A hora corrente está incompleta, e o ciclo em andamento pode não estar
        contado. Ordens e fills são do ledger nas últimas 24 h — outra
        população, não um degrau desta mesma contagem.
      </p>
      <ul className="funil">
        {recusas.map((step) => (
          <li key={`${step.outcome ?? ""}:${step.reason_code ?? ""}`}>
            <span className="funil-rot">
              <Badge codigo={step.reason_code} dicionario={MOTIVO_DECISAO} />
            </span>
            <span className="bar" aria-hidden="true">
              <span
                className="bar-fill"
                style={{ width: `${String((step.decisions / maior) * 100)}%` }}
              />
            </span>
            <span className="funil-val">
              {step.decisions.toLocaleString("pt-BR")}
              <small>
                {avaliadas === 0
                  ? ""
                  : ` · ${((step.decisions / avaliadas) * 100).toFixed(1).replace(".", ",")} %`}
              </small>
            </span>
            <span
              className="funil-nota"
              title="máximo de mercados distintos num único balde de hora, não a soma das horas"
            >
              {String(step.markets)} mercados no pico de uma hora
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

// ---------------------------------------------------------------------------
// Último ciclo (D2)
// ---------------------------------------------------------------------------

export function UltimoCiclo({
  overview,
}: Readonly<{ overview: Overview | null }>) {
  const ciclo = overview?.last_cycle ?? null;
  if (ciclo === null) {
    return (
      <>
        <h3>Último ciclo</h3>
        <p className="scope" role="status">
          Ainda não medido: o worker de portfólio não fechou nenhum ciclo desde
          o deploy. Isto não é &quot;o motor não achou nada&quot; — é
          &quot;ninguém contou ainda&quot;.
        </p>
      </>
    );
  }
  return (
    <>
      <h3>Último ciclo</h3>
      {/* A frase da D2, com os números do CICLO e não da amostra. */}
      <p className="funil-linha">
        {ciclo.entrable === 0 ? (
          <>
            <strong>Nenhum mercado entrável agora</strong> —{" "}
            {String(ciclo.evaluated)} avaliados
          </>
        ) : (
          <>
            <strong>{String(ciclo.entrable)} entráveis</strong> de{" "}
            {String(ciclo.evaluated)} avaliados
          </>
        )}
        {ciclo.open_breakers === 0
          ? ""
          : `, ${String(ciclo.open_breakers)} sob disjuntor`}
        {ciclo.stale_marks === 0
          ? ""
          : `, ${String(ciclo.stale_marks)} com marca velha`}
        .
      </p>
      <p className="scope">
        Ciclo de <strong>{instante(ciclo.cycle_at)}</strong>:{" "}
        {String(ciclo.decisions_written)} decisões gravadas (o motor avalia todo
        o universo a cada ciclo e grava só o que mudou de veredito),{" "}
        {String(ciclo.positions)} posições, estado{" "}
        <Badge codigo={ciclo.state} />.
      </p>
    </>
  );
}

// ---------------------------------------------------------------------------
// Quase (D3)
// ---------------------------------------------------------------------------

export function Quase({
  overview,
  limites,
}: Readonly<{
  overview: Overview | null;
  limites: PortfolioLimits | null;
}>) {
  const quase = overview?.near_misses_24h ?? [];
  // D3: o piso vem do bloco `config` de `/portfolio/limits`, que é a única
  // fonte publicada dele. Sem ele, a tela escreve "não medido" — nunca 0,02.
  const piso = limites?.config?.edgeLiqMin ?? null;
  return (
    <>
      <h3>Quase</h3>
      <p className="scope">
        Decisões que passaram a menos de um centavo do critério, na mesma janela
        do funil. A folga é calculada <strong>no servidor</strong>, em decimal,
        e esta tela só a formata. Piso de edge da config:{" "}
        {piso === null ? <strong>não medido</strong> : <strong>{piso}</strong>}
        {limites?.config?.config_version === undefined ||
        limites.config.config_version === null
          ? ""
          : ` (config ${limites.config.config_version})`}
        .
      </p>
      {quase.length === 0 ? (
        <p className="scope">
          Nenhuma decisão na banda nas 24 h. Isto é uma medição, não uma
          ausência de dado: o funil acima diz quantas foram recusadas e por quê.
        </p>
      ) : (
        <ul className="funil">
          {quase.map((linha) => (
            <li key={linha.reason_code}>
              <span className="funil-rot">
                <Badge codigo={linha.reason_code} dicionario={MOTIVO_DECISAO} />
              </span>
              <span className="funil-val">
                {String(linha.count)}
                <small> quase</small>
              </span>
              <span
                className="funil-nota"
                title={consequencia(linha.reason_code, MOTIVO_DECISAO)}
              >
                faltou {centavos(linha.folga_min)} na melhor delas
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Congeladas (D3)
// ---------------------------------------------------------------------------

/**
 * Os dois tipos com contagem regressiva.
 *
 * Os outros disjuntores fecham quando a CONDIÇÃO deles cessa (dado volta a ser
 * fresco, UMA resolve), não quando um prazo vence — mostrar um relógio neles
 * diria "acaba às 14h" sobre algo que pode acabar em um minuto ou nunca.
 */
const COM_PRAZO: readonly string[] = ["PARAM_CHANGE", "RULE_CLARIFICATION"];

export function Congeladas({
  breakers,
  agoraMs,
}: Readonly<{
  breakers: PortfolioStateSnapshot["openBreakers"];
  agoraMs: number;
}>) {
  const engenheiro = useModoEngenheiro();
  const porTipo = new Map<
    string,
    { total: number; maisAntigo: string | null; windowMs: number | null }
  >();
  for (const breaker of breakers) {
    const atual = porTipo.get(breaker.kind) ?? {
      total: 0,
      maisAntigo: null,
      windowMs: null,
    };
    atual.total += 1;
    if (
      breaker.started_at !== null &&
      (atual.maisAntigo === null || breaker.started_at < atual.maisAntigo)
    ) {
      atual.maisAntigo = breaker.started_at;
    }
    atual.windowMs = breaker.window_ms;
    porTipo.set(breaker.kind, atual);
  }
  const grupos = [...porTipo.entries()].sort(
    (esquerda, direita) => direita[1].total - esquerda[1].total,
  );

  return (
    <>
      <h3>Congeladas</h3>
      {grupos.length === 0 ? (
        <p className="scope">Nenhum disjuntor aberto.</p>
      ) : (
        <>
          <p className="scope">
            Disjuntores abertos, por tipo. O painel <strong>só lê</strong>:
            nenhum é fechado, alterado ou contornado por aqui. A contagem
            regressiva usa a janela que o motor publica, não um prazo fixado
            nesta tela.
          </p>
          <ul className="funil">
            {grupos.map(([kind, grupo]) => {
              const prazo =
                COM_PRAZO.includes(kind) &&
                grupo.maisAntigo !== null &&
                grupo.windowMs !== null
                  ? new Date(grupo.maisAntigo).getTime() +
                    grupo.windowMs -
                    agoraMs
                  : null;
              return (
                <li key={kind}>
                  <span className="funil-rot">
                    <Badge codigo={kind} dicionario={TIPO_DISJUNTOR} />
                  </span>
                  <span className="funil-val">
                    {String(grupo.total)}
                    <small> {grupo.total === 1 ? "mercado" : "mercados"}</small>
                  </span>
                  <span className="funil-nota">
                    {prazo === null
                      ? "fecha quando a condição cessar, sem prazo"
                      : `o mais antigo libera em ${duracao(prazo)}`}
                    {engenheiro && grupo.windowMs !== null
                      ? ` · janela ${String(grupo.windowMs)} ms`
                      : ""}
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </>
  );
}
