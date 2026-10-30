import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDigest } from '../src/index.js';

const valid = {
  batch_id: '2026-10-29-daily',
  stories: [{ id: 'story-1', title: 'خبر آزمایشی', summary: 'خلاصه خبر', source_url: 'https://example.com/story', category: 'هوش مصنوعی' }]
};

test('accepts a valid digest with HTTPS source', () => assert.deepEqual(validateDigest(valid), { ok: true }));
test('rejects a digest without a batch id', () => assert.equal(validateDigest({ ...valid, batch_id: '' }).ok, false));
test('rejects more than three stories', () => assert.equal(validateDigest({ ...valid, stories: [...valid.stories, ...valid.stories, ...valid.stories, ...valid.stories] }).ok, false));
test('rejects non-HTTPS source URLs', () => assert.equal(validateDigest({ ...valid, stories: [{ ...valid.stories[0], source_url: 'http://example.com' }] }).ok, false));
test('rejects a story missing its source URL', () => assert.equal(validateDigest({ ...valid, stories: [{ ...valid.stories[0], source_url: '' }] }).ok, false));
