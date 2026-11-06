# SQLite → PostgreSQL Migration Mapping

> وثيقة مقارنة فقط — لا تحتوي على كود ترحيل، ولا تنفذ أي نقل للبيانات.

## طريقة القراءة

- قاعدة SQLite الحالية لا تحتوي جدولًا مستقلًا لكل مجموعة؛ التخزين الفعلي يتم في `storage_rows.payload` بصيغة JSON.
- لذلك أُدرجت أسماء المجموعات المنطقية كما ظهرت في `storage_collections`، مع بيان جدول PostgreSQL المستهدف أو الحاجة إلى جدول جديد.
- العينات مأخوذة للقراءة فقط. تم حجب `password_hash` وأي قيمة قد تمثل كلمة مرور أو token.
- `— (0 سجل)` تعني أن المجموعة موجودة في SQLite لكن لا توجد عينة فعلية لاستخراج حقولها.

## الجدول 1 — مجموعات SQLite الـ41

| collection | sample row (1، مع حجب password/token) | الحقول | جدول PG المستهدف | أعمدة مفقودة في PG | ملاحظات |
|---|---|---|---|---|---|
| `ai_insights` | — (0 سجل) | — | **جديد** | غير قابل للتحديد | لا توجد عينة؛ لا يوجد جدول PG مطابق. |
| `attendance` | — (0 سجل) | — | `attendance` | غير قابل للتحديد | تطابق اسمي مباشر؛ يلزم اختبار الحقول عند توفر بيانات. |
| `audit_logs` | `{"id":29,"user_id":1,"action":"تسجيل دخول","entity":"users","entity_id":1,"details":"تسجيل دخول ناجح للمستخدم مدير النظام","created_at":"2026-10-30 23:10:00"}` | `id, user_id, action, entity, entity_id, details, created_at` | `audit_logs` | لا يوجد في العينة | `branch_id` و`updated_at` يضافان أثناء الترحيل حسب الفرع. |
| `branch_inventory` | — (0 سجل) | — | `warehouse_products` | غير قابل للتحديد | تحويل/دمج محتمل مع مخزون المخازن؛ يحتاج قرارًا قبل الترحيل. |
| `branches` | `{"id":1,"name":"الفرع الرئيسي","address":"","phone":"","is_active":true,"is_default":true,"created_at":"2026-10-30T22:41:20.883Z"}` | `id, name, address, phone, is_active, is_default, created_at` | `branches` | `is_default` | `code` و`branch_id` و`updated_at` غير موجودة في المصدر وتحتاج قيمة/قاعدة تحويل. |
| `cash_audit_chain` | — (0 سجل) | — | **جديد** | غير قابل للتحديد | لا يوجد جدول PG مطابق؛ السلسلة تحتاج تصميمًا مستقلًا. |
| `cash_transactions` | — (0 سجل) | — | `cash_transactions` | غير قابل للتحديد | تطابق اسمي؛ لا توجد عينة للتحقق من الحقول. |
| `cashier_shifts` | — (0 سجل) | — | `shifts` | غير قابل للتحديد | إعادة تسمية منطقية؛ يحتاج مطابقة حقول الوردية عند توفر بيانات. |
| `categories` | — (0 سجل) | — | `categories` | غير قابل للتحديد | تطابق اسمي؛ لا توجد عينة. |
| `customer_transactions` | — (0 سجل) | — | **جديد** | غير قابل للتحديد | لا يوجد دفتر معاملات العملاء في مخطط PG الحالي. |
| `customers` | `{"id":1,"name":"عميل نقدي","phone":"","notes":"عميل نقدي افتراضي","balance":0}` | `id, name, phone, notes, balance` | `customers` | لا يوجد في العينة | `branch_id` و`created_at` و`updated_at` يضافون من سياق الفرع/الترحيل. |
| `delivery_assignments` | — (0 سجل) | — | **جديد** | غير قابل للتحديد | لا يوجد جدول PG لربط طلبات التوصيل بالمناديب. |
| `delivery_rider_transactions` | — (0 سجل) | — | **جديد** | غير قابل للتحديد | لا يوجد دفتر معاملات مستقل للمناديب في PG الحالي. |
| `delivery_riders` | — (0 سجل) | — | `delivery_riders` | غير قابل للتحديد | تطابق اسمي؛ لا توجد عينة. |
| `delivery_settlements` | — (0 سجل) | — | `delivery_settlements` | غير قابل للتحديد | تطابق اسمي؛ لا توجد عينة. |
| `employee_transactions` | — (0 سجل) | — | `employee_transactions` | غير قابل للتحديد | تطابق اسمي؛ لا توجد عينة. |
| `employees` | — (0 سجل) | — | `employees` | غير قابل للتحديد | تطابق اسمي؛ لا توجد عينة. |
| `installment_contracts` | — (0 سجل) | — | `installments` | غير قابل للتحديد | إعادة تسمية منطقية؛ يلزم التحقق من بنية العقد قبل الترحيل. |
| `loyalty_transactions` | — (0 سجل) | — | **جديد** | غير قابل للتحديد | إعدادات الولاء موجودة كمخزن قيمة، لكن دفتر الحركات غير موجود في PG. |
| `products` | — (0 سجل) | — | `products` | غير قابل للتحديد | تطابق اسمي؛ لا توجد عينة فعلية. |
| `promotions` | — (0 سجل) | — | `promotions` | غير قابل للتحديد | تطابق اسمي؛ لا توجد عينة. |
| `purchase_items` | — (0 سجل) | — | `purchase_items` | غير قابل للتحديد | تطابق اسمي؛ لا توجد عينة. |
| `purchase_order_items` | — (0 سجل) | — | **جديد** | غير قابل للتحديد | مخطط PG الحالي يحتوي `purchase_orders` فقط دون جدول بنود مستقل. |
| `purchase_orders` | — (0 سجل) | — | `purchase_orders` | غير قابل للتحديد | تطابق اسمي؛ لا توجد عينة. |
| `purchases` | — (0 سجل) | — | `purchases` | غير قابل للتحديد | تطابق اسمي؛ لا توجد عينة. |
| `sale_items` | — (0 سجل) | — | `sale_items` | غير قابل للتحديد | تطابق اسمي؛ لا توجد عينة. |
| `sale_returns` | — (0 سجل) | — | **جديد** | غير قابل للتحديد | لا يوجد جدول مرتجعات في مخطط PG الحالي. |
| `sales` | — (0 سجل) | — | `sales` | غير قابل للتحديد | تطابق اسمي؛ لا توجد عينة. |
| `self_order_requests` | — (0 سجل) | — | **جديد** | غير قابل للتحديد | لا يوجد جدول لطلبات الطلب الذاتي في مخطط PG الحالي. |
| `service_orders` | — (0 سجل) | — | `service_orders` | غير قابل للتحديد | تطابق اسمي؛ لا توجد عينة. |
| `stock_movements` | — (0 سجل) | — | `stock_movements` | غير قابل للتحديد | تطابق اسمي؛ لا توجد عينة. |
| `supplier_transactions` | — (0 سجل) | — | **جديد** | غير قابل للتحديد | لا يوجد دفتر معاملات الموردين في مخطط PG الحالي. |
| `suppliers` | — (0 سجل) | — | `suppliers` | غير قابل للتحديد | تطابق اسمي؛ لا توجد عينة. |
| `suspended_sales` | — (0 سجل) | — | `suspended_sales` | غير قابل للتحديد | تطابق اسمي؛ لا توجد عينة. |
| `users` | `{"id":1,"name":"مدير النظام","username":"admin","password_hash":"[REDACTED]","role":"admin","permissions":["view","add","edit","delete","import_export","print_pdf","system_settings","user_management","image_management"],"is_active":true,"created_at":"2026-10-05 09:00:00","branch_id":1,"must_change_password":true,"bootstrap_password_initialized":true,"is_owner":true}` | `id, name, username, password_hash, role, permissions, is_active, created_at, branch_id, must_change_password, bootstrap_password_initialized, is_owner` | `users` | `bootstrap_password_initialized` | `updated_at` و`last_login_at` موجودان في PG ويحتاجان قيمة افتراضية عند الترحيل. |
| `warehouse_categories` | — (0 سجل) | — | `categories` | غير قابل للتحديد | دمج محتمل مع تصنيفات المنتجات؛ يحتاج تأكيد نطاق التصنيف. |
| `warehouse_inventory` | — (0 سجل) | — | `warehouse_products` | غير قابل للتحديد | إعادة تسمية/دمج محتمل مع مخزون المخازن. |
| `warehouse_products` | — (0 سجل) | — | `warehouse_products` | غير قابل للتحديد | تطابق اسمي؛ لا توجد عينة. |
| `warehouse_stock_movements` | — (0 سجل) | — | `stock_movements` | غير قابل للتحديد | إعادة تسمية/دمج محتمل مع حركات المخزون. |
| `warehouses` | `{"id":1,"branch_id":1,"name":"المخزن الرئيسي","is_default":true,"is_active":true,"created_at":"2026-10-30T22:41:21.536Z"}` | `id, branch_id, name, is_default, is_active, created_at` | `warehouses` | `is_default` | `code` و`address` و`updated_at` موجودة في PG وتحتاج قيمة افتراضية/تحويل. |
| `waste_records` | — (0 سجل) | — | `inventory_waste` | غير قابل للتحديد | إعادة تسمية منطقية؛ يلزم التحقق من سبب الهالك وتاريخه. |

