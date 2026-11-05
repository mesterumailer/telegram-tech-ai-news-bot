const MAX_FEED_BYTES = 2_500_000;
const MAX_ITEMS_PER_FEED = 25;
const MAX_CANDIDATE_AGE_DAYS = 14;

export const NEWS_FEEDS = Object.freeze([
  { id: "openai-news", name: "OpenAI News", url: "https://openai.com/news/rss.xml" },
  { id: "techcrunch-ai", name: "TechCrunch AI", url: "https://techcrunch.com/category/artificial-intelligence/feed" },
  { id: "theverge-ai", name: "The Verge AI", url: "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml" },
  { id: "mittr-ai", name: "MIT Technology Review AI", url: "https://www.technologyreview.com/topic/artificial-intelligence/feed" },
  { id: "arstechnica-ai", name: "Ars Technica AI", url: "https://arstechnica.com/ai/feed" },
  { id: "venturebeat-ai", name: "VentureBeat AI", url: "https://venturebeat.com/category/ai/feed" }
]);

function decodeXml(value) {
  return String(value || "")
    .replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/i, "$1")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readElement(block, name) {
  const safe = escapeRegExp(name);
  const match = new RegExp("<" + safe + "\\b[^>]*>([\\s\\S]*?)<\\/" + safe + "\\s*>", "i").exec(block);
  return match ? decodeXml(match[1].replace(/<\\/?\\w[^>]*>/g, " ")) : "";
}

function readAttribute(tag, name) {
  const safe = escapeRegExp(name);
  const match = new RegExp("(?:^|\\s)" + safe + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))", "i").exec(tag);
  return match ? decodeXml(match[1] ?? match[2] ?? match[3] ?? "") : "";
}

function stripMarkup(value) {
  return decodeXml(String(value || "")
    .replace(/<!\\[CDATA\\[/gi, "")
    .replace(/\\]\\]>/g, "")
    .replace(/<script\\b[^>]*>[\\s\\S]*?<\\/script>/gi, " ")
    .replace(/<style\\b[^>]*>[\\s\\S]*?<\\/style>/gi, " ")
    .replace(/<[^>]+>/g, " "))
    .replace(/\\s+/g, " ")
    .trim();
}

function firstHttpsUrl(value) {
  try {
    const url = new URL(decodeXml(value).trim());
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password) return "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function readEntryLink(block) {
  const tags = block.match(/<link\\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const href = readAttribute(tag, "href");
    const rel = readAttribute(tag, "rel");
    if (href && (!rel || rel === "alternate")) {
      const safe = firstHttpsUrl(href);
      if (safe) return safe;
    }
  }
  return firstHttpsUrl(readElement(block, "link"));
}

function readEntryImage(block) {
  const tags = block.match(/<(?:media:content|media:thumbnail|enclosure)\\b[^>]*\\/?\s*>/gi) || [];
  for (const tag of tags) {
    const type = readAttribute(tag, "type");
    const url = firstHttpsUrl(readAttribute(tag, "url"));
    if (url && (!type || type.toLowerCase().startsWith("image/"))) return url;
  }
  const imageTag = (block.match(/<img\\b[^>]*>/i) || [])[0] || "";
  return firstHttpsUrl(readAttribute(imageTag, "src"));
}

