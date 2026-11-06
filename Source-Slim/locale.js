'use strict';

(() => {
  const dictionaries = {
    ar: {},
    en: {
      'لوحة التحكم': 'Dashboard', 'المبيعات': 'Sales', 'المشتريات والمخازن': 'Purchases & Warehouses',
      'العملاء': 'Customers', 'الموردين': 'Suppliers', 'التقارير': 'Reports', 'شؤون الموظفين': 'Employees',
      'مركز التحكم السريع': 'Quick control center', 'المبيعات والعملاء': 'Sales and customers', 'المخازن والمشتريات': 'Warehouses and purchases', 'الإدارة والتقارير': 'Administration and reports',
      'سجل المبيعات': 'Sales history', 'العروض الترويجية': 'Promotions', 'التقسيط': 'Installments', 'رسائل العروض': 'Offer messages', 'المخزون': 'Inventory', 'طباعة باركود': 'Print barcodes',
      'الموظفين': 'Employees', 'المستخدمين': 'Users', 'سجل النشاط': 'Activity log', 'الدليفري': 'Delivery',
      'الخزائن والمعاملات النقدية': 'Cash Drawers', 'إعدادات البرنامج': 'Settings', 'مظهر البرنامج': 'Appearance',
      'لوحة التحكم': 'Dashboard', 'الرجوع للقائمة الرئيسية': 'Back to dashboard', 'العودة إلى لوحة التحكم': 'Back to dashboard',
      'إخفاء الشريط العلوي': 'Hide top bar', 'إظهار الشريط العلوي': 'Show top bar', 'تغيير ثيم وخلفية البرنامج': 'Change theme and background',
      'ربط أجهزة الشبكة والتابلت': 'Connect network devices and tablets', 'تنبيهات النواقص': 'Low stock alerts',
      'عرض اختصارات لوحة المفاتيح': 'Keyboard shortcuts', 'رجوع': 'Back', 'الاختصارات': 'Shortcuts',
      'تسجيل الدخول': 'Sign in', 'اكتب اسم المستخدم وكلمة المرور للدخول إلى حسابك': 'Enter your username and password to sign in',
      'اكتب اسم المستخدم': 'Enter username', 'أدخل كلمة المرور أو PIN': 'Enter password or PIN', 'الدخول ببصمة الإصبع أو الوجه': 'Sign in with fingerprint or face',
      'ربط Windows Hello بهذا الحساب': 'Set up Windows Hello for this account', 'تذكر رمز الدخول وتسجيل الدخول تلقائيًا عند فتح البرنامج': 'Remember credentials and sign in automatically',
      'دخول': 'Sign in', 'حفظ بيانات الدخول': 'Remember login', 'تفعيل البرنامج': 'Activate', 'نسيت كلمة المرور؟': 'Forgot password?', 'تواصل عبر واتساب': 'Contact via WhatsApp',
      'شكل الخلفية': 'Background style', 'معدني زيتي': 'Sage metal', 'عاجي ذهبي': 'Ivory gold', 'كحلي معدني': 'Navy steel', 'نيون ليلي': 'Neon night', 'نيون موسّع': 'Neon wide',
      'بحث': 'Search', 'بحث بالاسم أو الباركود أو رقم الصنف': 'Search by name, barcode, or item number',
      'المخزن الرئيسي (رئيسي)': 'Main warehouse (Main)', 'المخزن': 'Warehouse', 'المنتجات': 'Products', 'الفئات': 'Categories',
      'شكل شاشة البيع: بطاقات': 'Sales screen: cards', 'فاتورة بيع حالية': 'Current sales invoice', 'نوع الطلب': 'Order type',
      'داخل المحل': 'In store', 'توصيل': 'Delivery', 'عميل نقدي افتراضي': 'Default cash customer', 'المبلغ المدفوع': 'Amount paid',
      'الإجمالي النهائي': 'Final total', 'إتمام البيع': 'Complete sale', 'إتمام البيع والطباعة': 'Complete sale & print',
      'طباعة': 'Print', 'نقدي': 'Cash', 'بطاقة': 'Card', 'محفظة': 'Wallet', 'دفع آجل': 'Credit', 'تعليق الطلب الحالي': 'Suspend current sale',
      'إفراغ الفاتورة': 'Clear invoice', 'المجموع الفرعي': 'Subtotal', 'خصم إضافي على الفاتورة': 'Invoice discount',
      'المخزون المتاح': 'Available stock', 'اسم المنتج': 'Product name', 'الكمية': 'Quantity', 'السعر': 'Price',
      'حفظ': 'Save', 'إلغاء': 'Cancel', 'إضافة': 'Add', 'تعديل': 'Edit', 'حذف': 'Delete', 'إغلاق': 'Close',
      'الإعدادات': 'Settings', 'حجم الخط': 'Font size', 'عادي': 'Normal', 'كبير': 'Large', 'كبير جداً': 'Extra large',
      'المستخدمون والصلاحيات': 'Users & permissions', 'الموظفون': 'Employees', 'الفروع والمخازن': 'Branches & warehouses',
      'المظهر والفروع والمستخدمون والأجهزة': 'Appearance, branches, users, and devices', 'العودة': 'Return',
      'أدخل بيانات نشاطك': 'Enter your business details', 'اسم النشاط': 'Business name', 'اسم صاحب النشاط': 'Business owner',
      'نوع النشاط': 'Business type', 'رقم هاتف النشاط': 'Business phone', 'العنوان': 'Address', 'شعار النشاط (اختياري)': 'Business logo (optional)',
      'حفظ البيانات وبدء الاستخدام': 'Save and start using the app', 'لا يوجد طيارون نشطون. يمكنك إتمام البيع بدون توصيل أو ': 'No active riders. You can complete the sale without delivery or ',
      'اختر الطيار المتاح': 'Choose an available rider', 'متاح': 'Available', 'غير نشط': 'Inactive',
      'SYSTEM — برنامج مبيعات متكامل': 'SYSTEM — Complete Sales Program'
    }
  };
  Object.assign(dictionaries.en, {
    'نقطة البيع (POS)': 'Point of Sale (POS)', 'نوع البيع للعميل:': 'Customer price level:', 'المجموع الفرعي:': 'Subtotal:',
    'خصم إضافي على الفاتورة:': 'Additional invoice discount:', 'الإجمالي النهائي:': 'Final total:', 'رسوم التوصيل:': 'Delivery fee:',
    'ميعاد الاستحقاق:': 'Due date:', 'المبلغ المتبقي (الباقي):': 'Remaining balance:', 'الأصناف: — · الكميات: —': 'Items: — · quantities: —',
    'إجمالي الرصيد: —': 'Total balance: —', 'إجمالي المصروفات: —': 'Total expenses: —', 'مؤشر المبيعات آخر 7 أيام': 'Sales trend — last 7 days',
    'عرض كل النواقص في المخزن ←': 'View all low-stock items →', 'تقدير محلي يعتمد على مبيعات آخر 30 يوماً والمخزون الحالي.': 'Local estimate based on the last 30 days of sales and current stock.',
    'إجمالي النتائج: 0': 'Total results: 0', 'اسم الفئة الجديدة:': 'New category name:', 'تصدير المخزون Excel': 'Export inventory to Excel',
    'تصدير المشتريات Excel': 'Export purchases to Excel', 'اشترِ X واحصل على Y مجاناً': 'Buy X and get Y free', 'كمية الشراء X': 'Purchase quantity X',
    'كمية المجاني Y': 'Free quantity Y', 'إرسال عبر SMS': 'Send by SMS', 'إرسال عبر WhatsApp': 'Send through WhatsApp',
    'حالة WhatsApp': 'WhatsApp status', 'ربط WhatsApp / عرض QR': 'Connect WhatsApp / Show QR', 'مستلم صالح:': 'Valid recipients:',
    'غير صالح:': 'Invalid:', 'مكرر:': 'Duplicate:', 'محدد:': 'Selected:', 'فواتير:': 'Invoices:', 'المبيعات:': 'Sales:', 'الربح:': 'Profit:',
    'تصدير المبيعات Excel': 'Export sales to Excel', 'تصدير كشف العملاء Excel': 'Export customer statement to Excel',
    'تصدير كشف الموردين Excel': 'Export supplier statement to Excel', 'فرع الموظفين:': 'Employee branch:', 'حضور PIN / بطاقة': 'Attendance PIN / Card',
    'انصراف PIN / بطاقة': 'Check-out PIN / Card', 'اختر المنتج للطباعة:': 'Select product to print:', 'عدد الملصقات:': 'Label count:',
    'تصدير إكسيل (Excel)': 'Export to Excel', 'تصدير Excel': 'Export to Excel', 'عنوان Tally': 'Tally address', 'اسم الشركة في Tally': 'Company name in Tally',
    'إرسال الفواتير الجديدة إلى Tally': 'Send new invoices to Tally', 'سجل مراقبة العمليات الحساسة (Audit Log)': 'Sensitive activity audit log',
    'لوجو النشاط (PNG أو JPG أو WebP)': 'Business logo (PNG, JPG, or WebP)', 'مكان ومسار حفظ قاعدة البيانات (Custom Database Location)': 'Database location',
    'المسار النشط الحالي:': 'Current active path:', 'الشبكة والـIP': 'Network and IP', 'رابط الدخول من أجهزة المحل الأخرى:': 'Access link from other store devices:',
    'احفظ إعدادات الأجهزة على هذا الكمبيوتر. الطباعة العادية تستخدم تعريف Windows؛ التوصيل التسلسلي يتطلب منفذًا يدعمه الجهاز.': 'Save device settings on this computer. Standard printing uses the Windows driver; serial printing requires a supported port.',
    'طابعة Windows الافتراضية / اختيار من نافذة الطباعة': 'Default Windows printer / choose from print dialog', 'طابعة أخرى مثبتة في Windows': 'Other printer installed in Windows',
    'طباعة من تعريف Windows (متوافقة مع أغلب الطابعات)': 'Print through Windows driver (works with most printers)',
    'نص ESC/POS عبر منفذ تسلسلي يدعم العربية': 'ESC/POS text over a serial port with Arabic support', 'اختيار منفذ COM لطباعة ESC/POS': 'Select COM port for ESC/POS printing',
    'وضع ESC/POS يحتاج طابعة تسلسلية تدعم UTF-8. وضع Windows يعمل مع الطابعات المثبتة بتعريفها.': 'ESC/POS mode requires a serial printer with UTF-8 support. Windows mode works with installed printer drivers.',
    'إشارة درج من الطابعة (ESC/POS)': 'Cash drawer signal from printer (ESC/POS)', 'اختيار منفذ COM للدرج': 'Select cash-drawer COM port',
    'أمر قراءة ESC/POS': 'ESC/POS read command', 'صورة QR التي يوفرها البنك أو المحفظة': 'QR image provided by the bank or wallet',
    'تجدها داخل مجلد backups بجوار ملف قاعدة البيانات.': 'It is stored in the backups folder beside the database.',
    'يحفظ النظام نسخة مستقلة داخل userData/backups ويحتفظ بآخر 14 نسخة مجدولة. هذا لا يغيّر نسخ قبل/بعد الطلبات.': 'The system keeps a separate copy in userData/backups and retains the latest 14 scheduled backups. This does not change order snapshots.',
    'نسخة مشفرة إلى Google Drive': 'Encrypted Google Drive backup',
    'تُنشأ نسخة SQLite محلية متسقة، ثم تُشفّر AES-256-GCM قبل رفعها. تعطل الإنترنت يُبقي النسخة المشفرة في طابور محلي للمحاولة لاحقاً.': 'A consistent local SQLite snapshot is encrypted with AES-256-GCM before upload. If offline, the encrypted copy stays queued locally for retry.',
    'معرّف OAuth لتطبيق Desktop من Google Cloud': 'OAuth client ID for a Desktop app from Google Cloud', 'ربط Google Drive': 'Connect Google Drive',
    'تحذير أمان: النسخة مشفّرة بكلمة مرورها. إذا نسيت كلمة مرور النسخة فلن يمكن استرجاع بياناتها؛ احتفظ بها في مكان آمن خارج هذا الجهاز.': 'Security: backups are encrypted with their password. If you forget it, the backup cannot be restored. Keep it safely away from this device.',
    'استعادة نسخة من Google Drive': 'Restore from Google Drive', 'نسخ Google Drive': 'Google Drive backups', 'لم يتم فحص حالة Google Drive بعد.': 'Google Drive has not been checked yet.',
    'تحميل نسخة احتياطية (Backup)': 'Download backup', 'رابط الوصول العام (HTTPS)': 'Public access URL (HTTPS)', 'المستخدم الحالي:': 'Current user:',
    'استرجاع بيانات من حساب Google': 'Restore data from Google account', 'الاسم بالكامل:': 'Full name:', 'اسم المستخدم للدخول:': 'Username:',
    'كلمة المرور:': 'Password:', 'الدور والصلاحيات:': 'Role and permissions:', 'قالب صلاحيات جاهز:': 'Permission preset:',
    'فروع العمل (فرع أو فرعان كحد أقصى):': 'Work branches (up to two):', 'اضغط Ctrl لاختيار فرعين.': 'Hold Ctrl to select two branches.',
    'الطباعة وPDF': 'Printing and PDF', 'الرصيد المسجل حالياً:': 'Currently recorded balance:', 'الرصيد الفعلي الجديد بعد الجرد:': 'New actual balance after count:',
    'سبب التسوية:': 'Adjustment reason:', 'إضافة صنف للفاتورة:': 'Add item to invoice:', 'إجمالي فاتورة الشراء:': 'Purchase invoice total:',
    'رقم التسجيل الضريبي:': 'Tax registration number:', 'نقاط الولاء المكتسبة:': 'Loyalty points earned:', 'ضريبة المبيعات:': 'Sales tax:',
    'الإجمالي المستحق:': 'Amount due:', 'رابط الفاتورة الإلكترونية:': 'E-invoice link:', 'حفظ PDF': 'Save PDF',
    'اسم الموظف بالكامل:': 'Employee full name:', 'الوظيفة / الدور:': 'Job / role:', 'فرع العمل:': 'Work branch:', 'بداية العمل:': 'Start date:',
    'نهاية العمل:': 'End date:', 'أيام العمل:': 'Work days:', 'نظام الراتب:': 'Pay schedule:', 'الراتب الأساسي (ج.م):': 'Base salary (EGP):',
    'عمولة البيع التلقائية (%):': 'Automatic sales commission (%):', 'PIN الحضور (4–8 أرقام):': 'Attendance PIN (4–8 digits):',
    'رقم بطاقة الحضور:': 'Attendance card number:', 'ملاحظات أو مواعيد العمل:': 'Notes or work schedule:', 'نوع العملية المالية:': 'Transaction type:',
    'المبلغ (ج.م):': 'Amount (EGP):', 'البيان / ملاحظات العملية:': 'Description / transaction notes:', 'رابط الشبكة المحلية المباشر:': 'Direct local network link:',
    'خطوات التوصيل السريع:': 'Quick connection steps:', 'خدمة العملاء:': 'Customer service:', 'اسم المنتج / الصنف:': 'Product / item name:',
    'سعر الجملة (اختياري):': 'Wholesale price (optional):', 'سعر العميل المميز (اختياري):': 'Special customer price (optional):',
    'سعر الشراء (التكلفة):': 'Purchase price (cost):', 'سعر البيع للجمهور:': 'Retail price:', 'الكمية المتوفرة:': 'Available quantity:',
    'الحد الأدنى (أمان):': 'Minimum stock level:', 'وحدة القياس:': 'Unit:', 'تاريخ الإنتاج (اختياري):': 'Production date (optional):',
    'تاريخ الانتهاء (اختياري):': 'Expiry date (optional):', 'ملاحظات إضافية:': 'Additional notes:', 'السقف الائتماني (اختياري):': 'Credit limit (optional):',
    'اسم المورد / الشركة:': 'Supplier / company name:', 'ملاحظات ونوع البضاعة:': 'Notes and goods type:', 'المنتج:': 'Product:', 'التاريخ:': 'Date:',
    'الكاشير:': 'Cashier:', 'العميل:': 'Customer:', 'الخصم:': 'Discount:', 'المبلغ المستحق:': 'Amount due:', 'واجهة SYSTEM العصرية': 'SYSTEM modern interface',
    'واجهة SYSTEM المدمجة': 'SYSTEM compact interface', 'واجهة SYSTEM الزجاجية': 'SYSTEM glass interface', 'عنوان:': 'Address:',
    'نقدي': 'Cash', 'قطاعي': 'Retail', 'جملة': 'Wholesale', 'الكل': 'All', 'التالي': 'Next', 'السابق': 'Previous', 'صفحة': 'Page', 'من': 'of',
    'الضريبة متوقفة.': 'Tax is disabled.',
    'فتح الوردية': 'Open shift', 'المبيعات المعلقة': 'Suspended sales', 'الطلبات المعلقة': 'Pending orders', 'إفراغ الفاتورة': 'Clear invoice',
    'إتمام البيع والطباعة': 'Complete sale & print', 'بحث بالاسم أو الباركود أو رقم الصنف': 'Search by name, barcode, or item number',
    'المخزن الرئيسي (رئيسي)': 'Main warehouse (Main)', 'إعدادات البرنامج': 'Settings', 'شكل الخلفية': 'Background style',
    'حفظ البيانات وبدء الاستخدام': 'Save and start using the app', 'أدخل بيانات نشاطك': 'Enter your business details',
    'اسم النشاط': 'Business name', 'اسم صاحب النشاط': 'Business owner', 'نوع النشاط': 'Business type', 'رقم هاتف النشاط': 'Business phone',
    'العنوان': 'Address', 'إعدادات الخزينة': 'Cash drawer settings', 'حركات الطيار': 'Rider ledger', 'سجل الحركات': 'Transaction history',
    'رصيد الخزنة': 'Cash drawer balance', 'قبض': 'Receipt', 'صرف': 'Payment', 'حفظ التغييرات': 'Save changes', 'إضافة صنف جديد': 'Add new product',
    'إضافة فئة جديدة': 'Add new category', 'حركة جديدة': 'New transaction', 'استعادة نسخة احتياطية': 'Restore backup', 'إنشاء نسخة احتياطية': 'Create backup'
  });

  Object.assign(dictionaries.en, {
    'صاحب النشاط': 'Business owner', 'المدير العام': 'General manager', 'جارٍ التحديث': 'Updating', 'جارٍ تحديث بيانات لوحة التحكم...': 'Updating dashboard data...',
    'اسأل محلك': 'Ask your store', 'اسأل عن المخزون، النواقص، الصلاحية، المبيعات المسجلة أو أرصدة العملاء.': 'Ask about stock, low items, expiry dates, recorded sales, or customer balances.',
    'اسأل': 'Ask', 'الوصول السريع': 'Quick access', 'كل أدواتك في مكان واحد': 'All your tools in one place', 'اختصارات ذكية للعمل اليومي': 'Smart shortcuts for daily work',
    'بيع جديد': 'New sale', 'ابدأ فاتورة بيع': 'Start a sales invoice', 'متابعة طلب': 'Track order', 'ابحث عن طلب': 'Search for an order',
    'الفواتير والعروض والعملاء': 'Invoices, offers, and customers', 'نقطة البيع': 'Point of Sale', 'الفواتير والمبيعات': 'Invoices and sales',
    'العروض والأسعار': 'Offers and pricing', 'العملاء والآجل': 'Customers and credit', 'التوريد والموردون': 'Purchasing and suppliers',
    'فواتير المشتريات': 'Purchase invoices', 'الموردون والحسابات': 'Suppliers and accounts', 'المخازن والمنتجات': 'Warehouses and products',
    'الأصناف والكميات والفئات': 'Items, quantities, and categories', 'المخازن والمخزون': 'Warehouses and inventory', 'المنتجات والأسعار': 'Products and prices',
    'الطلبات والطيارون': 'Orders and delivery riders', 'مكتب الدليفري': 'Delivery desk', 'طيارو التوصيل': 'Delivery riders',
    'الخزنة والحسابات': 'Cash drawer and accounts', 'الخزينة والمصروفات': 'Cash drawer and expenses', 'التقارير المالية': 'Financial reports',
    'حسابات العملاء': 'Customer accounts', 'مبيعات اليوم': 'Today’s sales', 'إجمالي فواتير اليوم': 'Today’s invoice total', 'أرباح اليوم الصافية': 'Net profit today',
    'خيارات البيع': 'Sales options', 'عند اختيار الجملة يُستخدم سعر الجملة المسجل للصنف.': 'Wholesale pricing uses the item’s saved wholesale price.',
    'البائع وعمولته': 'Salesperson and commission', 'قناة الطلب': 'Order channel', 'مبلغ الدفع': 'Payment amount', 'المبلغ المدفوع:': 'Amount paid:',
    'المبلغ بالضبط': 'Exact amount', 'السلة فارغة، اختر منتجات أو امسح الباركود': 'The cart is empty. Select products or scan a barcode.',
    'تفاصيل المجموع والخصم': 'Subtotal and discount details', '💵 نقدي': '💵 Cash', '💳 بطاقة': '💳 Card', '📱 محفظة': '📱 Wallet',
    'أدوات': 'Tools', 'القائمة': 'Menu', 'إظهار الشريط الفرعي': 'Show submenu', 'طلبات الموقع': 'Online orders',
    'لا توجد طلبات معلقة': 'There are no pending orders.', 'لا توجد وردية مفتوحة لهذا الكاشير.': 'No shift is open for this cashier.', 'إغلاق الوردية': 'Close shift',
    'إعادة محاولة فتح الكاميرا': 'Retry opening camera', 'فواتير الشراء والتوريد من الموردين': 'Purchase invoices and supplier deliveries',
    'تسجيل الفواتير الواردة وتحديث كميات وأسعار تكلفة المنتجات آلياً.': 'Record incoming invoices and automatically update product quantities and costs.',
    'تسجيل فاتورة شراء جديدة': 'Record a new purchase invoice', 'أوامر الشراء': 'Purchase orders',
    'أنشئ مسودة، اعتمدها، ثم استلمها لتحويلها إلى فاتورة شراء وتحديث المخزون وحساب المورد.': 'Create a draft, approve it, then receive it to create a purchase invoice and update inventory and supplier balances.',
    'إضافة الصنف للأمر': 'Add item to order', 'حفظ مسودة أمر الشراء': 'Save purchase order draft', 'الصنف': 'Item', 'تكلفة الوحدة': 'Unit cost',
    'الصلاحية': 'Expiry', 'الإجمالي': 'Total', 'رقم الأمر': 'Order number', 'المورد': 'Supplier', 'الأصناف': 'Items', 'الحالة': 'Status',
    'تاريخ الإنشاء': 'Created on', 'لا توجد أوامر شراء.': 'There are no purchase orders.', 'بحث برقم الفاتورة أو المورد': 'Search by invoice number or supplier',
    'من تاريخ': 'From date', 'إلى تاريخ': 'To date', 'رقم الفاتورة': 'Invoice number', 'المسؤول': 'Responsible user', 'عدد الأصناف': 'Item count',
    'إجمالي الشراء': 'Purchase total', 'المدفوع': 'Paid', 'المتبقي': 'Remaining', 'التاريخ': 'Date', 'لا توجد فواتير شراء مطابقة.': 'No matching purchase invoices.',
    'إضافة منتج جديد': 'Add new product', 'الكتالوج الموحّد': 'Unified catalog', 'رفع ملف كتالوج': 'Upload catalog file', 'إجمالي الأصناف: 0': 'Total items: 0',
    'الفئة': 'Category', 'الباركود': 'Barcode', 'سعر الشراء': 'Purchase price', 'سعر البيع': 'Sale price', 'هامش الربح': 'Profit margin', 'حد الأمان': 'Minimum stock',
    'تاريخ الإنتاج': 'Production date', 'تاريخ الانتهاء': 'Expiry date', 'لا توجد أصناف مسجلة بعد': 'No items have been registered yet', '0–0 من 0': '0–0 of 0',
    'لكل صفحة': 'Per page', 'صفحة 1 من 1': 'Page 1 of 1', 'إدارة الفروع': 'Branch management', 'التنبيهات': 'Alerts', 'الرئيسية': 'Main',
    'إدارة أصناف المخزن وفئاته ومتابعة أرصدته وحركاته.': 'Manage warehouse items and categories, and review balances and movements.', 'الفرع': 'Branch', 'الفروع': 'Branches',
    'المخازن': 'Warehouses', 'إضافة مخزن جديد': 'Add new warehouse', 'إضافة منتج': 'Add product', 'عرض المحتوى': 'Show contents', 'الأصناف والكميات': 'Items and quantities',
    'حركة المخزون': 'Stock movement', 'لا توجد منتجات مرتبطة بهذا المخزن.': 'No products are linked to this warehouse.', 'تقرير المخزون الحالي': 'Current inventory report',
    'جميع المنتجات': 'All products', '⚠️ النواقص والحد الأدنى': '⚠️ Low stock and minimums', '📜 سجل حركة المخزون': '📜 Stock movement log',
    '🧪 التشغيلات والصلاحية': '🧪 Lots and expiry', 'تسوية جرد مخزني': 'Stock adjustment', 'المنتج': 'Product', 'الكمية الحالية': 'Current quantity',
    'الحد الأدنى': 'Minimum level', 'قيمة المخزون (سعر التكلفة)': 'Inventory value (cost)', 'حالة الرصيد': 'Balance status', 'إجراء': 'Action',
    'تسجيل هالك أو تالف': 'Record damaged or wasted stock', 'قائمة العملاء وسجل المديونيات': 'Customer list and balances', 'إضافة عميل': 'Add customer',
    'الاسم': 'Name', 'رقم الهاتف': 'Phone number', 'الرصيد / الآجل': 'Balance / credit', 'نقاط الولاء': 'Loyalty points', 'ملاحظات': 'Notes',
    'قائمة الموردين المعتمدين': 'Approved suppliers', 'إضافة مورد': 'Add supplier', 'اسم المورد': 'Supplier name', 'الرصيد المستحق': 'Amount payable', 'ملاحظات والتوريدات': 'Notes and deliveries',
    'مركز الإعدادات': 'Settings center', 'وصول سريع إلى الإعدادات الموجودة في البرنامج.': 'Quick access to application settings.', 'النسخ الاحتياطي': 'Backups',
    'تحميل واستعادة النسخ الموجودة.': 'Download and restore existing backups.', 'فتح شاشة المستخدمين الحالية.': 'Open user management.', 'تغيير الثيم والخلفية من النافذة الحالية.': 'Change the theme and background here.',
    'فتح إدارة الفروع الموجودة.': 'Open branch management.', 'بيانات النشاط': 'Business details', 'تعديل بيانات النشاط الحالية.': 'Edit business details.',
    'أجهزة نقطة البيع': 'Point-of-sale devices', 'فتح إعدادات الأجهزة الموجودة.': 'Open device settings.', 'إظهار وإخفاء الشاشات': 'Show or hide screens',
    'تطبيق الإعدادات على دور': 'Apply settings to role', 'طي الكل': 'Collapse all', 'عرض الكل': 'Expand all', 'إظهار الكل': 'Show all', 'الحجم': 'Size',
    'لغة البرنامج': 'Application language', 'اللغة': 'Language', 'شكل شاشة البيع': 'Sales screen layout', 'التخطيط': 'Layout',
    'لم يتم اختيار صورة جديدة.': 'No new image selected.', 'حفظ بيانات النشاط': 'Save business details', 'إزالة لوجو النشاط': 'Remove business logo',
    'إعداد الفاتورة الضريبية': 'Tax invoice settings', 'تفعيل احتساب الضريبة على الفواتير الجديدة': 'Calculate tax on new invoices', 'نسبة الضريبة %': 'Tax rate %',
    'رقم التسجيل الضريبي': 'Tax registration number', 'حفظ إعداد الضريبة': 'Save tax settings', 'الضريبة متوقفة.': 'Tax is disabled.',
    'برنامج نقاط ولاء العملاء': 'Customer loyalty program', 'تفعيل اكتساب نقاط الولاء': 'Enable loyalty points', 'قيمة الإنفاق لاكتساب نقطة واحدة (ج.م)': 'Spend required to earn one point (EGP)',
    'تنبيهات النواقص': 'Low stock alerts', 'تسجيل الدخول': 'Sign in', 'اكتب اسم المستخدم': 'Enter username', 'أدخل كلمة المرور أو PIN': 'Enter password or PIN',
    'كاميرا': 'Camera', '📷 كاميرا': '📷 Camera', 'المخزن الرئيسي': 'Main warehouse', 'المشتريات': 'Purchases', 'التوصيل': 'Delivery',
    '0.00 ج.م': 'EGP 0.00', 'ج.م': 'EGP', 'سعر البيع − سعر الشراء الفعلي': 'Sale price − actual purchase cost', 'فواتير اليوم': 'Today’s invoices',
    'عمليات بيع ناجحة': 'Successful sales', 'نواقص المخزون': 'Low stock', 'أصناف بلغت الحد الأدنى أو نفدت': 'Items at or below minimum stock',
    'ديون العملاء الآجلة': 'Customer receivables', 'مستحقات الموردين': 'Supplier payables', 'تحديث لحظي': 'Live update', 'الأكثر مبيعاً': 'Top-selling items',
    'الأكثر مبيعًا': 'Top-selling items', 'لا توجد مبيعات مسجلة حتى الآن': 'No sales have been recorded yet', 'الرصيد المتبقي': 'Remaining balance',
    'إجراءات': 'Actions', 'إجمالي الأصناف: 0': 'Total items: 0', 'لا توجد أصناف مسجلة بعد': 'No items have been registered yet',
    '0–0 من 0': '0–0 of 0', 'لكل صفحة': 'Per page', 'صفحة 1 من 1': 'Page 1 of 1', 'السابق': 'Previous', 'التالي': 'Next',
    'تظل شاشة الإعدادات متاحة حتى يستطيع الأدمن إعادة العناصر.': 'Settings remain available so an administrator can restore the items.',
    'يُطبّق الإخفاء على مستخدمي الدور المحدد فقط، ولا يحذف بيانات أو يغيّر صلاحيات الوصول. تظل شاشة الإعدادات متاحة حتى يستطيع الأدمن إعادة العناصر.': 'Visibility changes apply only to users with the selected role. They do not delete data or change access permissions. Settings remain available so an administrator can restore items.',
    'يُحفظ هذا الإعداد لكل مستخدم ويطبّق بالتناسب على الشاشات والجداول والأزرار والقوائم.': 'This setting is saved per user and scales screens, tables, buttons, and menus proportionally.',
    'اختيار منفصل لكل مستخدم. يبدأ النظام بشكل بطاقات اللمس، ويمكن الرجوع إلى التخطيط الكلاسيكي.': 'Saved separately for each user. The touch-card layout is the default; you can switch back to the classic layout.',
    'يمكنك تعديل اسم صاحب النشاط واسم النشاط ونوعه والعنوان ورقم الهاتف والشعار في أي وقت. شعار SYSTEM هوية ثابتة للبرنامج.': 'You can update the owner and business names, business type, address, phone, and logo at any time. The SYSTEM logo is a permanent application identity.',
    'تظل الضريبة متوقفة حتى تفعيلها وإدخال النسبة ورقم التسجيل من بياناتك الرسمية. تُضاف الضريبة فوق الأسعار الحالية.': 'Tax stays disabled until you enable it and enter the official rate and registration number. Tax is added on top of current prices.',
    'يكتسب العميل المسجل نقاطًا من قيمة مشترياته. تُخصم النقاط المكتسبة تلقائيًا عند إرجاع الفاتورة.': 'Registered customers earn points based on purchases. Earned points are automatically deducted when an invoice is returned.',
    'حفظ إعدادات الولاء': 'Save loyalty settings', 'البرنامج متوقف حاليًا.': 'The program is currently disabled.',
    'يمكنك تحديد وحفظ ملف قاعدة البيانات في أي بارتشن (مثلاً D:\\ أو E:\\) أو على فلاشة USB لحماية بياناتك من الفورمات.': 'Choose a database file on a disk (for example D: or E:) or a USB drive to protect data from disk formatting.',
    'متصل ونشط': 'Connected and active', 'اختيار مجلد': 'Choose folder', 'فتح المجلد': 'Open folder', 'حفظ ونقل البيانات للمسار الجديد': 'Save and move data to the new location',
    'الربط بالشبكة المحلية وتشغيل كاشير على أجهزة وتابلت متعددة': 'Connect to the local network and run cashiers on multiple devices and tablets',
    'يمكن لأي تابلت أو هاتف أو لابتوب متصل بنفس راوتر الواي فاي بمحلك فتح النظام والعمل كنقطة بيع إضافية في نفس الوقت.': 'Any tablet, phone, or laptop on the store Wi-Fi can open the system and work as an additional point of sale.',
    'عرض رابط الشبكة': 'Show network link', 'نسخ الرابط': 'Copy link',
    'عند فتح الرابط لأول مرة من التابلت أو الهاتف سيظهر تحذير أمان. اضغط (خيارات متقدمة) ثم (متابعة). هذا الاتصال مشفر داخل الشبكة المحلية.': 'The first time you open the link on a tablet or phone, a security warning appears. Select Advanced, then Continue. This connection is encrypted within the local network.',
    'التشغيلة (اختياري)': 'Lot (optional)', 'السبب': 'Reason', 'تسجيل الهالك': 'Record wastage', 'التكلفة التقديرية': 'Estimated cost',
    'التشغيلات': 'Lots', 'لا توجد قيود هالك مسجلة.': 'No wastage records have been logged.', 'فرع رئيسي': 'Main branch', 'الفرع الرئيسي': 'Main branch', 'المخزن الرئيسي · ٠ صنف · إجمالي ٠ وحدة (يشمل المخازن التابعة)': 'Main warehouse · 0 items · 0 units total (including linked warehouses)',
    'كاميرا': 'Camera',
    'صاحب النشاط': 'Business owner', 'تنبيهات المخزون الحرج (نواقص المحل)': 'Critical stock alerts (store shortages)',
    'إجراء سريع': 'Quick action', 'تحليل ذكي للمخزون': 'Smart inventory analysis',
    'لا توجد توصيات محفوظة لهذا اليوم.': 'No recommendations have been saved for today.',
    'المخزون في حالة ممتازة، لا توجد نواقص حالياً! 🎉': 'Inventory is in great shape. There are no shortages right now! 🎉',
    'تحديث التوقعات': 'Refresh forecast',
    'إجمالي الأصناف 0؛ ابحث لعرض الصنف المطلوب.': 'Total items: 0. Search to view an item.',
    'يُخصم من المخزون، ويُحدّث رصيد التشغيلة المختارة، ويُسجّل السبب والتكلفة التقديرية في سجل التدقيق.': 'Stock is reduced, the selected lot balance is updated, and the reason and estimated cost are recorded in the audit log.',
    'عند فتح الرابط لأول مرة من التابلت أو الهاتف سيظهر تحذير أمان. اضغط (خيارات متقدمة) ثم (متابعة). هذا طبيعي لأن النظام يعمل داخل شبكة المحل.': 'The first time you open the link on a tablet or phone, a security warning appears. Select Advanced, then Continue. This is normal because the system runs on the store network.',
    'الميزان والطابعة وأجهزة نقطة البيع': 'Scales, printers, and point-of-sale devices', 'الأجهزة الطرفية للكاشير': 'Cashier peripherals',
    'طابعة الفواتير': 'Invoice printer', 'الطابعة / موديلها': 'Printer / model', 'عرض الورق': 'Paper width',
    'طريقة الطباعة': 'Print method', 'سرعة منفذ الطابعة': 'Printer port speed', 'اختبار الطباعة': 'Test printing',
    'درج النقدية': 'Cash drawer', 'طريقة فتح الدرج': 'Drawer opening method', 'طرف أمر الفتح في الطابعة': 'Printer drawer-command pin',
    'اختبار فتح الدرج': 'Test drawer', 'لم يتم اختيار منفذ تسلسلي.': 'No serial port selected.',
    'الميزان': 'Scale', 'يوجد ميزان موصل بالكاشير': 'A scale is connected to this register', 'البروتوكول': 'Protocol',
    'سرعة الاتصال': 'Connection speed', 'اختيار منفذ الميزان': 'Select scale port', 'اقرأ الميزان': 'Read scale',
    'لم يتم اختيار منفذ. تختلف أوامر القراءة حسب موديل الميزان.': 'No port selected. Read commands vary by scale model.',
    'شاشة العميل والدفع الإلكتروني': 'Customer display and electronic payments', 'توجد شاشة عميل موصلة': 'A customer display is connected',
    'نوع الشاشة': 'Display type', 'اختيار منفذ الشاشة': 'Select display port', 'اختبار الشاشة': 'Test display',
    'جهاز الدفع بالبطاقة': 'Card payment terminal', 'إظهار بيانات الدفع على شاشة العميل الثانية': 'Show payment details on the second customer display',
    'فتح شاشة العميل الثانية': 'Open the second customer display', 'حفظ إعدادات الأجهزة': 'Save device settings',
    'النسخ الاحتياطي لقاعدة البيانات': 'Database backups',
    'يمكنك حفظ نسخة كاملة من كل المنتجات والفواتير والمخزون بضغطة زر واحدة لحماية بيانات المحل، واستعادتها في أي وقت.': 'Save a complete backup of products, invoices, and inventory with one click, then restore it whenever needed.',
    'نسخ تلقائي دائم لكل تغييرات البيانات': 'Permanent automatic backup for every data change',
    'قبل وبعد كل إضافة أو تعديل أو حذف ناجح، يحفظ النظام نسخة كاملة بجانب قاعدة البيانات. النسخ لا تُحذف تلقائياً.': 'Before and after every successful addition, edit, or deletion, the system saves a complete copy beside the database. These copies are not deleted automatically.',
    'نسخ يومي وعند إغلاق البرنامج': 'Daily backup and backup on app exit',
    'مسار نسخة إضافية (اختياري — فلاشة أو مجلد شبكة)': 'Additional backup path (optional — USB drive or network folder)',
    'حفظ مسار النسخة الإضافية': 'Save additional backup path',
    'حفظ المعرّف': 'Save client ID', 'إنشاء ورفع نسخة مشفرة': 'Create and upload encrypted backup',
    'إعادة محاولة الطابور': 'Retry queue', 'فصل الحساب': 'Disconnect account',
    'أدخل كلمة المرور التي حُفظت مع النسخة، ثم عاين بياناتها. سيحفظ النظام نسخة أمان قبل الاستبدال.': 'Enter the password saved with the backup and preview its contents. The system saves a safety copy before replacing data.',
    'كلمة مرور النسخة': 'Backup password', 'حفظ كلمة مرور النسخ': 'Save backup password', 'عرض النسخ': 'View backups',
    'معاينة وتحذير الاستبدال': 'Preview and warn before replacing data', 'أو استعادة نسخة محلية من الجهاز': 'Or restore a local backup from this device',
    'معاينة واستعادة محلية': 'Preview and restore local backup',
    'احفظ ملف البيانات على فلاشة أو مجلد آمن على جهازك.': 'Save the data file to a USB drive or a secure folder on your device.',
    'تحميل النسخة الاحتياطية الآن': 'Download backup now', 'نسخة يومية/إغلاق محفوظة': 'Daily/exit backup saved',
    'استعادة النسخة المجدولة': 'Restore scheduled backup', 'تحديث القائمة': 'Refresh list',
    'إعدادات عنوان الشبكة والمنفذ': 'Network address and port settings',
    'متاحة للمدير فقط. يتطلب تغييرها إعادة تشغيل التطبيق.': 'Available to administrators only. Changes require restarting the app.',
    'عنوان الاستماع': 'Listen address', 'المنفذ': 'Port',
    'الوكيل الموثوق (اختياري، الافتراضي معطّل)': 'Trusted proxy (optional, disabled by default)',
    'حفظ إعدادات الشبكة': 'Save network settings',
    'شاشات القائمة الجانبية': 'Sidebar screens', 'أزرار الشريط العلوي': 'Top bar buttons',
    'قوائم الشريط العلوي': 'Top bar menus', 'بطاقات لوحة التحكم': 'Dashboard cards',
    'إظهار المجموعة': 'Show group', 'إخفاء المجموعة': 'Hide group',
    'ابحث بالاسم أو الفئة أو امسح الباركود للعثور على صنف من كامل القائمة': 'Search by name or category, or scan a barcode to find an item in the full catalog'
  });
  for (const key of Object.keys(dictionaries.en)) dictionaries.ar[key] = key;
  const storageKey = () => `system_ui_language_${String(window.rawdaCurrentUser?.id || window.rawdaCurrentUser?.username || 'guest')}`;
  const normalize = value => String(value || '').replace(/\s+/gu, ' ').trim();
  const t = value => {
    const text = String(value ?? '');
    if (document.documentElement.lang !== 'en') return text;
    const normalized = normalize(text);
    if (dictionaries.en[normalized]) return dictionaries.en[normalized];
    const productTotal = normalized.match(/^إجمالي الأصناف:\s*([\d٠-٩,٬]+)$/u);
    if (productTotal) return `Total items: ${productTotal[1].replace(/[٠-٩]/gu, digit => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit))).replace(/٬/gu, ',')}`;
    const pageRange = normalized.match(/^([\d٠-٩]+)[–-]([\d٠-٩]+) من ([\d٠-٩]+)$/u);
    if (pageRange) return `${pageRange[1]}–${pageRange[2]} of ${pageRange[3]}`.replace(/[٠-٩]/gu, digit => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)));
    const pageNumber = normalized.match(/^صفحة ([\d٠-٩]+) من ([\d٠-٩]+)$/u);
    if (pageNumber) return `Page ${pageNumber[1]} of ${pageNumber[2]}`.replace(/[٠-٩]/gu, digit => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)));
    const scheduledCount = normalized.match(/^([\d٠-٩]+) نسخة مجدولة محفوظة\.$/u);
    if (scheduledCount) return `${scheduledCount[1].replace(/[٠-٩]/gu, digit => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))} scheduled backup(s) saved.`;
    const driveStatus = normalized.match(/^أدخل معرّف OAuth لتطبيق Desktop؛ كلمة مرور الاستعادة غير محفوظة؛ نسخ مشفرة معلقة ([\d٠-٩]+) \(([\d٠-٩,٬]+) KB\)$/u);
    if (driveStatus) return `Enter a Desktop OAuth client ID; restore password not saved; ${driveStatus[1]} encrypted backup(s) queued (${driveStatus[2]} KB)`.replace(/[٠-٩]/gu, digit => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit))).replace(/٬/gu, ',');
    if (normalized.startsWith('لا توجد توصيات محفوظة لهذا اليوم.')) return normalized.replace('لا توجد توصيات محفوظة لهذا اليوم.', 'No recommendations have been saved for today.').replace('يمكن للمدير تحديث التوقعات.', 'A manager can refresh the forecast.');
    const warehouseSummary = normalized.match(/^(.+) · (.+) · ([٠-٩\d,٬]+) صنف · إجمالي ([٠-٩\d,٬]+) وحدة \(يشمل المخازن التابعة\)$/u);
    if (warehouseSummary) return `${t(warehouseSummary[1])} · ${t(warehouseSummary[2])} · ${warehouseSummary[3]} items · total ${warehouseSummary[4]} units (including linked warehouses)`.replace(/[٠-٩]/gu, digit => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit))).replace(/٬/gu, ',');
    if (/^(السبت|الأحد|الإثنين|الاثنين|الثلاثاء|الأربعاء|الخميس|الجمعة)[،,]/u.test(normalized)) {
      return normalized.replace(/السبت|الأحد|الإثنين|الاثنين|الثلاثاء|الأربعاء|الخميس|الجمعة|يناير|فبراير|مارس|أبريل|ابريل|مايو|يونيو|يوليو|أغسطس|اغسطس|سبتمبر|أكتوبر|اكتوبر|نوفمبر|ديسمبر/gu, token => ({ السبت:'Saturday', الأحد:'Sunday', الإثنين:'Monday', الاثنين:'Monday', الثلاثاء:'Tuesday', الأربعاء:'Wednesday', الخميس:'Thursday', الجمعة:'Friday', يناير:'January', فبراير:'February', مارس:'March', أبريل:'April', ابريل:'April', مايو:'May', يونيو:'June', يوليو:'July', أغسطس:'August', اغسطس:'August', سبتمبر:'September', أكتوبر:'October', اكتوبر:'October', نوفمبر:'November', ديسمبر:'December' })[token] || token).replace(/[٠-٩]/gu, digit => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit))).replace(/،/gu, ',');
    }
    if (/^[\s٠-٩\d.,٬٫-]+(?:ج\.م)?$/u.test(normalized)) {
      return normalized.replace(/[٠-٩]/gu, digit => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit))).replace(/٫/gu, '.').replace(/٬/gu, ',').replace(/ج\.م/gu, 'EGP').trim();
    }
    const mixedReplacements = [
      ['امسح الباركود أو Enter', 'Scan barcode or press Enter'],
      ['ابحث بالاسم أو الباركود أو رقم الصنف', 'Search by name, barcode, or item number'],
      ['ابحث باسم العميل أو رقم الهاتف', 'Search by customer name or phone'],
      ['العنوان أو المنطقة', 'Address or area'],
      ['الدعم الفني', 'technical support'],
      ['حفاظًا على سلامة بياناتك ودعمك الفني، لا تثبّت البرنامج على جهاز آخر. بيانات التطبيق محفوظة على هذا الجهاز. للدعم تواصل معنا:', 'For data safety and technical support, do not install the app on another device. App data is stored on this device. Contact support:'],
      ['رقم التواصل:', 'Contact:'],
      ['المستخدم الحالي:', 'Current user:'],
      ['برمجة وتصميم خالد ويجا', 'Developed and designed by Khaled Wega'],
      ['تسجيل الخروج', 'Sign out'],
      ['لا توجد طلبات معلقة', 'No suspended sales'],
      ['تعليق الطلب الحالي', 'Suspend current sale'],
      ['خيارات البيع', 'Sales options'],
      ['عميل نقدي افتراضي', 'Default cash customer'],
      ['نوع الطلب', 'Order type'],
      ['داخل المحل', 'In store'],
      ['توصيل', 'Delivery'],
      ['كبير جداً', 'Extra large'],
      ['الكل', 'All'],
      ['ج.م', 'EGP'],
      ['العربية', 'Arabic'],
      ['إظهار الشريط الفرعي', 'Show sub-bar'],
      ['إخفاء الشريط الفرعي', 'Hide sub-bar'],
      ['يتطلب إعداد Windows Hello على هذا الجهاز. يمكنك دائمًا الدخول بكلمة المرور أو PIN.', 'Windows Hello setup is required on this device. You can always sign in with your password or PIN.']
    ];
    let mixed = text;
    for (const [from, to] of mixedReplacements) mixed = mixed.split(from).join(to);
    return mixed === text ? text : mixed;
  };
  const translateStaticDom = () => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      if (!node.isConnected || node.parentElement?.closest('script,style,textarea,input,[data-user-content],.pos-product-card,.cart-item,.invoice-line,.product-row,.customer-row,.supplier-row')) continue;
      if (document.documentElement.lang === 'ar' && node.__systemArabicText !== undefined) { node.nodeValue = node.__systemArabicText; delete node.__systemArabicText; continue; }
      if (document.documentElement.lang === 'en') {
        const original = node.__systemArabicText ?? node.nodeValue;
        const leading = original.match(/^\s*/u)?.[0] || '';
        const trailing = original.match(/\s*$/u)?.[0] || '';
        const translated = `${leading}${t(original.trim())}${trailing}`;
        if (translated !== original) { node.__systemArabicText = original; node.nodeValue = translated; }
      }
    }
    for (const element of document.querySelectorAll('input[placeholder],textarea[placeholder],[title],[aria-label]')) {
      if (element.matches('input,textarea') && element.value) continue;
      for (const attr of ['placeholder','title','aria-label']) if (element.hasAttribute(attr)) {
        const dataKey = `data-system-original-${attr}`;
        if (document.documentElement.lang === 'ar' && element.hasAttribute(dataKey)) { element.setAttribute(attr, element.getAttribute(dataKey)); element.removeAttribute(dataKey); continue; }
        if (document.documentElement.lang === 'en') {
          const original = element.getAttribute(dataKey) ?? element.getAttribute(attr);
          const translated = t(original);
          if (translated !== original) { element.setAttribute(dataKey, original); element.setAttribute(attr, translated); }
        }
      }
    }
  };
  const setUiLanguage = language => {
    const selected = language === 'en' ? 'en' : 'ar';
    try { localStorage.setItem(storageKey(), selected); } catch (_) {}
    document.documentElement.lang = selected;
    document.documentElement.dir = selected === 'en' ? 'ltr' : 'rtl';
    document.body?.setAttribute('data-language', selected);
    document.querySelectorAll('[dir]').forEach(element => {
      if (element.id === 'pos-main-layout') { element.setAttribute('dir', 'rtl'); return; }
      if (element.tagName === 'BDI' || element.hasAttribute('data-direction-fixed')) return;
      if (element.dataset.systemOriginalDir === undefined) element.dataset.systemOriginalDir = element.getAttribute('dir') || '';
      element.setAttribute('dir', selected === 'en' ? 'ltr' : (element.dataset.systemOriginalDir || 'rtl'));
    });
    const picker = document.getElementById('system-language-setting');
    if (picker) picker.value = selected;
    translateStaticDom();
    if (selected === 'ar') {
      const orderLabel = document.querySelector('[data-ui-group="order-channels"] label:first-child');
      if (orderLabel) { const caption = orderLabel.querySelector('span'); if (caption) caption.textContent = 'نوع الطلب'; else orderLabel.firstChild && (orderLabel.firstChild.nodeValue = 'نوع الطلب'); }
      const order = document.getElementById('pos-order-type');
      if (order) { order.options[0] && (order.options[0].textContent = 'داخل المحل'); order.options[1] && (order.options[1].textContent = 'استلام من الفرع'); order.options[2] && (order.options[2].textContent = 'توصيل'); }
    }
    document.title = t('SYSTEM — برنامج مبيعات متكامل');
    document.querySelectorAll('[data-language-toggle]').forEach(button => {
      button.textContent = selected === 'en' ? 'Arabic' : 'English';
      button.setAttribute('aria-label', selected === 'en' ? 'Switch to Arabic' : 'التبديل إلى الإنجليزية');
    });
    window.applyLoginLanguage?.(selected);
    window.updateTrialBanner?.();
    window.dispatchEvent(new CustomEvent('system-language-changed', { detail: { language: selected } }));
    if (typeof window.updateAppClocks === 'function') window.updateAppClocks();
    window.rawdaDesktop?.setAppLanguage?.(selected).catch(() => {});
    return selected;
  };
  const loadLanguage = () => {
    let selected = 'ar';
    try { selected = localStorage.getItem(storageKey()) || 'ar'; } catch (_) {}
    setUiLanguage(selected);
  };
  window.SYSTEM_DICTIONARIES = dictionaries;
  window.t = t;
  window.setUiLanguage = setUiLanguage;
  window.loadUiLanguage = loadLanguage;
  document.addEventListener('DOMContentLoaded', () => {
    loadLanguage();
    const observer = new MutationObserver(records => {
      if (document.documentElement.lang !== 'en') return;
      const added = records.some(record => record.addedNodes.length || record.type === 'characterData');
      if (added) requestAnimationFrame(translateStaticDom);
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }, { once: true });
})();
