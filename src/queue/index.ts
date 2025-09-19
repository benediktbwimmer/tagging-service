import { Queue, QueueEvents, QueueScheduler, JobsOptions } from 'bullmq';
import { getConfig } from '../config';

export const TAGGING_QUEUE_NAME = 'tagging-service:jobs';

export interface TaggingQueueComponents {
  queue: Queue;
  queueEvents: QueueEvents;
  scheduler: QueueScheduler;
}

export function buildQueueComponents(): TaggingQueueComponents {
  const { REDIS_URL } = getConfig();
  const connection = { connectionString: REDIS_URL };

  const queue = new Queue(TAGGING_QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 500 },
      removeOnComplete: 1000,
      removeOnFail: 2000
    }
  });
  const queueEvents = new QueueEvents(TAGGING_QUEUE_NAME, { connection });
  const scheduler = new QueueScheduler(TAGGING_QUEUE_NAME, { connection });

  return { queue, queueEvents, scheduler };
}

export function taggingJobId(repositoryId: string): string {
  return `tagging:${repositoryId}`;
}

export function taggingJobOptions(overrides: JobsOptions = {}): JobsOptions {
  return {
    attempts: 3,
    backoff: { type: 'exponential', delay: 500 },
    removeOnComplete: 1000,
    removeOnFail: 2000,
    ...overrides
  };
}
