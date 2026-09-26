import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type {
  DeskAccountView,
  DeskJevView,
  DeskOperation,
} from "@ganso-market/contracts/trading";
import {
  AccountCondition,
  JevStatus,
  OperationDetail,
  reasonLabel,
} from "../src/BtcOperations.tsx";
import { BTC_TELAS, TELAS } from "../src/App.tsx";
import fixture from "./fixtures/btc-operation.json";
const detail = fixture as unknown as DeskOperation;
describe("BTC history uses recorded facts from an explicit disposable fixture", () => {
  it("shows causal inputs, partial fill/fee and cancellation without claiming the requested exit filled", () => {
    const html = renderToStaticMarkup(<OperationDetail detail={detail} />);
    for (const text of [
      "fixture:decision",
      "fixture:metadata",
      "fixture:fill",
      "fixture:fee",
      "0,0004",
      "−0,026",
      "cancelled",
      "stop_triggered",
      "Solicitação não comprova encerramento",
    ])
      expect(html).toContain(text);
    expect(html).not.toContain("lucro garantido");
    expect(html).toContain("não explicam retroativamente");
  });
  it("keeps missing execution/stop evidence unavailable and never manufactures a fill", () => {
    const order = { ...detail.order };
    delete order.risk_plan;
    const html = renderToStaticMarkup(
      <OperationDetail
        detail={{
          ...detail,
          execution_input: null,
          decision_evidence_id: null,
          protective_exit: null,
          order,
          events: [],
        }}
      />,
    );
    expect(html).toContain("indisponível");
    expect(html).toContain("Eventos indisponíveis");
    expect(html).not.toContain("fixture:fill");
    expect(html).not.toContain("stop_triggered");
  });
  it("does not translate an unknown broker reason into a fictional explanation", () => {
    const html = renderToStaticMarkup(
      <OperationDetail
        detail={{
          ...detail,
          view: "receipts",
          receipts: [
            {
              cursor: "a",
              operation_id: "a",
              reason: "unrecognized_reason",
              evidence_id: "fixture:evidence",
              book_key: null,
              recorded_at: detail.as_of,
            },
          ],
        }}
      />,
    );
    expect(html).toContain("Motivo registrado");
    expect(html).toContain("unrecognized_reason");
    expect(html).toContain("fixture:evidence");
  });
  it("distinguishes pending funding, pause, warmup, lack of signal, veto, stale data and failure", () => {
    const codes = [
      "BTC_FUNDING_PENDING",
      "REDUCE_ONLY",
      "WARMUP",
      "NO_SIGNAL",
      "BTC_RISK_CAP",
      "BTC_BOOK_STALE",
      "BTC_BOOK_MISSING",
      "TRADING_READ_UNAVAILABLE",
    ];
    expect(new Set(codes.map(reasonLabel)).size).toBe(codes.length);
    const account = {
      reason_codes: [],
      ticket: {
        risk_state: "REDUCE_ONLY",
        risk_reasons: ["BTC_FUNDING_PENDING"],
      },
      funding: {
        status: "pending",
        reason: "oracle_unavailable",
        period_hour: detail.as_of,
      },
    } as unknown as DeskAccountView;
    const html = renderToStaticMarkup(<AccountCondition account={account} />);
    expect(html).toContain("PENDENTE");
    expect(html).toContain("oracle_unavailable");
    expect(html).not.toContain("liquidado");
    expect(html).toContain("não prova falta de sinal");
  });
  it("keeps BTC navigation separate while preserving every legacy reader", () => {
    expect(BTC_TELAS).toEqual(["Mesa", "Operações", "Experimentos", "Sistema"]);
    expect(TELAS.map((a) => a.chave)).toEqual([
      "mesa",
      "carteira",
      "decisoes",
      "sombra",
      "resolucao",
      "sistema",
    ]);
  });
});

describe("Jev status labels from MOCK UI fixtures", () => {
  const empty: DeskJevView = {
    as_of: "2026-09-26T12:00:00.000Z",
    enabled: false,
    reasons: ["credential_unavailable", "coverage_unavailable"],
    credential_present: false,
    configured_origin: "real",
    registration: null,
    recent: [],
    real_api_cost: {
      month: "2026-09",
      measured_usd6: "0",
      uncertain_reserved_usd6: "0",
      calls: "0",
      limit_usd6: null,
      committed_usd6: "0",
      circuit_open: false,
    },
  };
  it("distinguishes no consultation and unavailable coverage from mock/real answers and paper cash", () => {
    const html = renderToStaticMarkup(<JevStatus view={empty} />);
    for (const text of [
      "DESATIVADA",
      "Credencial indisponível",
      "Cobertura de consumo não disponível",
      "Sem consulta Jev observada",
      "Gasto real de API",
      "não paga a API",
      "não é crédito disponível",
    ])
      expect(html).toContain(text);
    expect(html).not.toContain("API REAL · tentativa");
    expect(html).not.toContain("MOCK · teste sintético");
  });
  it("keeps mock veto, real timeout and unrequested eligibility distinct without calling uncertain costs free", () => {
    const row: DeskJevView["recent"][number] = {
      decision_id: "mock:1",
      source_decision_id: "mock:base",
      bar_end_at: empty.as_of,
      eligibility: "candidate",
      eligibility_reasons: [],
      request_state: "final",
      deadline_at: empty.as_of,
      origin: "mock",
      attempted: true,
      decision: "veto",
      reason: "ok",
      cost_usd6: "42",
      reserved_usd6: "2753",
      duration_ms: 35,
      response_received_at: empty.as_of,
      admission_reasons: ["jev_veto"],
      admission_status: null,
    };
    const html = renderToStaticMarkup(
      <JevStatus
        view={{
          ...empty,
          recent: [
            row,
            {
              ...row,
              decision_id: "mock:2",
              origin: "real",
              decision: "abstain",
              reason: "timeout",
              cost_usd6: null,
              response_received_at: null,
            },
            {
              ...row,
              decision_id: "mock:3",
              origin: null,
              attempted: false,
              decision: null,
              reason: null,
              request_state: null,
            },
          ],
        }}
      />,
    );
    for (const text of [
      "MOCK · teste sintético",
      "VETO",
      "API REAL · tentativa",
      "ABSTENÇÃO",
      "SEM CONSULTA",
      "timeout",
      "incerto",
      "35.0 ms",
      "sem ordem aceita",
    ])
      expect(html).toContain(text);
  });
});
