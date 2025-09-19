import { performance } from 'node:perf_hooks';
import { CatalogClient } from '../clients/catalog';
import { FileExplorerClient } from '../clients/fileExplorer';
import { AiConnectorClient } from '../clients/aiConnector';
import { gatherFileSummaries } from './fileDiscovery';
import { buildPrompt } from '../utils/prompt';
import { normalizeRepositoryTags, normalizeFileTags } from './tagNormalization';
import { diffRepositoryTags, diffFileTags } from './tagDiff';
import { ensureRepositoryCheckout } from '../utils/git';
import { logger } from '../lib/logger';
import { EventPublisher } from '../events/publisher';
import { WebhookNotifier } from '../events/webhook';
import { completeJobRun, recordTagAssignments, startJobRun, upsertJob } from '../db/jobStore';
import {
  TaggingJobData,
  TaggingJobResult,
  PromptContext,
  TagPayload,
  FileTagPayload,
  RepositoryMetadataTag
} from './types';
import { PermanentJobError, TransientJobError } from './errors';

const SOURCE = 'tagging-service';

export class TaggingProcessor {
  private readonly catalogClient = new CatalogClient();
  private readonly fileExplorerClient = new FileExplorerClient();
  private readonly aiClient = new AiConnectorClient();
  private readonly events = new EventPublisher();
  private readonly webhook = new WebhookNotifier();

  async process(jobData: TaggingJobData): Promise<TaggingJobResult> {
    const { repositoryId } = jobData;
    const jobRecord = upsertJob(repositoryId);
    const jobRun = startJobRun(jobRecord.id);
    const started = performance.now();
    let prompt: string | null = null;
    let repositoryTags: TagPayload[] = [];
    let fileTags: FileTagPayload[] = [];
    let rawResponse: unknown = undefined;

    logger.info({ repositoryId, jobRunId: jobRun.id }, 'Processing tagging job');

    try {
      const metadata = await this.catalogClient.getRepository(repositoryId);
      const repoUrl = (metadata as { repoUrl?: string; repositoryUrl?: string }).repoUrl ??
        (metadata as { repositoryUrl?: string }).repositoryUrl;

      if (!repoUrl) {
        throw new PermanentJobError('Repository metadata missing repoUrl');
      }

      const repoPath = await ensureRepositoryCheckout({
        repositoryId,
        repoUrl,
        defaultBranch: metadata.defaultBranch
      });

      const fileSummaries = await gatherFileSummaries(repositoryId, repoPath, this.fileExplorerClient);
      const existingTagsForPrompt: TagPayload[] = (metadata.tags ?? []).map((tag) => ({
        key: tag.key,
        value: tag.value
      }));

      const taggingServiceTags = selectTaggingServiceTags(metadata.tags ?? []);
      const promptContext: PromptContext = {
        repository: {
          id: metadata.id,
          name: metadata.name ?? repositoryId,
          repoUrl,
          defaultBranch: metadata.defaultBranch,
          description: metadata.description,
          readme: metadata.readme,
          tags: metadata.tags
        },
        fileSummaries,
        existingTags: existingTagsForPrompt
      };

      prompt = await buildPrompt(promptContext);
      const aiResult = await this.aiClient.generateTags(prompt);
      rawResponse = aiResult.response;

      repositoryTags = normalizeRepositoryTags(aiResult.response.repository_tags ?? []);
      fileTags = normalizeFileTags(aiResult.response.file_tags ?? []);

      const repoDiff = diffRepositoryTags(repositoryTags, taggingServiceTags);
      const fileDiff = diffFileTags(fileTags);

      await this.applyRepositoryTags(repositoryId, repoDiff.apply, repoDiff.remove);
      await this.applyFileTags(repositoryId, fileDiff.apply, fileDiff.remove);

      recordTagAssignments(
        jobRun.id,
        [
          ...repositoryTags.map((tag) => ({
            scope: 'repository' as const,
            target: repositoryId,
            key: tag.key,
            value: tag.value,
            confidence: tag.confidence
          })),
          ...fileTags.flatMap((file) =>
            file.tags.map((tag) => ({
              scope: 'file' as const,
              target: file.path,
              key: tag.key,
              value: tag.value,
              confidence: tag.confidence
            }))
          )
        ]
      );

      const completedRun = completeJobRun(jobRun.id, {
        status: 'succeeded',
        prompt,
        promptTokens: aiResult.metrics.promptTokens ?? null,
        completionTokens: aiResult.metrics.completionTokens ?? null,
        latencyMs: Math.round(performance.now() - started),
        rawResponse
      });

      await this.events.publish('tagging.completed', {
        repositoryId,
        jobRunId: completedRun.id,
        repositoryTags: repositoryTags.length,
        fileTags: fileTags.reduce((sum, file) => sum + file.tags.length, 0),
        trigger: jobData.trigger
      });
      await this.webhook.emit('tagging.completed', {
        repositoryId,
        jobRunId: completedRun.id,
        repositoryTags: repositoryTags.length,
        fileTags: fileTags.reduce((sum, file) => sum + file.tags.length, 0),
        trigger: jobData.trigger
      });

      return {
        repositoryTags,
        fileTags,
        rawResponse,
        prompt: prompt ?? '',
        metrics: {
          promptTokens: completedRun.prompt_tokens ?? undefined,
          completionTokens: completedRun.completion_tokens ?? undefined,
          latencyMs: completedRun.latency_ms ?? undefined
        }
      };
    } catch (error) {
      const latency = Math.round(performance.now() - started);
      const message = error instanceof Error ? error.message : 'Unknown error';
      completeJobRun(jobRun.id, {
        status: 'failed',
        errorMessage: message,
        prompt,
        latencyMs: latency,
        rawResponse
      });

      const transient = error instanceof TransientJobError;
      await this.events.publish('tagging.failed', {
        repositoryId,
        jobRunId: jobRun.id,
        message,
        trigger: jobData.trigger,
        transient
      });
      await this.webhook.emit('tagging.failed', {
        repositoryId,
        jobRunId: jobRun.id,
        message,
        trigger: jobData.trigger,
        transient
      });

      logger.error({ repositoryId, jobRunId: jobRun.id, err: error }, 'Tagging job failed');
      throw error;
    }
  }

