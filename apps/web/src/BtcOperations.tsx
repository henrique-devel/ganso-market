import { useEffect, useState } from "react";
import type {
  DeskAccount,
  DeskAccountView,
  DeskOperation,
  DeskOrder,
  DeskPage,
} from "@ganso-market/contracts/trading";
import { BtcDesk } from "./BtcDesk.tsx";
import { displayRaw } from "./btc-ticket.js";
import "./btc-desk.css";

type Access = { accessToken: string; onUnauthorized: () => void };
function useRead<T>(
  path: string | null,
  { accessToken, onUnauthorized }: Access,
) {
  const [state, setState] = useState<{
    path: string;
    value?: T;
    error?: string;
  } | null>(null);
  useEffect(() => {
    if (!path) return;
    let alive = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    void (async () => {
      try {
        const response = await fetch(`/api/trading/${path}`, {
          headers: { authorization: `Bearer ${accessToken}` },
          cache: "no-store",
          signal: controller.signal,
        });
        if (response.status === 401) onUnauthorized();
        if (!response.ok)
          throw new Error(
            response.status === 404
              ? "Registro não encontrado nesta conta."
              : "Falha de leitura. Dados indisponíveis nesta tentativa.",
          );
        const value = (await response.json()) as T;
        if (alive) setState({ path, value });
      } catch (error) {
        if (alive)
          setState({
            path,
            error: error instanceof Error ? error.message : "Falha de leitura.",
          });
      } finally {
        clearTimeout(timer);
      }
    })();
    return () => {
      alive = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [path, accessToken, onUnauthorized]);
  // Never render a response from the previous account, page or order.
  return state?.path === path ? state : null;
}
const orderStatus = (status: DeskOrder["status"]) =>
  ({
    active: "ativa",
    filled: "executada",
    cancelled: "cancelada efetivamente",
    expired: "expirada",
  })[status];
export function reasonLabel(code: string): string {
  if (/FUNDING|funding|oracle_unavailable/.test(code))
    return "Funding pendente ou indisponível";
  if (/WARMUP|warmup/.test(code)) return "Coleta em warmup";
  if (/NO_SIGNAL|no_signal/.test(code))
    return "Sem sinal registrado pelo produtor";
  if (/STALE|stale/.test(code)) return "Dados desatualizados";
  if (/MISSING|UNPROVEN|missing|source_time_unproven/.test(code))
    return "Dados ausentes ou origem temporal não comprovada";
  if (/REDUCE_ONLY|HALTED|paused/.test(code)) return "Entradas pausadas";
  if (/BTC_RISK_|BTC_RESERVATION_/.test(code))
    return "Veto de risco ou reserva";
  if (/UNAVAILABLE|failed|error/.test(code))
    return "Falha ou indisponibilidade";
  return "Motivo registrado";
}
export function AccountCondition({
  account,
}: {
  account: DeskAccountView | null;
}) {
  if (!account) return <p>Condições da conta: dados indisponíveis.</p>;
  return (
    <div className="btc-condition">
      <p>
        Risco persistido:{" "}
        <strong>{account.ticket?.risk_state ?? "não disponível"}</strong>.{" "}
        {account.ticket?.risk_reasons.map((code) => (
          <span key={code}>
            {reasonLabel(code)}: <code>{code}</code>.{" "}
          </span>
        ))}
      </p>
      {account.reason_codes.map(({ component, code }) => (
        <p key={`${component}:${code}`}>
          {reasonLabel(code)} · {component}: <code>{code}</code>
        </p>
      ))}
      <p>
        Funding da hora atual:{" "}
        <strong>
          {account.funding
            ? {
                pending: "PENDENTE",
                settled: "liquidado",
                conflict: "CONFLITO",
              }[account.funding.status]
            : "sem recibo disponível"}
        </strong>
        {account.funding && (
          <>
            {" "}
            · {account.funding.period_hour} ·{" "}
            <code>{account.funding.reason}</code>
            {account.funding.model_version && (
              <>
                {" "}
                · modelo <code>{account.funding.model_version}</code>
              </>
            )}
          </>
        )}
        .
      </p>
      <p>
        Funding paper usa taxa final e oracle observado antes do corte (resposta
        recebida até 5 segundos antes). É aproximação de preço, não settlement
        exato da venue: o horário de atualização do oracle é desconhecido. Sem
        taxa ou evidência válida, fica pendente e pode bloquear novas entradas;
        saídas e gestão de risco continuam conforme seus limites.
      </p>
      {account.baseline ? (
        <>
          <p>
            Estratégia paper: <code>{account.baseline.policy_version}</code>.
            Início prospectivo: {account.baseline.start_at}.
          </p>
          <p>
            Últimas {account.baseline.decisions.length} decisões persistidas
            (até 20). Ausência de ordem não representa lucro nem sinal neutro.
          </p>
          {account.baseline.decisions.length === 0 && (
            <p>Aguardando a primeira janela de decisão após o início.</p>
          )}
          {account.baseline.decisions.map((d) => (
            <details key={d.decision_id}>
              <summary>
                {d.bar_end_at} · {d.state}
              </summary>
              <p>
                Processada em {d.decision_at}. Motivos:{" "}
                {d.reasons.join(", ") || "nenhum"}.
              </p>
              {d.candidate && (
                <p>
                  Candidato {d.candidate.direction}:{" "}
                  {displayRaw(d.candidate.quantity_btc_raw, 8)} BTC; stop US${" "}
                  {displayRaw(d.candidate.stop_usd_raw)}.
                </p>
              )}
              <p>
                Admissão:{" "}
                {d.admission
                  ? [
                      d.admission.status,
                      d.admission.reason,
                      ...d.admission.reasons,
                    ]
                      .filter(Boolean)
                      .join(" · ")
                  : "sem ordem proposta"}
                .
              </p>
              <p>
                Execução:{" "}
                {d.execution
                  ? [
                      d.execution.status,
                      d.execution.reason,
                      ...d.execution.reasons,
                    ]
                      .filter(Boolean)
                      .join(" · ")
                  : "sem resultado de execução registrado"}
                .
              </p>
              {d.order_id && (
                <p>
                  Ordem: <code>{d.order_id}</code>. Fills e custos na aba
                  Operações desta conta.
                </p>
              )}
              <p>
                Referência da decisão: <code>{d.decision_id}</code>.
              </p>
            </details>
          ))}
          {account.baseline.exits.map((x) => (
            <p key={x.position_id}>
              Saída {x.state} · prazo {x.deadline} · {x.reasons.join(", ")}.{" "}
              {x.requested_at &&
                `Solicitada em ${x.requested_at}; fechamento depende de livro observado.`}
            </p>
          ))}
        </>
      ) : (
        <p>
          Sinais e warmup de estratégia: sem diagnóstico disponível nesta
          leitura. Uma lista vazia de ordens não prova falta de sinal, veto ou
          conclusão do warmup.
        </p>
      )}
    </div>
  );
}
export function BtcWorkspace(props: Access & { tab: string }) {
  const [selected, setSelected] = useState("manual");
  const [cursor, setCursor] = useState<string | null>(null);
  const accounts = useRead<DeskPage<DeskAccount>>(
    `accounts?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    props,
  );
  const [known, setKnown] = useState<DeskAccount[]>([]);
  useEffect(() => {
    if (accounts?.value)
      setKnown((previous) => {
        const map = new Map(previous.map((a) => [a.account.account_id, a]));
        for (const a of accounts.value!.items) map.set(a.account.account_id, a);
        return [...map.values()];
      });
  }, [accounts]);
  if (!["Mesa", "Operações", "Experimentos"].includes(props.tab)) return null;
  return (
    <>
      <section
        className="btc-desk btc-account-picker"
        aria-label="Conta BTC selecionada"
      >
        <label>
          Conta / cenário independente
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
          >
            {!known.some((a) => a.account.account_id === selected) && (
              <option value={selected}>{selected} · aguardando cadastro</option>
            )}
            {known.map((a) => (
              <option key={a.account.account_id} value={a.account.account_id}>
                {a.account.account_id} ·{" "}
                {a.account.purpose === "manual"
                  ? "manual"
                  : a.account.purpose === "baseline"
                    ? "base"
                    : "desafiante"}{" "}
                · {a.status === "enabled" ? "habilitada" : "inativa"}
              </option>
            ))}
          </select>
        </label>
        <p>
          Somente a conta <strong>{selected}</strong>. Saldos e resultados dos
          cenários nunca são somados.
        </p>
        {accounts?.error && <p role="alert">{accounts.error}</p>}
        {accounts?.value?.items.length === 0 && (
          <p>Nenhuma conta cadastrada nesta página.</p>
        )}
        {accounts?.value?.next_cursor && (
          <button onClick={() => setCursor(accounts.value!.next_cursor)}>
            Carregar mais contas
          </button>
        )}
      </section>
      {props.tab === "Mesa" ? (
        <BtcDesk key={selected} {...props} accountId={selected} />
      ) : props.tab === "Operações" ? (
        <Operations key={selected} {...props} accountId={selected} />
      ) : (
        <section className="btc-desk">
          <h2>Experimentos BTC</h2>
          <p>Conta selecionada: {selected}.</p>
          <p>
            Avaliação de experimentos ainda indisponível. Não há comparação de
            desempenho ou promoção de modelo disponível nesta tela. As decisões
            da conta-base estão na Mesa e seus fills/custos em Operações.
          </p>
          <p>
            Versão cadastrada:{" "}
            {known.find((a) => a.account.account_id === selected)
              ?.strategy_version ?? "não disponível"}
            . Cadastro não comprova execução, sinal ou warmup concluído.
          </p>
          <p>
            Resultados históricos Polymarket permanecem em Acervo legado →
            Sombra.
          </p>
        </section>
      )}
    </>
  );
}
function Operations(props: Access & { accountId: string }) {
  const [order, setOrder] = useState<string | null>(null);
  const [position, setPosition] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const path = `orders?account_id=${encodeURIComponent(props.accountId)}&limit=20${position ? `&position_id=${encodeURIComponent(position)}` : ""}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
  return (
    <section className="btc-desk">
      <h2>Operações BTC</h2>
      <p>
        Ordens, execução efetiva e custos persistidos · SIMULAÇÃO · conta{" "}
        {props.accountId}
      </p>
      <button
        onClick={() => {
          setCursor(null);
          setRevision((v) => v + 1);
        }}
      >
        Atualizar primeira página
      </button>
      {position && (
        <p>
          Posição {position}{" "}
          <button
            onClick={() => {
              setPosition(null);
              setCursor(null);
            }}
          >
            Todas as posições
          </button>
        </p>
      )}
      <OrderPage
        key={`${path}:${revision}`}
        path={path}
        {...props}
        onSelect={setOrder}
        onNext={setCursor}
      />
      {order && (
        <OperationReader
          key={`${order}:${revision}`}
          {...props}
          orderId={order}
          onPosition={(p) => {
            setPosition(p);
            setCursor(null);
          }}
          onClose={() => setOrder(null)}
        />
      )}
    </section>
  );
}
function OrderPage(
  props: Access & {
    path: string;
    onSelect: (order: string) => void;
    onNext: (cursor: string) => void;
  },
) {
  const state = useRead<DeskPage<DeskOrder>>(props.path, props);
  if (!state) return <p role="status">Carregando ordens…</p>;
  if (state.error) return <p role="alert">{state.error}</p>;
  const data = state.value!;
  return (
    <>
      {data.status === "unavailable" && (
        <p role="alert">
          Leitura indisponível:{" "}
          {data.reason_codes.map((r) => r.code).join(", ")}
        </p>
      )}
      {data.items.length === 0 ? (
        <p>
          Nenhuma ordem registrada nesta página. Isso não informa o motivo de
          não operar.
        </p>
      ) : (
        <div className="btc-table">
          <table>
            <thead>
              <tr>
                <th>Ordem / posição</th>
                <th>Lado / intenção</th>
                <th>Fill BTC</th>
                <th>Estado</th>
                <th>Histórico</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((o) => (
                <tr key={o.order_id}>
                  <td>
                    <code>{o.order_id}</code>
                    <br />
                    {o.position_id}
                  </td>
                  <td>
                    {o.side === "buy" ? "Compra" : "Venda"} ·{" "}
                    {o.intent === "open" ? "abertura" : "saída"}
                  </td>
                  <td>
                    {displayRaw(o.filled_btc_raw, 8)} /{" "}
                    {displayRaw(o.quantity_btc_raw, 8)}
                  </td>
                  <td>
                    {o.filled_btc_raw !== "0" &&
                      o.filled_btc_raw !== o.quantity_btc_raw &&
                      "Parcial · "}
                    {orderStatus(o.status)}
                  </td>
                  <td>
                    <button onClick={() => props.onSelect(o.order_id)}>
                      Abrir ficha
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data.next_cursor && (
        <button onClick={() => props.onNext(data.next_cursor!)}>
          Próxima página de ordens
        </button>
      )}
    </>
  );
}
function OperationReader(
  props: Access & {
    accountId: string;
    orderId: string;
    onPosition: (id: string) => void;
    onClose: () => void;
  },
) {
  const [view, setView] = useState<"events" | "receipts">("events");
  const [cursor, setCursor] = useState<string | null>(null);
  const path = `operation?account_id=${encodeURIComponent(props.accountId)}&order_id=${encodeURIComponent(props.orderId)}&view=${view}&limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
  const state = useRead<DeskOperation>(path, props);
  return (
    <article className="btc-operation" aria-label="Ficha da operação">
      <h3>Ficha da operação</h3>
      <button onClick={props.onClose}>Fechar ficha</button>
      <nav aria-label="Dados da operação">
        <button
          aria-pressed={view === "events"}
          onClick={() => {
            setView("events");
            setCursor(null);
          }}
        >
          Reserva, fills e taxas
        </button>
        <button
          aria-pressed={view === "receipts"}
          onClick={() => {
            setView("receipts");
            setCursor(null);
          }}
        >
          Motivos de execução
        </button>
      </nav>
      {!state ? (
        <p role="status">Carregando ficha…</p>
      ) : state.error ? (
        <p role="alert">{state.error}</p>
      ) : (
        <>
          <OperationDetail detail={state.value!} />
          <button
            onClick={() => props.onPosition(state.value!.order.position_id)}
          >
            Ver abertura e saídas desta posição
          </button>
          {state.value!.next_cursor && (
            <button onClick={() => setCursor(state.value!.next_cursor)}>
              Próxima página da ficha
            </button>
          )}
        </>
      )}
    </article>
  );
}
export function OperationDetail({ detail: d }: { detail: DeskOperation }) {
  return (
    <>
      <p>
        Conta <strong>{d.scope.account_id}</strong> · ordem{" "}
        <code>{d.order.order_id}</code> · posição{" "}
        <code>{d.order.position_id}</code>
      </p>
      <h4>Inputs persistidos no aceite</h4>
      <dl className="btc-facts">
        <dt>Origem / intenção</dt>
        <dd>
          {d.order.source === "manual" ? "Manual" : "Estratégia"} ·{" "}
          {d.order.intent === "open" ? "Abertura" : "Saída"} ·{" "}
          {d.order.side === "buy" ? "Compra" : "Venda"}
        </dd>
        <dt>Quantidade BTC</dt>
        <dd>{displayRaw(d.order.quantity_btc_raw, 8)}</dd>
        <dt>Limite / teto USD</dt>
        <dd>
          {displayRaw(d.execution_input?.limit_price_usd_raw)} /{" "}
          {displayRaw(d.order.price_cap_usd_raw)}
        </dd>
        <dt>Stop / piso USD</dt>
        <dd>
          {displayRaw(d.order.risk_plan?.stop_price_usd_raw)} /{" "}
          {displayRaw(d.order.risk_plan?.entry_floor_usd_raw)}
        </dd>
        <dt>Regime / taxa para reserva</dt>
        <dd>
          {d.broker === "ioc"
            ? "IOC"
            : d.broker === "passive"
              ? "Passiva"
              : "não registrado"}{" "}
          · {d.order.fee_bps} bps
        </dd>
        <dt>Aceite / validade UTC</dt>
        <dd>
          {d.accepted_at} / {d.order.valid_until}
        </dd>
        <dt>Decisão / latência</dt>
        <dd>
          {d.execution_input?.decision_at ?? "não registrada"} /{" "}
          {d.execution_input?.latency_ms === undefined
            ? "não registrada"
            : `${d.execution_input.latency_ms} ms`}
        </dd>
        <dt>Fonte das taxas</dt>
        <dd>{d.execution_input?.fee_metadata_id ?? "não registrada"}</dd>
        <dt>Evidência da decisão</dt>
        <dd>{d.decision_evidence_id ?? "não disponível"}</dd>
      </dl>
      <p>
        Justificativa de sinal: não disponível neste contrato. Os motivos abaixo
        vêm dos registros de execução; não explicam retroativamente por que o
        operador decidiu entrar.
      </p>
      {d.protective_exit ? (
        <p>
          Saída protetiva solicitada: <code>{d.protective_exit.reason}</code> ·{" "}
          {d.protective_exit.triggered_at}. Solicitação não comprova
          encerramento.
        </p>
      ) : (
        <p>
          Sem solicitação de saída protetiva registrada. Consulte as ordens da
          posição para saídas manuais e seus fills.
        </p>
      )}
      {d.view === "events" ? (
        <>
          <h4>Eventos efetivos · sequência persistida</h4>
          {d.events.length === 0 && <p>Eventos indisponíveis nesta página.</p>}
          <ol className="btc-events">
            {d.events.map((e) => (
              <li key={e.sequence}>
                <strong>
                  {e.action === "consume"
                    ? "Execução efetiva"
                    : e.action === "release"
                      ? "Liberação da reserva"
                      : "Reserva aceita"}
                </strong>{" "}
                · {e.recorded_at}
                <p>
                  Sequência {e.sequence} · <code>{e.operation_id}</code> ·{" "}
                  {orderStatus(e.status)} · restante{" "}
                  {displayRaw(e.remaining_btc_raw, 8)} BTC
                  {e.reason && <> · motivo persistido: {e.reason}</>}
                </p>
                {e.ledger.map((l) => (
                  <p key={l.event_id}>
                    <code>{l.event_id}</code> ·{" "}
                    {l.payload.event_type === "fill" ? (
                      <>
                        Fill {displayRaw(l.payload.quantity.raw, 8)} BTC a US${" "}
                        {displayRaw(l.payload.price.raw)} · execução{" "}
                        {l.payload.execution_id}
                      </>
                    ) : l.payload.event_type === "fee" ? (
                      <>
                        Taxa efetiva (fluxo de caixa): US${" "}
                        {displayRaw(l.payload.delta.raw)}
                      </>
                    ) : (
                      l.payload.event_type
                    )}{" "}
                    · tempo econômico {l.occurred_at} · ledger #{l.sequence}
                  </p>
                ))}
                {e.action === "consume" && e.ledger.length === 0 && (
                  <p>
                    Vínculo financeiro indisponível; não há fill comprovado
                    nesta leitura.
                  </p>
                )}
              </li>
            ))}
          </ol>
        </>
      ) : (
        <>
          <h4>Recibos persistidos do broker</h4>
          <p>
            Paginação por identificador do recibo (IOC) ou sequência (passiva).
            Horário e evidência acompanham cada motivo.
          </p>
          {d.receipts.length === 0 && (
            <p>
              Nenhum recibo disponível nesta página. Não significa execução
              bem-sucedida.
            </p>
          )}
          <ul className="btc-events">
            {d.receipts.map((r) => (
              <li key={r.cursor}>
                {reasonLabel(r.reason)}: <code>{r.reason}</code>
                <p>
                  {r.recorded_at} · operação {r.operation_id} · evidência{" "}
                  {r.evidence_id} · livro{" "}
                  {r.book_key ?? "não registrado neste recibo"}
                </p>
              </li>
            ))}
          </ul>
        </>
      )}
      <p>
        Taxas mostradas por fill, sem total parcial disfarçado de total da
        operação. Funding e PnL da conta estão na Mesa; nenhum custo ausente é
        convertido em zero.
      </p>
    </>
  );
}
