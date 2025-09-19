import { getDb } from '.';

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed';
export type JobRunStatus = JobStatus;

export interface JobRecord {
  id: number;
  repository_id: string;
  status: JobStatus;
  last_run_at: string | null;
  runs: number;
  created_at: string;
  updated_at: string;
}

export interface JobRunRecord {
  id: number;
  job_id: number;
  status: JobRunStatus;
  started_at: string;
  completed_at: string | null;
  error_message: string | null;
  prompt: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cost_usd: number | null;
  latency_ms: number | null;
  raw_response: string | null;
}

export interface TagAssignmentRecord {
  id: number;
  job_run_id: number;
  scope: 'repository' | 'file';
  target: string;
  key: string;
  value: string;
  confidence: number | null;
  applied_at: string;
}

export interface JobSummary extends JobRecord {
  latest_run_id: number | null;
  latest_run_status: JobRunStatus | null;
  latest_completed_at: string | null;
}

export function upsertJob(repositoryId: string): JobRecord {
  const db = getDb();
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO jobs (repository_id, status, runs, created_at, updated_at)
    VALUES (@repositoryId, 'queued', 0, @now, @now)
    ON CONFLICT(repository_id) DO UPDATE SET
      updated_at = excluded.updated_at
  `);
  stmt.run({ repositoryId, now });

  return getJobByRepositoryId(repositoryId);
}

export function getJobByRepositoryId(repositoryId: string): JobRecord {
  const db = getDb();
  const row = db.prepare('SELECT * FROM jobs WHERE repository_id = ?').get(repositoryId);
  if (!row) {
    throw new Error(`Job for repository ${repositoryId} not found`);
  }
  return row as JobRecord;
}

export function getJobById(id: number): JobRecord {
  const db = getDb();
  const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  if (!row) {
    throw new Error(`Job ${id} not found`);
  }
  return row as JobRecord;
}

export function startJobRun(jobId: number): JobRunRecord {
  const db = getDb();
  const startedAt = new Date().toISOString();
  const runStmt = db.prepare(`
    INSERT INTO job_runs (job_id, status, started_at)
    VALUES (@jobId, 'running', @startedAt)
  `);
  const result = runStmt.run({ jobId, startedAt });
  const runId = Number(result.lastInsertRowid);

  db.prepare(`
    UPDATE jobs
    SET status = 'running', runs = runs + 1, last_run_at = @startedAt
    WHERE id = @jobId
  `).run({ jobId, startedAt });

  return getJobRunById(runId);
}

export function completeJobRun(
  jobRunId: number,
  metrics: {
    status: 'succeeded' | 'failed';
    completedAt?: string;
    errorMessage?: string | null;
    prompt?: string | null;
    promptTokens?: number | null;
    completionTokens?: number | null;
    costUsd?: number | null;
    latencyMs?: number | null;
    rawResponse?: unknown;
  }
): JobRunRecord {
  const db = getDb();
  const completedAt = metrics.completedAt ?? new Date().toISOString();
  const rawResponseString = metrics.rawResponse ? JSON.stringify(metrics.rawResponse) : null;

  db.prepare(`
    UPDATE job_runs
    SET status = @status,
        completed_at = @completedAt,
        error_message = @errorMessage,
        prompt = @prompt,
        prompt_tokens = @promptTokens,
        completion_tokens = @completionTokens,
        cost_usd = @costUsd,
        latency_ms = @latencyMs,
        raw_response = @rawResponse
    WHERE id = @jobRunId
  `).run({
    jobRunId,
    status: metrics.status,
    completedAt,
    errorMessage: metrics.errorMessage ?? null,
    prompt: metrics.prompt ?? null,
    promptTokens: metrics.promptTokens ?? null,
    completionTokens: metrics.completionTokens ?? null,
    costUsd: metrics.costUsd ?? null,
    latencyMs: metrics.latencyMs ?? null,
    rawResponse: rawResponseString
  });

  const job = db.prepare('SELECT job_id FROM job_runs WHERE id = ?').get(jobRunId) as {
    job_id: number;
  };

  if (job) {
    db.prepare(`
      UPDATE jobs
      SET status = @status,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = @jobId
    `).run({ jobId: job.job_id, status: metrics.status });
  }

  return getJobRunById(jobRunId);
}

export function getJobRunById(jobRunId: number): JobRunRecord {
  const db = getDb();
  const row = db.prepare('SELECT * FROM job_runs WHERE id = ?').get(jobRunId);
  if (!row) {
    throw new Error(`Job run ${jobRunId} not found`);
  }
  return row as JobRunRecord;
}

export function listJobRuns(jobId: number, limit = 25): JobRunRecord[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM job_runs
       WHERE job_id = ?
       ORDER BY started_at DESC
       LIMIT ?`
    )
    .all(jobId, limit);
  return rows as JobRunRecord[];
}

export function countJobs(): number {
  const db = getDb();
  const row = db.prepare('SELECT COUNT(*) as total FROM jobs').get() as { total: number };
  return row.total ?? 0;
}

export function listRecentJobs(limit: number, offset = 0): JobSummary[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT j.*, (
         SELECT id FROM job_runs WHERE job_id = j.id ORDER BY started_at DESC LIMIT 1
       ) AS latest_run_id,
       (
         SELECT status FROM job_runs WHERE job_id = j.id ORDER BY started_at DESC LIMIT 1
       ) AS latest_run_status,
       (
         SELECT completed_at FROM job_runs WHERE job_id = j.id ORDER BY started_at DESC LIMIT 1
       ) AS latest_completed_at
       FROM jobs j
       ORDER BY j.updated_at DESC
       LIMIT ? OFFSET ?`
    )
    .all(limit, offset);

  return rows as JobSummary[];
}

export function getAssignmentsForRun(jobRunId: number): TagAssignmentRecord[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM tag_assignments
       WHERE job_run_id = ?
       ORDER BY id ASC`
    )
    .all(jobRunId);
  return rows as TagAssignmentRecord[];
}

export function getLatestSuccessfulRun(repositoryId: string): JobRunRecord | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT jr.* FROM job_runs jr
       JOIN jobs j ON j.id = jr.job_id
       WHERE j.repository_id = ? AND jr.status = 'succeeded'
       ORDER BY jr.completed_at DESC
       LIMIT 1`
    )
    .get(repositoryId);
  return (row as JobRunRecord) ?? null;
}

export function hasRecentSuccessfulRun(repositoryId: string, maxAgeMs: number): boolean {
  const latest = getLatestSuccessfulRun(repositoryId);
  if (!latest || !latest.completed_at) {
    return false;
  }
  const completed = new Date(latest.completed_at).getTime();
  const age = Date.now() - completed;
  return age >= 0 && age <= maxAgeMs;
}

export function recordTagAssignments(
  jobRunId: number,
  assignments: Array<{ scope: 'repository' | 'file'; target: string; key: string; value: string; confidence?: number }>
): void {
  if (!assignments.length) {
    return;
  }
  const db = getDb();
  const insert = db.prepare(`
    INSERT INTO tag_assignments (job_run_id, scope, target, key, value, confidence)
    VALUES (@jobRunId, @scope, @target, @key, @value, @confidence)
  `);
  const transaction = db.transaction((rows: typeof assignments) => {
    for (const row of rows) {
      insert.run({
        jobRunId,
        scope: row.scope,
        target: row.target,
        key: row.key,
        value: row.value,
        confidence: row.confidence ?? null
      });
    }
  });
  transaction(assignments);
}
