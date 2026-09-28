# Retirada definitiva Polymarket — 28/09/2026

Autorização explícita do proprietário: todo código/dado exclusivo, local até
produção. BTC/Hyperliquid, auth, ledger e pins BTC permanecem.

A migration [0049](../../migrations/0049_retire_polymarket.sql) contém a lista
fechada de 72 tabelas, 36 funções e uma view. DROP RESTRICT em transação recusa
consumidores externos; não usa CASCADE, prune global, exclusão do volume ou
liberação de HOLD. As 48 migrations anteriores mantêm seus checksums para
bancos existentes. Em instalações novas, o schema final também não contém o
legado. Proteções genéricas da fundação sobrevivem; pins BTC são independentes.

## Publicação

1. Gate de código, PostgreSQL (inclusive upgrade com dados e dependência externa)
   e Compose isolado. Registrar hashes/contagens do ledger BTC, OIDs das relações
   protegidas, HOLD/guards, ID/início do banco e capacidade antes da aplicação.
2. Remover somente `/etc/ganso/legacy-quiesced.compose.yml` da lista COMPOSE_FILE
   em `deploy/server.env`; manter overlay BTC e demais campos. Conferir config
   efetiva e quiescência sem executar up. Isso evita referências a serviços retirados.
3. PR/merge/deploy seletivo de API/web/Nginx e migration. Não recriar PostgreSQL
   nem iniciar coleta BTC. Recriar o container BTC parado com a imagem nova,
   usando `up --no-start --no-deps --no-build --force-recreate`, para retirar o código antigo também dessa imagem.
4. Remover os cinco containers Polymarket por labels/IDs verificados; unidades
   e overrides de recorder-watchdog/shadow-replay; overlay legado, replay em
   `/var/lib/ganso/shadow-replay`, estado do watchdog e diagnósticos exclusivos
   inventariados. O capacity-monitor atual usa df diretamente e permanece.
5. Excluir somente snapshots de código anteriores identificados e imagens
   antigas do projeto sem consumidores, por manifesto explícito. Nenhuma
   exclusão de volumes, imagem compartilhada em uso ou prune global.
6. Verificar ausência das relações/rotas/serviços aposentados, hashes do ledger
   e OIDs preservados, guards/HOLD BTC, saúde/autenticação e espaço recuperado.

## Compatibilidade

A remoção de dados é irreversível. Git mantém histórico de código; nenhuma
recuperação de dados apagados é prometida. Depois da migration 0049, não usar
release pré-retirada como rollback funcional. Falha posterior exige correção
para frente ou release já compatível com 0049. Backup não é requisito desta
entrega. Dados frescos/coleta retomada continuam sujeitos aos gates BTC.
