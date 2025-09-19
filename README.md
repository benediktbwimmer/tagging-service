# Tagging Service

A standalone TypeScript service that orchestrates automated repository tagging by reacting to catalog events, running AI-assisted analysis against repository contents, and synchronising structured tags back to AppHub systems. The implementation follows the specification in `docs/SPEC_initial.md`.

## Features
- Subscribes to Redis `repository.updated` and `repository.ingestion-event` notifications and enqueues idempotent BullMQ jobs per repository.
- Processes jobs in a dedicated worker that clones or refreshes repositories, samples relevant files, builds an AI prompt, and applies repository/file tags via the Catalog and Better File Explorer APIs.
- Persists jobs, job runs, and tag assignments in SQLite for audit and replay.
- Publishes lifecycle events to Redis and optional webhooks.
- Exposes a Fastify-based API for health reporting, job inspection, and manual retries, plus auto-generated OpenAPI docs.
- Includes a periodic scheduler to backfill repositories that may have missed events.

## Getting Started
1. **Install dependencies**
   ```bash
   npm install
   ```
2. **Prepare environment variables**
   Copy `.env.example` to `.env` and adjust values for your installation.
3. **Run database migrations**
   Migrations execute automatically on first startup; no manual step is required.
4. **Start the API server**
   ```bash
   npm run start:dev
   ```
5. **Start the worker**
   In a separate shell:
   ```bash
   npm run worker:dev
   ```

The API listens on `PORT` (default `5103`) and exposes `/healthz`, `/jobs`, `/jobs/:runId`, `/jobs/:repositoryId/retry`, and `/openapi.json`. Swagger UI is served at `/docs`.

## Testing
Run the Jest test suite:
```bash
npm test
```

## Project Structure
- `src/config` – configuration loading and validation.
- `src/db` – SQLite access layer and schema management.
- `src/jobs` – tagging job orchestration, AI integration, and tag heuristics.
- `src/clients` – HTTP clients for Catalog, File Explorer, and AI connector.
- `src/events` – Redis publisher/subscriber utilities and webhook notifier.
- `src/scheduler` – catalog backfill scheduler.
- `src/server` – Fastify HTTP server and health checks.
- `src/workers` – BullMQ worker entrypoint.

## Key Environment Variables
| Variable | Purpose |
| --- | --- |
| `PORT` | HTTP port for the API server |
| `REDIS_URL` | Connection string for Redis (queue + pub/sub) |
| `REDIS_EVENTS_CHANNEL` | Redis pub/sub channel for ingestion events |
| `CATALOG_BASE_URL` / `CATALOG_TOKEN` | Catalog API endpoint and shared secret |
| `FILE_EXPLORER_BASE_URL` / `FILE_EXPLORER_TOKEN` | Better File Explorer endpoint and optional token |
| `AI_CONNECTOR_BASE_URL` / `AI_CONNECTOR_MODEL` | AI connector endpoint and model name |
| `WORKSPACE_ROOT` | Directory for cloned repositories |
| `DATABASE_PATH` | SQLite database location |
| `TAGGING_PROMPT_TEMPLATE_PATH` | Prompt template used for AI requests |
| `WEBHOOK_URL` | Optional webhook for job lifecycle notifications |

## Operational Notes
- The scheduler runs every six hours and only re-enqueues repositories without a successful run in the past 24 hours.
- BullMQ job attempts default to three with exponential backoff. Permanent failures skip retries via worker-side discard logic.
- Health checks probe Redis, BullMQ, Catalog, File Explorer, and AI connector endpoints to surface dependency status.
