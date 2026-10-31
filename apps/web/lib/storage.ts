import { Catalog } from './catalog';
let pendingDb: Promise<IDBDatabase> | undefined;
function db(): Promise<IDBDatabase> {
  if (!pendingDb) pendingDb = new Promise((resolve,reject) => {
    const request = indexedDB.open('cloudnest-demo-v1',1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('catalog'); request.result.createObjectStore('originals');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { pendingDb = undefined; reject(new Error('Browser storage is unavailable.')); };
  });
  return pendingDb;
}
async function read<T>(store: string, key: string): Promise<T | undefined> {
  const database = await db();
  return new Promise((resolve,reject) => {
    const request = database.transaction(store,'readonly').objectStore(store).get(key);
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
}
async function write(store: string, key: string, value?: unknown): Promise<void> {
  const database = await db();
  return new Promise((resolve,reject) => {
    const tx = database.transaction(store,'readwrite');
    if (value === undefined) tx.objectStore(store).delete(key); else tx.objectStore(store).put(value,key);
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
  });
}
export const loadCatalog = () => read<Catalog>('catalog','current');
export const saveCatalog = (value: Catalog) => write('catalog','current',value);

export const MAX_CACHE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB limit
const TARGET_EVICTION_BYTES = 1.6 * 1024 * 1024 * 1024; // 1.6 GB headroom threshold

interface CacheMetaEntry {
  size: number;
  accessedAt: number;
}

const META_STORAGE_KEY = 'cloudnest_cache_meta_v1';

function getCacheMeta(): Record<string, CacheMetaEntry> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem(META_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveCacheMeta(meta: Record<string, CacheMetaEntry>): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(META_STORAGE_KEY, JSON.stringify(meta));
  } catch {
    // ignore quota error
  }
}

export async function enforceCacheLimit(): Promise<void> {
  const meta = getCacheMeta();
  let totalBytes = 0;
  for (const k in meta) {
    totalBytes += meta[k].size || 0;
  }

  if (totalBytes <= MAX_CACHE_BYTES) {
    return;
  }

  // Sort oldest first (LRU eviction)
  const entries = Object.entries(meta).sort((a, b) => (a[1].accessedAt || 0) - (b[1].accessedAt || 0));
  const database = await db();
  const tx = database.transaction('originals', 'readwrite');
  const store = tx.objectStore('originals');

  for (const [id, entry] of entries) {
    if (totalBytes <= TARGET_EVICTION_BYTES) break;
    try {
      store.delete(id);
      totalBytes -= entry.size || 0;
      delete meta[id];
    } catch {
      // ignore
    }
  }

  saveCacheMeta(meta);
}

export async function saveOriginal(id: string, blob: Blob): Promise<void> {
  await write('originals', id, blob);
  if (!id.startsWith('thumb-')) {
    const meta = getCacheMeta();
    meta[id] = { size: blob.size, accessedAt: Date.now() };
    saveCacheMeta(meta);
    void enforceCacheLimit();
  }
}

export async function getOriginal(id: string): Promise<Blob | undefined> {
  const result = await read<Blob>('originals', id);
  if (result && !id.startsWith('thumb-')) {
    const meta = getCacheMeta();
    if (meta[id]) {
      meta[id].accessedAt = Date.now();
      saveCacheMeta(meta);
    } else {
      meta[id] = { size: result.size, accessedAt: Date.now() };
      saveCacheMeta(meta);
    }
  }
  return result;
}

export async function removeOriginal(id: string): Promise<void> {
  await write('originals', id);
  const meta = getCacheMeta();
  if (meta[id]) {
    delete meta[id];
    saveCacheMeta(meta);
  }
}

export async function getCacheStats(): Promise<{ totalBytes: number; originalBytes: number; thumbBytes: number; count: number }> {
  try {
    const database = await db();
    return new Promise((resolve) => {
      const tx = database.transaction('originals', 'readonly');
      const store = tx.objectStore('originals');
      const request = store.openCursor();
      let totalBytes = 0;
      let originalBytes = 0;
      let thumbBytes = 0;
      let count = 0;

      request.onsuccess = (e) => {
        const cursor = (e.target as IDBRequest<IDBCursorWithValue>).result;
        if (cursor) {
          const key = String(cursor.key);
          const val = cursor.value;
          const bytes = val instanceof Blob ? val.size : (val && typeof val === 'object' && 'size' in val ? Number(val.size) : 0);
          totalBytes += bytes;
          count++;
          if (key.startsWith('thumb-')) {
            thumbBytes += bytes;
          } else {
            originalBytes += bytes;
          }
          cursor.continue();
        } else {
          resolve({ totalBytes, originalBytes, thumbBytes, count });
        }
      };
      request.onerror = () => resolve({ totalBytes: 0, originalBytes: 0, thumbBytes: 0, count: 0 });
    });
  } catch {
    return { totalBytes: 0, originalBytes: 0, thumbBytes: 0, count: 0 };
  }
}

export async function clearMediaCache(keepThumbnails = true): Promise<void> {
  const database = await db();
  return new Promise((resolve, reject) => {
    const tx = database.transaction('originals', 'readwrite');
    const store = tx.objectStore('originals');
    if (!keepThumbnails) {
      const req = store.clear();
      req.onsuccess = () => {
        saveCacheMeta({});
        resolve();
      };
      req.onerror = () => reject(req.error);
      return;
    }
    const request = store.openCursor();
    request.onsuccess = (e) => {
      const cursor = (e.target as IDBRequest<IDBCursorWithValue>).result;
      if (cursor) {
        const key = String(cursor.key);
        if (!key.startsWith('thumb-')) {
          cursor.delete();
        }
        cursor.continue();
      } else {
        saveCacheMeta({});
        resolve();
      }
    };
    request.onerror = () => reject(request.error);
  });
}
export async function commitCatalog(value: Catalog, originals?: {put?: {id: string; blob: Blob}; remove?: string[]}): Promise<void> {
  const database = await db();
  return new Promise((resolve,reject) => {
    const tx = database.transaction(['catalog','originals'],'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('Could not save browser data.'));
    tx.onabort = () => reject(tx.error || new Error('Saving was interrupted.'));
    try {
      if(originals?.put) tx.objectStore('originals').put(originals.put.blob,originals.put.id);
      for(const id of originals?.remove || []) tx.objectStore('originals').delete(id);
      tx.objectStore('catalog').put(value,'current');
    } catch(error) {
      try {tx.abort();} catch {}
      reject(error);
    }
  });
}
