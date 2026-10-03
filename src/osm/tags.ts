/**
 * Node tag filter, shared by every OSM parser.
 *
 * A province extract has tens of millions of nodes and almost none of them
 * carry a name. Keeping only placemark-ish tags on nodes bounds memory, and —
 * more importantly — the XML and PBF parsers must agree exactly, or a node
 * indexed by one path would be silently missing from the other's gazetteer.
 *
 * Way tags are never filtered: the road graph needs every tag on a way.
 */

/** Tags worth retaining on a node. */
export function isInterestingTag(k: string): boolean {
  return (
    k === 'name' ||
    k === 'place' ||
    k === 'amenity' ||
    k === 'shop' ||
    k === 'tourism' ||
    k === 'leisure' ||
    k === 'highway' ||
    k === 'railway' ||
    k === 'landuse' ||
    k === 'natural' ||
    k === 'waterway' ||
    k === 'building' ||
    k === 'office' ||
    k === 'craft' ||
    k === 'healthcare' ||
    k === 'aeroway' ||
    k === 'historic' ||
    k === 'man_made' ||
    k === 'addr:housenumber' ||
    k === 'addr:street'
  );
}
