SHELL := /bin/sh
.DEFAULT_GOAL := help

PYTHON ?= python3
VENV := .venv
RUFF := $(VENV)/bin/ruff

.PHONY: help doctor install init-secrets format format-check lint test build verify \
	contracts-check compose-config licenses up migrate integration resource-check secret-scan down

help:
	@echo "Ganso Market RFC-001"
	@echo "  make doctor         verifica toolchains"
	@echo "  make install        instala dependencias locais fixadas"
	@echo "  make verify         format-check, lint, testes, build, scan e Compose config"
	@echo "  make up             sobe o runtime local em 127.0.0.1"
	@echo "  make integration    testa Compose, readiness e shutdown"
	@echo "  make down           encerra sem apagar volumes"

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
	$(RUFF) format workers scripts

format-check:
	npm run format:check
	cargo fmt --all --check
	$(RUFF) format --check workers scripts

lint:
	npm run lint
	cargo clippy --workspace --all-targets --all-features --locked -- -D warnings
	$(RUFF) check workers scripts

test:
	npm test
	cargo test --workspace --all-targets --locked
	$(PYTHON) -m unittest discover -s workers/model-worker/tests -v
	$(PYTHON) -m unittest discover -s scripts/tests -v

build:
	npm run build
	cargo build --workspace --locked
	$(PYTHON) -m compileall -q workers/model-worker/src scripts

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
	docker compose --profile model down --remove-orphans
