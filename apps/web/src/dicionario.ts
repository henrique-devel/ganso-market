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

// ---------------------------------------------------------------------------
// RFC-027 D5: a natureza do bloqueio
//
// Os seis gates aparecem hoje com o MESMO rótulo — "Sem dado bastante" — e não
// é o que está acontecendo. Medido em produção 2026-09-09, os seis estão em
// `INSUFFICIENT_DATA` por quatro razões diferentes, e a diferença muda o que o
// operador faz:
//
//   G5  espera um RELÓGIO com data (28/08 + 60 d = 2026-10-27 20:38:47Z);
//   G4  está travado por um DEFEITO (0 amostras de fee com fills existindo);
//   G6  espera uma DECISÃO do proprietário, e nada o mede;
//   G1  depende de um MODELO PROMOVIDO (`model_forecasts = 0`).
//
// "Sem dado bastante" nos quatro casos faz o G6 parecer que vai destravar
// sozinho e o G5 parecer que não vai nunca. Nenhum dos dois é verdade.
//
// A REGRA É DADO-DIRIGIDA, e é isso que a torna manutenível: nada aqui olha o
// nome do gate para decidir a etiqueta. `naturezaDoBloqueio` lê as MESMAS
// chaves de `metrics_json` que a barra "tem/precisa" já lê, e a etiqueta muda
// sozinha quando o número muda. Foi o que aconteceu entre a RFC e esta
// implementação: em 02/09 o G2 tinha `closed_positions = 0` e a RFC previu
// "travado por defeito"; em 09/09 ele tem 8, e a mesma função devolve
// "acumulando" sem uma linha de código nova. O aceite 3 prevê exatamente isso.
// ---------------------------------------------------------------------------

