# HANDOFF — مرجع العمل التالي

هذا الملف توثيق فقط. لا يدخل في قائمة `build.files` في `package.json` (القائمة تبدأ من `electron/**/*` وتذكر ملفات التطبيق صراحةً في `package.json:42-78`) ولا يغيّر سلوك البرنامج.

## 1) نبذة عن البرنامج وبنيته

الاسم: **SYSTEM — نظام إدارة الأعمال**، الإصدار `1.0.1` (`package.json:3`). التطبيق POS/إدارة مخازن وفروع ومبيعات ومشتريات وطيارين وحملات.

التقنيات المثبتة/المستهدفة:

- Electron `38.8.6` هو الإصدار المحلّل في `pnpm-lock.yaml:37,734,2618`، بينما نطاق `package.json:34` هو `^38.2.1`.
- Node 22 هو إصدار التشغيل المستهدف في إجراءات المشروع؛ **لم أتحقق من تشغيل جهاز Node 22 في هذه الجلسة** (بيئة التدقيق الحالية أظهرت `node v24.22.1`).
- pnpm `10.12.1` مثبت في `package.json:25` وتم التحقق منه بالأمر `pnpm -v`.
- Playwright `1.55.0` في `package.json:36` لاختبارات المتصفح.

البنية والملفات المهمة:

| الملف/المجلد | الوظيفة والدليل |
|---|---|
| `electron/main.js` | نقطة تشغيل Electron، اختيار مسار القاعدة، تشغيل الخادم، إنشاء النافذة، `loadURL`، سجل البدء وحوار الخطأ؛ الأسطر `43-102,258-365,444-551`. |
| `electron/startup-runtime.js` | مسارات الفشل، اختيار القاعدة، تنسيق سبب الفشل وتمييز `ERR_ABORTED -3`؛ `main.js:10` يستورده. |
| `electron/storage-paths.js` | تحويل `appDataPath` إلى `GeneralBusinessPOS` ومتغيرات `RAWDA_*`؛ الأسطر `5-21`. |
| `electron/preload.js` | جسر IPC الآمن بين النافذة وعمليات النظام. |
| `server.js` | Express API، تسجيل الدخول، المبيعات والمخازن والمشتريات والنسخ والحملات؛ الاستماع في `4237`، وlogin/logout في `828` و`997`. |
| `database.js` | مدير persistence لقاعدة JSON؛ الإنشاء/القراءة `118-234`، الحفظ الذري `253-260`، تغيير المسار `319-356`. |
| `app.js` | منطق واجهة المستخدم، الشاشات، الجداول، الصلاحيات والثيمات؛ `switchTab` تقريباً `2834-2920`، والدوال مصدّرة للاختبار قرب `8241`. |
| `index.html` | هيكل شاشة الدخول، الشريط، لوحة التحكم، المبيعات، المخازن، الإعدادات؛ شاشة المنتجات `TAB 3` تقريباً `710-800`، والإعدادات `1600+`. |
| `app.css` | التصميم، الثيمات، التخطيط، الشريط السفلي والفراغ؛ خط مضمّن في `2087`، وملف الخطوط يربط عبر `index.html:9`. |
| `scheduled-backups.js` | نسخ يومية/عند الإغلاق ونسخ أمان، كتابة ذرية واحتفاظ؛ `19-133`. |
| `license.js` | تجربة 30 يوماً، التوقيع، ملف الترخيص، Registry، كشف رجوع الساعة؛ `9-10,67-90,111-175`. |
| `campaign-whatsapp-manager.js` | تطبيع الهواتف، SMS، Baileys، dry-run، الإيقاف والتأخير؛ `7-28,31-165`. |
| `sw.js` | service worker وcache للأصول، ومنها شعار `system-primary-logo.png`. |
| `assets/` | الشعار، الأيقونة، صور الواجهة، SVG، وخط `assets/fonts/ReemKufiInk-Regular.ttf`; الثيمات وخيارات الخلفية في `index.html:1978,2520+` و`app.css`. |

## 2) قاعدة البيانات والمسارات

