/* db.js — IndexedDB persistence.
 *
 * Strategy: read the entire database into memory once at boot, then write
 * through on every mutation. Five years of heavy use is ~10k transactions
 * (≈2 MB), which fits in RAM with room to spare. The payoff is that every
 * render path is synchronous — no awaits between a tap and pixels moving.
 */

const NAME = 'fin';
const VERSION = 1;
export const STORES = ['accounts', 'txns', 'debts', 'goals', 'budgets', 'categories', 'recurring', 'meta'];

let db = null;

export function open() {
  if (db) return Promise.resolve(db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, VERSION);
    req.onupgradeneeded = (e) => {
      const d = e.target.result;
      for (const s of STORES) {
        if (d.objectStoreNames.contains(s)) continue;
        // `meta` is a key/value bag (settings); everything else is keyed by `id`.
        const store = d.createObjectStore(s, { keyPath: s === 'meta' ? 'k' : 'id' });
        if (s === 'txns') store.createIndex('date', 'date');
      }
    };
    req.onsuccess = () => { db = req.result; resolve(db); };
    req.onerror = () => reject(req.error);
  });
}

const tx = (stores, mode) => db.transaction(stores, mode);
const done = (t) => new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });

export function all(store) {
  return new Promise((res, rej) => {
    const r = tx([store], 'readonly').objectStore(store).getAll();
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

/** One round trip for the whole database. */
export async function loadAll() {
  await open();
  const out = {};
  await Promise.all(STORES.map(async (s) => { out[s] = await all(s); }));
  out.meta = Object.fromEntries(out.meta.map((r) => [r.k, r.v]));
  return out;
}

export async function put(store, obj) {
  await open();
  const t = tx([store], 'readwrite');
  t.objectStore(store).put(obj);
  await done(t);
  return obj;
}

export async function putMany(store, objs) {
  if (!objs.length) return;
  await open();
  const t = tx([store], 'readwrite');
  const os = t.objectStore(store);
  for (const o of objs) os.put(o);
  await done(t);
}

export async function del(store, id) {
  await open();
  const t = tx([store], 'readwrite');
  t.objectStore(store).delete(id);
  await done(t);
}

export async function delMany(store, ids) {
  if (!ids.length) return;
  await open();
  const t = tx([store], 'readwrite');
  const os = t.objectStore(store);
  for (const id of ids) os.delete(id);
  await done(t);
}

export const setMeta = (k, v) => put('meta', { k, v });

/** Replace the entire database in one atomic transaction.
 *  Used by restore-from-backup: either the whole import lands, or none of it
 *  does. A half-restored ledger would be worse than no restore at all. */
export async function replaceAll(data) {
  await open();
  const t = tx(STORES, 'readwrite');
  for (const s of STORES) {
    const os = t.objectStore(s);
    os.clear();
    if (s === 'meta') {
      for (const [k, v] of Object.entries(data.meta || {})) os.put({ k, v });
    } else {
      for (const o of data[s] || []) os.put(o);
    }
  }
  await done(t);
}

/** Rough on-disk footprint, for the Settings screen. */
export async function usage() {
  if (!navigator.storage?.estimate) return null;
  const { usage: u, quota } = await navigator.storage.estimate();
  return { used: u, quota };
}

/** Ask the browser not to evict this data under storage pressure.
 *  Without it, a browser cleaning up space can silently delete five years of
 *  records. Chrome grants it automatically for installed PWAs. */
export const persist = () => navigator.storage?.persist?.() ?? Promise.resolve(false);
export const isPersisted = () => navigator.storage?.persisted?.() ?? Promise.resolve(false);
