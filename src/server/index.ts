import fastify from 'fastify';
import type { FastifyBaseLogger } from 'fastify';
import fastifySensible from 'fastify-sensible';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getConfig } from '../config';
import { logger } from '../lib/logger';
import { buildQueueComponents, taggingJobId } from '../queue';
import { EventSubscriber } from '../events/subscriber';
import { Scheduler } from '../scheduler';
import { runHealthChecks } from './health';
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
  queueEvents.on('failed', ({ jobId, failedReason }) => {
    logger.error({ jobId, failedReason }, 'Queue job failed');
  });

  const eventSubscriber = new EventSubscriber(queue);
  const manualScheduler = new Scheduler(queue);

  await app.register(fastifySensible);
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

void main().catch(async (err) => {
  logger.error({ err }, 'Failed to start server');
  process.exit(1);
});