قاعدة التشغيل **JSON وليست SQLite**. اسم الملف هو `database.json`، ويُقرأ ويُكتب بواسطة `database.js` (`constructor` في `118-234` و`save` في `253-260`). لا تنقل هذا المصدر إلى SQLite دون خطة ترحيل واختبارات احتفاظ بالبيانات.

المجموعات الأساسية في `database.js:8-115`: `business_profile`, `categories`, `products`, `users`, `customers`, `suppliers`, `sales`, `sale_items`, `sale_returns`, `purchases`, `purchase_items`, `purchase_orders`, `purchase_order_items`, `branches`, `branch_inventory`, `waste_records`, `delivery_riders`, `delivery_assignments`, `delivery_settlements`, `customer_transactions`, `supplier_transactions`, `cash_transactions`, `loyalty_transactions`, `ai_insights`, `loyalty_settings`, `tax_settings`, `accounting_settings`, `ui_settings`, `cashier_shifts`, `service_orders`, `installment_contracts`, `promotions`, `stock_movements`, `employees`, `employee_transactions`, `attendance`, `audit_logs`، إضافة إلى رسالة WhatsApp.

المسارات:

- `storage-paths.js:5-21` يحدد `%APPDATA%\GeneralBusinessPOS` و`config.json`, `database.json`, `business-catalog.json`, `license.json`, `trial-state.json`.
- في أول تشغيل، `main.js:303-332` يطلب اختيار مجلد القاعدة؛ الافتراضي `database.json` داخل مجلد بيانات المستخدم، ثم يكتب `config.json`.
- `main.js:258-301` يقرأ `config.json`، يحافظ على المسار المحفوظ، ويقترح مساراً محلياً فقط إذا تعذر الوصول إليه.
- اختبارات العزل تستخدم `RAWDA_DB_PATH` و`RAWDA_CONFIG_PATH` و`RAWDA_DATA_DIR`؛ `storage-paths.js:14-21` و`main.js:264-271,377-379`.
- النسخ المجدولة تحفظ تحت `backups` بجانب بيانات المستخدم، مع مسار ثانوي اختياري؛ `scheduled-backups.js:19-94,116-133` و`server.js:676-748`.

## 3) جدول الصفوف التفصيلي (الدليل لا الذاكرة)

الحالة «منفّذ بدليل» تعني أن ملف/سطر واسم اختبار أو لقطة مذكوران. «جزئي» أو «لم أتحقق» ليسا اعتماداً.

