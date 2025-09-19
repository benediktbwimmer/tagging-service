import { FileTagPayload, TagPayload } from './types';

function normalizeKey(key: string): string {
  return key
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function normalizeValue(value: string): string {
  return value.trim().toLowerCase();
}

function clampConfidence(confidence?: number): number | undefined {
  if (confidence === undefined) {
    return undefined;
  }
  if (Number.isNaN(confidence)) {
    return undefined;
  }
  if (confidence < 0) {
    return 0;
  }
  if (confidence > 1) {
    return 1;
  }
  return confidence;
}

export function normalizeRepositoryTags(tags: TagPayload[]): TagPayload[] {
  const seen = new Set<string>();
  const normalized: TagPayload[] = [];
  for (const tag of tags) {
    const key = normalizeKey(tag.key);
    const value = normalizeValue(tag.value);
    if (!key || !value) {
      continue;
    }
    const signature = `${key}:${value}`;
    if (seen.has(signature)) {
      continue;
    }
    seen.add(signature);
    normalized.push({ key, value, confidence: clampConfidence(tag.confidence) });
  }
  return normalized;
}

export function normalizeFileTags(fileTags: FileTagPayload[]): FileTagPayload[] {
  return fileTags
    .map((file) => {
      const tags = normalizeRepositoryTags(file.tags);
      return { path: file.path, tags };
    })
    .filter((file) => file.tags.length > 0);
}
