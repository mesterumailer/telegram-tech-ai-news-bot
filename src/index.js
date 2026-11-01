const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "telegram-news-publisher", mode: env.PUBLISH_ENABLED === "true" ? "publish" : "dry-run" });
    }
    if (request.method === "POST" && url.pathname === "/telegram/webhook") {
      if (!env.TELEGRAM_WEBHOOK_SECRET || request.headers.get("x-telegram-bot-api-secret-token") !== env.TELEGRAM_WEBHOOK_SECRET) return json({ error: "unauthorized webhook" }, 401);
      let update;
      try { update = await request.json(); } catch { return json({ error: "invalid update" }, 400); }
      try { await handleTelegramUpdate(update, env); return json({ ok: true }); }
      catch (error) { await logEvent(env, "telegram_ui_error", safeError(error)); return json({ ok: false, error: safeError(error) }, 500); }
    }
    if (request.method === "POST" && url.pathname === "/admin/submit") {
      if (!authorized(request, env)) return json({ error: "unauthorized" }, 401);
      let digest;
      try { digest = await request.json(); } catch { return json({ error: "body must be valid JSON" }, 400); }
      const validation = validateDigest(digest);
      if (!validation.ok) return json({ error: validation.error }, 400);
      const mode = await getSetting(env, "publication_mode", "manual");
      if (mode !== "auto") {
        const queuedCount = await queueDigestForReview(digest, env, "manual_api");
        if (queuedCount > 0 && env.TELEGRAM_ADMIN_USER_ID) await notifyPendingDigest(env, digest);
        return json({ ok: true, status: "queued_for_admin_review", batch_id: digest.batch_id });
      }
      const result = await processDigest(digest, env, "manual");
      return json(result, result.ok ? 200 : 502);
    }
    if (request.method === "POST" && url.pathname === "/admin/register-webhook") {
      if (!authorized(request, env)) return json({ error: "unauthorized" }, 401);
      if (!env.TELEGRAM_WEBHOOK_SECRET || !env.TELEGRAM_ADMIN_USER_ID) return json({ error: "TELEGRAM_WEBHOOK_SECRET and TELEGRAM_ADMIN_USER_ID must be configured" }, 400);
      try {
        const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            url: `${url.origin}/telegram/webhook`,
            secret_token: env.TELEGRAM_WEBHOOK_SECRET,
            allowed_updates: ["message", "callback_query"],
            drop_pending_updates: false
          })
        });
        const result = await response.json();
        if (!response.ok || !result.ok) throw new Error(result.description || `Telegram setWebhook failed with HTTP ${response.status}`);
        return json({ ok: true, status: "webhook_registered", url: `${url.origin}/telegram/webhook` });
      } catch (error) { return json({ ok: false, error: safeError(error) }, 502); }
    }
    if (request.method === "POST" && url.pathname === "/admin/test-message") {
      if (!authorized(request, env)) return json({ error: "unauthorized" }, 401);
      if (env.TELEGRAM_TEST_ENABLED !== "true") return json({ error: "telegram test endpoint is disabled" }, 403);
      try {
        await sendTelegram(env, {
          title: "پیام آزمایشی ربات اخبار فناوری",
          summary: "این یک پیام آزمایشی است. اگر این پیام را در کانال می‌بینید، اتصال Cloudflare Worker به ربات تلگرام برقرار است. این پیام خبر واقعی نیست.",
          source_url: "https://github.com/mesterumailer/telegram-tech-ai-news-bot",
          category: "آزمایش سیستم"
        });
        return json({ ok: true, status: "test_message_sent" });
      } catch (error) {
        return json({ ok: false, error: safeError(error) }, 502);
      }
    }
    return json({ error: "not found" }, 404);
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil((async () => {
      try {
        const digest = await fetchGitHubDigest(env);
        if (!digest) return;
        const validation = validateDigest(digest);
        if (!validation.ok) {
          await logEvent(env, "validation_error", validation.error);
          return;
        }
        const mode = await getSetting(env, "publication_mode", "manual");
        if (mode === "auto" && env.PUBLISH_ENABLED === "true") {
          await processDigest(digest, env, "scheduled");
        } else {
          const queuedCount = await queueDigestForReview(digest, env, "scheduled");
          if (queuedCount > 0 && env.TELEGRAM_ADMIN_USER_ID) await notifyPendingDigest(env, digest);
          if (mode === "auto" && env.PUBLISH_ENABLED !== "true") await logEvent(env, "auto_publish_paused", "PUBLISH_ENABLED master switch is false");
        }
      } catch (error) {
        await logEvent(env, "worker_error", safeError(error));
      }
    })());
  }
};

