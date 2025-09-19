import { Queue } from 'bullmq';
import { createRedisClient } from '../lib/redis';
import { getConfig } from '../config';
import { logger } from '../lib/logger';
import { hasRecentSuccessfulRun } from '../db/jobStore';
import { TaggingJobData } from '../jobs/types';
import { taggingJobId } from '../queue';

interface RepositoryEventPayload {
  repository: {
    id: string;
    ingestStatus?: string;
  };
  [key: string]: unknown;
}

interface IncomingEvent {
  event: string;
  payload: RepositoryEventPayload;
}

const RECENCY_WINDOW_MS = 1000 * 60 * 60 * 12; // 12 hours

export class EventSubscriber {
  private readonly redis = createRedisClient({ enableAutoPipelining: true });
  private listening = false;
  private readonly messageListener = (_channel: string, message: string) => {
    void this.handleMessage(message).catch((err) => {
      logger.error({ err }, 'Failed to handle incoming event');
    });
  };

  constructor(private readonly queue: Queue) {}

  async start(): Promise<void> {
    if (this.listening) {
      return;
    }
    const { REDIS_EVENTS_CHANNEL } = getConfig();
    await this.redis.subscribe(REDIS_EVENTS_CHANNEL);
    this.redis.on('message', this.messageListener);
    this.redis.on('error', (err) => {
      logger.error({ err }, 'Redis subscriber error');
    });
    this.listening = true;
    logger.info({ channel: getConfig().REDIS_EVENTS_CHANNEL }, 'Subscribed to repository events');
  }

  async stop(): Promise<void> {
    if (!this.listening) {
      return;
    }
    const { REDIS_EVENTS_CHANNEL } = getConfig();
    this.redis.removeListener('message', this.messageListener);
    await this.redis.unsubscribe(REDIS_EVENTS_CHANNEL);
    this.listening = false;
    await this.redis.quit();
  }

  private async handleMessage(raw: string): Promise<void> {
    let parsed: IncomingEvent;
    try {
      parsed = JSON.parse(raw) as IncomingEvent;
    } catch (error) {
      logger.warn({ raw }, 'Ignoring non-JSON event payload');
      return;
    }

    if (!parsed?.event?.startsWith('repository.')) {
      return;
    }
    if (!parsed.payload?.repository?.id) {
      return;
    }
    const { repository } = parsed.payload;

    if (parsed.event === 'repository.updated' || parsed.event === 'repository.ingestion-event') {
      if (repository.ingestStatus !== 'ready') {
        return;
      }
      const repoId = repository.id;
      if (hasRecentSuccessfulRun(repoId, RECENCY_WINDOW_MS)) {
        logger.debug({ repoId }, 'Skipping event because repository was tagged recently');
        return;
      }
      await this.enqueueTaggingJob({ repositoryId: repoId, trigger: 'event' });
    }
  }

  private async enqueueTaggingJob(data: TaggingJobData): Promise<void> {
    const jobId = taggingJobId(data.repositoryId);
    await this.queue.add('tag-repository', data, { jobId });
    logger.info({ repositoryId: data.repositoryId }, 'Enqueued tagging job from event');
  }
}
