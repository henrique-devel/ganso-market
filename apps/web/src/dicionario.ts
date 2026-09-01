// RFC-015: código de máquina → rótulo em português + a consequência para o
// operador.
//
// A regra que governa este módulo: **o código original nunca some.** Toda
// tradução aqui é acompanhada, na tela, do código cru em `<code>` ou no
// `title`. Um painel que só mostra "Parado" vira uma segunda fonte de verdade,
// que diverge do log, do banco e do runbook no primeiro dia em que alguém
// renomear um código. Mostrando os dois, a tradução é uma legenda — e legenda
// errada é visível, não silenciosa.
//
// Segunda regra: um rótulo sozinho não resolve nada. `HALTED` traduzido para
// "Parado" continua sem dizer que ele NÃO sai sozinho. Por isso cada verbete
// tem uma frase de consequência: o que o operador faz, ou não faz, com isso.

export interface Verbete {
  /** Rótulo curto, para caber em badge e cabeçalho de tabela. */
  readonly rotulo: string;
  /** O que isso significa para quem opera. Vai no title/tooltip. */
  readonly consequencia?: string;
  /** Peso visual: muda a cor do badge, não o texto. */
  readonly tom?: "ok" | "atencao" | "alerta" | "neutro";
}

type Dicionario = Readonly<Record<string, Verbete>>;

// ---------------------------------------------------------------------------
// Estado do portfólio
// ---------------------------------------------------------------------------

export const ESTADO_PORTFOLIO: Dicionario = {
  NORMAL: {
    rotulo: "Normal",
    consequencia: "O motor pode abrir e fechar posição.",
    tom: "ok",
  },
  REDUCE_ONLY: {
    rotulo: "Só reduzir",
    consequencia:
      "Nenhuma entrada nova; só saída. Volta sozinho quando a janela expira.",
    tom: "atencao",
  },
  HALTED: {
    rotulo: "Parado",
    consequencia:
      "Não sai sozinho — nem com drawdown recuperado, nem com restart. " +
      "Exige ação sua, por dentro do servidor: o perímetro não publica o " +
      "endpoint que retoma.",
    tom: "alerta",
  },
};

export const GATILHO_TRANSICAO: Dicionario = {
  daily_loss: { rotulo: "perda do dia" },
  weekly_loss: { rotulo: "perda da semana" },
  drawdown: { rotulo: "drawdown" },
  manual: { rotulo: "ação manual" },
  window_expired: { rotulo: "janela expirou" },
  boot: { rotulo: "boot do serviço" },
};

// ---------------------------------------------------------------------------
// Gates da RFC-009
// ---------------------------------------------------------------------------

export const SITUACAO_GATE: Dicionario = {
  PASS: {
    rotulo: "Passou",
    consequencia: "Medido, e o critério foi atendido.",
    tom: "ok",
  },
  FAIL: {
    rotulo: "Reprovou",
    consequencia: "Medimos e não funcionou. É um resultado, não uma pendência.",
    tom: "alerta",
  },
  INSUFFICIENT_DATA: {
    rotulo: "Sem dado bastante",
    consequencia:
      "Ainda não medimos o suficiente para dizer. NÃO é o mesmo que reprovar: " +
      "um é 'não sabemos', o outro é 'sabemos que não'.",
    tom: "atencao",
  },
};

export const GATE: Dicionario = {
  G1: { rotulo: "G1 — calibração do modelo" },
  G2: { rotulo: "G2 — paper com amostra suficiente" },
  G3: { rotulo: "G3 — risco dentro do limite" },
  G4: { rotulo: "G4 — reconciliação ligada" },
  G5: { rotulo: "G5 — regime atual" },
  G6: { rotulo: "G6 — revisão do proprietário" },
};

export const MOTIVO_GATE: Dicionario = {
  G1_CALIBRATION_NOT_MET: {
    rotulo: "calibração não atingida",
    consequencia: "O modelo ainda não bate a referência de calibração exigida.",
  },
  G2_INSUFFICIENT_PAPER: {
    rotulo: "paper insuficiente",
    consequencia: "Faltam operações simuladas para a amostra ter poder.",
  },
  G3_RISK_BREACH: { rotulo: "limite de risco rompido" },
  G4_RECONCILIATION_OFF: { rotulo: "reconciliação desligada" },
  G5_REGIME_STALE: { rotulo: "regime desatualizado" },
  G6_NOT_REVIEWED: {
    rotulo: "sem revisão do proprietário",
    consequencia: "Este gate só fecha com uma decisão sua; nada o mede.",
  },
};

