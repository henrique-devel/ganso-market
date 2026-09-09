// RFC-027 aceite 4: nenhuma requisição a `/decisions` no carregamento padrão
// da tela Decisões.
//
// O aceite está escrito como "aba de rede", e é aí que ele seria conferido à
// mão, uma vez. Aqui ele é conferido a cada `npm test`: a função que a tela
// realmente executa no seu efeito de carga é chamada com um `fetch` espião, e
// as URLs pedidas são a afirmação.
//
// Um teste que apenas verificasse a constante de seções provaria a
// implementação de hoje. Este exercita o caminho de código.

import { describe, expect, it, vi } from "vitest";

import {
  SECOES_COM_CRUAS,
  SECOES_PADRAO,
  buscaDaTelaPadrao,
} from "../src/Decisoes.tsx";

function jsonOk(): Response {
  return {
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        simulation: "SIMULAÇÃO — SEM EXECUÇÃO REAL",
        state: null,
        transitions: [],
        open_circuit_breakers: [],
        caps: [],
        binding_constraints_24h: [],
        config: null,
      }),
  } as unknown as Response;
}

describe("aceite 4 — a tela Decisões não carrega o log cru por padrão", () => {
  it("pede estado e limites, e nunca /decisions", async () => {
    const urls: string[] = [];
    const espiao = vi.fn((url: string) => {
      urls.push(url);
      return Promise.resolve(jsonOk());
    }) as unknown as typeof fetch;

    await buscaDaTelaPadrao("token", espiao);

    // A afirmação do aceite.
    expect(urls.some((url) => url.includes("/polymarket/decisions"))).toBe(
      false,
    );
    // E o que ela PEDE é exatamente o que as quatro seções precisam:
    // `state` alimenta Congeladas, `limits` dá o piso de edge do "Quase".
    expect(urls).toEqual([
      "/api/polymarket/portfolio/state",
      "/api/polymarket/portfolio/limits",
    ]);
  });

  it("só monta a seção do log cru quando o filtro é ligado", () => {
    // A outra metade do aceite: o painel de portfólio busca em função das
    // seções que recebe (`quer("decisoes") ? fetchDecisions(...) : null`), e a
    // tela só lhe entrega `decisoes` com o filtro ligado.
    expect(SECOES_PADRAO).not.toContain("decisoes");
    expect(SECOES_COM_CRUAS).toContain("decisoes");
  });
});
