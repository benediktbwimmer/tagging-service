"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const tagNormalization_1 = require("src/jobs/tagNormalization");
describe('tag normalization', () => {
    it('normalizes keys and removes duplicates', () => {
        const normalized = (0, tagNormalization_1.normalizeRepositoryTags)([
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
        const normalized = (0, tagNormalization_1.normalizeFileTags)([
            { path: 'src/index.ts', tags: [{ key: ' Feature ', value: ' Tagging ' }] },
            { path: 'README.md', tags: [] }
        ]);
        expect(normalized).toEqual([
            { path: 'src/index.ts', tags: [{ key: 'feature', value: 'tagging', confidence: undefined }] }
        ]);
    });
});