export const STATUS_RFC009: Dicionario = {
  BLOCKED: {
    rotulo: "Bloqueada",
    consequencia:
      "Execução real segue impedida enquanto qualquer gate não estiver em " +
      "'Passou'.",
    tom: "alerta",
  },
  READY_FOR_OWNER_REVIEW: {
    rotulo: "Pronta para sua revisão",
    consequencia:
      "Todos os gates passaram. Ligar execução real continua sendo decisão " +
      "sua — nada aqui liga sozinho.",
    tom: "atencao",
  },
};

// ---------------------------------------------------------------------------
// Risco de resolução (RFC-012)
// ---------------------------------------------------------------------------

export const ACAO_RESOLUCAO: Dicionario = {
  NONE: {
    rotulo: "Livre",
    consequencia: "Sem restrição de resolução.",
    tom: "ok",
  },
  BUFFER: {
    rotulo: "Com colchão",
    consequencia:
      "Pode operar, mas o EV é descontado de um colchão de risco de resolução.",
    tom: "atencao",
  },
  VETO: {
    rotulo: "Vetado",
    consequencia: "Entrada proibida neste mercado enquanto o veto valer.",
    tom: "alerta",
  },
  CIRCUIT_BREAKER: {
    rotulo: "Disjuntor aberto",
    consequencia:
      "Mercado congelado por evento externo (UMA, salto de preço, mudança de " +
      "regra). Fecha sozinho quando a causa passa.",
    tom: "alerta",
  },
};

export const TIPO_DISJUNTOR: Dicionario = {
  UMA_PROPOSED_OR_DISPUTED: { rotulo: "UMA propôs ou disputou" },
  PRICE_JUMP_NO_CATALYST: { rotulo: "salto de preço sem catalisador" },
  RULE_CLARIFICATION: { rotulo: "regra esclarecida" },
  PARAM_CHANGE: { rotulo: "parâmetro mudou" },
  DATA_STALENESS: { rotulo: "dado velho" },
};

export const DIRECAO_DIVERGENCIA: Dicionario = {
  rfc012_only: {
    rotulo: "só a RFC-012 bloqueia",
    consequencia: "O score de resolução veta e o broker não congelou.",
  },
  rfc011_only: {
    rotulo: "só o broker congelou",
    consequencia: "O broker congelou o mercado e o score não veta.",
  },
};

// ---------------------------------------------------------------------------
// Decisões do motor de portfólio
// ---------------------------------------------------------------------------

export const TIPO_DECISAO: Dicionario = {
  ENTRY: { rotulo: "Entrada" },
  EXIT: { rotulo: "Saída" },
  VETO: { rotulo: "Veto" },
  RESIZE: { rotulo: "Redimensionar" },
};

export const RESULTADO_DECISAO: Dicionario = {
  ACCEPTED: { rotulo: "Aceita", tom: "ok" },
  REJECTED: { rotulo: "Recusada", tom: "neutro" },
};

export const MOTIVO_DECISAO: Dicionario = {
  PORTFOLIO_CIRCUIT_BREAKER: {
    rotulo: "disjuntor de portfólio aberto",
    consequencia:
      "A recusa é do portfólio inteiro, não deste mercado. É metade do log.",
  },
  BOOK_STALE: {
    rotulo: "livro velho",
    consequencia:
      "O último livro passou do TTL de atualidade; não se decide no escuro.",
  },
  DATA_STALE: {
    rotulo: "dado velho",
    consequencia: "Alguma entrada passou do TTL.",
  },
  PRICE_OUT_OF_BAND: {
    rotulo: "preço fora da banda",
    consequencia: "O preço saiu da faixa em que este motor aceita operar.",
  },
  LOWER_BOUND_BELOW_COSTS: {
    rotulo: "limite inferior não cobre os custos",
    consequencia:
      "O pior caso da estimativa não supera preço + custos + margem. É a " +
      "recusa que o modelo mais produz quando tem opinião.",
  },
  EDGE_BELOW_MIN: { rotulo: "edge abaixo do mínimo" },
  HOLD_NO_EXIT_SIGNAL: {
    rotulo: "manter — sem sinal de saída",
    consequencia: "Avaliou a saída e decidiu segurar.",
  },
  INSUFFICIENT_DATA: { rotulo: "sem dado bastante" },
};

