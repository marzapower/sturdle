# Guarantees and limits

What Sturdle promises, what it does not, and where each promise lives in the code. Every
statement below was checked against the sources at the time of writing; the file in
parentheses is where to look when you want to check again. Constants are quoted as they are in
the code, not rounded. There are no benchmarks and no comparisons on this page: where a number
would need a measurement we did not make, it says so.

Versions: `@sturdle/engine` 0.1.0, `@sturdle/postgres` 0.1.0.

## Delivery semantics: at least once

A job runs **at least once**. It can run more than once: after a crash mid-execution, after a
retry, or after a lease expires while the handler is still running (see "When the process
dies"). Nothing in the engine deduplicates executions, so **handlers must be idempotent**, or
must put their side effects inside `step.run` so that a re-execution replays the recorded result
instead of repeating the effect (see "Memoized steps").

Two things reduce duplicates but do not eliminate them:

- A job is claimed inside one Postgres transaction with `FOR UPDATE ... SKIP LOCKED`, so two
  live workers never take the same job at the same time
  (`packages/postgres/src/adapter.ts`, `dequeueJob`).
- A running job renews a lease with a heartbeat; only a job whose lease is stale is given back
  to the queue (`packages/engine/src/engine/dispatcher.ts`, `createJobHandler`;
  `packages/postgres/src/adapter.ts`, `releaseStaleJobs`).

Exactly-once execution is not offered and is not planned.

## How a job is claimed

Sturdle polls. There is no `LISTEN/NOTIFY`, no push from the database.

- The dispatcher runs a cycle every **50 ms** (`Dispatcher.jobQueueInterval`,
  `packages/engine/src/engine/dispatcher.ts`). When it has a free worker and nothing buffered
  in memory, it asks each registered queue, in priority order, for one job
  (`Dispatcher.fetchNewJobs` → `Queue.getNextJob` → `adapter.dequeueJob`).
- `dequeueJob` is one transaction (`packages/postgres/src/adapter.ts`): a transaction-scoped
  advisory lock per queue (`pg_advisory_xact_lock(hashtext('sturdle:dequeue:<schema>:<queue>'))`),
  then `SELECT ... FROM job_streams ... ORDER BY timestamp ASC FOR UPDATE OF s SKIP LOCKED LIMIT 1`
  joined with the concurrency-key check, then `UPDATE jobs SET status = 'processing',
started_at = now(), updated_at = now(), attempts = attempts + 1`, then the stream row is
  tagged with the consumer name. The attempt counter is incremented **at claim time**, so a
  crash after the claim counts as a failed attempt.
- A queue stops asking when it already has `concurrency` jobs running in this process
  (`packages/engine/src/engine/queue.ts`, `getNextJob`). The default queue is `default`
  with `concurrency: 3` (`packages/engine/src/engine/shared.ts`, `defaultQueues`); the engine
  has `maxWorkers: 10` by default (`packages/engine/src/engine/engine.ts`).

**Latency between enqueue and execution.** By construction, an idle engine with a free worker
notices a new job on its next 50 ms tick, plus the time of one `dequeueJob` transaction. In the
consumer check that runs in CI (`scripts/consumer-check.sh`: one job, one process, two workers,
Postgres on the same machine) the job went from `createdAt` to `completedAt` in **62 ms** on
2026-09-28, handler included. That is one measurement on a laptop, not a service level; it is
here so the mechanism has a number next to it. Under load, latency is bounded by the number of
free workers and by Postgres, not by the tick.

## Heartbeat and stale recovery

- While a handler runs, the engine renews the job's lease every **30 s**
  (`Dispatcher.heartbeatIntervalMs = 30_000`, `packages/engine/src/engine/dispatcher.ts`). The
  renewal is `UPDATE jobs SET updated_at = now() WHERE id = $1 AND status = 'processing'`
  (`packages/postgres/src/adapter.ts`, `heartbeatJob`). A heartbeat that fails is swallowed
  (`.catch(noop)`); the job keeps running.
- A job is **stale** when it is `processing` and its `updated_at` is older than
  `staleJobsDeadlineMs`, **5 minutes** by default
  (`Engine.defaultStaleJobsDeadlineMs = 5 * 60 * 1000`, `packages/engine/src/engine/engine.ts`;
  configurable through `EngineOptions.staleJobsDeadlineMs`).
- Stale jobs are looked for at engine start and then every `staleJobsDeadlineMs`
  (`Engine.startPeriodicStaleJobsCleanup`). So a job orphaned by a dead process is picked up
  again between **5 and 10 minutes** after its last heartbeat, and only if some engine
  instance is alive to run the sweep.
- What the sweep does (`releaseStaleJobs`, `packages/postgres/src/adapter.ts`): if
  `attempts < max_attempts`, the job goes back to `pending` and its stream row is released for
  any worker to claim; otherwise it is marked `failed` with the error
  `"Job stale - max attempts reached"`. This second path does **not** run the job's
  `onDeadLetter` hook and does **not** emit a `job.dead-lettered` telemetry event; it is
  visible only in the job row and in the engine log.

A handler that legitimately runs longer than the deadline is safe as long as its process keeps
heartbeating; the deadline measures silence, not duration.

## When the process dies

- A job that was **claimed but not finished** stays `processing` with a stale `updated_at`
  until the sweep above releases it. Its steps that completed before the crash are replayed on
  the next execution; the step that was running when the process died is re-executed from
  scratch (see "Memoized steps").
- On a **graceful shutdown** (`engine.gracefullyShutdown()`), each worker waits up to **10 s**
  for its current job, then up to **5 s** more for the job promise to settle, then gives up
  (`packages/engine/src/engine/worker.ts`, `shutdown`). A job that outlives that window is left
  `processing` and recovered as stale, like a crash.
- Nothing is lost at **enqueue** time: `addJob` resolves only after the row is written. If the
  process dies between the `jobs` insert and the `job_streams` insert (two separate statements,
  see next section), the job row exists with status `pending` but is never claimed — there is
  no repair for this case today.

## Enqueue is not transactional with your data

`engine.addJob()` runs its own statements on the adapter's pool: an `INSERT INTO jobs` followed
by an `INSERT INTO job_streams` (or `delayed_jobs`), each with `pool.query`, **outside any
transaction** (`packages/postgres/src/adapter.ts`, `enqueueJob`). Even when you construct
`PostgresAdapter` with your own `pg.Pool`, the adapter checks out its own client for these
writes; there is no way to pass the client of a transaction you have open. So:

- If your transaction rolls back after `addJob` resolved, the job still runs.
- If your process dies after your commit and before `addJob`, the job never exists.

If you need "job exists iff my row was committed", write an outbox row in your own transaction
and enqueue from it. A transactional enqueue API is not offered today.

## Connection poolers in transaction mode

From `packages/postgres/README.md`, verified in `packages/postgres/src/migrate.ts` and
`packages/postgres/src/adapter.ts`:

- `migrate()` holds a **session-level** advisory lock (`pg_advisory_lock`) on one client for the
  whole run. Under a transaction-pooling proxy (PgBouncer in `transaction` mode, some managed
  poolers) a session lock can outlive the logical connection or be silently dropped. Run
  migrations against a direct or session-mode connection, once, out of band, instead of letting
  `connect()` do it on every boot.
- `dequeueJob` uses a **transaction-scoped** advisory lock (`pg_advisory_xact_lock`) inside a
  `BEGIN … COMMIT` on a single checked-out client, which is safe under transaction pooling.
- The heartbeat, the stale sweep, and every other write are single statements or single
  transactions and are safe under transaction pooling.

## Load on Postgres and table growth

Per engine instance, when idle (one queue, no jobs):

- every **50 ms**: one `dequeueJob` transaction per registered queue with a free slot — that is
  `BEGIN`, the advisory lock, the `SELECT … SKIP LOCKED`, `COMMIT`, so roughly 20 short
  transactions per second per queue (`packages/engine/src/engine/dispatcher.ts`, `runCycle`);
- every **1 s**: one `SELECT` on `delayed_jobs` per queue looking for due jobs
  (`packages/engine/src/engine/asyncScheduler.ts`, `cycleIntervalMs = 1000`);
- every **1 s**: the cron scheduler evaluates the registered cron expressions in memory and
  touches the database only when one is due (`packages/engine/src/engine/cronScheduler.ts`);
- every **5 min** (or your `staleJobsDeadlineMs`): the stale sweep, one `SELECT` per queue plus
  one `DELETE` of expired locks (`packages/engine/src/engine/engine.ts`, `cleanupStaleJobs`).

Per job executed: the claim transaction, one `UPDATE` to `processing`, one `INSERT … ON CONFLICT`
of `job_metadata.steps` at each step start and each step end, the heartbeat every 30 s, the
final `UPDATE` to `completed`/`failed`, and one save of the attempt's logs when it ends
(`packages/engine/src/engine/dispatcher.ts`, the `finally` of `createJobHandler`; logs are not
written while the job runs). Steps and logs are stored
as **whole JSONB arrays rewritten on every save** (`saveJobSteps`, `saveJobLogs`,
`packages/postgres/src/adapter.ts`), so a job with many steps or many log lines costs more per
write as it goes.

**There is no automatic cleanup.** Completed and failed jobs, their `job_metadata` (steps and
logs) and their acknowledged `job_streams` rows stay forever. The only deletions the adapter
performs are `deleteJob(id)` when you call it (cascades to streams, delayed entries and
metadata through the foreign keys), the claim of a delayed job (its `delayed_jobs` row), and
expired `distributed_locks` (`cleanupExpiredLocks`). Retention is your job: a periodic
`DELETE FROM "sturdle".jobs WHERE status IN ('completed','failed') AND completed_at < …` — the
cascades do the rest — or a cron job of your own calling `adapter.deleteJob`. Indexes exist on
`queue_name`, `status`, `scheduled_at`, `delay_until`, `created_at`, `(code, created_at)` and
`(concurrency_key, status)` (`packages/postgres/src/migrations/0001_init.sql`).

## No serverless worker today

The engine is a long-running process: timers, a worker pool, and a polling loop
(`packages/engine/src/engine/shared.ts`, `Stoppable.startCycle`). It runs in-process with your
Node server, or as a separate Node process, and it must stay up for jobs to run. There is no
mode where a platform without a persistent process (serverless functions, edge runtimes) can
execute jobs, and no "tick" endpoint you could call from an external scheduler. That mode is
planned, unscheduled. Until it exists, a platform without a long-running Node process cannot
run Sturdle workers; enqueuing from such a platform works (it is a database write) as long as a
worker runs somewhere else.

## Cron

- Every second, each registered cron job's next occurrence is computed from the process clock
  with `cron-parser` (UTC unless the expression starts with `TZ=<zone> `;
  `packages/engine/src/engine/utils.ts`). If that occurrence falls **within the next second**,
  the scheduler tries to take a lock named `cron:<code>:<unix-second>` with a TTL of **120 s**
  in the `distributed_locks` table; whoever gets it enqueues the job, the others skip
  (`packages/engine/src/engine/cronScheduler.ts`; `acquireLock` in
  `packages/postgres/src/adapter.ts` is a single `INSERT … ON CONFLICT DO UPDATE … WHERE expired`).
- So with several instances, **one instance fires** per occurrence, as long as their clocks
  agree to within the lock TTL. Clock drift larger than about two minutes between instances can
  produce a second firing of the same occurrence; drift smaller than that cannot, because the
  lock key is the occurrence's own second, not the local time.
- A cron job may be enqueued up to **one second early** (the "within the next second" window)
  and then waits for a free worker like any job.
- **Missed occurrences are not replayed.** If no instance is running at the time, the next
  computation starts from "now" and the missed run is skipped. There is no catch-up.
- A cron job's payload is always `{}` (`packages/engine/src/engine/dispatcher.ts`,
  `setupEvents`, `JobScheduled`). A `payloadSchema` on a cron definition would validate that
  empty object on every run; leave it out.

