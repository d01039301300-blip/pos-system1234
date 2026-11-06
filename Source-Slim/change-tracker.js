'use strict';

const objectToProxy = new WeakMap();
const proxyToObject = new WeakMap();
const rowProxyToRecord = new WeakMap();

function storageRowKey(row, index, duplicateIndex = 0) {
  if (row && typeof row === 'object' && Object.hasOwn(row, 'id') && row.id !== null) {
    return `id:${typeof row.id}:${JSON.stringify(row.id)}${duplicateIndex ? `#${duplicateIndex}` : ''}`;
  }
  return `idx:${index}${duplicateIndex ? `#${duplicateIndex}` : ''}`;
}

function unwrap(value) { return proxyToObject.get(value) || value; }

function createChangeTracker(data, { excludedCollections = ['business_catalog'] } = {}) {
  const excluded = new Set(excludedCollections);
  const collectionStates = new Map();
  const dirtyValues = new Set();
  const deletedValues = new Set();
  let proxyData;

  const stateFor = (name, raw = []) => {
    let state = collectionStates.get(name);
    if (!state) {
      state = { name, raw, proxy: null, records: [], dirty: new Map(), deleted: new Set(), orderChanged: false, replace: false, remove: false, original: new Set(), unstableKeys: false, nextOrdinalValue: 0 };
      collectionStates.set(name, state);
    }
    return state;
  };

  const markValue = name => { deletedValues.delete(name); dirtyValues.add(name); };

  const markRecord = record => {
    const state = record?.state;
    if (!state || state.replace) return;
    state.deleted.delete(record.key);
    state.dirty.set(record.key, record);
  };

  const deleteRecord = record => {
    if (!record) return;
    const state = record.state;
    state.dirty.delete(record.key);
    if (record.persisted || state.original.has(record.key)) state.deleted.add(record.key);
    else state.deleted.delete(record.key);
  };

  const makeRecord = (state, value, ordinal, { persisted = false, key = null, index = ordinal } = {}) => {
    const raw = unwrap(value);
    const record = { state, raw, key: key || storageRowKey(raw, index), ordinal, persisted, proxy: null };
    record.proxy = wrap(raw, { record });
    rowProxyToRecord.set(record.proxy, record);
    return record;
  };

  const rebuildRecords = (state, { persisted = false } = {}) => {
    state.records = [];
    const duplicates = new Map();
    state.unstableKeys = false;
    let maxOrdinal = -1;
    for (let index = 0; index < state.raw.length; index += 1) {
      const raw = unwrap(state.raw[index]);
      const base = storageRowKey(raw, index);
      const duplicate = duplicates.get(base) || 0;
      duplicates.set(base, duplicate + 1);
      if (base.startsWith('idx:') || duplicate > 0) state.unstableKeys = true;
      const key = storageRowKey(raw, index, duplicate);
      const record = makeRecord(state, raw, index, { persisted, key, index });
      state.records.push(record);
      maxOrdinal = Math.max(maxOrdinal, record.ordinal);
      state.raw[index] = record.proxy;
      if (persisted) state.original.add(key);
    }
    state.nextOrdinalValue = maxOrdinal + 1;
  };

  const replaceIfUnstable = state => {
    if (!state.unstableKeys) return;
    state.replace = true;
    state.dirty.clear();
    state.deleted.clear();
    rebuildRecords(state);
  };

  const recordForValue = (state, value) => {
    const trackedRecord = rowProxyToRecord.get(value);
    if (trackedRecord?.state === state) return trackedRecord;
    const raw = unwrap(value);
    return state.records.find(record => record.raw === raw) || null;
  };

  const renumber = state => {
    state.orderChanged = true;
    state.records.forEach((record, index) => { record.ordinal = index; });
    state.nextOrdinalValue = state.records.length;
  };

  const nextOrdinal = state => state.nextOrdinalValue++;
  const minOrdinal = state => state.records.reduce((min, record) => Math.min(min, record.ordinal), 0);

  function wrap(value, context = null) {
    if (!value || typeof value !== 'object') return value;
    const raw = unwrap(value);
    if (!Array.isArray(raw) && Object.getPrototypeOf(raw) !== Object.prototype && Object.getPrototypeOf(raw) !== null) return raw;
    const cacheKey = context?.record || context?.valueName || context?.collection || null;
    let byContext = objectToProxy.get(raw);
    if (!byContext) { byContext = new Map(); objectToProxy.set(raw, byContext); }
    if (byContext.has(cacheKey)) return byContext.get(cacheKey);

    if (Array.isArray(raw) && context?.collection) return wrapCollection(raw, context.collection);

    const proxy = new Proxy(raw, {
      get(target, property, receiver) {
        const result = Reflect.get(target, property, receiver);
        if (typeof result === 'function' || !result || typeof result !== 'object') return result;
        return wrap(result, context);
      },
      set(target, property, value) {
        const next = unwrap(value);
        const previous = target[property];
        if (Object.is(previous, next)) return true;
        Reflect.set(target, property, next, target);
        if (context?.record) {
          const record = context.record;
          if (property === 'id') {
            const oldKey = record.key;
            const newKey = storageRowKey(target, record.ordinal);
            if (oldKey !== newKey) {
              deleteRecord({ ...record, key: oldKey });
              record.key = newKey;
              if (record.persisted) record.state.deleted.add(oldKey);
            }
          }
          markRecord(context.record);
        } else if (context?.valueName) {
          markValue(context.valueName);
        }
        return true;
      },
      deleteProperty(target, property) {
        if (!Reflect.has(target, property)) return true;
        const success = Reflect.deleteProperty(target, property);
        if (success) {
          if (context?.record) markRecord(context.record);
          else if (context?.valueName) markValue(context.valueName);
        }
        return success;
      },
      defineProperty(target, property, descriptor) {
        const success = Reflect.defineProperty(target, property, descriptor);
        if (success) {
          if (context?.record) markRecord(context.record);
          else if (context?.valueName) markValue(context.valueName);
        }
        return success;
      }
    });
    byContext.set(cacheKey, proxy);
    proxyToObject.set(proxy, raw);
    return proxy;
  }

  function wrapCollection(raw, name) {
    const state = stateFor(name, raw);
    if (state.proxy) return state.proxy;
    rebuildRecords(state, { persisted: true });
    state.original = new Set(state.records.map(record => record.key));

    const proxy = new Proxy(raw, {
      get(target, property, receiver) {
        if (property === 'push') return (...items) => {
          const start = target.length;
          for (const item of items) {
            const record = makeRecord(state, item, nextOrdinal(state), { persisted: false, index: start + state.records.length - start });
            target.push(record.proxy);
            state.records.push(record);
            markRecord(record);
          }
          replaceIfUnstable(state);
          return target.length;
        };
        if (property === 'pop') return () => {
          if (!target.length) return undefined;
          const removed = target.pop();
          const record = state.records.pop();
          deleteRecord(record || recordForValue(state, removed));
          replaceIfUnstable(state);
          return removed;
        };
        if (property === 'unshift') return (...items) => {
          if (!items.length) return target.length;
          const before = minOrdinal(state) - items.length;
          const added = items.map((item, index) => makeRecord(state, item, before + index, { persisted: false, index: index }));
          target.unshift(...added.map(record => record.proxy));
          state.records.unshift(...added);
          for (const record of added) markRecord(record);
          replaceIfUnstable(state);
          return target.length;
        };
        if (property === 'shift') return () => {
          if (!target.length) return undefined;
          const removed = target.shift();
          const record = state.records.shift();
          deleteRecord(record || recordForValue(state, removed));
          replaceIfUnstable(state);
          return removed;
        };
        if (property === 'splice') return (...spliceArgs) => {
          const [startArg, deleteCountArg, ...items] = spliceArgs;
          const length = target.length;
          const start = startArg < 0 ? Math.max(length + Number(startArg), 0) : Math.min(Number(startArg) || 0, length);
          const deleteCount = spliceArgs.length < 2 ? length - start : Math.max(0, Math.min(Number(deleteCountArg) || 0, length - start));
          const removedRecords = state.records.splice(start, deleteCount);
          const removedValues = target.splice(start, deleteCount);
          for (const record of removedRecords) deleteRecord(record);
          if (items.length) {
            if (start === 0) {
              const before = minOrdinal(state) - items.length;
              const added = items.map((item, index) => makeRecord(state, item, before + index, { persisted: false, index }));
              target.splice(start, 0, ...added.map(record => record.proxy));
              state.records.splice(start, 0, ...added);
              for (const record of added) markRecord(record);
            } else if (start === state.records.length) {
              const before = nextOrdinal(state);
              const added = items.map((item, index) => makeRecord(state, item, before + index, { persisted: false, index: start + index }));
              state.nextOrdinalValue = Math.max(state.nextOrdinalValue, before + items.length);
              target.splice(start, 0, ...added.map(record => record.proxy));
              state.records.splice(start, 0, ...added);
              for (const record of added) markRecord(record);
            } else {
              const added = items.map((item, index) => makeRecord(state, item, start + index, { persisted: false, index: start + index }));
              target.splice(start, 0, ...added.map(record => record.proxy));
              state.records.splice(start, 0, ...added);
              renumber(state);
              for (const record of added) markRecord(record);
            }
          }
          replaceIfUnstable(state);
          return removedValues;
        };
        if (property === 'sort' || property === 'reverse') return (...args) => {
          Array.prototype[property].apply(target, args);
          state.records = target.map(value => recordForValue(state, value));
          if (state.records.some(record => !record)) {
            state.replace = true;
            rebuildRecords(state);
          }
          renumber(state);
          return receiver;
        };
        if (property === 'fill' || property === 'copyWithin') return (...args) => {
          Array.prototype[property].apply(target, args.map(unwrap));
          state.replace = true;
          rebuildRecords(state);
          return receiver;
        };
        const result = Reflect.get(target, property, receiver);
        if (typeof property === 'string' && /^\d+$/u.test(property)) return result;
        return result;
      },
      set(target, property, value) {
        if (property === 'length') {
          const newLength = Number(value);
          const oldLength = target.length;
          if (newLength < oldLength) {
            const removed = state.records.splice(newLength);
            target.length = newLength;
            for (const record of removed) deleteRecord(record);
            replaceIfUnstable(state);
            return true;
          }
          if (newLength > oldLength) {
            target.length = newLength;
            state.replace = true;
            rebuildRecords(state);
            return true;
          }
          return true;
        }
        if (typeof property === 'string' && /^\d+$/u.test(property)) {
          const index = Number(property);
          const next = unwrap(value);
          if (index > target.length) {
            target[index] = next;
            state.replace = true;
            rebuildRecords(state);
            return true;
          }
          if (index === target.length) {
            const record = makeRecord(state, next, nextOrdinal(state), { persisted: false, index });
            target[index] = record.proxy;
            state.records[index] = record;
            markRecord(record);
            return true;
          }
          const oldRecord = state.records[index];
          if (oldRecord?.raw === next) return true;
          const record = makeRecord(state, next, oldRecord?.ordinal ?? index, { persisted: false, index });
          if (oldRecord) deleteRecord(oldRecord);
          target[index] = record.proxy;
          state.records[index] = record;
          markRecord(record);
          return true;
        }
        return Reflect.set(target, property, unwrap(value), target);
      },
      deleteProperty(target, property) {
        if (typeof property === 'string' && /^\d+$/u.test(property)) {
          const index = Number(property);
          const record = state.records[index];
          if (record) deleteRecord(record);
          delete target[index];
          state.replace = true;
          return true;
        }
        return Reflect.deleteProperty(target, property);
      }
    });
    state.proxy = proxy;
    proxyToObject.set(proxy, raw);
    return proxy;
  }

  const topLevel = new Proxy(data, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof property !== 'string' || excluded.has(property) || !value || typeof value !== 'object') return value;
      if (Array.isArray(value)) return wrap(value, { collection: property });
      return wrap(value, { valueName: property });
    },
    set(target, property, value) {
      if (typeof property !== 'string' || excluded.has(property)) return Reflect.set(target, property, unwrap(value), target);
      const next = unwrap(value);
      const previous = target[property];
      if (Object.is(previous, next)) return true;
      Reflect.set(target, property, next, target);
      if (Array.isArray(next)) {
        const state = stateFor(property, next);
        state.raw = next;
        state.proxy = null;
        state.records = [];
        state.dirty.clear();
        state.deleted.clear();
        state.orderChanged = true;
        state.replace = true;
        state.remove = false;
        wrap(next, { collection: property });
      } else {
        collectionStates.delete(property);
        markValue(property);
      }
      return true;
    },
    deleteProperty(target, property) {
      if (!Reflect.has(target, property)) return true;
      const previous = target[property];
      const success = Reflect.deleteProperty(target, property);
      if (success && typeof property === 'string' && !excluded.has(property)) {
        if (Array.isArray(previous)) {
          const state = stateFor(property, []);
          state.replace = true;
          state.remove = true;
          state.records = [];
        } else {
          collectionStates.delete(property);
          dirtyValues.delete(property);
          deletedValues.add(property);
        }
      }
      return success;
    },
    defineProperty(target, property, descriptor) {
      const success = Reflect.defineProperty(target, property, descriptor);
      if (success && typeof property === 'string' && !excluded.has(property)) {
        if (Array.isArray(target[property])) {
          const state = stateFor(property, target[property]);
          state.replace = true;
          state.proxy = null;
          state.records = [];
        } else markValue(property);
      }
      return success;
    }
  });
  proxyToObject.set(proxyData = topLevel, data);

  // Materialize root collection proxies now so mutations are tracked before the
  // first save, while leaving JSON-visible properties and array semantics intact.
  for (const [name, value] of Object.entries(data)) if (Array.isArray(value) && !excluded.has(name)) wrap(value, { collection: name });

  function snapshotChanges() {
    const collections = [];
    for (const state of collectionStates.values()) {
      if (process.env.RAWDA_PROFILE === '1' && (state.replace || state.dirty.size || state.deleted.size || state.orderChanged)) console.error(`[PROFILE] tracker ${state.name} replace=${state.replace} dirty=${state.dirty.size} deleted=${state.deleted.size} ordered=${state.orderChanged} rows=${state.records.length}`);
      if (!state.replace && !state.dirty.size && !state.deleted.size && !state.orderChanged) continue;
      if (state.replace) {
        const rows = state.records.map((record, ordinal) => ({ key: record.key, ordinal, row: record.proxy }));
        collections.push({ name: state.name, replace: true, remove: state.remove, rows, deletes: [], ordinals: [] });
        continue;
      }
      const rows = [...state.dirty.values()].map(record => ({ key: record.key, ordinal: record.ordinal, row: record.proxy }));
      const ordinals = state.orderChanged ? state.records.map((record, ordinal) => ({ key: record.key, ordinal })) : [];
      collections.push({ name: state.name, replace: false, rows, deletes: [...state.deleted], ordinals });
    }
    const values = [];
    for (const name of dirtyValues) values.push({ name, value: data[name] });
    return { collections, values, deleteValues: [...deletedValues] };
  }

  function markSaved(changes = null) {
    const affected = changes?.collections ? new Set(changes.collections.map(collection => collection.name)) : new Set(collectionStates.keys());
    for (const name of affected) {
      const state = collectionStates.get(name);
      if (!state) continue;
      if (state.replace) {
        for (const record of state.records) record.persisted = true;
        state.original = new Set(state.records.map(record => record.key));
      } else {
        for (const key of state.deleted) state.original.delete(key);
        for (const record of state.dirty.values()) {
          record.persisted = true;
          state.original.add(record.key);
        }
      }
      state.dirty.clear();
      state.deleted.clear();
      state.replace = false;
      state.remove = false;
      state.orderChanged = false;
    }
    const valueNames = changes?.values ? new Set(changes.values.map(value => value.name)) : new Set(dirtyValues);
    for (const name of valueNames) dirtyValues.delete(name);
    for (const name of changes?.deleteValues || deletedValues) deletedValues.delete(name);
  }

  function markAllDirty() {
    for (const state of collectionStates.values()) {
      state.replace = true;
      state.orderChanged = true;
    }
    for (const key of Object.keys(data)) if (!Array.isArray(data[key]) && !excluded.has(key)) dirtyValues.add(key);
  }

  return { data: proxyData, snapshotChanges, markSaved, markAllDirty, unwrap };
}

module.exports = { createChangeTracker, storageRowKey };
