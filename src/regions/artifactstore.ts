/** Uncompressed random-access artifacts. OPFS on web, app-private files on
 * Android. The native bridge reads *ranges*, never base64-encodes a province. */
import { Capacitor, registerPlugin } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
const ranges = registerPlugin<{ readRange(o: { path: string; offset: number; length: number }): Promise<{ data: string }> }>('PackFiles');
const native = () => Capacitor.isNativePlatform();
function path(id: string, name: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(id) || !/^[a-zA-Z0-9_.-]+$/.test(name) || name.startsWith('.')) throw new Error('Invalid artifact path');
  return `canopy-bundles/${id}/${name}`;
}
async function dir(id: string, create = false): Promise<FileSystemDirectoryHandle> {
  path(id, 'check');
  const root = await navigator.storage.getDirectory();
  return (await root.getDirectoryHandle('canopy-bundles', { create })).getDirectoryHandle(id, { create });
}
function decode(s: string): Uint8Array { return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); }
function encode(b: Uint8Array): string {
  let s = ''; for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192));
  return btoa(s);
}
export async function putArtifact(id: string, name: string, blob: Blob): Promise<void> {
  const p = path(id, name);
  if (native()) {
    await Filesystem.writeFile({ path: p, directory: Directory.Data, data: '', recursive: true });
    for (let offset = 0; offset < blob.size; offset += 1024 * 1024) {
      await Filesystem.appendFile({ path: p, directory: Directory.Data, data: encode(new Uint8Array(await blob.slice(offset, offset + 1024 * 1024).arrayBuffer())) });
    }
  } else {
    const handle = await (await dir(id, true)).getFileHandle(name, { create: true });
    const writer = await handle.createWritable();
    try { await writer.write(blob); await writer.close(); } catch (e) { await writer.abort(); throw e; }
  }
}
export async function readRange(id: string, name: string, offset: number, length: number): Promise<ArrayBuffer> {
  const p = path(id, name);
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0) throw new Error('Invalid artifact range');
  if (native()) return decode((await ranges.readRange({ path: p, offset, length })).data).buffer as ArrayBuffer;
  const file = await (await (await dir(id)).getFileHandle(name)).getFile();
  return file.slice(offset, offset + length).arrayBuffer();
}
export async function getArtifact(id: string, name: string): Promise<Blob> {
  if (!native()) return (await (await dir(id)).getFileHandle(name)).getFile();
  const stat = await Filesystem.stat({ path: path(id, name), directory: Directory.Data });
  const chunks: ArrayBuffer[] = [];
  for (let o = 0; o < stat.size; o += 1024 * 1024) chunks.push(await readRange(id, name, o, Math.min(1024 * 1024, stat.size - o)));
  return new Blob(chunks);
}
export async function deleteArtifacts(id: string): Promise<void> {
  path(id, 'check');
  if (native()) await Filesystem.rmdir({ path: `canopy-bundles/${id}`, directory: Directory.Data, recursive: true });
  else {
    const root = await navigator.storage.getDirectory();
    try { await (await root.getDirectoryHandle('canopy-bundles')).removeEntry(id, { recursive: true }); }
    catch (e) { if (!(e instanceof DOMException && e.name === 'NotFoundError')) throw e; }
  }
}
