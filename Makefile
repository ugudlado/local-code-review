.PHONY: build watch type-check test test-watch package install format knip knip-fix clean dev deps

## Deps

node_modules: package.json pnpm-lock.yaml
	pnpm install
	@touch node_modules

deps: node_modules ## Install dependencies if needed (idempotent)

## Core

build: node_modules ## Build extension bundle (installs deps if needed)
	pnpm build

watch: node_modules ## Watch mode for development
	pnpm watch

type-check: node_modules ## TypeScript type checking
	pnpm type-check

test: node_modules ## Run vitest unit tests (pure layer)
	pnpm test

test-watch: node_modules ## Vitest in watch mode
	pnpm test:watch

package: build  ## Package .vsix (builds first)
	pnpm package

install: package ## Build, package, and install into VS Code
	code --install-extension $$(ls -t *.vsix | head -1)

## Quality

format: node_modules ## Format all source files
	pnpm format

knip: node_modules ## Dead code detection
	pnpm knip

knip-fix: node_modules ## Auto-remove safe unused exports
	pnpm knip:fix

## Shortcuts

dev: type-check test build ## Type-check, test, then build
	@echo "Ready"

clean:          ## Remove build artifacts
	rm -rf dist *.vsix

help:           ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?##' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

.DEFAULT_GOAL := help
