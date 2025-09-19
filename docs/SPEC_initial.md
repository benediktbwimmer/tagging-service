# SPEC_file-tagging-service

## Overview
The File Tagging Service is a standalone TypeScript service that listens for repository readiness events, analyzes repository files by leveraging the File Explorer and AI Connector APIs, and emits structured tag assignments back to the catalog. It must run independently (separate repository) but integrate with AppHub through HTTP and Redis.

## Goals
- Subscribe to `repository.updated` / `repository.ingestion-event` events to discover repositories that require tagging.
- Generate machine- and human-curated tags for both repository-level metadata and specific files using AI-assisted heuristics.
- Persist tagging jobs, results, and audit logs locally, and push final tags to the catalog (`/apps/:id/tags`) and Better File Explorer (`/api/tags`).
- Expose a minimal API for observability: job queue status, recent tagging results, manual requeue.

## Non-Goals
- Running ingestion, builds, or frontend responsibilities.
- Providing a UI beyond simple health/status endpoints.
- Managing authentication/authorization beyond simple shared-secret headers when calling other services.

## Service Architecture
- **Runtime**: Node.js 20+, Fastify for HTTP API, BullMQ for background jobs, Redis (shared with the rest of AppHub), SQLite (better-sqlite3) for persistence.
- **Processes**: Single codebase exports two entrypoints: `server.ts` (HTTP API & event subscription) and `worker.ts` (BullMQ worker processing tagging jobs).
- **Configuration**: `.env` with variables documented below.

## Core Components
1. **Event Subscriber**
   - Connects to Redis pub/sub channel `apphub:events` (configurable).
   - Filters for `repository.updated` events where `repository.ingestStatus === "ready"` and no recent successful tagging run exists.
   - Enqueues a BullMQ job (`tagging:<repositoryId>`), de-duplicated via jobId.

2. **Job Processor**
   - Steps per job:
     1. Fetch repository metadata from catalog (`GET /apps/:id`).
     2. Ensure repo checkout exists under a workspace path (`WORKSPACE_ROOT/<repositoryId>`); if missing or stale, run `git clone` using `repoUrl`.
     3. Ask File Explorer for candidate files (`GET /api/search` with repo root path) or, if unavailable, list files locally.
     4. Build an AI prompt summarizing repo metadata, README, and file excerpts.
     5. Call AI Connector (`POST /chat/completions`) with `response_format` to request tags: repository tags and file-level tags with optional confidence scores.
     6. Apply heuristics (e.g., dedupe, whitelist keys) and write tags:
        - Catalog call: `POST /apps/:id/tags` (batch payload).
        - File Explorer calls: `POST /api/tags` per file, optionally `DELETE /api/tags` for removed tags.
     7. Emit Redis event `tagging.completed` with summary, emit HTTP webhook if configured.
   - Store job history in SQLite (`jobs`, `job_runs`, `tags` tables) for auditing and replays.

3. **HTTP API**
   - `GET /healthz`: health status of dependencies (Redis, catalog, AI connector, file explorer).
   - `GET /jobs`: paginated list of recent tagging jobs with status (`queued`, `running`, `succeeded`, `failed`).
   - `POST /jobs/:repositoryId/retry`: enqueue a manual retry.
   - `GET /jobs/:id`: detailed run (prompts, tag diff, latency metrics, error if failed).
   - Optional `GET /openapi.json` generated via `fastify-oas`.

4. **Scheduler**
   - Periodic scan (every 6 hours) of catalog repositories to catch anything missed (fallback for lost Redis events).

## Data Model (SQLite)
- `jobs`: `id`, `repository_id`, `status`, `last_run_at`, `runs`, `created_at`, `updated_at`.
- `job_runs`: `id`, `job_id`, `status`, `started_at`, `completed_at`, `error_message`, `prompt_tokens`, `completion_tokens`, `cost_usd`, `latency_ms`, `raw_response`.
- `tag_assignments`: `id`, `job_run_id`, `scope` (`repository` | `file`), `target`, `key`, `value`, `confidence`, `applied_at`.

