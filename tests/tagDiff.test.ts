import { diffRepositoryTags, diffFileTags } from 'src/jobs/tagDiff';

it('computes repository tag diff and preserves removals', () => {
  const diff = diffRepositoryTags(
    [
      { key: 'language', value: 'typescript' },
      { key: 'framework', value: 'fastify' }
    ],
    [{ key: 'language', value: 'javascript' }]
  );

  expect(diff.apply).toHaveLength(2);
  expect(diff.remove).toEqual([{ key: 'language', value: 'javascript' }]);
});

it('returns file tags to apply without removals by default', () => {
  const diff = diffFileTags([
    { path: 'src/app.ts', tags: [{ key: 'feature', value: 'api' }] }
  ]);

  expect(diff.apply).toHaveLength(1);
  expect(diff.remove).toEqual([]);
});
