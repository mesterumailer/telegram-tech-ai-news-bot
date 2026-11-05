# ربات اخبار فناوری و هوش مصنوعی تلگرام — فاز اول

این پروژه از دو زمان‌بندی مستقل استفاده می‌کند: تولید روزانهٔ بستهٔ سه‌خبری و به‌روزرسانی فایل GitHub، و Cron کلودفلر که هر ۶ ساعت صف D1 را بررسی می‌کند و در هر اجرا حداکثر یک خبر منتشرنشده را ارسال می‌کند. مسیر جایگزین برای ارسال دستی JSON نیز از طریق endpoint امن Worker فراهم است.

## طرح مورد توافق

- زمان‌بندی روزانهٔ ChatGPT: آماده‌سازی دقیقاً ۳ خبر تازهٔ فارسی و ثبت بسته در `content/ready-digest.json` شاخهٔ `main`؛ این زمان‌بندی باید در بخش Automations فعال باشد.
- GitHub: نگهداری فایل `content/ready-digest.json` با قالب مشخص.
- Cloudflare Worker: بررسی فایل GitHub و صف پایدار D1 هر ۶ ساعت؛ در هر اجرا فقط یک خبر منتشرنشده را ارسال می‌کند. اگر صف خالی باشد، هیچ پیامی نمی‌فرستد.
- Cloudflare D1: ثبت شناسه خبرها و وضعیت ارسال برای جلوگیری از تکرار در اجرای مجدد.
- مسیر جایگزین: `POST /admin/submit` با `Authorization: Bearer <ADMIN_SECRET>` برای ارسال JSON آماده‌شده.
- مسیر آزمایش واقعی تلگرام: `POST /admin/test-message`؛ فقط با `TELEGRAM_TEST_ENABLED=true` و `ADMIN_SECRET` فعال می‌شود و یک پیام ثابت و مشخصاً آزمایشی می‌فرستد. این مسیر مستقل از `PUBLISH_ENABLED` است و Digest سه‌خبری را تغییر نمی‌دهد.
- انتشار خودکار با `PUBLISH_ENABLED=true` فعال می‌شود. این کلید، توقف اضطراری سراسری است.

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
9. برای انتشار خودکار، `PUBLISH_ENABLED=true` را در تنظیمات محیط Production Worker قرار دهید و Worker را deploy کنید؛ سپس `/health` باید `mode: publish` نشان دهد. چون `keep_vars=true` است، مقدار متغیری که از قبل در Dashboard ذخیره شده در زمان deploy حفظ می‌شود؛ اگر مقدار زنده `false` باشد، باید همان‌جا به `true` تغییر کند.

## RSS feed collector

- Worker در هر اجرای Cron شش‌ساعته شش منبع RSS را بررسی می‌کند: OpenAI News، TechCrunch AI، The Verge AI، MIT Technology Review AI، Ars Technica AI و VentureBeat AI.
- آیتم‌های تازه و دارای تاریخ معتبر در جدول D1 به نام `news_feed_items` ذخیره می‌شوند. این فیدها فقط منبع کشف خبر هستند؛ به‌تنهایی باعث انتشار نمی‌شوند.
- GPT می‌تواند فهرست ورودی‌ها را از endpoint عمومی و فقط‌خواندنی `GET /feed/candidates?limit=60` دریافت کند. قبل از انتخاب، خبر باید در منبع اصلی و با یک منبع معتبر دیگر بررسی شود.
- تصویر داخل RSS فقط یک سرنخ است؛ GPT باید URL مستقیم، عمومی، HTTPS و اعتبار دقیق آن را جداگانه بررسی کند.
- برای این قابلیت، مهاجرت `0004_news_feed_items.sql` باید روی D1 راه دور اعمال و Worker جدید deploy شود.

## قالب خروجی ChatGPT

فایل `content/ready-digest.json` باید شبیه `examples/ready-digest.json` باشد. برای هر خبر `id` پایدار و یکتا، عنوان فارسی، خلاصه، لینک HTTPS منبع و در صورت امکان دسته و زمان انتشار لازم است. هر batch یک `batch_id` دارد. فیلدهای تصویری اختیاری‌اند: `image_url` در صورت وجود باید لینک مستقیم، عمومی و HTTPS به فایل تصویر باشد (نه لینک صفحه مقاله)، `image_credit` اعتبار دقیق عکاس/شرکت/ناشر و `image_alt` شرح کوتاه تصویر است. اگر `image_url` خالی باشد، Worker تلاش می‌کند تصویر صفحهٔ مقاله را از متادیتای `og:image` یا `twitter:image` استخراج کند؛ اگر سایت تصویر قابل‌دسترسی ارائه نکند، خبر متنی ارسال و رویداد `image_not_found` ثبت می‌شود.


## انتشار خبر همراه تصویر

