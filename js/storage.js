/*
 * Session persistence in IndexedDB: the canvas snapshot, every reference
 * image (as Blobs) with its placement and display settings, and app settings.
 * Everything is stored as one record so a restore is atomic.
 */
const DB_NAME = 'tracit';
const STORE = 'kv';
const KEY = 'session';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    const req = fn(store);
    t.oncomplete = () => { db.close(); resolve(req && req.result); };
    t.onerror = () => { db.close(); reject(t.error); };
  });
}

export function loadSession() {
  return tx('readonly', s => s.get(KEY)).catch(err => { console.warn('restore failed', err); return null; });
}

export function saveSession(session) {
  return tx('readwrite', s => s.put(session, KEY));
}

export function clearSession() {
  return tx('readwrite', s => s.delete(KEY));
}

/** Returns a function that saves at most every `ms` milliseconds. */
export function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}
