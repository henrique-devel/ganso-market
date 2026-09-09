// RFC-029 D4 — a tela Sombra.
//
// O QUE ELA CORRIGE. Os números do shadow replay existiam só no stdout em
// inglês de uma sessão SSH que morria sozinha. Agora um job diário grava o JSON
// em disco e esta tela o lê em português, todos os dias, com as ressalvas
// impressas ao lado dos números em vez de na cabeça de quem rodou o comando.
//
// O QUE ELA NÃO FAZ, E POR QUÊ. **Nenhum botão.** Não promove modelo, não cunha
// config, não dispara a rodada, não escreve em lugar nenhum. O PnL desta tela é
// contrafactual e a tela diz isso em três lugares diferentes: no selo, no
// sufixo "(paper)" e na ressalva fixa de que ele soma LINHAS e não posições.
// Um botão de promoção aqui transformaria uma leitura com ressalvas numa
// decisão sem elas.
//
// AS RESSALVAS SÃO FIXAS, NÃO OPCIONAIS. Elas não dependem do dado: são
// propriedades de como o número é calculado, então aparecem mesmo quando o
// número é bom — sobretudo quando o número é bom.

import { useCallback, useEffect, useRef, useState } from "react";

import { Badge } from "./Overview.tsx";
import {
  EXCLUSAO_SOMBRA,
  MOTIVO_DECISAO,
  RESULTADO_DECISAO,
  consequencia,
  rotulo,
} from "./dicionario";
import { useModoEngenheiro } from "./modo.tsx";
import {
  fetchRodadaSombra,
  fetchRodadasSombra,
  modelosMisturados,
  type RelatorioModoA,
  type RelatorioModoB,
  type RodadaListada,
  type RodadaSombra,
} from "./sombra";

/**
 * 60 s, não os 30 s das outras telas.
 *
 * O dado por trás desta tela muda uma vez por dia, às 03:30 UTC. Um poll de
 * 30 s gastaria o dobro das requisições do orçamento da D5 para reler um
 * arquivo que não mudou — e a tela mostra `generated_at`, então quem quiser
 * saber se chegou coisa nova olha o carimbo, não o relógio.
 */
export const REFRESH_MS = 60_000;
const REQUEST_TIMEOUT_MS = 5_000;

export type Estado =
  | { readonly tipo: "carregando" }
  | { readonly tipo: "erro" }
  | {
      readonly tipo: "ok";
      readonly modoB: RodadaSombra | null;
      readonly modoA: RodadaSombra | null;
      readonly rodadas: readonly RodadaListada[];
    };

/**
 * As três buscas da tela, numa função exportada.
 *
 * Exportada para que o teste possa afirmar sobre as URLs pedidas com um `fetch`
 * espião — e para que "esta tela só faz GET" seja verificável a cada
 * `npm test` em vez de na aba de rede.
 */
