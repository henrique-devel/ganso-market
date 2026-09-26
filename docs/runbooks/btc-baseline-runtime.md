# Conta-base automática paper — G2-07.3

A API hospeda a conta-base no consumidor já provisionado, separado da conta
manual e sem IA. `config/trading/baseline.json` e seu contrato normativo continuam
congelados. Carregar o código ou aplicar a migration 43 não ativa uma conta.

## Ativação prospectiva

Depois dos checks, merge, deploy seletivo e leitura de capacidade/frescor do
coletor, o operador executa no release publicado:

```sh
python3 - <<'PY' | docker compose --env-file deploy/server.env exec -T api node apps/api/dist/baseline-activate-cli.js OWNER
import json
from pathlib import Path
print(json.dumps({
    "manifest": Path("config/trading/baseline.json").read_text(),
    "contract": Path("docs/contracts/btc-baseline-manifest-v1.md").read_text(),
}))
PY
```

Substituir `OWNER` pelo usuário autenticado já existente. O CLI valida os bytes,
o fingerprint e os contratos de runtime, e lê o SHA da imagem em
`/etc/ganso/release-sha`. Grava registro append-only ligado à conta, dono,
metadata, manifesto e código; `start_at` é a próxima fronteira UTC de 15 minutos
estritamente posterior ao registro. Repetir retorna o registro original, sem
reabilitar pausas nem mover o início. Outra conta-base preexistente é recusada.

A identidade é registrada imediatamente. A gênese única de USD6 `1000000000`
é materializada pelo consumidor em/apos `start_at`: o ledger proíbe registrar
cedo um evento econômico futuro. Antes disso a projeção financeira pode aparecer
indisponível. Cada cenário tem sua própria banca; nenhum saldo é somado à manual.

## Decisão, execução e retomada

Janela de entrada `[T+10s,T+60s)`, uma decisão por barra/conta/experimento/
política/manifesto/instrumento. A decisão e os inputs pinados são permanentes.
O consumidor prioriza a janela atual e registra no máximo uma janela perdida
por ciclo, sem enviar entradas históricas. A janela do experimento é 30 dias;
saídas continuam depois dela. A seleção usa as barras retidas conhecidas no
relógio real, nunca um candle da venue ou um preço posterior relabelado.
Sem prova do início original da série, uma janela curta é `data_unavailable`,
não um warmup presumidamente íntegro. Gaps e revisões inválidas vetoam entradas.

Candidato → revalidação → risco/reserva → IOC usam a mesma transação e locks
de retenção/conta/recovery. A execução exige outro livro posterior à latência de
1s e respeita o TTL original de 5s. Veto na admissão/execução é registrado sem
resize nem substituição do candidato. Fills parciais cancelam o restante.
Restart retoma apenas IOC ainda válido e já reservado, ou expira o vencido;
nunca cria outra ordem para o sinal consumido.

O primeiro fill fixa stop/deadline. Saídas observadas persistem entre ciclos e
restarts, cancelam aumentos e reduzem antes de outra entrada. Outra tentativa
exige livro econômico estritamente mais novo e nenhum IOC de redução ativo.
Sem livro, a saída permanece pendente; o sistema não inventa preço de stop.
Liquidação do núcleo tem prioridade. Funding continua no modelo paper v2/RATE18,
com HTTP antes do corte e suas limitações; fetch ocorre fora da transação SQL.

A Mesa mostra até 20 decisões recentes, candidato, motivos, admissão/execução
e saídas; Operações detalha ordens, fills e custos da conta selecionada. O botão
de pausa autenticado também aceita a baseline; nenhum ticket manual pode abrir,
cancelar ou fechar suas ordens. A pausa grava REDUCE_ONLY e não impede gestão
de saída. Retorno de dados não rearma risco. Rearme permanece uma operação
explícita `applyRisk(..., action: "rearm")`, sob o mesmo owner/fence; não zerar
guards ou trocar diretamente o checkpoint no banco.

HOLD de retenção protege dados e é independente do HALTED da conta. Nenhum
limite de coleta, disco, SQL ou pool é ampliado por esta entrega. Se o coletor
parar ou ficar stale, a baseline registra abstenção; não reiniciar saturado.

## Verificação e reversão

Fixtures PostgreSQL descartáveis exercitam skip, candidato long/short, parcial,
latência, veto de preço, saída por stop/prazo/pausa, concorrência, restart,
autenticação e isolamento da manual. Não representam operações produtivas ou
desempenho econômico. Os checks obrigatórios incluem source, PostgreSQL e Compose.
Implantação seletiva: migration aditiva e API/web; preservar coletor, PostgreSQL,
legado, pins e histórico. Conferir SHA, saúde, liveness da conta e uma decisão
real quando houver janela; input insuficiente é resultado legítimo.

Para conter entradas, usar a pausa autenticada. Não desativar o consumidor
enquanto houver posição sem assegurar outro gestor de saídas. Rollback para
binário anterior à G2-07.3 não gere saídas baseline: exige conta flat, sem
reservas, e entradas desabilitadas antes da troca. Preservar schema 43,
registro/decisões/eventos, ledger e pins; o binário também precisa compreender
funding v2/RATE18. Nunca apagar gênese ou reiniciar o experimento para esconder
perda, gap ou indisponibilidade.
