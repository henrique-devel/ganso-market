# model-worker

Estrutura de processo da RFC-001. Expõe somente health, readiness e métricas
internas. Não contém modelo, inferência, jobs, dados de mercado ou acesso a
signer. Como não há dependência obrigatória nesta fase, readiness representa a
validade da configuração e a capacidade do servidor de responder.
