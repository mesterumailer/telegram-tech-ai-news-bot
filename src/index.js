const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "telegram-news-publisher", mode: env.PUBLISH_ENABLED === "true" ? "publish" : "dry-run" });
    }
    if (request.method === "POST" && url.pathname === "/admin/submit") {
      if (!authorized(request, env)) return json({ error: "unauthorized" }, 401);
      let digest;
      try { digest = await request.json(); } catch { return json({ error: "body must be valid JSON" }, 400); }
      const validation = validateDigest(digest);
      if (!validation.ok) return json({ error: validation.error }, 400);
      const result = await processDigest(digest, env, "manual");
      return json(result, result.ok ? 200 : 502);
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
        await processDigest(digest, env, "scheduled");
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

async function sendTelegram(env, story) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHANNEL_ID) throw new Error("Missing Telegram credentials");
  const text = `📰 <b>${escapeHtml(story.title)}</b>\n\n${escapeHtml(story.summary)}\n\n🔎 <a href="${escapeAttribute(story.source_url)}">منبع خبر</a>${story.category ? `\n🏷 ${escapeHtml(story.category)}` : ""}`;
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHANNEL_ID, text, parse_mode: "HTML", disable_web_page_preview: false })
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(`Telegram send failed with HTTP ${response.status}`);
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
