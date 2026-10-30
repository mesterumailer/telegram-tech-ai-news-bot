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
      const result = await processDigest(digest, env, "manual");
      return json(result, result.ok ? 200 : 502);
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
          await queueDigestForReview(digest, env, "scheduled");
          if (env.TELEGRAM_ADMIN_USER_ID) await notifyPendingDigest(env, digest);
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


async function handleTelegramUpdate(update, env) {
  const message = update?.message;
  if (message?.text) {
    const fromId = String(message.from?.id || "");
    if (!isAdmin(fromId, env)) return;
    const chatId = message.chat?.id;
    if (String(message.chat?.type) !== "private" || !chatId) return;
    const command = message.text.trim().split(/\\s+/)[0].split("@")[0].toLowerCase();
    if (command === "/start" || command === "/menu") return sendAdminMenu(env, chatId);
    if (command === "/latest") return showLatestNews(env, chatId);
    if (command === "/settings") return showPublicationSettings(env, chatId);
    return sendBotMessage(env, chatId, "از منوی زیر استفاده کن.", adminMenuKeyboard());
  }

  const callback = update?.callback_query;
  if (!callback) return;
  const userId = String(callback.from?.id || "");
  if (!isAdmin(userId, env)) {
    await answerCallback(env, callback.id, "دسترسی غیرمجاز", true);
    return;
  }
  await answerCallback(env, callback.id);
  const data = String(callback.data || "");
  const chatId = callback.message?.chat?.id;
  if (!chatId || String(callback.message?.chat?.type) !== "private") return;

  if (data === "menu") return sendAdminMenu(env, chatId);
  if (data === "latest") return showLatestNews(env, chatId);
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

async function showLatestNews(env, chatId) {
  const digest = await fetchGitHubDigest(env);
  if (!digest) return sendBotMessage(env, chatId, "هنوز فایل اخبار آماده‌ای در GitHub وجود ندارد.");
  const validation = validateDigest(digest);
  if (!validation.ok) return sendBotMessage(env, chatId, `بسته خبری معتبر نیست: ${validation.error}`);
  await queueDigestForReview(digest, env, "admin_preview");
  await sendBotMessage(env, chatId, `🗞 آخرین بسته خبری\\nشناسه: ${escapeHtml(digest.batch_id)}\\nتعداد خبر: ${digest.stories.length}\\n\\nهر خبر را جداگانه بررسی و تأیید یا رد کن.`, undefined, "HTML");
  for (const story of digest.stories) {
    const status = await env.DB.prepare("SELECT review_status FROM story_review_queue WHERE story_id = ?").bind(story.id).first();
    const label = status?.review_status === "approved" ? "تأیید شده" : status?.review_status === "rejected" ? "رد شده" : "در انتظار بررسی";
    const keyboard = status?.review_status === "pending" ? { inline_keyboard: [[
      { text: "✅ تأیید و انتشار", callback_data: `approve:${story.id}` },
      { text: "❌ رد خبر", callback_data: `reject:${story.id}` }
    ]] } : { inline_keyboard: [[{ text: "↻ به‌روزرسانی فهرست", callback_data: "latest" }]] };
    const text = `<b>${escapeHtml(story.title)}</b>\\n\\n${escapeHtml(story.summary)}\\n\\n🏷 ${escapeHtml(story.category || "بدون دسته")}\\n📅 ${escapeHtml(story.published_at || "زمان نامشخص")}\\n🔗 <a href="${escapeAttribute(story.source_url)}">مشاهده منبع</a>\\n\\nوضعیت: <b>${label}</b>`;
    await sendBotMessage(env, chatId, text, keyboard, "HTML");
  }
}

async function queueDigestForReview(digest, env, origin) {
  for (const story of digest.stories) {
    await env.DB.prepare(`INSERT INTO story_review_queue (story_id, batch_id, story_json, review_status, origin, updated_at)
      VALUES (?, ?, ?, 'pending', ?, CURRENT_TIMESTAMP)
      ON CONFLICT(story_id) DO NOTHING`)
      .bind(story.id, digest.batch_id, JSON.stringify(story), origin).run();
  }
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