## External Contracts
- **Catalog**
  - `GET /apps/:id` (existing) for metadata.
  - `GET /apps/:id/history` for prior ingestion context if needed.
  - `POST /apps/:id/tags` (new endpoint from integration spec) body:
    ```json
    {
      "tags": [
        { "key": "language", "value": "typescript", "source": "tagging-service", "confidence": 0.92 }
      ],
      "remove": [ { "key": "language", "value": "unknown" } ]
    }
    ```
- **Better File Explorer**
  - `POST /api/tags` / `DELETE /api/tags` as defined in its OpenAPI.
  - `GET /api/tree` / `GET /api/file/stream` for browsing content.
- **AI Connector**
  - `POST /chat/completions` with payload enforcing `response_format` schema to guarantee structured tags.

## Configuration
| Variable | Description | Default |
| --- | --- | --- |
| `PORT` | HTTP port | 5103 |
| `REDIS_URL` | Redis connection string | `redis://127.0.0.1:6379` |
| `CATALOG_BASE_URL` | Catalog API endpoint | `http://127.0.0.1:4000` |
| `CATALOG_TOKEN` | Shared secret for `/apps/:id/tags` | required |
| `FILE_EXPLORER_BASE_URL` | Better File Explorer base URL | `http://127.0.0.1:4174` |
| `FILE_EXPLORER_TOKEN` | Optional auth header | optional |
| `AI_CONNECTOR_BASE_URL` | AI Connector endpoint | `http://127.0.0.1:8000` |
| `AI_CONNECTOR_MODEL` | Default model to request | `gpt-4o-mini` |
| `WORKSPACE_ROOT` | Directory storing cloned repos | `./workspace` |
| `TAGGING_CONCURRENCY` | Max concurrent BullMQ jobs | 2 |
| `TAGGING_PROMPT_TEMPLATE_PATH` | Path to prompt template | bundled default |

## Prompt & Response Schema
- Prompt assembled from template with placeholders: repo summary, file snippets, existing tags.
- Expected response schema enforced via `response_format`:
  ```json
  {
    "name": "tagging_response",
    "schema": {
      "type": "object",
      "properties": {
        "repository_tags": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "key": { "type": "string" },
              "value": { "type": "string" },
              "confidence": { "type": "number", "minimum": 0, "maximum": 1 }
            },
            "required": ["key", "value"]
          }
        },
        "file_tags": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": { "type": "string" },
              "tags": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "key": { "type": "string" },
                    "value": { "type": "string" },
                    "confidence": { "type": "number", "minimum": 0, "maximum": 1 }
                  },
                  "required": ["key", "value"]
                }
              }
            },
            "required": ["path", "tags"]
          }
        }
      },
      "required": ["repository_tags"]
    }
  }
  ```

## Error Handling & Retries
- BullMQ retries: 3 attempts per job, exponential backoff (500ms -> 5s).
- Distinguish between transient errors (network failures, 5xx) and permanent errors (invalid schema from AI). Permanent errors mark job failed and emit `tagging.failed` event.
- When catalog or file explorer calls fail persistently, store the tag diff locally and expose via `/jobs/:id` for manual replay.

## Observability
- Structured logging (`pino`) with jobId, repositoryId, duration, cost.
- Metrics endpoint (optional future): expose Prometheus counters (jobs processed, failures, tags applied).
- Publish `tagging.started`, `tagging.completed`, `tagging.failed` events to Redis with payload including repositoryId, jobId, status, counts.

## Testing Strategy
- Unit tests with Jest for:
  - Prompt builder (template expansion, file selection heuristics).
  - API clients mocking HTTP/Redis interactions.
  - Tag normalization/deduping logic.
- Integration tests using local Fastify mocks for catalog/file explorer and msw/httpx for AI connector responses.
- End-to-end smoke test script that:
  1. Creates a fake repository in catalog.
  2. Emits a `repository.updated` event.
  3. Confirms the service clones the repo, calls AI mock, applies tags, and records job success.

## Deployment Notes
- Package as Docker image with multi-stage build (install deps, compile TypeScript, copy dist, run with node).
- Provide `Procfile`/systemd guidance for running alongside other services.
- Ensure workspace cleanup job (daily cron) prunes old repo clones to avoid disk bloat.

