# TASK 7 — SQLite→PostgreSQL Sync Bridge Design (v4, FINAL)

## المبدأ

- `server.js` لا يتغير.
- الحقن في `storage-adapter.js` على مستوى bookkeeping: wrappers حول `upsertRow`, `deleteRow`, `upsertValue`, `deleteValue`.
- الكتابة في `pg_sync_queue` داخل نفس SQLite transaction قبل `COMMIT` (السطور 365, 436, 474).
- متزامن بالكامل (لا `await`، لا تغيير API).

## ما يُزامَن (Row-level only)

- `upsertRow` / `deleteRow` (كل collections المسموحة).
- `upsertValue` / `deleteValue` → جدول PostgreSQL `settings(key, value)`.
- `storage_values` تُسجّل بـ `collection='__values__'`, `row_key=key`, `payload=value`.

## ما يُستثنى (ليست بيانات صفية)

- `updateOrdinal` — ترتيب SQLite داخلي فقط.
- `addCollection` / `deleteCollection` — عمليات schema.
- `setMeta` / `deleteMeta` (`storage_meta`) — metadata.
- `business_catalog` (`LARGE_UNTRACKED_COLLECTIONS`) — يؤجل إلى TASK 8.
- `LARGE_UNTRACKED_COLLECTIONS` — كل ما في القائمة الحالية.

## هوية المصدر

- Composite: `(collection, row_key)` في queue.
- `source_collection` يُحفظ في الطابور.
- `warehouse_categories` → جدول PostgreSQL مستقل `warehouse_categories` (ليس `categories`).
- worker ينشئه إن لم يوجد: `CREATE TABLE IF NOT EXISTS warehouse_categories (...)` بنفس schema `categories` (`id`, `name`, `branch_id`, `created_at`, `updated_at`).

## saveHinted fallback keys

- إذا كان collection مسموحًا للمزامنة ولم يوجد `row_key` مستقر → `raise Error` → `ROLLBACK` → التغيير يبقى في الذاكرة.

## Schema (في database.sqlite، تُنشأ عند تفعيل الـbridge)

```sql
pg_sync_queue (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  collection TEXT NOT NULL,
  row_key TEXT NOT NULL,
  op TEXT NOT NULL,
  payload TEXT,
  created_at INTEGER NOT NULL,
  attempts INTEGER DEFAULT 0,
  last_error TEXT
);
CREATE INDEX idx_pg_sync_queue_pending ON pg_sync_queue(seq);

pg_sync_dead_letter (
  original_seq INTEGER PRIMARY KEY,
  collection TEXT NOT NULL,
  row_key TEXT NOT NULL,
  op TEXT NOT NULL,
  payload TEXT,
  last_error TEXT,
  attempts INTEGER,
  moved_at INTEGER NOT NULL
);
```

## Worker (تفاصيل في TASK 7-G)

- PG advisory lock: `pg_try_advisory_lock(hashtext('pos_sync_worker_v1'))`.
- `LISTEN pos_sync_enqueue` + polling احتياطي كل 60s.
- batches متتالية حتى الطابور فارغ.
- 20 محاولة فاشلة → dead-letter + استمرار.
- target table مفقودة → رفض البدء + تقرير.
- DELETE idempotent (0 rows affected = نجاح).
- baseline: parity check عند البدء (COUNT لكل collection SQLite vs PG)، تسجيل فقط.

## ما ليس في TASK 7 (مؤجل)

- `business_catalog`.
- ZeroTier transport (TASK 8).
- Backpressure على القرص الممتلئ.
- Multi-worker coordination (advisory lock كافٍ حاليًا).

## الملفات (تطبيق مقسم على 3 مهام)

- 7-E: `shared/collection-map.js` + tests.
- 7-F: `sync-bridge.js` + hooks في `storage-adapter.js`.
- 7-G: `sync-worker.js` + LISTEN + tests.
