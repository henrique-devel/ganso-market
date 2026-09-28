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

A política recebe o ID/payload/hash completos da metadata pinada no registro.
A observação mais recente, selecionada as-of, precisa concordar em todos os
campos do instrumento, regras, taxas e proveniência do parser/referência. Só
podem variar os relógios da observação local e o hash da resposta bruta da venue
(que inclui outros ativos). Esses campos continuam nos payloads e hashes
originais: a comparação não recalcula nem altera o hash congelado. Versão igual
sozinha não comprova equivalência. O snapshot da conta retém ambas as evidências
e o resultado da comparação; revisão econômica real ou evidência futura/ausente
veta entradas. Registro, início e decisões antigas permanecem imutáveis.

## Decisão, execução e retomada

Janela de entrada `[T+10s,T+60s)`, uma decisão por barra/conta/experimento/
política/manifesto/instrumento. A decisão e os inputs pinados são permanentes.
O consumidor prioriza a janela atual e registra no máximo uma janela perdida
por ciclo, sem enviar entradas históricas. A janela do experimento é 30 dias;
saídas continuam depois dela. A seleção usa as barras retidas conhecidas no
relógio real, nunca um candle da venue ou um preço posterior relabelado.
Sem prova do início original da série, uma janela curta é `data_unavailable`,
não um warmup presumidamente íntegro. Gaps e revisões inválidas vetoam entradas.

A leitura e os hashes do histórico volumoso usam uma transação READ ONLY fora
do lock de retenção. Sob o fence de execução, o consumidor confere as mesmas
versões das barras; mudança concorrente adia a decisão. Conta, risco, reserva,
ordem e pins permanecem atômicos. A decisão conserva todos os inputs de replay,
mas protege dependências transitivas pelos roots das barras e da conta, evitando
milhares de vínculos redundantes. Recovery consulta cada nó do grafo por índice.
Essas medidas reduzem contenção; não alteram o timeout de 2s nem garantem ausência
de contenção em toda carga futura. Uma parada do coletor exige diagnóstico.

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


## G2-13.3 — Rearme protegido e períodos sucessores

Esta entrega instala mecanismo e migration 47; não executa rearme nem registra
um período produtivo. G2-13.4 só pode operar após a admissão de G2-12.3, fontes
recentes/sem gaps, funding disponível, reconciliação, capacidade e custo total
coberto no teto de US$80/mês. HOLD de retenção, ledger, pins e caps permanecem.

A leitura produtiva somente leitura de 28/09/2026 04:29:50 UTC conferiu registro
original às **26/09/2026 04:13:50.585 UTC**, início **26/09 04:15 UTC** e fim
exclusivo **26/10 04:15 UTC**. O intervalo remanescente pode servir a um piloto;
não fornece 30 dias completos futuros desde esta entrega. Pausas e ausência de
dados permanecem nessa janela. Não transformar retrospectivamente o piloto
ou os gaps em avaliação econômica completa.

O CLI `apps/api/dist/baseline-operate-cli.js OWNER` recebe **um JSON pelo stdin**.
`OWNER` precisa corresponder ao dono existente da baseline paper habilitada.
O binário lê seu SHA de `/etc/ganso/release-sha`; não aceita saldo, checkpoint,
capital, caps, flags de frescor ou identidade de worker fornecidos pelo operador.
O resultado de stdout contém apenas ação, operation_id e status; o journal
retém o checkpoint, sem exportar finanças pelo terminal.

Rearme, somente após os gates atuais:

```json
{"action":"rearm","operation_id":"rearme-operacional-001","reason":"Gates atuais de capacidade, fontes e funding conferidos"}
```

A operação revalida o dono sob lock, usa recovery/reconciliação e fence finais,
confere as evidências de metadata, livro, contexto, captura e funding e chama
`applyRiskTx` dentro de `riskTransaction`. Não atualiza diretamente checkpoints.
O journal conserva as âncoras; ganhos observados e mudança real do dia continuam
seguindo o contrato de risco existente. Repetir o mesmo ID e conteúdo devolve o
resultado anterior: **uma pausa posterior permanece pausada**, ainda que o recibo
antigo diga NORMAL. Outra tentativa intencional requer novo ID e novos gates;
conteúdo diferente sob o mesmo ID é recusado. A prontidão deve ser lida novamente
após a operação. Fonte recuperada não dispara rearme automático.