| الصف | ما طُلب | ما نُفِّذ | ملف/سطر | اللقطة/الاختبار | الحالة |
|---|---|---|---|---|---|
| 1-أ | شكل شاشة المبيعات | تخطيط المبيعات والبحث | `index.html:234-320`; `app.js:3048-3123` | `outputs/step-1a-pos-1366x768.png` | منفّذ بدليل |
| 1-ب | البحث ورقم الصنف | بحث كامل وفهرس | `product-list-utils.js:3-6`; `app.js:2943-3066` | `step-1a-item-number-1366x768.png`; `step-1a-browser-results.json` | منفّذ بدليل |
| 1-ج | رقم الصنف | تخصيص/عرض الرقم API وواجهة | `database.js:138-155,366-371`; `server.js:1521-1590` | `step-1a-browser-results.json` | منفّذ بدليل |
| 1-د | الأكثر مبيعاً | بطاقات الأكثر مبيعاً وتقسيم اللوحة | `app.js:3086-3168`; `index.html:318` | `step-1b-pos-1366x768.png`, `1920x768.png` | منفّذ بدليل |
| 1-هـ | اختيار العميل | بحث العميل وربطه | `index.html:347-356`; `app.js:6371-6463` | `step-1b-browser-results.json` | منفّذ بدليل |
| 1-و | طرق الدفع | نقدي/بطاقة/محفظة/آجل | `index.html:400-415`; `app.js:3530-3544` | `step-1b-browser-results.json` | منفّذ بدليل |
| 1-ز | البيع الآجل | 100/0 و100/40 و100/100 ومنع بلا عميل | `app.js:3530-3670`; `server.js:2670-2714` | `step-1c-credit-results.json` | منفّذ بدليل |
| 1-ح | حساب العميل | كشف وحركات ورصيد | `server.js:2758-2778`; `app.js:3904-3908` | `step-1c-credit-results.json` | منفّذ بدليل |
| 1-ط | الفاتورة | مستحق وموعد وتنبيه | `index.html:2467-2470`; `app.js:3863-3909` | `step-1c-credit-receipt-1366x768.png` | منفّذ بدليل |
| 1-ي | الشريط الجانبي | إخفاء POS وإظهار المنتجات حسب الحالة | `app.js:2834-2839`; `app.css:3190` | `step-1d-browser-results.json` | منفّذ بدليل |
| 1-ك | القائمة | درج وتبديل الأدوات | `index.html:318,325,345`; `app.js:8257-8272` | `step-1d-pos-1366x768.png` | منفّذ بدليل |
| 1-ل | الكمية | إدخال صفر/نص وحدود التحكم | `app.js:3406-3437,3489-3491` | `step-1d-browser-results.json` | منفّذ بدليل |
| 1-م | تقسيم اللوحة | قياسات الرأس/الأصناف/الملخص | `index.html:334-415`; `app.css:3198-3219` | `step-1d-browser-results.json`, لقطتا المقاسين | منفّذ بدليل |
| 2-أ | شاشة المخازن | عنوان ومسار ومحتوى | `index.html:838-866`; `app.js:1623-1729` | `step-2a-warehouse-1366x768.png` | منفّذ بدليل |
| 2-ب | قائمة المخازن | ستة عناصر داخلية | `index.html:839-848` | `step-2a-browser-results.json` | منفّذ بدليل |
| 2-ج | العدادات | فروع/مخازن/منتجات | `app.js:1500-1505,1654-1664` | `step-2a-browser-results.json` | منفّذ بدليل |
| 2-د | الإضافة والعرض | لوحتا إضافة مخزن/منتج والعرض الافتراضي | `app.js:1588-1620`; `index.html:850-856` | `step-2a-browser-results.json` | منفّذ بدليل |
| 2-هـ | بطاقات الأصناف | متوفر/غير متوفر وأرقام الصنف | `app.js:1709-1730` | `step-2a-browser-results.json` | منفّذ بدليل |
| 2-و | التبويبات | فئات/أصناف/كميات/حركة | `app.js:1740-1761`; `index.html:858-866` | `step-2a-browser-results.json` | منفّذ بدليل |
| 2-ز | فرع ومخازنه | قوائم الفرع والمخازن | `app.js:1634-1664` | `step-2a-browser-results.json` | منفّذ بدليل |
| 2-ح | الإطار والتصميم | حدود وبطاقات ونمط | `app.css:3237-3295` | `step-2a-warehouse-1366x768.png` | منفّذ بدليل |
| 2-ط | التلميع | pill وعدادات وحالات | `app.css:3237-3360` | `step-2b-warehouse-1366x768.png`; `step-2b-browser-results.json` | منفّذ بدليل |
| 3-أ | الشريط العلوي | 12 مجموعة تنقل | `index.html:102-105`; `app.js:8223-8259` | `step-3-ribbon-1366x768.png` | منفّذ بدليل |
| 3-ب | التحديد والتنقل | تسع وجهات وتمييز نشط | `app.js:2795-2799,8244-8255` | `step-3-browser-results.json` | منفّذ بدليل |
| 3-ج | الأدوات | 37 أداة مباشرة | `index.html:104`; `app.js:2796-2799` | `step-3-browser-results.json` | منفّذ بدليل |
| 3-د | الإعدادات | بقيت مخفية/ضمن الوصول المحدد | `app.js:2434-2456,2565-2578` | `step-3-browser-results.json` | منفّذ بدليل |
| 4-أ | رأس لوحة التحكم | رأس بارتفاع 82px | `index.html:474-492`; `app.css:2951-2963` | `step-4a-dashboard-1366x768.png` | منفّذ بدليل |
| 4-ب | البطاقات | ثلاث بطاقات وخمسة أزرار | `index.html:494-500`; `app.js:1408-1423` | `step-4a-browser-results.json` | منفّذ بدليل |
| 4-ج | أزرار البطاقة | خمسة لكل بطاقة | `app.js:1416`; `index.html:497` | `step-4a-browser-results.json` | منفّذ بدليل |
| 4-د | رأس الفروع | صف واحد | `index.html:495-499` | `step-4a-browser-results.json` | منفّذ بدليل |
| 4-هـ | الخزينة والمصروفات | ملخصان وبطاقات متساوية | `index.html:502-512`; `app.css:3290` | `step-4a-browser-results.json` | منفّذ بدليل |
| 4-و | الخطوط | نص أساسي وعناوين | `app.css:2951-2963`; `assets/vendor/fonts.css` | `step-4a-browser-results.json` | منفّذ بدليل |
| 4-ز | الأرقام | تطبيع الأرقام | `app.js:normalizeDashboardDigits` | `step-4a-browser-results.json` | منفّذ بدليل |
| 4-ح | التمدد | لا تمدد أفقي | `index.html:470-550` | `step-4a-browser-results.json` | منفّذ بدليل |
| 4-ط | فجوة اللوحة | قياسات الفراغ والمحتوى | `app.js:2561-2564,2902-2909`; `app.css:3318-3319` | `step-4b-final-results.json` | منفّذ بدليل |
| 4-ي | إزالة القائمة العامة | مخفية في POS و`theme-sage-metal` فقط؛ خريطة الوصول أدناه | `app.js:2834-2839`; `index.html:115` | `step-4b-access-map.md`; `step-4b-final-results.json` | جزئي: ليس نهائياً لكل الثيمات |
| 5-أ | 30 يوماً | مدة التجربة والقفل | `license.js:9,67-90` | `step-5a-browser-results.json`; `t20-license.test.js` | منفّذ بدليل |
| 5-ب | أماكن الحالة | ملف/Registry/ترخيص | `license.js:111-175` | `t20-license.test.js`, `t21-license-server.test.js` | منفّذ بدليل |
| 5-ج | التوفيق | توحيد مصادر الحالة | `license.js:137-175` | 12 نجاحاً موثقاً | منفّذ بدليل |
| 5-د | القفل | انتهاء/رجوع الساعة/402 | `license.js:78-90`; `server.js:4005-4009` | `t20` و`t21` | منفّذ بدليل |
| 5-هـ | المتبقي | شريط وأيام متبقية | `app.js:2651-2662`; `index.html:94,1931` | `step-5a-trial-1366x768.png` | منفّذ بدليل |
| 5-و | التشخيص | README وتعريف `dist:win` | `package.json:11`; `README.md:13-15` | `step-5c-results.json` | منفّذ بدليل |
| 5-ز | المثبتات | لم يُبنَ/لم يُسلّم بناءً على قرار المستخدم | `package.json:11` | لا يوجد مثبت في التسليم | لم أتحقق |
| 5-ح | الحساب التجريبي | الحفاظ على القائمة وإنشاء القياسي عند الفراغ | `server.js:54-70`; `t20-license.test.js:131-139` | `step-5a-browser-results.json` | منفّذ بدليل |
| 6-أ | زر الخروج | زر ثابت أسفل الواجهة | `index.html:1931`; `app.css:1248` | `step-6-results.json` ولقطات 10 شاشات | منفّذ بدليل |
| 6-ب | إنهاء الجلسة | logout و401 بعد الرجوع | `app.js:2641-2649`; `server.js:997` | `step-6-results.json` | منفّذ بدليل |
| 6-ج | عدم التداخل | overlaps=0 | `app.css:3332-3335` | قياسات 1366/1920 | منفّذ بدليل |
| 7-أ | شاشة الحملة | رسالة وقنوات وعدادات | `index.html:1126-1150`; `app.js:5927-6008` | `step-7a-campaign-1366x768.png` | منفّذ بدليل |
| 7-ب | جلب الأرقام | تطبيع/تكرار/غير صالح | `campaign-whatsapp-manager.js:7-28`; `server.js:628-632` | `step-7a-results.json` | منفّذ بدليل |
| 7-ج | SMS | dry-run وحماية إعدادات ناقصة | `campaign-whatsapp-manager.js:87-98,127-135` | `step-7a-results.json` | منفّذ بدليل |
| 7-د | WhatsApp | Baileys وربط الجلسة | `campaign-whatsapp-manager.js:31-73`; `package.json:27` | `step-7b-results.json` | منفّذ بدليل |
| 7-هـ | التأخير | 5–12 ثانية | `campaign-whatsapp-manager.js:112-145` | `step-7b-results.json` | منفّذ بدليل |
| 7-و | سلامة الإرسال | تأكيد وتقدم وإيقاف | `app.js:5969-6014` | `step-7c-results.json` | منفّذ بدليل |
| 7-ز | الاختبار | dry-run وتكرار بلا QR | `index.html:1137`; `campaign-whatsapp-manager.js:127-130` | `step-7c-results.json` | منفّذ بدليل |
| 7-ح | عدم التأثير | فشل الشبكة لا يعطل المسار | `campaign-whatsapp-manager.js:130-151` | `step-7c-results.json` | منفّذ بدليل |
| 7-ط | التدقيق | v62/بدون Baileys/معه: 15 عالية و0 حرجة | `package.json:25,27`; lock | تقرير 7-ط في `PROGRESS.md` | منفّذ بدليل |
| 7-ي | لا إرسال تلقائي | فتح محادثة يدوي/لا إرسال حقيقي | `app.js:5902+`; `campaign-whatsapp-manager.js:100-105` | `step-7b/c-results.json` | منفّذ بدليل |
| 7-ك | ربط البناء | مدير الحملات ضمن build files مع try/catch | `package.json:42-78`; `electron/main.js:106-111` | `step-7b-build-binding.json` | منفّذ بدليل |
| 8-أ | طلب توصيل وحقول الطيار والعنوان | الحقول تظهر عند اختيار توصيل، والتخزين يربطهما بالبيع | `index.html:304-310`; `app.js:3670-3685`; `server.js:3184-3204` | `step-8-browser-results.json` ولقطات `step-8-*` | منفّذ بدليل |
| 8-ب | سجل تغيير الطيار | `assignment_history` وaudit عند التعيين/التغيير | `server.js:3196-3204` | `step-8-api-results.json` | منفّذ بدليل |
| 8-ج | جدول الطلبات | فاتورة/عميل/عنوان/حالة/طيار/عهدة | `index.html:960-962`; `app.js:5390-5465` | `step-8-browser-results.json` | منفّذ بدليل |
| 8-د | التحصيل | تحصيل وتوريد وعهدة | `server.js:3206-3239` | `step-8-api-results.json` | منفّذ بدليل |
| 8-هـ | السلفة | مصدر rider أو employee ومعاملة مالية | `server.js:3133-3139`; `database.js:386+` | `step-8-summary-results.json` | منفّذ بدليل |
| 8-و | كشف الطيار | تم/قيد/مرتجع/عهدة/رصيد سلف | `index.html:994`; `app.js:5342`; `server.js:3108-3132` | `step-8-summary-results.json` | منفّذ بدليل |
| 8-ز | عدم التأثير | بيع سابق لا يتغير | `server.js:3194-3204` | `step-8-api-results.json` (`oldSaleUnaffected`) | منفّذ بدليل |
| 9-أ | شاشة فواتير الشراء | قائمة ونموذج | `index.html:1006-1060,2296-2373`; `app.js:5136-5205` | `step-9-after-list/invoice-*.png` | منفّذ بدليل |
| 9-ب | تقسيم المناطق | header/body/footer بلا تداخل | `index.html:2296-2373`; `app.js:5136-5205` | `step-9-after-invoice-1366x768.png` | منفّذ بدليل |
| 9-ج | إدخال الأصناف | Tab/Enter وخمسة صفوف | `app.js:5567-5705` | `step-9-correction.json` | منفّذ بدليل |
| 9-د | التحقق | رسائل المورد والصنف | `app.js:5567-5745` | `step-9-after-invoice-*.png` | منفّذ بدليل |
| 9-هـ | الحساب | إجمالي/مدفوع/متبقي/رصيد/كمية | `server.js:3306-3394`; `app.js:5745-5750` | جدول v62 مقابل الجديد في `PROGRESS.md` | منفّذ بدليل |
| 9-و | البحث والطباعة | PUR والمورد وفتح/طباعة | `index.html:1032-1054`; `app.js:5136-5205` | `step-9-after-list-*.png` | منفّذ بدليل |
| 9-ز | ثبات الحساب | التعديل عرضي فقط | `app.js:updatePurchaseRemaining/renderPurchaseRows` | `step-9-correction.json` | منفّذ بدليل |
| ب-1 | اختيار القاعدة أول تشغيل | اختيار مجلد وعدم إنشاء صامت | `main.js:303-332`; `startup-flow.test.js` | `step-5b-results.json` | منفّذ بدليل |
| ب-2 | مسار محفوظ غير متاح | حوار ومسار بديل بعد موافقة | `main.js:274-301`; `startup-runtime.js:14-25` | `startup-runtime.test.js` | منفّذ بدليل |
| ب-3 | لا صفحة طوارئ | dialog فقط وتمييز -3/-2 | `main.js:43-70,497-507`; `external-url.js:3-24` | `step-5b-results.json` | منفّذ بدليل |
| ب-4 | startup.log | علامات المراحل وloadURL/did-fail | `main.js:39-53,92-102,444-551` | `step-5b-results.json` | منفّذ بدليل |
| ب-5 | الملفات الناقصة | 0 ناقص و59/59 requires | تدقيق `b-5-audit.json` | `b-5-audit.json` | منفّذ بدليل |
| ب-6 | نظافة الحزمة | لا artifacts ممنوعة | فحص zip | `HANDOFF_REPORT.md` | منفّذ بدليل |
| ب-7 | مقارنة الاختبارات | تشغيل كامل كشف 179/6 مقابل v62 151/8 | `source-full-test.log`, `v62-full-test.log` | جدول التقرير النهائي | جزئي |
| ب-8 | البناء | لم يُبنَ بناء التسليم | `package.json:11` | لا يوجد artifact نهائي | لم أتحقق |
| ب-9 | app.asar | لم يُفحص للتسليم الحالي | `package.json:39` | لا يوجد بناء نهائي | لم أتحقق |
| ب-10 | باقة المصدر | zip وSHA ونسخة مفكوكة | مسار `SYSTEM_Final_Delivery` | `SHA256.txt` | منفّذ بدليل |
| ب-11 | README والتقرير | README وFINAL_REPORT | `README.md`; `03_Reports` | الملفات نفسها | منفّذ بدليل |
| ب-12 | أول تشغيل | config غائب ثم اختيار وقاعدة وخادم | `main.js:303-365`; `startup-flow.test.js` | `step-5b-results.json` | منفّذ بدليل |

