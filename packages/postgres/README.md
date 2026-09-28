# @sturdle/postgres

A `PostgresAdapter` for `@sturdle/engine`'s `BaseDatabaseAdapter`, built directly on the `pg`
driver — no ORM. It stores jobs, streams, delayed jobs, per-job metadata (logs/steps) and
distributed locks in a dedicated, app-managed Postgres schema, and ships its own SQL migrations.

## Usage

```ts
import { PostgresAdapter } from "@sturdle/postgres";
import { Engine } from "@sturdle/engine";

const adapter = new PostgresAdapter({
  connectionString: process.env.DATABASE_URL,
  // schema: "sturdle", // optional, this is the default
});

const engine = new Engine({ databaseAdapter: adapter });
await engine.start(); // calls adapter.connect() internally, which runs the migrations
```

You can also hand the adapter an existing `pg.Pool` instead of a connection string:

```ts
import { Pool } from "pg";
import { PostgresAdapter } from "@sturdle/postgres";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PostgresAdapter({ pool });
```

When a `pool` is passed in, the adapter never owns it: `disconnect()` leaves it open. When only a
`connectionString` is given, the adapter creates and owns the pool, and `disconnect()` closes it.

## Options

```ts
interface PostgresAdapterOptions {
  pool?: Pool; // reused as-is; disconnect() never closes it
  connectionString?: string; // required when `pool` is absent
  schema?: string; // default "sturdle"; must match /^[a-z_][a-z0-9_]*$/
}
```

The `schema` option lets multiple independent deployments (or a test suite) share one Postgres
database without colliding: every table, enum and advisory-lock key is qualified with it.

## Migrations

`connect()` runs `SELECT 1` and then `migrate()`; you don't normally need to call `migrate()`
yourself. It is safe to call from multiple processes/instances at once — it takes a Postgres
advisory lock (`pg_advisory_lock(hashtext('sturdle:migrate:<schema>'))`) on a dedicated client for
the whole operation, creates the schema and its `schema_migrations` bookkeeping table inside that
lock, then applies each pending migration in its own transaction. A concurrent `migrate()` call
blocks until the first one releases the lock, then finds nothing left to apply.

```ts
const { applied } = await adapter.migrate(); // e.g. { applied: ["0001_init"] }
```

To get the plain DDL (e.g. to hand to a DBA, or apply through a different tool) without touching a
database, use the standalone export:

```ts
import { migrationsSql } from "@sturdle/postgres";

for (const { id, sql } of migrationsSql("sturdle")) {
  console.log(id, sql);
}
```

Migration files live in `src/migrations/*.sql`, versioned and applied in order; each one contains
a `{{schema}}` placeholder that gets substituted with the configured schema name before it runs.

## Tables

All under the configured schema: `jobs`, `job_streams`, `delayed_jobs`, `job_metadata`,
`distributed_locks`, plus the `job_status` enum and the `schema_migrations` bookkeeping table. Job
ids (and every other table's `id` column) are `text`, generated application-side with
`crypto.randomUUID()` — there is no database-side id generator to depend on. Every timestamp column
is `timestamptz(3)`. Foreign keys cascade on delete.

## Connection poolers (PgBouncer, RDS Proxy, ...)

- `migrate()` uses a Postgres **session-level** advisory lock (`pg_advisory_lock`, not the
  transaction-scoped variant) held on one dedicated client for the whole migration run, and
  releases it explicitly before returning that client to the pool. This requires the pool
  connection used for `migrate()` to keep the same underlying server session for the duration —
  fine in direct/session-mode pooling, but **not safe in transaction-pooling mode** (e.g. PgBouncer
  in `transaction` mode), where a session-level lock can outlive the logical "connection" or be
  silently dropped. Run migrations against a session-mode (or direct) connection.
- `dequeueJob`'s per-queue serialization uses a **transaction-scoped** advisory lock
  (`pg_advisory_xact_lock`), which is safe under transaction pooling as long as the whole
  transaction stays on one server connection — which `pg.Pool` already guarantees for a single
  `BEGIN…COMMIT` sequence on one checked-out client.
- If you point this adapter at a transaction-pooling proxy, run `migrate()` once, out of band,
  against a direct (session-mode) connection, rather than relying on the adapter's own
  `connect()` to do it for you on every boot.

## Tests

Integration tests (`test/*.test.ts`) run against a real Postgres and are skipped when
`TEST_DATABASE_URL` is not set. Each test file creates its own randomly-named schema
(`sturdle_test_<random>`) and drops it in `afterAll`, so test runs never collide with each other or
with a real deployment.

```bash
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/sturdle_test pnpm exec vitest run packages/postgres
```
