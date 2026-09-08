// RFC-026 D4: o modo engenheiro.
//
// Por padrão a tela mostra o rótulo em português e guarda o código bruto no
// `title` — é a regra do `dicionario.ts` ("o código nunca some") lida ao
// contrário do que a tela fazia antes: imprimir rótulo e código colados
// produzia "Normal NORMAL" em nove lugares.
//
// O modo engenheiro reinjeta o código onde ele foi tirado e abre o que só
// interessa a quem está depurando: `condition_id`, `token_id`, a versão da
// config, o `snapshot_id` e o JSON cru. Ele é preferência de quem opera, não
// estado do sistema, então vive no `localStorage` e não viaja para o servidor.
//
// O contexto é lido pelo `Badge` (Overview.tsx) e pela Mesa. O valor padrão é
// `false` de propósito: um componente renderizado fora do provedor — em teste,
// por exemplo — não pode imprimir código por acidente, porque é exatamente
// isso que o aceite A4 proíbe.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import type { ReactNode } from "react";

const CHAVE = "ganso:modo-engenheiro";

const ModoEngenheiro = createContext<boolean>(false);

/** Ligado? Fora de um provedor, sempre não. */
export function useModoEngenheiro(): boolean {
  return useContext(ModoEngenheiro);
}

/**
 * Leitura tolerante do `localStorage`.
 *
 * Um navegador com armazenamento bloqueado lança na leitura; a preferência
 * cai para desligado em vez de derrubar o painel.
 */
function lerPreferencia(): boolean {
  try {
    return window.localStorage.getItem(CHAVE) === "1";
  } catch {
    return false;
  }
}

function gravarPreferencia(ligado: boolean): void {
  try {
    window.localStorage.setItem(CHAVE, ligado ? "1" : "0");
  } catch {
    // Sem armazenamento a preferência vale só para esta sessão de tela. Não é
    // erro que mereça alarme: nada de operacional depende dela.
  }
}

/**
 * Estado do modo engenheiro, com a leitura do `localStorage` feita depois da
 * primeira renderização.
 *
 * O estado inicial é `false` mesmo quando a preferência está gravada porque o
 * mesmo componente é renderizado no servidor pelos testes, onde `window` não
 * existe; ler no efeito mantém a primeira árvore idêntica nos dois lados.
 */
export function useModoEngenheiroState(): {
  readonly ligado: boolean;
  readonly alternar: () => void;
} {
  const [ligado, setLigado] = useState(false);

  useEffect(() => {
    setLigado(lerPreferencia());
  }, []);

  const alternar = useCallback(() => {
    setLigado((atual) => {
      gravarPreferencia(!atual);
      return !atual;
    });
  }, []);

  return { ligado, alternar };
}

export function ModoEngenheiroProvider({
  ligado,
  children,
}: Readonly<{ ligado: boolean; children: ReactNode }>) {
  return (
    <ModoEngenheiro.Provider value={ligado}>{children}</ModoEngenheiro.Provider>
  );
}