## Payload and log size

- The payload is stored as `JSONB` in `jobs.payload` (`0001_init.sql`). The engine imposes **no
  size limit** of its own; Postgres will reject a `jsonb` value above its TOAST limit (in
  practice hundreds of megabytes), and long before that every claim, every status update and
  every console read pays for the payload size. Keep payloads small and put big data in your own
  tables, referenced by id.
- The payload must be a JSON object (`Payload = Record<string, unknown>`,
  `packages/engine/src/types.ts`). If the job declares a `payloadSchema` (zod), the payload is
  validated before the first attempt; an invalid payload is dead-lettered immediately, without
  retries (`packages/engine/src/engine/worker.ts`, `executeJobAsync`).
- Step results are `JSON.parse(JSON.stringify(result))`; a value that does not survive that
  round trip (functions, cyclic structures) is stored as `"[<typeof>]"` and replayed as such
  (`packages/engine/src/engine/dispatcher.ts`, `step.run`). Logs written through `ctx.logger`
  and the engine's own lines for the job are buffered in memory for the whole attempt and saved
  as one JSONB array when the attempt ends (`packages/engine/src/logger.ts`, `JobLogger`);
  there is **no cap** on their number or length, and they are not visible until that save. A
  handler that logs in a tight loop grows `job_metadata.logs` without bound and its own memory
  with it.

