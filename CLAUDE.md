# CLAUDE.md — Sturdle

Sturdle is a durable background-job engine for TypeScript that runs on the Postgres you already
have. This repository is the **public, MIT** half of the project: `@sturdle/engine`,
`@sturdle/postgres`, `@sturdle/ui`, the examples and the technical documentation. The website
lives elsewhere.

Read `README.md`, `docs/guarantees.md` and `docs/pro.md` before changing anything.

## Rules

- **Three packages, one DAG.** `@sturdle/engine` imports no workspace package; `@sturdle/postgres`
  imports only `@sturdle/engine` (and `pg`); `@sturdle/ui` imports no engine code and no adapter.
  Enforced by `.dependency-cruiser.cjs`; `pnpm boundaries` must stay green.
- **Technology neutrality.** No ORM in the engine or its adapter, no platform-specific code
  (hosting, error tracker, vendor SDK) inside the engine. Integrations go through the telemetry
  hook (`onEvent`) or through a `DatabaseAdapter`.
- **Never invent claims.** No made-up customers, benchmarks, numbers or competitor comparisons
  anywhere. Features that do not exist are labelled "planned". A latency figure appears only
  when it was measured on this code, with the date and the setup next to it.
- **Origin-agnostic.** The engine was extracted from an internal tool of another product. Never
  name or describe that product, its domain, its data, its people or its infrastructure —
  not in code, comments, tests, fixtures, docs or commit messages.
- **Nothing that belongs to Sturdle Pro is ever written here.** Not the code, not a plugin
  seam for it, not a stub. What is MIT today stays MIT.
- **Plug-and-play is the success criterion** for everything user-facing: first job in
  production in under 10 minutes, zero new infrastructure, no migration command, no env sync.
- **The console is monochrome by rule** (`packages/ui/styles/tokens.css`): one teal accent,
  colour marks deviation only. Do not add a light palette or a second accent.
- **Language.** Everything in this repository is in English: code, comments, docs, commits.

## Working here

- pnpm 11 via corepack (`packageManager` pins the version): `corepack enable` once, or prefix
  commands with `corepack pnpm`.
- Local Postgres for the integration tests: `TEST_DATABASE_URL` pointing at a dedicated
  database. Without it they skip cleanly.
- Default branch is `master`; work in progress goes on `feature/<name>`.
- **Agents never commit or push.** Wait for an explicit request and follow the requested
  commit organisation. Commit messages are `<type>(<scope>): <summary>` with the type one of
  `new` | `enh` | `fix` | `chore` (map feat/refactor/docs/test onto `enh` or `chore`), enforced
  by commitlint. No AI attribution trailers.
- Every user-visible change to a published package carries a changeset (`pnpm changeset`).

## Definition of done

All green:

```bash
pnpm check                                   # lint, boundaries, format, typecheck, unit tests
TEST_DATABASE_URL=postgres://... pnpm test   # integration tests on a real Postgres
pnpm build
bash scripts/consumer-check.sh               # packed tarballs installed with npm, one job runs
```

Plus, for anything in `examples/`, the example builds (`pnpm --filter example-nextjs build`).