### توضيح 4-ي

ليست الإزالة نهائية لكل الثيمات: `app.js:2836-2839` يخفي `#app-shell aside.w-60` عندما تكون شاشة POS أو عندما يكون `theme-sage-metal` مفعلاً؛ في الثيمات الأخرى يعاد إظهارها. لذلك الحالة أعلاه «جزئي» إذا كان المطلوب إزالة عامة في كل الثيمات. خريطة الوصول المثبتة في `outputs/step-4b-access-map.md` هي: لوحة التحكم←الشريط العلوي؛ المبيعات←المبيعات ثم نقطة البيع؛ العملاء←العملاء؛ المشتريات/المخزون/المنتجات/الفئات←المشتريات والمخازن؛ التقارير←التقارير؛ الموظفون←شؤون الموظفين؛ المستخدمون←شؤون الموظفين ثم المستخدمون؛ الإعدادات والنسخ←إعدادات البرنامج/مجموعة قاعدة البيانات. قائمة المخازن الداخلية تبقى داخل صفحة المخازن، وليست القائمة العامة.

### توضيح البند 8

الحقول موجودة فعلاً في فاتورة المبيعات عند اختيار «توصيل»: `index.html:304-310` (`pos-delivery-rider-select` و`pos-delivery-address`)، ويُرسلها `app.js:3670-3685`. التعيين وسجل التغيير في `server.js:3196-3204` (`assignment_history` وaudit). السلفة في `server.js:3133-3139`، وكشف الطيار وملخص السلفة في `index.html:994`, `app.js:5342`, `server.js:3108-3132`. الأدلة: `outputs/step-8-api-results.json`, `step-8-browser-results.json`, `step-8-summary-results.json` ولقطات `step-8-*.png`. لم أجد دليلاً على نقص هذه الحقول؛ أما جهاز نظيف وElectron فلم أتحقق منه.

