import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Pool, PoolClient } from "pg";

import { assertValidSchemaName, DEFAULT_SCHEMA } from "./schema-name.js";

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

// Ordered list of migration ids: each one is a file `<id>.sql` under src/migrations/.
const MIGRATION_IDS = ["0001_init"] as const;

export interface MigrationFile {
  id: string;
  sql: string;
}

export interface MigrateResult {
  applied: string[];
}

/**
 * Returns the DDL for every migration with the "{{schema}}" placeholder resolved to the given
 * schema, in application order. Pure and side-effect free — used both by `migrate()` and for
 * exporting the DDL (e.g. to hand to a DBA, or to apply through a different tool).
 */
export function migrationsSql(schema: string = DEFAULT_SCHEMA): MigrationFile[] {
  assertValidSchemaName(schema);

  return MIGRATION_IDS.map((id) => {
    const raw = readFileSync(path.join(migrationsDir, `${id}.sql`), "utf8");
    return { id, sql: raw.replaceAll("{{schema}}", schema) };
  });
}

/**
 * Applies every migration that has not run yet against `schema`, using a dedicated pool client
 * held for the whole operation:
 *   1. `pg_advisory_lock(hashtext('sturdle:migrate:'||schema))` — a session-level lock, so a
 *      concurrent `migrate()` call (this process or another) blocks until this one releases it.
 *   2. `CREATE SCHEMA IF NOT EXISTS` and the `schema_migrations` bookkeeping table are created
 *      INSIDE the lock, before anything else touches them.
 *   3. Each pending migration runs in its own transaction (DDL + the bookkeeping insert), so a
 *      failure mid-migration never leaves a partially-applied, unrecorded migration.
 *   4. The lock is released in `finally`, and the client is always returned to the pool.
 *
 * Idempotent: running it twice (sequentially or concurrently) applies each migration once.
 */
export async function migrate(pool: Pool, schema: string = DEFAULT_SCHEMA): Promise<MigrateResult> {
  assertValidSchemaName(schema);

  const client: PoolClient = await pool.connect();
  const lockKey = `sturdle:migrate:${schema}`;

  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [lockKey]);

    try {
      await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
      await client.query(
        `CREATE TABLE IF NOT EXISTS "${schema}".schema_migrations (
           id TEXT NOT NULL PRIMARY KEY,
           applied_at TIMESTAMPTZ(3) NOT NULL DEFAULT now()
         )`,
      );

      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM "${schema}".schema_migrations`,
      );
      const alreadyApplied = new Set(rows.map((row) => row.id));

      const applied: string[] = [];
      for (const migration of migrationsSql(schema)) {
        if (alreadyApplied.has(migration.id)) continue;

        await client.query("BEGIN");
        try {
          await client.query(migration.sql);
          await client.query(`INSERT INTO "${schema}".schema_migrations (id) VALUES ($1)`, [
            migration.id,
          ]);
          await client.query("COMMIT");
          applied.push(migration.id);
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        }
      }

      return { applied };
    } finally {
      await client
        .query("SELECT pg_advisory_unlock(hashtext($1))", [lockKey])
        .catch(() => undefined);
    }
  } finally {
    client.release();
  }
}
