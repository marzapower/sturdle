// The schema name is interpolated directly into DDL and DML strings (quoted identifiers, hashtext
// lock keys), so it must be restricted to a safe character set before it ever reaches SQL.
const SCHEMA_NAME_PATTERN = /^[a-z_][a-z0-9_]*$/;

export const DEFAULT_SCHEMA = "sturdle";

export function assertValidSchemaName(schema: string): void {
  if (!SCHEMA_NAME_PATTERN.test(schema)) {
    throw new Error(
      `Invalid Postgres schema name "${schema}": must match ${SCHEMA_NAME_PATTERN.source}`,
    );
  }
}
