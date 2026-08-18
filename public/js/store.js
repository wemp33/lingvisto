// Local-first storage. Everything is written to IndexedDB immediately and
// pushed to the server afterwards, so the app works with no signal and the
// account is a sync mechanism rather than a login wall.
//
// Safari evicts IndexedDB for sites it considers unengaged, and an installed
// PWA is treated better but not guaranteed. That is why the server copy is a
// data-integrity requirement here, not a convenience: losing the review log
// would mean losing the only record of how the learner actually learns.

const DB_NAME = 'lingvisto';
const DB_VERSION = 1;

export const KINDS = ['word', 'card', 'page', 'log', 'pref', 'convo', 'song'];

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('records')) {
        const s = db.createObjectStore('records', { keyPath: 'key' });
        s.createIndex('kind', 'kind');
        s.createIndex('dirty', 'dirty');
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'k' });
      }
      if (!db.objectStoreNames.contains('blobs')) {
        db.createObjectStore('blobs', { keyPath: 'k' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

// Never interleave `await` between two requests on the same transaction: an
// IndexedDB transaction auto-commits as soon as the microtask queue drains with
// nothing pending, and Safari is the strictest about it. Every read-then-write
// below is therefore two separate transactions.
const reqP = (r) => new Promise((res, rej) => {
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});

const key = (kind, id) => `${kind}:${id}`;

export const uid = () =>
  (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

/* ---------- meta ---------- */

export async function getMeta(k, fallback = null) {
  const db = await openDb();
  const t = db.transaction('meta', 'readonly');
  const row = await reqP(t.objectStore('meta').get(k));
  return row ? row.v : fallback;
}

export async function setMeta(k, v) {
  const db = await openDb();
  const t = db.transaction('meta', 'readwrite');
  t.objectStore('meta').put({ k, v });
  return new Promise((res, rej) => {
    t.oncomplete = res;
    t.onerror = () => rej(t.error);
  });
}

/* ---------- records ---------- */

export async function put(kind, id, data, { dirty = true, updatedAt = Date.now() } = {}) {
  const rec = { key: key(kind, id), kind, id, updatedAt, deleted: false, data, dirty: dirty ? 1 : 0 };
  const db = await openDb();
  const t = db.transaction('records', 'readwrite');
  t.objectStore('records').put(rec);
  await new Promise((res, rej) => {
    t.oncomplete = res;
    t.onerror = () => rej(t.error);
  });
  notify(kind);
  return rec;
}

// Bulk write on one transaction — used by sync and by anything that touches a
// whole word's worth of cards at once.
export async function putMany(items, { dirty = true } = {}) {
  if (!items.length) return;
  const db = await openDb();
  const t = db.transaction('records', 'readwrite');
  const store = t.objectStore('records');
  const kinds = new Set();
  for (const it of items) {
    kinds.add(it.kind);
    store.put({
      key: key(it.kind, it.id),
      kind: it.kind,
      id: it.id,
      updatedAt: it.updatedAt ?? Date.now(),
      deleted: !!it.deleted,
      data: it.data,
      dirty: dirty ? 1 : 0,
    });
  }
  await new Promise((res, rej) => {
    t.oncomplete = res;
    t.onerror = () => rej(t.error);
  });
  kinds.forEach(notify);
}

export async function get(kind, id) {
  const db = await openDb();
  const t = db.transaction('records', 'readonly');
  const row = await reqP(t.objectStore('records').get(key(kind, id)));
  return row && !row.deleted ? row.data : null;
}

export async function all(kind) {
  const db = await openDb();
  const t = db.transaction('records', 'readonly');
  const rows = await reqP(t.objectStore('records').index('kind').getAll(kind));
  return rows.filter((r) => !r.deleted).map((r) => r.data);
}

// Tombstone rather than delete, so the other device learns about the removal.
export async function remove(kind, id) {
  const db = await openDb();
  const t = db.transaction('records', 'readwrite');
  t.objectStore('records').put({
    key: key(kind, id), kind, id, updatedAt: Date.now(), deleted: true, data: null, dirty: 1,
  });
  await new Promise((res, rej) => {
    t.oncomplete = res;
    t.onerror = () => rej(t.error);
  });
  notify(kind);
}

/* ---------- change notification ---------- */

const listeners = new Map();

export function onChange(kind, fn) {
  if (!listeners.has(kind)) listeners.set(kind, new Set());
  listeners.get(kind).add(fn);
  return () => listeners.get(kind).delete(fn);
}

function notify(kind) {
  listeners.get(kind)?.forEach((fn) => {
    try { fn(); } catch (e) { console.error(e); }
  });
  listeners.get('*')?.forEach((fn) => {
    try { fn(kind); } catch (e) { console.error(e); }
  });
}

/* ---------- large binaries ---------- */
// Whiteboard page thumbnails live outside the synced records: they are
// regenerable from the strokes and would otherwise dominate the sync payload.

export async function putBlob(k, blob) {
  const db = await openDb();
  const t = db.transaction('blobs', 'readwrite');
  t.objectStore('blobs').put({ k, blob });
  return new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
}

export async function getBlob(k) {
  const db = await openDb();
  const t = db.transaction('blobs', 'readonly');
  const row = await reqP(t.objectStore('blobs').get(k));
  return row ? row.blob : null;
}

/* ---------- sync ---------- */

async function dirtyRecords(limit = 400) {
  const db = await openDb();
  const t = db.transaction('records', 'readonly');
  const rows = await reqP(t.objectStore('records').index('dirty').getAll(1, limit));
  return rows;
}

async function clearDirty(keys, at) {
  if (!keys.length) return;
  const db = await openDb();

  // Read pass.
  const rt = db.transaction('records', 'readonly');
  const rstore = rt.objectStore('records');
  const rows = await Promise.all(keys.map((k) => reqP(rstore.get(k))));

  // Write pass. Only clear the flag where nothing has been written locally
  // since the push started, or an edit made mid-flight would be lost.
  const keep = rows.filter((row) => row && row.updatedAt <= at);
  if (!keep.length) return;
  const wt = db.transaction('records', 'readwrite');
  const wstore = wt.objectStore('records');
  for (const row of keep) wstore.put({ ...row, dirty: 0 });
  return new Promise((res, rej) => { wt.oncomplete = res; wt.onerror = () => rej(wt.error); });
}

let syncing = false;
let syncQueued = false;

// Returns { pushed, pulled } or null when there is no account / no network.
export async function sync(api, { force = false } = {}) {
  if (!api.hasSession()) return null;
  if (syncing) { syncQueued = true; return null; }
  syncing = true;
  try {
    let pushed = 0;
    let pulled = 0;

    // Push in batches until the local dirty set is empty.
    for (;;) {
      const rows = await dirtyRecords(400);
      if (!rows.length) break;
      const at = Date.now();
      const res = await api.push(rows.map((r) => ({
        kind: r.kind, id: r.id, updatedAt: r.updatedAt, deleted: r.deleted, data: r.data,
      })));
      if (!res) break;
      await clearDirty(rows.map((r) => r.key), at);
      pushed += rows.length;
      if (rows.length < 400) break;
    }

    // Pull everything the other device has written since our cursor.
    for (;;) {
      const cursor = await getMeta('cursor', 0);
      const res = await api.pull(cursor);
      if (!res) break;
      if (res.records.length) {
        // Server records win only where they are newer; a record edited locally
        // while offline must not be clobbered by a stale pull.
        const db = await openDb();
        const rt = db.transaction('records', 'readonly');
        const rstore = rt.objectStore('records');
        const locals = await Promise.all(
          res.records.map((r) => reqP(rstore.get(key(r.kind, r.id)))),
        );

        const winners = res.records.filter((r, i) => !(locals[i] && locals[i].updatedAt > r.updatedAt));
        if (winners.length) {
          const wt = db.transaction('records', 'readwrite');
          const wstore = wt.objectStore('records');
          const kinds = new Set();
          for (const r of winners) {
            kinds.add(r.kind);
            wstore.put({
              key: key(r.kind, r.id), kind: r.kind, id: r.id, updatedAt: r.updatedAt,
              deleted: r.deleted, data: r.data, dirty: 0,
            });
          }
          await new Promise((res2, rej) => { wt.oncomplete = res2; wt.onerror = () => rej(wt.error); });
          kinds.forEach(notify);
        }
        pulled += res.records.length;
      }
      await setMeta('cursor', res.cursor);
      if (!res.more) break;
    }

    await setMeta('lastSync', Date.now());
    return { pushed, pulled };
  } finally {
    syncing = false;
    if (syncQueued) {
      syncQueued = false;
      setTimeout(() => sync(api), 50);
    }
  }
}

// A fresh sign-in on a second device has to replay the whole account, so the
// cursor starts at zero and every local record is re-pushed.
export async function resetCursor() {
  await setMeta('cursor', 0);
}

export async function markAllDirty() {
  const db = await openDb();
  const rt = db.transaction('records', 'readonly');
  const rows = await reqP(rt.objectStore('records').getAll());
  if (!rows.length) return;
  const wt = db.transaction('records', 'readwrite');
  const store = wt.objectStore('records');
  for (const r of rows) store.put({ ...r, dirty: 1 });
  return new Promise((res, rej) => { wt.oncomplete = res; wt.onerror = () => rej(wt.error); });
}

export async function clearLocal() {
  const db = await openDb();
  const t = db.transaction(['records', 'meta', 'blobs'], 'readwrite');
  t.objectStore('records').clear();
  t.objectStore('meta').clear();
  t.objectStore('blobs').clear();
  await new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
  KINDS.forEach(notify);
}

/* ---------- export / import ---------- */

export async function exportAll() {
  const db = await openDb();
  const t = db.transaction('records', 'readonly');
  const rows = await reqP(t.objectStore('records').getAll());
  return {
    app: 'lingvisto',
    version: 1,
    exportedAt: new Date().toISOString(),
    records: rows.map(({ kind, id, updatedAt, deleted, data }) => ({ kind, id, updatedAt, deleted, data })),
  };
}

export async function importAll(payload) {
  if (!payload || payload.app !== 'lingvisto' || !Array.isArray(payload.records)) {
    throw new Error('not_a_lingvisto_backup');
  }
  const items = payload.records.filter((r) => KINDS.includes(r.kind) && r.id);
  await putMany(items, { dirty: true });
  return items.length;
}
