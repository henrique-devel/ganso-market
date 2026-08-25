SHELL := /bin/sh
.DEFAULT_GOAL := help

PYTHON ?= python3
VENV := .venv
RUFF := $(VENV)/bin/ruff
SERVER_ENV ?= deploy/server.env
SERVER_COMPOSE := docker compose --env-file $(SERVER_ENV)

.PHONY: help doctor install init-secrets format format-check lint test build verify \
	contracts-check compose-config licenses up migrate integration resource-check secret-scan down \
	recorder-up recorder-logs recorder-down \
	estimator-up estimator-logs estimator-down \
	paper-up paper-logs paper-down \
	resolution-up resolution-logs resolution-down \
	server-init server-config server-up server-health server-status server-logs server-update server-down

help:
	@echo "Ganso Market RFC-001"
	@echo "  make doctor         verifica toolchains"
	@echo "  make install        instala dependencias locais fixadas"
	@echo "  make verify         format-check, lint, testes, build, scan e Compose config"
	@echo "  make up             sobe o runtime local em 127.0.0.1"
	@echo "  make integration    testa Compose, readiness e shutdown"
	@echo "  make down           encerra sem apagar volumes"
	@echo "  make recorder-up    sobe o recorder Polymarket (dados públicos)"
	@echo "  make recorder-logs  acompanha os logs do recorder Polymarket"
	@echo "  make recorder-down  encerra o recorder Polymarket"
	@echo "  make estimator-up   sobe o modelo fundamental (RFC-010)"
	@echo "  make estimator-logs acompanha os logs do modelo fundamental"
	@echo "  make estimator-down encerra o modelo fundamental"
	@echo "  make paper-up       sobe o paper broker (RFC-011, simulação)"
	@echo "  make paper-logs     acompanha os logs do paper broker"
	@echo "  make paper-down     encerra o paper broker"
	@echo "  make resolution-up  sobe o risco de resolução/grafo (RFC-012)"
	@echo "  make resolution-logs acompanha os logs do risco de resolução"
	@echo "  make resolution-down encerra o risco de resolução"
	@echo "  make server-up      sobe o Ganso Market standalone na porta 80"
	@echo "  make server-health  verifica frontend, API, banco e engine"
	@echo "  make server-status  mostra o estado dos containers"
	@echo "  make server-logs    acompanha os logs do runtime"
	@echo "  make server-update  reconstrói e atualiza o runtime"
	@echo "  make server-down    encerra o runtime sem apagar o banco"

doctor:
	@./scripts/check_toolchains.sh

install: doctor
	npm ci
	cargo fetch --locked
	$(PYTHON) -m venv $(VENV)
	$(VENV)/bin/pip install --disable-pip-version-check -r requirements-dev.txt

init-secrets:
	@$(PYTHON) scripts/init_dev_secrets.py

format:
	npm run format
	cargo fmt --all
	$(RUFF) format workers scripts deploy

format-check:
	npm run format:check
	cargo fmt --all --check
	$(RUFF) format --check workers scripts deploy

lint:
	npm run lint
	cargo clippy --workspace --all-targets --all-features --locked -- -D warnings
	$(RUFF) check workers scripts deploy
	@for file in deploy/*.sh infra/migrations/*.sh scripts/*.sh; do sh -n "$$file"; done

test:
	npm test
	cargo test --workspace --all-targets --locked
	$(PYTHON) -m unittest discover -s workers/model-worker/tests -v
	$(PYTHON) -m unittest discover -s scripts/tests -v

build:
	npm run build
	cargo build --workspace --locked
	$(PYTHON) -m compileall -q workers/model-worker/src scripts deploy

contracts-check:
	npm run test --workspace @ganso-market/contracts

licenses:
	$(PYTHON) scripts/generate_license_report.py --output docs/dependency-licenses.json

compose-config: init-secrets
	docker compose config --quiet
	$(PYTHON) scripts/check_compose_policy.py

secret-scan:
	$(PYTHON) scripts/scan_secrets.py

verify: format-check lint test build secret-scan compose-config

up: init-secrets
	docker compose up --build --detach

migrate: init-secrets
	docker compose run --rm migrate

integration: init-secrets
	./scripts/compose_smoke.sh

resource-check:
	$(PYTHON) scripts/check_compose_policy.py
	$(PYTHON) scripts/check_runtime_memory.py

down:
	docker compose --profile model --profile polymarket down --remove-orphans

recorder-up: init-secrets
	docker compose --profile polymarket up --build --detach polymarket-recorder

recorder-logs:
	docker compose --profile polymarket logs --follow --tail 100 polymarket-recorder

recorder-down:
	docker compose --profile polymarket rm --stop --force polymarket-recorder

estimator-up: init-secrets
	docker compose --profile polymarket up --build --detach polymarket-estimator

estimator-logs:
	docker compose --profile polymarket logs --follow --tail 100 polymarket-estimator

estimator-down:
	docker compose --profile polymarket rm --stop --force polymarket-estimator

paper-up: init-secrets
	docker compose --profile polymarket up --build --detach polymarket-paper

paper-logs:
	docker compose --profile polymarket logs --follow --tail 100 polymarket-paper

paper-down:
	docker compose --profile polymarket rm --stop --force polymarket-paper

resolution-up: init-secrets
	docker compose --profile polymarket up --build --detach polymarket-resolution

resolution-logs:
	docker compose --profile polymarket logs --follow --tail 100 polymarket-resolution

resolution-down:
	docker compose --profile polymarket rm --stop --force polymarket-resolution

server-init:
	@if [ ! -f "$(SERVER_ENV)" ]; then \
		cp deploy/server.env.example "$(SERVER_ENV)"; \
		echo "configuração criada em $(SERVER_ENV)"; \
	fi
	@$(PYTHON) scripts/init_dev_secrets.py

server-config: server-init
	@$(SERVER_COMPOSE) config --quiet

server-up: server-config
	$(SERVER_COMPOSE) up --build --detach --remove-orphans --wait --wait-timeout 180
	@SERVER_ENV="$(SERVER_ENV)" ./deploy/healthcheck.sh

server-health:
	@SERVER_ENV="$(SERVER_ENV)" ./deploy/healthcheck.sh

server-status:
	@$(SERVER_COMPOSE) ps

server-logs:
	$(SERVER_COMPOSE) logs --follow --tail 100

server-update: server-config
	$(SERVER_COMPOSE) pull --ignore-buildable
	$(SERVER_COMPOSE) build --pull
	$(SERVER_COMPOSE) up --detach --force-recreate --remove-orphans --wait --wait-timeout 180
	@SERVER_ENV="$(SERVER_ENV)" ./deploy/healthcheck.sh

server-down:
	$(SERVER_COMPOSE) --profile model down --remove-orphans