export const LIMITADOR: Dicionario = {
  KELLY_CAP: { rotulo: "teto de Kelly" },
  DEPTH_TAKE_PCT: { rotulo: "% da profundidade do livro" },
  UNCERTAINTY_SHRINK: { rotulo: "encolhimento por incerteza" },
  CORRELATION_FACTOR: { rotulo: "fator de correlação" },
  RULE_PRECISION: { rotulo: "precisão da regra" },
  CAP_ENTRADA: { rotulo: "cap de entrada" },
  CAP_MERCADO: { rotulo: "cap do mercado" },
  CAP_GRUPO_CORRELACIONADO: { rotulo: "cap do grupo correlacionado" },
  CAP_CATEGORIA: { rotulo: "cap da categoria" },
  CAP_FONTE_RESOLUCAO: { rotulo: "cap da fonte de resolução" },
  CAP_CATALISADOR_JANELA: { rotulo: "cap da janela do catalisador" },
  CAP_CAPITAL_BLOQUEADO: { rotulo: "cap de capital bloqueado" },
  SLIPPAGE_MAX_PCT_EDGE: { rotulo: "slippage máximo sobre o edge" },
  MIN_ORDER_SIZE: { rotulo: "tamanho mínimo de ordem" },
  NOT_SIZED: {
    rotulo: "não dimensionada",
    consequencia:
      "A decisão parou antes do dimensionamento — nada limitou porque nada foi calculado.",
  },
};

// ---------------------------------------------------------------------------
// Modelo e estimativa (RFC-010)
// ---------------------------------------------------------------------------

export const FONTE_ESTIMATIVA: Dicionario = {
  MODEL: {
    rotulo: "modelo",
    consequencia: "A estimativa veio de um modelo promovido.",
    tom: "ok",
  },
  MARKET_BASELINE: {
    rotulo: "baseline do mercado",
    consequencia:
      "Sem opinião própria: q é o microprice do próprio livro. O motor não " +
      "tem como achar edge contra ele.",
    tom: "neutro",
  },
};

export const STATUS_MODELO: Dicionario = {
  active: { rotulo: "ativo", tom: "ok" },
  shadow: {
    rotulo: "sombra",
    consequencia:
      "Grava estimativa para os gates e é invisível aos consumidores.",
    tom: "neutro",
  },
  retired: { rotulo: "aposentado", tom: "neutro" },
};

// ---------------------------------------------------------------------------
// Categorias de mercado
// ---------------------------------------------------------------------------

export const CATEGORIA: Dicionario = {
  crypto: { rotulo: "Cripto" },
  crypto_updown: { rotulo: "Cripto — sobe/desce" },
  macro: { rotulo: "Macro" },
  macro_scheduled: { rotulo: "Macro — evento agendado" },
  weather: { rotulo: "Clima (legado)" },
  // O bucket histórico. Não é dado faltando: é dado que NÃO PODE existir.
  // O histórico de metadata começa em 2026-08-25 01:42:43Z (medido) e é
  // prospectivo por desenho — projetar a categoria de hoje sobre um mercado
  // que terminou antes disso seria look-ahead. São 308 terminais, todos entre
  // 2026-08-22 01:38Z e 2026-08-25 01:33Z, e o número é permanente.
  unknown: {
    rotulo: "Sem categoria (anterior a 25/08)",
    consequencia:
      "Mercados que terminaram antes de o histórico de metadata existir " +
      "(25/08/2026 01:42Z). A categoria de hoje não pode ser projetada para " +
      "trás sem look-ahead, então o balde é permanente por desenho.",
    tom: "neutro",
  },
};

// ---------------------------------------------------------------------------
// Kill switch e ordens do paper
// ---------------------------------------------------------------------------

export const EVENTO_LEDGER: Dicionario = {
  order_accepted: { rotulo: "ordem aceita" },
  order_rejected: { rotulo: "ordem recusada", tom: "atencao" },
  cancel_requested: { rotulo: "cancelamento pedido" },
  cancel_effective: { rotulo: "cancelamento efetivado" },
  fill: { rotulo: "execução", tom: "ok" },
  fill_denied_degradation: {
    rotulo: "execução negada por degradação",
    consequencia: "O simulador recusou o fill porque o dado estava degradado.",
    tom: "atencao",
  },
  expired: { rotulo: "expirou" },
  resolution: { rotulo: "resolução" },
  mark: { rotulo: "marcação" },
  kill_switch_engaged: { rotulo: "kill switch engatado", tom: "alerta" },
  kill_switch_rearmed: { rotulo: "kill switch rearmado", tom: "ok" },
};

