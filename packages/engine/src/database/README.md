# Database adapter system

The engine is storage-agnostic: it talks to persistence only through the `DatabaseAdapter`
interface defined here.

- **`types.ts`** — `DatabaseAdapter` interface plus `Job`, `JobMetadata`, `AttemptHistoryEntry`,
  `EnqueueJobInput` and the query/stats support types.
- **`adapter.ts`** — `BaseDatabaseAdapter`, an abstract class implementing the connection-state
  boilerplate so concrete adapters only implement the data-access methods.
- **`enhanced-job.ts`** — `EnhancedJob` wraps a plain `Job` with `updateStatus`, `saveSteps` and
  `saveLogs`, persisting through the adapter.
- **`in-memory-adapter.ts`** — `InMemoryAdapter`, a `Map`-backed `DatabaseAdapter` used by this
  package's own tests (and available for reuse) so the engine can be exercised without a real
  database.

A production-grade Postgres implementation lives in the separate `@sturdle/postgres` package,
kept out of this one to leave `@sturdle/engine` free of any database driver or ORM dependency.

## Adding an adapter

Implement `DatabaseAdapter` (or extend `BaseDatabaseAdapter`) and pass an instance as
`EngineOptions.databaseAdapter` when constructing `Engine`.