## Memoized steps and replay

- `ctx.step.run(name, fn)` runs `fn`, then writes the step with its result to
  `job_metadata.steps` and **awaits that write** before returning; only after the write is
  durable does the step count as done (`packages/engine/src/engine/dispatcher.ts`, `step.run`).
- On a later execution of the same job (retry, resume after `sleep`, recovery after a crash),
  the handler runs from the top again; each `step.run` whose key already has a `completed`
  record returns the stored result without calling `fn`. Steps recorded as `running` (the
  process died inside them) or `failed` are executed again.
- Step keys are the name plus an occurrence counter (`send`, `send:2`, `send:3` …), so the same
  name can be used in a loop, **as long as the sequence of step calls is deterministic**. Code
  before or between steps re-runs on every execution; branching on time, randomness or external
  state changes which step keys are produced and breaks the replay.
- A replayed step is recorded as a zero-duration trace pointing at the attempt that really ran
  it (`replayedFrom`), which is what the console timeline shows.
- Anything outside a `step.run` is not memoized. An email sent directly in the handler body is
  sent again on every retry.

## Retries and dead letter

- Default `maxAttempts` is **3**, settable per enqueue (`engine.addJob(code, payload,
{ maxAttempts })`; `packages/engine/src/engine/queue.ts`, `enqueueJob`).
- After a failed attempt the job is delayed by `min(1000 ms × 2^(attempt−1) + jitter, 5 min)`
  with jitter uniform in `[0, 1000 ms)` (`calculateExponentialBackoff`,
  `packages/engine/src/engine/dispatcher.ts`): about 1 s, 2 s, 4 s, 8 s … capped at 5 minutes.
