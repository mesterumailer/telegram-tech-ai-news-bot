import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { validateDigest } from '../src/index.js';

const stories = [1, 2, 3].map(n => ({
  id: `story-${n}`,
  title: `خبر آزمایشی ${n}`,
  summary: `خلاصه خبر ${n}`,
  source_url: `https://example.com/story-${n}`,
  category: 'هوش مصنوعی'
}));
const valid = { batch_id: '2026-10-30-daily', stories };

test('accepts exactly three valid stories with HTTPS sources', () => assert.deepEqual(validateDigest(valid), { ok: true }));
test('rejects a digest without a batch id', () => assert.equal(validateDigest({ ...valid, batch_id: '' }).ok, false));
test('rejects fewer than three stories', () => assert.equal(validateDigest({ ...valid, stories: stories.slice(0, 2) }).ok, false));
test('rejects more than three stories', () => assert.equal(validateDigest({ ...valid, stories: [...stories, { ...stories[0], id: 'story-4' }] }).ok, false));
test('rejects duplicate story ids', () => assert.equal(validateDigest({ ...valid, stories: [stories[0], stories[1], { ...stories[2], id: stories[0].id }] }).ok, false));
test('rejects non-HTTPS source URLs', () => assert.equal(validateDigest({ ...valid, stories: [{ ...stories[0], source_url: 'http://example.com' }, stories[1], stories[2]] }).ok, false));
test('rejects a story missing its source URL', () => assert.equal(validateDigest({ ...valid, stories: [{ ...stories[0], source_url: '' }, stories[1], stories[2]] }).ok, false));
test('rejects oversized story text', () => assert.equal(validateDigest({ ...valid, stories: [{ ...stories[0], summary: 'x'.repeat(2501) }, stories[1], stories[2]] }).ok, false));

test('test-message endpoint rejects requests without admin authorization', async () => {
  const response = await worker.fetch(new Request('https://worker.example/admin/test-message', { method: 'POST' }), {});
  assert.equal(response.status, 401);
});

test('test-message endpoint is disabled unless explicitly enabled', async () => {
  const response = await worker.fetch(new Request('https://worker.example/admin/test-message', {
    method: 'POST',
    headers: { authorization: 'Bearer test-secret' }
  }), { ADMIN_SECRET: 'test-secret', TELEGRAM_TEST_ENABLED: 'false' });
  assert.equal(response.status, 403);
});