## 4) القرارات الثابتة

- الحسابات الافتراضية الموثقة في `README.md:11-15`: `admin / admin123`، `inventory / inv123`، `cashier / cash123`. حساب `admin1` حساب مالك محمي؛ لا تُغيّر بياناته ولا تُضمّن كلمة مرور له في توثيق عام.
- التجربة 30 يوماً: `license.js:9,71-90`; تحفظ في `trial-state.json` وRegistry (`license.js:13,120-175`)، مع `license.json` عند التفعيل.
- الحملات: SMS وWhatsApp عبر Baileys `6.7.24` (`package.json:27`)، التأخير الافتراضي 5–12 ثانية (`campaign-whatsapp-manager.js:112-145`)، و`dry-run` افتراضي وعدم إرسال حقيقي في الاختبارات.
- الطيارون: الجداول والمسارات في `server.js:3108-3202` وواجهة `app.js:5284-5465`؛ لا تمس مبيعات قديمة أو admin 1.
- أخطاء البدء: نافذة نظام `dialog.showMessageBox` في `main.js:43-70`؛ لا تُحمّل صفحة طوارئ. `ERR_ABORTED (-3)` غير قاتل، و`ERR_FAILED (-2)` في الصفحة الرئيسية يعرض الحوار فقط.

## 5) القواعد الصارمة لأي عمل لاحق

