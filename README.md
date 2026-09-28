# Sturdle

Durable background jobs, crons and step functions for TypeScript, running on the Postgres you
already have. Jobs, steps and logs live in a schema of your own database; workers run in your
own process; there is nothing to provision, no migration command and no dashboard to host
somewhere else. The engine, the Postgres adapter and the console components are MIT. Flow
control and retry-aware alerts will be [Sturdle Pro](docs/pro.md), a flat licence per
organisation — planned, not built.

## Install

```bash
npm i @sturdle/engine @sturdle/postgres
```

Node 20 or newer; Postgres 16 is what CI tests against. `pg` comes with the adapter.

## Quickstart

```ts
import { Engine, JobRegistry } from "@sturdle/engine";
import { PostgresAdapter } from "@sturdle/postgres";

// 1. Register a job. `event` is the code you enqueue with.
JobRegistry.register<{ to: string }>({
  name: "Send welcome email",
  event: "email/send",
  func: async (ctx) => {
    // Each step is persisted when it completes: on a retry, completed steps
    // replay their stored result instead of running again.
    const messageId = await ctx.step.run("send", () => mailer.send(ctx.event.data.to));

    // Sleeping frees the worker: the job is parked in Postgres and resumed later.
    await ctx.step.sleep("wait a day", 24 * 60 * 60 * 1000);
    // await ctx.step.sleepUntil("monday", nextMonday);

    await ctx.step.run("follow-up", () => mailer.followUp(ctx.event.data.to, messageId));

    // Spawn another job from inside this one, recorded as a step.
    await ctx.step.sendEvent("notify", { name: "crm/contacted", data: { to: ctx.event.data.to } });

    return { messageId };
  },
});

// 2. Start the engine: connects, applies the migrations, starts the workers.
const engine = new Engine({
  databaseAdapter: new PostgresAdapter({ connectionString: process.env.DATABASE_URL }),
});
await engine.start();

// 3. Enqueue.
const jobId = await engine.addJob("email/send", { to: "someone@example.com" });
```

Everything the definition accepts: `cron` (`"0 9 * * MON"` or `"TZ=Europe/Rome 0 9 * * MON"`),
`queue`, `concurrency` (`5`, or `{ limit: 1, key: "orderId" }` to limit per payload value),
`payloadSchema` (a zod schema, validated before the first attempt), `onDeadLetter`. Enqueue
options: `delayUntil`, `priority`, `maxAttempts` (default 3, exponential backoff between
attempts). Pass `onEvent` to `Engine` to forward `job.error`, `job.dead-lettered` and the other
engine events to your own observability stack — the engine never imports a vendor SDK.

Read [`docs/guarantees.md`](docs/guarantees.md) before you rely on it in production: it says
what at-least-once means for your handlers, how a job is claimed, what happens when a process
dies, and what is not there yet (no automatic cleanup, no serverless worker).

## Packages

| Package                                  | What it is                                                                                                                                                                                                         |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`@sturdle/engine`](packages/engine)     | The job engine: queues, workers, retries with backoff, memoized steps, sleep, cron with a distributed lock, keyed concurrency, dead letter, telemetry hook. Storage-agnostic, ships an in-memory adapter for tests |
| [`@sturdle/postgres`](packages/postgres) | The Postgres storage adapter on the raw `pg` driver: a dedicated schema (`sturdle` by default), self-applying versioned migrations, safe under concurrent boots                                                    |
| [`@sturdle/ui`](packages/ui)             | The console's design tokens and presentational React components (timeline per attempt, steps, logs, fleet table, activity chart) and the turtle mark                                                               |
| [`examples/nextjs`](examples/nextjs)     | A Next.js app with one job, an enqueue route and the worker started from `instrumentation.ts`, with the time to the first job measured                                                                             |

## Free and Pro

Sturdle is open core. This repository is the free half and stays MIT; Sturdle Pro is a set of
features built on top of it, sold as a flat licence per organisation — never per step. None of
it exists yet, and none of its code will ever live in this repository. Details, prices and the
licence model: [`docs/pro.md`](docs/pro.md) and <https://sturdle.dev/pro>.