export const NATUREZA_BLOQUEIO: Dicionario = {
  RELOGIO: {
    rotulo: "relógio, com data",
    consequencia:
      "Um piso de tempo que já está correndo. Ninguém precisa fazer nada: " +
      "a data em que ele vence é conhecida e está na tela.",
    tom: "atencao",
  },
  RELOGIO_NAO_INICIADO: {
    rotulo: "relógio não iniciado",
    consequencia:
      "O piso de tempo existe, mas nada registrou o início dele. Sem " +
      "`clock_start` não há data — e uma data inventada seria pior que nenhuma.",
    tom: "alerta",
  },
  DEFEITO: {
    rotulo: "travado por defeito, sem data",
    consequencia:
      "Não é falta de tempo: a evidência que este gate mede não está sendo " +
      "produzida. Esperar não resolve — o defeito é que tem de ser corrigido.",
    tom: "alerta",
  },
  DECISAO_PROPRIETARIO: {
    rotulo: "decisão do proprietário",
    consequencia:
      "Nada mede este gate e nada o destrava com o tempo. Ele fecha quando " +
      "houver uma revisão escrita, e só então.",
    tom: "atencao",
  },
  DEPENDE_DE_MODELO: {
    rotulo: "depende de modelo promovido",
    consequencia:
      "O sinal em uso é a linha de base do mercado. Pontuá-lo contra o preço " +
      "compararia o preço com ele mesmo, então não há o que medir enquanto " +
      "nenhum modelo for promovido.",
    tom: "atencao",
  },
  ACUMULANDO: {
    rotulo: "acumulando",
    consequencia:
      "A evidência está sendo produzida e a contagem sobe. Não há data " +
      "porque o ritmo é que decide, mas a barra mostra onde está.",
    tom: "atencao",
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
      // "É metade do log" saiu: era um número de produção fixado em texto, e
      // deixou de ser verdade. Medido em 02/09 era 55,9 % das avaliadas; medido
      // em 2026-09-09, depois de a RFC-025 fazer o PARAM_CHANGE abrir em
      // mudança real de parâmetro e não no nascimento do mercado, são 2,3 %. O
      // funil da tela Decisões mostra a fatia medida; o verbete não a fixa.
      "A recusa é do portfólio inteiro, não deste mercado. Quanto ela pesa no " +
      "log está no funil da tela Decisões.",
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
  SIZE_BELOW_MIN_ORDER: {
    rotulo: "tamanho abaixo da ordem mínima",
    consequencia:
      "O edge passou, o dimensionamento não: a ordem sairia menor que o " +
      "mínimo negociável. Na varredura da Sombra isto NÃO é ação nova — " +
      "aceitar e não conseguir mandar dá no mesmo que recusar.",
  },
  HOLD_NO_EXIT_SIGNAL: {
    rotulo: "manter — sem sinal de saída",
    consequencia: "Avaliou a saída e decidiu segurar.",
  },
  INSUFFICIENT_DATA: { rotulo: "sem dado bastante" },
};

// ---------------------------------------------------------------------------
// Shadow replay (RFC-029): por que uma decisão ficou fora da amostra
// ---------------------------------------------------------------------------

/**
 * As exclusões do modo B. Nenhuma delas é um defeito: são o preço de exigir
 * que a comparação seja honesta. Cada verbete diz o que a exclusão custa à
 * leitura, porque uma contagem grande aqui muda o que o funil significa.
 */
export const EXCLUSAO_SOMBRA: Dicionario = {
  SHADOW_MISSING: {
    rotulo: "sem sombra no instante",
    consequencia:
      "Não havia linha shadow as-of o instante da decisão, então não há o que " +
      "trocar. É a maior exclusão por construção: a sombra cobre menos tokens " +
      "que o log de decisões.",
  },
  SHADOW_STALE: {
    rotulo: "sombra velha demais",
    consequencia:
      "Existia linha shadow, mas fora do TTL de atualidade. Usá-la seria " +
      "comparar o motor com um dado que ele próprio teria recusado.",
  },
  BASELINE_MISMATCH: {
    rotulo: "baseline não reproduz",
    consequencia:
      "Reexecutar a decisão com a config gravada não deu o resultado gravado. " +
      "Drift do motor nunca vira sinal: a linha sai da amostra.",
  },
  BASELINE_ALREADY_SHADOW: {
    rotulo: "baseline já era sombra",
    consequencia:
      "A decisão original já tinha usado a estimativa shadow, então a troca " +
      "não compara nada. Contá-la inflaria a diferença com linhas idênticas.",
  },
  NO_REPLAY_BLOCK: {
    rotulo: "sem bloco de replay",
    consequencia:
      "A decisão foi gravada sem o bloco de entradas que o replay precisa. " +
      "Sem ele não há como reexecutar.",
  },
  UNSUPPORTED_KIND: {
    rotulo: "tipo não suportado",
    consequencia:
      "O modo B mede terminal e barreira; famílias fora disso não têm " +
      "decisão alcançável e ficam de fora.",
  },
  CONFIG_UNAVAILABLE: {
    rotulo: "config indisponível",
    consequencia:
      "A versão de config que a decisão citou não está mais em " +
      "portfolio_config_versions.",
  },
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
  EXCLUSAO_SOMBRA,
  NATUREZA_BLOQUEIO,
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

// ---------------------------------------------------------------------------
// RFC-027 D5: a classificação, e as barras "tem/precisa"
// ---------------------------------------------------------------------------

/** Um par tem/precisa lido de `metrics_json`, já pronto para virar barra. */
export interface Progresso {
  readonly chave: string;
  readonly tem: number;
  readonly precisa: number;
}

/** O relógio do G5, como `/polymarket/gates` o publica (D5). */
export interface RelogioG2 {
  readonly category: string;
  readonly clock_start: string | null;
  readonly regime_fingerprint: string | null;
  readonly last_reset_reason: string | null;
}

function numero(valor: unknown): number | null {
  if (typeof valor === "number") {
    return Number.isFinite(valor) ? valor : null;
  }
  if (typeof valor === "string" && valor.trim() !== "") {
    const convertido = Number(valor);
    return Number.isFinite(convertido) ? convertido : null;
  }
  return null;
}

function objeto(valor: unknown): Record<string, unknown> {
  return typeof valor === "object" && valor !== null && !Array.isArray(valor)
    ? (valor as Record<string, unknown>)
    : {};
}

/**
 * Os pares tem/precisa de um gate, na ordem em que a tela os desenha.
 *
 * Lidos dos MESMOS caminhos que a etiqueta usa — não há um segundo mapa que
 * possa divergir dela. Um par só entra quando os dois lados existem: uma barra
 * com denominador ausente desenharia uma proporção que ninguém mediu.
 */
export function progressoDoGate(
  gate: string,
  metrics: Readonly<Record<string, unknown>>,
): readonly Progresso[] {
  const pares: Progresso[] = [];
  const empurra = (chave: string, tem: unknown, precisa: unknown): void => {
    const a = numero(tem);
    const b = numero(precisa);
    if (a !== null && b !== null && b > 0) {
      pares.push({ chave, tem: a, precisa: b });
    }
  };

  if (gate === "G1") {
    empurra(
      "model_resolved_markets",
      metrics.model_resolved_markets,
      metrics.required,
    );
  }
  // G2 publica os pares já formados em `shortfalls.*`; o G3 carrega os mesmos
  // dentro de `evidence_base`, porque a base de evidência dele É a do G2.
  const shortfalls = objeto(
    gate === "G3"
      ? objeto(metrics.evidence_base).shortfalls
      : metrics.shortfalls,
  );
  for (const [chave, valor] of Object.entries(shortfalls)) {
    const par = objeto(valor);
    empurra(chave, par.have, par.need);
  }
  if (gate === "G4") {
    empurra("fee_samples", metrics.fee_samples, metrics.samples_required);
    empurra(
      "slippage_samples",
      metrics.slippage_samples,
      metrics.samples_required,
    );
  }
  return pares;
}

/**
 * A natureza do bloqueio de um gate, decidida pelos NÚMEROS.
 *
 * Devolve uma chave de `NATUREZA_BLOQUEIO`, ou `null` quando o gate não está
 * bloqueado (`PASS`) — a tela então mostra a situação e mais nada.
 *
 * Nenhum ramo aqui existe "porque é o G2": cada um pergunta a uma chave de
 * `metrics_json` o que ela vale. É por isso que a etiqueta do G2 já mudou de
 * "travado por defeito" para "acumulando" entre a redação da RFC e este código,
 * sem que uma linha fosse escrita para isso.
 */
export function naturezaDoBloqueio(
  gate: string,
  status: string | null,
  metrics: Readonly<Record<string, unknown>>,
  g2Clock: readonly RelogioG2[] = [],
): string | null {
  if (status === "PASS") {
    return null;
  }

  // G5: um piso de tempo. A data vem do relógio, nunca do `metrics_json`.
  if (numero(metrics.required_days) !== null) {
    return g2Clock.some((linha) => linha.clock_start !== null)
      ? "RELOGIO"
      : "RELOGIO_NAO_INICIADO";
  }

  // G6: nada o mede. Reconhecido pela ausência de qualquer par tem/precisa
  // somada à presença do identificador do relatório.
  if ("current_report_id" in metrics) {
    return "DECISAO_PROPRIETARIO";
  }

  // G1: enquanto nenhum modelo for promovido não há previsão de modelo para
  // pontuar, e nenhuma quantidade de tempo muda isso.
  const previsoesDeModelo = numero(metrics.model_forecasts);
  if (previsoesDeModelo !== null) {
    return previsoesDeModelo === 0 ? "DEPENDE_DE_MODELO" : "ACUMULANDO";
  }

  // G4: a reconciliação. Zero amostras COM fills existindo é defeito, não
  // falta de tempo; qualquer amostra já é acumulação.
  const amostrasDeFee = numero(metrics.fee_samples);
  const amostrasDeSlippage = numero(metrics.slippage_samples);
  if (amostrasDeFee !== null || amostrasDeSlippage !== null) {
    return (amostrasDeFee ?? 0) === 0 && (amostrasDeSlippage ?? 0) === 0
      ? "DEFEITO"
      : "ACUMULANDO";
  }

  // G2 e G3: a base de evidência do paper. `closed_positions = 0` com o motor
  // rodando há dias é o defeito da liquidação; qualquer posição fechada já é
  // acumulação.
  const base = gate === "G3" ? objeto(metrics.evidence_base) : metrics;
  const posicoesFechadas = numero(base.closed_positions);
  if (posicoesFechadas !== null) {
    return posicoesFechadas === 0 ? "DEFEITO" : "ACUMULANDO";
  }

  return null;
}

/**
 * A data em que o piso de tempo do G5 vence, ou `null`.
 *
 * `clock_start` mais tarde entre as categorias: o gate só passa quando TODAS
 * tiverem cumprido o piso, então a data que interessa é a da última. `null`
 * quando não há relógio — e a tela escreve "relógio não iniciado" em vez de
 * inventar uma data.
 */
export function dataDoRelogio(
  metrics: Readonly<Record<string, unknown>>,
  g2Clock: readonly RelogioG2[],
): string | null {
  const dias = numero(metrics.required_days);
  if (dias === null) {
    return null;
  }
  let maisTarde: number | null = null;
  for (const linha of g2Clock) {
    if (linha.clock_start === null) {
      continue;
    }
    const instante = new Date(linha.clock_start).getTime();
    if (
      !Number.isNaN(instante) &&
      (maisTarde === null || instante > maisTarde)
    ) {
      maisTarde = instante;
    }
  }
  if (maisTarde === null) {
    return null;
  }
  return new Date(maisTarde + dias * 86_400_000).toISOString();
}

// ---------------------------------------------------------------------------
// RFC-027 D6: o `detail` do feed vira texto
//
// O feed renderizava `JSON.stringify(detail, null, 2)` dentro de um `<details>`
// — em toda linha, para todo operador, o tempo todo. JSON cru numa tela de
// operação não é transparência: é o painel devolvendo o problema para quem
// veio buscar resposta.
//
// As chaves são as que `overview.ts` publica em `EVENT_SOURCES` (oito fontes).
// Uma chave que este mapa não conhece NÃO é escondida: ela deixa de aparecer
// como texto e continua inteira no modo engenheiro, que imprime o JSON como
// antes. Assim uma fonte nova nunca some da tela em silêncio — ela aparece do
// jeito antigo até alguém traduzi-la.
// ---------------------------------------------------------------------------

export const CHAVE_DETALHE: Readonly<Record<string, string>> = {
  from_state: "de",
  to_state: "para",
  reason: "motivo",
  trigger_source: "disparado por",
  decision_kind: "tipo",
  condition_id: "mercado",
  token_id: "token",
  market_side: "lado",
  size_shares: "cotas",
  edge_net: "edge líq.",
  outcome: "resultado",
  binding_constraint: "limitador",
  event_type: "evento",
  order_id: "ordem",
  kind: "tipo",
  scope: "escopo",
  ended_at: "encerrado em",
  edge_key: "aresta",
  magnitude_bps: "magnitude (bps)",
  magnitude: "magnitude",
  suppressed: "suprimida",
  direction: "direção",
  position_held: "com posição aberta",
  category: "categoria",
  previous_start: "início anterior",
  new_start: "novo início",
};

/**
 * Que dicionário traduz o VALOR de cada chave.
 *
 * Sem isto, "para: HALTED" seria traduzido pela metade — o rótulo em português
 * e o valor em código. A regra do módulo continua valendo: o código volta no
 * `title` e no modo engenheiro.
 */
const DICIONARIO_DO_VALOR: Readonly<Record<string, Dicionario>> = {
  from_state: ESTADO_PORTFOLIO,
  to_state: ESTADO_PORTFOLIO,
  trigger_source: GATILHO_TRANSICAO,
  decision_kind: TIPO_DECISAO,
  market_side: LADO,
  outcome: RESULTADO_DECISAO,
  binding_constraint: LIMITADOR,
  event_type: EVENTO_LEDGER,
  kind: TIPO_DISJUNTOR,
  direction: DIRECAO_DIVERGENCIA,
  category: CATEGORIA,
};

export interface CampoDetalhe {
  readonly chave: string;
  readonly rotulo: string;
  readonly valor: string;
  /** O `title`: a consequência quando há, o código cru quando não. */
  readonly titulo: string | undefined;
}

function valorLegivel(chave: string, valor: unknown): string | null {
  if (valor === null || valor === undefined || valor === "") {
    return null;
  }
  if (typeof valor === "boolean") {
    return valor ? "sim" : "não";
  }
  if (typeof valor === "number") {
    return String(valor);
  }
  if (typeof valor !== "string") {
    // Objeto ou lista aninhada: não há tradução de uma linha para isso, e
    // achatá-lo aqui reinventaria o JSON com menos informação. Fica para o
    // modo engenheiro.
    return null;
  }
  const dicionario = DICIONARIO_DO_VALOR[chave];
  return dicionario === undefined ? valor : rotulo(valor, dicionario);
}

/**
 * O `detail` de um evento como campos legíveis.
 *
 * Devolve só o que sabe traduzir, na ordem em que as chaves chegaram. Uma lista
 * vazia quer dizer "não conheço nada disto" — e a tela então mostra o aviso que
 * manda ligar o modo engenheiro, em vez de uma seção vazia.
 */
export function traduzDetalhe(
  detail: Readonly<Record<string, unknown>>,
): readonly CampoDetalhe[] {
  const campos: CampoDetalhe[] = [];
  for (const [chave, bruto] of Object.entries(detail)) {
    const rot = CHAVE_DETALHE[chave];
    if (rot === undefined) {
      continue;
    }
    const valor = valorLegivel(chave, bruto);
    if (valor === null) {
      continue;
    }
    const dicionario = DICIONARIO_DO_VALOR[chave];
    campos.push({
      chave,
      rotulo: rot,
      valor,
      titulo:
        dicionario === undefined || typeof bruto !== "string"
          ? chave
          : consequencia(bruto, dicionario),
    });
  }
  return campos;
}

/**
 * As chaves que `traduzDetalhe` não soube traduzir. A tela as nomeia.
 *
 * Uma chave AUSENTE de valor — `null`, `undefined` ou `""` — não é
 * desconhecida: é vazia, e não há o que mostrar nem o que traduzir. Contá-la
 * aqui faria toda linha do feed anunciar "+1 sem tradução" por causa de um
 * `ended_at` nulo, que é o normal de um disjuntor aberto.
 */
export function chavesDesconhecidas(
  detail: Readonly<Record<string, unknown>>,
): readonly string[] {
  return Object.keys(detail).filter((chave) => {
    const bruto = detail[chave];
    if (bruto === null || bruto === undefined || bruto === "") {
      return false;
    }
    if (CHAVE_DETALHE[chave] === undefined) {
      return true;
    }
    // Conhecida mas não representável numa linha (objeto, lista): o JSON do
    // modo engenheiro é o lugar dela.
    return valorLegivel(chave, bruto) === null;
  });
}