function json(value, status = 200) {
  return new Response(JSON.stringify(value, null, 2), { status, headers: JSON_HEADERS });
}

function authorized(request, env) {
  const expected = env.ADMIN_SECRET;
  if (!expected) return false;
  return request.headers.get("authorization") === `Bearer ${expected}`;
}

export function validateDigest(digest) {
  if (!digest || typeof digest !== "object" || Array.isArray(digest)) return { ok: false, error: "digest must be a JSON object" };
  if (typeof digest.batch_id !== "string" || !digest.batch_id.trim()) return { ok: false, error: "batch_id is required" };
  if (!Array.isArray(digest.stories) || digest.stories.length !== 3) return { ok: false, error: "exactly 3 validated stories are required" };
  const ids = new Set();
  for (let i = 0; i < digest.stories.length; i++) {
    const s = digest.stories[i];
    if (!s || typeof s !== "object") return { ok: false, error: `stories[${i}] must be an object` };
    for (const key of ["id", "title", "summary", "source_url"]) {
      if (typeof s[key] !== "string" || !s[key].trim()) return { ok: false, error: `stories[${i}].${key} is required` };
    }
    if (ids.has(s.id)) return { ok: false, error: `stories[${i}].id must be unique` };
    ids.add(s.id);
    try {
      const parsed = new URL(s.source_url);
      if (parsed.protocol !== "https:") return { ok: false, error: `stories[${i}].source_url must use HTTPS` };
    } catch { return { ok: false, error: `stories[${i}].source_url is invalid` }; }
    if (s.image_url !== undefined && s.image_url !== null && s.image_url !== "") {
      if (typeof s.image_url !== "string" || s.image_url.length > 2048) return { ok: false, error: `stories[${i}].image_url is invalid` };
      try {
        const imageUrl = new URL(s.image_url);
        if (imageUrl.protocol !== "https:" || !imageUrl.hostname || imageUrl.username || imageUrl.password) return { ok: false, error: `stories[${i}].image_url must be a public HTTPS URL` };
      } catch { return { ok: false, error: `stories[${i}].image_url is invalid` }; }
    }
    for (const key of ["proxy1_url", "proxy2_url"]) {
      if (s[key] !== undefined && s[key] !== null && s[key] !== "") {
        if (typeof s[key] !== "string" || !isTelegramProxyUrl(s[key])) return { ok: false, error: `stories[${i}].${key} must be a valid Telegram HTTPS proxy URL` };
      }
    }
    if (s.image_credit !== undefined && (typeof s.image_credit !== "string" || s.image_credit.length > 160)) return { ok: false, error: `stories[${i}].image_credit is invalid` };
    if (s.image_alt !== undefined && (typeof s.image_alt !== "string" || s.image_alt.length > 300)) return { ok: false, error: `stories[${i}].image_alt is invalid` };
    if (s.title.length > 300 || s.summary.length > 2500) return { ok: false, error: `stories[${i}] text is too long` };
  }
  return { ok: true };
}

