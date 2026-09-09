// RFC-027 D6: os consumidores do que já estava publicado, e os semáforos.
//
// Duas rotas estavam no perímetro sem ninguém as ler:
//
//   `/polymarket/data-quality`      publicada desde a RFC-015; o `grep` da
//                                   RFC-027 voltava vazio em `apps/web/src`
//   `/polymarket/portfolio/limits`  a RFC-026 PR 1 passou a ler o bloco
//                                   `config` dela, e só ele — `caps` e
//                                   `binding_constraints_24h` seguiam sem tela
//
// Uma rota publicada sem consumidor é pior do que uma rota que não existe: ela
// custa perímetro, custa teste e não responde a ninguém.
//
// SÓ LEITURA. Dois GETs sobre rotas que já existiam; nenhuma location nova.

import { useCallback, useEffect, useRef, useState } from "react";

import { LIMITADOR, consequencia, rotulo } from "./dicionario";
import { semaforo, type DataQuality, type Overview } from "./overview";
import { fetchDataQuality } from "./overview";
import { fetchLimits, type PortfolioLimits } from "./portfolio";
import { useModoEngenheiro } from "./modo.tsx";

const REFRESH_MS = 30_000;
const REQUEST_TIMEOUT_MS = 5_000;
const GB = 1024 ** 3;

function bytes(valor: number): string {
  if (valor >= GB) {
    return `${(valor / GB).toFixed(2).replace(".", ",")} GB`;
  }
  return `${(valor / (1024 * 1024)).toFixed(1).replace(".", ",")} MB`;
}

function ms(valor: number | null): string {
  if (valor === null) {
    return "—";
  }
  if (valor < 1000) {
    return `${String(Math.round(valor))} ms`;
  }
  if (valor < 60_000) {
    return `${(valor / 1000).toFixed(1).replace(".", ",")} s`;
  }
  return `${(valor / 60_000).toFixed(1).replace(".", ",")} min`;
}

/**
 * Uma fonte no painel de semáforos.
 *
 * `idadeMs === null` NÃO é verde: é cinza, com "não medido no painel". O
 * heartbeat por worker é fase 2, e até lá a ausência de medição não pode
 * parecer saúde.
 */
interface Fonte {
  readonly nome: string;
  readonly idadeMs: number | null;
  readonly detalhe: string;
}

