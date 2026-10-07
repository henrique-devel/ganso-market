# Protocolo das sessões JEV

Execute somente o prompt selecionado em [índice](README.md). O pacote divide GJ00–GJ15 em 52 sessões; criar o pacote não executa suas entregas. A [especificação vigente](../../docs/PRD-GANSO-JEV.md) prevalece sobre baseline/filtro e banca US$1.000 do ciclo antigo.

## Autonomia e contexto

A [autorização do proprietário](../../docs/ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-jev-com-autonomia-por-bloco) cobre alteração e implementação, branch `codex/`, commit/push, criação/correção do PR, merge após revisão/checks/proteções e publicação em produção do escopo selecionado, sem reconfirmação por etapa. Inclui migrations aditivas, configuração, quiescência reversível e restart seletivo previstos. Publicar código e ativar operação são resultados distintos.

Leia este protocolo, a emenda de autorização, a linha do prompt e dependências no [estado](../../docs/roadmap/GANSO_JEV_EXECUTION_STATE.md), uma seção do plano e somente as seções do PRD indicadas. Consulte o [inventário](../../docs/architecture/ganso-jev-code-map.md) por componente se precisar localizar símbolos. Alvo de leitura documental inicial: 1.500 palavras, expandindo somente o contrato necessário. Não carregar todos os prompts, RFCs ou histórico da conversa. O prompt é o roteiro; código e runtime verificados são os fatos.

Comece conferindo raiz, branch, base e delta. A árvore inicial tinha trabalho BTC não rastreado; SHA isolado não comprova seu conteúdo. Preserve alterações alheias. Reutilize trabalho integrado e use checkout isolado quando necessário. Não fazer reset/stash destrutivo nem incluir o delta alheio no PR.

`depends_on` indica contratos/código disponíveis, verificáveis no commit ou PR integrado. Uma linha planejada não invalida código já existente comprovado. Gates operacionais só condicionam ativação/qualificação; não impedem desenvolver/publicar código desabilitado. Sete e 90 dias são observação do produto, sem manter uma sessão aberta aguardando.

Alvo por sessão: 3–6 arquivos de lógica e até uma migration aditiva; testes, contratos e registro podem complementar. Se uma fronteira for maior, conclua a menor unidade funcional segura e deixe a continuação delimitada na mesma linha, sem stub operacional nem falso aceite. Não iniciar outro prompt, chat ou agente automaticamente.

## Contratos comuns

- BTC Hyperliquid perps, operador único; três perfis paper com stress independente e US$250 fictícios por conta. Primeiro ciclo com horizontes 1/3/5 minutos; horizonte não é cadência nem permanência obrigatória.
- No máximo um piloto live de US$250 reais totais, isolated 1x, patrimônio/HWM persistentes entre sucessores. Sem aporte, reset, pirâmide, aumento, reversão automática ou expansão para moedas.
- JEV decide direção e abrir/manter/fechar; código determina tamanho, risco e proteção. Cadência 60s; 2s apenas com posição aberta e gatilho versionado. Risco e saídas urgentes continuam sem JEV. Não transformar falha em hold, simular resposta real ou reinferir replay.
- Lote por perfil para contas que precisam decidir; vínculo explícito na pergunta, mesmo contexto de origem, estados próprios por conta. Custo desconhecido impede admissão. Modelos, prompts, critérios e respostas são versionados.
- Risco: entrada planejada 1% da equity de trading atual; exposição 50%; perda diária 2% da equity inicial UTC; drawdown fixo US$12,50 desde pico. Equity de risco inclui fees/funding/PnL aberto e exclui JEV/infra. Bloqueio global não é liberado por sucessão. Rearme diário só no próximo UTC, flat/reconciliado/fresco e sem bloqueio global.
- Stop fixo 2 ATR, ATR14 em candles fechados de 15min; reserva integral da tolerância nativa de 10% dentro do risco de entrada. Máximo 6h desde primeiro fill, sem take profit/trailing/trend exit.
- Maker post-only, um passo válido dentro do spread ou próprio melhor preço; rejeição não vira taker. Latência paper 1s/stress 2s; espera maker 2s após ACK; cancelar/reconciliar parcial, sem completar quantidade. Saídas IOC reduce-only; incerteza não vira fill/flat. Proteção nativa por posição desde primeiro parcial, independente da ordem de entrada.
- Stress é conta prospectiva com estado/funding/fills próprios e trading fees dobradas. Fila observada e liquidez determinam fills; toque de preço sozinho não prova execução.
- Resultado da estratégia desconta fees, funding assinado e JEV. Infra fica fora do PnL, aprovação e limites, inclusive após 90 dias; card manual separado. Bill JEV conta request uma vez; avaliação de cada conta desconta integralmente o lote de que participou. Não somar essa atribuição conservadora como fatura real.
- Pools JEV mensais agregados: US$8 operação e US$2 geração/validação, dentro do teto de planejamento US$80. Não comprar créditos/serviços por autorização de deploy.
- Elegibilidade inicial: motor qualificado por sete dias válidos, 60 episódios fechados em cada paper/stress, cobertura 99%, custos reconciliados e resultado conservador positivo em ambos. PnL aberto positivo não ajuda. Avaliação completa após 90 dias e rolling diário, margem 5pp sobre melhor caixa/BTC protegido, sem reiniciar posições/benchmarks.
- Sucessão live somente por reprovação comprovada; fechar/cancelar/reconciliar antes da reserva atualmente elegível. Três vagas de espera além dos pares ativos; prioridade/remoção persistidas. JEV valida coerência da proposta, sem provar lucro; uma mudança por versão dentro do template/faixas aprovados.
- Ledger, resultados e versões permanentes; evidência funcional do experimento protegida durante execução e 180 dias depois ou dependência maior. Quota não remove pins. Falta de espaço pausa admissão; sem apagar protegido, elevar quota ou criar backup fora do escopo vigente.

## Verificar e entregar

Inspecione antes de alterar; escolha detalhes rotineiros dentro dos contratos, registre/versione antes do experimento e prossiga. Para APIs externas, confira documentação oficial atual. Em conflito material de capital, orçamento ou produto não decidido, conclua o trabalho independente e peça somente a decisão faltante.

Teste comportamentos do aceite e falhas relevantes, sem testes espelho ou suíte repetida sem motivo. SQL em PostgreSQL descartável com o harness existente; nunca produção. Confira comandos e CI da base; `make verify` e checks obrigatórios devem passar antes do merge. Teste pulado não é aprovado.

Revise diff/segredos/compatibilidade; crie PR, acompanhe checks, corrija, faça merge e publique o componente afetado. Anexe qualquer PR criado à tarefa. Verifique versão/saúde/persistência/proteções. Só texto segue dispensa de deploy; leitura sem delta não exige PR vazio.

Migration aplicada/eventos são imutáveis. Reversão usa versão compatível, pausa entradas, preserva proteção e reconcilia; nunca desfaz schema apagando dados. Preserve auth/perímetro/identidade SSH e segredos. Não force gates ou bypass.

Ativação paper só no prompt próprio com capacidade/cobertura efetivas. Testnet delimitada segue GJ13.5. Operação real exige gates e ativação inicial autenticada do operador; não clicar pelo humano, depositar, armar signer ou aumentar limites por publicar código. Sucessão posterior automatizada respeita o contrato. Não criar agendamento ou enviar mensagens externas sem pedido.

Atualize apenas a linha selecionada do estado e encerre: mudança, PR/SHA, validação observada, publicação ou pendência concreta. Sem recibo, relatório ou screenshots obrigatórios. Dados financeiros e respostas JEV continuam requisitos do produto.