1. `admin1` خط أحمر: لا تعديل أو حذف أو إعادة تعيين.
2. لا حذف أو تعديل بيانات المستخدم؛ اختبارات قاعدة البيانات تستخدم ملفاً مؤقتاً فقط.
3. لا تضع ملفات `.bak` داخل المشروع أو الـzip؛ نسخ الأمان خارج المشروع.
4. لا تغيّر نهايات الأسطر أو القفل دون توثيق وهاش قبل/بعد.
5. لا تشغّل Electron أو مثبتاً على جهاز المستخدم.
6. لا إرسال SMS/WhatsApp حقيقي؛ استخدم dry-run أو mocks فقط.
7. لا تكتب «تم» بلا ملف/سطر/اختبار/لقطة دليل.
8. اعمل بخطوة واحدة وانتظر كلمة «تابع» عند تطبيق نظام الخطوات.
9. استثناء pnpm محدود: استخدم `pnpm@10.12.1` فقط؛ لا تغيّر `pnpm-lock.yaml`. تعيين `tesseract.js=false` لا يتم إلا بعد فحص scripts وتوثيق السبب.

## 6) البيئة والبناء والاختبارات

التثبيت المقصود:

```powershell
corepack prepare pnpm@10.12.1 --activate
pnpm -v
pnpm install --frozen-lockfile
```

