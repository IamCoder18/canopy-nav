/**
 * Routing-pack import (`regions/store.ts`).
 *
 * The store-level contract: a file that is not a pack says so and changes
 * nothing; a pack attaches to the region its name matches, mounts into the
 * offline Valhalla engine, and survives (or honestly fails to survive)
 * persistence. The engine itself is stubbed — `test/valhalla-local.spec.ts`
 * covers the real one — so these tests are about the plumbing around it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { IDBFactory } from 'fake-indexeddb';

import {
  importPackFile,
  packRegionId,
  packRegionName,
  regionLib,
  removeRegion,
} from '../src/regions/store';
import { setLocalValhalla, type LocalValhallaClient } from '../src/nav/valhalla-local';
import { parseOsmXml, buildDataset } from '../src/osm/engine.worker';
import type { RegionMeta } from '../src/osm/regions';

const FIXTURE_PACK = join(__dirname, 'fixture.valhalla.tar');
const realIndexedDb = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');

function fileOf(name: string, bytes: Uint8Array): File {
  return new File([bytes], name);
}

function fixturePackFile(name = 'fixture.valhalla.tar'): File {
  return fileOf(name, new Uint8Array(readFileSync(FIXTURE_PACK)));
}

/** A stub engine that records what the store asked of it. */
function stubEngine(calls: string[]): LocalValhallaClient {
  return {
    ready: () => calls.includes('mount'),
    regions: () => (calls.includes('mount') ? ['local-fixture'] : []),
    mount: async (region: string) => { calls.push(`mount:${region}`); },
    unmount: (region: string) => { calls.push(`unmount:${region}`); },
    route: async () => { throw new Error('stub'); },
    dispose: () => { calls.push('dispose'); },
  };
}

function addFixtureRegion(): void {
  const { nodes, ways } = parseOsmXml(`<osm>
    <node id="1" lat="0" lon="0"/>
    <node id="2" lat="0" lon="0.005"/>
    <way id="10"><nd ref="1"/><nd ref="2"/><tag k="highway" v="residential"/><tag k="name" v="Main"/></way>
  </osm>`);
  const dataset = buildDataset(nodes, ways, () => {});
  const meta: RegionMeta = {
    id: 'local-fixture',
    name: 'Fixture',
    code: 'local',
    bbox: dataset.bbox,
    loadedAt: Date.now(),
    bytes: 1000,
    counts: dataset.counts,
    gazetteerSize: dataset.gaz.length,
  };
  regionLib.add(meta, dataset);
}

let calls: string[];

beforeEach(() => {
  calls = [];
  setLocalValhalla(stubEngine(calls));
  Object.defineProperty(globalThis, 'indexedDB', {
    value: new IDBFactory(),
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  setLocalValhalla(null);
  for (const id of regionLib.ids) regionLib.remove(id);
  regionLib.setPack('local-fixture', null);
  if (realIndexedDb) Object.defineProperty(globalThis, 'indexedDB', realIndexedDb);
  else delete (globalThis as { indexedDB?: unknown }).indexedDB;
});

describe('pack naming', () => {
  it('ties a pack to the region its name matches', () => {
    expect(packRegionId(fixturePackFile())).toBe('local-fixture');
    expect(packRegionId(fileOf('British-Columbia.valhalla.tar', new Uint8Array(0)))).toBe('local-british-columbia');
    expect(packRegionId(fileOf('weird.tar', new Uint8Array(0)))).toBe('local-weird');
  });

  it('names the region for humans', () => {
    expect(packRegionName(fixturePackFile())).toBe('Fixture');
    expect(packRegionName(fileOf('british-columbia.valhalla.tar', new Uint8Array(0)))).toBe('British Columbia');
  });
});

describe('importPackFile', () => {
  it('imports a pack: validates, mounts, and records it on its region', async () => {
    addFixtureRegion();
    const info = await importPackFile({ file: fixturePackFile() });
    expect(info).toEqual({ bytes: 30720, tiles: 3 });
    expect(calls).toEqual(['mount:local-fixture']);
    expect(regionLib.packFor('local-fixture')).toEqual({ bytes: 30720, tiles: 3 });
    expect(regionLib.get('local-fixture')?.pack).toEqual({ bytes: 30720, tiles: 3 });
  });

  it('records a pack for a region that is not imported yet', async () => {
    const info = await importPackFile({ file: fixturePackFile('late-arriving.valhalla.tar') });
    expect(info).not.toBeNull();
    expect(regionLib.packFor('local-late-arriving')).toEqual({ bytes: 30720, tiles: 3 });
  });

  it('refuses a tar with no tiles and changes nothing', async () => {
    const notAPack = fileOf('holiday-photos.tar', new Uint8Array(2048));
    const errors: (string | null)[] = [];
    const info = await importPackFile({ file: notAPack, onError: (m) => errors.push(m) });
    expect(info).toBeNull();
    // The last word is the failure; the first is the deliberate `onError(null)`
    // reset that clears whatever the previous import said.
    const message = errors.at(-1) ?? '';
    expect(message).toMatch(/not a routing pack/i);
    expect(message).toMatch(/Nothing was changed/i);
    expect(calls).toEqual([]);
    expect(regionLib.packFor('local-holiday-photos')).toBeNull();
  });

  it('refuses a file that is not even an archive', async () => {
    const junk = fileOf('notes.txt', new TextEncoder().encode('hello world, definitely not a tar'));
    const errors: (string | null)[] = [];
    const info = await importPackFile({ file: junk, onError: (m) => errors.push(m) });
    expect(info).toBeNull();
    expect(errors.at(-1) ?? '').toMatch(/not a routing pack/i);
  });

  it('imports anyway when persistence fails, and says what was lost', async () => {
    Object.defineProperty(globalThis, 'indexedDB', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    const persistProblems: (string | null)[] = [];
    const info = await importPackFile({
      file: fixturePackFile(),
      onPersistError: (m) => persistProblems.push(m),
    });
    // The pack works this session: mounted, recorded, returned.
    expect(info).toEqual({ bytes: 30720, tiles: 3 });
    expect(calls).toEqual(['mount:local-fixture']);
    expect(persistProblems[0]).toBeTruthy();
  });
});

describe('removeRegion', () => {
  it('takes the region\'s pack with it — unmounted and deleted', async () => {
    addFixtureRegion();
    await importPackFile({ file: fixturePackFile() });
    calls.length = 0;

    const problem = await removeRegion('local-fixture');
    expect(problem).toBeNull();
    expect(calls).toContain('unmount:local-fixture');
    expect(regionLib.get('local-fixture')).toBeUndefined();
    expect(regionLib.packFor('local-fixture')).toBeNull();
  });
});
