/** Tiny IndexedDB key-value store with a localStorage fallback. */
const DB = 'feltcircle';
const STORE = 'kv';

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

let dbp: Promise<IDBDatabase | null> | null = null;
const db = () => (dbp ??= openDb());

export async function kvGet<T>(key: string): Promise<T | null> {
  const d = await db();
  if (!d) {
    const v = localStorage.getItem(`fc.kv.${key}`);
    return v ? (JSON.parse(v) as T) : null;
  }
  return new Promise((resolve) => {
    const req = d.transaction(STORE, 'readonly').objectStore(STORE).get(key);
    req.onsuccess = () => resolve((req.result as T) ?? null);
    req.onerror = () => resolve(null);
  });
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  const d = await db();
  if (!d) {
    localStorage.setItem(`fc.kv.${key}`, JSON.stringify(value));
    return;
  }
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function kvDel(key: string): Promise<void> {
  const d = await db();
  if (!d) {
    localStorage.removeItem(`fc.kv.${key}`);
    return;
  }
  return new Promise((resolve) => {
    const tx = d.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

export function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function lsSet(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* private mode */
  }
}