للبناء لاحقاً فقط: أنشئ مجلداً جديداً وفارغاً تحت `C:\SYSBUILD`، انسخ المصدر النظيف، نفّذ `pnpm install --frozen-lockfile` ثم `pnpm run dist:win` لإخراج x64 وia32. لا تستخدم مجلد بناء سابقاً. عند `spawn UNKNOWN` توقف فوراً، سجّل الخطأ، وافحص Smart App Control وProtection history. `package.json:11-16,38-80` يثبت إعداد `dist:win` و`signExecutable: false`; الإنتاج يحتاج توقيعاً تجارياً/موثوقاً ولا يجوز تجاوز Smart App Control.

الاختبارات:

- اختبارات الوحدة: `node --test tests/<file>.test.js` أو `pnpm run test:full` (`package.json:10`).
- وضع المتصفح: شغّل `server.js` بقاعدة مؤقتة عبر `RAWDA_DB_PATH`/`RAWDA_DATA_DIR`، ثم استخدم Playwright `1.55.0` ولقطات 1366×768 و1920×1080. لا تستخدم قاعدة المستخدم الحقيقية.
- قبل كل مقارنة احفظ هاش `pnpm-lock.yaml`، ولا تشغّل Electron.

## 7) المعروف وغير المختبر

المعروف: المصدر الحالي JSON وليس SQLite؛ النسخة المصدرية النظيفة 178 ملفاً، بلا `node_modules` أو `dist` أو `.bak` أو قواعد تشغيلية؛ `node --check` نجح للملفات الرئيسية. لا يوجد `02_Installers`.

