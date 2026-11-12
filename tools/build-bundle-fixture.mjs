#!/usr/bin/env node
// Reproduce the checked-in cross-language bundle. Geometry/routing are the
// existing fixture grid; one explicitly tagged test address tests exact search.
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseOsmXml, encodeSorted } from './osm2pbf.mjs';
const temp = mkdtempSync('/tmp/opencode/canopy-bundle-fixture-');
try {
  const { nodes,ways } = parseOsmXml(readFileSync('test/fixture.osm','utf8'));
  // The search fixture also has isolated Canadian place nodes thousands of km
  // from the road grid. Keep this map fixture's bbox on its actual road grid.
  for (const [id,node] of nodes) if (node.lon < -2 || node.lon > 0) nodes.delete(id);
  // The old parser fixture deliberately repeats way ids. Real OSM ids are
  // unique; union extraction correctly deduplicates them. Normalise test ids
  // so its separate road geometries remain separate OSM elements.
  ways.forEach((way,index) => { way.id = 500000 + index; });
  nodes.set(900001,{ id: 900001,lon: -1.3904,lat: 51.506,tags: [['addr:housenumber','123'],['addr:street','Main Street'],['addr:city','Fixture City']] });
  ways[0].tags.push(['alt_name','Main Street']);
  const input = join(temp,'fixture.osm.pbf'); writeFileSync(input,await encodeSorted(nodes,ways));
  execFileSync('cargo',['run','--locked','--manifest-path','server/Cargo.toml','--example','fixture','--',input,resolve('test/packserver')],{ stdio: 'inherit' });
} finally { rmSync(temp,{recursive:true,force:true}); }
