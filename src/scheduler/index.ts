import { Queue } from 'bullmq';
import { CatalogClient } from '../clients/catalog';
import { logger } from '../lib/logger';
import { hasRecentSuccessfulRun } from '../db/jobStore';
import { TaggingJobData } from '../jobs/types';
import { taggingJobId } from '../queue';

const DEFAULT_INTERVAL_MS = 1000 * 60 * 60 * 6; // 6 hours
const FALLBACK_RECENCY_WINDOW_MS = 1000 * 60 * 60 * 24; // 24 hours

interface CatalogRepositorySummary {
  id: string;
  ingestStatus?: string;
}

export class Scheduler {
  private readonly catalogClient = new CatalogClient();
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(private readonly queue: Queue, private readonly intervalMs = DEFAULT_INTERVAL_MS) {}

  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.runCycle();
    }, this.intervalMs);
    void this.runCycle();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async runCycle(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;

    try {
      let page = 1;
      const perPage = 50;
      while (true) {
        const repos = (await this.catalogClient.listRepositories({ page, perPage })) as CatalogRepositorySummary[];
        if (!repos.length) {
          break;
        }
        for (const repo of repos) {
          await this.maybeEnqueueRepository(repo);
        }
        if (repos.length < perPage) {
          break;
        }
        page += 1;
      }
    } catch (error) {
      logger.error({ err: error }, 'Scheduler run failed');
    } finally {
      this.running = false;
    }
  }

  private async maybeEnqueueRepository(repo: CatalogRepositorySummary): Promise<void> {
    if (!repo.id) {
      return;
    }
    if (repo.ingestStatus && repo.ingestStatus !== 'ready') {
      return;
    }
    if (hasRecentSuccessfulRun(repo.id, FALLBACK_RECENCY_WINDOW_MS)) {
      return;
    }

    const data: TaggingJobData = { repositoryId: repo.id, trigger: 'scheduler' };
    await this.queue.add('tag-repository', data, { jobId: taggingJobId(repo.id) });
    logger.info({ repositoryId: repo.id }, 'Scheduler enqueued repository');
  }
}