لم أتحقق من: تشغيل على جهاز نظيف بلا صلاحية loopback، تثبيت فعلي، واجهة Electron على جهاز المستخدم، إرسال SMS/WhatsApp حقيقي، بناء نهائي بعد قرار SQLite، وفحص `app.asar` خاص بالتسليم الحالي.

اختبارات الأساس v62: السجل المقارن السابق `144` نجاحاً و`8` إخفاقات؛ النسخة الجديدة في السجل المقارن `168` نجاحاً و`7` إخفاقات فريدة. التشغيل المفكوك الأخير سجل `39` نجاحاً و`28` إخفاقاً قبل إيقاف الاختبارات الطويلة. الإخفاقات الموثقة تشمل توقعات اختبار قديمة للألوان، شاشة منتجات مخفية عند استدعاء الدالة مباشرة، وانفصال checkbox أثناء إعادة الرسم. لا تُعد هذه النتائج نجاحاً كاملاً.

ملاحظات خارج البنود: بيئة الاختبار منعت اتصالات loopback أحياناً (`EACCES`) وقفل Windows ملفات قاعدة الاختبار (`EPERM`)، لذلك يجب إعادة الاختبارات في بيئة محلية مستقرة. لا توجد ادعاءات نجاح بناء أو تثبيت.

## 8) المهمة القادمة

المهمة التالية هي **تحويل قاعدة `database.json` إلى SQLite** بسبب توقع نحو 30,000 صنف. يجب تصميم migration قابل للرجوع، حفظ نسخة JSON الأصلية، اختبار كل collections ومسارات النسخ والتشغيل الأول، ثم تحديث `database.js` و`server.js` والاختبارات تدريجياً. هذا المصدر وهذه الوثيقة هما نقطة الرجوع؛ لا تبدأ التحويل قبل اعتماد خطة الترحيل واختبار عدم المساس بـ`admin1`.

آخر تحقق: 2026-10-24. هاش القفل الحالي: `F0BE17C295AA7815E8FC4C1C7A824A8D984235147A84DA33744E27B436EBCAB3`.

## تدقيق إضافي قبل اعتماد الباقة — 2026-10-24

- اختبار license/backup نجح منفرداً بصلاحية مرتفعة (1/1) بعد تحديث التوقع ليشمل `delivery_rider_transactions: []`. بقيت كل الحقول القديمة مطابقة byte-for-byte؛ لم يتغير أي حقل آخر.
- T35: بعد `switchTab('products')` نجح `renderProducts()` وظهر 100 صفاً. قياس DOM: `tabVisible=true`, `rows=100`, `searchVisible=true`. اللقطة: `docs/evidence/step-10-t35-products-after.png`. الفشل المتبقي لاحق في جدول المخزون، وليس في `renderProducts`.
- تمت إضافة `switchTab('pos')` و`switchTab('inventory')` إلى الاختبار قبل قياس عناصر تلك الشاشات؛ لم يتغير كود التطبيق.
- Node 22: ناقص؛ `npx` غير متاح، ومحاولة `npx -p node@22 node -v` تعذرت. التشغيل المتاح كان Node `v24.22.1`.
- ملفات app.asar القديمة نُقلت إلى `docs/evidence/old/` ولا تمثل بناء التسليم الحالي.
- المقارنة الحالية تثبت إزالة `business-catalog.json` و`business-profile.json` و`config.json` من المصدر المضغوط. لا يمكن استعادة قائمة 13 اسماً كاملة لأن أرشيف 179 ملفاً السابق استُبدل؛ لذلك هذا الجزء ناقص ولا توجد دعوى بقائمة كاملة.
