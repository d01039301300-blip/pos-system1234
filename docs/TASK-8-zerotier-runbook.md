# TASK 8 — ZeroTier + database-per-branch runbook

> وثيقة تشغيلية للمالك/المشغّل. لا تحتوي كودًا.

## Topology

- ZeroTier network واحدة، خادم PostgreSQL مركزي واحد.
- قاعدة بيانات منفصلة لكل فرع: `pos_branch_01` … `pos_branch_10`.
- كل فرع يشغّل `sync-worker` محليًا يتصل بـ `pos_branch_NN` الخاص به.
- لا يوجد cross-branch database access.

## الخادم المركزي (PostgreSQL)

1. تثبيت PostgreSQL 16.x (تم — 16.15).
2. تثبيت ZeroTier One وانضمام للشبكة: `zerotier-cli join <network-id>`.
3. ملاحظة عنوان ZeroTier الثابت: `zerotier-cli listnetworks` → IP.
   (مثال: `10.147.20.1` — لا تفترضه، اقرأه فعليًا.)

4. تعديل `postgresql.conf` — السطر التالي:

   `listen_addresses = 'localhost,10.147.20.1'`

5. تعديل `pg_hba.conf` — أضف السطر:

   `host    all    pos_user    10.147.20.0/24    scram-sha-256`

6. إعادة تشغيل الخدمة:

   `Restart-Service postgresql-x64-16`

7. `pos_user` يملك CREATEDB (منفّذ في 8-A).

## Provisioning الفروع (مرة واحدة على الخادم)

```powershell
$env:PGHOST = '127.0.0.1'
$env:PGUSER = 'pos_user'
$env:PGPASSWORD = '<password>'

node tools/provision-all-branches.js             # dry-run
node tools/provision-all-branches.js --apply     # ينشئ فعليًا
```

النتيجة: `pos_branch_01` … `pos_branch_10` كل واحدة 44 جدولًا.

## إعداد كل فرع

1. ZeroTier One منضم لنفس الشبكة.
2. متغيرات البيئة على جهاز الفرع:

   `PGHOST=<ZT-IP-الخادم>`
   `PGPORT=5432`
   `PGDATABASE=pos_branch_01`
   `PGUSER=pos_user`
   `PGPASSWORD=<password>`

3. التحقق:

   `node tools/branch-health.js --branch 01`

   المتوقع: `HEALTHY: true`.

## تشغيل sync-worker في الفرع

```powershell
node tools/sync-worker.js
```

- advisory lock على `pos_branch_NN` (مستقل لكل فرع).
- LISTEN على `pos_sync_enqueue`.
- polling كل 60 ثانية.
- SIGTERM يُغلق نظيفًا.

تحذير: لا تشغّل `tools/migrate-to-postgres.js` على `pos_branch_NN`. له خريطة
collection→table مختلفة عن sync-bridge وقد يسبب id collision. البيانات تصل للفروع
عبر sync-worker فقط.

## استكشاف الأخطاء

| العَرَض | السبب | الحل |
|---|---|---|
| connect ECONNREFUSED | ZeroTier غير متصل / PG لا يستمع | `zerotier-cli listnetworks` + `listen_addresses` |
| tables=0 < 40 | provision لم يُنفّذ | `node tools/provision-all-branches.js --apply` |
| advisory lock busy | sync-worker يعمل بالفعل | طبيعي — لا تشغّل نسختين |
| password authentication failed | PGPASSWORD خطأ | تحقق من `pg_hba.conf` + كلمة السر |
| sync-worker exit 2 | target tables مفقودة | أعد provision |

## ما لم يُغطَّ في TASK 8

- 8-C: 4 collections محذوفة من sync (branch_inventory، warehouse_inventory،
  warehouse_stock_movements، warehouse_categories) — تحتاج جداول PG حقيقية. مؤجلة.
- 8-D: اختبار فعلي على 10 أجهزة — خارج نطاق Lona، ينفّذه المشغّل.
