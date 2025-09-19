import { FileTagPayload, TagPayload } from './types';

export interface RepositoryTagDiff {
  apply: TagPayload[];
  remove: Array<{ key: string; value: string }>;
}

export function diffRepositoryTags(newTags: TagPayload[], existingTags: TagPayload[] = []): RepositoryTagDiff {
  const newSignatures = new Set(newTags.map((tag) => `${tag.key}:${tag.value}`));
  const remove = existingTags
    .filter((tag) => !newSignatures.has(`${tag.key}:${tag.value}`))
    .map((tag) => ({ key: tag.key, value: tag.value }));

  return { apply: newTags, remove };
}

export interface FileTagDiff {
  apply: FileTagPayload[];
  remove: FileTagPayload[];
}

export function diffFileTags(newTags: FileTagPayload[], _existing: FileTagPayload[] = []): FileTagDiff {
  // File explorer API currently does not supply existing tags; just apply new ones.
  return { apply: newTags, remove: [] };
}