- اگر یک خبر `image_url` معتبر داشته باشد، Worker آن را با متد `sendPhoto` تلگرام ارسال می‌کند؛ متن خبر، لینک منبع، دسته و اعتبار تصویر در کپشن قرار می‌گیرند.
- کپشن تصویر مطابق محدودیت ۱۰۲۴ نویسه تلگرام کوتاه می‌شود؛ متن کامل خبر در حالت پیام متنی حفظ می‌شود.
- اگر تلگرام صریحاً تصویر را رد کند (مثلاً لینک مستقیم یا فرمت تصویر قابل دریافت نباشد)، Worker همان خبر را به‌صورت متن ارسال می‌کند و رویداد fallback را ثبت می‌کند.
- در خطاهای مبهم شبکه، Worker برای جلوگیری از انتشار تکراری به‌صورت خودکار پیام دوم ارسال نمی‌کند؛ وضعیت باید بررسی شود.
- بخش `/latest` برای کاربران عمومی و مدیران نیز از تصویر استفاده می‌کند؛ دکمه‌های تأیید و رد مدیر روی پیام تصویری باقی می‌مانند.
- اولویت با عکس رسمی/خبری دارای مجوز استفاده و اعتبار دقیق تصویر است. لینک باید مستقیماً به فایل تصویر عمومی HTTPS برسد. اگر قابلیت دسترسی، نوع فایل یا حق استفاده مشخص نیست، تصویر را حذف کنید تا خبر به‌صورت متنی نمایش داده شود.

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
- The scheduled Worker always imports the current digest into the persistent `story_review_queue`, independently of the admin UI's manual/API mode.
- When `PUBLISH_ENABLED=true`, each scheduled execution atomically claims and publishes at most one pending story. Later six-hour executions continue with the next pending story.
- The admin UI's `publication_mode` setting applies to the manual `/admin/submit` route; it does not pause the six-hour scheduled publisher.
- `PUBLISH_ENABLED=false` is a hard safety stop: no story can be sent to the public channel, including a manually approved story.
- Only administrative commands and callback actions are restricted by `TELEGRAM_ADMIN_USER_ID`; public users cannot approve/reject stories or change publication settings. Webhook requests are verified with `TELEGRAM_WEBHOOK_SECRET`.

Required Cloudflare setup after deploying this version:
1. Apply all pending D1 migrations, including `0002_telegram_admin_ui.sql` and `0003_telegram_webhook_idempotency.sql`, to the existing D1 database.
2. Add `TELEGRAM_ADMIN_USER_ID` as a Text variable containing the numeric Telegram user ID of the manager.
3. Add `TELEGRAM_WEBHOOK_SECRET` as a Secret. Use a random 32+ character value containing only letters, digits, underscores or hyphens.
4. Call `POST /admin/register-webhook` with `Authorization: Bearer <ADMIN_SECRET>`. This securely registers the Worker URL with Telegram; the bot token is not needed in the PowerShell request.
5. Set `PUBLISH_ENABLED=true` only after the bot token, channel permissions, D1 binding, GitHub path and the deployed Cron Trigger have been verified. The scheduled publisher sends at most one queued story per six-hour run. `PUBLISH_ENABLED=false` remains the global emergency stop.

The admin panel is private-chat only. Never put the bot token, admin secret, or webhook secret in GitHub.


## بررسی عملکرد دکمه‌های مدیر

- دکمه‌های تأیید و رد از شناسهٔ کوتاه و پایدار خبر در `callback_data` استفاده می‌کنند تا از محدودیت ۶۴ بایتی تلگرام عبور نکنند.
- برای بررسی دریافت رویدادهای دکمه، endpoint امن `POST /admin/webhook-status` را با هدر `Authorization: Bearer <ADMIN_SECRET>` فراخوانی کنید. خروجی، URL وب‌هوک، فعال بودن `callback_query`، تعداد آپدیت‌های معطل و آخرین خطای تلگرام را نشان می‌دهد.
- اگر وب‌هوک تنظیم نیست یا `callback_query` در `allowed_updates` نیست، ابتدا `POST /admin/register-webhook` را با همان هدر اجرا کنید.
- انتشار دستی با دکمهٔ «تأیید و انتشار» همچنان به `PUBLISH_ENABLED=true` نیاز دارد. انتخاب «انتشار خودکار» فقط شیوهٔ انتشار بسته‌های آینده را تنظیم می‌کند و به‌تنهایی خبرهای منتظر را منتشر نمی‌کند.


## جلوگیری از تکرار در پنل تلگرام

- هر آپدیت دریافتی از تلگرام با `update_id` در جدول `telegram_webhook_updates` به‌صورت اتمیک ثبت می‌شود. ارسال دوبارهٔ همان آپدیت از طرف تلگرام بدون اجرای مجدد عملیات، با پاسخ موفق دریافت می‌شود.
- وضعیت آپدیت‌ها (`processing`، `processed` یا `failed`) و خطای احتمالی برای بررسی در D1 نگهداری می‌شود. رکوردهای قدیمی‌تر از ۳۰ روز در اجرای زمان‌بندی‌شده پاک می‌شوند.
- نمایش آخرین اخبار برای هر گفتگوی خصوصی قفل مستقل دارد؛ درخواست‌های هم‌زمان رد می‌شوند و پس از پایان نمایش نیز تا ۱۰ ثانیه درخواست تازه پذیرفته نمی‌شود.
- قفل نمایش در صورت متوقف‌شدن اجرای Worker حداکثر پس از ۱۲۰ ثانیه منقضی می‌شود. برای جلوگیری از ارسال تکراری، آپدیت تلگرام که قبلاً claim شده باشد حتی در صورت خطای اجرای قبلی دوباره پردازش نمی‌شود؛ وضعیت خطا در D1 ثبت می‌شود و در چنین مواردی بررسی دستی لازم است.
- برای فعال‌شدن این محافظ‌ها، مهاجرت `0003_telegram_webhook_idempotency.sql` باید روی D1 راه دور اجرا شود.
