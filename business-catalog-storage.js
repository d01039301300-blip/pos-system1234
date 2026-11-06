'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function catalogContentHash(rows) {
  return crypto.createHash('sha256').update(JSON.stringify(rows), 'utf8').digest('hex');
}

function writeAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, typeof value === 'string' ? value : JSON.stringify(value), { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(temporary, filePath);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch (_) {}
    throw error;
  }
}

function createBusinessCatalogStorage({ databaseFile, catalogFile, logger = console, atomicWrite = writeAtomic } = {}) {
  let mainFile = path.resolve(databaseFile);
  let filePath = path.resolve(catalogFile || path.join(path.dirname(mainFile), 'business-catalog.json'));
  let rows = [];
  let loadError = '';
  let contentHash = catalogContentHash(rows);
  let automaticSnapshotDir = path.join(path.dirname(mainFile), 'backups');

  function makeEnvelope(items) {
    return { format: 'system-business-catalog-storage', version: 1, item_count: items.length, content_sha256: catalogContentHash(items), items };
  }

  function readValidCatalog(candidate = filePath) {
    const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'));
    if (!parsed || parsed.format !== 'system-business-catalog-storage' || parsed.version !== 1 || !Array.isArray(parsed.items)
      || parsed.item_count !== parsed.items.length || parsed.content_sha256 !== catalogContentHash(parsed.items)) {
      throw new Error('بصمة أو عدد صفوف ملف الكتالوج المستقل غير مطابق.');
    }
    return parsed.items;
  }

  function writeAndVerify(items, destination = filePath) {
    const envelope = makeEnvelope(items);
    atomicWrite(destination, envelope);
    const verified = readValidCatalog(destination);
    if (verified.length !== items.length || catalogContentHash(verified) !== catalogContentHash(items)) {
      throw new Error('فشل التحقق من عدد أو بصمة محتوى الكتالوج المستقل بعد الكتابة.');
    }
  }

  function ensureAutomaticSnapshotArtifact() {
    if (loadError) return null;
    const snapshotDir = path.join(automaticSnapshotDir, 'catalog-snapshots');
    const snapshotName = `business-catalog-${contentHash}.json`;
    const snapshotPath = path.join(snapshotDir, snapshotName);
    fs.mkdirSync(snapshotDir, { recursive: true });
    if (!fs.existsSync(snapshotPath)) {
      try { fs.linkSync(filePath, snapshotPath); }
      catch (_) { fs.copyFileSync(filePath, snapshotPath); }
      readValidCatalog(snapshotPath);
    }
    return `catalog-snapshots/${snapshotName}`;
  }

  function readSnapshotReference(reference, scheduledBackupDirectory = automaticSnapshotDir) {
    const normalized = String(reference || '').replace(/\\/g, '/');
    const contentAddressed = /^catalog-snapshots\/business-catalog-[a-f0-9]{64}\.json$/u.test(normalized);
    const scheduledCompanion = /^(?:scheduled-(?:daily|close)-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.json\.catalog\.json|safety\/safety-before-restore-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-\d+-[a-f0-9]+\.json\.catalog\.json)$/u.test(normalized);
    if (!contentAddressed && !scheduledCompanion) throw new Error('مرجع ملف الكتالوج في النسخة التلقائية غير صالح.');
    const root = contentAddressed ? automaticSnapshotDir : path.resolve(scheduledBackupDirectory);
    const candidate = path.resolve(root, ...normalized.split('/'));
    if (!candidate.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error('مسار ملف الكتالوج في النسخة خارج مجلد النسخ.');
    return readValidCatalog(candidate);
  }

  function getContentAddressedSnapshotPath(reference) {
    const normalized = String(reference || '').replace(/\\/g, '/');
    if (!/^catalog-snapshots\/business-catalog-[a-f0-9]{64}\.json$/u.test(normalized)) throw new Error('مرجع ملف الكتالوج في النسخة التلقائية غير صالح.');
    return path.resolve(automaticSnapshotDir, ...normalized.split('/'));
  }

  function initialize({ data, saveMainData }) {
    if (!data || typeof data !== 'object' || typeof saveMainData !== 'function') throw new TypeError('catalog initialization requires data and saveMainData');
    loadError = '';
    const hasLegacy = Object.prototype.hasOwnProperty.call(data, 'business_catalog');
    if (hasLegacy) {
      const legacyRows = Array.isArray(data.business_catalog) ? data.business_catalog : [];
      const legacyHash = catalogContentHash(legacyRows);
      const original = fs.readFileSync(mainFile);
      const backupPath = `${mainFile}.pre-business-catalog-${crypto.createHash('sha256').update(original).digest('hex')}.bak`;
      if (!fs.existsSync(backupPath)) writeAtomic(backupPath, original.toString('utf8'));
      if (fs.existsSync(filePath)) {
        const existing = readValidCatalog();
        if (existing.length !== legacyRows.length || catalogContentHash(existing) !== legacyHash) {
          throw new Error('فشل ترحيل الكتالوج المستقل: الملف الجديد لا يطابق الكتالوج داخل قاعدة البيانات؛ تم الحفاظ على البيانات القديمة.');
        }
        rows = existing;
        contentHash = legacyHash;
      } else {
        writeAndVerify(legacyRows);
        rows = legacyRows;
        contentHash = legacyHash;
      }
      delete data.business_catalog;
      data.business_catalog_storage_version = 1;
      try { saveMainData(); }
      catch (error) {
        data.business_catalog = legacyRows;
        delete data.business_catalog_storage_version;
        throw error;
      }
      ensureAutomaticSnapshotArtifact();
      return rows;
    }

    if (data.business_catalog_storage_version === 1) {
      if (!fs.existsSync(filePath)) {
        loadError = `ملف الكتالوج المستقل مفقود: ${filePath}. تم تشغيل النظام بكتالوج فارغ.`;
        logger.error?.(loadError);
        rows = [];
        return rows;
      }
      try { rows = readValidCatalog(); }
      catch (error) {
        loadError = `تعذر تحميل الكتالوج المستقل من ${filePath}: ${error.message}. تم تشغيل النظام بكتالوج فارغ.`;
        logger.error?.(loadError);
        rows = [];
      }
      contentHash = catalogContentHash(rows);
      if (!loadError) ensureAutomaticSnapshotArtifact();
      return rows;
    }

    rows = [];
    if (!fs.existsSync(filePath)) writeAndVerify(rows);
    contentHash = catalogContentHash(rows);
    data.business_catalog_storage_version = 1;
    saveMainData();
    ensureAutomaticSnapshotArtifact();
    return rows;
  }

  function initializeFast({ data }) {
    if (!data || typeof data !== 'object') throw new TypeError('catalog fast initialization requires data');
    loadError = '';
    if (!fs.existsSync(filePath)) {
      rows = [];
      contentHash = catalogContentHash(rows);
      return rows;
    }
    try {
      rows = readValidCatalog();
      contentHash = catalogContentHash(rows);
      return rows;
    } catch (error) {
      loadError = `تعذر تحميل الكتالوج المستقل من ${filePath}: ${error.message}. تم تشغيل النظام بكتالوج فارغ.`;
      logger.error?.(loadError);
      rows = [];
      contentHash = catalogContentHash(rows);
      return rows;
    }
  }

  function setRows(nextRows) {
    if (!Array.isArray(nextRows)) throw new TypeError('business catalog rows must be an array');
    const oldRows = rows;
    const oldHash = contentHash;
    writeAndVerify(nextRows);
    rows = nextRows;
    contentHash = catalogContentHash(rows);
    try { ensureAutomaticSnapshotArtifact(); }
    catch (error) {
      try { writeAndVerify(oldRows); } catch (rollbackError) { logger.error?.(`Catalog persistence rollback failed: ${rollbackError.message}`); }
      rows = oldRows;
      contentHash = oldHash;
      throw error;
    }
    return rows;
  }

  function setDatabaseFile(newDatabasePath) {
    const nextMainFile = path.resolve(newDatabasePath);
    const nextFilePath = path.join(path.dirname(nextMainFile), 'business-catalog.json');
    if (path.resolve(nextFilePath) !== path.resolve(filePath) && fs.existsSync(nextFilePath)) {
      const targetRows = readValidCatalog(nextFilePath);
      if (catalogContentHash(targetRows) !== catalogContentHash(rows)) throw new Error('يوجد ملف كتالوج مختلف في المجلد المحدد؛ لم يتم تغيير مسار قاعدة البيانات.');
    } else if (path.resolve(nextFilePath) !== path.resolve(filePath)) {
      writeAndVerify(rows, nextFilePath);
    }
    filePath = nextFilePath;
    mainFile = nextMainFile;
    automaticSnapshotDir = path.join(path.dirname(nextMainFile), 'backups');
    ensureAutomaticSnapshotArtifact();
    return filePath;
  }

  function getSnapshot(data) {
    const snapshot = JSON.parse(JSON.stringify(data));
    delete snapshot.business_catalog_storage_version;
    const result = {};
    let inserted = false;
    for (const [key, value] of Object.entries(snapshot)) {
      if (key === 'branches' && !inserted) {
        result.business_catalog = rows;
        inserted = true;
      }
      result[key] = value;
    }
    if (!inserted) result.business_catalog = rows;
    return result;
  }

  function replaceFromSnapshot(nextRows, saveMainData, data) {
    const previousRows = rows;
    const previousMain = JSON.stringify(data);
    try {
      setRows(nextRows);
      delete data.business_catalog;
      data.business_catalog_storage_version = 1;
      saveMainData();
    } catch (error) {
      try { setRows(previousRows); } catch (rollbackError) { logger.error?.(`Catalog rollback failed: ${rollbackError.message}`); }
      try { atomicWrite(mainFile, previousMain); } catch (rollbackError) { logger.error?.(`Database rollback failed: ${rollbackError.message}`); }
      throw error;
    }
  }

  function getAutomaticSnapshotReference() {
    return ensureAutomaticSnapshotArtifact();
  }

  return {
    initialize, initializeFast, getFilePath: () => filePath, getRows: () => rows, setRows, getLoadError: () => loadError,
    setDatabaseFile, getSnapshot, replaceFromSnapshot, getAutomaticSnapshotReference, readSnapshotReference, getContentAddressedSnapshotPath, catalogContentHash
  };
}

module.exports = { createBusinessCatalogStorage, catalogContentHash };