export const STATUS_ORDEM: Dicionario = {
  open: { rotulo: "aberta" },
  filled: { rotulo: "executada" },
  canceled: { rotulo: "cancelada" },
  rejected: { rotulo: "recusada" },
  expired: { rotulo: "expirada" },
};

export const LADO: Dicionario = {
  BUY: { rotulo: "compra" },
  SELL: { rotulo: "venda" },
  YES: { rotulo: "SIM" },
  NO: { rotulo: "NÃO" },
};

// ---------------------------------------------------------------------------
// Feed de eventos
// ---------------------------------------------------------------------------

export const FONTE_EVENTO: Dicionario = {
  estado: { rotulo: "Estado do portfólio" },
  decisao: { rotulo: "Decisão" },
  ordem: { rotulo: "Broker paper" },
  disjuntor: { rotulo: "Disjuntor" },
  violacao: { rotulo: "Violação de grafo" },
  divergencia: { rotulo: "Divergência de camada" },
  veto: { rotulo: "Veto de sanidade" },
  g2: { rotulo: "Relógio do G2" },
};

// ---------------------------------------------------------------------------
// Consulta
// ---------------------------------------------------------------------------

/**
 * Todo dicionário em um só lugar, para `traduzir` achar o verbete quando o
 * chamador não sabe (ou não quer dizer) de que família o código é.
 *
 * A ordem importa: o primeiro que casar ganha. `VETO` existe em dois lugares
 * (ação de resolução e tipo de decisão) e ambos os rótulos servem, mas
 * `ACAO_RESOLUCAO` vem antes porque é o uso mais frequente na tela.
 */
const TODOS: readonly Dicionario[] = [
  ESTADO_PORTFOLIO,
  SITUACAO_GATE,
  STATUS_RFC009,
  ACAO_RESOLUCAO,
  MOTIVO_DECISAO,
  MOTIVO_GATE,
  LIMITADOR,
  TIPO_DECISAO,
  RESULTADO_DECISAO,
  FONTE_ESTIMATIVA,
  STATUS_MODELO,
  CATEGORIA,
  TIPO_DISJUNTOR,
  DIRECAO_DIVERGENCIA,
  EVENTO_LEDGER,
  STATUS_ORDEM,
  LADO,
  GATE,
  GATILHO_TRANSICAO,
  FONTE_EVENTO,
];

/**
 * O verbete de um código, ou `null` quando ele não está no dicionário.
 *
 * `null` — e não um rótulo inventado — é o ponto: a UI mostra o código cru
 * nesse caso, e o operador vê exatamente o que o sistema gravou. Um dicionário
 * que devolve "Desconhecido" para tudo que não conhece esconde justamente os
 * códigos novos, que são os que alguém precisa notar.
 */
export function verbete(
  codigo: string | null | undefined,
  dicionario?: Dicionario,
): Verbete | null {
  if (codigo === null || codigo === undefined || codigo === "") {
    return null;
  }
  if (dicionario !== undefined) {
    return dicionario[codigo] ?? null;
  }
  for (const candidato of TODOS) {
    const encontrado = candidato[codigo];
    if (encontrado !== undefined) {
      return encontrado;
    }
  }
  return null;
}

/** O rótulo, com fallback para o próprio código. Nunca devolve string vazia. */
export function rotulo(
  codigo: string | null | undefined,
  dicionario?: Dicionario,
): string {
  if (codigo === null || codigo === undefined || codigo === "") {
    return "—";
  }
  return verbete(codigo, dicionario)?.rotulo ?? codigo;
}

/** A frase de consequência, para `title=`. Cai no código quando não há. */
export function consequencia(
  codigo: string | null | undefined,
  dicionario?: Dicionario,
): string | undefined {
  if (codigo === null || codigo === undefined || codigo === "") {
    return undefined;
  }
  const encontrado = verbete(codigo, dicionario);
  if (encontrado === null) {
    return codigo;
  }
  return encontrado.consequencia === undefined
    ? codigo
    : `${encontrado.consequencia} (${codigo})`;
}

export function tom(
  codigo: string | null | undefined,
  dicionario?: Dicionario,
): "ok" | "atencao" | "alerta" | "neutro" {
  return verbete(codigo, dicionario)?.tom ?? "neutro";
}