export async function buscaDaTelaSombra(
  accessToken: string,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<
  readonly [
    Awaited<ReturnType<typeof fetchRodadaSombra>>,
    Awaited<ReturnType<typeof fetchRodadaSombra>>,
    Awaited<ReturnType<typeof fetchRodadasSombra>>,
  ]
> {
  return Promise.all([
    fetchRodadaSombra(accessToken, "B", fetcher, signal),
    fetchRodadaSombra(accessToken, "A", fetcher, signal),
    fetchRodadasSombra(accessToken, fetcher, signal),
  ]);
}

function inteiro(valor: number | null): string {
  return valor === null ? "—" : valor.toLocaleString("pt-BR");
}

/** O líquido, com sinal: é o número que responde "teria dado ou perdido". */
function dinheiro(valor: number | null): string {
  if (valor === null) {
    return "—";
  }
  const sinal = valor > 0 ? "+" : valor < 0 ? "−" : "";
  return `${sinal}${montante(Math.abs(valor))}`;
}

/** Bruto, custos e degradação: magnitudes de uma conta, não resultados. Um
 * "+US$ 0,16" de custo lê como ganho, e custo não é ganho. */
function montante(valor: number | null): string {
  return valor === null
    ? "—"
    : `US$ ${valor.toLocaleString("pt-BR", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`;
}

/**
 * Um valor de config ou de virada, em pt-BR e com casas suficientes.
 *
 * `0.020128609260873245` impresso cru são dezoito dígitos de ruído para uma
 * diferença que aparece na quarta casa. Seis casas mostram a diferença entre as
 * viradas e o valor gravado, que é a coisa que se está olhando.
 */
function decimal(valor: number | null, casas = 6): string {
  return valor === null
    ? "—"
    : valor.toLocaleString("pt-BR", {
        minimumFractionDigits: 0,
        maximumFractionDigits: casas,
      });
}

/**
 * UTC com o `Z` à mostra, como o resto do painel (`Overview.tsx:90`).
 *
 * Hora local seria ambígua justamente aqui: o job roda às 03:30 **UTC**, a
 * janela do modo B é descrita em UTC e o `coveredTo` é comparado com ela. Uma
 * data sem fuso ao lado de um horário com fuso é um erro de leitura esperando
 * acontecer.
 */
function instante(iso: string | null): string {
  if (iso === null) {
    return "—";
  }
  const quando = new Date(iso);
  return Number.isNaN(quando.getTime())
    ? iso
    : `${quando.toISOString().replace("T", " ").slice(0, 19)}Z`;
}

/** Um identificador não é uma quantidade: `910574`, nunca `910.574`. */
function identificador(valor: number | null): string {
  return valor === null ? "—" : String(valor);
}

// ---------------------------------------------------------------------------

/**
 * A proveniência, sempre visível e sempre em primeiro lugar.
 *
 * Antes dos números, não depois: a janela coberta e as tabelas com TTL que o
 * modo B lê são o que decide se os números abaixo respondem à pergunta que
 * quem olha está fazendo.
 */
export function Proveniencia({ rodada }: Readonly<{ rodada: RodadaSombra }>) {
  const proveniencia = rodada.proveniencia;
  return (
    <section className="card sombra-proveniencia">
      <h3>Proveniência</h3>
      <dl className="detalhe-grade">
        <dt>Janela coberta</dt>
        <dd>
          {instante(proveniencia?.janelaDe ?? null)} →{" "}
          {instante(proveniencia?.janelaAte ?? null)}
        </dd>
        <dt>Linhas no log da janela</dt>
        <dd>{inteiro(proveniencia?.linhasNoLog ?? null)}</dd>
        <dt>Fechado no decision_id</dt>
        <dd>{identificador(proveniencia?.fechadoEmDecisionId ?? null)}</dd>
        <dt>Modelos de sombra na janela</dt>
        <dd>
          {proveniencia === null || proveniencia.modelIds.length === 0
            ? "—"
            : proveniencia.modelIds.join(", ")}
        </dd>
        <dt>Gerado em</dt>
        <dd>
          {instante(rodada.geradoEm)}
          {rodada.velho ? (
            <strong className="sombra-velho">
              {" "}
              · mais de 36 h: o job pode não ter rodado
            </strong>
          ) : null}
        </dd>
      </dl>
      {/* Em português, com o texto do CLI no title. A regra do dicionario.ts
          vale aqui como em toda tradução do painel: o original nunca some, e
          uma legenda errada tem de ser visível ao lado do que ela traduz. A
          frase do CLI é a fonte; esta é a leitura dela. */}
      <p className="scope" title={proveniencia?.naoEAuditoria ?? undefined}>
        <strong>Não é auditoria.</strong> O modo B lê{" "}
        <code>fundamental_estimates</code> e <code>fundamental_labels</code>,
        que têm TTL e quota: a janela que ele consegue cobrir é a que essas
        tabelas ainda guardam, e ela encurta sozinha com o tempo. O modo A não
        depende delas.
      </p>
      <p className="scope">
        Lê: {proveniencia?.leTabelas.join(", ") ?? "—"}. Nada é escrito por esta
        tela nem pelo job que a alimenta.
      </p>
    </section>
  );
}

/** O aviso que decide se estes números podem sustentar uma promoção. */
export function AvisoModelosMisturados({
  rodada,
}: Readonly<{ rodada: RodadaSombra | null }>) {
  if (!modelosMisturados(rodada)) {
    return null;
  }
  return (
    <p className="sombra-aviso" role="status">
      <strong>Modelos misturados — não usar para promoção.</strong> A janela tem{" "}
      {String(rodada?.proveniencia?.modelIds.length ?? 0)} versões de sombra (
      {rodada?.proveniencia?.modelIds.join(", ") ?? ""}), então o as-of compara
      o motor contra duas coisas ao mesmo tempo. Promover exige uma janela de um
      modelo só, o gate da RFC-010 em PASS e um ato do proprietário.
    </p>
  );
}

/** Uma rodada que falhou: o que se mostra em vez do número de ontem. */
export function FalhaDeHoje({ rodada }: Readonly<{ rodada: RodadaSombra }>) {
  const falha = rodada.falha;
  if (falha === null) {
    return null;
  }
  return (
    <p className="sombra-falha" role="alert">
      <strong>A rodada de hoje falhou: {falha.reasonCode}.</strong>{" "}
      {rodada.runDate === null
        ? "Não há rodada boa anterior para mostrar."
        : `Os números abaixo são da rodada de ${rodada.runDate} — não são de hoje.`}
      {falha.exitStatus === null
        ? ""
        : ` O job saiu com status ${String(falha.exitStatus)}.`}
    </p>
  );
}

export function Funil({ relatorio }: Readonly<{ relatorio: RelatorioModoB }>) {
  const degraus: readonly {
    rot: string;
    valor: number | null;
    nota: string;
  }[] = [
    {
      rot: "Decisões vistas",
      valor: relatorio.funil.vistas,
      nota: `${inteiro(relatorio.mercadosVistos)} mercados`,
    },
    {
      rot: "Admitidas na amostra",
      valor: relatorio.funil.admitidas,
      nota: `${inteiro(relatorio.mercadosAdmitidos)} mercados; baseline reproduz`,
    },
    {
      rot: "Alcançam a estimativa",
      valor: relatorio.funil.alcancamEstimativa,
      nota: "havia linha shadow as-of o instante",
    },
    {
      rot: "Agiriam diferente",
      valor: relatorio.funil.agiriamDiferente,
      nota: `${inteiro(relatorio.mercadosQueAgiriamDiferente)} mercados`,
    },
    {
      rot: "Aceitas só pela sombra",
      valor: relatorio.funil.aceitasSoPelaSombra,
      nota: "o motor gravado teria recusado",
    },
    {
      rot: "Liquidadas (têm rótulo final)",
      valor: relatorio.funil.liquidadas,
      nota: "as únicas que entram no PnL",
    },
  ];
  const maior = degraus.reduce(
    (maximo, degrau) => Math.max(maximo, degrau.valor ?? 0),
    0,
  );
  return (
    <section className="card">
      <h3>Funil da população</h3>
      <ul className="funil">
        {degraus.map((degrau) => (
          <li key={degrau.rot}>
            <span className="funil-rot">{degrau.rot}</span>
            <span className="bar" aria-hidden="true">
              <span
                className="bar-fill"
                style={{
                  width: `${String(maior === 0 ? 0 : ((degrau.valor ?? 0) / maior) * 100)}%`,
                }}
              />
            </span>
            <span className="funil-val">{inteiro(degrau.valor)}</span>
            <span className="funil-nota">{degrau.nota}</span>
          </li>
        ))}
      </ul>
      {relatorio.exclusoes.length === 0 ? null : (
        <>
          <h4>Por que as outras ficaram de fora</h4>
          <ul className="funil">
            {relatorio.exclusoes.map((exclusao) => (
              <li key={exclusao.codigo}>
                <span className="funil-rot">
                  <Badge
                    codigo={exclusao.codigo}
                    dicionario={EXCLUSAO_SOMBRA}
                  />
                </span>
                <span className="funil-val">{inteiro(exclusao.linhas)}</span>
                <span
                  className="funil-nota"
                  title={consequencia(exclusao.codigo, EXCLUSAO_SOMBRA)}
                >
                  {consequencia(exclusao.codigo, EXCLUSAO_SOMBRA)}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/**
 * O PnL contrafactual, em roxo tracejado, com selo HIPOTÉTICO.
 *
 * A ressalva de que ele soma LINHAS e não posições é fixa e vem com os dois
 * números que a tornam concreta — N liquidadas em no máximo M mercados. Sem
 * eles a frase é uma desculpa; com eles é a escala do problema.
 */
export function CartaoPnl({
  relatorio,
}: Readonly<{ relatorio: RelatorioModoB }>) {
  const pnl = relatorio.pnl;
  return (
    <section className="card sombra-pnl">
      <h3>
        PnL contrafactual <span className="sombra-selo">HIPOTÉTICO</span>
      </h3>
      <p className="sombra-pnl-valor">
        {dinheiro(pnl.liquidoUsd)} <small>(paper)</small>
      </p>
      <dl className="detalhe-grade">
        <dt>Vitórias / derrotas</dt>
        <dd>
          {inteiro(pnl.vitorias)} / {inteiro(pnl.derrotas)}
        </dd>
        <dt>Bruto</dt>
        <dd>{montante(pnl.brutoUsd)}</dd>
        <dt>Custos</dt>
        <dd>{montante(pnl.custosUsd)}</dd>
        <dt>Degradação</dt>
        <dd>{montante(pnl.degradacaoUsd)}</dd>
        <dt>Sem rótulo final</dt>
        <dd>
          {inteiro(pnl.semRotuloFinal)} de {inteiro(pnl.consideradas)}
        </dd>
      </dl>
      <p className="sombra-ressalva">
        <strong>Soma de linhas, não posições.</strong> {inteiro(pnl.liquidadas)}{" "}
        liquidadas em ≤ {inteiro(relatorio.mercadosQueAgiriamDiferente)}{" "}
        mercados: uma linha por minuto por mercado, sem deduplicar e sem os
        `caps`. O mesmo mercado aparece dezenas de vezes, e o total soma todas.
      </p>
      <p className="sombra-ressalva">
        Zero decisões alcançáveis nas famílias &quot;sobe ou desce&quot; horária
        e diária: o modo B mede terminal e barreira.
      </p>
    </section>
  );
}

export function Transicoes({
  relatorio,
}: Readonly<{ relatorio: RelatorioModoB }>) {
  const engenheiro = useModoEngenheiro();
  if (relatorio.transicoes.length === 0) {
    return null;
  }
  return (
    <section className="card">
      <h3>Como o veredito mudaria</h3>
      <table className="livro-tabela sombra-transicoes">
        <thead>
          <tr>
            <th scope="col">De</th>
            <th scope="col">Para</th>
            <th scope="col">Linhas</th>
          </tr>
        </thead>
        <tbody>
          {relatorio.transicoes.map((transicao) => (
            <tr key={transicao.codigo} title={transicao.codigo}>
              <td>
                <Badge
                  codigo={transicao.deResultado}
                  dicionario={RESULTADO_DECISAO}
                />{" "}
                {transicao.deMotivo === null
                  ? ""
                  : rotulo(transicao.deMotivo, MOTIVO_DECISAO)}
              </td>
              <td>
                <Badge
                  codigo={transicao.paraResultado}
                  dicionario={RESULTADO_DECISAO}
                />{" "}
                {transicao.paraMotivo === null
                  ? ""
                  : rotulo(transicao.paraMotivo, MOTIVO_DECISAO)}
              </td>
              <td className="funil-val">{inteiro(transicao.linhas)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {engenheiro ? (
        <p className="scope mesa-cru">
          {relatorio.transicoes.map((t) => t.codigo).join(" · ")}
        </p>
      ) : null}
    </section>
  );
}

/**
 * A varredura do modo A: uma barra por valor, a linha do valor gravado, e os
 * pontos de virada.
 *
 * A sub-barra "abaixo da ordem mínima" existe porque aceitar por edge e não
 * conseguir dimensionar não é ação nova; somá-la com o resto contaria ganho
 * que não há.
 */
export function Varredura({
  relatorio,
}: Readonly<{ relatorio: RelatorioModoA }>) {
  const maior = relatorio.candidatos.reduce(
    (maximo, candidato) => Math.max(maximo, candidato.linhas),
    0,
  );
  return (
    <section className="card">
      <h3>
        Varredura de <code>{relatorio.chave ?? "—"}</code>
      </h3>
      <p className="scope">
        Valor gravado: <strong>{decimal(relatorio.valorGravado)}</strong>. Cada
        barra é quantas linhas mudariam de AÇÃO se só esta chave mudasse.
      </p>
      <ul className="funil sombra-varredura">
        {relatorio.candidatos.map((candidato) => (
          <li
            key={String(candidato.valor)}
            className={
              candidato.valor === relatorio.valorGravado
                ? "sombra-gravado"
                : undefined
            }
          >
            <span className="funil-rot">
              {decimal(candidato.valor)}
              {candidato.valor === relatorio.valorGravado ? " (gravado)" : ""}
            </span>
            <span className="bar" aria-hidden="true">
              <span
                className="bar-fill"
                style={{
                  width: `${String(maior === 0 ? 0 : (candidato.linhas / maior) * 100)}%`,
                }}
              />
              <span
                className="bar-fill sombra-sub-barra"
                style={{
                  width: `${String(maior === 0 ? 0 : (candidato.abaixoDaOrdemMinima / maior) * 100)}%`,
                }}
              />
            </span>
            <span className="funil-val">
              {inteiro(candidato.linhas)}
              <small> · {inteiro(candidato.mercados)} mercados</small>
            </span>
            <span className="funil-nota">
              {candidato.abaixoDaOrdemMinima === 0
                ? ""
                : `${inteiro(candidato.abaixoDaOrdemMinima)} nascem abaixo da ordem mínima`}
            </span>
          </li>
        ))}
      </ul>
      {relatorio.viradas.length === 0 ? null : (
        <p className="scope">
          <strong>{inteiro(relatorio.viradas.length)}</strong> valores de virada
          de AÇÃO, entre{" "}
          <strong>{decimal(relatorio.viradas[0] ?? null)}</strong> e{" "}
          <strong>
            {decimal(relatorio.viradas[relatorio.viradas.length - 1] ?? null)}
          </strong>
          {relatorio.viradasProcuradas === null
            ? ""
            : ` (de ${inteiro(relatorio.viradasProcuradas)} procuradas)`}
          . Uma virada tão perto do valor gravado quer dizer que a decisão é
          sensível à segunda casa, não que a segunda casa esteja errada.
        </p>
      )}
    </section>
  );
}

export function Historico({
  rodadas,
}: Readonly<{ rodadas: readonly RodadaListada[] }>) {
  return (
    <section className="card">
      <h3>Rodadas em disco</h3>
      {rodadas.length === 0 ? (
        <p className="empty">
          Nenhuma rodada gravada ainda. O job roda às 03:30 UTC.
        </p>
      ) : (
        <table className="livro-tabela">
          <thead>
            <tr>
              <th scope="col">Data</th>
              <th scope="col">Modo</th>
              <th scope="col">Bytes</th>
              <th scope="col">Gravada em</th>
            </tr>
          </thead>
          <tbody>
            {rodadas.map((rodada) => (
              <tr key={`${rodada.runDate}-${rodada.modo}`}>
                <td>{rodada.runDate}</td>
                <td>{rodada.modo}</td>
                <td className="funil-val">{inteiro(rodada.bytes)}</td>
                <td>{instante(rodada.mtime)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------

export function SombraView({ estado }: Readonly<{ estado: Estado }>) {
  if (estado.tipo === "carregando") {
    return <p className="empty">Lendo a rodada de hoje…</p>;
  }
  if (estado.tipo === "erro") {
    return (
      <p className="card-note card-note--error">
        Não foi possível ler o shadow replay. Se o job nunca rodou nesta
        máquina, as rotas respondem 404 e é isto que se vê —{" "}
        <code>docs/ops/SHADOW_REPLAY_JOB.md</code> diz como instalar o timer.
      </p>
    );
  }
  const { modoB, modoA, rodadas } = estado;
  return (
    <div className="sombra">
      <p className="scope">
        Simulação. O shadow replay pergunta &quot;o que o motor teria feito com
        outra config (modo A) ou com outra fonte de estimativa (modo B)&quot; —
        e responde com número medido, não com opinião. Nada aqui promove modelo,
        cunha config ou dispara a rodada: o job é do host, às 03:30 UTC.
      </p>
      <AvisoModelosMisturados rodada={modoB} />
      {modoB === null ? null : <FalhaDeHoje rodada={modoB} />}
      {modoA === null ? null : <FalhaDeHoje rodada={modoA} />}
      {modoB === null ? (
        <p className="empty">Sem rodada do modo B.</p>
      ) : (
        <>
          <Proveniencia rodada={modoB} />
          {modoB.modoB === null ? null : (
            <>
              <Funil relatorio={modoB.modoB} />
              <CartaoPnl relatorio={modoB.modoB} />
              <Transicoes relatorio={modoB.modoB} />
            </>
          )}
        </>
      )}
      {modoA === null || modoA.modoA === null ? null : (
        <Varredura relatorio={modoA.modoA} />
      )}
      <Historico rodadas={rodadas} />
    </div>
  );
}

export function Sombra({
  accessToken,
  onUnauthorized,
}: Readonly<{
  accessToken: string;
  onUnauthorized: () => void;
}>) {
  const [estado, setEstado] = useState<Estado>({ tipo: "carregando" });
  const montado = useRef(true);

  const carregar = useCallback(
    async (signal: AbortSignal): Promise<void> => {
      const [b, a, runs] = await buscaDaTelaSombra(accessToken, fetch, signal);
      if (!montado.current || signal.aborted) {
        return;
      }
      if (
        b.kind === "unauthorized" ||
        a.kind === "unauthorized" ||
        runs.kind === "unauthorized"
      ) {
        onUnauthorized();
        return;
      }
      if (b.kind === "error" && a.kind === "error") {
        setEstado({ tipo: "erro" });
        return;
      }
      setEstado({
        tipo: "ok",
        modoB: b.kind === "ok" ? b.value : null,
        modoA: a.kind === "ok" ? a.value : null,
        rodadas: runs.kind === "ok" ? runs.value : [],
      });
    },
    [accessToken, onUnauthorized],
  );

  useEffect(() => {
    montado.current = true;
    // Um AbortController POR ciclo, abortado na saída: sem ele, um poll em voo
    // quando o operador troca de aba resolve depois da desmontagem e escreve
    // num componente que não existe mais.
    const controllers = new Set<AbortController>();
    const disparar = (): void => {
      const controller = new AbortController();
      controllers.add(controller);
      const prazo = window.setTimeout(() => {
        controller.abort();
      }, REQUEST_TIMEOUT_MS);
      void carregar(controller.signal)
        .catch(() => {
          if (montado.current) {
            setEstado({ tipo: "erro" });
          }
        })
        .finally(() => {
          window.clearTimeout(prazo);
          controllers.delete(controller);
        });
    };
    disparar();
    const tique = window.setInterval(disparar, REFRESH_MS);
    return () => {
      montado.current = false;
      window.clearInterval(tique);
      for (const controller of controllers) {
        controller.abort();
      }
    };
  }, [carregar]);

  return <SombraView estado={estado} />;
}
