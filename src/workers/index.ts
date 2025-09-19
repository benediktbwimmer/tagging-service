import { Worker } from 'bullmq';
import { getConfig } from '../config';
import { logger } from '../lib/logger';
import { TaggingProcessor } from '../jobs/taggingProcessor';
import { TaggingJobData } from '../jobs/types';
import { PermanentJobError } from '../jobs/errors';
import { TAGGING_QUEUE_NAME } from '../queue';

async function main(): Promise<void> {
  const config = getConfig();
  const processor = new TaggingProcessor();

  const worker = new Worker(
    TAGGING_QUEUE_NAME,
    async (job) => {
      const data = job.data as TaggingJobData;
      try {
        return await processor.process(data);
      } catch (error) {
        if (error instanceof PermanentJobError) {
          await job.discard();
        }
        throw error;
      }
    },
    {
      connection: { connectionString: config.REDIS_URL },
      concurrency: config.TAGGING_CONCURRENCY
    }
  );

  worker.on('completed', (job) => {
    logger.info({ jobId: job.id }, 'Tagging job completed');
  });

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, 'Tagging job failed');
  });

  const shutdown = async () => {
    logger.info('Shutting down worker');
    await worker.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void main().catch((err) => {
  logger.error({ err }, 'Worker failed to start');
  process.exit(1);
});
