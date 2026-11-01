import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { validateDigest, sendStoryToChat, buildStoryCaption, buildStoryReviewKeyboard } from '../src/index.js';

const stories = [1, 2, 3].map(n => ({
  id: `story-${n}`,
  title: `خبر آزمایشی ${n}`,
  summary: `خلاصه خبر ${n}`,
  source_url: `https://example.com/story-${n}`,
  category: 'هوش مصنوعی'
}));
const valid = { batch_id: '2026-10-30-daily', stories };

function createReviewDb(story, reviewStatus = 'pending') {
  const statements = [];
  const processedUpdates = new Set();
  return {
    statements,
    processedUpdates,
    prepare(sql) {
      return {
        bind(...values) {
          return {
            async first() {
              statements.push({ sql, values, method: 'first' });
              if (sql.includes('FROM story_review_queue')) {
                return values[0] === story.id
                  ? { story_id: story.id, story_json: JSON.stringify(story), review_status: reviewStatus }
                  : null;
              }
              if (sql.includes('FROM published_stories')) return null;
              return null;
            },
            async all() {
              statements.push({ sql, values, method: 'all' });
              return { results: [{ story_id: story.id, story_json: JSON.stringify(story), review_status: reviewStatus }] };
            },
            async run() {
              statements.push({ sql, values, method: 'run' });
              if (sql.includes('INSERT INTO telegram_webhook_updates')) {
                if (processedUpdates.has(values[0])) return { meta: { changes: 0 } };
                processedUpdates.add(values[0]);
                return { meta: { changes: 1 } };
              }
              return { meta: { changes: 1 } };
            }
          };
        }
      };
    }
  };
}

function callbackUpdate(data, userId = 123, updateId = 1001) {
  return {
    update_id: updateId,
    callback_query: {
      id: 'callback-test-1',
      data,
      from: { id: userId },
      message: { message_id: 77, chat: { id: userId, type: 'private' } }
    }
  };
}

test('accepts exactly three valid stories with HTTPS sources', () => assert.deepEqual(validateDigest(valid), { ok: true }));
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


test('renders proxy URLs only as embedded proxy1 and proxy2 links', () => {
  const caption = buildStoryCaption({
    ...stories[0],
    proxy1_url: 'https://t.me/ProxyMTProto/48256',
    proxy2_url: 'https://t.me/ProxyMTProto/48255'
  });
  assert.match(caption, /<a href="https:\/\/t\.me\/ProxyMTProto\/48256">پروکسی1<\/a>/);
  assert.match(caption, /<a href="https:\/\/t\.me\/ProxyMTProto\/48255">پروکسی2<\/a>/);
  assert.match(caption, /<a href="https:\/\/t\.me\/Tech4UsNews">@Tech4UsNews<\/a>/);
  const visibleText = caption.replace(/<a href="[^"]*">/g, '').replaceAll('</a>', '');
  assert.doesNotMatch(visibleText, /48256|48255/);
  assert.match(visibleText, /@Tech4UsNews/);
});

