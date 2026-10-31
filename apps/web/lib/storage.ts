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
export const saveOriginal = (id: string, blob: Blob) => write('originals',id,blob);
export const getOriginal = (id: string) => read<Blob>('originals',id);
export const removeOriginal = (id: string) => write('originals',id);
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
