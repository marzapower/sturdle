import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { migrate, migrationsSql } from "../src/migrate.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

function randomSchema(): string {
  return `sturdle_test_migrate_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

describe("migrationsSql", () => {
  it("substitutes the schema placeholder and rejects an invalid schema name", () => {
    const files = migrationsSql("my_schema");
    expect(files.length).toBeGreaterThan(0);
    expect(files[0]?.id).toBe("0001_init");
    expect(files[0]?.sql).toContain('"my_schema".jobs');
    expect(files[0]?.sql).not.toContain("{{schema}}");

    expect(() => migrationsSql("not-valid")).toThrow();
  });

  it("defaults to the sturdle schema", () => {
    const files = migrationsSql();
    expect(files[0]?.sql).toContain('"sturdle".jobs');
  });
});

describe.skipIf(!TEST_DATABASE_URL)("migrate", () => {
  const schema = randomSchema();
  let pool: Pool;

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  });

  it("is idempotent and applies each migration exactly once under concurrent calls", async () => {
    pool = new Pool({ connectionString: TEST_DATABASE_URL });

    const [resultA, resultB] = await Promise.all([migrate(pool, schema), migrate(pool, schema)]);

    const totalApplied = resultA.applied.length + resultB.applied.length;
    expect(totalApplied).toBe(1);
    expect([...resultA.applied, ...resultB.applied]).toEqual(["0001_init"]);

    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM "${schema}".schema_migrations`,
    );
    expect(rows.map((r) => r.id)).toEqual(["0001_init"]);

    // Running it again afterwards applies nothing more.
    const third = await migrate(pool, schema);
    expect(third.applied).toEqual([]);
  });
});
