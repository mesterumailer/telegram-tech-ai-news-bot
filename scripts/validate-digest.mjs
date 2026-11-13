import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const digestPath = resolve(process.cwd(), process.argv.find(arg => !arg.startsWith("--") && arg.endsWith(".json")) || "content/ready-digest.json");
const checkRemote = process.argv.includes("--check-remote");
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function fail(message) {
  console.error(`Digest validation failed: ${message}`);
  process.exitCode = 1;
}

function requireText(value, field, maxLength = 4096) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  if (value.length > maxLength) throw new Error(`${field} exceeds ${maxLength} characters`);
  return value.trim();
}

function requirePublicHttps(value, field) {
  const raw = requireText(value, field, 2048);
  let url;
  try { url = new URL(raw); } catch { throw new Error(`${field} is not a valid URL`); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || !host || url.username || url.password) {
    throw new Error(`${field} must be a public HTTPS URL without embedded credentials`);
  }
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    throw new Error(`${field} must not point to a local host`);
  }
  if (/^(127\\.|10\\.|192\\.168\\.|169\\.254\\.)/.test(host) || /^172\\.(1[6-9]|2[0-9]|3[01])\\./.test(host)) {
    throw new Error(`${field} must not point to a private IP address`);
  }
  return url;
}

function validateDigest(digest) {
  if (!digest || typeof digest !== "object" || Array.isArray(digest)) throw new Error("root must be a JSON object");
  requireText(digest.batch_id, "batch_id", 200);
  if (!Array.isArray(digest.stories) || digest.stories.length !== 3) {
    throw new Error("exactly three stories are required");
  }

  const ids = new Set();
  for (const [index, story] of digest.stories.entries()) {
    const prefix = `stories[${index}]`;
    if (!story || typeof story !== "object" || Array.isArray(story)) throw new Error(`${prefix} must be an object`);
    const id = requireText(story.id, `${prefix}.id`, 200);
    if (ids.has(id)) throw new Error(`${prefix}.id is duplicated`);
    ids.add(id);
    requireText(story.title, `${prefix}.title`, 300);
    requireText(story.summary, `${prefix}.summary`, 2500);
    requirePublicHttps(story.source_url, `${prefix}.source_url`);

    const imageUrl = requirePublicHttps(story.image_url, `${prefix}.image_url`);
    requireText(story.image_credit, `${prefix}.image_credit`, 160);
    requireText(story.image_alt, `${prefix}.image_alt`, 300);
    const license = requireText(story.image_license, `${prefix}.image_license`, 300);
    if (/^(unknown|unclear|not stated|نامشخص|نامعلوم|نامعلوم است|مجوز نامشخص)$/i.test(license)) {
      throw new Error(`${prefix}.image_license must state a verifiable reuse basis`);
    }
    requirePublicHttps(story.image_license_url, `${prefix}.image_license_url`);

    story.__validatedImageUrl = imageUrl.href;
  }
  return digest;
}

async function inspectImage(url, storyId) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  let response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { Range: "bytes=0-0" },
      redirect: "follow",
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const finalUrl = new URL(response.url || url);
    if (finalUrl.protocol !== "https:") throw new Error("redirected image URL is not HTTPS");

    const contentType = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!ALLOWED_IMAGE_TYPES.has(contentType)) {
      throw new Error(`response Content-Type is ${contentType || "missing"}, not JPEG/PNG/WebP`);
    }

    let size = null;
    const contentRange = response.headers.get("content-range");
    const totalMatch = contentRange && /\\/(\\d+)$/.exec(contentRange);
    if (totalMatch) size = Number(totalMatch[1]);
    else if (response.status !== 206) {
      const length = Number(response.headers.get("content-length"));
      if (Number.isFinite(length) && length > 0) size = length;
    }

    if (size !== null && size > MAX_IMAGE_BYTES) throw new Error(`image exceeds 5 MB (${size} bytes)`);
    await response.body?.cancel();
    console.log(`✓ ${storyId}: ${contentType}${size === null ? "" : `, ${size} bytes`}`);
  } finally {
    clearTimeout(timeout);
    if (response?.body && !response.body.locked) {
      try { await response.body.cancel(); } catch { /* response body may already be closed */ }
    }
  }
}

try {
  const raw = await readFile(digestPath, "utf8");
  const digest = validateDigest(JSON.parse(raw));
  console.log(`✓ Structure valid: ${digest.batch_id}, ${digest.stories.length} stories, all with image and rights metadata`);

  if (checkRemote) {
    for (const story of digest.stories) {
      await inspectImage(story.image_url, story.id);
    }
    console.log("✓ All three image URLs resolve to supported image content over HTTPS");
  }
} catch (error) {
  fail(error?.message || String(error));
}
