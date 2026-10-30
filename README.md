# ربات اخبار فناوری و هوش مصنوعی تلگرام — فاز اول

این پروژه مسیر انتشار خبرهای آماده را پیاده‌سازی می‌کند. **تولید خبر توسط ChatGPT هنوز به اتصال نوشتن خودکار GitHub وابسته است و در این فاز تضمین نشده**؛ مسیر جایگزین برای ارسال دستی JSON از طریق endpoint امن Worker فراهم شده است.

## طرح مورد توافق

- ChatGPT Free: آماده‌سازی حداکثر ۳ خبر مهم فارسی روزانه و همچنین تولید دستی هنگام درخواست کاربر. قابلیت نوشتن مستقیم در GitHub باید با حساب و اتصال واقعی آزمایش شود؛ اتصال به‌تنهایی تضمین آن نیست.
- GitHub: نگهداری فایل `content/ready-digest.json` با قالب مشخص.
- Cloudflare Worker: بررسی فایل هر ۶ ساعت و انتشار خبرهای جدید در کانال.
- Cloudflare D1: ثبت شناسه خبرها و وضعیت ارسال برای جلوگیری از تکرار در اجرای مجدد.
- مسیر جایگزین: `POST /admin/submit` با `Authorization: Bearer <ADMIN_SECRET>` برای ارسال JSON آماده‌شده.
- مسیر آزمایش واقعی تلگرام: `POST /admin/test-message`؛ فقط با `TELEGRAM_TEST_ENABLED=true` و `ADMIN_SECRET` فعال می‌شود و یک پیام ثابت و مشخصاً آزمایشی می‌فرستد. این مسیر مستقل از `PUBLISH_ENABLED` است و Digest سه‌خبری را تغییر نمی‌دهد.
- انتشار عمومی در شروع غیرفعال است (`PUBLISH_ENABLED=false`).

## ساختار فایل‌ها

- `src/index.js` — Worker، زمان‌بندی، دریافت فایل GitHub، اعتبارسنجی، ارسال تلگرام و مسیر جایگزین
- `migrations/0001_init.sql` — جداول D1 برای وضعیت خبرها و گزارش رویدادها
- `examples/ready-digest.json` — نمونه ساختار داده؛ خبر نمونه است و نباید منتشر شود
- `wrangler.toml` — تنظیمات Worker و Cron هر ۶ ساعت
- `tests/worker.test.js` — تست‌های اولیه اعتبارسنجی

## راه‌اندازی

1. یک مخزن GitHub **مستقل** برای این پروژه بسازید؛ از مخزن `androidApp` استفاده نکنید.
2. فایل‌های این بسته را در ریشه مخزن قرار دهید.
3. در Cloudflare یک Worker و یک پایگاه D1 بسازید. شناسه D1 را در `wrangler.toml` جایگزین کنید.
4. با `npm install` وابستگی‌ها را نصب و با `npm test` تست‌ها را اجرا کنید.
5. با Wrangler متغیرهای محرمانه را تنظیم کنید:
   - `npx wrangler secret put TELEGRAM_BOT_TOKEN`
   - `npx wrangler secret put ADMIN_SECRET`
   - `npx wrangler secret put GITHUB_TOKEN` (اگر مخزن خصوصی است؛ برای مخزن عمومی معمولاً لازم نیست)
6. `TELEGRAM_CHANNEL_ID` را به عنوان secret یا متغیر غیرمحرمانه تنظیم کنید؛ ربات باید مجوز انتشار در کانال داشته باشد.
7. در `wrangler.toml` مقادیر `GITHUB_OWNER`، `GITHUB_REPO`، `GITHUB_BRANCH` و `GITHUB_PATH` را تنظیم کنید.
8. اجرای مهاجرت D1: `npx wrangler d1 migrations apply telegram-news-state --remote`
9. ابتدا با `PUBLISH_ENABLED=false` مستقر کنید و `/health` و مسیر دستی را آزمایش کنید. فقط پس از تست end-to-end مقدار را به `true` تغییر دهید.

## قالب خروجی ChatGPT

فایل `content/ready-digest.json` باید شبیه `examples/ready-digest.json` باشد. برای هر خبر `id` پایدار و یکتا، عنوان فارسی، خلاصه، لینک HTTPS منبع و در صورت امکان دسته و زمان انتشار لازم است. هر batch یک `batch_id` دارد.

## مسیر جایگزین دستی

