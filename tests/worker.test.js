import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { validateDigest, sendStoryToChat, buildStoryCaption, parseLatestMtprotoProxies, buildProxyMessage } from '../src/index.js';

const stories = [1, 2, 3].map(n => ({
  id: `story-${n}`,
  title: `خبر آزمایشی ${n}`,
  summary: `خلاصه خبر ${n}`,
  source_url: `https://example.com/story-${n}`,
  category: 'هوش مصنوعی'
}));
const valid = { batch_id: '2026-10-30-daily', stories };

test('accepts exactly three valid stories with HTTPS sources', () => assert.deepEqual(validateDigest(valid), { ok: true }));

test('extracts the two newest unique valid MTProto links in page order', () => {
  const html = [
    '<a href="https://t.me/proxy?server=old.example&amp;port=443&amp;secret=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa">old</a>',
    '<a href="https://t.me/proxy?server=middle.example&amp;port=443&amp;secret=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb">middle</a>',
    '<a href="https://t.me/proxy?server=middle.example&amp;port=443&amp;secret=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb">duplicate</a>',
    '<a href="https://t.me/proxy?server=latest.example&amp;port=88&amp;secret=cccccccccccccccccccccccccccccccc">latest</a>'
  ].join('');
  const proxies = parseLatestMtprotoProxies(html);
  assert.deepEqual(proxies.map(proxy => proxy.server), ['middle.example', 'latest.example']);
  assert.equal(proxies[1].port, 88);
  assert.match(proxies[1].url, /^https:\/\/t\.me\/proxy\?/);
});

test('ignores malformed or incomplete MTProto links', () => {
  const html = [
    '<a href="https://t.me/proxy?server=Unknown&amp;port=443&amp;secret=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa">unknown</a>',
    '<a href="https://t.me/proxy?server=missing-port.example&amp;secret=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb">missing</a>',
    '<a href="https://t.me/proxy?server=valid.example&amp;port=443&amp;secret=short">short</a>'
  ].join('');
  assert.deepEqual(parseLatestMtprotoProxies(html), []);
});

test('builds a Persian proxy footer with numbered, clickable connect links and source credit', () => {
  const message = buildProxyMessage([
    { server: 'one.example', port: 443, url: 'https://t.me/proxy?server=one.example&port=443&secret=aaaaaaaaaaaaaaaa' },
    { server: 'two.example', port: 88, url: 'https://t.me/proxy?server=two.example&port=88&secret=bbbbbbbbbbbbbbbb' }
  ]);
  assert.match(message, /پروکسی ۱/);
  assert.match(message, /پروکسی ۲/);
  assert.match(message, /one\.example:443/);
  assert.match(message, /@proxyMtProto/);
  assert.match(message, /&amp;port=443/);
});
test('rejects a digest without a batch id', () => assert.equal(validateDigest({ ...valid, batch_id: '' }).ok, false));
test('rejects fewer than three stories', () => assert.equal(validateDigest({ ...valid, stories: stories.slice(0, 2) }).ok, false));
test('rejects more than three stories', () => assert.equal(validateDigest({ ...valid, stories: [...stories, { ...stories[0], id: 'story-4' }] }).ok, false));
test('rejects duplicate story ids', () => assert.equal(validateDigest({ ...valid, stories: [stories[0], stories[1], { ...stories[2], id: stories[0].id }] }).ok, false));
test('rejects non-HTTPS source URLs', () => assert.equal(validateDigest({ ...valid, stories: [{ ...stories[0], source_url: 'http://example.com' }, stories[1], stories[2]] }).ok, false));
test('rejects a story missing its source URL', () => assert.equal(validateDigest({ ...valid, stories: [{ ...stories[0], source_url: '' }, stories[1], stories[2]] }).ok, false));
test('rejects oversized story text', () => assert.equal(validateDigest({ ...valid, stories: [{ ...stories[0], summary: 'x'.repeat(2501) }, stories[1], stories[2]] }).ok, false));

test('accepts an optional direct HTTPS image URL', () => {
  const withImage = { ...valid, stories: [{ ...stories[0], image_url: 'https://cdn.example.com/news.jpg' }, stories[1], stories[2]] };
  assert.deepEqual(validateDigest(withImage), { ok: true });
});

