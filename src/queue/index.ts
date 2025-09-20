import { createHash } from 'node:crypto';
import { Queue, QueueEvents, JobsOptions } from 'bullmq';
import { getConfig } from '../config';

export const TAGGING_QUEUE_NAME = 'tagging-service-jobs';

export interface TaggingQueueComponents {
  queue: Queue;
  queueEvents: QueueEvents;
}

export function buildQueueComponents(): TaggingQueueComponents {
  const { REDIS_URL } = getConfig();
  const connection = { url: REDIS_URL };

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

  return { queue, queueEvents };
}

export function taggingJobId(repositoryId: string): string {
  const digest = createHash('sha1').update(repositoryId).digest('hex');
  return `tagging-${digest}`;
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