در صورت ناممکن بودن نوشتن مستقیم از ChatGPT به GitHub، متن تولیدشده را در قالب JSON آماده کنید و به endpoint زیر POST کنید:

`POST https://<worker-domain>/admin/submit`

Header: `Authorization: Bearer <ADMIN_SECRET>`
Header: `Content-Type: application/json`
Body: محتوای JSON مطابق قالب بالا.

این endpoint برای کنترل دستی است؛ کلید را در چت عمومی یا مخزن قرار ندهید. در مرحله بعد می‌توانیم یک فرمان امن در ربات مدیریتی تلگرام بسازیم تا نیازی به ابزار HTTP دستی نباشد.

## نکات ایمنی و محدودیت‌ها

- توکن ربات و کلیدها هرگز داخل GitHub commit نشوند.
- تا زمانی که آزمایش واقعی انجام نشده، ادعا نکنید ChatGPT Free می‌تواند هر روز بدون دخالت کاربر فایل GitHub را تغییر دهد.
- Cron زمان‌بندی تقریبی است و تضمین اجرای دقیق در همان دقیقه نیست.
- Worker فقط خروجی آماده را منتشر می‌کند؛ خودش خبر را با مدل زبانی تولید نمی‌کند.
- ارسال تلگرام و ثبت وضعیت دو عملیات جدا هستند؛ در موارد نادرِ قطع اتصال پس از ارسال ممکن است تکرار رخ دهد. این مورد باید در تست‌های بازیابی بررسی و در مرحله بعد با طراحی idempotency قوی‌تر شود.
- در شروع فقط از حالت dry-run استفاده کنید و هیچ خبر نمونه‌ای را منتشر نکنید.


## Publication safety (updated)

- A digest must contain **exactly three** stories with unique IDs and HTTPS source links. Fewer than three valid stories are rejected; the Worker does not fill gaps.
- Publishing uses an atomic D1 claim. A story already marked `sent` is skipped.
- Stories left in `pending` or `failed` are not automatically retried. They are returned as `manual_review_required` (or `failed`) because a timeout/crash can leave uncertainty about whether Telegram accepted the post. This conservative policy avoids accidental duplicate posts; manual reconciliation is required before retrying.
- The three-story validation currently checks structure and HTTPS, **not** source reputation or factual accuracy. Trusted-source validation and editorial review remain required before enabling publication.


## Telegram user and admin interface (phase 1)

The Telegram bot webhook is served at `POST /telegram/webhook`. Any user can start a private chat with the bot and use the public commands; the manager's numeric Telegram ID is used only to protect administrative actions.

Public commands (all users):
- `/start` or `/menu`: show the public welcome menu.
- `/latest`: display the latest prepared stories as read-only cards with source links.
- `/help`: show the public menu again.

Admin commands (manager only):
- `/start` or `/menu`: open the admin menu.
- `/latest`: load the current GitHub digest and display each story with review buttons.
- `/settings`: choose manual approval or automatic publishing.

Publication behavior:
- The persisted D1 setting `publication_mode` defaults to `manual`.
- In manual mode, scheduled and API-submitted digests enter `story_review_queue`; only a manager's approval can publish an individual story.
- In auto mode, the scheduled Worker may publish valid digest stories, but only when the independent master switch `PUBLISH_ENABLED=true`.
- `PUBLISH_ENABLED=false` is a hard safety stop: no story can be sent to the public channel, including a manually approved story.
- Only administrative commands and callback actions are restricted by `TELEGRAM_ADMIN_USER_ID`; public users cannot approve/reject stories or change publication settings. Webhook requests are verified with `TELEGRAM_WEBHOOK_SECRET`.

Required Cloudflare setup after deploying this version:
1. Apply migration `0002_telegram_admin_ui.sql` to the existing D1 database.
2. Add `TELEGRAM_ADMIN_USER_ID` as a Text variable containing the numeric Telegram user ID of the manager.
3. Add `TELEGRAM_WEBHOOK_SECRET` as a Secret. Use a random 32+ character value containing only letters, digits, underscores or hyphens.
4. Call `POST /admin/register-webhook` with `Authorization: Bearer <ADMIN_SECRET>`. This securely registers the Worker URL with Telegram; the bot token is not needed in the PowerShell request.
5. Keep `PUBLISH_ENABLED=false` while testing the interface. After all tests pass, enable it to allow manual approvals to send; automatic publishing still requires choosing auto mode inside Telegram.

The admin panel is private-chat only. Never put the bot token, admin secret, or webhook secret in GitHub.
