import fastify from 'fastify';
import type { FastifyBaseLogger } from 'fastify';
import fastifySensible from 'fastify-sensible';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import websocketPlugin from '@fastify/websocket';
import type { SocketStream } from '@fastify/websocket';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getConfig } from '../config';
import { logger } from '../lib/logger';
import { buildQueueComponents, taggingJobId } from '../queue';
import { EventSubscriber } from '../events/subscriber';
import { Scheduler } from '../scheduler';
import { runHealthChecks } from './health';
import { DashboardHub } from './dashboardHub';
import {
  countJobs,
  getAssignmentsForRun,
  getJobById,
  getJobRunById,
  listRecentJobs,
  upsertJob
} from '../db/jobStore';
import { TaggingJobData } from '../jobs/types';

async function main(): Promise<void> {
  const config = getConfig();
  const baseApp = fastify({ logger: logger as unknown as FastifyBaseLogger });
  baseApp.setValidatorCompiler(validatorCompiler);
  baseApp.setSerializerCompiler(serializerCompiler);
  const app = baseApp.withTypeProvider<ZodTypeProvider>();

  const { queue, queueEvents } = buildQueueComponents();
  await queue.waitUntilReady();
  await queueEvents.waitUntilReady();
  const dashboard = new DashboardHub(queue);
  await dashboard.bootstrap();

  const recordQueueTransition = async (
    type: 'job-enqueued' | 'job-started' | 'job-completed' | 'job-failed',
    jobId: string | number | null | undefined,
    summary: string,
    details?: Record<string, unknown>
  ) => {
    const normalizedJobId = jobId != null ? String(jobId) : undefined;
    let repositoryId: string | undefined;
    let jobDetails: Record<string, unknown> | undefined;

    if (normalizedJobId) {
      try {
        const job = await queue.getJob(normalizedJobId);
        if (job) {
          const data = job.data as Partial<TaggingJobData>;
          repositoryId = data.repositoryId;
          jobDetails = {
            attemptsMade: job.attemptsMade,
            processedOn: job.processedOn,
            finishedOn: job.finishedOn,
            data
          };
        }
      } catch (error) {
        logger.warn({ jobId: normalizedJobId, error }, 'Failed to load job for dashboard event');
      }
    }

    const message = repositoryId
      ? `Repository ${repositoryId} ${summary}`
      : `Job ${normalizedJobId ?? 'unknown'} ${summary}`;

    const mergedDetails: Record<string, unknown> | undefined = (() => {
      if (!details && !jobDetails) {
        return undefined;
      }
      return {
        ...(details ?? {}),
        ...(jobDetails ? { job: jobDetails } : {})
      };
    })();

    await dashboard.recordJobEvent(type, {
      repositoryId,
      jobId: normalizedJobId,
      message,
      details: mergedDetails
    });
  };

  queueEvents.on('waiting', ({ jobId }) => {
    recordQueueTransition('job-enqueued', jobId, 'was enqueued').catch((error) => {
      logger.warn({ jobId, error }, 'Failed to record enqueued job event');
    });
  });
  queueEvents.on('active', ({ jobId }) => {
    recordQueueTransition('job-started', jobId, 'started processing').catch((error) => {
      logger.warn({ jobId, error }, 'Failed to record started job event');
    });
  });
  queueEvents.on('completed', ({ jobId, returnvalue }) => {
    recordQueueTransition('job-completed', jobId, 'completed successfully', {
      returnValue: returnvalue
    }).catch((error) => {
      logger.warn({ jobId, error }, 'Failed to record completed job event');
    });
  });
  queueEvents.on('failed', ({ jobId, failedReason }) => {
    logger.error({ jobId, failedReason }, 'Queue job failed');
    recordQueueTransition(
      'job-failed',
      jobId,
      failedReason ? `failed: ${failedReason}` : 'failed',
      failedReason ? { failedReason } : undefined
    ).catch((error) => {
      logger.warn({ jobId, error }, 'Failed to record failed job event');
    });
  });

  const eventSubscriber = new EventSubscriber(queue, (event) => dashboard.recordRepositoryEvent(event));
  const manualScheduler = new Scheduler(queue);

  await app.register(fastifySensible);
  await app.register(websocketPlugin);
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Tagging Service API',
        description: 'HTTP interface for the tagging service job queue',
        version: '0.1.0'
      }
    }
  });
  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list'
    }
  });

  app.get('/', async (_request, reply) => {
    return reply.type('text/html').send(buildDashboardHtml());
  });

  app.get('/ws', { websocket: true }, (connection: SocketStream) => {
    dashboard.addClient(connection.socket);
  });

  const jobsQuerySchema = z.object({
    page: z.coerce.number().int().min(1).default(1),
    perPage: z.coerce.number().int().min(1).max(100).default(20)
  });

  app.get('/healthz', async () => {
    const report = await runHealthChecks(queue);
    return report;
  });

  app.get('/jobs', {
    schema: {
      querystring: jobsQuerySchema,
      response: {
        200: z.object({
          page: z.number(),
          perPage: z.number(),
          total: z.number(),
          jobs: z.array(
            z.object({
              id: z.number(),
              repositoryId: z.string(),
              status: z.string(),
              lastRunAt: z.string().nullable(),
              runs: z.number(),
              latestRunId: z.number().nullable(),
              latestRunStatus: z.string().nullable(),
              latestCompletedAt: z.string().nullable()
            })
          )
        })
      }
    }
  }, async (request) => {
    const { page, perPage } = request.query;
    const offset = (page - 1) * perPage;
    const jobs = listRecentJobs(perPage, offset).map((job) => ({
      id: job.id,
      repositoryId: job.repository_id,
      status: job.status,
      lastRunAt: job.last_run_at,
      runs: job.runs,
      latestRunId: job.latest_run_id,
      latestRunStatus: job.latest_run_status,
      latestCompletedAt: job.latest_completed_at
    }));

    const total = countJobs();

    return { page, perPage, total, jobs };
  });

  app.post('/jobs/:repositoryId/retry', {
    schema: {
      params: z.object({
        repositoryId: z.string().min(1)
      }),
      response: {
        202: z.object({
          repositoryId: z.string(),
          jobId: z.string()
        })
      }
    }
  }, async (request, reply) => {
    const { repositoryId } = request.params;
    upsertJob(repositoryId);
    const data: TaggingJobData = {
      repositoryId,
      trigger: 'manual',
      reason: 'Manual retry via API'
    };

    const jobId = taggingJobId(repositoryId);
    try {
      await queue.add('tag-repository', data, { jobId });
    } catch (error) {
      if (error instanceof Error && error.message.includes('already exists')) {
        logger.warn({ repositoryId }, 'Job already queued, skipping duplicate');
      } else {
        throw error;
      }
    }

    return reply.code(202).send({ repositoryId, jobId });
  });

  app.get('/jobs/:runId', {
    schema: {
      params: z.object({
        runId: z.coerce.number().int().min(1)
      }),
      response: {
        200: z.object({
          jobRun: z.object({
            id: z.number(),
            jobId: z.number(),
            repositoryId: z.string(),
            status: z.string(),
            startedAt: z.string(),
            completedAt: z.string().nullable(),
            prompt: z.string().nullable(),
            errorMessage: z.string().nullable(),
            metrics: z.object({
              promptTokens: z.number().nullable(),
              completionTokens: z.number().nullable(),
              costUsd: z.number().nullable(),
              latencyMs: z.number().nullable()
            })
          }),
          assignments: z.object({
            repository: z.array(
              z.object({
                key: z.string(),
                value: z.string(),
                confidence: z.number().nullable()
              })
            ),
            files: z.array(
              z.object({
                path: z.string(),
                tags: z.array(
                  z.object({
                    key: z.string(),
                    value: z.string(),
                    confidence: z.number().nullable()
                  })
                )
              })
            )
          }),
          rawResponse: z.unknown().nullable()
        })
      }
    }
  }, async (request) => {
    const runId = request.params.runId;
    const run = getJobRunById(runId);
    const job = getJobById(run.job_id);
    const assignments = getAssignmentsForRun(runId);

    const repositoryAssignments = assignments
      .filter((a) => a.scope === 'repository')
      .map((a) => ({ key: a.key, value: a.value, confidence: a.confidence }));

    const fileAssignmentsMap = new Map<string, { path: string; tags: Array<{ key: string; value: string; confidence: number | null }> }>();
    for (const assignment of assignments.filter((a) => a.scope === 'file')) {
      if (!fileAssignmentsMap.has(assignment.target)) {
        fileAssignmentsMap.set(assignment.target, { path: assignment.target, tags: [] });
      }
      fileAssignmentsMap.get(assignment.target)?.tags.push({
        key: assignment.key,
        value: assignment.value,
        confidence: assignment.confidence
      });
    }

    let rawResponse: unknown = null;
    if (run.raw_response) {
      try {
        rawResponse = JSON.parse(run.raw_response);
      } catch (error) {
        rawResponse = { parsingError: (error as Error).message, raw: run.raw_response };
      }
    }

    return {
      jobRun: {
        id: run.id,
        jobId: run.job_id,
        repositoryId: job.repository_id,
        status: run.status,
        startedAt: run.started_at,
        completedAt: run.completed_at,
        prompt: run.prompt,
        errorMessage: run.error_message,
        metrics: {
          promptTokens: run.prompt_tokens,
          completionTokens: run.completion_tokens,
          costUsd: run.cost_usd,
          latencyMs: run.latency_ms
        }
      },
      assignments: {
        repository: repositoryAssignments,
        files: Array.from(fileAssignmentsMap.values())
      },
      rawResponse
    };
  });

  app.get('/openapi.json', async (_request, reply) => {
    return reply.send(app.swagger());
  });

  await eventSubscriber.start();
  manualScheduler.start();

  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  logger.info({ port: config.PORT }, 'Tagging service API listening');

  let shuttingDown = false;

  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info('Shutting down API server');
    manualScheduler.stop();
    await eventSubscriber.stop();
    await queueEvents.close();
    await queue.close();
    await app.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function buildDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Tagging Service Dashboard</title>
    <style>
      :root {
        color-scheme: light dark;
        --bg: #0f172a;
        --surface: rgba(15, 23, 42, 0.8);
        --surface-light: rgba(255, 255, 255, 0.08);
        --text: #f8fafc;
        --muted: #94a3b8;
        --accent: #38bdf8;
        --success: #22c55e;
        --warning: #facc15;
        --danger: #f87171;
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      }

      body {
        margin: 0;
        min-height: 100vh;
        background: radial-gradient(circle at top, #1e293b, #020617 70%);
        color: var(--text);
      }

      .dashboard {
        max-width: 1200px;
        margin: 0 auto;
        padding: 32px 16px 48px;
      }

      header {
        display: flex;
        flex-direction: column;
        gap: 8px;
        margin-bottom: 32px;
      }

      header h1 {
        margin: 0;
        font-size: 2rem;
        letter-spacing: 0.02em;
      }

      .status-line {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        align-items: center;
        font-size: 0.95rem;
        color: var(--muted);
      }

      .connection-status {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 4px 8px;
        border-radius: 12px;
        background: var(--surface-light);
      }

      .connection-status::before {
        content: '';
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--warning);
      }

      .connection-status.connected::before {
        background: var(--success);
      }

      .connection-status.disconnected::before {
        background: var(--danger);
      }

      .cards {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
        gap: 16px;
        margin-bottom: 32px;
      }

      .card {
        background: var(--surface);
        backdrop-filter: blur(18px);
        border-radius: 16px;
        padding: 20px;
        box-shadow: 0 8px 24px rgba(15, 23, 42, 0.35);
        display: flex;
        flex-direction: column;
        gap: 6px;
      }

      .metric-label {
        font-size: 0.95rem;
        color: var(--muted);
      }

      .metric-value {
        font-size: 2.25rem;
        font-weight: 600;
        letter-spacing: 0.01em;
      }

      .event-stream {
        background: var(--surface);
        backdrop-filter: blur(18px);
        border-radius: 16px;
        padding: 20px;
        box-shadow: 0 8px 32px rgba(15, 23, 42, 0.4);
      }

      .event-stream h2 {
        margin: 0 0 16px;
        font-size: 1.4rem;
      }

      #event-list {
        list-style: none;
        padding: 0;
        margin: 0;
        display: flex;
        flex-direction: column;
        gap: 12px;
        max-height: 420px;
        overflow-y: auto;
      }

      #event-list li {
        border-left: 3px solid transparent;
        padding: 12px 16px;
        border-radius: 12px;
        background: rgba(15, 23, 42, 0.65);
      }

      #event-list li.event-repository-event {
        border-color: var(--accent);
      }

      #event-list li.event-job-enqueued {
        border-color: var(--warning);
      }

      #event-list li.event-job-started {
        border-color: var(--accent);
      }

      #event-list li.event-job-completed {
        border-color: var(--success);
      }

      #event-list li.event-job-failed {
        border-color: var(--danger);
      }

      .event-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
        margin-bottom: 6px;
      }

      .event-type {
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        font-size: 0.75rem;
        color: var(--muted);
      }

      .event-time {
        font-size: 0.85rem;
        color: var(--muted);
      }

      .event-message {
        font-size: 1rem;
        line-height: 1.4;
      }

      .event-details {
        margin-top: 8px;
        font-size: 0.8rem;
        color: var(--muted);
        background: rgba(15, 23, 42, 0.55);
        padding: 8px;
        border-radius: 8px;
        overflow-x: auto;
      }

      @media (max-width: 640px) {
        .dashboard {
          padding: 24px 12px 36px;
        }

        header h1 {
          font-size: 1.6rem;
        }

        .metric-value {
          font-size: 1.8rem;
        }
      }
    </style>
  </head>
  <body>
    <div class="dashboard">
      <header>
        <h1>Tagging Service Monitor</h1>
        <div class="status-line">
          <span id="connection-status" class="connection-status">Connecting…</span>
          <span>Last update: <strong id="updated-at">—</strong></span>
        </div>
      </header>
      <section class="cards" aria-label="Job summary metrics">
        <article class="card" data-metric="totalJobs">
          <span class="metric-label">Tracked Repositories</span>
          <span class="metric-value">0</span>
        </article>
        <article class="card" data-metric="queuedJobs">
          <span class="metric-label">Queued Jobs</span>
          <span class="metric-value">0</span>
        </article>
        <article class="card" data-metric="runningJobs">
          <span class="metric-label">Running Jobs</span>
          <span class="metric-value">0</span>
        </article>
        <article class="card" data-metric="succeededJobs">
          <span class="metric-label">Succeeded Jobs</span>
          <span class="metric-value">0</span>
        </article>
        <article class="card" data-metric="failedJobs">
          <span class="metric-label">Failed Jobs</span>
          <span class="metric-value">0</span>
        </article>
      </section>
      <section class="cards" aria-label="Queue metrics">
        <article class="card" data-queue="waiting">
          <span class="metric-label">Waiting</span>
          <span class="metric-value">0</span>
        </article>
        <article class="card" data-queue="active">
          <span class="metric-label">Active</span>
          <span class="metric-value">0</span>
        </article>
        <article class="card" data-queue="completed">
          <span class="metric-label">Completed (retained)</span>
          <span class="metric-value">0</span>
        </article>
        <article class="card" data-queue="failed">
          <span class="metric-label">Failed (retained)</span>
          <span class="metric-value">0</span>
        </article>
        <article class="card" data-queue="delayed">
          <span class="metric-label">Delayed</span>
          <span class="metric-value">0</span>
        </article>
      </section>
      <section class="event-stream" aria-label="Event stream">
        <h2>Recent Activity</h2>
        <ul id="event-list" aria-live="polite"></ul>
      </section>
    </div>
    <script>
      (() => {
        const statusEl = document.getElementById('connection-status');
        const updatedAtEl = document.getElementById('updated-at');
        const summaryEls = {
          totalJobs: document.querySelector('[data-metric="totalJobs"] .metric-value'),
          queuedJobs: document.querySelector('[data-metric="queuedJobs"] .metric-value'),
          runningJobs: document.querySelector('[data-metric="runningJobs"] .metric-value'),
          succeededJobs: document.querySelector('[data-metric="succeededJobs"] .metric-value'),
          failedJobs: document.querySelector('[data-metric="failedJobs"] .metric-value')
        };
        const queueEls = {
          waiting: document.querySelector('[data-queue="waiting"] .metric-value'),
          active: document.querySelector('[data-queue="active"] .metric-value'),
          completed: document.querySelector('[data-queue="completed"] .metric-value'),
          failed: document.querySelector('[data-queue="failed"] .metric-value'),
          delayed: document.querySelector('[data-queue="delayed"] .metric-value')
        };
        const eventsList = document.getElementById('event-list');

        function setStatus(text, state) {
          statusEl.textContent = text;
          statusEl.classList.remove('connected', 'disconnected', 'connecting');
          if (state) {
            statusEl.classList.add(state);
          }
        }

        function formatTimestamp(value) {
          if (!value) {
            return '—';
          }
          const date = new Date(value);
          if (Number.isNaN(date.getTime())) {
            return value;
          }
          return date.toLocaleString();
        }

        function formatType(type) {
          return (
            {
              'repository-event': 'Repository Event',
              'job-enqueued': 'Job Enqueued',
              'job-started': 'Job Started',
              'job-completed': 'Job Completed',
              'job-failed': 'Job Failed'
            }[type] || type
          );
        }

        function renderEvents(events) {
          eventsList.innerHTML = '';
          (events || []).forEach((event) => {
            const item = document.createElement('li');
            item.classList.add('event', 'event-' + event.type);

            const header = document.createElement('div');
            header.className = 'event-header';

            const typeEl = document.createElement('span');
            typeEl.className = 'event-type';
            typeEl.textContent = formatType(event.type);

            const timeEl = document.createElement('span');
            timeEl.className = 'event-time';
            timeEl.textContent = formatTimestamp(event.timestamp);

            header.appendChild(typeEl);
            header.appendChild(timeEl);
            item.appendChild(header);

            const messageEl = document.createElement('div');
            messageEl.className = 'event-message';
            const parts = [];
            if (event.repositoryId) {
              parts.push(event.repositoryId);
            }
            parts.push(event.message);
            messageEl.textContent = parts.join(' — ');
            item.appendChild(messageEl);

            if (event.details && Object.keys(event.details).length > 0) {
              const detailsEl = document.createElement('pre');
              detailsEl.className = 'event-details';
              detailsEl.textContent = JSON.stringify(event.details, null, 2);
              item.appendChild(detailsEl);
            }

            eventsList.appendChild(item);
          });
        }

        function updateSnapshot(snapshot) {
          if (!snapshot) {
            return;
          }
          updatedAtEl.textContent = formatTimestamp(snapshot.generatedAt);

          if (snapshot.summary) {
            Object.entries(summaryEls).forEach(([key, el]) => {
              if (!el) return;
              const value = snapshot.summary[key] ?? 0;
              el.textContent = Number.isFinite(value) ? value.toLocaleString() : String(value);
            });
          }

          if (snapshot.queue) {
            Object.entries(queueEls).forEach(([key, el]) => {
              if (!el) return;
              const value = snapshot.queue[key] ?? 0;
              el.textContent = Number.isFinite(value) ? value.toLocaleString() : String(value);
            });
          }

          renderEvents(snapshot.events);
        }

        function connect() {
          setStatus('Connecting…', 'connecting');
          const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
          const socket = new WebSocket(protocol + '://' + window.location.host + '/ws');

          socket.addEventListener('open', () => {
            setStatus('Connected', 'connected');
          });

          socket.addEventListener('close', () => {
            setStatus('Disconnected – retrying…', 'disconnected');
            setTimeout(connect, 2000);
          });

          socket.addEventListener('error', () => {
            socket.close();
          });

          socket.addEventListener('message', (event) => {
            try {
              const payload = JSON.parse(event.data);
              if (payload && payload.type === 'snapshot') {
                updateSnapshot(payload.payload);
              }
            } catch (err) {
              console.error('Failed to parse dashboard payload', err);
            }
          });
        }

        connect();
      })();
    </script>
  </body>
</html>`;
}

void main().catch(async (err) => {
  logger.error({ err }, 'Failed to start server');
  process.exit(1);
});