| Free (MIT)                                                                                       | Sturdle Pro (planned)                                                                                          |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Queues, workers, heartbeat, recovery of stale jobs                                               | —                                                                                                              |
| Retries with exponential backoff, dead letter                                                    | —                                                                                                              |
| Memoized `step.run`, `step.sleep` / `step.sleepUntil`                                            | —                                                                                                              |
| Cron with a distributed lock                                                                     | —                                                                                                              |
| Global concurrency per task, concurrency per payload key, priority queues                        | —                                                                                                              |
| Installable console (per-attempt timeline, table, chart) — components today, application planned | —                                                                                                              |
| Telemetry hook `onEvent`                                                                         | —                                                                                                              |
| —                                                                                                | **Windowed rate limits and throttling distributed across workers**, per task and per key — planned             |
| —                                                                                                | **Debounce, batch, fan-out and workflows** — planned                                                           |
| —                                                                                                | **Retry-aware alerts** (Slack, email, webhook; thresholds on attempts and dead letters) — planned, to validate |
| —                                                                                                | Payload encryption — planned                                                                                   |
| —                                                                                                | Email support during business hours — planned                                                                  |
| —                                                                                                | Enterprise: on-prem console with SSO/RBAC, EU data-processing agreement, SLA — planned                         |

## Development

```bash
corepack enable                 # pnpm 11, pinned by packageManager
pnpm install
pnpm check                      # lint, boundaries, format, typecheck, unit tests
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/sturdle_test pnpm test
pnpm build                      # ESM + .d.ts into each package's dist/
bash scripts/consumer-check.sh  # pack, install with npm into an empty project, run one job
pnpm --filter example-nextjs build
```

Integration tests need `TEST_DATABASE_URL` pointing at a database they may create schemas in;
without it they skip. Inside the workspace, packages resolve each other through the
`sturdle-source` export condition (`tsconfig.base.json` → `customConditions`), so typecheck and
tests run from the TypeScript sources and never need a prior build; every real consumer,
including the example's `next build`, resolves `dist/`.

Boundaries (`.dependency-cruiser.cjs`): `@sturdle/engine` imports no workspace package,
`@sturdle/postgres` imports only `@sturdle/engine`, `@sturdle/ui` imports neither. Commit
messages are `<type>(<scope>): <summary>` with `new | enh | fix | chore`, checked by commitlint.
Agents working here read `AGENTS.md`.

## Releasing

Versions are managed with [changesets](https://github.com/changesets/changesets). Every change
that should reach npm carries one (`pnpm changeset`). On push to `master`, the release workflow
(`.github/workflows/release.yml`) opens a "Version Packages" pull request from the pending
changesets; merging that PR publishes every package whose version is not on npm yet, with
provenance (`NPM_CONFIG_PROVENANCE=true`; `id-token: write`).

**One-time setup, by the owner** (the npm organisation `sturdle` already exists and owns the
`@sturdle` scope):

1. Create a granular npm access token with publish rights on `@sturdle/*` (2FA "authorization
   only" or bypass for automation), and add it to the GitHub repository as the secret
   `NPM_TOKEN`. Alternatively configure [trusted publishing](https://docs.npmjs.com/trusted-publishers)
   on each package once it exists on npm and drop the token: the workflow already requests the
   OIDC token.
2. In the repository settings, allow GitHub Actions to create pull requests
   (_Actions → General → Workflow permissions → "Allow GitHub Actions to create and approve pull
   requests"_), otherwise the changesets action cannot open the version PR.

**Prerelease** (`0.1.0-next.n`, published under the `next` dist-tag, for the website to consume
before the first stable):

```bash
pnpm changeset pre enter next   # commits .changeset/pre.json
pnpm changeset version          # 0.1.0-next.0, then -next.1, ... on each run
pnpm build && pnpm release      # or let the release workflow do it from master
pnpm changeset pre exit         # when 0.1.0 is ready
```

`@sturdle/postgres` depends on `@sturdle/engine` as `workspace:^`, which pnpm rewrites to the
real range (`^0.1.0`) at publish time.

**Supported Node versions.** The packages declare `engines.node >= 20`. The sources were
grepped for APIs newer than Node 20 (`Promise.withResolvers`, `Array.fromAsync`, the `Set`
algebra methods, `Object.groupBy`, `import.meta.dirname`, …) and use none; the newest thing they
rely on is `String.prototype.replaceAll` and `crypto.randomUUID`, both in Node 20. CI runs on
Node 24 (`.nvmrc`), which is what development requires (`engines` at the root); the floor for
consumers is 20 until a test on 20 says otherwise.

## Licence

MIT — see [`LICENSE`](LICENSE). Copyright (c) 2026 Daniele Di Bernardo.