export function parseNewsFeedXml(xml, feed, now = new Date()) {
  const source = String(xml || "");
  const blocks = [...source.matchAll(/<(item|entry)\\b[^>]*>([\\s\\S]*?)<\\/\\1\\s*>/gi)]
    .slice(0, MAX_ITEMS_PER_FEED);
  const cutoff = now.getTime() - MAX_CANDIDATE_AGE_DAYS * 24 * 60 * 60 * 1000;
  const futureLimit = now.getTime() + 24 * 60 * 60 * 1000;
  const seen = new Set();
  const items = [];

  for (const match of blocks) {
    const block = match[2];
    const title = stripMarkup(readElement(block, "title"));
    const url = readEntryLink(block);
    const dateText = readElement(block, "pubDate")
      || readElement(block, "published")
      || readElement(block, "updated")
      || readElement(block, "dc:date")
      || readElement(block, "date");
    const timestamp = Date.parse(dateText);
    if (!title || !url || !Number.isFinite(timestamp) || timestamp < cutoff || timestamp > futureLimit || seen.has(url)) continue;

    const summary = stripMarkup(
      readElement(block, "description")
      || readElement(block, "summary")
      || readElement(block, "content:encoded")
      || readElement(block, "content")
    ).slice(0, 1800);
    const imageUrl = readEntryImage(block);
    seen.add(url);
    items.push({
      feed_id: feed.id,
      source_name: feed.name,
      title: title.slice(0, 500),
      summary,
      source_url: url,
      published_at: new Date(timestamp).toISOString(),
      candidate_image_url: imageUrl || null
    });
  }

  return items.sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at));
}

export async function refreshNewsFeeds(env, options = {}) {
  if (!env?.DB) throw new Error("D1 binding DB is required to store news feed items");
  const fetchImpl = options.fetchImpl || fetch;
  const now = options.now instanceof Date ? options.now : new Date();
  const feedResults = await Promise.all(NEWS_FEEDS.map(async feed => {
    try {
      const response = await fetchImpl(feed.url, {
        headers: {
          accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.1",
          "user-agent": "Mozilla/5.0 (compatible; Tech4UsNewsFeedBot/1.0)",
          "cache-control": "no-cache"
        },
        redirect: "follow"
      });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const contentType = response.headers.get("content-type") || "";
      if (contentType && !/(xml|rss|atom)/i.test(contentType)) {
        throw new Error("Unexpected feed content type: " + contentType);
      }
      const xml = await response.text();
      if (xml.length > MAX_FEED_BYTES) throw new Error("Feed response exceeded size limit");
      const items = parseNewsFeedXml(xml, feed, now);
      let stored = 0;
      for (const item of items) {
        const result = await env.DB.prepare(`INSERT INTO news_feed_items
          (source_url, feed_id, source_name, title, summary, published_at, candidate_image_url, first_seen_at, last_seen_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          ON CONFLICT(source_url) DO UPDATE SET
            feed_id=excluded.feed_id,
            source_name=excluded.source_name,
            title=excluded.title,
            summary=excluded.summary,
            published_at=excluded.published_at,
            candidate_image_url=COALESCE(excluded.candidate_image_url, news_feed_items.candidate_image_url),
            last_seen_at=CURRENT_TIMESTAMP`)
          .bind(item.source_url, item.feed_id, item.source_name, item.title, item.summary, item.published_at, item.candidate_image_url)
          .run();
        stored += result.meta?.changes ?? 0;
      }
      return { feed_id: feed.id, source_name: feed.name, parsed: items.length, stored, ok: true };
    } catch (error) {
      return { feed_id: feed.id, source_name: feed.name, parsed: 0, stored: 0, ok: false, error: String(error?.message || error).slice(0, 300) };
    }
  }));

  try {
    await env.DB.prepare("DELETE FROM news_feed_items WHERE published_at < datetime('now', '-30 days')").run();
  } catch {
    // Feed refresh results remain useful even if housekeeping fails.
  }

  return {
    feeds_checked: feedResults.length,
    feeds_ok: feedResults.filter(item => item.ok).length,
    parsed_items: feedResults.reduce((sum, item) => sum + item.parsed, 0),
    stored_items: feedResults.reduce((sum, item) => sum + item.stored, 0),
    feeds: feedResults
  };
}

export async function listNewsFeedCandidates(db, limit = 60) {
  if (!db) throw new Error("D1 binding DB is required");
  const boundedLimit = Math.max(1, Math.min(100, Number(limit) || 60));
  const result = await db.prepare(`SELECT feed_id, source_name, title, summary, source_url, published_at, candidate_image_url, first_seen_at, last_seen_at
    FROM news_feed_items
    WHERE published_at >= datetime('now', '-14 days')
    ORDER BY published_at DESC, first_seen_at DESC
    LIMIT ?`).bind(boundedLimit).all();
  return result.results || [];
}
