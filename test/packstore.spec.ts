/**
 * Routing-pack persistence.
 *
 * `fake-indexeddb` stands in for real IndexedDB exactly as `persist.spec.ts`
 * does; the "no IndexedDB at all" branch is exercised by removing the global.
 * The contract under test is the failure policy: storage problems degrade to
 * session-only packs and sentences, never to broken navigation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { IDBFactory } from 'fake-indexeddb';

import { savePack, loadPack, listPacks, deletePack } from '../src/regions/packstore';

const FIXTURE_PACK = join(__dirname, 'fixture.valhalla.tar');
const realIndexedDb = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');

function withDb(): void {
  Object.defineProperty(globalThis, 'indexedDB', {
    value: new IDBFactory(),
    configurable: true,
    writable: true,
  });
}

function withoutDb(): void {
  Object.defineProperty(globalThis, 'indexedDB', {
    value: undefined,
    configurable: true,
    writable: true,
  });
}

beforeEach(() => {
  withDb();
});

afterEach(() => {
  if (realIndexedDb) Object.defineProperty(globalThis, 'indexedDB', realIndexedDb);
  else delete (globalThis as { indexedDB?: unknown }).indexedDB;
});

const INFO = { bytes: 30720, tiles: 3 };

describe('packstore', () => {
  it('round-trips a pack byte for byte', async () => {
    const data = readFileSync(FIXTURE_PACK);
    const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    await savePack('local-fixture', buf, INFO);

    const loaded = await loadPack('local-fixture');
    expect(loaded).not.toBeNull();
    expect(loaded!.info).toEqual(INFO);
    expect(new Uint8Array(loaded!.data)).toEqual(new Uint8Array(buf));
  });

  it('lists ids and sizes without dragging bytes along', async () => {
    const buf = new Uint8Array(1024).buffer;
    await savePack('a', buf, { bytes: 1024, tiles: 1 });
    await savePack('b', buf, { bytes: 1024, tiles: 2 });
    const list = await listPacks();
    expect(list.map((p) => p.id).sort()).toEqual(['a', 'b']);
    expect(list.every((p) => p.info.tiles > 0)).toBe(true);
    expect(list[0]).not.toHaveProperty('data');
  });

  it('reports an unknown pack as absent rather than failing', async () => {
    expect(await loadPack('never-saved')).toBeNull();
  });

  it('replaces a pack on re-import', async () => {
    await savePack('a', new Uint8Array(4).buffer, { bytes: 4, tiles: 1 });
    await savePack('a', new Uint8Array(8).buffer, { bytes: 8, tiles: 2 });
    const loaded = await loadPack('a');
    expect(loaded!.info.tiles).toBe(2);
    expect(loaded!.data.byteLength).toBe(8);
  });

  it('deletes packs, and deleting an unknown one is not an error', async () => {
    await savePack('a', new Uint8Array(4).buffer, { bytes: 4, tiles: 1 });
    await deletePack('a');
    expect(await loadPack('a')).toBeNull();
    await expect(deletePack('ghost')).resolves.toBeUndefined();
  });

  it('degrades to session-only when the device has no IndexedDB', async () => {
    withoutDb();
    // Save refuses with a sentence a human can act on…
    const err = await savePack('a', new Uint8Array(4).buffer, { bytes: 4, tiles: 1 })
      .then(() => null, (e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toMatch(/session/i);
    // …and every read behaves as "nothing saved" rather than throwing.
    expect(await loadPack('a')).toBeNull();
    expect(await listPacks()).toEqual([]);
    await expect(deletePack('a')).resolves.toBeUndefined();
  });
});
