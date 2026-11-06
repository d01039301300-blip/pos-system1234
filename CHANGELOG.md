# سجل التغييرات

- feat(6-B): add SQLite→PostgreSQL migration script
- feat(1.16-C): add user-facing error handling to 7 catches

## 2026-11-02 — المرحلة الأولى / المهمة 1.15

- أضيف سجل أخطاء دوّار في مجلد بيانات Electron: `error.log` مع خمسة ملفات إجمالاً (السجل الحالي وأربعة ملفات تدوير)، وحد أقصى 5MB قبل التدوير.
- أضيف التقاط `window.error` و`unhandledrejection` في الواجهة، والتقاط `uncaughtException` و`unhandledRejection` في Electron عبر IPC آمن.
- تُنقّى كلمات المرور والرموز وBearer قبل الحفظ، ولا يُسجّل محتوى العملاء أو كلمات المرور.
- اختبار Electron التكاملي مؤجل حتى إعادة بناء الحزمة لأن تنزيل الملف التنفيذي محجوب؛ نجح اختبار Node المباشر لمنطق التنقية والتدوير.

## 2026-11-02 — المرحلة الأولى / المهمة 1.13

- تأكدت نافذة Electron الرئيسية وشاشة البداية من `contextIsolation:true` و`sandbox:true` و`nodeIntegration:false`، ويعرض preload واجهة `rawdaDesktop` فقط.
- أضيفت سياسة CSP للخادم لمنع الإضافات والكائنات والإطارات والمصادر البعيدة للطلبات، مع إبقاء الموارد الحالية الضرورية للواجهة والخطوط والأيقونات دون تغيير.
- الاختبار الفعلي: CSP موجودة في الاستجابة، لا توجد أخطاء صفحة، و`window.require` و`window.process` غير متاحين، بينما ميزات Chromium المطلوبة تعمل.

## 2026-11-02 — المرحلة الأولى / المهمة 1.13ب

- اعتمد التطبيق على Chromium المضمّن في Electron؛ لم نضف fallback أو مكتبة أو خطًا جديدًا لأن الميزات المطلوبة متاحة.
- الاختبار الفعلي داخل صفحة التطبيق: `crypto.subtle` نفذ SHA-256 وأعاد 32 بايت، و`AbortSignal.timeout` و`showPicker` و`navigator.credentials` متاحة، والسياق آمن، بلا أخطاء صفحة.

## 2026-11-02 — المرحلة الأولى / المهمة 1.10

- جعل الوضع الافتراضي للبناء `client`، مع السماح بتجاوز شاشة إجبار تغيير كلمة المرور فقط عند `BUILD_MODE=dev` صراحةً.
- في بناء العميل: تُعرض شاشة التغيير بعد الدخول، تُمنع من الإغلاق، وتُحجب عمليات الكتابة في الخادم حتى نجاح تغيير كلمة المرور.
- أضيف تحقق موحد لكلمة المرور الجديدة: 8 أحرف على الأقل، مختلفة عن الحالية واسم المستخدم وكلمات المرور الافتراضية.
- أزيلت بيانات الدخول التجريبية الثابتة من وضع التخزين المحلي؛ وتُرحّل التجزئة التالفة إلى كلمة استرداد عشوائية مع إبقاء إجبار التغيير.
- أضيف حارس بناء للمثبّت يرفض `BUILD_MODE=dev` ويثبت `BUILD_MODE=client` قبل تشغيل electron-builder.
- الاختبار الفعلي: بناء العميل أظهر المودال ومنع `/api/products` حتى التغيير، وبناء `dev` تجاوز المودال وسمح بالمسار؛ بعد التغيير نجح المساران بلا أخطاء صفحة.
- ترحيل الحسابات القديمة: كلمات المرور الافتراضية المعروفة تُعلّم لإجبار التغيير دون تعطيل أو حذف أي مستخدم، وتُسجّل `last_user_migration`، بينما الحسابات التي تستخدم كلمة مخصصة لا تتأثر.
- الاختبار الفعلي: حساب قديم بكلمة افتراضية دخل ثم أُجبر على التغيير، وحساب بكلمة مخصصة دخل دون إجبار.
- أضيفت حقول إنشاء حساب المالك إلى نموذج أول تشغيل الموجود، وربطت بحساب المدير في الخادم مع رفض كلمات المرور الافتراضية أو المساوية لاسم المستخدم.
- الاختبار الفعلي: إعداد نشاط جديد أنشأ حساب المالك، ثم نجح الدخول به كمالك دون إجبار إضافي.

## 2026-11-02 — المرحلة الأولى / المهمة 1.11

