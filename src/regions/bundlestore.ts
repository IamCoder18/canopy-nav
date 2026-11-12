import type { BundleManifest } from './bundle';
export interface BundleRecord { id: string; manifest: BundleManifest; }
function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('canopy-bundles', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('regions', { keyPath: 'id' });
    r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
  });
}
export async function bundleRecords(): Promise<BundleRecord[]> {
  const d = await db();
  try { return await new Promise((resolve, reject) => { const r = d.transaction('regions').objectStore('regions').getAll(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); }
  finally { d.close(); }
}
export async function writeBundleRecord(record: BundleRecord | null, id: string): Promise<void> {
  const d = await db();
  try { await new Promise<void>((resolve, reject) => {
    const tx = d.transaction('regions', 'readwrite');
    if (record) tx.objectStore('regions').put(record); else tx.objectStore('regions').delete(id);
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
  }); } finally { d.close(); }
}
