declare const __BUILD_SHA__: string;

export const BUILD_SHA: string =
  typeof __BUILD_SHA__ === "string" ? __BUILD_SHA__ : "unknown";

/**
 * The lesson of 2026-08-31, made visible.
 *
 * The rearm button "did not work" for an hour because the SPA in memory was an
 * old bundle. Logging in inside the app does NOT reload the page, and
 * index.html is served no-store — so one reload fixes it and nothing on screen
 * said so. Now the panel reports its own revision and compares it against the
 * one the API reports.
 */
export function precisaRecarregar(
  bundle: string,
  releaseSha: string | null,
): boolean {
  // Only when BOTH revisions are known and they differ. An unknown bundle is
  // a dev checkout (the release-sha placeholder is literal there) and an
  // unknown API sha is an older API; warning in either case would train the
  // operator to ignore the warning, which is worse than not having it.
  if (releaseSha === null || bundle === "unknown" || releaseSha === "unknown") {
    return false;
  }
  return releaseSha !== bundle;
}

export function BuildFooter({
  releaseSha,
}: Readonly<{ releaseSha: string | null }>) {
  const bundle = BUILD_SHA;
  const desatualizado = precisaRecarregar(bundle, releaseSha);
  return (
    <footer className="rodape">
      {desatualizado ? (
        <p className="rodape-aviso" role="alert">
          <strong>Recarregue a página.</strong> Este painel está rodando o build{" "}
          <code>{bundle.slice(0, 12)}</code> e a API está em{" "}
          <code>{(releaseSha ?? "").slice(0, 12)}</code>. Entrar de novo não
          recarrega o bundle; só um reload troca o código em memória.
        </p>
      ) : null}
      <p className="rodape-linha">
        painel{" "}
        <code>
          {bundle === "unknown" ? "desconhecido" : bundle.slice(0, 12)}
        </code>
        {" · "}
        API{" "}
        <code>
          {releaseSha === null ? "desconhecida" : releaseSha.slice(0, 12)}
        </code>
      </p>
    </footer>
  );
}
