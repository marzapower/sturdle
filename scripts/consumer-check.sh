#!/usr/bin/env bash
# Consumer check: packs the publishable packages exactly as `npm publish` would, installs the
# tarballs into a fresh, empty npm project (no workspace, no pnpm, no TypeScript), and runs one
# job end to end against a real Postgres. This is the "installable from npm" criterion of the
# first release, and it runs in CI on every push.
#
# Usage: TEST_DATABASE_URL=postgres://... bash scripts/consumer-check.sh
set -euo pipefail

if [[ -z "${TEST_DATABASE_URL:-}" ]]; then
  echo "TEST_DATABASE_URL is required (a Postgres the check may create a schema in)" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PNPM="${PNPM:-corepack pnpm}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "==> Building packages"
(cd "$ROOT" && $PNPM build >/dev/null)

echo "==> Packing into $WORK/tarballs"
mkdir -p "$WORK/tarballs"
for pkg in engine postgres ui; do
  (cd "$ROOT/packages/$pkg" && $PNPM pack --out "$WORK/tarballs/$pkg.tgz" >/dev/null)
done
ls -la "$WORK/tarballs"

echo "==> Installing the tarballs into an empty npm project"
mkdir -p "$WORK/consumer"
cd "$WORK/consumer"
npm init -y >/dev/null
# The postgres tarball depends on @sturdle/engine@^0.1.0, which is not on npm yet: install the
# engine tarball first so npm resolves that range from the local package instead of the registry.
npm install --no-audit --no-fund --loglevel=error "$WORK/tarballs/engine.tgz" >/dev/null
npm install --no-audit --no-fund --loglevel=error "$WORK/tarballs/postgres.tgz" pg >/dev/null
npm ls --depth=0

cat > check.mjs <<'JS'
import { Engine, JobRegistry } from "@sturdle/engine";
import { PostgresAdapter } from "@sturdle/postgres";

const schema = `consumer_check_${Math.random().toString(36).slice(2, 8)}`;
const adapter = new PostgresAdapter({ connectionString: process.env.TEST_DATABASE_URL, schema });

JobRegistry.register({
  name: "Consumer check",
  event: "consumer/check",
  func: async (ctx) => {
    const greeting = await ctx.step.run("greet", () => `hello ${ctx.event.data.who}`);
    return { greeting };
  },
});

const engine = new Engine({ databaseAdapter: adapter, maxWorkers: 2 });
const deadline = Date.now() + 60_000;
let exitCode = 1;

try {
  await engine.start();
  const jobId = await engine.addJob("consumer/check", { who: "npm" });
  console.log(`enqueued ${jobId} in schema ${schema}`);

  let job = await adapter.getJob(jobId);
  while (job && job.status !== "completed" && job.status !== "failed" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    job = await adapter.getJob(jobId);
  }

  if (job?.status === "completed" && job.result?.greeting === "hello npm") {
    console.log(`completed in ${job.completedAt - job.createdAt} ms: ${JSON.stringify(job.result)}`);
    exitCode = 0;
  } else {
    console.error(`job did not complete: ${JSON.stringify(job)}`);
  }
} finally {
  await engine.gracefullyShutdown().catch(() => undefined);
  await engine.shutdown().catch(() => undefined);
  // Drop the throwaway schema so repeated runs leave nothing behind.
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
  await pool.end();
}

process.exit(exitCode);
JS

echo "==> Running one job from the installed packages"
node check.mjs