export function Semaforos({
  overview,
}: Readonly<{ overview: Overview | null }>) {
  const agora = overview?.generated_at;
  const idadeDe = (instante: string | null): number | null => {
    if (instante === null || agora === undefined || agora === null) {
      return null;
    }
    const delta = new Date(agora).getTime() - new Date(instante).getTime();
    return Number.isNaN(delta) ? null : delta;
  };

  const fontes: readonly Fonte[] = [
    {
      nome: "Coletor (livro)",
      idadeMs: overview?.collection.last_book_delta_age_ms ?? null,
      detalhe: "último delta de livro gravado",
    },
    {
      nome: "Modelo (estimativas)",
      idadeMs: idadeDe(overview?.model.last_estimate_at ?? null),
      detalhe: "última estimativa fundamental",
    },
    {
      nome: "Motor (último ciclo)",
      idadeMs: idadeDe(overview?.last_cycle?.cycle_at ?? null),
      detalhe: "último PORTFOLIO_CYCLE resumido",
    },
    {
      nome: "Disjuntores",
      idadeMs: idadeDe(overview?.circuit_breakers.most_recent_at ?? null),
      // Este é o único em que "velho" é BOM, e a tela tem de dizer isso — um
      // vermelho aqui leria como defeito quando é o resultado desejado.
      detalhe: "abertura mais recente; aqui, velho é bom",
    },
  ];

  return (
    <>
      <h3>Fontes</h3>
      <p className="scope">
        Verde abaixo de 60 s, âmbar abaixo de 5 min, vermelho acima. Derivado
        das idades que o <code>/overview</code> já publica. O que não tem idade
        publicada aparece em cinza como <strong>não medido no painel</strong> —
        um heartbeat por worker é fase 2, e até lá &quot;não sei&quot; não pode
        parecer &quot;está bem&quot;.
      </p>
      <ul className="semaforos">
        {fontes.map((fonte) => (
          <li key={fonte.nome} data-tom={semaforo(fonte.idadeMs)}>
            <span className="semaforo-ponto" aria-hidden="true" />
            <span className="semaforo-nome">{fonte.nome}</span>
            <span className="semaforo-val">
              {fonte.idadeMs === null
                ? "não medido no painel"
                : ms(fonte.idadeMs)}
            </span>
            <span className="semaforo-nota">{fonte.detalhe}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

// ---------------------------------------------------------------------------

export function QualidadeDeDados({
  qualidade,
}: Readonly<{ qualidade: DataQuality | null }>) {
  const engenheiro = useModoEngenheiro();
  if (qualidade === null) {
    return (
      <>
        <h3>Qualidade de dados</h3>
        <p className="scope">Não lido nesta tentativa.</p>
      </>
    );
  }
  const tabelas = qualidade.storage.tables
    .filter((tabela) => tabela.quota_bytes > 0)
    .map((tabela) => ({
      ...tabela,
      uso: tabela.live_bytes / tabela.quota_bytes,
    }))
    .sort((esquerda, direita) => direita.uso - esquerda.uso)
    .slice(0, engenheiro ? 100 : 8);

  return (
    <>
      <h3>Qualidade de dados</h3>
      <p className="scope">
        Lacunas nas últimas 24 h, atraso de ingestão na última hora e uso de
        quota por tabela. Total:{" "}
        <strong>{bytes(qualidade.storage.total_bytes)}</strong> de{" "}
        {bytes(qualidade.storage.budget_bytes)} (
        {qualidade.storage.budget_used_pct === null
          ? "—"
          : `${qualidade.storage.budget_used_pct.toFixed(1).replace(".", ",")} %`}
        ).
      </p>

      <h4>Lacunas (24 h)</h4>
      {qualidade.gaps_24h.length === 0 ? (
        <p className="scope">Nenhuma lacuna aberta ou fechada nas 24 h.</p>
      ) : (
        <ul className="funil">
          {qualidade.gaps_24h.map((lacuna) => (
            <li key={lacuna.source ?? "—"}>
              <span className="funil-rot">{lacuna.source ?? "—"}</span>
              <span className="funil-val">{String(lacuna.count)}</span>
              <span className="funil-nota">
                {ms(lacuna.total_duration_ms)} sem dado no total
              </span>
            </li>
          ))}
        </ul>
      )}

      <h4>Atraso de ingestão (1 h)</h4>
      <p className="funil-linha">
        p50 <strong>{ms(qualidade.ingest_lag_ms_last_hour.p50)}</strong> · p99{" "}
        <strong>{ms(qualidade.ingest_lag_ms_last_hour.p99)}</strong>
      </p>

      {/* RFC-024 D4: a cobertura vem PRONTA da rota. A tela exibe; não
          recalcula. Um segundo cálculo do mesmo número no cliente é como as
          duas metades divergem. */}
      {qualidade.fast_coverage === null ||
      qualidade.fast_coverage.dias.length === 0 ? null : (
        <>
          <h4>Cobertura do universo rápido</h4>
          <p className="scope">
            Série <code>{qualidade.fast_coverage.serie ?? "—"}</code>, por dia
            UTC do FIM do mercado. Calculada pela API (RFC-024 D4) e apenas
            exibida aqui. Um dia sem mercados emitidos aparece como
            &quot;—&quot;, nunca como 100 %.
          </p>
          <table className="grid grid--compacta">
            <thead>
              <tr>
                <th scope="col">Dia</th>
                <th scope="col">Emitidos</th>
                <th scope="col">Com livro T-15</th>
                <th scope="col">Catalogados 60 min</th>
                <th scope="col">Lead mediano</th>
              </tr>
            </thead>
            <tbody>
              {qualidade.fast_coverage.dias.map((dia) => (
                <tr key={dia.dia ?? "—"}>
                  <th scope="row">{dia.dia ?? "—"}</th>
                  <td>{String(dia.emitidos)}</td>
                  <td>
                    {dia.com_livro_t15_pct === null
                      ? "—"
                      : `${String(dia.com_livro_t15_pct)} %`}
                  </td>
                  <td>
                    {dia.catalogados_60min_pct === null
                      ? "—"
                      : `${String(dia.catalogados_60min_pct)} %`}
                  </td>
                  <td>
                    {dia.lead_mediano_min === null
                      ? "—"
                      : `${String(dia.lead_mediano_min)} min`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <h4>Quota por tabela</h4>
      <p className="scope">
        As {String(tabelas.length)} de maior uso.{" "}
        {engenheiro ? "" : "Ligue o modo engenheiro (tecla ?) para ver todas. "}
        Uma tabela <strong>protegida</strong> nunca é podada: o uso dela é
        monitorado, não corrigido pela retenção.
      </p>
      <ul className="funil">
        {tabelas.map((tabela) => (
          <li key={tabela.table_name}>
            <span className="funil-rot">
              <code>{tabela.table_name}</code>
            </span>
            <span className="bar" aria-hidden="true">
              <span
                className={
                  tabela.uso > 1 ? "bar-fill bar-fill--neg" : "bar-fill"
                }
                style={{ width: `${String(Math.min(tabela.uso, 1) * 100)}%` }}
              />
            </span>
            <span className="funil-val">{(tabela.uso * 100).toFixed(0)} %</span>
            <span className="funil-nota">
              {bytes(tabela.live_bytes)} de {bytes(tabela.quota_bytes)}
              {tabela.protected ? " · protegida" : ""}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

// ---------------------------------------------------------------------------

export function Limites({
  limites,
}: Readonly<{ limites: PortfolioLimits | null }>) {
  if (limites === null) {
    return (
      <>
        <h3>Limites</h3>
        <p className="scope">Não lido nesta tentativa.</p>
      </>
    );
  }
  const dominante = [...limites.bindingConstraints24h].sort(
    (esquerda, direita) => (direita.decisions ?? 0) - (esquerda.decisions ?? 0),
  );
  const total = dominante.reduce((soma, l) => soma + (l.decisions ?? 0), 0);

  return (
    <>
      <h3>Limites</h3>
      <p className="scope">
        Os quatro números da config em vigor, os caps por dimensão e qual
        limitador amarrou mais decisões nas últimas 24 h.{" "}
        {limites.config === null ? (
          <strong>Config não medida</strong>
        ) : (
          <>
            Config <strong>{limites.config.config_version ?? "—"}</strong>: piso
            de edge <strong>{limites.config.edgeLiqMin ?? "—"}</strong>, margem
            de segurança{" "}
            <strong>{limites.config.safetyMarginMin ?? "—"}</strong>, livro
            velho a partir de <strong>{ms(limites.config.bookMaxAgeMs)}</strong>
            , estimativa velha a partir de{" "}
            <strong>{ms(limites.config.estimateMaxAgeMs)}</strong>.
          </>
        )}
      </p>

      <h4>Limitador dominante (24 h)</h4>
      {dominante.length === 0 ? (
        <p className="scope">Nenhuma decisão nas 24 h.</p>
      ) : (
        <ul className="funil">
          {dominante.slice(0, 6).map((linha) => (
            <li key={linha.binding_constraint ?? "—"}>
              <span
                className="funil-rot"
                title={consequencia(linha.binding_constraint, LIMITADOR)}
              >
                {rotulo(linha.binding_constraint, LIMITADOR)}
              </span>
              <span className="bar" aria-hidden="true">
                <span
                  className="bar-fill"
                  style={{
                    width: `${String(
                      total === 0
                        ? 0
                        : ((linha.decisions ?? 0) /
                            (dominante[0]?.decisions ?? 1)) *
                            100,
                    )}%`,
                  }}
                />
              </span>
              <span className="funil-val">
                {(linha.decisions ?? 0).toLocaleString("pt-BR")}
              </span>
              <span className="funil-nota">
                {total === 0
                  ? ""
                  : `${(((linha.decisions ?? 0) / total) * 100).toFixed(1).replace(".", ",")} % das decisões`}
              </span>
            </li>
          ))}
        </ul>
      )}

      <h4>Caps por dimensão</h4>
      {limites.caps.length === 0 ? (
        <p className="scope">Nenhuma dimensão com uso acima de zero.</p>
      ) : (
        <table className="grid grid--compacta">
          <thead>
            <tr>
              <th scope="col">Dimensão</th>
              <th scope="col">Chave</th>
              <th scope="col">Pior caso</th>
              <th scope="col">Cap</th>
              <th scope="col">Uso</th>
            </tr>
          </thead>
          <tbody>
            {limites.caps.slice(0, 20).map((cap) => (
              <tr key={`${cap.dimension}:${cap.dimension_key}`}>
                <th scope="row">{cap.dimension}</th>
                <td>{cap.dimension_key}</td>
                <td>{cap.worst_case_usd ?? "—"}</td>
                <td>{cap.cap_usd ?? "—"}</td>
                <td>
                  {cap.utilization === null
                    ? "—"
                    : `${(cap.utilization * 100).toFixed(1).replace(".", ",")} %`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

/** As duas seções novas da tela Sistema, com o poll delas. */
export function SistemaFase1({
  accessToken,
  onUnauthorized,
  overview,
}: Readonly<{
  accessToken: string;
  onUnauthorized: () => void;
  overview: Overview | null;
}>) {
  const [qualidade, setQualidade] = useState<DataQuality | null>(null);
  const [limites, setLimites] = useState<PortfolioLimits | null>(null);
  const montado = useRef(true);

  const refresh = useCallback(async (): Promise<void> => {
    const controller = new AbortController();
    const timeout = window.setTimeout(
      () => controller.abort(),
      REQUEST_TIMEOUT_MS,
    );
    const [dq, lim] = await Promise.all([
      fetchDataQuality(accessToken, fetch, controller.signal),
      fetchLimits(accessToken, fetch, controller.signal),
    ]);
    window.clearTimeout(timeout);
    if (!montado.current) {
      return;
    }
    if (dq.kind === "unauthorized" || lim.kind === "unauthorized") {
      onUnauthorized();
      return;
    }
    if (dq.kind === "ok") {
      setQualidade(dq.value);
    }
    if (lim.kind === "ok") {
      setLimites(lim.value);
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

  return (
    <section className="painel">
      <h2>Sistema</h2>
      <Semaforos overview={overview} />
      <QualidadeDeDados qualidade={qualidade} />
      <Limites limites={limites} />
    </section>
  );
}
