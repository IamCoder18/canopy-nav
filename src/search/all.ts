/**
 * Search across every region in the library.
 *
 * This used to live in `osm/regions.ts` as a second copy of the single-region
 * matcher, with the "123 main" branch missing: an address query worked with one
 * region loaded and silently degraded with two. It is now a thin loop over the
 * one matcher in `gaz.ts`, and it lives here rather than there so the search
 * engine loads on demand (with the rest of search) instead of with the region
 * library — the library is boot code; search is what happens when someone
 * types.
 *
 * Taking each region's top `limit` before the merge is exact, not an
 * approximation: a hit that does not make its own region's top `limit` cannot
 * make the global top `limit` either. The old version's "cap total work at
 * 6000 hits" existed only because every hit was scored on the full scan — the
 * index makes that cap unnecessary, and it was order-dependent anyway.
 */

import type { LatLng } from '../geo';
import { scoreGazetteer, type GazEntry } from './gaz';
import type { RegionLibrary } from '../osm/regions';

export interface RegionHit {
  regionId: string;
  regionName: string;
  score: number;
  entry: GazEntry;
}

export function searchAll(
  lib: RegionLibrary,
  q: string,
  near: LatLng,
  limit = 20,
): RegionHit[] {
  const hits: RegionHit[] = [];
  for (const region of lib.all) {
    for (const h of scoreGazetteer(region.dataset.gaz, q, near, limit)) {
      hits.push({
        regionId: region.id,
        regionName: region.name,
        score: h.score,
        entry: h.entry,
      });
    }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}