## الجدول 2 — جداول PG بدون collection مطابقة بالاسم

| جدول PG | collection المصدر | ملاحظة |
|---|---|---|
| `campaigns` | فارغ/جديد | لا توجد collection مقابلة في SQLite الحالية. |
| `expenses` | فارغ/جديد | لا توجد collection مقابلة في SQLite الحالية. |
| `installments` | `installment_contracts` | نفس المجال الوظيفي باسم مختلف؛ يحتاج مطابقة الحقول. |
| `inventory_waste` | `waste_records` | نفس المجال الوظيفي باسم مختلف؛ يحتاج مطابقة الحقول. |
| `loyalty_settings` | `storage_values` | إعداد محفوظ كقيمة عامة، وليس collection صفوف. |
| `sessions` | فارغ/جديد | لا توجد collection جلسات في SQLite الحالية. |
| `settings` | `storage_values` | الإعدادات الحالية موزعة كقيم مثل `ui_settings` و`tax_settings` و`accounting_settings`. |
| `shifts` | `cashier_shifts` | نفس المجال الوظيفي باسم مختلف؛ يحتاج مطابقة الحقول. |

## الملخص

- عدد collections لها جدول PG مطابق بالاسم: **24**
- عدد collections تحتاج جدولًا جديدًا في PG: **10**
- عدد collections بها حقول مفقودة في PG، بناءً على العينات المتاحة: **3** (`branches`, `users`, `warehouses`)

### ملاحظات حاسمة قبل الترحيل

1. لا يمكن تنفيذ ترحيل مباشر صف-إلى-صف من الجداول، لأن SQLite الحالية تخزن السجلات داخل `storage_rows.payload` كـ JSON.
2. المجموعات التي لا تحتوي سجلات تحتاج مراجعة منطقية للحقول قبل كتابة أي محوّل.
3. الحقول الإضافية المطلوبة في PostgreSQL مثل `branch_id` و`updated_at` يجب تحديد قيمها وقواعدها قبل الترحيل.
4. هذه الوثيقة لا تعدّل SQLite ولا PostgreSQL ولا أي ملف كود.
