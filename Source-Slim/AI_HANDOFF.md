# SYSTEM POS — AI Handoff & Architecture Guide v4.16.0
مرحباً بك كمساعد ذكاء اصطناعي. مهمتك هي مساعدة المالك في تطوير هذا المشروع.
**قاعدة صارمة:** المالك يمنع منعاً باتاً تعديل التصميم أو المسارات الأساسية.

## 1. الملفات المحمية (Red Lines - DO NOT TOUCH)
ممنوع تعديل هذه الملفات بأي شكل:
- `index.html` (Hash: 1DE6B9BB...)
- `app.css`, `override.css`, `self-order.css` (التصميم)
- `database.js` (Hash: C3A5BC6B...)
- `server.js` (Hash: A2E83651...)
- `storage-adapter.js`
- `electron/main.js`

## 2. أين يُسمح لك بالتعديل؟ (Safe Zones)
- **أدوات جديدة:** أنشئ ملفات في `tools/`.
- **وظائف مشتركة:** أضفها في `shared/`.
- **اختبارات:** أضفها في `tests/`.
- **واجهة الترخيص:** في `license-gate.html` (هذه ليست واجهة الـ POS).

## 3. القواعد الذهبية
1. لا تستخدم `require` لملفات غير موجودة.
2. لا تغير مسارات التخزين (احترم `%APPDATA%\SystemPOS\`).
3. شغل `node --test tests/` بعد أي تعديل.