- أزيلت هوية `current_user_id` من جميع طلبات الواجهة؛ الخادم يستمد المستخدم من جلسة HttpOnly ويستبدل أي قيمة قديمة يرسلها عميل قديم.
- حافظ الخادم على عزل الفروع عبر `X-Active-Branch` مع رفض الفرع غير المسموح.
- الاختبار المباشر: بلا جلسة = 401، الكاشير لا يحذف منتجاً = 403، ومحاولة فرع غير مسموح = 403.

## 2026-11-02 — المرحلة الأولى / المهمة 1.11ب

- شددت مسارات التقارير المالية لتتطلب صلاحية إعدادات النظام، مع بقاء حساب المدير المصرح له قادراً على الوصول.
- الاختبار المباشر عبر API: الكاشير إضافة مستخدم/حذف منتج/تقرير مالي = 403، مدير المخزون إضافة مستخدم/حذف منتج/تقرير مالي = 403، والمدير الكامل = 201/200/200.

## 2026-11-02 — المرحلة الأولى / المهمة 1.12

- تحقق بلا تعديل: حفظ الدخول في Electron يستخدم `safeStorage.encryptString` داخل `remembered-login.bin`، والاسترجاع يفك التشفير، والمسح يحذف الملف.
- لا تُحفظ كلمة المرور كنص عادي في ملف التذكر؛ اختبار المسار البرمجي أكد وجود التشفير والمسح الفعلي.

## 2026-11-01 — المرحلة الأولى / المهمة 1.1

- fix(1.1): prevent addToCart bridge recursion via coreAddToCart
- توحيد جسر شاشة نقطة البيع مع وظائف السلة والدفع ورسم المنتجات الموجودة في التطبيق.
- الحفاظ على توافق أزرار شاشة البيع القديمة مع أصناف قاعدة البيانات، مع اعتماد السعر الحالي حسب مستوى البيع.
- تفعيل تحديث الكميات، الدفع، الإيصال، الوردية، التصنيفات، كاميرا الباركود، ورسم المنتجات من قاعدة البيانات.
- إصلاح انتظار إضافة المنتج عند مسح الباركود حتى لا تظهر رسالة النجاح قبل اكتمال الإضافة.
- إصلاح مسار الآجل لاختيار العميل وفترة السداد، ودعم صنف الخدمة (وحدة «خدمة») دون اشتراط مخزون أو خصم مخزون.
- التحقق الفعلي: +/−، نقدي، بطاقة، آجل، الإيصال، خصم المخزون، البحث بالاسم/الباركود، الفئات، التفريغ، نفاد المخزون، الخدمة، فتح/إغلاق الوردية.
- لم يتم تعديل التصميم أو الألوان أو الثيم أو الخطوط في هذه المهمة.

## 2026-11-01 — المرحلة الثالثة / المهمة 3.1

- تثبيت منفذ المرتجع على هوية جلسة الخادم بدل الاعتماد على معرّف يرسله المتصفح.
- إضافة رقم إشعار دائن مرتبط برقم الفاتورة الأصلية داخل نتيجة المرتجع وسجل المرتجع.
- إظهار تفاصيل إشعار المرتجع في نافذة الطباعة الموجودة أصلًا، بدون تعديل CSS أو الثيم أو الخطوط.
## 2026-11-02 — المرحلة الأولى / المهمة 1.3

- تحقق بلا تعديل: لا يوجد حساب ثابت `taxable * 0.14` ولا تقريب خاطئ للإجمالي.
- الاختبار الفعلي: ضريبة 10% على 100 = 110.00، إيقاف الضريبة = 100.00، و33.33 + 10% = 36.66.
- بقيت مواضع الحساب المكررة كما هي حسب المطلوب؛ التوحيد مؤجل للمهمة 2.6.

## 2026-11-02 — المرحلة الأولى / المهمة 1.5

- تحقق: المكتبات المحلية الموجودة مسبقاً `qrcode.min.js` و`xlsx.full.min.js` و`html5-qrcode.min.js` محمّلة قبل `app.js` وتعمل (`QRCode.toCanvas` و`XLSX.utils.aoa_to_sheet` و`Html5Qrcode`).
- لم تُضف خطوطاً أو CDN أو CSS. اختبار الكاميرا الفعلي مؤجل حسب ترتيب السكريبت، وسيُسجل «لم يُختبر» إن لم يتوفر جهاز كاميرا.

## 2026-11-02 — المرحلة الأولى / المهمة 1.8

- الإبقاء على تعريف واحد لـ `escapeHtml(value ?? '')` وحذف التعريفين المكررين.
- حماية رموز روابط التوصيل قبل إدراجها في أزرار المشاركة.
- اختبار فعلي: الاسم `<b>x</b>` ظهر كنص عادي (`&lt;b&gt;x&lt;/b&gt;`) وليس HTML.

## 2026-11-02 — المرحلة الأولى / المهمة 1.9