test('rejects non-HTTPS image URLs', () => {
  const withImage = { ...valid, stories: [{ ...stories[0], image_url: 'http://cdn.example.com/news.jpg' }, stories[1], stories[2]] };
  assert.equal(validateDigest(withImage).ok, false);
});

test('rejects malformed image metadata', () => {
  const withImage = { ...valid, stories: [{ ...stories[0], image_credit: 'x'.repeat(161) }, stories[1], stories[2]] };
  assert.equal(validateDigest(withImage).ok, false);
});

test('photo caption remains within Telegram 1024-character limit', () => {
  const caption = buildStoryCaption({
    ...stories[0],
    summary: 'خبر مهم '.repeat(500),
    image_credit: 'منبع تصویر رسمی',
    published_at: '2026-11-01T08:00:00Z'
  });
  const visibleText = caption
    .replace(/<[^>]*>/g, '')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"');
  assert.ok(Array.from(visibleText).length <= 1024);
});

test('sends a story with an image using Telegram sendPhoto and preserves review buttons', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, payload: JSON.parse(options.body) });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  try {
    const keyboard = { inline_keyboard: [[{ text: 'تأیید', callback_data: 'approve:story-1' }]] };
    await sendStoryToChat(
      { TELEGRAM_BOT_TOKEN: 'test-token' },
      '@test-channel',
      { ...stories[0], image_url: 'https://cdn.example.com/news.jpg' },
      keyboard,
      'در انتظار بررسی'
    );
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/sendPhoto$/);
    assert.equal(calls[0].payload.photo, 'https://cdn.example.com/news.jpg');
    assert.deepEqual(calls[0].payload.reply_markup, keyboard);
    assert.equal(calls[0].payload.parse_mode, 'HTML');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('falls back to a text post when Telegram explicitly rejects the photo', async () => {
  const originalFetch = globalThis.fetch;
  const methods = [];
  globalThis.fetch = async (url) => {
    methods.push(url.split('/').pop());
    if (methods.length === 1) return new Response(JSON.stringify({ ok: false, description: 'wrong file identifier' }), { status: 400 });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  try {
    await sendStoryToChat(
      { TELEGRAM_BOT_TOKEN: 'test-token' },
      '@test-channel',
      { ...stories[0], image_url: 'https://cdn.example.com/not-an-image' }
    );
    assert.deepEqual(methods, ['sendPhoto', 'sendMessage']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('does not retry as text after an ambiguous network error on photo send', async () => {
  const originalFetch = globalThis.fetch;
  const methods = [];
  globalThis.fetch = async (url) => {
    methods.push(url.split('/').pop());
    throw new Error('simulated network timeout');
  };
  try {
    await assert.rejects(
      sendStoryToChat(
        { TELEGRAM_BOT_TOKEN: 'test-token' },
        '@test-channel',
        { ...stories[0], image_url: 'https://cdn.example.com/news.jpg' }
      ),
      /simulated network timeout/
    );
    assert.deepEqual(methods, ['sendPhoto']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('sends text-only stories with sendMessage when no image is provided', async () => {
  const originalFetch = globalThis.fetch;
  const methods = [];
  globalThis.fetch = async (url) => {
    methods.push(url.split('/').pop());
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  try {
    await sendStoryToChat({ TELEGRAM_BOT_TOKEN: 'test-token' }, '@test-channel', stories[0]);
    assert.deepEqual(methods, ['sendMessage']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

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


test('Telegram webhook rejects requests without the configured secret', async () => {
  const response = await worker.fetch(new Request('https://worker.example/telegram/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ update_id: 1, message: { text: '/start' } })
  }), { TELEGRAM_WEBHOOK_SECRET: 'webhook-secret' });
  assert.equal(response.status, 401);
});

test('Telegram webhook rejects an incorrect secret', async () => {
  const response = await worker.fetch(new Request('https://worker.example/telegram/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'wrong-secret' },
    body: JSON.stringify({ update_id: 1, message: { text: '/start' } })
  }), { TELEGRAM_WEBHOOK_SECRET: 'webhook-secret' });
  assert.equal(response.status, 401);
});