async function fetchGitHubDigest(env) {
  if (!env.GITHUB_OWNER || !env.GITHUB_REPO || !env.GITHUB_PATH) throw new Error("Missing GITHUB_OWNER, GITHUB_REPO, or GITHUB_PATH configuration");
  const branch = env.GITHUB_BRANCH || "main";
  const endpoint = `https://api.github.com/repos/${encodeURIComponent(env.GITHUB_OWNER)}/${encodeURIComponent(env.GITHUB_REPO)}/contents/${env.GITHUB_PATH.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(branch)}`;
  const headers = { "accept": "application/vnd.github+json", "user-agent": "telegram-news-publisher/0.1", "cache-control": "no-cache" };
  if (env.GITHUB_TOKEN) headers.authorization = `Bearer ${env.GITHUB_TOKEN}`;
  const response = await fetch(endpoint, { headers, cf: { cacheTtl: 0, cacheEverything: false } });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub read failed with HTTP ${response.status}`);
  const file = await response.json();
  if (file.type !== "file" || typeof file.content !== "string") throw new Error("GitHub path is not a file");
  const decoded = atob(file.content.replace(/\s/g, ""));
  const bytes = Uint8Array.from(decoded, c => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function processDigest(digest, env, origin) {
  const validation = validateDigest(digest);
  if (!validation.ok) return { ok: false, error: validation.error };
  const outcomes = [];
  for (const story of digest.stories) {
    if (env.PUBLISH_ENABLED !== "true") {
      const prior = await env.DB.prepare("SELECT status FROM published_stories WHERE story_id = ?").bind(story.id).first();
      if (prior?.status === "sent") {
        outcomes.push({ id: story.id, status: "duplicate_skipped" });
      } else if (prior && prior.status !== "dry_run") {
        outcomes.push({ id: story.id, status: "manual_review_required" });
      } else {
        await upsertStory(env, story, "dry_run", origin);
        outcomes.push({ id: story.id, status: "dry_run" });
      }
      continue;
    }

    // Atomic claim: new stories and dry-run records may proceed. A pending/failed/sent
    // record is held for manual review to avoid duplicate sends after ambiguous failures.
    const claim = await env.DB.prepare(`INSERT INTO published_stories
      (story_id, source_url, title, status, origin, last_error, updated_at)
      VALUES (?, ?, ?, 'pending', ?, NULL, CURRENT_TIMESTAMP)
      ON CONFLICT(story_id) DO UPDATE SET status='pending', origin=excluded.origin,
      last_error=NULL, updated_at=CURRENT_TIMESTAMP
      WHERE published_stories.status='dry_run'`)
      .bind(story.id, story.source_url, story.title, origin).run();
    if ((claim.meta?.changes ?? 0) !== 1) {
      const prior = await env.DB.prepare("SELECT status FROM published_stories WHERE story_id = ?").bind(story.id).first();
      outcomes.push({ id: story.id, status: prior?.status === "sent" ? "duplicate_skipped" : "manual_review_required" });
      continue;
    }

    try {
      await sendTelegram(env, story);
      await upsertStory(env, story, "sent", origin);
      outcomes.push({ id: story.id, status: "sent" });
    } catch (error) {
      await upsertStory(env, story, "failed", origin, safeError(error));
      outcomes.push({ id: story.id, status: "failed", error: safeError(error) });
    }
  }
  const ok = outcomes.every(x => ["sent", "dry_run", "duplicate_skipped"].includes(x.status));
  await logEvent(env, ok ? "digest_processed" : "digest_partial_failure", JSON.stringify({ batch_id: digest.batch_id, origin, outcomes }));
  return { ok, batch_id: digest.batch_id, outcomes };
}

function codePointLength(value) { return Array.from(String(value)).length; }

function truncateCodePoints(value, maxLength) {
  return Array.from(String(value)).slice(0, Math.max(0, maxLength)).join("");
}

function isTelegramProxyUrl(value) {
  try {
    const url = new URL(String(value).trim());
    return url.protocol === "https:"
      && ["t.me", "telegram.me"].includes(url.hostname.toLowerCase())
      && !url.username && !url.password;
  } catch {
    return false;
  }
}

function extractProxyLinks(summary, story = {}) {
  const links = {};
  for (const key of ["1", "2"]) {
    const direct = story[`proxy${key}_url`];
    if (direct && isTelegramProxyUrl(direct)) links[key] = new URL(direct).toString();
  }

  const keptLines = [];
  for (const line of String(summary || "").split(/\r?\n/)) {
    const match = line.match(/(?:پروکسی|proxy)\s*([12۱۲])\s*[:：-]?\s*(https:\/\/\S+)/i);
    if (!match) {
      keptLines.push(line);
      continue;
    }
    const key = ({ "1": "1", "2": "2", "۱": "1", "۲": "2" })[match[1]];
    const candidate = match[2].replace(/[),،؛.]+$/, "");
    if (isTelegramProxyUrl(candidate)) {
      if (!links[key]) links[key] = new URL(candidate).toString();
    } else {
      keptLines.push(line);
    }
  }
  return { summary: keptLines.join("\n").trim(), links };
}

function formatSummaryHtml(summary, maxVisibleLength = 2500, story = {}) {
  const extracted = extractProxyLinks(summary, story);
  const proxyLabels = [];
  for (const key of ["1", "2"]) {
    if (extracted.links[key]) proxyLabels.push(`<a href="${escapeAttribute(extracted.links[key])}">پروکسی${key}</a>`);
  }
  const proxyTextLength = proxyLabels.length ? proxyLabels.length * 7 + (proxyLabels.length - 1) * 3 : 0;
  const cleanSummary = truncateCodePoints(extracted.summary, Math.max(0, maxVisibleLength - proxyTextLength));
  const parts = [];
  if (cleanSummary) parts.push(escapeHtml(cleanSummary));
  if (proxyLabels.length) parts.push(proxyLabels.join(" | "));
  return parts.join("\n\n");
}

export function buildStoryCaption(story, statusLabel = "") {
  const fixedParts = [`📰 ${story.title}`, "🔎 منبع خبر"];
  if (story.category) fixedParts.push(`🏷 ${story.category}`);
  if (story.published_at) fixedParts.push(`📅 ${story.published_at}`);
  if (story.image_credit) fixedParts.push(`🖼 تصویر: ${story.image_credit}`);
  if (statusLabel) fixedParts.push(`وضعیت: ${statusLabel}`);
  const fixedLength = codePointLength(fixedParts.join("\n\n"));
  const summaryBudget = Math.max(0, 1024 - fixedLength - 2);
  const parts = [
    `<b>${escapeHtml(story.title)}</b>`,
    formatSummaryHtml(story.summary, summaryBudget, story),
    `<a href="${escapeAttribute(story.source_url)}">🔎 منبع خبر</a>`
  ];
  if (story.category) parts.push(`🏷 ${escapeHtml(story.category)}`);
  if (story.published_at) parts.push(`📅 ${escapeHtml(story.published_at)}`);
  if (story.image_credit) parts.push(`🖼 تصویر: ${escapeHtml(story.image_credit)}`);
  if (statusLabel) parts.push(`وضعیت: ${escapeHtml(statusLabel)}`);
  return parts.join("\n\n");
}

function buildStoryText(story, statusLabel = "") {
  const parts = [
    `<b>${escapeHtml(story.title)}</b>`,
    formatSummaryHtml(story.summary, 2500, story),
    `🔎 <a href="${escapeAttribute(story.source_url)}">منبع خبر</a>`
  ];
  if (story.category) parts.push(`🏷 ${escapeHtml(story.category)}`);
  if (story.published_at) parts.push(`📅 ${escapeHtml(story.published_at)}`);
  if (story.image_credit) parts.push(`🖼 تصویر: ${escapeHtml(story.image_credit)}`);
  if (statusLabel) parts.push(`وضعیت: <b>${escapeHtml(statusLabel)}</b>`);
  return parts.join("\n\n");
}

function decodeHtmlEntities(value) {
  return String(value)
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function readHtmlAttribute(tag, name) {
  const attributes = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let match;
  while ((match = attributes.exec(tag)) !== null) {
    if (match[1].toLowerCase() === name.toLowerCase()) {
      return decodeHtmlEntities(match[2] ?? match[3] ?? match[4] ?? "");
    }
  }
  return "";
}

function findPageImage(html) {
  const candidates = [];
  for (const tag of String(html).match(/<meta\b[^>]*>/gi) || []) {
    const key = (
      readHtmlAttribute(tag, "property")
      || readHtmlAttribute(tag, "name")
      || readHtmlAttribute(tag, "itemprop")
    ).toLowerCase();
    if (["og:image", "og:image:url", "og:image:secure_url", "twitter:image", "twitter:image:src", "image"].includes(key)) {
      const content = readHtmlAttribute(tag, "content");
      if (content) candidates.push(content);
    }
  }
  return candidates[0] || "";
}

async function resolveStoryImageUrl(story) {
  if (story.image_url) return story.image_url;
  try {
    const source = new URL(story.source_url);
    if (source.protocol !== "https:") return null;
    const response = await fetch(source.toString(), {
      headers: {
        "accept": "text/html,application/xhtml+xml",
        "user-agent": "Mozilla/5.0 (compatible; TelegramNewsPublisher/1.0)"
      },
      redirect: "follow"
    });
    if (!response.ok) return null;
    const contentType = response.headers.get("content-type") || "";
    if (contentType && !/text\/html|application\/xhtml\+xml/i.test(contentType)) return null;
    const html = (await response.text()).slice(0, 1_000_000);
    const candidate = findPageImage(html);
    if (!candidate) return null;
    const imageUrl = new URL(candidate, response.url || source.toString());
    if (imageUrl.protocol !== "https:" || !imageUrl.hostname || imageUrl.username || imageUrl.password) return null;
    if (["localhost", "127.0.0.1", "::1"].includes(imageUrl.hostname.toLowerCase())) return null;
    return imageUrl.toString();
  } catch {
    return null;
  }
}

export async function sendStoryToChat(env, chatId, story, replyMarkup, statusLabel = "") {");
  const match = tag.match(new RegExp(`(?:^|\\s)${escapedName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return match ? decodeHtmlEntities(match[1] ?? match[2] ?? match[3] ?? "") : "";
}

function findPageImage(html) {
  const candidates = [];
  for (const tag of String(html).match(/<meta\\b[^>]*>/gi) || []) {
    const key = (readHtmlAttribute(tag, "property") || readHtmlAttribute(tag, "name") || readHtmlAttribute(tag, "itemprop")).toLowerCase();
    if (["og:image", "og:image:url", "og:image:secure_url", "twitter:image", "twitter:image:src", "image"].includes(key)) {
      const content = readHtmlAttribute(tag, "content");
      if (content) candidates.push(content);
    }
  }
  return candidates[0] || "";
}

async function resolveStoryImageUrl(story) {
  if (story.image_url) return story.image_url;
  try {
    const source = new URL(story.source_url);
    if (source.protocol !== "https:") return null;
    const response = await fetch(source.toString(), {
      headers: {
        "accept": "text/html,application/xhtml+xml",
        "user-agent": "Mozilla/5.0 (compatible; TelegramNewsPublisher/1.0)"
      },
      redirect: "follow"
    });
    if (!response.ok) return null;
    const contentType = response.headers.get("content-type") || "";
    if (contentType && !/text\\/html|application\\/xhtml\\+xml/i.test(contentType)) return null;
    const html = (await response.text()).slice(0, 1_000_000);
    const candidate = findPageImage(html);
    if (!candidate) return null;
    const imageUrl = new URL(candidate, response.url || source.toString());
    if (imageUrl.protocol !== "https:" || !imageUrl.hostname || imageUrl.username || imageUrl.password) return null;
    if (["localhost", "127.0.0.1", "::1"].includes(imageUrl.hostname.toLowerCase())) return null;
    return imageUrl.toString();
  } catch {
    return null;
  }
}

export async function sendStoryToChat(env, chatId, story, replyMarkup, statusLabel = "") {
  if (!env.TELEGRAM_BOT_TOKEN || !chatId) throw new Error("Missing Telegram credentials or target chat");
  const endpoint = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`;
  const requestTelegram = async (method, payload) => {
    const response = await fetch(`${endpoint}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    let result;
    try { result = await response.json(); }
    catch { throw new Error(`Telegram ${method} returned an unreadable response (HTTP ${response.status})`); }
    return { response, result };
  };

  const resolvedImageUrl = await resolveStoryImageUrl(story);
  if (resolvedImageUrl) {
    const photoPayload = {
      chat_id: chatId,
      photo: resolvedImageUrl,
      caption: buildStoryCaption(story, statusLabel),
      parse_mode: "HTML",
      disable_notification: false
    };
    if (replyMarkup) photoPayload.reply_markup = replyMarkup;
    const photoResult = await requestTelegram("sendPhoto", photoPayload);
    if (photoResult.response.ok && photoResult.result?.ok === true) return;
    if (photoResult.result?.ok !== false) {
      throw new Error(`Telegram photo send failed with HTTP ${photoResult.response.status}`);
    }
    await logEvent(env, "photo_send_fallback", `${story.id}: ${safeError(photoResult.result.description || "Telegram rejected the image")}`);
  }

  const textPayload = {
    chat_id: chatId,
    text: buildStoryText(story, statusLabel),
    parse_mode: "HTML",
    disable_web_page_preview: false
  };
  if (replyMarkup) textPayload.reply_markup = replyMarkup;
  const textResult = await requestTelegram("sendMessage", textPayload);
  if (!textResult.response.ok || !textResult.result?.ok) {
    throw new Error(`Telegram text send failed with HTTP ${textResult.response.status}: ${textResult.result?.description || "unknown error"}`);
  }
}