  private async applyRepositoryTags(
    repositoryId: string,
    tags: TagPayload[],
    remove: Array<{ key: string; value: string }>
  ): Promise<void> {
    if (!tags.length && !remove.length) {
      return;
    }
    try {
      await this.catalogClient.postTags(repositoryId, {
        tags: tags.map((tag) => ({
          key: tag.key,
          value: tag.value,
          source: SOURCE,
          confidence: tag.confidence
        })),
        remove
      });
    } catch (error) {
      throw new TransientJobError('Failed to post repository tags to catalog', error);
    }
  }

  private async applyFileTags(
    repositoryId: string,
    apply: FileTagPayload[],
    remove: FileTagPayload[]
  ): Promise<void> {
    for (const file of apply) {
      try {
        await this.fileExplorerClient.applyFileTags(repositoryId, file);
      } catch (error) {
        throw new TransientJobError(`Failed to apply file tags for ${file.path}`, error);
      }
    }

    for (const file of remove) {
      try {
        await this.fileExplorerClient.removeFileTags(repositoryId, { path: file.path, tags: file.tags });
      } catch (error) {
        throw new TransientJobError(`Failed to remove file tags for ${file.path}`, error);
      }
    }
  }
}

function selectTaggingServiceTags(tags: RepositoryMetadataTag[]): TagPayload[] {
  return normalizeRepositoryTags(
    tags
      .filter((tag) => !tag.source || tag.source === SOURCE)
      .map((tag) => ({ key: tag.key, value: tag.value }))
  );
}
