PROJECT  := ket
MAIN_PKG := ./cmd/$(PROJECT)

BUILD_DATE   := $(shell date -u '+%Y-%m-%dT%H:%M:%SZ')
BUILD_COMMIT := $(shell git rev-parse --short HEAD 2> /dev/null || echo unknown)
VERSION      := $(or $(IMAGE_TAG),$(shell git describe --tags --first-parent --match "v*" 2> /dev/null || echo v0.0.0))
LDFLAGS      := -X github.com/rakunlabs/ket/internal/config.Version=$(VERSION) -X github.com/rakunlabs/ket/internal/config.Commit=$(BUILD_COMMIT) -X github.com/rakunlabs/ket/internal/config.BuildDate=$(BUILD_DATE)

# Image platform for `make build-container`: linux on this machine's CPU.
GOARCH ?= $(shell go env GOARCH)

.DEFAULT_GOAL := help

.PHONY: install-ui
install-ui: ## Install UI dependencies
	@echo "> Installing UI dependencies"
	@cd _ui && pnpm install --frozen-lockfile

.PHONY: gen
gen: ## Regenerate internal/catalog/catalog.json from the UI command registry
	@cd _ui && pnpm run gen

.PHONY: build-ui
build-ui: install-ui ## Build the UI into internal/server/dist (also regenerates the catalog)
	@echo "> Building UI assets"
	@cd _ui && pnpm run build

.PHONY: build
build: build-ui ## Build the single binary for this machine into bin/ket
	@echo "> Building bin/$(PROJECT) $(VERSION)"
	@CGO_ENABLED=0 go build -trimpath -ldflags="-s -w $(LDFLAGS)" -o bin/$(PROJECT) $(MAIN_PKG)

.PHONY: build-container
build-container: build-ui ## Build the release image for linux/GOARCH with the test tag (ket:test)
	GOOS=linux GOARCH=$(GOARCH) goreleaser build --snapshot --clean --single-target
	docker build --platform=linux/$(GOARCH) --build-arg TARGETPLATFORM=. \
		-t $(PROJECT):test -f ci/Dockerfile dist/$(PROJECT)_linux_$(GOARCH)*/

.PHONY: snapshot
snapshot: build-ui ## Full snapshot release with goreleaser: every archive and the images, nothing published
	goreleaser release --snapshot --clean

.PHONY: run
run: ## Run the backend (reads ket.yaml if present); serves the UI from internal/server/dist, so `make build-ui` needs no restart
	KET_SERVER_UI_DIR=$${KET_SERVER_UI_DIR:-internal/server/dist} go run -ldflags="$(LDFLAGS)" $(MAIN_PKG)

.PHONY: run-ui
run-ui: ## Run the Vite dev server (proxies /api, /ws and /mcp to :8080)
	@cd _ui && pnpm run dev

.PHONY: env
env: ## Start PostgreSQL for development
	docker compose -f env/compose.yaml up -d --wait

.PHONY: env-down
env-down: ## Stop PostgreSQL and drop its data
	docker compose -f env/compose.yaml down -v

.PHONY: test
test: ## Run Go and engine tests (store tests need KET_TEST_DSN)
	@go test -race -count=1 ./...
	@cd _ui && pnpm test

.PHONY: lint
lint: ## Lint Go code, check the release config and type-check the UI
	@golangci-lint run ./...
	@goreleaser check -q
	@cd _ui && pnpm run check

.PHONY: e2e
e2e: build ## Browser tests against bin/ket; empties the database at KET_E2E_DSN (default ket_e2e on the dev PostgreSQL)
	@cd _ui && pnpm exec playwright install chromium && pnpm run e2e

.PHONY: help
help: ## Show this help
	@grep -h -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-16s\033[0m %s\n", $$1, $$2}'
