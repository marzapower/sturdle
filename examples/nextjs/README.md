# Sturdle in a Next.js app

A minimal Next.js (App Router) app that registers one job, enqueues it from a route handler and
runs it with a worker started inside the Next.js server process. **This needs a long-running
Node process**: the worker polls Postgres for as long as `next dev` / `next start` is up, and
nothing runs when it is down. Platforms without a persistent process (serverless functions,
edge runtimes) are covered in [`docs/guarantees.md`](../../docs/guarantees.md) — today they can
enqueue, but cannot run workers.

What is in here:

| File                       | Role                                                                                   |
| -------------------------- | -------------------------------------------------------------------------------------- |
| `jobs/email-send.ts`       | The job `email/send`, registered with `JobRegistry.register`, two `ctx.step.run` steps |
| `lib/engine.ts`            | `Engine` + `PostgresAdapter` from `DATABASE_URL`, one instance per process             |
| `instrumentation.ts`       | Starts the worker once when the server boots (Node runtime only)                       |
| `app/api/enqueue/route.ts` | `POST /api/enqueue` → `engine.addJob("email/send", …)`                                 |
| `docker-compose.yml`       | A Postgres 16 for the example                                                          |

## Steps

Measured from the root of a clone of this repository.

1. Start Postgres:

   ```bash
   cd examples/nextjs
   docker compose up -d --wait
   ```

   If port 5432 is taken on your machine: `DB_PORT=5439 docker compose up -d --wait`, and use
   that port in step 2.

2. Configure the connection:

   ```bash
   cp .env.example .env     # DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/sturdle_example
   ```

3. Install and build the workspace packages the example depends on (from the repository root):

   ```bash
   cd ../..
   corepack enable
   pnpm install
   pnpm build
   ```

4. Start the app. The worker starts with it and applies the engine's migrations on first boot:

   ```bash
   pnpm --filter example-nextjs dev
   ```

   The log shows `[sturdle] engine started`.

5. Enqueue a job:

   ```bash
   curl -X POST http://localhost:3000/api/enqueue \
     -H 'content-type: application/json' \
     -d '{"to":"someone@example.com","subject":"Hello"}'
   ```

   The response carries the job id; the server log shows the two steps running
   (`[email/send] sending …`, `[email/send] recorded …`). The job's row, steps and logs are in
   the `sturdle` schema of `sturdle_example`.

**Measured: first job in 20 seconds on 2026-09-28** — wall clock from `docker compose up` to the
job's last step logged, the five steps above run back to back by a script on a macOS laptop with
the Postgres image already pulled and the pnpm store warm (`pnpm install` took 1 s). A person
following the steps at reading pace, with a cold pnpm store and the image to pull, will take
longer; that time has not been measured by hand yet.

## Why the worker lives in `instrumentation.ts`

Next.js calls `register()` once per server process, on the Node runtime, before it serves a
request. That is exactly one worker per process, started before the first `POST /api/enqueue`
can arrive, with no second process to deploy. The guard in `lib/engine.ts` (`globalThis`) keeps
a single engine when Next.js re-evaluates modules in development.

The trade-off: the worker shares the process, the event loop and the connection pool with your
HTTP handlers. For heavier jobs, run the same `getEngine()` from a separate Node entry point
(`node --import ./worker.js`) and drop `instrumentation.ts`; nothing else changes.

## Adapting it

- Copy `jobs/`, `lib/engine.ts` and `instrumentation.ts` into your app, and install the
  packages from npm: `npm i @sturdle/engine @sturdle/postgres pg`.
- Keep `serverExternalPackages` in `next.config.ts`: the adapter reads its SQL migrations from
  disk and holds a `pg` pool, neither of which belongs in a bundle.