- فصل مراقب أرقام لوحة التحكم عند تنظيف موارد الصفحة ثم تصفير مرجعه لمنع تسريب الذاكرة.
- اختبار إغلاق الصفحة: لا أخطاء تطبيق؛ ظهرت فقط أخطاء موارد خارجية محجوبة في بيئة الاختبار بلا إنترنت.
- feat(7-E): define sync collection map + source identity (no wiring)

## [7-F] — 2026-11-02
- feat(7-F): add shared/sync-bridge.js + hooks in storage-adapter.js (behind PG_SYNC_ENABLED=0)
- fix: _clearPendingSync() after ALL three ROLLBACK paths (374, 439, 477)

## [7-G.1] — 2026-11-02
- feat(7-G.1): install pg ^8.11.3
- feat(7-G.1): add shared/pg-client.js (connection factory)
- feat(7-G.1): extend sync-bridge ensureSchema (dead_letter, meta, indexes, retry columns)
- feat(7-G.1): add syncBridge.notifyPg() + shutdownNotify (lazy pg)
- feat(7-G.1): call notifyPg() after COMMIT in storage-adapter (3 sites)
- feat(7-G.1): add tools/pg-create-target-tables.js (manual, creates 4 missing PG tables)
- test(7-G.1): pg-client unit tests + ensureSchema extension tests

## [7-G.2] — 2026-11-02
- feat(7-G.2): add PostgreSQL sync worker with advisory lock, LISTEN, polling, retries, and dead-letter handling
- test(7-G.2): add fake-client worker coverage for startup, batches, retries, shutdown, and NOTIFY wake-up

## [7-G.1-fix] — 2026-11-02
- fix(7-G.1): remove branch_inventory, warehouse_inventory,
  warehouse_stock_movements, warehouse_categories from sync scope
  (no proper PG target tables — worker verifyTargetTables would exit 2)
- chore(7-G.1): delete tools/pg-create-target-tables.js (stub creator
  superseded by requirement for real PG tables)

## [8-A] — 2026-11-02
- feat(8-A): add db/schema.sql (pos_central schema via pg_dump 16.15, 44 tables)
- feat(8-A): add tools/provision-branch-db.js (idempotent CREATE DATABASE + schema load)
- feat(8-A): strip psql meta-commands (\\restrict etc.) before execution via pg.Client
- chore(8-A): grant CREATEDB to pos_user (one-time, بحساب postgres)
- test(8-A): verified on pos_branch_99 (≥40 tables created, then dropped)
- KNOWN RISK (TASK 9): migrate-to-postgres.js has its own collection→table map
  with merge semantics different from shared/collection-map.js (1:1). Both write
  to same PG tables → potential id collision. Do NOT run migrate-to-postgres.js
  on pos_branch_XX. Branches populate exclusively via sync-worker.
- KNOWN GAP: MIGRATION_MAPPING.md documents 10 collections needing new PG tables.
  pos_central's 44 tables are not 1:1 with 41 collections.
- NOTE: PG bin not on PATH by default; scripts assume PGPASSWORD + PGHOST in env.

## [8-B] — 2026-11-02
- feat(8-B): refactor tools/provision-branch-db.js to export provisionBranch()
- feat(8-B): add tools/provision-all-branches.js (dry-run default, --apply to create)
- feat(8-B): add tools/branch-health.js (connectivity + tables + privileges + lock probe)
- test(8-B): add tests/branch-health.test.js (5 scenarios)
- docs(8-B): add docs/TASK-8-zerotier-runbook.md
- docs(8-B): add docs/env-branch.example
- Deferred to 8-C: 4 missing collections need real PG schema.
- Deferred to 8-D: real 10-branch device testing.

- fix(9-A): bench-worker loads PG columns from information_schema and filters payload
- fix(9-A): alias mapping (invoice_number→invoice_no, cost_price→purchase_price, etc.)
- fix(9-A): fallback values for NOT NULL columns with no default
- fix(9-A): FK constraints disabled via session_replication_role; fallback to seed rows
- fix(9-A): skip individual rows on error instead of aborting benchmark
- fix(9-A): seed categories 1-20 (products_category_id_fkey FK)
- fix(9-A): always call seedMinimal regardless of FK disable success
- fix(9-A): SAVEPOINT per row prevents transaction cascade on row error
- verified: 10K products + 100K sales → products=10000, sales=100000 in PG

## [9-B] — 2026-11-02
- feat(9-B): add tools/generate-bench-sqlite.js (200K + 1M in storage_rows)
- feat(9-B): add tools/bench-db-layer.js (uses production storageAdapter path)
- Discovery: database.js → storage-adapter.js → createSqliteStorageAdapter().load()
- Result @ 1M: heap=274MB, load=5.3s, save=68.2s
- Queries: barcode=5ms, name=22ms, category=9ms
- Verdict: 10M feasible=YES
- fix(8-B): branch-health.js uses pg.Client at call time (enables DI in tests)