test('rejects non-HTTPS proxy links', () => {
  const invalid = { ...valid, stories: [{ ...stories[0], proxy1_url: 'http://t.me/proxy' }, stories[1], stories[2]] };
  assert.equal(validateDigest(invalid).ok, false);
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
    assert.match(calls[0].payload.caption, /<a href="https:\/\/t\.me\/Tech4UsNews">@Tech4UsNews<\/a>/);
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
  const calls = [];
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith('https://example.com/story-1')) {
      return new Response('no article image metadata', { status: 404 });
    }
    calls.push({ method: url.split('/').pop(), payload: JSON.parse(options.body) });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  try {
    await sendStoryToChat({ TELEGRAM_BOT_TOKEN: 'test-token' }, '@test-channel', stories[0]);
    assert.deepEqual(calls.map(x => x.method), ['sendMessage']);
    assert.match(calls[0].payload.text, /<a href="https:\/\/t\.me\/Tech4UsNews">@Tech4UsNews<\/a>/);
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


test('discovers an article og:image and sends the story with sendPhoto when image_url is missing', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith('https://example.com/story-1')) {
      return new Response('<html><head><meta property="og:image" content="https://cdn.example.com/story-photo.jpg"></head></html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' }
      });
    }
    calls.push({ url, payload: JSON.parse(options.body) });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  try {
    await sendStoryToChat({ TELEGRAM_BOT_TOKEN: 'test-token' }, '@test-channel', stories[0]);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/sendPhoto$/);
    assert.equal(calls[0].payload.photo, 'https://cdn.example.com/story-photo.jpg');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('resolves relative article image metadata and HTML-escaped URL parameters', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith('https://example.com/story-1')) {
      return new Response('<meta property="og:image" content="/assets/news.jpg?size=large&amp;format=jpg">', {
        status: 200,
        headers: { 'content-type': 'text/html' }
      });
    }
    calls.push({ url, payload: JSON.parse(options.body) });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  try {
    await sendStoryToChat({ TELEGRAM_BOT_TOKEN: 'test-token' }, '@test-channel', stories[0]);
    assert.equal(calls[0].payload.photo, 'https://example.com/assets/news.jpg?size=large&format=jpg');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('builds review buttons within Telegram callback_data 64-byte limit for long story IDs', async () => {
  const longStory = { ...stories[0], id: 'openai-perturbai-scripps-thousands-agents-brain-cells-20261021' };
  const keyboard = buildStoryReviewKeyboard(longStory);
  for (const button of keyboard.inline_keyboard[0]) {
    assert.ok(Buffer.byteLength(button.callback_data, 'utf8') <= 64);
  }
  assert.match(keyboard.inline_keyboard[0][0].callback_data, /^approve:/);
  assert.match(keyboard.inline_keyboard[0][1].callback_data, /^reject:/);
});

test('reject button callback updates the review queue and sends an explicit confirmation', async () => {
  const story = { ...stories[1] };
  const DB = createReviewDb(story);
  const callbackData = buildStoryReviewKeyboard(story).inline_keyboard[0][1].callback_data;
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, payload: JSON.parse(options.body) });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  try {
    const response = await worker.fetch(new Request('https://worker.example/telegram/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': 'webhook-secret'
      },
      body: JSON.stringify(callbackUpdate(callbackData))
    }), {
      TELEGRAM_WEBHOOK_SECRET: 'webhook-secret',
      TELEGRAM_ADMIN_USER_ID: '123',
      TELEGRAM_BOT_TOKEN: 'test-token',
      DB
    });
    assert.equal(response.status, 200);
    assert.ok(DB.statements.some(x => x.sql.includes("SET review_status='rejected'")));
    assert.equal(calls[0].url.split('/').pop(), 'answerCallbackQuery');
    assert.equal(calls[1].url.split('/').pop(), 'sendMessage');
    assert.match(calls[1].payload.text, /خبر رد شد/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Telegram webhook processes each update_id only once', async () => {
  const story = { ...stories[0] };
  const DB = createReviewDb(story);
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), payload: JSON.parse(options.body) });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  try {
    const requestBody = JSON.stringify(callbackUpdate('settings', 123, 9001));
    const makeRequest = () => new Request('https://worker.example/telegram/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': 'webhook-secret'
      },
      body: requestBody
    });
    const env = {
      TELEGRAM_WEBHOOK_SECRET: 'webhook-secret',
      TELEGRAM_ADMIN_USER_ID: '123',
      TELEGRAM_BOT_TOKEN: 'test-token',
      DB
    };

    const first = await worker.fetch(makeRequest(), env);
    const firstBody = await first.json();
    const second = await worker.fetch(makeRequest(), env);
    const secondBody = await second.json();

    assert.equal(first.status, 200);
    assert.deepEqual(firstBody, { ok: true });
    assert.equal(second.status, 200);
    assert.deepEqual(secondBody, { ok: true, duplicate: true });
    assert.equal(DB.processedUpdates.size, 1);
    assert.equal(calls.filter(x => x.url.endsWith('/sendMessage')).length, 1);
    assert.equal(calls.filter(x => x.url.endsWith('/answerCallbackQuery')).length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('approve button explains the master publish switch when publishing is disabled', async () => {
  const story = { ...stories[1] };
  const DB = createReviewDb(story);
  const callbackData = buildStoryReviewKeyboard(story).inline_keyboard[0][0].callback_data;
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, payload: JSON.parse(options.body) });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  try {
    const response = await worker.fetch(new Request('https://worker.example/telegram/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': 'webhook-secret'
      },
      body: JSON.stringify(callbackUpdate(callbackData))
    }), {
      TELEGRAM_WEBHOOK_SECRET: 'webhook-secret',
      TELEGRAM_ADMIN_USER_ID: '123',
      TELEGRAM_BOT_TOKEN: 'test-token',
      PUBLISH_ENABLED: 'false',
      DB
    });
    assert.equal(response.status, 200);
    assert.ok(!DB.statements.some(x => x.sql.includes("SET review_status='publishing'")));
    const reply = calls.find(x => x.url.endsWith('/sendMessage'));
    assert.match(reply.payload.text, /PUBLISH_ENABLED/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test('approve button publishes the selected story when the master switch is enabled', async () => {
  const story = { ...stories[1], image_url: 'https://cdn.example.com/review-story.jpg' };
  const DB = createReviewDb(story);
  const callbackData = buildStoryReviewKeyboard(story).inline_keyboard[0][0].callback_data;
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, payload: JSON.parse(options.body) });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  try {
    const response = await worker.fetch(new Request('https://worker.example/telegram/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': 'webhook-secret'
      },
      body: JSON.stringify(callbackUpdate(callbackData))
    }), {
      TELEGRAM_WEBHOOK_SECRET: 'webhook-secret',
      TELEGRAM_ADMIN_USER_ID: '123',
      TELEGRAM_BOT_TOKEN: 'test-token',
      TELEGRAM_CHANNEL_ID: '@news-channel',
      PUBLISH_ENABLED: 'true',
      DB
    });
    assert.equal(response.status, 200);
    assert.ok(DB.statements.some(x => x.sql.includes("SET review_status='publishing'")));
    assert.ok(DB.statements.some(x => x.sql.includes("SET review_status='published'")));
    assert.ok(calls.some(x => x.url.endsWith('/sendPhoto') && x.payload.chat_id === '@news-channel'));
    const confirmation = calls.find(x => x.url.endsWith('/sendMessage') && /خبر منتشر شد/.test(x.payload.text));
    assert.ok(confirmation);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('webhook status endpoint reports whether callback_query updates are enabled', async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl = '';
  globalThis.fetch = async (url) => {
    requestUrl = String(url);
    return new Response(JSON.stringify({
      ok: true,
      result: {
        url: 'https://worker.example/telegram/webhook',
        pending_update_count: 2,
        allowed_updates: ['message', 'callback_query'],
        last_error_message: 'old transient error'
      }
    }), { status: 200 });
  };
  try {
    const response = await worker.fetch(new Request('https://worker.example/admin/webhook-status', {
      method: 'POST',
      headers: { authorization: 'Bearer admin-secret' }
    }), { ADMIN_SECRET: 'admin-secret', TELEGRAM_BOT_TOKEN: 'test-token' });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(requestUrl.split('/').pop(), 'getWebhookInfo');
    assert.equal(body.webhook_configured, true);
    assert.equal(body.callback_query_enabled, true);
    assert.equal(body.pending_update_count, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
