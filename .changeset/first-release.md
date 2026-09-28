---
"@sturdle/engine": minor
"@sturdle/postgres": minor
"@sturdle/ui": minor
---

First public release.

- `@sturdle/engine`: the job engine — queues, workers, retries with exponential backoff,
  memoized `step.run`, `step.sleep` / `step.sleepUntil`, `step.sendEvent`, cron with a
  distributed lock, global and keyed concurrency limits, dead letter, the `onEvent` telemetry
  hook and an in-memory adapter for tests.
- `@sturdle/postgres`: the Postgres storage adapter on the raw `pg` driver, with a dedicated
  schema (`sturdle` by default) and self-applying versioned migrations.
- `@sturdle/ui`: the console design tokens (`styles/tokens.css`) and the presentational
  dashboard components.