async function sendTelegram(env, story) {
  if (!env.TELEGRAM_CHANNEL_ID) throw new Error("Missing Telegram channel ID");
  return sendStoryToChat(env, env.TELEGRAM_CHANNEL_ID, story);
}

async function upsertStory(env, story, status, origin, error = null) {
  await env.DB.prepare(`INSERT INTO published_stories (story_id, source_url, title, status, origin, last_error, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(story_id) DO UPDATE SET status=excluded.status, origin=excluded.origin, last_error=excluded.last_error, updated_at=CURRENT_TIMESTAMP`)
    .bind(story.id, story.source_url, story.title, status, origin, error).run();
}

async function logEvent(env, event, detail) {
  try { await env.DB.prepare("INSERT INTO event_logs (event, detail, created_at) VALUES (?, ?, CURRENT_TIMESTAMP)").bind(event, String(detail).slice(0, 3000)).run(); } catch { /* logging must not mask the original failure */ }
}

function escapeHtml(value) { return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"); }
function escapeAttribute(value) { return escapeHtml(value).replaceAll('"', "&quot;"); }
function safeError(error) { return String(error?.message || error || "unknown error").slice(0, 500); }


async function handleTelegramUpdate(update, env) {
  const message = update?.message;
  if (message?.text) {
    const chatId = message.chat?.id;
    if (String(message.chat?.type) !== "private" || !chatId) return;
    const fromId = String(message.from?.id || "");
    const admin = isAdmin(fromId, env);
    const command = message.text.trim().split(/\\s+/)[0].split("@")[0].toLowerCase();

    // Public commands are available to every user in a private chat.
    if (command === "/start" || command === "/menu") {
      return admin ? sendAdminMenu(env, chatId) : sendPublicMenu(env, chatId);
    }
    if (command === "/latest") return showLatestNews(env, chatId, admin);
    if (command === "/help") return sendPublicMenu(env, chatId);
    if (command === "/settings") {
      return admin
        ? showPublicationSettings(env, chatId)
        : sendBotMessage(env, chatId, "این بخش فقط برای مدیر ربات در دسترس است. برای مشاهده خبرها از دستور /latest استفاده کن.");
    }
    return sendPublicMenu(env, chatId);
  }

  const callback = update?.callback_query;
  if (!callback) return;
  const data = String(callback.data || "");
  const chatId = callback.message?.chat?.id;
  if (!chatId || String(callback.message?.chat?.type) !== "private") return;

  // The public latest-news button is read-only and does not require admin access.
  if (data === "public_latest") {
    await answerCallback(env, callback.id);
    return showLatestNews(env, chatId, false);
  }

  const userId = String(callback.from?.id || "");
  if (!isAdmin(userId, env)) {
    await answerCallback(env, callback.id, "این عملیات فقط برای مدیر ربات مجاز است.", true);
    return;
  }
  await answerCallback(env, callback.id);

  if (data === "menu") return sendAdminMenu(env, chatId);
  if (data === "latest") return showLatestNews(env, chatId, true);
  if (data === "settings") return showPublicationSettings(env, chatId);
  if (data === "mode:manual" || data === "mode:auto") {
    await setSetting(env, "publication_mode", data.slice(5));
    await logEvent(env, "publication_mode_changed", data.slice(5));
    return showPublicationSettings(env, chatId, true);
  }
  if (data.startsWith("approve:")) return reviewStory(env, chatId, data.slice(8), "approved");
  if (data.startsWith("reject:")) return reviewStory(env, chatId, data.slice(7), "rejected");
}
function isAdmin(userId, env) {
  return Boolean(env.TELEGRAM_ADMIN_USER_ID && userId && userId === String(env.TELEGRAM_ADMIN_USER_ID));
}

function adminMenuKeyboard() {
  return { inline_keyboard: [
    [{ text: "🗞 آخرین اخبار جمع‌آوری‌شده", callback_data: "latest" }],
    [{ text: "⚙️ تنظیم شیوه انتشار", callback_data: "settings" }]
  ] };
}

function publicMenuKeyboard() {
  return { inline_keyboard: [[{ text: "🗞 مشاهده آخرین خبرها", callback_data: "public_latest" }]] };
}

async function sendPublicMenu(env, chatId) {
  return sendBotMessage(env, chatId,
    "سلام! به ربات اخبار فناوری و هوش مصنوعی خوش آمدی.\\n\\nبرای دیدن آخرین خبرهای آماده، روی دکمه زیر بزن یا دستور /latest را ارسال کن.",
    publicMenuKeyboard());
}

async function sendAdminMenu(env, chatId) {
  const mode = await getSetting(env, "publication_mode", "manual");
  return sendBotMessage(env, chatId, `پنل مدیریت اخبار\\n\\nوضعیت انتشار: ${mode === "auto" ? "خودکار" : "با تأیید مدیر"}\\nکلید اصلی انتشار: ${env.PUBLISH_ENABLED === "true" ? "روشن" : "خاموش"}`, adminMenuKeyboard());
}

async function showPublicationSettings(env, chatId, changed = false) {
  const mode = await getSetting(env, "publication_mode", "manual");
  const text = `⚙️ <b>تنظیم شیوه انتشار</b>\\n\\nحالت فعلی: <b>${mode === "auto" ? "انتشار خودکار" : "انتشار با تأیید مدیر"}</b>\\n\\n${env.PUBLISH_ENABLED === "true" ? "کلید اصلی انتشار روشن است." : "کلید اصلی انتشار خاموش است؛ در این وضعیت هیچ خبری به کانال ارسال نمی‌شود، حتی اگر حالت خودکار انتخاب شود."}${changed ? "\\n\\nتنظیم ذخیره شد." : ""}`;
  return sendBotMessage(env, chatId, text, { inline_keyboard: [
    [{ text: mode === "manual" ? "✓ با تأیید مدیر" : "با تأیید مدیر", callback_data: "mode:manual" }],
    [{ text: mode === "auto" ? "✓ انتشار خودکار" : "انتشار خودکار", callback_data: "mode:auto" }],
    [{ text: "⬅️ بازگشت", callback_data: "menu" }]
  ] }, "HTML");
}

async function showLatestNews(env, chatId, adminView = true) {
  const digest = await fetchGitHubDigest(env);
  if (!digest) return sendBotMessage(env, chatId, "هنوز فایل اخبار آماده‌ای در GitHub وجود ندارد.");
  const validation = validateDigest(digest);
  if (!validation.ok) return sendBotMessage(env, chatId, `بسته خبری معتبر نیست: ${validation.error}`);
  if (adminView) await queueDigestForReview(digest, env, "admin_preview");
  const intro = adminView
    ? `🗞 آخرین بسته خبری\\nشناسه: ${escapeHtml(digest.batch_id)}\\nتعداد خبر: ${digest.stories.length}\\n\\nهر خبر را جداگانه بررسی و تأیید یا رد کن.`
    : `🗞 آخرین خبرهای آماده\\nتعداد خبر: ${digest.stories.length}`;
  await sendBotMessage(env, chatId, intro, undefined, "HTML");
  for (const story of digest.stories) {
    let keyboard;
    let statusLabel = "";
    if (adminView) {
      const status = await env.DB.prepare("SELECT review_status FROM story_review_queue WHERE story_id = ?").bind(story.id).first();
      statusLabel = status?.review_status === "approved" ? "تأیید شده" : status?.review_status === "rejected" ? "رد شده" : "در انتظار بررسی";
      keyboard = status?.review_status === "pending" ? { inline_keyboard: [[
        { text: "✅ تأیید و انتشار", callback_data: `approve:${story.id}` },
        { text: "❌ رد خبر", callback_data: `reject:${story.id}` }
      ]] } : { inline_keyboard: [[{ text: "↻ به‌روزرسانی فهرست", callback_data: "latest" }]] };
    }
    await sendStoryToChat(env, chatId, story, keyboard, statusLabel);
  }
}

async function queueDigestForReview(digest, env, origin) {
  let inserted = 0;
  for (const story of digest.stories) {
    const result = await env.DB.prepare(`INSERT INTO story_review_queue (story_id, batch_id, story_json, review_status, origin, updated_at)
      VALUES (?, ?, ?, 'pending', ?, CURRENT_TIMESTAMP)
      ON CONFLICT(story_id) DO UPDATE SET
        batch_id=excluded.batch_id,
        story_json=excluded.story_json,
        origin=excluded.origin,
        updated_at=CURRENT_TIMESTAMP
      WHERE story_review_queue.review_status='pending'
        AND story_review_queue.story_json != excluded.story_json`)
      .bind(story.id, digest.batch_id, JSON.stringify(story), origin).run();
    inserted += result.meta?.changes ?? 0;
  }
  return inserted;
}

async function notifyPendingDigest(env, digest) {
  const pending = await env.DB.prepare("SELECT COUNT(*) AS count FROM story_review_queue WHERE batch_id = ? AND review_status = 'pending'").bind(digest.batch_id).first();
  if (!pending?.count) return;
  await sendBotMessage(env, env.TELEGRAM_ADMIN_USER_ID, `🆕 بسته خبری تازه آماده بررسی است. تعداد خبرهای در انتظار: ${pending.count}`, adminMenuKeyboard());
}

async function reviewStory(env, chatId, storyId, decision) {
  const row = await env.DB.prepare("SELECT story_json, review_status FROM story_review_queue WHERE story_id = ?").bind(storyId).first();
  if (!row) return sendBotMessage(env, chatId, "این خبر در صف بررسی پیدا نشد.");
  if (row.review_status !== "pending") return sendBotMessage(env, chatId, `این خبر قبلاً تعیین تکلیف شده است: ${row.review_status}`);
  if (decision === "rejected") {
    await env.DB.prepare("UPDATE story_review_queue SET review_status='rejected', updated_at=CURRENT_TIMESTAMP WHERE story_id=? AND review_status='pending'").bind(storyId).run();
    await logEvent(env, "story_rejected", storyId);
    return sendBotMessage(env, chatId, "خبر رد شد و منتشر نخواهد شد.");
  }
  if (env.PUBLISH_ENABLED !== "true") return sendBotMessage(env, chatId, "انتشار فعلاً متوقف است. ابتدا کلید اصلی PUBLISH_ENABLED را در Cloudflare روشن کن؛ تا آن زمان هیچ خبری ارسال نمی‌شود.");
  const claim = await env.DB.prepare("UPDATE story_review_queue SET review_status='publishing', updated_at=CURRENT_TIMESTAMP WHERE story_id=? AND review_status='pending'").bind(storyId).run();
  if ((claim.meta?.changes ?? 0) !== 1) return sendBotMessage(env, chatId, "این خبر هم‌زمان توسط درخواست دیگری بررسی شده است.");
  const story = JSON.parse(row.story_json);
  try {
    await publishReviewedStory(env, story);
    await env.DB.prepare("UPDATE story_review_queue SET review_status='published', updated_at=CURRENT_TIMESTAMP WHERE story_id=?").bind(storyId).run();
    await logEvent(env, "story_approved_and_published", storyId);
    return sendBotMessage(env, chatId, `✅ خبر منتشر شد:\\n${escapeHtml(story.title)}`, undefined, "HTML");
  } catch (error) {
    await env.DB.prepare("UPDATE story_review_queue SET review_status='pending', updated_at=CURRENT_TIMESTAMP WHERE story_id=?").bind(storyId).run();
    await logEvent(env, "story_publish_failed", `${storyId}: ${safeError(error)}`);
    return sendBotMessage(env, chatId, `ارسال انجام نشد: ${escapeHtml(safeError(error))}`, undefined, "HTML");
  }
}

async function publishReviewedStory(env, story) {
  const prior = await env.DB.prepare("SELECT status FROM published_stories WHERE story_id=?").bind(story.id).first();
  if (prior?.status === "sent") throw new Error("این خبر قبلاً منتشر شده است.");
  if (prior && prior.status !== "dry_run") throw new Error("وضعیت قبلی خبر نیازمند بررسی دستی است.");
  await env.DB.prepare(`INSERT INTO published_stories (story_id, source_url, title, status, origin, last_error, updated_at)
    VALUES (?, ?, ?, 'pending', 'telegram_approval', NULL, CURRENT_TIMESTAMP)
    ON CONFLICT(story_id) DO UPDATE SET status='pending', origin='telegram_approval', last_error=NULL, updated_at=CURRENT_TIMESTAMP
    WHERE published_stories.status='dry_run'`)
    .bind(story.id, story.source_url, story.title).run();
  await sendTelegram(env, story);
  await upsertStory(env, story, "sent", "telegram_approval");
}

async function getSetting(env, key, fallback) {
  const row = await env.DB.prepare("SELECT setting_value FROM app_settings WHERE setting_key=?").bind(key).first();
  return row?.setting_value ?? fallback;
}

async function setSetting(env, key, value) {
  await env.DB.prepare(`INSERT INTO app_settings (setting_key, setting_value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(setting_key) DO UPDATE SET setting_value=excluded.setting_value, updated_at=CURRENT_TIMESTAMP`).bind(key, value).run();
}

async function sendBotMessage(env, chatId, text, replyMarkup, parseMode) {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN");
  const payload = { chat_id: chatId, text, disable_web_page_preview: true };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  if (parseMode) payload.parse_mode = parseMode;
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload)
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(`Telegram send failed with HTTP ${response.status}: ${result.description || "unknown error"}`);
}

async function answerCallback(env, callbackId, text = "", showAlert = false) {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackId, text, show_alert: showAlert })
  });
  if (!response.ok) throw new Error(`Telegram callback response failed with HTTP ${response.status}`);
}
