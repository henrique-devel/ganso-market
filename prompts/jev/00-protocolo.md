# Protocolo de execução das entregas JEV

O [índice](README.md) organiza 14 entregas JE01–JE14 com 46 checkpoints de código/diagnóstico e seis etapas operacionais próprias; os 52 IDs GJ e seus aceites permanecem. Execute a entrega ou etapa selecionada, avançando internamente sem novo pedido. A preparação documental não inicia implementação. A [especificação vigente](../../docs/PRD-GANSO-JEV.md) prevalece sobre baseline/filtro e banca US$1.000 do ciclo antigo.

## Autonomia e contexto

A [autorização JEV](../../docs/ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-jev-com-autonomia-por-bloco) cobre alteração, branch `codex/`, commit/push, criação/correção/revisão do PR, merge após checks/proteções e implantação seletiva de todo o grupo. Inclui migrations aditivas, configuração, quiescência reversível e restart previstos. Selecionar um grupo autoriza continuar seus checkpoints, sem novo pedido por ID. Pedido restrito a um ID limita o escopo. Outra entrega exige seleção, salvo sequência expressamente solicitada. Não criar chats/agentes/agendamentos automaticamente.

Leia uma vez o prompt da entrega, este protocolo e a emenda de autorização; consulte sua linha/IDs/dependências no [estado](../../docs/roadmap/GANSO_JEV_EXECUTION_STATE.md). Abra checkpoints e seções PRD/plano à medida que precisar de seus contratos/aceites. Consulte o [inventário](../../docs/architecture/ganso-jev-code-map.md) por componente e código por símbolo. Sem teto documental arbitrário nem leitura de todo o pacote: reutilize contexto pertinente já disponível. Código e runtime verificados são os fatos.

Comece conferindo raiz, branch, base e delta. A árvore inicial tinha trabalho BTC não rastreado; SHA isolado não comprova seu conteúdo. Preserve alterações alheias, reutilize trabalho integrado e use checkout isolado quando necessário. Não fazer reset/stash destrutivo nem incluir delta alheio no PR.

`depends_on` continua obrigatório por checkpoint. Dependências externas devem estar integradas ou comprovadas na base; dependências internas podem ser validadas na mesma branch antes da parte seguinte, sem PR/merge intermediário. Uma linha planejada não invalida código já existente comprovado. Gates operacionais condicionam ativação/qualificação, sem impedir código desativado. Sete/90 dias e 60 episódios são observação real do produto; não manter sessão de código aguardando.

O tamanho segue a fronteira funcional, sem limite fixo de arquivos/migrations aditivas. Use checkpoints pequenos dentro da entrega, teste os comportamentos críticos e corrija falhas antes da parte dependente. Divida uma entrega apenas quando necessário à revisão/compatibilidade; registre continuação e mantenha o grupo aberto até todos os aceites. Sem stub operacional ou falso aceite. Código, ledger, respostas JEV e métricas continuam requisitos do produto.

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

Inspecione antes de alterar; escolha detalhes rotineiros dentro dos contratos e versione antes do experimento. Confira documentação oficial atual para APIs externas. Se houver conflito material de capital, orçamento ou produto não decidido, conclua o trabalho independente e peça somente a decisão faltante.

Durante a implementação, execute testes específicos do delta e falhas relevantes, com resultados financeiros calculados independentemente. SQL exige PostgreSQL descartável com o harness existente; nunca produção. Preserve testes de isolamento, reserva/ledger, cancel/fill, restart, proteção parcial e singleton. Não repetir a suíte completa entre checkpoints sem nova alteração/falha que justifique.

No fechamento da entrega, execute `make verify`, `make test-postgres` e verificações exigidas na base reconciliada; checks obrigatórios de PR/main e integração Compose permanecem antes da publicação aplicável. Teste pulado não é aprovado. Resultado de revisão ou ambiente diferente não comprova o delta atual. JE01 registra a baseline; leitura sem delta não exige PR vazio e só texto segue dispensa de deploy.

Prefira um PR coerente por entrega; revise contratos/diff/segredos/compatibilidade, acompanhe checks, corrija, faça merge e publique os componentes afetados. Anexe todo PR criado à tarefa. Verifique versão/saúde/persistência/proteções do que foi publicado. A redução de repetições vem do agrupamento, sem bypass de checks/proteções.

Migration aplicada/eventos são imutáveis. Reversão usa versão compatível, pausa entradas, preserva proteção e reconcilia; nunca desfaz schema apagando dados. Preserve auth/perímetro/identidade SSH/segredos. Não ampliar quota, descartar protegido ou criar backup fora do escopo vigente.

Ativação paper é selecionada separadamente em GJ12.2 com capacidade/cobertura/custo efetivos. Qualificação técnica observada é GJ12.3. Testnet delimitada é GJ13.5. Operação real exige gates e ato inicial autenticado do operador; não clicar pelo humano, depositar, armar signer ou aumentar limites por publicar código. Sucessão posterior automatizada respeita o contrato. Não criar agendamento ou enviar mensagens externas sem pedido.

Atualize apenas a linha da entrega e seus IDs verificados no estado; eles podem compartilhar PR/SHA. Em etapa operacional, atualize só seu ID. Registre validação, publicação/gate pendente e, na interrupção, base/branch, delta e próximo checkpoint. Marque o grupo concluído somente com todos os aceites cobertos e fechamento observado. Sem recibo, relatório ou screenshots obrigatórios. Encerre após o escopo selecionado.
