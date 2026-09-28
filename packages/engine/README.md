# @sturdle/engine

A durable background-job engine: queues, workers, retries with exponential backoff, durable
steps (memoized `step.run`), suspend/resume (`step.sleep`/`step.sleepUntil`), cron scheduling
with a distributed lock, keyed concurrency limits, and a dead letter queue — all storage-agnostic
behind a small `DatabaseAdapter` interface.

This package has no dependency on any specific host, ORM, or vendor SDK. It ships an
in-memory `DatabaseAdapter` for tests; a production-grade Postgres adapter lives in the sibling
`@sturdle/postgres` package.

## Usage

```ts
import { Engine, InMemoryAdapter, JobRegistry } from "@sturdle/engine";

JobRegistry.register({
  name: "Send welcome email",
  event: "email/send",
  func: async (ctx) => {
    await ctx.step.run("send", async () => {
      // ...
    });
  },
});

const engine = new Engine({ databaseAdapter: new InMemoryAdapter() });
await engine.start();
await engine.addJob("email/send", { to: "user@example.com" });
```

## Telemetry

The engine never talks to an error tracker or vendor SDK directly. Pass `onEvent` to `Engine`
(threaded down to the dispatcher and its workers) to observe engine-level events —
`job.error`, `job.dropped`, `job.dead-lettered`, `job.assignment-error`, `hook.error`,
`engine.error` — and forward them to whatever observability stack the host application uses. A
throwing listener is logged and never propagates.

```ts
const engine = new Engine({
  databaseAdapter,
  onEvent: (event) => {
    if (event.type === "job.dead-lettered") {
      // report to your error tracker of choice
    }
  },
});
```

## Adapters

See `src/database/README.md` for the `DatabaseAdapter` contract and how to implement one.
