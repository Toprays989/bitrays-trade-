# Repository Guidelines

## Project Structure & Module Organization

This repository is a TypeScript React/Vinext trading operations application. UI routes and APIs live under `app/`; client models are in `app/client/` and page components in `app/components/`. Database code is in `db/`, forward-only SQL migrations in `drizzle/`, and domain logic and execution adapters in `lib/`. Tests are under `tests/`, deployment assets and scripts under `deploy/` and `scripts/`, and static assets under `public/`.

## Build, Test, and Development Commands

Use Node.js 22 or newer and the package manager selected by the lockfile.

- `pnpm dev` starts the local Vinext development server.
- `pnpm build` creates the production bundle.
- `pnpm lint` runs ESLint across the application, excluding generated output.
- `pnpm test` runs runtime-name checks, a production build, and the full Node test suite.
- `pnpm test:mainline` runs the focused mainline baseline checks.
- `pnpm db:generate` generates a Drizzle migration after schema changes; review the SQL before applying it.

## Coding Style & Naming Conventions

Use two-space indentation, TypeScript types for API boundaries, and `camelCase` for variables and functions. Use `PascalCase` for React components and exported types, and kebab-case for route directories and migrations. Keep validation in API routes; prefer domain helpers in `lib/` over duplicated exchange or risk logic. Run ESLint on changed files.

## Testing Guidelines

Tests use Node’s built-in runner with `.test.mjs` files. Name tests after the behavior they protect, such as `manual-grid.test.mjs` or `challenge-order-gate.test.mjs`. Add focused coverage for execution gates, idempotency, risk transitions, and PAPER/LIVE isolation. Run `pnpm test` before merging.

## Commit & Pull Request Guidelines

Use short imperative subjects with a conventional prefix, such as `feat: add paper challenge execution` or `fix: reject stale wall handoff`. Keep commits focused. Pull requests should describe behavior, migrations and deployment impact, validation commands, and screenshots for material UI changes. Never include secrets, production database files, or release archives.

## Security & Configuration Tips

Treat LIVE execution as high risk. Preserve server-side permission, account, environment, idempotency, and readiness checks. PAPER execution must use the isolated virtual ledger and public market data without reading live credentials or sending exchange write requests. Keep secrets in the deployment environment, not source files or logs.