**Lease do CLI:** um processo independente recebe `BTC_RECOVERY_OWNED` enquanto
outro consumidor tiver lease válido; worker antigo recebe `BTC_RECOVERY_FENCED`.
Não copiar worker_id/generation, editar lease/checkpoint ou fazer retry agressivo.
Planejar uma manutenção breve: pausar entradas de todas as contas geridas pela
API pelos seus contratos autenticados, manter a gestão de saídas e só então
confirmar **todas essas contas flat e sem ordens/reservas ativas**, para não
interromper saídas manuais, baseline ou challenger. Se houver posições, adiar o
CLI até flat; não parar o gestor para forçar rearme. Depois dos gates, parar
somente API e aguardar expiração natural de seu lease. Rodar o comando no mesmo
release:

```sh
docker compose --env-file deploy/server.env run --rm --no-deps -T \
  --entrypoint node api apps/api/dist/baseline-operate-cli.js OWNER < operation.json
```

Restaurar somente a API e conferir Nginx/upstream, saúde, recuperação e prontidão;
o CLI também deixa um lease de 30 segundos, que deve expirar naturalmente para
o consumidor assumir. Fazer isso mesmo após erro, preservando a contenção de
entradas. Não parar PostgreSQL, iniciar coletor, alterar restart/timers ou remover
HOLD. Este procedimento **não foi executado em G2-13.3**.

Um sucessor é registrado separadamente, antes do seu início, por exemplo:

```json
{"action":"register_period","operation_id":"avaliacao-futura-001","reason":"Janela prospectiva definida antes da observacao","purpose":"economic_evaluation","start_at":"2026-10-26T04:15:00.000Z"}
```

A data é um exemplo baseado no fim original, não autorização para executar nem
cronograma automático; se já tiver passado, deve ser escolhida outra fronteira
UTC de 15 minutos estritamente futura. `purpose` aceita `operational_pilot` ou
`economic_evaluation`. Cada período dura exatamente 30 dias e começa no fim ou
depois do predecessor; sobreposição, retroatividade e redução de janela são
recusadas. Não cancelamos nem encurtamos o período original para excluir perdas.

`btc.baseline-period.v1` guarda versão, SHA, dono, motivo, fingerprint do registro
original e evidência anterior. Migration 47 é append-only, sem seeds; o payload
entra na retenção existente com pin e arestas para original/predecessor, sujeito
às mesmas quotas. Registro não deposita novos US$1.000, não materializa gênese,
não muda saldo, funding, histórico ou pausas. A identidade financeira permanece
original. A seleção prioriza a barra atual e usa a mesma chave única conta/barra:
períodos futuros não executam cedo e não duplicam sinais. Decisões de sucessores
carregam o período versionado e a referência pinada para replay. Histórico legado
sem esse campo mantém sua interpretação original. Funding e todas as saídas
antigas continuam, inclusive depois da expiração e entre períodos. Expiração é
revalidada também na admissão/execução de entradas.

Esta camada entrega seleção/horizonte; não certifica cobertura, estabilidade,
comparação econômica ou 30 dias observados. G2-14/G2-17 devem mostrar as janelas
selecionadas e os gaps sem misturar piloto e avaliação ou renomear o início
financeiro. Nenhum período sucessor nem rearme é criado em startup/migration.

Deploy: migration aditiva e somente API; PG/coletor/web e perímetro preservados.
Rollback conserva schema 47/pins/histórico e leitores de projeção de decisões
compatíveis com schema 46. Antes de retornar a um binário sem períodos, conter
entradas: esse binário ignora sucessores e mantém apenas gestão histórica de
saídas; não apagar períodos para fazê-lo parecer compatível com nova avaliação.
