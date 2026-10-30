# Architecture and implementation plan

## Pipeline
1. RSS source fetcher
2. Article normalizer (title, URL, published timestamp, source, summary/content)
3. Duplicate detection (canonical URL + normalized title fingerprint)
4. Candidate ranking (source trust, freshness, impact, topic fit, audience usefulness)
5. Local model analysis (strict JSON schema; title, Persian summary, significance, category, confidence)
6. Validation gate (source URL required; reject unsupported claims and low-confidence output)
7. Three-story selector with topic diversity
8. Telegram publisher (idempotency key per scheduled run; partial-send recovery)
9. Admin controls and audit log
10. Health checks and failure alerts

## Free hosting decision
Preferred candidate: Oracle Cloud Always Free Ampere A1 VM, if available in the user's account/home region. It is the most plausible single-host shape for a small local model plus persistent SQLite, but capacity and account verification are not guaranteed and idle-instance reclamation is possible.
Fallback: a free sleeping host is suitable only for development/testing, not guaranteed 8-hour publishing. Cloudflare Workers can handle webhooks and scheduled tasks but cannot host a conventional Ollama local model; it would require replacing local-model inference with rule-based summarization or a separate inference host.

## First release safety rules
- Do not fabricate a story to reach three items.
- If fewer than three candidates pass validation, do not publish an incomplete/low-quality digest; log the reason and alert admin.
- Keep source URL in every story.
- Prevent repeat publication after retries/restarts.
- Store timestamps in UTC and display in configured timezone.
- Admin controls must be restricted by numeric Telegram user ID.
- Manual emergency pause must override scheduled runs.
- Start in dry-run mode; enable public publishing only after end-to-end test.

## Phases
A. Infrastructure and existing-bot audit.
B. RSS ingestion and SQLite deduplication.
C. Ranking and local model output validation.
D. Admin UI and 8-hour scheduler.
E. Integration tests, recovery tests, and controlled launch.
