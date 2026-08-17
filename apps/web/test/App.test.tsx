import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LoginPanel, StatusPanel } from "../src/App.js";

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

describe("LoginPanel", () => {
  it("renders username and password fields and a submit action", () => {
    const html = renderToStaticMarkup(
      <LoginPanel onSubmit={() => undefined} pending={false} error={null} />,
    );

    expect(html).toContain('name="username"');
    expect(html).toContain('type="password"');
    expect(html).toContain("Entrar");
    expect(html).toContain("Acesso restrito");
  });

  it("shows an error message and a pending state", () => {
    const html = renderToStaticMarkup(
      <LoginPanel
        onSubmit={() => undefined}
        pending
        error="Usuário ou senha inválidos."
      />,
    );

    expect(html).toContain("Usuário ou senha inválidos.");
    expect(html).toContain("Entrando…");
  });
});
