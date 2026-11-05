import { refreshNewsFeeds, listNewsFeedCandidates } from "./news-feed.js";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/feed/candidates") {
      try {
        const rawLimit = Number(url.searchParams.get("limit") || 60);
        const items = await listNewsFeedCandidates(env.DB, rawLimit);
        return json({
          ok: true,
          count: items.length,
          generated_at: new Date().toISOString(),
          items
        });
      } catch (error) {
        return json({ ok: false, error: safeError(error) }, 503);
      }
    }
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "telegram-news-publisher", mode: env.PUBLISH_ENABLED === "true" ? "publish" : "dry-run" });
    }
    if (request.method === "POST" && url.pathname === "/telegram/webhook") {
      if (!env.TELEGRAM_WEBHOOK_SECRET || request.headers.get("x-telegram-bot-api-secret-token") !== env.TELEGRAM_WEBHOOK_SECRET) return json({ error: "unauthorized webhook" }, 401);
      let update;
      try { update = await request.json(); } catch { return json({ error: "invalid update" }, 400); }
      if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0) {
        return json({ error: "Telegram update_id is required" }, 400);
      }

      let claimed;
      try {
        claimed = await claimTelegramUpdate(env, update.update_id);
      } catch (error) {
        await logEvent(env, "telegram_update_claim_failed", `${update.update_id}: ${safeError(error)}`);
        return json({ ok: false, error: "could not register Telegram update" }, 500);
      }
      if (!claimed) return json({ ok: true, duplicate: true });

      try {
        await handleTelegramUpdate(update, env);
        await setTelegramUpdateStatus(env, update.update_id, "processed");
        return json({ ok: true });
      } catch (error) {
        try { await setTelegramUpdateStatus(env, update.update_id, "failed", safeError(error)); }
        catch (statusError) {
          await logEvent(env, "telegram_update_status_failed", `${update.update_id}: ${safeError(statusError)}`);
        }
        await logEvent(env, "telegram_ui_error", `${update.update_id}: ${safeError(error)}`);
        return json({ ok: false, error: safeError(error) }, 500);
      }
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
    if (request.method === "POST" && url.pathname === "/admin/webhook-status") {
      if (!authorized(request, env)) return json({ error: "unauthorized" }, 401);
      if (!env.TELEGRAM_BOT_TOKEN) return json({ error: "TELEGRAM_BOT_TOKEN is not configured" }, 400);
      try {
        const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getWebhookInfo`);
        const result = await response.json();
        if (!response.ok || !result.ok) throw new Error(result.description || `Telegram getWebhookInfo failed with HTTP ${response.status}`);
        const info = result.result || {};
        return json({
          ok: true,
          webhook_configured: Boolean(info.url),
          url: info.url || null,
          pending_update_count: info.pending_update_count ?? 0,
          callback_query_enabled: !Array.isArray(info.allowed_updates) || info.allowed_updates.includes("callback_query"),
          allowed_updates: info.allowed_updates || null,
          last_error_date: info.last_error_date || null,
          last_error_message: info.last_error_message || null
        });
      } catch (error) {
        return json({ ok: false, error: safeError(error) }, 502);
      }
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
        try { await pruneTelegramWebhookUpdates(env); }
        catch (error) { await logEvent(env, "webhook_update_prune_failed", safeError(error)); }

        // Refresh trusted RSS sources on every Cron run. Feed discovery is separate
        // from editorial approval: only the GPT-prepared three-story digest is queued.
        try {
          const feedReport = await refreshNewsFeeds(env);
          await logEvent(env, "news_feeds_refreshed", JSON.stringify(feedReport));
        } catch (error) {
          await logEvent(env, "news_feed_refresh_failed", safeError(error));
        }

        // Refresh the persistent queue from the current GitHub digest. If GitHub is
        // temporarily unavailable, the already queued stories can still be processed.
        try {
          const digest = await fetchGitHubDigest(env);
          if (digest) {
            const validation = validateDigest(digest);
            if (!validation.ok) {
              await logEvent(env, "validation_error", validation.error);
            } else {
              const queuedCount = await queueDigestForReview(digest, env, "scheduled");
              await logEvent(env, "scheduled_digest_queued", JSON.stringify({
                batch_id: digest.batch_id,
                queued_or_updated: queuedCount
              }));
            }
          }
        } catch (error) {
          await logEvent(env, "digest_fetch_failed", safeError(error));
        }

        // PUBLISH_ENABLED remains the single global emergency stop.
        // Each six-hour Cron invocation publishes at most one queued story.
        if (env.PUBLISH_ENABLED !== "true") {
          await logEvent(env, "auto_publish_paused", "PUBLISH_ENABLED master switch is false");
          return;
        }
        await publishNextQueuedStory(env, "scheduled");
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

async function claimTelegramUpdate(env, updateId) {
  const result = await env.DB.prepare(`INSERT INTO telegram_webhook_updates (update_id, status, updated_at)
    VALUES (?, 'processing', CURRENT_TIMESTAMP)
    ON CONFLICT(update_id) DO NOTHING`)
    .bind(updateId).run();
  return (result.meta?.changes ?? 0) === 1;
}

async function setTelegramUpdateStatus(env, updateId, status, error = null) {
  await env.DB.prepare(`UPDATE telegram_webhook_updates
    SET status = ?, last_error = ?, updated_at = CURRENT_TIMESTAMP
    WHERE update_id = ?`)
    .bind(status, error, updateId).run();
}

async function pruneTelegramWebhookUpdates(env) {
  await env.DB.prepare(`DELETE FROM telegram_webhook_updates
    WHERE created_at < datetime('now', '-30 days')`).run();
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
    const imageFields = ["image_url", "image_credit", "image_alt"];
    const imageFieldPresent = imageFields.map(key => typeof s[key] === "string" && s[key].trim().length > 0);
    if (imageFieldPresent.some(Boolean) && !imageFieldPresent.every(Boolean)) {
      return { ok: false, error: `stories[${i}] must include image_url, image_credit, and image_alt together, or omit all three` };
    }
    if (imageFieldPresent.every(Boolean)) {
      if (s.image_url.length > 2048) return { ok: false, error: `stories[${i}].image_url is invalid` };
      try {
        const imageUrl = new URL(s.image_url);
        if (imageUrl.protocol !== "https:" || !imageUrl.hostname || imageUrl.username || imageUrl.password) return { ok: false, error: `stories[${i}].image_url must be a public HTTPS URL` };
      } catch { return { ok: false, error: `stories[${i}].image_url is invalid` }; }
      if (s.image_credit.length > 160) return { ok: false, error: `stories[${i}].image_credit is invalid` };
    }
    for (const key of ["proxy1_url", "proxy2_url"]) {
      if (s[key] !== undefined && s[key] !== null && s[key] !== "") {
        if (typeof s[key] !== "string" || s[key].length > 2048) return { ok: false, error: `stories[${i}].${key} is invalid` };
        try {
          const proxyUrl = new URL(s[key]);
          if (proxyUrl.protocol !== "https:" || !proxyUrl.hostname || proxyUrl.username || proxyUrl.password) return { ok: false, error: `stories[${i}].${key} must be a public HTTPS URL` };
        } catch { return { ok: false, error: `stories[${i}].${key} is invalid` }; }
      }
    }
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
  const proxyLinks = env.PUBLISH_ENABLED === "true"
    ? await resolveProxyLinksFromDigest(digest, env)
    : [];
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
      await sendTelegram(env, story, proxyLinks);
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

const RTL_MARK = "\u200f";

export function addRtlParagraphMarks(value) {
  return String(value).split("\n").map(line => line ? `${RTL_MARK}${line}` : line).join("\n");
}

function stripProxyPostLinks(value) {
  return String(value || "")
    .split(/\r?\n/)
    .filter(line => {
      const hasProxyPostUrl = /https?:\/\/t\.me\/(?:s\/)?proxymtproto\/\d+/i.test(line);
      return !(hasProxyPostUrl && /پروکسی|proxy/i.test(line));
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildChannelLinkHtml() {
  return '<a href="https://t.me/Tech4UsNews">@Tech4UsNews</a>';
}

function visibleHtmlTextLength(value) {
  return codePointLength(decodeHtmlEntities(String(value).replace(/<[^>]*>/g, "")));
}

export function buildStoryCaption(story, statusLabel = "") {
  const tail = [
    `<a href="${escapeAttribute(story.source_url)}">🔎 منبع خبر</a>`,
    story.category ? `🏷 ${escapeHtml(story.category)}` : "",
    story.published_at ? `📅 ${escapeHtml(story.published_at)}` : "",
    story.image_credit ? `🖼 تصویر: ${escapeHtml(story.image_credit)}` : "",
    statusLabel ? `وضعیت: ${escapeHtml(statusLabel)}` : "",
    buildChannelLinkHtml()
  ].filter(Boolean);
  const cleanSummary = stripProxyPostLinks(story.summary);
  const makeCaption = summaryLength => addRtlParagraphMarks([
    `<b>${escapeHtml(story.title)}</b>`,
    escapeHtml(truncateCodePoints(cleanSummary, summaryLength)),
    ...tail
  ].join("\n\n"));

  let low = 0;
  let high = codePointLength(cleanSummary);
  let best = makeCaption(0);
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = makeCaption(middle);
    if (visibleHtmlTextLength(candidate) <= 1024) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

function buildStoryText(story, statusLabel = "") {
  const parts = [
    `<b>${escapeHtml(story.title)}</b>`,
    escapeHtml(stripProxyPostLinks(story.summary)),
    `🔎 <a href="${escapeAttribute(story.source_url)}">منبع خبر</a>`
  ];
  if (story.category) parts.push(`🏷 ${escapeHtml(story.category)}`);
  if (story.published_at) parts.push(`📅 ${escapeHtml(story.published_at)}`);
  if (story.image_credit) parts.push(`🖼 تصویر: ${escapeHtml(story.image_credit)}`);
  if (statusLabel) parts.push(`وضعیت: <b>${escapeHtml(statusLabel)}</b>`);
  parts.push(buildChannelLinkHtml());
  return addRtlParagraphMarks(parts.join("\n\n"));
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

function buildMtprotoProxyUrl(server, port, secret) {
  const host = String(server || "").trim();
  const portNumber = Number(String(port || "").trim());
  const secretValue = String(secret || "").trim();
  const validHost = /^[a-z0-9.-]+$/i.test(host) || /^\[[0-9a-f:]+\]$/i.test(host);
  if (!validHost || host.length > 253 || host.toLowerCase() === "unknown") return null;
  if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) return null;
  if (!/^[a-z0-9+/_=-]{16,256}$/i.test(secretValue)) return null;
  const params = new URLSearchParams({ server: host, port: String(portNumber), secret: secretValue });
  return `https://t.me/proxy?${params.toString()}`;
}

function normalizeMtprotoProxyUrl(value) {
  try {
    const url = new URL(String(value || ""));
    const validHttps = url.protocol === "https:"
      && ["t.me", "www.t.me", "telegram.me"].includes(url.hostname.toLowerCase())
      && url.pathname.toLowerCase() === "/proxy";
    const validTelegram = url.protocol === "tg:" && url.hostname.toLowerCase() === "proxy";
    if (!validHttps && !validTelegram) return null;
    return buildMtprotoProxyUrl(url.searchParams.get("server"), url.searchParams.get("port"), url.searchParams.get("secret"));
  } catch {
    return null;
  }
}

export function extractProxyDeepLinkFromPostHtml(html, postPath) {
  const source = String(html || "");
  const markerPattern = /data-post\s*=\s*["']([^"']+)["']/gi;
  let marker;
  while ((marker = markerPattern.exec(source)) !== null) {
    if (marker[1].toLowerCase() !== String(postPath).toLowerCase()) continue;
    const blockStart = source.lastIndexOf("<div", marker.index);
    const nextMarkerPattern = /data-post\s*=\s*["']([^"']+)["']/gi;
    nextMarkerPattern.lastIndex = markerPattern.lastIndex;
    const nextMarker = nextMarkerPattern.exec(source);
    const blockEnd = nextMarker ? source.lastIndexOf("<div", nextMarker.index) : source.length;
    const block = source.slice(blockStart >= 0 ? blockStart : 0, blockEnd > blockStart ? blockEnd : source.length);

    for (const anchor of block.match(/<a\b[^>]*>/gi) || []) {
      const directLink = normalizeMtprotoProxyUrl(readHtmlAttribute(anchor, "href"));
      if (directLink) return directLink;
    }

    const text = decodeHtmlEntities(
      block
        .replace(/<br\s*\/?\s*>/gi, "\n")
        .replace(/<\/(?:div|p|code)>/gi, "\n")
        .replace(/<[^>]*>/g, " ")
    );
    const capture = label => {
      const expression = new RegExp("(?:^|\\s)" + label + "\\s*:\\s*['\"]?([^\\s'\"<>]+)", "i");
      return text.match(expression)?.[1] || "";
    };
    return buildMtprotoProxyUrl(capture("Server"), capture("Port"), capture("Secret"));
  }
  return null;
}

function extractProxyPostReference(value) {
  try {
    const url = new URL(String(value || ""));
    if (!["t.me", "www.t.me", "telegram.me"].includes(url.hostname.toLowerCase())) return null;
    const match = url.pathname.match(/^\/(?:s\/)?proxymtproto\/(\d+)$/i);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

export async function resolveProxyLinksFromDigest(digest, env) {
  const refs = new Map();
  for (const story of digest?.stories || []) {
    for (const [field, label] of [["proxy1_url", "اتصال پروکسی ۱"], ["proxy2_url", "اتصال پروکسی ۲"]]) {
      const postId = extractProxyPostReference(story?.[field]);
      if (postId && !refs.has(postId)) refs.set(postId, label);
    }
  }

  const resolved = await Promise.all([...refs.entries()].slice(0, 2).map(async ([postId, label]) => {
    try {
      const pageUrl = `https://t.me/s/ProxyMTProto?before=${Number(postId) + 1}`;
      const response = await fetch(pageUrl, {
        headers: {
          "accept": "text/html,application/xhtml+xml",
          "user-agent": "Mozilla/5.0 (compatible; TelegramNewsPublisher/1.0)"
        },
        redirect: "follow"
      });
      if (!response.ok) throw new Error(`Telegram proxy post fetch failed with HTTP ${response.status}`);
      const html = (await response.text()).slice(0, 1_000_000);
      const url = extractProxyDeepLinkFromPostHtml(html, `ProxyMTProto/${postId}`);
      if (!url) throw new Error("MTProto connection details were not found in the proxy post");
      return { label, url };
    } catch (error) {
      await logEvent(env, "proxy_resolution_failed", `${postId}: ${safeError(error)}`);
      return null;
    }
  }));
  return resolved.filter(Boolean);
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
  } else {
    await logEvent(env, "image_not_found", `${story.id}: no direct image_url or supported article image metadata`);
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

async function sendTelegram(env, story, proxyLinks = []) {
  if (!env.TELEGRAM_CHANNEL_ID) throw new Error("Missing Telegram channel ID");
  const keyboard = buildStoryKeyboard(story, proxyLinks, false);
  return sendStoryToChat(env, env.TELEGRAM_CHANNEL_ID, story, keyboard);
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
    const command = message.text.trim().split(/\s+/)[0].split("@")[0].toLowerCase();

    if (command === "/start" || command === "/menu") {
      return admin ? sendAdminMenu(env, chatId) : sendPublicMenu(env, chatId);
    }
    if (command === "/latest") return showLatestNewsGuarded(env, chatId, admin, update.update_id);
    if (command === "/help") return sendPublicMenu(env, chatId);
    if (command === "/settings") {
      return admin
        ? showPublicationSettings(env, chatId)
        : sendBotMessage(env, chatId, "این بخش فقط برای مدیر ربات در دسترس است. برای مشاهده خبرها از دستور /latest استفاده کن.");
    }
    return sendPublicMenu(env, chatId);
  }

  const callback = update?.callback_query;
  if (!callback?.id) return;
  const data = String(callback.data || "");
  const chat = callback.message?.chat;
  const chatId = chat?.id;
  if (!chatId || String(chat.type) !== "private") {
    await answerCallback(env, callback.id, "این دکمه فقط در گفتگوی خصوصی ربات کار می‌کند.", true);
    return;
  }

  if (data === "public_latest") {
    return showLatestNewsGuarded(env, chatId, false, update.update_id, callback.id);
  }

  const userId = String(callback.from?.id || "");
  if (!isAdmin(userId, env)) {
    await answerCallback(env, callback.id, "این عملیات فقط برای مدیر ربات مجاز است.", true);
    return;
  }

  if (data === "latest") {
    return showLatestNewsGuarded(env, chatId, true, update.update_id, callback.id);
  }

  await answerCallback(env, callback.id, "درخواست دریافت شد.");
  try {
    if (data === "menu") return await sendAdminMenu(env, chatId);
    if (data === "settings") return await showPublicationSettings(env, chatId);
    if (data === "mode:manual" || data === "mode:auto") {
      await setSetting(env, "publication_mode", data.slice(5));
      await logEvent(env, "publication_mode_changed", data.slice(5));
      await showPublicationSettings(env, chatId, true);
      return;
    }
    if (data.startsWith("approve:")) {
      await reviewStory(env, chatId, data.slice(8), "approved");
      return;
    }
    if (data.startsWith("reject:")) {
      await reviewStory(env, chatId, data.slice(7), "rejected");
      return;
    }
    await sendBotMessage(env, chatId, "این دکمه شناخته نشد. فهرست خبرها را با /latest تازه‌سازی کن.");
  } catch (error) {
    await logEvent(env, "telegram_callback_error", `${data.slice(0, 80)}: ${safeError(error)}`);
    await sendBotMessage(env, chatId, `عملیات انجام نشد: ${escapeHtml(safeError(error))}`, undefined, "HTML");
  }
}
function storyCallbackToken(storyId) {
  const mask = 0xffffffffffffffffn;
  const prime = 0x100000001b3n;
  let hash = 0xcbf29ce484222325n;
  const value = String(storyId);
  for (let i = 0; i < value.length; i++) {
    hash ^= BigInt(value.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return hash.toString(36);
}

export function buildStoryKeyboard(story, proxyLinks = [], adminView = false, reviewStatus = "pending") {
  const rows = [];
  if (adminView) {
    if (reviewStatus === "pending") {
      const token = storyCallbackToken(story.id);
      rows.push([
        { text: "✅ تأیید و انتشار", callback_data: `approve:${token}` },
        { text: "❌ رد خبر", callback_data: `reject:${token}` }
      ]);
    } else {
      rows.push([{ text: "↻ به‌روزرسانی فهرست", callback_data: "latest" }]);
    }
  }

  const proxyButtons = (proxyLinks || []).slice(0, 2).map((proxy, index) => {
    const url = normalizeMtprotoProxyUrl(proxy?.url);
    if (!url) return null;
    return {
      text: proxy.label || (index === 0 ? "اتصال پروکسی ۱" : "اتصال پروکسی ۲"),
      url
    };
  }).filter(Boolean);
  if (proxyButtons.length) rows.push(proxyButtons);

  for (const row of rows) {
    for (const button of row) {
      if (button.callback_data && new TextEncoder().encode(button.callback_data).length > 64) {
        throw new Error("Telegram callback_data exceeds the 64-byte limit");
      }
    }
  }
  return rows.length ? { inline_keyboard: rows } : undefined;
}

export function buildStoryReviewKeyboard(story, proxyLinks = []) {
  return buildStoryKeyboard(story, proxyLinks, true, "pending");
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
  const text = `⚙️ <b>تنظیم شیوه انتشار</b>\\n\\nمسیر زمان‌بندی‌شدهٔ Cloudflare: <b>خودکار؛ حداکثر یک خبر در هر اجرای ۶ ساعته</b>.\\n\\nحالت انتخابی زیر فقط برای ارسال از مسیر دستی/API است: <b>${mode === "auto" ? "انتشار خودکار" : "انتشار با تأیید مدیر"}</b>.\\n\\n${env.PUBLISH_ENABLED === "true" ? "کلید اصلی انتشار روشن است." : "کلید اصلی انتشار خاموش است؛ تا زمان روشن‌شدن آن هیچ خبری به کانال ارسال نمی‌شود."}${changed ? "\\n\\nتنظیم ذخیره شد." : ""}`;
  return sendBotMessage(env, chatId, text, { inline_keyboard: [
    [{ text: mode === "manual" ? "✓ با تأیید مدیر" : "با تأیید مدیر", callback_data: "mode:manual" }],
    [{ text: mode === "auto" ? "✓ انتشار خودکار" : "انتشار خودکار", callback_data: "mode:auto" }],
    [{ text: "⬅️ بازگشت", callback_data: "menu" }]
  ] }, "HTML");
}

const LATEST_VIEW_LOCK_SECONDS = 120;
const LATEST_VIEW_COOLDOWN_SECONDS = 10;

async function acquireLatestViewLock(env, chatId, updateId) {
  const result = await env.DB.prepare(`INSERT INTO telegram_latest_view_locks
      (chat_id, lock_update_id, locked_until, cooldown_until)
    VALUES (?, ?, unixepoch() + ${LATEST_VIEW_LOCK_SECONDS}, 0)
    ON CONFLICT(chat_id) DO UPDATE SET
      lock_update_id = excluded.lock_update_id,
      locked_until = excluded.locked_until
    WHERE telegram_latest_view_locks.locked_until <= unixepoch()
      AND telegram_latest_view_locks.cooldown_until <= unixepoch()`)
    .bind(String(chatId), updateId).run();
  return (result.meta?.changes ?? 0) === 1;
}

async function releaseLatestViewLock(env, chatId, updateId) {
  await env.DB.prepare(`UPDATE telegram_latest_view_locks
    SET locked_until = 0, cooldown_until = unixepoch() + ${LATEST_VIEW_COOLDOWN_SECONDS}
    WHERE chat_id = ? AND lock_update_id = ?`)
    .bind(String(chatId), updateId).run();
}

async function showLatestNewsGuarded(env, chatId, adminView, updateId, callbackId = null) {
  const acquired = await acquireLatestViewLock(env, chatId, updateId);
  if (!acquired) {
    if (callbackId) {
      await answerCallback(env, callbackId, "خبرها همین الان نمایش داده شدند؛ کمی بعد دوباره امتحان کن.");
    } else {
      await logEvent(env, "latest_view_throttled", String(chatId));
    }
    return;
  }

  try {
    if (callbackId) await answerCallback(env, callbackId, "در حال دریافت آخرین خبرها...");
    await showLatestNews(env, chatId, adminView);
  } finally {
    try { await releaseLatestViewLock(env, chatId, updateId); }
    catch (error) { await logEvent(env, "latest_view_lock_release_failed", safeError(error)); }
  }
}

async function showLatestNews(env, chatId, adminView = true) {
  const digest = await fetchGitHubDigest(env);
  if (!digest) return sendBotMessage(env, chatId, "هنوز فایل اخبار آماده‌ای در GitHub وجود ندارد.");
  const validation = validateDigest(digest);
  if (!validation.ok) return sendBotMessage(env, chatId, `بسته خبری معتبر نیست: ${validation.error}`);
  const proxyLinks = await resolveProxyLinksFromDigest(digest, env);
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
      keyboard = buildStoryKeyboard(story, proxyLinks, true, status?.review_status || "pending");
    } else {
      keyboard = buildStoryKeyboard(story, proxyLinks, false);
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

async function publishNextQueuedStory(env, origin) {
  const candidate = await env.DB.prepare(`SELECT q.story_id, q.story_json, q.batch_id
    FROM story_review_queue q
    LEFT JOIN published_stories p ON p.story_id = q.story_id
    WHERE q.review_status = 'pending'
      AND (p.story_id IS NULL OR p.status = 'dry_run')
    ORDER BY q.updated_at ASC, q.story_id ASC
    LIMIT 1`).first();

  if (!candidate) {
    await logEvent(env, "scheduled_no_unpublished_story", "No eligible pending story was found");
    return { sent: false, reason: "no_unpublished_stories" };
  }

  // Atomic queue claim prevents overlapping Cron invocations from sending the
  // same item. A story left in 'publishing' after an ambiguous failure is not retried.
  const queueClaim = await env.DB.prepare(`UPDATE story_review_queue
    SET review_status = 'publishing', updated_at = CURRENT_TIMESTAMP
    WHERE story_id = ? AND review_status = 'pending'`)
    .bind(candidate.story_id).run();

  if ((queueClaim.meta?.changes ?? 0) !== 1) {
    await logEvent(env, "scheduled_story_claim_lost", candidate.story_id);
    return { sent: false, reason: "story_claimed_by_another_execution" };
  }

  let story;
  try {
    story = JSON.parse(candidate.story_json);
  } catch (error) {
    await logEvent(env, "scheduled_story_invalid_json", `${candidate.story_id}: ${safeError(error)}`);
    return { sent: false, reason: "invalid_queued_story", story_id: candidate.story_id };
  }

  const publishClaim = await env.DB.prepare(`INSERT INTO published_stories
    (story_id, source_url, title, status, origin, last_error, updated_at)
    VALUES (?, ?, ?, 'pending', ?, NULL, CURRENT_TIMESTAMP)
    ON CONFLICT(story_id) DO UPDATE SET status='pending', origin=excluded.origin,
    last_error=NULL, updated_at=CURRENT_TIMESTAMP
    WHERE published_stories.status='dry_run'`)
    .bind(story.id, story.source_url, story.title, origin).run();

  if ((publishClaim.meta?.changes ?? 0) !== 1) {
    const prior = await env.DB.prepare("SELECT status FROM published_stories WHERE story_id = ?").bind(story.id).first();
    if (prior?.status === "sent") {
      await env.DB.prepare("UPDATE story_review_queue SET review_status='published', updated_at=CURRENT_TIMESTAMP WHERE story_id=?")
        .bind(story.id).run();
    }
    await logEvent(env, "scheduled_story_not_claimed", JSON.stringify({
      story_id: story.id,
      prior_status: prior?.status || "unknown"
    }));
    return { sent: false, reason: "manual_reconciliation_required", story_id: story.id };
  }

  try {
    const proxyLinks = await resolveProxyLinksFromDigest({ stories: [story] }, env);
    await sendTelegram(env, story, proxyLinks);
  } catch (error) {
    await upsertStory(env, story, "failed", origin, safeError(error));
    await logEvent(env, "scheduled_story_failed", `${story.id}: ${safeError(error)}`);
    // Keep the queue row in 'publishing'. Network failures can be ambiguous:
    // do not automatically retry and risk posting the same story twice.
    return { sent: false, reason: "send_failed_manual_review", story_id: story.id };
  }

  await upsertStory(env, story, "sent", origin);
  await env.DB.prepare("UPDATE story_review_queue SET review_status='published', updated_at=CURRENT_TIMESTAMP WHERE story_id=?")
    .bind(story.id).run();
  await logEvent(env, "scheduled_story_published", JSON.stringify({
    batch_id: candidate.batch_id,
    story_id: story.id
  }));
  return { sent: true, story_id: story.id, batch_id: candidate.batch_id };
}

async function notifyPendingDigest(env, digest) {
  const pending = await env.DB.prepare("SELECT COUNT(*) AS count FROM story_review_queue WHERE batch_id = ? AND review_status = 'pending'").bind(digest.batch_id).first();
  if (!pending?.count) return;
  await sendBotMessage(env, env.TELEGRAM_ADMIN_USER_ID, `🆕 بسته خبری تازه آماده بررسی است. تعداد خبرهای در انتظار: ${pending.count}`, adminMenuKeyboard());
}

async function findReviewQueueRow(env, storyRef) {
  const direct = await env.DB.prepare("SELECT story_id, story_json, review_status FROM story_review_queue WHERE story_id = ?").bind(storyRef).first();
  if (direct) return direct;
  const result = await env.DB.prepare("SELECT story_id, story_json, review_status FROM story_review_queue").bind().all();
  const matches = (result.results || []).filter(row => storyCallbackToken(row.story_id) === storyRef);
  if (matches.length > 1) throw new Error("شناسهٔ دکمه تکراری است؛ فهرست خبرها را تازه‌سازی کن.");
  return matches[0] || null;
}

async function reviewStory(env, chatId, storyRef, decision) {
  const row = await findReviewQueueRow(env, storyRef);
  if (!row) return sendBotMessage(env, chatId, "این خبر در صف بررسی پیدا نشد. فهرست را با /latest تازه‌سازی کن.");
  const storyId = row.story_id;
  if (row.review_status !== "pending") return sendBotMessage(env, chatId, `این خبر قبلاً تعیین تکلیف شده است: ${row.review_status}`);
  if (decision === "rejected") {
    const update = await env.DB.prepare("UPDATE story_review_queue SET review_status='rejected', updated_at=CURRENT_TIMESTAMP WHERE story_id=? AND review_status='pending'").bind(storyId).run();
    if ((update.meta?.changes ?? 0) !== 1) return sendBotMessage(env, chatId, "وضعیت خبر هم‌زمان تغییر کرده است؛ فهرست را تازه‌سازی کن.");
    await logEvent(env, "story_rejected", storyId);
    return sendBotMessage(env, chatId, "✅ خبر رد شد و در کانال منتشر نخواهد شد.");
  }
  if (env.PUBLISH_ENABLED !== "true") {
    await logEvent(env, "story_approval_blocked", `${storyId}: PUBLISH_ENABLED is not true`);
    return sendBotMessage(env, chatId, "تأیید دریافت شد، اما انتشار متوقف است. برای اجازهٔ انتشار، متغیر PUBLISH_ENABLED را در Cloudflare روی true قرار بده؛ سپس /latest را بزن و خبر را دوباره تأیید کن.");
  }
  const claim = await env.DB.prepare("UPDATE story_review_queue SET review_status='publishing', updated_at=CURRENT_TIMESTAMP WHERE story_id=? AND review_status='pending'").bind(storyId).run();
  if ((claim.meta?.changes ?? 0) !== 1) return sendBotMessage(env, chatId, "این خبر هم‌زمان توسط درخواست دیگری بررسی شده است؛ فهرست را تازه‌سازی کن.");
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
  const proxyLinks = await resolveProxyLinksFromDigest({ stories: [story] }, env);
  await sendTelegram(env, story, proxyLinks);
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
  const payload = { chat_id: chatId, text: addRtlParagraphMarks(text), disable_web_page_preview: true };
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
  let result;
  try { result = await response.json(); }
  catch { throw new Error(`Telegram callback response was unreadable (HTTP ${response.status})`); }
  if (!response.ok || result?.ok !== true) {
    throw new Error(result?.description || `Telegram callback response failed with HTTP ${response.status}`);
  }
}
