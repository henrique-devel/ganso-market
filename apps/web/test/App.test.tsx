import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { StatusPanel } from "../src/App.js";

describe("StatusPanel", () => {
  it("renders the loading state without invented market data", () => {
    const html = renderToStaticMarkup(
      <StatusPanel status={{ kind: "loading" }} />,
    );

    expect(html).toContain("Verificando");
    expect(html).toContain("Consultando liveness e readiness");
    expect(html).not.toContain("P&amp;L");
  });

  it("renders an observed readiness reason", () => {
    const html = renderToStaticMarkup(
      <StatusPanel
        status={{
          kind: "not_ready",
          checkedAt: "2026-08-10T12:00:00.000Z",
          reasonCode: "POSTGRES_UNAVAILABLE",
        }}
      />,
    );

    expect(html).toContain("Não pronto");
    expect(html).toContain("POSTGRES_UNAVAILABLE");
  });
});
