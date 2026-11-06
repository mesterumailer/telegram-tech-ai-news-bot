import test from 'node:test';
import assert from 'node:assert/strict';
import worker, {
  validateDigest,
  sendStoryToChat,
  buildStoryCaption,
  buildStoryReviewKeyboard,
  buildStoryKeyboard,
  addRtlParagraphMarks,
  extractProxyDeepLinkFromPostHtml,
  resolveProxyLinksFromDigest,
  discoverLatestProxyPostUrls,
  refreshProxyPostCache
} from '../src/index.js';
import { parseNewsFeedXml, NEWS_FEEDS } from '../src/news-feed.js';

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

function createLatestViewDb() {
  const processedUpdates = new Set();
  const locks = new Map();
  const statements = [];
  return {
    statements,
    prepare(sql) {
      return {
        bind(...values) {
          return {
            async first() {
              statements.push({ sql, values, method: 'first' });
              if (sql.includes('SELECT review_status FROM story_review_queue')) {
                return { review_status: 'pending' };
              }
              return null;
            },
            async all() {
              statements.push({ sql, values, method: 'all' });
              return { results: [] };
            },
            async run() {
              statements.push({ sql, values, method: 'run' });
              if (sql.includes('INSERT INTO telegram_webhook_updates')) {
                if (processedUpdates.has(values[0])) return { meta: { changes: 0 } };
                processedUpdates.add(values[0]);
                return { meta: { changes: 1 } };
              }
              if (sql.includes('INSERT INTO telegram_latest_view_locks')) {
                const chatId = values[0];
                const lock = locks.get(chatId);
                if (lock?.locked || lock?.cooldown) return { meta: { changes: 0 } };
                locks.set(chatId, { locked: true, lockUpdateId: values[1], cooldown: false });
                return { meta: { changes: 1 } };
              }
              if (sql.includes('UPDATE telegram_latest_view_locks')) {
                const chatId = values[0];
                const lock = locks.get(chatId);
                if (lock && lock.lockUpdateId === values[1]) {
                  locks.set(chatId, { ...lock, locked: false, cooldown: true });
                }
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

function createSchedulerDb() {
  const queue = new Map();
  const published = new Map();
  const events = [];
  const statements = [];

  function statement(sql) {
    let values = [];
    const api = {
      bind(...args) { values = args; return api; },
      async first() {
        statements.push({ sql, values, method: 'first' });
        if (sql.includes('FROM story_review_queue q')) {
          const row = [...queue.values()]
            .filter(item => item.review_status === 'pending')
            .filter(item => {
              const prior = published.get(item.story_id);
              return !prior || prior.status === 'dry_run';
            })
            .sort((a, b) => a.story_id.localeCompare(b.story_id))[0];
          return row ? { ...row } : null;
        }
        if (sql.includes('SELECT status FROM published_stories')) {
          return published.get(values[0]) || null;
        }
        return null;
      },
      async all() {
        statements.push({ sql, values, method: 'all' });
        return { results: [] };
      },
      async run() {
        statements.push({ sql, values, method: 'run' });
        if (sql.includes('INSERT INTO story_review_queue')) {
          const [storyId, batchId, storyJson, origin] = values;
          const prior = queue.get(storyId);
          if (!prior) {
            queue.set(storyId, { story_id: storyId, batch_id: batchId, story_json: storyJson, review_status: 'pending', origin });
            return { meta: { changes: 1 } };
          }
          if (prior.review_status === 'pending' && prior.story_json !== storyJson) {
            queue.set(storyId, { ...prior, batch_id: batchId, story_json: storyJson, origin });
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        }
        if (sql.includes('UPDATE story_review_queue')) {
          const storyId = values[0];
          const row = queue.get(storyId);
          if (!row) return { meta: { changes: 0 } };
          if (/SET review_status\s*=\s*'publishing'/.test(sql) && row.review_status !== 'pending') return { meta: { changes: 0 } };
          const status = /SET review_status\s*=\s*'([^']+)'/.exec(sql)?.[1];
          if (status) queue.set(storyId, { ...row, review_status: status });
          return { meta: { changes: 1 } };
        }
        if (sql.includes('INSERT INTO published_stories')) {
          const [storyId, sourceUrl, title] = values;
          const prior = published.get(storyId);
          if (sql.includes("VALUES (?, ?, ?, 'pending'")) {
            if (prior && prior.status !== 'dry_run') return { meta: { changes: 0 } };
            published.set(storyId, { status: 'pending', source_url: sourceUrl, title });
          } else {
            const status = values[3];
            published.set(storyId, { status, source_url: sourceUrl, title });
          }
          return { meta: { changes: 1 } };
        }
        if (sql.includes('INSERT INTO event_logs')) {
          events.push({ event: values[0], detail: values[1] });
        }
        return { meta: { changes: 1 } };
      }
    };
    return api;
  }

  return {
    queue, published, events, statements,
    prepare: statement
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


test('removes source-channel proxy post links from the news caption and applies RTL marks', () => {
  const caption = buildStoryCaption({
    ...stories[0],
    summary: 'خلاصه خبر\n\n🔐 پروکسی ۱: https://t.me/ProxyMTProto/48256\n🔐 پروکسی ۲: https://t.me/ProxyMTProto/48255',
    proxy1_url: 'https://t.me/ProxyMTProto/48256',
    proxy2_url: 'https://t.me/ProxyMTProto/48255'
  });
  assert.ok(caption.startsWith('\u200f'));
  assert.doesNotMatch(caption, /ProxyMTProto\/4825[56]/);
  assert.doesNotMatch(caption, /<a href="https:\/\/t\.me\/proxy/);
  assert.match(caption, /<a href="https:\/\/t\.me\/Tech4UsNews">@Tech4UsNews<\/a>/);
  assert.equal(addRtlParagraphMarks('عنوان\nمتن'), '\u200fعنوان\n\u200fمتن');
});

test('extracts a direct MTProto URL from the Connect button in a Telegram proxy post', () => {
  const html = '<div class="tgme_widget_message_wrap" data-post="ProxyMTProto/48256">' +
    '<a href="https://t.me/proxy?server=149.154.167.51&amp;port=443&amp;secret=eec16575954a98f1f3277fc329ec45a7">Connect</a>' +
    '</div>';
  assert.equal(
    extractProxyDeepLinkFromPostHtml(html, 'ProxyMTProto/48256'),
    'https://t.me/proxy?server=149.154.167.51&port=443&secret=eec16575954a98f1f3277fc329ec45a7'
  );
});

test('builds a direct MTProto URL from Server, Port and Secret fields when no Connect link exists', () => {
  const html = '<div class="tgme_widget_message_wrap" data-post="ProxyMTProto/48255">' +
    '<div>Server: <code>149.154.167.52</code><br>Port: <code>443</code><br>Secret: <code>ee0123456789abcdef0123456789abcdef</code></div>' +
    '</div>';
  assert.equal(
    extractProxyDeepLinkFromPostHtml(html, 'ProxyMTProto/48255'),
    'https://t.me/proxy?server=149.154.167.52&port=443&secret=ee0123456789abcdef0123456789abcdef'
  );
});

test('resolves the two proxy post references into direct Telegram MTProto links', async () => {
  const originalFetch = globalThis.fetch;
  const html = [
    '<div class="tgme_widget_message_wrap" data-post="ProxyMTProto/48256"><a href="https://t.me/proxy?server=149.154.167.51&amp;port=443&amp;secret=eec16575954a98f1f3277fc329ec45a7">Connect</a></div>',
    '<div class="tgme_widget_message_wrap" data-post="ProxyMTProto/48255"><a href="https://t.me/proxy?server=149.154.167.52&amp;port=443&amp;secret=ee0123456789abcdef0123456789abcdef">Connect</a></div>'
  ].join('');
  const requested = [];
  globalThis.fetch = async url => {
    requested.push(String(url));
    return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
  };
  try {
    const links = await resolveProxyLinksFromDigest({
      stories: [{
        ...stories[0],
        proxy1_url: 'https://t.me/ProxyMTProto/48256',
        proxy2_url: 'https://t.me/ProxyMTProto/48255'
      }]
    }, {});
    assert.equal(links.length, 2);
    assert.match(links[0].url, /^https:\/\/t\.me\/proxy\?/);
    assert.match(links[1].url, /^https:\/\/t\.me\/proxy\?/);
    assert.ok(requested.some(url => url.includes('before=48257')));
    assert.ok(requested.some(url => url.includes('before=48256')));
    assert.ok(links.every(link => !link.url.includes('ProxyMTProto/')));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('discovers the newest two proxy posts with valid Connect links without a digest', async () => {
  const originalFetch = globalThis.fetch;
  const html = [
    '<div class="tgme_widget_message_wrap" data-post="ProxyMTProto/48260"><a href="https://t.me/proxy?server=unknown&amp;port=443&amp;secret=0123456789abcdef">Connect</a></div>',
    '<div class="tgme_widget_message_wrap" data-post="ProxyMTProto/48259"><a href="https://t.me/proxy?server=proxy-new.example&amp;port=443&amp;secret=0123456789abcdef">Connect</a></div>',
    '<div class="tgme_widget_message_wrap" data-post="ProxyMTProto/48258"><a href="https://t.me/proxy?server=proxy-second.example&amp;port=8443&amp;secret=abcdef0123456789">Connect</a></div>'
  ].join('');
  const requested = [];
  globalThis.fetch = async url => {
    requested.push(String(url));
    return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
  };
  try {
    const posts = await discoverLatestProxyPostUrls();
    assert.deepEqual(posts, [
      'https://t.me/ProxyMTProto/48259',
      'https://t.me/ProxyMTProto/48258'
    ]);
    assert.deepEqual(requested, ['https://t.me/s/ProxyMTProto']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('proxy cache persists only public post URLs, never raw MTProto Connect secrets', async () => {
  const originalFetch = globalThis.fetch;
  const secret = '0123456789abcdef';
  const html = [
    '<div class="tgme_widget_message_wrap" data-post="ProxyMTProto/48259"><a href="https://t.me/proxy?server=proxy-new.example&amp;port=443&amp;secret=' + secret + '">Connect</a></div>',
    '<div class="tgme_widget_message_wrap" data-post="ProxyMTProto/48258"><a href="https://t.me/proxy?server=proxy-second.example&amp;port=8443&amp;secret=abcdef0123456789">Connect</a></div>'
  ].join('');
  const writes = [];
  const DB = {
    prepare(sql) {
      return {
        bind(...values) {
          return { async run() { writes.push({ sql, values }); return { meta: { changes: 1 } }; } };
        },
        async run() { writes.push({ sql, values: [] }); return { meta: { changes: 1 } }; }
      };
    }
  };
  globalThis.fetch = async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
  try {
    const posts = await refreshProxyPostCache({ DB });
    assert.equal(posts.length, 2);
    const cacheWrites = writes.filter(item => item.sql.includes('INSERT INTO proxy_post_cache'));
    assert.deepEqual(cacheWrites.map(item => item.values[1]), posts);
    assert.ok(writes.every(item => !JSON.stringify(item.values).includes(secret)));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('combines admin review callbacks and direct proxy URL buttons in separate rows', () => {
  const proxies = [
    { label: 'اتصال پروکسی ۱', url: 'https://t.me/proxy?server=149.154.167.51&port=443&secret=eec16575954a98f1f3277fc329ec45a7' },
    { label: 'اتصال پروکسی ۲', url: 'https://t.me/proxy?server=149.154.167.52&port=443&secret=ee0123456789abcdef0123456789abcdef' }
  ];
  const keyboard = buildStoryKeyboard(stories[0], proxies, true, 'pending');
  assert.equal(keyboard.inline_keyboard.length, 2);
  assert.match(keyboard.inline_keyboard[0][0].callback_data, /^approve:/);
  assert.match(keyboard.inline_keyboard[0][1].callback_data, /^reject:/);
  assert.deepEqual(keyboard.inline_keyboard[1].map(button => button.url), proxies.map(proxy => proxy.url));
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


test('Telegram webhook rejects updates without a numeric update_id', async () => {
  const response = await worker.fetch(new Request('https://worker.example/telegram/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-telegram-bot-api-secret-token': 'webhook-secret'
    },
    body: JSON.stringify({ callback_query: { id: 'callback-1', data: 'latest' } })
  }), { TELEGRAM_WEBHOOK_SECRET: 'webhook-secret' });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /update_id/);
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

test('rapid latest-news button clicks are throttled for the same private chat', async () => {
  const digest = {
    batch_id: 'latest-click-test',
    stories: stories.map((story, index) => ({
      ...story,
      image_url: `https://cdn.example.com/story-${index + 1}.jpg`
    }))
  };
  const DB = createLatestViewDb();
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const urlString = String(url);
    if (urlString.startsWith('https://api.github.com/')) {
      return new Response(JSON.stringify({
        type: 'file',
        content: Buffer.from(JSON.stringify(digest), 'utf8').toString('base64')
      }), { status: 200 });
    }
    calls.push({ url: urlString, payload: JSON.parse(options.body) });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  try {
    const env = {
      TELEGRAM_WEBHOOK_SECRET: 'webhook-secret',
      TELEGRAM_ADMIN_USER_ID: '123',
      TELEGRAM_BOT_TOKEN: 'test-token',
      GITHUB_OWNER: 'owner',
      GITHUB_REPO: 'repo',
      GITHUB_BRANCH: 'main',
      GITHUB_PATH: 'content/ready-digest.json',
      DB
    };
    const sendLatest = async updateId => {
      const update = callbackUpdate('latest', 123, updateId);
      update.callback_query.id = `callback-${updateId}`;
      return worker.fetch(new Request('https://worker.example/telegram/webhook', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-telegram-bot-api-secret-token': 'webhook-secret'
        },
        body: JSON.stringify(update)
      }), env);
    };

    const first = await sendLatest(9101);
    const second = await sendLatest(9102);

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(calls.filter(x => x.url.endsWith('/sendPhoto')).length, 3);
    assert.equal(calls.filter(x => x.url.endsWith('/sendMessage') && /آخرین بسته خبری/.test(x.payload.text)).length, 1);
    const throttledToast = calls.find(x =>
      x.url.endsWith('/answerCallbackQuery') &&
      /همین الان نمایش داده شدند/.test(x.payload.text)
    );
    assert.ok(throttledToast, 'second click should be acknowledged without sending another news batch');
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


test('scheduled Cron queues a digest and publishes only one pending story per run', async () => {
  const DB = createSchedulerDb();
  const digest = {
    batch_id: 'cron-one-story-test',
    stories: stories.map(story => ({ ...story }))
  };
  const originalFetch = globalThis.fetch;
  const telegramCalls = [];
  globalThis.fetch = async url => {
    const target = String(url);
    if (target.startsWith('https://api.github.com/')) {
      return new Response(JSON.stringify({
        type: 'file',
        content: Buffer.from(JSON.stringify(digest), 'utf8').toString('base64')
      }), { status: 200 });
    }
    if (target.startsWith('https://example.com/')) {
      return new Response('no image metadata', { status: 404 });
    }
    if (target.startsWith('https://api.telegram.org/')) {
      telegramCalls.push(target.split('/').pop());
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response('', { status: 404 });
  };

  const env = {
    DB,
    GITHUB_OWNER: 'owner',
    GITHUB_REPO: 'repo',
    GITHUB_BRANCH: 'main',
    GITHUB_PATH: 'content/ready-digest.json',
    TELEGRAM_BOT_TOKEN: 'test-token',
    TELEGRAM_CHANNEL_ID: '@test-channel',
    PUBLISH_ENABLED: 'true'
  };

  const runCron = async () => {
    const pending = [];
    worker.scheduled({}, env, { waitUntil(promise) { pending.push(promise); } });
    await Promise.all(pending);
  };

  try {
    await runCron();
    assert.equal(telegramCalls.filter(method => method === 'sendMessage').length, 1);
    assert.equal([...DB.queue.values()].filter(row => row.review_status === 'published').length, 1);
    assert.equal([...DB.queue.values()].filter(row => row.review_status === 'pending').length, 2);

    await runCron();
    assert.equal(telegramCalls.filter(method => method === 'sendMessage').length, 2);
    assert.equal([...DB.queue.values()].filter(row => row.review_status === 'published').length, 2);
    assert.equal([...DB.queue.values()].filter(row => row.review_status === 'pending').length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('scheduled Cron keeps the queue but sends nothing while PUBLISH_ENABLED is false', async () => {
  const DB = createSchedulerDb();
  const digest = { batch_id: 'cron-publish-off-test', stories: stories.map(story => ({ ...story })) };
  const originalFetch = globalThis.fetch;
  let telegramCalls = 0;
  globalThis.fetch = async url => {
    const target = String(url);
    if (target.startsWith('https://api.github.com/')) {
      return new Response(JSON.stringify({
        type: 'file',
        content: Buffer.from(JSON.stringify(digest), 'utf8').toString('base64')
      }), { status: 200 });
    }
    if (target.startsWith('https://api.telegram.org/')) telegramCalls++;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  try {
    const pending = [];
    worker.scheduled({}, {
      DB,
      GITHUB_OWNER: 'owner',
      GITHUB_REPO: 'repo',
      GITHUB_BRANCH: 'main',
      GITHUB_PATH: 'content/ready-digest.json',
      PUBLISH_ENABLED: 'false'
    }, { waitUntil(promise) { pending.push(promise); } });
    await Promise.all(pending);
    assert.equal(DB.queue.size, 3);
    assert.equal(telegramCalls, 0);
    assert.equal([...DB.queue.values()].filter(row => row.review_status === 'pending').length, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test('parses recent RSS items with their original HTTPS links and candidate image URLs', async () => {
  const now = new Date('2026-11-05T12:00:00Z');
  const feed = NEWS_FEEDS.find(item => item.id === 'openai-news');
  const xml = `<?xml version="1.0"?><rss><channel><item>
    <title><![CDATA[New AI system announced]]></title>
    <link>https://example.com/story</link>
    <pubDate>Thu, 05 Nov 2026 10:00:00 GMT</pubDate>
    <description><![CDATA[<p>Important <b>AI</b> update.</p>]]></description>
    <enclosure url="https://cdn.example.com/story.jpg" type="image/jpeg"/>
  </item></channel></rss>`;
  const items = parseNewsFeedXml(xml, feed, now);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'New AI system announced');
  assert.equal(items[0].source_url, 'https://example.com/story');
  assert.equal(items[0].summary, 'Important AI update.');
  assert.equal(items[0].candidate_image_url, 'https://cdn.example.com/story.jpg');
});

test('parses Atom entries and ignores stale or non-HTTPS feed links', () => {
  const now = new Date('2026-11-05T12:00:00Z');
  const feed = NEWS_FEEDS.find(item => item.id === 'theverge-ai');
  const xml = `<feed xmlns="http://www.w3.org/2005/Atom">
    <entry><title>Fresh atom story</title><link rel="alternate" href="https://example.com/fresh"/>
    <updated>2026-11-05T09:00:00Z</updated><summary>Atom summary</summary></entry>
    <entry><title>Stale story</title><link href="https://example.com/old"/>
    <updated>2026-09-01T09:00:00Z</updated></entry>
    <entry><title>Insecure story</title><link href="http://example.com/insecure"/>
    <updated>2026-11-05T09:00:00Z</updated></entry>
  </feed>`;
  const items = parseNewsFeedXml(xml, feed, now);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Fresh atom story');
  assert.equal(items[0].source_url, 'https://example.com/fresh');
});
