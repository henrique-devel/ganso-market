import { useEffect, useRef, useState } from "react";
import type {
  DeskAccountView,
  DeskCommand,
  DeskCommandPreview,
  DeskOrder,
  DeskPosition,
  DeskPage,
} from "@ganso-market/contracts/trading";
import {
  decimalRaw,
  displayRaw,
  inputRaw,
  quantityFromNotional,
  previewTicket,
  sendTicket,
  TicketError,
  type PendingTicket,
} from "./btc-ticket.js";
import { AccountCondition, reasonLabel } from "./BtcOperations.tsx";
import "./btc-desk.css";
const storageKey = (account: string) =>
  account === "manual"
    ? "ganso.manual.pending.v1"
    : `ganso.${account}.pending.v1`;
const saved = (storage: string): PendingTicket | null => {
  try {
    return JSON.parse(
      sessionStorage.getItem(storage) ?? "null",
    ) as PendingTicket | null;
  } catch {
    return null;
  }
};
const quality = (q: string | undefined) =>
  q === "fresh"
    ? "dentro do limite"
    : q === "stale"
      ? "DESATUALIZADO"
      : (q ?? "indisponível");
export function BtcDesk({
  accessToken,
  onUnauthorized,
  accountId = "manual",
}: {
  accessToken: string;
  accountId?: string;
  onUnauthorized: () => void;
}) {
  const storage = storageKey(accountId);
  const [account, setAccount] = useState<DeskAccountView | null>(null),
    [orders, setOrders] = useState<DeskOrder[]>([]),
    [positions, setPositions] = useState<DeskPosition[]>([]);
  const [readError, setReadError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [pending, setPending] = useState<PendingTicket | null>(() =>
      saved(storage),
    ),
    [preview, setPreview] = useState<DeskCommandPreview | null>(null);
  const [side, setSide] = useState<"buy" | "sell">("buy"),
    [unit, setUnit] = useState("BTC"),
    [size, setSize] = useState("0,001"),
    [limit, setLimit] = useState(""),
    [cap, setCap] = useState(""),
    [floor, setFloor] = useState(""),
    [stop, setStop] = useState(""),
    [seconds, setSeconds] = useState("60");
  const [now, setNow] = useState(Date.now()),
    [revision, setRevision] = useState(0);
  const inFlight = useRef(false);
  useEffect(() => {
    if (pending) sessionStorage.setItem(storage, JSON.stringify(pending));
    else sessionStorage.removeItem(storage);
  }, [pending, storage]);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const get = async <T,>(route: string): Promise<T> => {
          const r = await fetch(`/api/trading/${route}`, {
            headers: { authorization: `Bearer ${accessToken}` },
            cache: "no-store",
            signal: AbortSignal.timeout(5000),
          });
          if (r.status === 401) onUnauthorized();
          if (!r.ok)
            throw new Error(
              r.status === 404
                ? "Conta ainda não disponível."
                : "Leitura indisponível. Aguarde a atualização.",
            );
          return r.json() as Promise<T>;
        };
        const [a, o, p] = await Promise.all([
          get<DeskAccountView>(
            `account?account_id=${encodeURIComponent(accountId)}`,
          ),
          get<DeskPage<DeskOrder>>(
            `orders?account_id=${encodeURIComponent(accountId)}&limit=100`,
          ),
          get<DeskPage<DeskPosition>>(
            `positions?account_id=${encodeURIComponent(accountId)}&limit=100`,
          ),
        ]);
        if (alive) {
          setAccount(a);
          setOrders([...o.items]);
          setPositions([...p.items]);
          setReadError(
            o.next_cursor || p.next_cursor
              ? "Exibindo a primeira página (até 100 registros)."
              : "",
          );
        }
      } catch (e) {
        if (alive)
          setReadError(
            e instanceof Error ? e.message : "Leitura indisponível.",
          );
      }
      if (alive) timer = setTimeout(load, 2000);
    };
    void load();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [accessToken, onUnauthorized, revision, accountId]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const ticket = account?.ticket;
  const age = (at: string | null | undefined) =>
    at
      ? Math.max(0, (now - Date.parse(at)) / 1000).toFixed(1) + " s"
      : "desconhecida";
  const freshRead = !!account && now - Date.parse(account.as_of) < 5000;
  const bookFresh =
    freshRead &&
    account?.book?.quality === "fresh" &&
    !!account.book.source_timestamp &&
    now - Date.parse(account.book.source_timestamp) <= 2000;
  const markFresh =
    freshRead &&
    account?.mark?.quality === "fresh" &&
    !!account.mark.received_at &&
    now -
      Date.parse(
        account.mark.freshness_timestamp ?? account.mark.received_at,
      ) <=
      5000;
  const operational =
    !!ticket?.enabled && !!ticket.consumer_ready && freshRead && !readError;
  const transact = async (command?: DeskCommand) => {
    if (
      inFlight.current ||
      (accountId !== "manual" &&
        (command?.action ?? pending?.command.action) !== "pause")
    )
      return;
    inFlight.current = true;
    setBusy(true);
    setMessage("");
    try {
      const next = command
        ? { key: crypto.randomUUID(), command, attempted: false }
        : pending;
      if (!next) throw new Error("Prepare uma intenção primeiro.");
      setPending(next);
      const p = await previewTicket(accessToken, next);
      setPreview(p);
      setMessage(
        p.replay
          ? "Resultado anterior encontrado. Confirme para recuperar o mesmo recibo."
          : "Confira a prévia. O aceite e a execução revalidam os dados.",
      );
    } catch (e) {
      setPreview(null);
      setMessage(
        e instanceof TicketError
          ? `Prévia recusada · ${reasonLabel(e.code)}: ${e.code}`
          : String(e),
      );
      if (e instanceof TicketError && e.code === "AUTH_UNAUTHENTICATED")
        onUnauthorized();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const confirm = async () => {
    if (inFlight.current || !pending || !preview) return;
    inFlight.current = true;
    setBusy(true);
    const attempted = { ...pending, attempted: true };
    setPending(attempted);
    // Persist before dispatch, so a reload or lost response cannot create a new intention.
    sessionStorage.setItem(storage, JSON.stringify(attempted));
    setMessage(
      pending.command.action === "cancel"
        ? "Cancelamento solicitado; aguardando confirmação efetiva…"
        : "Enviando intenção simulada…",
    );
    try {
      const r = await sendTicket(accessToken, attempted, preview);
      setMessage(
        r.status === "accepted"
          ? "Ordem aceita. Acompanhe a execução abaixo; aceite não é fill."
          : r.status === "cancelled"
            ? "Cancelamento efetivo. Execuções anteriores permanecem no extrato."
            : r.status === "entries_paused"
              ? "Novas exposições pausadas. Saídas continuam geridas."
              : "A ordem já estava encerrada.",
      );
      setPending(null);
      sessionStorage.removeItem(storage);
      setPreview(null);
      setRevision((v) => v + 1);
    } catch (e) {
      setPreview(null);
      if (e instanceof TicketError) {
        setMessage(
          `${e.ambiguous ? "Resultado indeterminado. Verifique/reenvie a mesma intenção." : "Comando recusado"} · ${reasonLabel(e.code)}: ${e.code}`,
        );
        if (e.ambiguous || pending.ambiguous) {
          const uncertain = { ...attempted, ambiguous: true };
          setPending(uncertain);
          sessionStorage.setItem(storage, JSON.stringify(uncertain));
        } else {
          setPending(null);
          sessionStorage.removeItem(storage);
        }
        if (e.code === "AUTH_UNAUTHENTICATED") onUnauthorized();
      } else setMessage("Resultado indeterminado. Repita a mesma intenção.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const submit = () => {
    try {
      const price = decimalRaw(limit, 6),
        maximum = decimalRaw(cap, 6),
        quantity =
          unit === "USD"
            ? quantityFromNotional(
                decimalRaw(size, 6),
                price,
                ticket?.quantity_step_btc_raw ?? "1000",
              )
            : decimalRaw(size, 8);
      void transact({
        account_id: "manual",
        action: "submit",
        side,
        quantity_btc_raw: quantity,
        limit_price_usd_raw: price,
        price_cap_usd_raw: maximum,
        valid_until: new Date(
          Date.now() + Number(seconds) * 1000,
        ).toISOString(),
        risk_plan: {
          stop_price_usd_raw: decimalRaw(stop, 6),
          entry_floor_usd_raw: decimalRaw(floor, 6),
        },
      });
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    }
  };
  const close = (p: DeskPosition) => {
    try {
      void transact({
        account_id: "manual",
        action: "close",
        position_id: p.position_id,
        limit_price_usd_raw: decimalRaw(limit, 6),
        price_cap_usd_raw: decimalRaw(cap, 6),
        valid_until: new Date(
          Date.now() + Number(seconds) * 1000,
        ).toISOString(),
      });
    } catch {
      setMessage(
        "Informe limite, proteção de preço e validade antes de encerrar.",
      );
    }
  };
  const reference = () => {
    const p =
      side === "buy" ? ticket?.ask_price_usd_raw : ticket?.bid_price_usd_raw;
    if (p) {
      setLimit(inputRaw(p));
      setCap(inputRaw(p));
      setFloor(inputRaw(p));
    }
    setMessage(
      "Referência copiada do livro. Defina o stop e revise os limites antes de enviar.",
    );
  };
  return (
    <section className="btc-desk" aria-label="Mesa BTC simulada">
      <header>
        <p className="btc-badge">SIMULAÇÃO · {accountId}</p>
        <h2>Mesa BTC / USD</h2>
        <p>
          Fonte real: Hyperliquid mainnet · saldo exclusivamente fictício ·
          margem isolada 1×
        </p>
      </header>
      <div className="btc-status" role="status">
        <strong>
          {operational ? "Consumidor operacional" : "Envio indisponível"}
        </strong>
        <span>
          Livro: {bookFresh ? quality(account?.book?.quality) : "DESATUALIZADO"}{" "}
          · idade da origem {age(account?.book?.source_timestamp)}
        </span>
        <span>
          Contexto:{" "}
          {markFresh
            ? quality(account?.mark?.quality)
            : "DESATUALIZADO / indisponível"}{" "}
          · resposta HTTP {age(account?.mark?.received_at)} · timestamp de
          origem {account?.mark?.source_timestamp ?? "desconhecido"}
        </span>
        <small>
          A idade HTTP mede a resposta do snapshot; não comprova quando o preço
          mudou. Sem garantia de fill ou lucro.
        </small>
        <span>
          Risco: {ticket?.risk_state ?? "a validar"}{" "}
          {ticket?.risk_reasons.join(", ")} · consumidor{" "}
          {age(ticket?.consumer_at)} {ticket?.consumer_reason}
        </span>
      </div>
      <AccountCondition account={account} />
      {readError && <p role="alert">{readError}</p>}
      <div className="btc-balances">
        <p>
          Saldo fictício
          <strong>US$ {displayRaw(account?.balances?.balance_usd_raw)}</strong>
        </p>
        <p>
          Patrimônio estimado
          <strong>US$ {displayRaw(account?.balances?.equity_usd_raw)}</strong>
        </p>
        <p>
          Caixa sem reservas
          <strong>
            US$ {displayRaw(account?.margin?.unreserved_cash_usd_raw)}
          </strong>
        </p>
      </div>
      {accountId === "manual" && (
        <div className="btc-columns">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <fieldset disabled={busy || !!pending}>
              <legend>Nova ordem simulada</legend>
              <label>
                Lado
                <select
                  value={side}
                  onChange={(e) => setSide(e.target.value as "buy" | "sell")}
                >
                  <option value="buy">Comprar / abrir long</option>
                  <option value="sell">Vender / abrir short</option>
                </select>
              </label>
              <label>
                Tipo
                <select value={ticket?.broker ?? "ioc"} disabled>
                  <option value="ioc">
                    Limite IOC · executa e cancela o restante
                  </option>
                  <option value="passive">
                    Limite passiva · fila observada
                  </option>
                </select>
              </label>
              <small>
                Regime fixo desta conta; cenários não compartilham capital.
              </small>
              <label>
                Informar por
                <select value={unit} onChange={(e) => setUnit(e.target.value)}>
                  <option>BTC</option>
                  <option value="USD">Nocional USD</option>
                </select>
              </label>
              <label>
                {unit === "BTC"
                  ? "Quantidade BTC"
                  : "Nocional USD (arredonda para baixo)"}
                <input
                  inputMode="decimal"
                  value={size}
                  onChange={(e) => setSize(e.target.value)}
                  required
                />
              </label>
              <button type="button" onClick={reference} disabled={!freshRead}>
                Usar referência do livro
              </button>
              <label>
                Preço limite USD (compra: teto; venda: piso)
                <input
                  inputMode="decimal"
                  value={limit}
                  onChange={(e) => setLimit(e.target.value)}
                  required
                />
              </label>
              <label>
                Teto de preço para reserva e execução USD
                <input
                  inputMode="decimal"
                  value={cap}
                  onChange={(e) => setCap(e.target.value)}
                  required
                />
              </label>
              <label>
                Piso planejado da entrada USD
                <input
                  inputMode="decimal"
                  value={floor}
                  onChange={(e) => setFloor(e.target.value)}
                  required
                />
              </label>
              <label>
                Stop de proteção USD
                <input
                  inputMode="decimal"
                  value={stop}
                  onChange={(e) => setStop(e.target.value)}
                  required
                />
              </label>
              <label>
                Validade
                <select
                  value={seconds}
                  onChange={(e) => setSeconds(e.target.value)}
                >
                  <option value="30">30 segundos</option>
                  <option value="60">1 minuto</option>
                  <option value="300">5 minutos</option>
                  <option value="3600">1 hora</option>
                </select>
              </label>
              <p>
                Exposição até 25%; risco planejado até 0,25%; pausa diária em
                1,5% e drawdown em 5%. Stop depende de livro válido e pode
                sofrer slippage.
              </p>
              <button
                disabled={!operational || !bookFresh || !markFresh || !!pending}
                type="submit"
              >
                Calcular prévia
              </button>
            </fieldset>
          </form>
          <aside className="btc-preview" aria-label="Prévia da intenção">
            <h3>Prévia e confirmação</h3>
            {pending &&
              (pending.command.action === "submit" ||
                pending.command.action === "close") && (
                <p>
                  Limite US$ {displayRaw(pending.command.limit_price_usd_raw)} ·
                  teto US$ {displayRaw(pending.command.price_cap_usd_raw)} ·
                  válida até{" "}
                  {new Date(pending.command.valid_until).toLocaleTimeString(
                    "pt-BR",
                  )}
                </p>
              )}
            {pending && (
              <p>
                {pending.command.action === "submit"
                  ? pending.command.side === "buy"
                    ? "Comprar"
                    : "Vender"
                  : pending.command.action === "close"
                    ? "Encerrar posição"
                    : pending.command.action === "cancel"
                      ? "Cancelar ordem"
                      : "Pausar novas exposições"}{" "}
                · conta manual
              </p>
            )}
            {preview?.estimate && (
              <dl>
                <dt>Quantidade</dt>
                <dd>{displayRaw(preview.estimate.quantity_btc_raw, 8)} BTC</dd>
                <dt>Nocional máximo</dt>
                <dd>
                  US$ {displayRaw(preview.estimate.maximum_notional_usd_raw)}
                </dd>
                <dt>Margem reservada</dt>
                <dd>
                  US$ {displayRaw(preview.estimate.reserved_margin_usd_raw)}
                </dd>
                <dt>Reserva de taxas</dt>
                <dd>
                  US$ {displayRaw(preview.estimate.reserved_fees_usd_raw)}
                </dd>
                <dt>Risco / dados</dt>
                <dd>
                  {preview.estimate.risk_state ?? "a validar"} · marca{" "}
                  {quality(preview.estimate.mark_quality)} · livro{" "}
                  {quality(preview.estimate.book_quality)}
                </dd>
              </dl>
            )}
            {preview && (
              <>
                <p>
                  Taxa pública base, sem descontos. Prévia válida até{" "}
                  {new Date(preview.expires_at).toLocaleTimeString("pt-BR")}.
                </p>
                <button
                  disabled={busy || now >= Date.parse(preview.expires_at)}
                  onClick={() => void confirm()}
                >
                  Confirmar simulação
                </button>
              </>
            )}
            {pending && (
              <button disabled={busy} onClick={() => void transact()}>
                Verificar / repetir a mesma intenção
              </button>
            )}
            {pending && !pending.attempted && (
              <button
                disabled={busy}
                onClick={() => {
                  setPending(null);
                  setPreview(null);
                }}
              >
                Descartar prévia
              </button>
            )}
            <p role="status" aria-live="polite">
              {message}
            </p>
            <button
              disabled={busy || !!pending}
              onClick={() =>
                void transact({ account_id: "manual", action: "pause" })
              }
            >
              Pausar novas exposições
            </button>
          </aside>
        </div>
      )}
      {account?.account.account.purpose === "baseline" && (
        <section aria-label="Pausa da conta-base">
          <p>
            A pausa persiste após reinício. Saídas continuam geridas; rearme
            exige ação explícita do operador.
          </p>
          <button
            disabled={busy || !!pending}
            onClick={() =>
              void transact({ account_id: accountId, action: "pause" })
            }
          >
            Pausar novas exposições da conta-base
          </button>
          {preview && (
            <button disabled={busy} onClick={() => void confirm()}>
              Confirmar pausa paper
            </button>
          )}
          {pending && (
            <button disabled={busy} onClick={() => void transact()}>
              Verificar / repetir a mesma intenção
            </button>
          )}
          <p role="status">{message}</p>
        </section>
      )}
      <h3>Posições e saída</h3>
      {accountId === "manual" && (
        <p>
          Para encerrar, preencha preço limite, teto de proteção e validade no
          ticket. A saída reduz a posição existente.
        </p>
      )}
      <div className="btc-table">
        <table>
          <thead>
            <tr>
              <th>Posição</th>
              <th>BTC</th>
              <th>Margem USD</th>
              <th>Ação</th>
            </tr>
          </thead>
          <tbody>
            {positions.map((p) => (
              <tr key={p.position_id}>
                <td title={p.position_id}>{p.position_id.slice(-12)}</td>
                <td>{displayRaw(p.quantity_btc_raw, 8)}</td>
                <td>{displayRaw(p.collateral_usd_raw)}</td>
                <td>
                  {p.quantity_btc_raw !== "0" && accountId === "manual" ? (
                    <button
                      disabled={!operational || busy || !!pending}
                      onClick={() => close(p)}
                    >
                      Encerrar
                    </button>
                  ) : p.quantity_btc_raw === "0" ? (
                    "Encerrada"
                  ) : (
                    "Somente leitura"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3>Ordens · estado efetivo</h3>
      <div className="btc-table">
        <table>
          <thead>
            <tr>
              <th>Ordem</th>
              <th>Lado / intenção</th>
              <th>Executado BTC</th>
              <th>Restante BTC</th>
              <th>Estado</th>
              <th>Ação</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.order_id}>
                <td title={o.order_id}>{o.order_id.slice(-12)}</td>
                <td>
                  {o.side === "buy" ? "Compra" : "Venda"} /{" "}
                  {o.intent === "reduce" ? "saída" : "abertura"}
                </td>
                <td>{displayRaw(o.filled_btc_raw, 8)}</td>
                <td>{displayRaw(o.remaining_btc_raw, 8)}</td>
                <td>
                  {o.filled_btc_raw !== "0" &&
                  o.filled_btc_raw !== o.quantity_btc_raw
                    ? "Parcial · "
                    : ""}
                  {
                    {
                      active: "ativa",
                      filled: "executada",
                      cancelled: "cancelada efetivamente",
                      expired: "expirada",
                    }[o.status]
                  }
                </td>
                <td>
                  {o.status === "active" && accountId === "manual" && (
                    <button
                      disabled={busy || !!pending}
                      onClick={() =>
                        void transact({
                          account_id: "manual",
                          action: "cancel",
                          order_id: o.order_id,
                        })
                      }
                    >
                      Cancelar
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3>Extrato resumido · valores fictícios</h3>
      <div className="btc-balances">
        <p>
          PnL realizado
          <strong>
            US$ {displayRaw(account?.balances?.realized_pnl_usd_raw)}
          </strong>
        </p>
        <p>
          Taxas acumuladas
          <strong>US$ {displayRaw(account?.balances?.fees_usd_raw)}</strong>
        </p>
        <p>
          Funding registrado
          <strong>US$ {displayRaw(account?.balances?.funding_usd_raw)}</strong>
        </p>
      </div>
      <p>
        Sequência financeira {account?.ledger_sequence ?? "indisponível"} ·
        atualizado {account?.ledger_recorded_at ?? "indisponível"}. Perdas e
        execuções permanecem no histórico.
      </p>
    </section>
  );
}
