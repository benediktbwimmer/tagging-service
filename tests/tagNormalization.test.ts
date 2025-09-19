import { normalizeRepositoryTags, normalizeFileTags } from 'src/jobs/tagNormalization';

describe('tag normalization', () => {
  it('normalizes keys and removes duplicates', () => {
    const normalized = normalizeRepositoryTags([
      { key: 'Language', value: 'TypeScript', confidence: 2 },
      { key: 'language', value: 'typescript' },
      { key: ' Framework ', value: ' Fastify ' }
    ]);

    expect(normalized).toEqual([
      { key: 'language', value: 'typescript', confidence: 1 },
      { key: 'framework', value: 'fastify', confidence: undefined }
    ]);
  });

  it('normalizes file tags and drops empty sets', () => {
    const normalized = normalizeFileTags([
      { path: 'src/index.ts', tags: [{ key: ' Feature ', value: ' Tagging ' }] },
      { path: 'README.md', tags: [] }
    ]);

    expect(normalized).toEqual([
      { path: 'src/index.ts', tags: [{ key: 'feature', value: 'tagging', confidence: undefined }] }
    ]);
  });
});
