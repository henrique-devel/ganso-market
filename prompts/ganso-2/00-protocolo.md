# Protocolo Ganso 2.0 — contexto mínimo e entrega completa

Vigente para `prompts/ganso-2/*`. O pedido atual do proprietário prevalece. Fonte: [autorização, emenda 2.0](../../docs/ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-ganso-20--entrega-com-registro-minimo-22092026).

## Entrada

1. Conferir raiz, alterações locais e base atual. Preservar trabalho alheio; não resetar ou reaplicar código já integrado. Usar checkout isolado quando necessário.
2. Ler um prompt, contrato comum e somente sua seção da RFC; consultar sua linha/dependências no [estado](../../docs/roadmap/GANSO_2_EXECUTION_STATE.md). PRD por seção, sob demanda. Nenhuma leitura integral de histórico.
3. Abrir os caminhos/símbolos indicados. Arquivo ausente: localizar na main reconciliada. Caminho proposto não é código existente. Confirmar dependências por contrato/código e resultado resumido, sem exigir recibo antigo.

## Autorização e escopo

**Código → branch/commit/push → PR → correção dos checks → merge → produção estão autorizados para a sessão selecionada**, sem nova confirmação em cada etapa. Inclui migrations aditivas previstas, configurações, testes, restart seletivo e ativação paper explicitamente descrita. Respeitar proteções de branch, identidade SSH e permissões reais das ferramentas. Mudança só de texto segue dispensa de deploy; leitura sem mudança não exige PR vazio.

Esse fluxo não ativa dinheiro real/signer, contrata serviço, aumenta orçamento nem autoriza apagar qualquer dado. Para compra, descarte ou mudança de perímetro, usar autorização específica já existente; se faltar, preparar resultado concreto, continuar parte independente e pedir só a decisão faltante. Nunca transformar falta de recibo em bloqueio.

## Trabalho e validação

Backup e restauração de backup ficam para depois de o sistema estar 100% operante; não implementar nem exigir como pré-requisito de nenhuma sessão atual. Retenção, pins e retomada após reinício continuam no escopo.

- Uma entrega coerente: alvo de 3–6 arquivos de lógica e até uma migration. É referência de tamanho, não motivo para deixar stub ativo. Se precisar dividir mais, registrar subbloco e fronteira no estado antes de ampliar escopo.
- Fixar entrada, saída e versão do contrato do bloco. Consultar fonte oficial atual quando implementar interface externa mutável. Testes SQL em PostgreSQL descartável, nunca produção.
- Dinheiro fixed-point; reservas/ledger idempotentes e por dono; dado stale não vira fresco; simulação não fabrica fills. Paper continua identificado e não instancia executor live por encontrar uma chave.
- Rodar testes proporcionais e checks obrigatórios. Corrigir falhas relevantes, sem bypass. Depois de aprovado, não repetir toda a suíte sem mudança ou falha nova.
- Fazer merge e verificar implantação apenas dos serviços afetados: saúde, versão quando aplicável e uma checagem breve da função. Usar rollback previsto se falhar, preservando schema/dados. Não exigir ensaio longo em cada sessão.

## Encerramento sem burocracia

Atualizar somente a linha do prompt no estado: **status; PR/SHA quando houver; validação em uma frase; deploy ou pendência**. O resumo e os resultados disponíveis no CI/PR bastam. Sem recibo, pasta de evidências, screenshots, dump de logs ou relatório formal obrigatório. Não registrar passed/deployed se não foi observado. Relatório ausente não invalida trabalho validado.

Dados necessários ao funcionamento — ledger, respostas Jev, pins e métricas do experimento — continuam sendo requisitos do produto; não são documentação de sessão. Janelas de 7/30 dias ficam em G2-09.4/5; se faltarem, usar estado `observing`, sem manter a sessão esperando.

Na resposta final, informar entrega, validação resumida, implantação e eventual impedimento real. **Parar no prompt selecionado.** Não começar outra sessão/agente/bloco automaticamente.
