export type TaggingJobTrigger = 'event' | 'manual' | 'scheduler';

export interface TaggingJobData {
  repositoryId: string;
  trigger: TaggingJobTrigger;
  reason?: string;
}

export interface RepositoryMetadataTag {
  key: string;
  value: string;
  source?: string;
}

export interface RepositoryMetadata {
  id: string;
  name: string;
  repoUrl: string;
  defaultBranch?: string;
  readme?: string;
  tags?: RepositoryMetadataTag[];
  description?: string;
  [key: string]: unknown;
}

export interface TagPayload {
  key: string;
  value: string;
  confidence?: number;
}

export interface FileTagPayload {
  path: string;
  tags: TagPayload[];
}

export interface AiTaggingResponse {
  repository_tags: TagPayload[];
  file_tags?: FileTagPayload[];
  [key: string]: unknown;
}

export interface PromptContext {
  repository: RepositoryMetadata;
  fileSummaries: FileSummary[];
  existingTags: TagPayload[];
}

export interface FileSummary {
  path: string;
  snippet: string;
}

export interface TaggingJobMetrics {
  promptTokens?: number;
  completionTokens?: number;
  costUsd?: number;
  latencyMs?: number;
}

export interface TaggingJobResult {
  repositoryTags: TagPayload[];
  fileTags: FileTagPayload[];
  rawResponse: unknown;
  prompt: string;
  metrics: TaggingJobMetrics;
}
