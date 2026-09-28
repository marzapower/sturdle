import { randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";

import type {
  DatabasePerformanceMetrics,
  EnqueueJobInput,
  FinishedJobRow,
  HistoricalJobStats,
  Job,
  JobFilter,
  JobMetadata,
  JobStats,
  JobStep,
  Log,
  QueueHealthStats,
  QueueInfo,
  TaskStats,
} from "@sturdle/engine";
import { aggregateTaskStats, BaseDatabaseAdapter, mergeByAttempt } from "@sturdle/engine";

import { migrate as applyMigrations, type MigrateResult } from "./migrate.js";
import { assertValidSchemaName, DEFAULT_SCHEMA } from "./schema-name.js";

export interface PostgresAdapterOptions {
  /** An existing pool to reuse. When given, `disconnect()` never closes it. */
  pool?: Pool;
  /** Required when `pool` is absent: a pool is created from it and owned (closed on disconnect). */
  connectionString?: string;
  /** Dedicated Postgres schema for every table. Default "sturdle". Validated against /^[a-z_][a-z0-9_]*$/. */
  schema?: string;
}

// Shapes persisted as JSONB in job_metadata.logs/steps; attempt is optional because entries
// written before it existed do not carry it.
interface StoredLog {
  level: string;
  message: string;
  timestamp: string;
  step?: string;
  system?: boolean;
  attempt?: number;
}

interface StoredStep {
  name: string;
  attempt?: number;
  kind?: string;
  startedAt: string;
  completedAt: string | null;
  duration: number | null;
  status: string;
  result: unknown;
  error: string | null;
  replayedFrom?: number | null;
}

interface JobRow {
  id: string;
  queue_name: string;
  code: string;
  payload: unknown;
  status: string;
  priority: number;
  attempts: number;
  max_attempts: number;
  created_at: Date;
  updated_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  failed_at: Date | null;
  delay_until: Date | null;
  parent_job_id: string | null;
  error: string | null;
  result: unknown;
  metadata: unknown;
  concurrency_key: string | null;
  concurrency_limit: number | null;
}

/**
 * Job storage adapter on the raw `pg` driver — no ORM. All tables live in a dedicated,
 * app-managed schema (`options.schema`, default "sturdle"); every query below is
 * schema-qualified rather than relying on `search_path`. Ids are generated application-side
 * with `crypto.randomUUID()`.
 */
export class PostgresAdapter extends BaseDatabaseAdapter {
  private readonly pool: Pool;
  private readonly ownsPool: boolean;
  private readonly schema: string;
  private readonly jobStatusType: string;

  constructor(options: PostgresAdapterOptions = {}) {
    super();

    const schema = options.schema ?? DEFAULT_SCHEMA;
    assertValidSchemaName(schema);
    this.schema = schema;
    this.jobStatusType = `"${schema}".job_status`;

    if (options.pool) {
      this.pool = options.pool;
      this.ownsPool = false;
    } else {
      if (!options.connectionString) {
        throw new Error("PostgresAdapter requires either a pool or a connectionString");
      }
      this.pool = new Pool({ connectionString: options.connectionString });
      this.ownsPool = true;
    }
  }

  private t(table: string): string {
    return `"${this.schema}".${table}`;
  }

  private nextStreamId(): string {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }

  private async runInTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async connect(): Promise<void> {
    try {
      await this.pool.query("SELECT 1");
      await this.migrate();
      this.setConnected(true);
    } catch (error) {
      this.setConnected(false);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (this.ownsPool) {
      await this.pool.end();
    }
    this.setConnected(false);
  }

  /** Applies every pending migration for this adapter's schema. Idempotent. */
  async migrate(): Promise<MigrateResult> {
    return applyMigrations(this.pool, this.schema);
  }

  async enqueueJob(queueName: string, job: EnqueueJobInput): Promise<Job> {
    const id = randomUUID();
    const createdAt = new Date();
    const isImmediate = !job.delayUntil || job.delayUntil <= createdAt;

    const { rows } = await this.pool.query<JobRow>(
      `INSERT INTO ${this.t("jobs")} (
         id, queue_name, code, payload, config, status, priority, attempts, max_attempts,
         created_at, updated_at, scheduled_at, delay_until, parent_job_id, error, result,
         metadata, concurrency_key, concurrency_limit
       ) VALUES (
         $1, $2, $3, $4::jsonb, '{}'::jsonb, $5::${this.jobStatusType}, $6, $7, $8,
         $9, $9, $9, $10, $11, $12, $13::jsonb,
         $14::jsonb, $15, $16
       )
       RETURNING *`,
      [
        id,
        queueName,
        job.code,
        JSON.stringify(job.payload),
        job.status,
        job.priority,
        job.attempts,
        job.maxAttempts,
        createdAt,
        job.delayUntil ?? null,
        job.parentJobId ?? null,
        job.error ?? null,
        job.result !== undefined ? JSON.stringify(job.result) : null,
        JSON.stringify(job.metadata ?? {}),
        job.concurrencyKey ?? null,
        job.concurrencyLimit ?? null,
      ],
    );

    const row = rows[0]!;

    if (isImmediate) {
      // Add immediate jobs to the stream
      await this.pool.query(
        `INSERT INTO ${this.t("job_streams")} (id, job_id, queue_name, job_code, stream_id, "timestamp", acknowledged)
         VALUES ($1, $2, $3, $4, $5, $6, false)`,
        [randomUUID(), id, queueName, job.code, this.nextStreamId(), createdAt],
      );
    } else {
      // Keep delayed jobs out of the stream until they are ready
      await this.pool.query(
        `INSERT INTO ${this.t("delayed_jobs")} (id, job_id, queue_name, execute_at)
         VALUES ($1, $2, $3, $4)`,
        [randomUUID(), id, queueName, job.delayUntil],
      );
    }

    return this.mapRowToJob(row);
  }

  async dequeueJob(queueName: string, consumerName: string): Promise<Job | null> {
    return this.runInTransaction(async (client) => {
      // Serialize dequeues per queue so the per-key concurrency count below is read-consistent
      // across concurrent workers: without this lock two workers can both see zero holders of
      // the same concurrency key before either commits its "processing" update.
      // Transaction-scoped (pg_advisory_xact_lock), released automatically at commit/rollback.
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('sturdle:dequeue:' || $1::text || ':' || $2::text))",
        [this.schema, queueName],
      );

      // FOR UPDATE SKIP LOCKED avoids worker contention. A job with a concurrency key is only a
      // candidate when fewer than its limit of other jobs currently hold that key (started but
      // not yet in a terminal state).
      const { rows: candidateRows } = await client.query<{ job_id: string }>(
        `SELECT s.job_id
         FROM ${this.t("job_streams")} s
         JOIN ${this.t("jobs")} j ON j.id = s.job_id
         WHERE s.queue_name = $1
           AND s.acknowledged = false
           AND (s.consumer_name IS NULL OR s.consumer_name = '')
           AND (
             j.concurrency_key IS NULL
             OR (
               SELECT count(*)::int FROM ${this.t("jobs")} r
               WHERE r.concurrency_key = j.concurrency_key
                 AND r.id <> j.id
                 AND r.started_at IS NOT NULL
                 AND r.status::text NOT IN ('completed', 'failed')
             ) < COALESCE(j.concurrency_limit, 1)
           )
         ORDER BY s.timestamp ASC
         FOR UPDATE OF s SKIP LOCKED
         LIMIT 1`,
        [queueName],
      );

      const jobId = candidateRows[0]?.job_id;
      if (!jobId) return null;

      // Mark the job as processing and increment attempts atomically with the claim
      const { rows: updatedRows } = await client.query<JobRow>(
        `UPDATE ${this.t("jobs")}
         SET status = 'processing'::${this.jobStatusType}, started_at = now(), updated_at = now(), attempts = attempts + 1
         WHERE id = $1
         RETURNING *`,
        [jobId],
      );
      const updated = updatedRows[0];
      if (!updated) return null;

      // Assign the job to this consumer after the status update; acknowledged stays false until completion
      await client.query(
        `UPDATE ${this.t("job_streams")} SET consumer_name = $1 WHERE job_id = $2 AND queue_name = $3`,
        [consumerName, jobId, queueName],
      );

      return this.mapRowToJob(updated);
    });
  }

  async getJob(id: string): Promise<Job | null> {
    const { rows } = await this.pool.query<JobRow>(
      `SELECT * FROM ${this.t("jobs")} WHERE id = $1`,
      [id],
    );
    return rows[0] ? this.mapRowToJob(rows[0]) : null;
  }

  async updateJob(id: string, updates: Partial<Job>): Promise<Job> {
    const setClauses: string[] = ["updated_at = now()"];
    const params: unknown[] = [];

    const addSet = (column: string, value: unknown, cast?: string) => {
      // pg only JSON-serializes plain objects automatically, not arrays (those get turned into a
      // Postgres array literal instead) — stringify explicitly for every jsonb column.
      params.push(cast === "jsonb" ? JSON.stringify(value) : value);
      setClauses.push(`${column} = $${params.length}${cast ? `::${cast}` : ""}`);
    };

    if (updates.status) addSet("status", updates.status, this.jobStatusType);
    if (updates.priority !== undefined) addSet("priority", updates.priority);
    if (updates.attempts !== undefined) addSet("attempts", updates.attempts);
    if (updates.maxAttempts !== undefined) addSet("max_attempts", updates.maxAttempts);
    if (updates.processedAt) addSet("started_at", updates.processedAt);
    if (updates.completedAt) addSet("completed_at", updates.completedAt);
    if (updates.failedAt) addSet("failed_at", updates.failedAt);
    if (updates.delayUntil) addSet("delay_until", updates.delayUntil);
    if (updates.parentJobId !== undefined) addSet("parent_job_id", updates.parentJobId || null);
    if (updates.error) addSet("error", updates.error);
    if (updates.result) addSet("result", updates.result, "jsonb");
    // metadata replaces the entire JSON blob — the caller always passes the full object
    if (updates.metadata) addSet("metadata", updates.metadata, "jsonb");

    params.push(id);
    const idIndex = params.length;

    return this.runInTransaction(async (client) => {
      const { rows } = await client.query<JobRow>(
        `UPDATE ${this.t("jobs")} SET ${setClauses.join(", ")} WHERE id = $${idIndex} RETURNING *`,
        params,
      );
      const row = rows[0];
      if (!row) throw new Error(`Job ${id} not found`);

      // Acknowledge terminal (or delayed) jobs in the stream
      if (
        updates.status === "completed" ||
        updates.status === "failed" ||
        updates.status === "delayed"
      ) {
        await client.query(
          `UPDATE ${this.t("job_streams")} SET acknowledged = true WHERE job_id = $1 AND acknowledged = false`,
          [id],
        );
      }

      return this.mapRowToJob(row);
    });
  }

  async deleteJob(id: string): Promise<void> {
    await this.runInTransaction(async (client) => {
      // Remove matching stream entries as well
      await client.query(`DELETE FROM ${this.t("job_streams")} WHERE job_id = $1`, [id]);
      await client.query(`DELETE FROM ${this.t("jobs")} WHERE id = $1`, [id]);
    });
  }

  // Release jobs left processing by stopped workers. Stale = the job's lease (updated_at,
  // renewed by heartbeatJob) has not been renewed recently.
  async releaseStaleJobs(queueName: string, staleAfterMs = 300000): Promise<number> {
    const staleTime = new Date(Date.now() - staleAfterMs);

    const { rows: staleJobs } = await this.pool.query<JobRow>(
      `SELECT * FROM ${this.t("jobs")} WHERE queue_name = $1 AND status::text = 'processing' AND updated_at <= $2`,
      [queueName, staleTime],
    );

    let releasedCount = 0;

    for (const job of staleJobs) {
      // Conditional update: a worker may have finished the job (or renewed its lease) between the
      // query and this write, in which case the row is no longer stale and must be left alone.
      const now = new Date();

      if (job.attempts < job.max_attempts) {
        const { rowCount } = await this.pool.query(
          `UPDATE ${this.t("jobs")}
           SET status = 'pending'::${this.jobStatusType}, updated_at = $1
           WHERE id = $2 AND status::text = 'processing' AND updated_at <= $3`,
          [now, job.id, staleTime],
        );
        if (!rowCount) continue;

        // Reset stream entry so it can be claimed again
        await this.pool.query(
          `UPDATE ${this.t("job_streams")} SET consumer_name = NULL WHERE job_id = $1 AND acknowledged = false`,
          [job.id],
        );
        releasedCount++;
      } else {
        // Job has exhausted its attempts: mark it as failed and ack the stream entry
        const { rowCount } = await this.pool.query(
          `UPDATE ${this.t("jobs")}
           SET status = 'failed'::${this.jobStatusType}, failed_at = $1, updated_at = $1, error = $2
           WHERE id = $3 AND status::text = 'processing' AND updated_at <= $4`,
          [now, "Job stale - max attempts reached", job.id, staleTime],
        );
        if (!rowCount) continue;

        await this.pool.query(
          `UPDATE ${this.t("job_streams")} SET acknowledged = true WHERE job_id = $1 AND acknowledged = false`,
          [job.id],
        );
      }
    }

    return releasedCount;
  }

  private async queryJobs(
    column: "queue_name" | "code",
    value: string,
    filter?: JobFilter,
  ): Promise<Job[]> {
    const conditions = [`${column} = $1`];
    const params: unknown[] = [value];

    if (filter?.status) {
      params.push(filter.status);
      conditions.push(`status::text = $${params.length}`);
    }
    if (filter?.priority !== undefined) {
      params.push(filter.priority);
      conditions.push(`priority = $${params.length}`);
    }
    if (filter?.createdAfter) {
      params.push(filter.createdAfter);
      conditions.push(`created_at >= $${params.length}`);
    }
    if (filter?.createdBefore) {
      params.push(filter.createdBefore);
      conditions.push(`created_at <= $${params.length}`);
    }

    let sql = `SELECT * FROM ${this.t("jobs")} WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC`;
    if (filter?.limit !== undefined) {
      params.push(filter.limit);
      sql += ` LIMIT $${params.length}`;
    }
    if (filter?.offset !== undefined) {
      params.push(filter.offset);
      sql += ` OFFSET $${params.length}`;
    }

    const { rows } = await this.pool.query<JobRow>(sql, params);
    return rows.map((row) => this.mapRowToJob(row));
  }

  async listJobs(queueName: string, filter?: JobFilter): Promise<Job[]> {
    return this.queryJobs("queue_name", queueName, filter);
  }

  async countJobs(queueName: string, filter?: { status?: string }): Promise<number> {
    const conditions = ["queue_name = $1"];
    const params: unknown[] = [queueName];

    if (filter?.status) {
      params.push(filter.status);
      conditions.push(`status::text = $${params.length}`);
    }

    const { rows } = await this.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM ${this.t("jobs")} WHERE ${conditions.join(" AND ")}`,
      params,
    );
    return rows[0]?.count ?? 0;
  }

  // Same shape as listJobs, but across all queues, filtered by job code instead of queue.
  async listJobsByCode(code: string, filter?: JobFilter): Promise<Job[]> {
    return this.queryJobs("code", code, filter);
  }

  private async computeStats(column: "queue_name" | "code", value: string): Promise<JobStats> {
    const { rows } = await this.pool.query<{ status: string; count: number }>(
      `SELECT status::text AS status, count(*)::int AS count
       FROM ${this.t("jobs")}
       WHERE ${column} = $1
       GROUP BY status`,
      [value],
    );

    const result: JobStats = {
      total: 0,
      pending: 0,
      processing: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
    };

    for (const row of rows) {
      const status = row.status as keyof JobStats;
      if (status in result) {
        result[status] = row.count;
        result.total += row.count;
      }
    }

    return result;
  }

  async getJobStatsByCode(code: string): Promise<JobStats> {
    return this.computeStats("code", code);
  }

  async getJobStats(queueName: string): Promise<JobStats> {
    return this.computeStats("queue_name", queueName);
  }

  async getQueueInfo(queueName: string): Promise<QueueInfo> {
    const stats = await this.getJobStats(queueName);
    const { rows } = await this.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM ${this.t("delayed_jobs")} WHERE queue_name = $1`,
      [queueName],
    );

    return {
      name: queueName,
      size: stats.pending,
      delayedSize: rows[0]?.count ?? 0,
      processingSize: stats.processing,
      stats,
    };
  }

  // Atomic retry scheduling: mark the job as delayed, ack the stream entry, create the delayed entry.
  async scheduleDelayedJob(
    queueName: string,
    jobId: string,
    delayUntil: Date,
    metadata?: JobMetadata,
  ): Promise<void> {
    await this.runInTransaction(async (client) => {
      const setClauses = [
        "delay_until = $1",
        `status = 'delayed'::${this.jobStatusType}`,
        "updated_at = now()",
      ];
      const params: unknown[] = [delayUntil];
      if (metadata !== undefined) {
        params.push(JSON.stringify(metadata));
        setClauses.push(`metadata = $${params.length}::jsonb`);
      }
      params.push(jobId);

      await client.query(
        `UPDATE ${this.t("jobs")} SET ${setClauses.join(", ")} WHERE id = $${params.length}`,
        params,
      );

      await client.query(
        `UPDATE ${this.t("job_streams")} SET acknowledged = true WHERE job_id = $1 AND acknowledged = false`,
        [jobId],
      );

      await client.query(
        `INSERT INTO ${this.t("delayed_jobs")} (id, job_id, queue_name, execute_at) VALUES ($1, $2, $3, $4)`,
        [randomUUID(), jobId, queueName, delayUntil],
      );
    });
  }

  async getReadyDelayedJobs(queueName: string): Promise<Job[]> {
    const { rows } = await this.pool.query<JobRow>(
      `SELECT j.* FROM ${this.t("delayed_jobs")} d
       JOIN ${this.t("jobs")} j ON j.id = d.job_id
       WHERE d.queue_name = $1 AND d.execute_at <= now()`,
      [queueName],
    );
    return rows.map((row) => this.mapRowToJob(row));
  }

  // Claim: deleting the delayed entry is the claim itself — if another replica already deleted
  // it, rowCount === 0 and we bail out without touching the stream or the job.
  async moveJobToStream(queueName: string, jobId: string): Promise<void> {
    await this.runInTransaction(async (client) => {
      const { rowCount } = await client.query(
        `DELETE FROM ${this.t("delayed_jobs")} WHERE job_id = $1`,
        [jobId],
      );
      if (!rowCount) return;

      const { rows } = await client.query<{ code: string }>(
        `SELECT code FROM ${this.t("jobs")} WHERE id = $1`,
        [jobId],
      );
      const code = rows[0]?.code ?? "";

      await client.query(
        `INSERT INTO ${this.t("job_streams")} (id, job_id, queue_name, job_code, stream_id, "timestamp", acknowledged)
         VALUES ($1, $2, $3, $4, $5, now(), false)
         ON CONFLICT (job_id, queue_name) DO UPDATE
           SET acknowledged = false, consumer_name = NULL, stream_id = EXCLUDED.stream_id, "timestamp" = now()`,
        [randomUUID(), jobId, queueName, code, this.nextStreamId()],
      );

      await client.query(
        `UPDATE ${this.t("jobs")} SET status = 'pending'::${this.jobStatusType}, updated_at = now() WHERE id = $1`,
        [jobId],
      );
    });
  }

  // Renews the lease of a running job: no-op (WHERE excludes it) once the job is no longer
  // "processing", e.g. it already completed/failed/was suspended.
  async heartbeatJob(jobId: string): Promise<void> {
    await this.pool.query(
      `UPDATE ${this.t("jobs")} SET updated_at = now() WHERE id = $1 AND status::text = 'processing'`,
      [jobId],
    );
  }

  // Atomic suspension: status "delayed", delay_until = wakeAt, attempts - 1 (a resumed sleep
  // keeps its attempt number), ack of the stream entry, delayed row. Metadata untouched.
  async suspendJob(queueName: string, jobId: string, wakeAt: Date): Promise<void> {
    await this.runInTransaction(async (client) => {
      const { rows } = await client.query<JobRow>(`SELECT * FROM ${this.t("jobs")} WHERE id = $1`, [
        jobId,
      ]);
      const job = rows[0];
      if (!job) throw new Error(`Job ${jobId} not found`);

      await client.query(
        `UPDATE ${this.t("jobs")}
         SET status = 'delayed'::${this.jobStatusType}, delay_until = $1, attempts = $2, updated_at = now()
         WHERE id = $3`,
        [wakeAt, job.attempts - 1, jobId],
      );

      await client.query(
        `UPDATE ${this.t("job_streams")} SET acknowledged = true WHERE job_id = $1 AND acknowledged = false`,
        [jobId],
      );

      await client.query(
        `INSERT INTO ${this.t("delayed_jobs")} (id, job_id, queue_name, execute_at) VALUES ($1, $2, $3, $4)`,
        [randomUUID(), jobId, queueName, wakeAt],
      );
    });
  }

  // Single INSERT ... ON CONFLICT ... DO UPDATE ... WHERE <expired>: this both clears a stale
  // lock and claims a free one in one round-trip, and is race-free under concurrent callers
  // (the second writer's WHERE evaluates against the row the first one just committed).
  async acquireLock(key: string, ttlMs: number): Promise<string | null> {
    const token = randomUUID();
    const expiresAt = new Date(Date.now() + ttlMs);

    const { rows } = await this.pool.query<{ token: string }>(
      `INSERT INTO ${this.t("distributed_locks")} (key, token, expires_at, created_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (key) DO UPDATE
         SET token = EXCLUDED.token, expires_at = EXCLUDED.expires_at
         WHERE ${this.t("distributed_locks")}.expires_at < now()
       RETURNING token`,
      [key, token, expiresAt],
    );

    return rows[0]?.token ?? null;
  }

  async releaseLock(key: string, token: string): Promise<boolean> {
    try {
      const { rowCount } = await this.pool.query(
        `DELETE FROM ${this.t("distributed_locks")} WHERE key = $1 AND token = $2`,
        [key, token],
      );
      return (rowCount ?? 0) > 0;
    } catch {
      return false;
    }
  }

  async cleanupExpiredLocks(): Promise<number> {
    const { rowCount } = await this.pool.query(
      `DELETE FROM ${this.t("distributed_locks")} WHERE expires_at < now()`,
    );
    return rowCount ?? 0;
  }

  async getChildJobIds(jobId: string): Promise<string[]> {
    const { rows } = await this.pool.query<{ id: string }>(
      `SELECT id FROM ${this.t("jobs")} WHERE parent_job_id = $1 ORDER BY created_at ASC`,
      [jobId],
    );
    return rows.map((row) => row.id);
  }

  async getChildJobs(jobId: string): Promise<Job[]> {
    const { rows } = await this.pool.query<JobRow>(
      `SELECT * FROM ${this.t("jobs")} WHERE parent_job_id = $1 ORDER BY created_at ASC`,
      [jobId],
    );
    return rows.map((row) => this.mapRowToJob(row));
  }

  async healthCheck(): Promise<{ healthy: boolean; message?: string }> {
    try {
      await this.pool.query("SELECT 1");
      return { healthy: true };
    } catch (error) {
      return {
        healthy: false,
        message: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  async getMetrics(): Promise<Record<string, unknown>> {
    const [totalResult, streamResult, lockResult, delayedResult] = await Promise.all([
      this.pool.query<{ count: number }>(`SELECT count(*)::int AS count FROM ${this.t("jobs")}`),
      this.pool.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM ${this.t("job_streams")} WHERE acknowledged = false`,
      ),
      this.pool.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM ${this.t("distributed_locks")} WHERE expires_at > now()`,
      ),
      this.pool.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM ${this.t("delayed_jobs")}`,
      ),
    ]);

    return {
      total_jobs: totalResult.rows[0]?.count ?? 0,
      active_streams: streamResult.rows[0]?.count ?? 0,
      active_locks: lockResult.rows[0]?.count ?? 0,
      delayed_jobs: delayedResult.rows[0]?.count ?? 0,
      database_type: "postgresql",
    };
  }

  async saveJobLogs(jobId: string, logs: Log[]): Promise<void> {
    const incoming: StoredLog[] = logs.map((log) => ({
      ...log,
      timestamp: new Date(log.timestamp).toISOString(),
    }));

    // Steps and logs are per attempt: entries of the attempt being saved replace only the
    // existing entries with the same attempt, other attempts are preserved.
    const { rows } = await this.pool.query<{ logs: StoredLog[] }>(
      `SELECT logs FROM ${this.t("job_metadata")} WHERE job_id = $1`,
      [jobId],
    );

    const merged = mergeByAttempt(rows[0]?.logs ?? [], incoming);

    await this.pool.query(
      `INSERT INTO ${this.t("job_metadata")} (id, job_id, logs)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (job_id) DO UPDATE SET logs = EXCLUDED.logs, updated_at = now()`,
      [randomUUID(), jobId, JSON.stringify(merged)],
    );
  }

  async saveJobSteps(jobId: string, steps: JobStep[]): Promise<void> {
    const incoming: StoredStep[] = steps.map((step) => ({
      name: step.name,
      attempt: step.attempt,
      kind: step.kind,
      startedAt: step.startedAt.toISOString(),
      completedAt: step.completedAt?.toISOString() || null,
      // ?? not ||: a replay trace's duration is legitimately 0.
      duration: step.duration ?? null,
      status: step.status,
      // ?? not ||: a completed step's result can legitimately be false, 0 or "".
      result: step.result ?? null,
      error: step.error || null,
      replayedFrom: step.replayedFrom ?? null,
    }));

    // Preserve existing logs (kept as-is on conflict, defaulted to '[]' on insert) and merge
    // steps of other attempts when saving steps.
    const { rows } = await this.pool.query<{ steps: StoredStep[] }>(
      `SELECT steps FROM ${this.t("job_metadata")} WHERE job_id = $1`,
      [jobId],
    );

    const merged = mergeByAttempt(rows[0]?.steps ?? [], incoming);

    await this.pool.query(
      `INSERT INTO ${this.t("job_metadata")} (id, job_id, steps)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (job_id) DO UPDATE SET steps = EXCLUDED.steps, updated_at = now()`,
      [randomUUID(), jobId, JSON.stringify(merged)],
    );
  }

  async getJobLogs(jobId: string): Promise<Log[]> {
    const { rows } = await this.pool.query<{ logs: StoredLog[] }>(
      `SELECT logs FROM ${this.t("job_metadata")} WHERE job_id = $1`,
      [jobId],
    );
    const logs = rows[0]?.logs;
    if (!logs) return [];

    return logs.map((log) => ({
      level: log.level,
      message: log.message,
      // timestamp is persisted as an ISO string by saveJobLogs, not an epoch number
      timestamp: new Date(log.timestamp).getTime(),
      step: log.step,
      system: log.system,
      // legacy entries persisted before this field existed are treated as attempt 1
      attempt: log.attempt ?? 1,
    }));
  }

  async getJobSteps(jobId: string): Promise<JobStep[]> {
    const { rows } = await this.pool.query<{ steps: StoredStep[] }>(
      `SELECT steps FROM ${this.t("job_metadata")} WHERE job_id = $1`,
      [jobId],
    );
    const steps = rows[0]?.steps;
    if (!steps) return [];

    return steps.map((step) => ({
      name: step.name,
      // legacy entries persisted before this field existed are treated as attempt 1
      attempt: step.attempt ?? 1,
      // legacy entries persisted before this field existed have no kind (treated as "run" by callers)
      kind: step.kind as JobStep["kind"],
      startedAt: new Date(step.startedAt),
      completedAt: step.completedAt ? new Date(step.completedAt) : undefined,
      // ?? not ||: a replay trace's duration is legitimately 0.
      duration: step.duration ?? undefined,
      status: step.status as JobStep["status"],
      result: step.result,
      error: step.error || undefined,
      replayedFrom: step.replayedFrom ?? undefined,
    }));
  }

  async getHistoricalStats(queueName: string, hoursBack: number): Promise<HistoricalJobStats[]> {
    const hoursBackDate = new Date(Date.now() - hoursBack * 60 * 60 * 1000);

    const { rows } = await this.pool.query<{ hour: Date; status: string; count: number }>(
      `SELECT date_trunc('hour', COALESCE(completed_at, failed_at)) AS hour, status::text AS status, count(*)::int AS count
       FROM ${this.t("jobs")}
       WHERE queue_name = $1
         AND (completed_at >= $2 OR failed_at >= $2)
         AND (completed_at IS NOT NULL OR failed_at IS NOT NULL)
         AND status::text IN ('completed', 'failed')
       GROUP BY hour, status
       ORDER BY hour`,
      [queueName, hoursBackDate],
    );

    const hourlyMap = new Map<string, { completed: number; failed: number; total: number }>();

    // Initialize all hours with zero values
    for (let i = 0; i < hoursBack; i++) {
      const hour = new Date(Date.now() - i * 60 * 60 * 1000);
      hour.setMinutes(0, 0, 0); // Round to hour
      hourlyMap.set(hour.toISOString(), { completed: 0, failed: 0, total: 0 });
    }

    // Fill in actual data
    for (const row of rows) {
      if (!row.hour) continue;
      const hourKey = new Date(row.hour).toISOString();
      const existing = hourlyMap.get(hourKey) ?? { completed: 0, failed: 0, total: 0 };
      const count = row.count;

      if (row.status === "completed") {
        existing.completed += count;
      } else if (row.status === "failed") {
        existing.failed += count;
      }
      existing.total += count;

      hourlyMap.set(hourKey, existing);
    }

    return Array.from(hourlyMap.entries())
      .map(([hour, stats]) => ({
        hour,
        completed: stats.completed,
        failed: stats.failed,
        total: stats.total,
      }))
      .sort((a, b) => new Date(a.hour).getTime() - new Date(b.hour).getTime());
  }

  async getPerformanceMetricsFromDB(
    queueName?: string,
    hoursBack = 24,
  ): Promise<DatabasePerformanceMetrics> {
    const hoursBackDate = new Date(Date.now() - hoursBack * 60 * 60 * 1000);
    const queueClause = queueName ? "AND queue_name = $2" : "";
    const countParams: unknown[] = queueName ? [hoursBackDate, queueName] : [hoursBackDate];

    const [completedResult, failedResult, activeResult] = await Promise.all([
      this.pool.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM ${this.t("jobs")}
         WHERE status::text = 'completed'
           AND (completed_at >= $1 OR failed_at >= $1)
           AND (completed_at IS NOT NULL OR failed_at IS NOT NULL)
           ${queueClause}`,
        countParams,
      ),
      this.pool.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM ${this.t("jobs")}
         WHERE status::text = 'failed'
           AND (completed_at >= $1 OR failed_at >= $1)
           AND (completed_at IS NOT NULL OR failed_at IS NOT NULL)
           ${queueClause}`,
        countParams,
      ),
      this.pool.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM ${this.t("jobs")}
         WHERE status::text = 'processing' ${queueName ? "AND queue_name = $1" : ""}`,
        queueName ? [queueName] : [],
      ),
    ]);

    const completedCount = completedResult.rows[0]?.count ?? 0;
    const failedCount = failedResult.rows[0]?.count ?? 0;
    const activeCount = activeResult.rows[0]?.count ?? 0;
    const totalJobs = completedCount + failedCount;

    if (totalJobs === 0) {
      return {
        totalJobs: 0,
        completedJobs: 0,
        failedJobs: 0,
        successRate: 0,
        avgDurationMs: 0,
        p50DurationMs: 0,
        p95DurationMs: 0,
        p99DurationMs: 0,
        minDurationMs: 0,
        maxDurationMs: 0,
        activeJobs: activeCount,
      };
    }

    const { rows: durationRows } = await this.pool.query<{ duration_ms: number }>(
      `SELECT EXTRACT(EPOCH FROM (COALESCE(completed_at, failed_at) - COALESCE(started_at, created_at))) * 1000 AS duration_ms
       FROM ${this.t("jobs")}
       WHERE (completed_at >= $1 OR failed_at >= $1)
         AND (completed_at IS NOT NULL OR failed_at IS NOT NULL)
         AND status::text IN ('completed', 'failed')
         AND (started_at IS NOT NULL OR created_at IS NOT NULL)
         AND EXTRACT(EPOCH FROM (COALESCE(completed_at, failed_at) - COALESCE(started_at, created_at))) > 0
         ${queueClause}
       ORDER BY duration_ms`,
      countParams,
    );

    const durations = durationRows
      .map((r) => Math.max(0, Math.round(r.duration_ms))) // Ensure non-negative durations
      .filter((d) => d > 0); // Remove zero durations

    let avgDurationMs = 0;
    let p50DurationMs = 0;
    let p95DurationMs = 0;
    let p99DurationMs = 0;
    let minDurationMs = 0;
    let maxDurationMs = 0;

    if (durations.length > 0) {
      avgDurationMs = Math.round(durations.reduce((sum, d) => sum + d, 0) / durations.length);

      const sortedDurations = [...durations].sort((a, b) => a - b);

      p50DurationMs = this.calculatePercentile(sortedDurations, 50);
      p95DurationMs = this.calculatePercentile(sortedDurations, 95);
      p99DurationMs = this.calculatePercentile(sortedDurations, 99);

      minDurationMs = sortedDurations[0] ?? 0;
      maxDurationMs = sortedDurations[sortedDurations.length - 1] ?? 0;
    }

    const successRate = totalJobs > 0 ? Math.round((completedCount / totalJobs) * 100) : 0;

    return {
      totalJobs,
      completedJobs: completedCount,
      failedJobs: failedCount,
      successRate,
      avgDurationMs,
      p50DurationMs,
      p95DurationMs,
      p99DurationMs,
      minDurationMs,
      maxDurationMs,
      activeJobs: Math.max(0, activeCount), // Ensure non-negative
    };
  }

  private calculatePercentile(sortedArray: number[], percentile: number): number {
    if (sortedArray.length === 0) return 0;

    const index = Math.ceil((percentile / 100) * sortedArray.length) - 1;
    const clampedIndex = Math.max(0, Math.min(index, sortedArray.length - 1));
    return sortedArray[clampedIndex] ?? 0;
  }

  async getQueueHealth(queueName: string, since: Date): Promise<QueueHealthStats> {
    const [oldestResult, completedResult, failedResult] = await Promise.all([
      this.pool.query<{ created_at: Date }>(
        `SELECT created_at FROM ${this.t("jobs")} WHERE queue_name = $1 AND status::text = 'pending' ORDER BY created_at ASC LIMIT 1`,
        [queueName],
      ),
      this.pool.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM ${this.t("jobs")} WHERE queue_name = $1 AND status::text = 'completed' AND completed_at >= $2`,
        [queueName, since],
      ),
      this.pool.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM ${this.t("jobs")} WHERE queue_name = $1 AND status::text = 'failed' AND failed_at >= $2`,
        [queueName, since],
      ),
    ]);

    return {
      oldestPendingAt: oldestResult.rows[0]?.created_at ?? null,
      completedSince: completedResult.rows[0]?.count ?? 0,
      failedSince: failedResult.rows[0]?.count ?? 0,
    };
  }

  async getLastRunByCode(code: string): Promise<Job | null> {
    const { rows } = await this.pool.query<JobRow>(
      `SELECT * FROM ${this.t("jobs")} WHERE code = $1 ORDER BY created_at DESC LIMIT 1`,
      [code],
    );
    return rows[0] ? this.mapRowToJob(rows[0]) : null;
  }

  // 24h-style aggregates per job code, for the fleet table. Only codes with at least one
  // finished job in the window are returned.
  async getTaskStats(hoursBack: number, code?: string): Promise<TaskStats[]> {
    const now = new Date();
    const since = new Date(now.getTime() - hoursBack * 60 * 60 * 1000);

    const conditions = [
      "status::text IN ('completed', 'failed')",
      "(completed_at >= $1 OR failed_at >= $1)",
    ];
    const params: unknown[] = [since];
    if (code) {
      params.push(code);
      conditions.push(`code = $${params.length}`);
    }

    const { rows } = await this.pool.query<{
      code: string;
      status: "completed" | "failed";
      created_at: Date;
      started_at: Date | null;
      completed_at: Date | null;
      failed_at: Date | null;
    }>(
      `SELECT code, status::text AS status, created_at, started_at, completed_at, failed_at
       FROM ${this.t("jobs")}
       WHERE ${conditions.join(" AND ")}`,
      params,
    );

    const finished: FinishedJobRow[] = rows.map((row) => ({
      code: row.code,
      status: row.status,
      createdAt: row.created_at,
      startedAt: row.started_at ?? undefined,
      completedAt: row.completed_at ?? undefined,
      failedAt: row.failed_at ?? undefined,
    }));

    return aggregateTaskStats(finished, hoursBack, now);
  }

  private mapRowToJob(row: JobRow): Job {
    return {
      id: row.id,
      code: row.code,
      queueName: row.queue_name,
      payload: row.payload as Record<string, unknown>,
      status: row.status as Job["status"],
      priority: row.priority,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      processedAt: row.started_at ?? undefined,
      completedAt: row.completed_at ?? undefined,
      failedAt: row.failed_at ?? undefined,
      delayUntil: row.delay_until ?? undefined,
      parentJobId: row.parent_job_id ?? undefined,
      error: row.error ?? undefined,
      result: (row.result as Record<string, unknown>) ?? undefined,
      metadata: (row.metadata as JobMetadata) ?? undefined,
      concurrencyKey: row.concurrency_key ?? undefined,
      concurrencyLimit: row.concurrency_limit ?? undefined,
    };
  }
}