- An error whose `name` is `"NonRetriableError"` is dead-lettered on the spot; so is a job whose
  code has no handler registered on the instance that claimed it, and a job whose payload fails
  its schema.
- Dead letter is a **status** (`failed`) plus `metadata.deadLetter = { at, reason }` and the
  attempt history on the same row, not a separate table. The `onDeadLetter` hook of the job
  definition runs once, and the `onEvent` hook receives `job.dead-lettered`. Re-running a
  dead-lettered job is a manual enqueue of a new job.

## Sleep granularity

- `step.sleep(name, ms)` and `step.sleepUntil(name, date)` do not block a worker: they record
  the step, move the job to `delayed` with `delay_until`, and unwind the handler
  (`JobSuspended`, `packages/engine/src/engine/dispatcher.ts`). The attempt counter is not
  incremented by a suspension (`suspendJob`, `packages/postgres/src/adapter.ts`).
- Due delayed jobs are moved back to the queue by a scanner that runs every **1 s**
  (`packages/engine/src/engine/asyncScheduler.ts`), then claimed on the next 50 ms tick. A
  sleep therefore wakes **between 0 and about 1 s late**, plus queueing time if no worker is
  free. Sleeps shorter than a second are not meaningful; `ms <= 0` and a past `date` return
  immediately without suspending.
- `delay_until` is a `timestamptz(3)`; the wake time is compared against the **database
  clock** (`execute_at <= now()` in `getReadyDelayedJobs`), so instances with different clocks
  agree on when a job is due.
- The same 1 s scan applies to `addJob(..., { delayUntil })` and to retry backoff.

## Concurrency limits

- A global limit per task (`concurrency: 5`) or a limit per payload key (`concurrency: { limit:
1, key: "orderId" }`) is enforced **at claim time, in the database**, across every instance:
  the candidate query counts the other jobs holding the same `concurrency_key` that have started
  and are not terminal (`packages/postgres/src/adapter.ts`, `dequeueJob`;
  `packages/engine/src/engine/concurrency.ts`). The per-queue advisory lock makes that count
  read-consistent between concurrent claims.
- A job left `processing` by a dead process keeps holding its key until the stale sweep
  releases it — up to the 5–10 minutes above. Keyed limits are therefore "at most N running,
  or N minus the orphans, until recovery".
- Queue `concurrency` (how many jobs of that queue one instance runs at once) is per process,
  not global; run two instances and you get twice that.

## What this page does not say

It gives no throughput figure, no p99 and no comparison with other systems, because none was
measured on published code. When a measurement exists it will be added here with the date, the
hardware and the command that produced it.
