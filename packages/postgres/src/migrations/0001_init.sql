-- Initial schema for the Postgres job storage adapter. The "{{schema}}" placeholder is replaced
-- with the configured schema name (validated against /^[a-z_][a-z0-9_]*$/) before this file is
-- executed, so every table, enum and cast below is schema-qualified rather than relying on
-- search_path.

CREATE TYPE "{{schema}}".job_status AS ENUM ('pending', 'processing', 'completed', 'failed', 'delayed');

CREATE TABLE "{{schema}}".jobs (
    id TEXT NOT NULL PRIMARY KEY,
    queue_name VARCHAR(255) NOT NULL,
    code VARCHAR(255) NOT NULL,
    payload JSONB NOT NULL,
    config JSONB NOT NULL DEFAULT '{}',
    status "{{schema}}".job_status NOT NULL DEFAULT 'pending',
    priority INTEGER NOT NULL DEFAULT 1,
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    created_at TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    scheduled_at TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    started_at TIMESTAMPTZ(3),
    completed_at TIMESTAMPTZ(3),
    failed_at TIMESTAMPTZ(3),
    delay_until TIMESTAMPTZ(3),
    parent_job_id TEXT REFERENCES "{{schema}}".jobs (id) ON DELETE CASCADE,
    error TEXT,
    result JSONB,
    metadata JSONB NOT NULL DEFAULT '{}',
    -- Keyed concurrency: set at enqueue time, never changed afterwards. concurrency_key is
    -- `<code>` (a plain numeric limit) or `<code>:<value>` (a keyed limit); null means
    -- unconstrained.
    concurrency_key VARCHAR(255),
    concurrency_limit INTEGER
);

CREATE INDEX jobs_queue_name_idx ON "{{schema}}".jobs (queue_name);
CREATE INDEX jobs_status_idx ON "{{schema}}".jobs (status);
CREATE INDEX jobs_scheduled_at_idx ON "{{schema}}".jobs (scheduled_at);
CREATE INDEX jobs_delay_until_idx ON "{{schema}}".jobs (delay_until);
CREATE INDEX jobs_parent_job_id_idx ON "{{schema}}".jobs (parent_job_id);
CREATE INDEX jobs_created_at_idx ON "{{schema}}".jobs (created_at);
CREATE INDEX jobs_code_created_at_idx ON "{{schema}}".jobs (code, created_at);
CREATE INDEX jobs_concurrency_key_status_idx ON "{{schema}}".jobs (concurrency_key, status);

CREATE TABLE "{{schema}}".job_streams (
    id TEXT NOT NULL PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES "{{schema}}".jobs (id) ON DELETE CASCADE,
    queue_name VARCHAR(255) NOT NULL,
    job_code VARCHAR(255) NOT NULL,
    stream_id VARCHAR(50) NOT NULL,
    "timestamp" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    consumer_group VARCHAR(255),
    consumer_name VARCHAR(255),
    acknowledged BOOLEAN NOT NULL DEFAULT false,
    UNIQUE (job_id, queue_name)
);

CREATE INDEX job_streams_queue_name_idx ON "{{schema}}".job_streams (queue_name);
CREATE INDEX job_streams_acknowledged_idx ON "{{schema}}".job_streams (acknowledged);
CREATE INDEX job_streams_timestamp_idx ON "{{schema}}".job_streams ("timestamp");
CREATE INDEX job_streams_job_id_idx ON "{{schema}}".job_streams (job_id);

CREATE TABLE "{{schema}}".delayed_jobs (
    id TEXT NOT NULL PRIMARY KEY,
    job_id TEXT NOT NULL UNIQUE REFERENCES "{{schema}}".jobs (id) ON DELETE CASCADE,
    queue_name VARCHAR(255) NOT NULL,
    execute_at TIMESTAMPTZ(3) NOT NULL,
    created_at TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);

CREATE INDEX delayed_jobs_execute_at_idx ON "{{schema}}".delayed_jobs (execute_at);
CREATE INDEX delayed_jobs_queue_name_idx ON "{{schema}}".delayed_jobs (queue_name);

CREATE TABLE "{{schema}}".job_metadata (
    id TEXT NOT NULL PRIMARY KEY,
    job_id TEXT NOT NULL UNIQUE REFERENCES "{{schema}}".jobs (id) ON DELETE CASCADE,
    logs JSONB NOT NULL DEFAULT '[]',
    steps JSONB NOT NULL DEFAULT '[]',
    created_at TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);

CREATE INDEX job_metadata_job_id_idx ON "{{schema}}".job_metadata (job_id);

CREATE TABLE "{{schema}}".distributed_locks (
    key VARCHAR(255) NOT NULL PRIMARY KEY,
    token VARCHAR(36) NOT NULL,
    expires_at TIMESTAMPTZ(3) NOT NULL,
    created_at TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);

CREATE INDEX distributed_locks_expires_at_idx ON "{{schema}}".distributed_locks (expires_at);
