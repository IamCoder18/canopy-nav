# The packserver program — replacing `.osm.pbf` ingestion with service-built files

**Status:** stages 1–3 implemented; verification and remaining deployment/device
measurements are recorded in `STATUS.md` §19. **Date:** 2026-11-12.
Deployment uses direct public IPv6 through Caddy, **not Cloudflare Tunnels**;
the app requires a configured server address and API key. See `server/README.md`.
**Scope:** three stages — (1) app changes with no service dependency, (2) the
build service, (3) app changes that consume the service. Staging order follows
the work's dependencies, not its narrative: stage 1 ships alone and de-risks
the UX; stage 2 needs nothing from the app; stage 3 is the only stage that can
start once the service exists.

This document consolidates and supersedes the design discussion covering the
upload service, the routing-engine endgame, the map tile path, and the
Photon-style search contract. It cites `research/valhalla-local-feasibility.md`
as "the feasibility study" and `STATUS.md` by section.

---

## 0. The one-paragraph version

Today the app downloads raw `.osm.pbf` extracts and derives everything on the
phone: a routing graph (96 B/node + 24 B/edge resident), a gazetteer, and
render geometry — a parse so heavy that provinces are refused outright
(STATUS §7 gap 13). We replace that with a self-hosted **build service**: you
upload one or more `.osm.pbf` files and get back a `.tar.gz` of three
lightweight artifacts — a **Valhalla routing pack** (lazy-read tiles instead of
a resident graph), a **full-resolution search gazetteer** (Photon-style
entries: real data only, admin context, importance, name variants), and
**MVT map tiles in a PMTiles archive** (viewport-streamed instead of a
whole-dataset GeoJSON basemap). Routing becomes Valhalla-in-WASM for
everything the service produces; the TypeScript A\* survives only for legacy
raw imports, labelled as such. The map keeps MapLibre (JS) but consumes
lightweight tile *data*, with MapLibre Native remaining an open door.

---

## 1. Where the app is today, and what hurts

| Concern | Today | Cost / failure |
|---|---|---|
| Ingestion | parse `.osm`/`.osm.pbf` in `src/osm/engine.worker.ts` → one `OsmDataset` (graph + gaz + render geometry) | 229 B/kept-node parse peak (`src/osm/importguard.ts:113`); provinces refused on every device; the refusal sends drivers to a desktop `osmium` they may not have (§7 gap 13) |
| Routing | TS unidirectional A\* (`routeOnGraph`, `engine.worker.ts:1006–1116`) as fallback; Valhalla WASM from routing packs (`src/nav/valhalla-local/`) as default since v1.2.0 | A\* has a 1,200,000-expansion cap, no hierarchy, and inferred (wrong) maneuvers — 3 of 7 missed (§7 gap 6); cross-region routing is a 7.5× merge blowup guarded by `src/osm/mergeguard.ts` |
| Search | `src/search/gaz.ts` — one matcher/ranking over `GazEntry[]` built at import | Gazetteer carries synthetic house-number samples every ~150 m (largest entry category, fictional numbering, counter restarts per way fragment), per-way street duplicates, a 120k cap that sheds real entries on city-scale data, no admin context, no importance, no name variants |
| Map | MapLibre GL (283 kB gz vendor chunk). Online: OpenFreeMap MVT. Offline: GeoJSON built in JS from the in-memory dataset | Offline basemap doesn't scale past small extracts (every road is a GeoJSON feature re-serialised per zoom), and the whole dataset must be resident to draw any of it |
| Supply chain | `tools/build-pack.mjs` builds routing packs on a dev machine; `download.ts` fetches `.osm.pbf` from Geofabrik | "The supply chain is a tool, not a service" (STATUS §17.6). No packs are published; nothing produces search or map artifacts |

The service attacks the root: **the phone never parses OSM again** for
service-derived regions. The parse — and with it the 229 B/node peak, the
import guard, and the merge guard — exists only for legacy raw imports.

---

## 2. Decisions (locked), with the roads not taken

| # | Decision | Rationale | Rejected alternative |
|---|---|---|---|
| D1 | Service in **Rust**, self-hosted, **Docker**-containerised | In-language PBF decode + geometry work benefits from `osmpbf`/rayon and GC-free memory; concurrent stateless builds multiply per-process savings (Go comparison discussed and closed) | Go orchestrator (faster glue, weaker hot paths) |
| D2 | **Stateless** service; one request may carry **multiple** `.osm.pbf` files, built as a union | No cross-upload state to manage; multi-file upload gives union builds (`valhalla_build_tiles a.pbf b.pbf` is native) | Stateful projects with canonical continental builds (correct cross-region by construction, but heavier ops) — revisit if cross-build border tiles bite (§7) |
| D3 | Auth via **API keys**; **all admin actions CLI-only** | No HTTP surface can mint or manage keys; the HTTP API only verifies and builds | Admin REST endpoints (rejected outright) |
| D4 | Upload body is **never read before auth passes** | Bandwidth is the resource under attack: headers-first 401, `Expect: 100-continue` honoured, `413` from `Content-Length`, stream cap with abort, per-key rate limits | — |
| D5 | Bundle returned as one **deterministic `.tar.gz`**; consumers **unpack once at ingest** | Universal transport shape, reproducible bytes; gzip is not seekable, so the artifacts — especially the routing tar's lazy tile reads — must live unpacked at rest | Per-artifact downloads only (kept *as well*); keeping the bundle compressed at rest (rejected: kills random access) |
| D6 | Search = **Photon's UX**: type-ahead, typo tolerance, structured suggestions with admin context, location biasing, tap → lat/lon | The matcher already does type-ahead/fuzzy/bias (`src/search/gaz.ts:343`); what's missing is the *data*: importance, `city`/`state`/`country`, name variants | Running Photon itself (Nominatim + OpenSearch: hours of import, 95 GB planet index — and search must work offline anyway) |
| D7 | Gazetteer = **full-resolution real entries only**. No synthetic house-number sampling, no cap | The ~150 m sampler fabricates multiples-of-12 counters that restart per way fragment — wrong for real numbering (Calgary's 5-digit quadrants) and the largest row category. Real addresses match exactly; unmatched numbers fall back to the street | Keeping interpolation rows "for coverage" (rejected — fiction ≠ coverage); query-time linear referencing on street polylines (kept in reserve, only if evidence says users type house numbers OSM lacks) |
| D8 | Map tiles = **MVT in a PMTiles v3 archive**; renderer stays **MapLibre GL JS** | "Lightweight" means tile *data*: per-zoom class filtering + simplification + viewport-streamed reads. PMTiles is the standard single-file container and is readable from every MapLibre-flavoured SDK, keeping the **MapLibre Native** door open | Pre-rendered raster tiles (loses styling/pitch quality); custom canvas renderer (biggest bundle win, most work — only if bundle budgets ever demand it) |
| D9 | Routing: **Valhalla via WASM for all service-derived routing**; the TS A\* remains **only for raw `.osm`/`.osm.pbf` imports**, labelled deprecated. Raw import support stays. | Feasibility study §4–8: WASM is 1.4–1.7× native warm, bounded memory, real maneuvers; the A\* is capped and infers maneuvers badly. Raw imports keep working because users still have `.osm.pbf` files today | Deleting the A\* now (rejected: it is the only engine raw imports have; "retire, not delete") |
| D10 | Route-pack format stays **exactly** today's: deterministic ustar of `.gph` tiles | The app already imports, persists and mounts it (`parseTarIndex`, `packstore`, `valhalla-local`); `tools/build-pack.mjs` produces byte-identical output for tests | A new pack container (no need) |

---

## 3. Stage 1 — app changes with no service dependency

Everything here ships and is testable without the service existing. The
service-as-provider wiring is *excluded* by design (it is stage 3).

### 3.1 Search UX toward Photon (over the existing in-app gazetteer)

The matcher is already the right shape — tiered scoring, prefix + fuzzy +
abbreviation equivalence, `near` bias via `distanceBias` (`src/search/gaz.ts`).
What changes is presentation and ranking inputs, forward-compatible with the
stage-3 artifact:

1. **Suggestion rows** in the destination picker (`src/App.tsx` ~3832–4145):
   name, a context line, a type icon (`src/icons.tsx`), and distance when a
   bias point is active. Context comes from what's available in-app (region
   name + category label); the row component takes optional `city`/`state` and
   renders them when present (they arrive with stage 3 artifacts).
2. **Location biasing as a user-visible affordance** — a "search near
   me / near map" toggle feeding `near` (map centre or current fix). The
   scoring side already exists; this is UI plumbing.
3. **Type vocabulary**: map `GazEntry.cat` → display labels/icons (city, town,
   village, suburb, street, address, POI classes). Keep the mapping table in
   one module so stage 3's `type`/`osm` fields drop into it.
4. **Importance enters the score** as a tie-break tier below match quality and
   above distance, using the existing `rank` for now (stage 3 replaces `rank`
   with continuous `importance`). Guard the ordering constants that
   `test/regions.spec.ts` depends on.

Files: `src/search/gaz.ts` (scoring only), `src/search/results.ts`,
`src/App.tsx` picker, `src/icons.tsx`, `src/theme.ts` (icons/labels only).
Tests: extend `test/search-match.spec.ts`, `test/regions.spec.ts` rows.

### 3.2 Routing policy: Valhalla WASM first, A\* legacy-only

1. The `local` provider (`src/nav/providers.ts:61–107`) gets the label
   **"Offline (.osm) — deprecated"**; its readiness copy says it applies only
   to raw imported maps. `planRoute` (`src/nav/engines.ts:88–99`) never offers
   it for pack-backed regions (it already can't route without a `RoadGraph`;
   make that a stated policy, not an accident of data flow).
2. **Cross-region routing**: when both regions carry packs, the pack union is
   the only path — `RegionLibrary.merged()` / `src/osm/merge.ts` /
   `mergeguard.ts` become raw-import-only. `App.tsx:1112` and
   `RegionsScreen.tsx:688` lose the merged-graph fallback for pack-backed
   regions.
3. `hasManeuvers` (`src/nav/engines.ts:278`) semantics settle: maneuvers come
   from odin (hosted or pack). Inferred guidance (`src/nav/guidance.ts`) stays
   wired only for `engine === 'osm-local'` routes — i.e. raw imports.
4. **Retire, don't delete**: `test/astar-admissible.spec.ts`,
   `test/minheap.spec.ts`, `test/merge.spec.ts`, `test/mergeguard.spec.ts` stay
   green as the regression net for the legacy path until stage 3 has run its
   full e2e and STATUS records the parity check.

Files: `src/nav/engines.ts`, `src/nav/providers.ts`, `src/App.tsx`,
`src/regions/RegionsScreen.tsx`, `src/osm/regions.ts`.
Tests: `test/providers.spec.ts`, `test/engines.spec.ts`, `test/strict-plan.spec.ts`.

### 3.3 Map groundwork (MapLibre Native portability)

1. Audit `src/map/` for JS-only coupling and write the port seam down: style
   construction is already style-spec v8 (`src/map/style.ts`), overlays are
   GeoJSON sources/layers — keep it that way. No new MapLibre JS APIs in the
   hot path; anything beyond `Map`, `StyleSpecification`, `GeoJSONSource`,
   `addProtocol` gets a justification comment.
2. Keep bundle budgets as-is (`tools/bundle-budget.mjs`: `mapJs` 290 kB gz).
3. Document the seam where the PMTiles source will attach: the style-swap
   effect (`src/map/MapView.tsx:292–362`) and `offlineStyleSpec`
   (`src/map/style.ts:543–619`), whose layer definitions (class filters, width
   ramps) will be reused verbatim as MVT layer styles in stage 3.

### 3.4 Deprecation labelling and copy

The raw `.osm`/`.osm.pbf` import path stays supported (D9) but says what it
is: import screens (`src/regions/RegionsScreen.tsx`) note that map files get
turn-by-turn and search quality from the pack service when available; the
import guard's refusal copy (`src/osm/importguard.ts:253–268`) gains one
sentence pointing at the pack service in addition to `osmium`.

### 3.5 STATUS.md

A new section (following §17's precedent) recording: the decision log above,
the A\* deprecation boundary, the search sampler's removal from the plan, and
"stage 2/3 pending". `tools/status-audit.mjs` conventions apply.

---

## 4. Stage 2 — the packserver

New top-level `server/` directory: a single Rust crate (`canopy-packserver`,
binary `packserver`), its own `Cargo.lock`, its own tests, its own Dockerfile.
It is not part of the npm build; `npm run verify` stays app-only and the
server gets its own gate (§4.8).

### 4.1 Request lifecycle (the auth rule, D4)

1. TCP/TLS accepted. Headers parsed. `Authorization: Bearer canopy_pk_…`
   (or `X-API-Key`) validated **before any extractor touches the body** — a
   `FromRequestParts` auth extractor ordered ahead of `Multipart` in the
   handler signature. Bad key ⇒ `401` and the body stream is never polled;
   Hyper closes without draining.
2. `Expect: 100-continue` is honoured: a client that waits never transmits a
   byte on a rejected request.
3. `Content-Length` above the cap ⇒ `413` before reading. Chunked uploads are
   capped *while streaming*: the connection is aborted the instant the cap is
   exceeded; nothing beyond the cap reaches disk.
4. Per-key rate limits: concurrent uploads (default 2) and uploads/hour
   (default 10), `429` with `Retry-After`.
5. Honest limit: an attacker can always *send* bytes at the socket; we can
   only refuse to receive them. Edge termination (nginx/Caddy in front of the
   container) is documented as the layer that drops unruly connections.

### 4.2 HTTP API

Base path `/v1`; JSON errors everywhere in one envelope:
`{"error": {"code", "message", "detail"}}`.

- `GET /healthz` — unauthenticated liveness only.
- `POST /v1/builds` — multipart: `file` × 1..N (`.osm.pbf`), optional `region`
  (name), `minzoom`/`maxzoom`, `gazcap`. → `202` with `id`, `state: "queued"`,
  `inputs`, `links` (`status`, `artifacts`, `bundle`).
- `GET /v1/builds/{id}` — `state` (`queued|running|done|failed`), `stages[]`
  (`scan|valhalla|pack|gazetteer|tiles|pmtiles|manifest`, each
  `pending|running|done|failed` with `ms`), `progress` counts, `error` when
  failed.
- `GET /v1/builds/{id}/artifacts` — the manifest (§4.5.4).
- `GET /v1/builds/{id}/artifacts/{name}` — one artifact, raw bytes,
  `Content-Type` per manifest, `ETag: "<sha256>"`,
  `Content-Disposition: attachment`. `name` is validated against the
  manifest allowlist (no path traversal).
- `GET /v1/builds/{id}/bundle` — `application/gzip`,
  `Content-Disposition: attachment; filename="{id}.tar.gz"`; a deterministic
  tar of `manifest.json` + the three artifacts, **streamed** through
  `tar`+`gzip` writers straight from disk (never materialised).

Error codes: `unauthorized`, `rate_limited`, `too_large`, `input_not_pbf`,
`input_unsorted`, `valhalla_failed`, `disk_full`, `not_found`, `internal`.
`input_unsorted` detail names the offending file, the offending element ids,
and the exact `osmium sort` command.

Full JSON examples: Appendix A.

### 4.3 Admin CLI (the only admin surface, D3)

```
packserver serve                                  # the HTTP service (default)
packserver admin key create --name ci [--expires 2027-01-01]
packserver admin key list [--json]
packserver admin key revoke <key-id>
packserver admin jobs list [--json]
packserver admin jobs prune [--all]
packserver admin doctor
```

- Keys: random 32 bytes, rendered `canopy_pk_<base62>`; the service stores
  `sha256(key)` + `{id, name, created, expires?, last_used}` in
  `$PACKSERVER_DATA_DIR/keys.json` (mode 0600). The plaintext key is printed
  exactly once. `doctor` reports: valhalla binary + version, osmium presence,
  free disk, data-dir usage, config values.
- No HTTP route can create, list, revoke, or introspect keys; no HTTP route
  prunes jobs or exposes config.

### 4.4 Build pipeline

Runs in `spawn_blocking` behind a `MAX_CONCURRENT_BUILDS` semaphore
(default 2 — `valhalla_build_tiles` peaks at ~2.4 GB on province input;
the orchestrator is not the memory problem, the C++ binary is).

1. **scan** — stream each input with `osmpbf`: format check, **type-sortedness
   check** (nodes by id, then ways, then relations; mjolnir refuses unsorted
   input), entity counts, bbox, `sha256` of each file. Unsorted input: if
   `osmium` is available, `osmium sort` to a temp file and proceed (recorded in
   the manifest); else refuse with the actionable message. Unsorted or
   oversize inputs are rejected *before* any expensive stage.
2. **valhalla** — `valhalla_build_tiles --inline-config {…} -j N f1.pbf … fN.pbf`
   into a temp tile dir. Config: mjolnir `tile_dir`, logging off, no
   admin/timezone databases (they only affect edge attributes — feasibility
   study §3). Source: the `pyvalhalla` wheel's `valhalla/bin/valhalla_build_tiles`
   (verified standalone, version pinned, `packserver admin doctor` checks it).
3. **pack** — deterministic ustar of the tile dir: `--sort=name`, mtime 0,
   owner/group 0, **file entries only** (identical rules to
   `tools/build-pack.mjs:102–117`, byte-identical output where inputs match).
4. **gazetteer** — see §4.5.1. Two passes per input (ways → referenced node ids
   + interesting tags; nodes → coordinates), then assembly: admin containment,
   street merging, importance, alt names. Memory scales with kept ways and
   referenced nodes — bounded, documented (§4.9).
5. **tiles** + **pmtiles** — see §4.5.2.
6. **manifest** — §4.5.4; artifacts hashed; bundle tars on demand (lazy: the
   `.tar.gz` is generated at download time from the artifact files).

Job state lives in-process (a `HashMap` behind a mutex); artifacts live under
`$PACKSERVER_DATA_DIR/builds/{id}/`. A sweeper deletes builds past
`PACKSERVER_JOB_TTL_SECS` (default 24 h); `admin jobs prune` forces it. A
process restart drops queued/running jobs and orphans artifacts until the next
sweep — acceptable for a stateless service; the client re-submits.

### 4.5 Artifact formats

#### 4.5.1 `search.gazetteer.jsonl.gz` — full-resolution, Photon-shaped

One JSON object per line (schema `canopy-gazetteer/1`), gzipped, order:
importance descending. **Real entries only** (D7): every named place/POI/area,
merged streets, real `addr:housenumber`. No synthetic interpolation rows, no
cap (`gazcap` remains a request knob for emergencies; default 0 = unlimited).

```json
{"id":"way/4821991","name":"Stephen Avenue","type":"street","osm":"highway/pedestrian",
 "lat":51.0450,"lon":-114.0620,"importance":0.31,
 "city":"Calgary","state":"Alberta","country":"Canada","alt":["8 Avenue SW"]}
```

| Field | Notes |
|---|---|
| `id` | `node/…`,`way/…`,`relation/…` — dedupe and debugging |
| `name` | primary name as displayed |
| `type` | Photon-aligned vocabulary: `house`, `street`, `city`, `town`, `village`, `suburb`, `neighbourhood`, `hamlet`, `poi`, `area`, `water`, … |
| `osm` | `key/value` of the defining tag (`highway/residential`, `amenity/cafe`) — icon/filter source |
| `lat`,`lon` | point position; streets carry a representative point (midpoint of the merged polyline) |
| `importance` | continuous 0–1: base by type + `population` (log scale) + admin level. *Approximation* of Nominatim importance (no Wikipedia weights) — honest limitation, ordering of same-name places is still right |
| `city`,`state`,`country` | admin containment via `boundary=administrative` point-in-polygon at build time — the in-app builder can never do this, and it is what makes suggestions read like Photon's |
| `alt` | `name:*`, `alt_name`, `official_name`, `ref` — multilingual/variant matching (FR/EN matters for the CA catalogue) |
| `street`,`house` | on `type:"house"` rows: street name + house number as a **string** (`"12A"`) |

Streets are **merged across way fragments** by name before emission (one row
per street, not per OSM way). Real address rows keep their exact positions.

#### 4.5.2 `map.pmtiles` — MVT, PMTiles v3

- Layers: `roads` (`class`, `name`), `water` (`class`), `green` (`class`).
  Class vocabulary is exactly the app's: `RENDER_MIN_ZOOM`
  (`src/osm/engine.worker.ts:118–121`) for roads; `t.waterway ?? 'water'` for
  water; landuse/leisure/natural classes for green — mirroring
  `buildDataset`'s render half (worker lines 545–583) so the stage-3 style can
  reuse `offlineStyleSpec`'s class filters unchanged.
- Zooms: min 5, max 16 (configurable). Per-zoom class filtering (a motorway
  tile at z6, residential only from z13), Douglas–Peucker simplification with a
  tolerance in tile units that grows as zoom falls, polygon area drop-off per
  zoom, clip to tile + ~8% buffer, quantize to extent 4096.
- PMTiles v3 header: tile type `0x01` (MVT), internal + tile compression gzip,
  `clustered = true` with content-hash dedup, Hilbert tile ids per spec, root
  directory ≤ 16 257 bytes compressed with leaf directories beyond that
  (spec §4), metadata carrying `vector_layers` (required for MVT) and
  `attribution: "© OpenStreetMap contributors"` (ODbL, §7 of the feasibility
  study).
- Estimated weight: a province at z5–16 with class filtering lands in the
  low tens of MB gz — the "lightweight tile data" target. Measured in stage 2
  acceptance, not promised here.

#### 4.5.3 `routing.valhalla.tar`

Unchanged from today (D10): deterministic ustar of `.gph` tiles, file entries
only, sorted, mtime 0. Byte-compatible with `tools/build-pack.mjs` output and
the app's `parseTarIndex` (`src/nav/valhalla-local/tar.ts`).

#### 4.5.4 `manifest.json`

```json
{
  "format": "canopy-bundle/1",
  "build": {"id": "bld_9c14f2a7", "created": "…", "packserver": "0.1.0", "valhalla": "3.9.1"},
  "region": {"name": "alberta", "bbox": [-120, 48.99, -109.99, 60],
             "counts": {"nodes": 6242162, "ways": 1591723, "routable": 412873}},
  "inputs": [{"filename": "alberta-latest.osm.pbf", "bytes": 352181234, "sha256": "…",
              "sorted": true, "resorted": false}],
  "artifacts": [
    {"name": "routing.valhalla.tar", "role": "routing", "format": "valhalla-gph-tar/1",
     "bytes": 278901234, "sha256": "…", "tiles": 1438, "content-type": "application/x-tar"},
    {"name": "search.gazetteer.jsonl.gz", "role": "search", "format": "canopy-gazetteer/1",
     "bytes": 9182331, "sha256": "…", "entries": 412873, "content-type": "application/gzip"},
    {"name": "map.pmtiles", "role": "basemap", "format": "pmtiles/3",
     "bytes": 24118002, "sha256": "…", "minzoom": 5, "maxzoom": 16,
     "layers": ["roads", "water", "green"], "content-type": "application/vnd.pmtiles"}
  ]
}
```

### 4.6 Configuration (env; `PACKSERVER_*`)

| Var | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | listen port |
| `DATA_DIR` | `/var/lib/packserver` | builds + keys |
| `VALHALLA_BIN` | `valhalla_build_tiles` | mjolnir binary (the pyvalhalla wheel in the image) |
| `OSMIUM_BIN` | `osmium` | sort fallback |
| `MAX_UPLOAD_MB` | `2048` | per-request body cap (§4.1) |
| `MAX_CONCURRENT_BUILDS` | `2` | semaphore |
| `JOB_TTL_SECS` | `86400` | retention |
| `MIN_ZOOM` / `MAX_ZOOM` | `5` / `16` | tile pyramid |
| `GAZ_CAP` | `0` | global ceiling on gazetteer entries (0 = unlimited) |

### 4.7 Docker

Multi-stage, `server/` as build context:

1. `rust:1-bookworm` — `cargo build --release` (static-ish gnu target).
2. `valhalla` stage — `python:3.12-slim` + `pip install pyvalhalla==3.9.1`;
   the wheel's `valhalla/bin/valhalla_build_tiles` is standalone (verified:
   runs from an extracted wheel, zero missing libs).
3. `debian:bookworm-slim` runtime — `osmium-tool` (apt), the extracted
   `valhalla/bin` + `pyvalhalla.libs`, the `packserver` binary, non-root user,
   `VOLUME /var/lib/packserver`, `EXPOSE 8787`, healthcheck on `/healthz`.

Build acceptance: `docker build` from a clean tree, `docker run` + the §4.8
smoke against the running container.

### 4.8 Testing (server gate: `cd server && cargo test` + smoke)

- **Unit**: gazetteer extraction on `../test/fixture.osm.pbf` (known entries,
  street merging, alt names); sortedness detection (crafted unsorted inputs);
  MVT encode round-trip (decode with a minimal test decoder — command streams
  asserted); PMTiles writer vs a hand-rolled reader + header field assertions
  (root ≤ 16 257 bytes compressed, dedup counts, Hilbert ids); tar determinism
  (two runs byte-identical); manifest hashing.
- **API**: `tower::ServiceExt::oneshot` against the real router — auth-first
  ordering (a request with a body and a bad key must leave the body unread —
  assert via a body wrapper that panics on poll), 413 precheck, rate limits,
  artifact path-traversal refusal, bundle tar.gz round-trip.
- **Pipeline**: end-to-end with a **stub `valhalla_build_tiles`** (shell script
  emitting a fake tile dir) so CI needs no real Valhalla; one optional
  `#[ignore]`d test using the real binary for whoever has it.
- **Contract tests from the JS side** (they define "the app can consume this"):
  read `map.pmtiles` with the `pmtiles` npm package and fetch a tile; gunzip +
  parse `search.gazetteer.jsonl.gz` and validate the schema; untar
  `routing.valhalla.tar` with `src/nav/valhalla-local/tar.ts` and mount it.
  A tiny fixture bundle (built from `test/fixture.osm.pbf`) is checked in.

### 4.9 Resource envelope (honest)

- The orchestrator is I/O glue + bounded two-pass extraction; its RSS is
  dwarfed by `valhalla_build_tiles` (44 s / 2.4 GB peak on a 352 MB extract —
  feasibility study §3). `MAX_CONCURRENT_BUILDS=2` on a 8 GB host is the
  starting point; `admin doctor` surfaces the numbers.
- Gazetteer assembly holds kept ways + referenced node coordinates (province:
  low hundreds of MB). Tiles are built per-zoom incrementally, never a
  whole-pyramid materialisation. Documented ceiling: `MAX_UPLOAD_MB` is the
  real governor.

---

## 5. Stage 3 — app changes that consume the service

The only stage that requires a running packserver. Each item names the seam
from the exploration record.

### 5.1 Service client and provider wiring

- New `src/regions/service.ts`: submit (multipart with `X-API-Key`), poll
  `GET /v1/builds/{id}` with backoff, download the bundle. Settings screen
  gains "Pack service" (URL + API key, stored via `src/settings.ts`); the key
  is device-local and never logged.
- The service is an **artifact source**, not a routing engine — it does not
  enter `src/nav/engines.ts`'s provider table. It feeds the existing
  `local-valhalla` provider (packs) plus the new search/map stores.

### 5.2 Bundle ingest (the unpack-once rule, D5)

New `src/regions/bundle.ts`:
1. `DecompressionStream('gzip')` + tar walk (the `parseTarIndex` codebase in
   `src/nav/valhalla-local/tar.ts` extends to extraction).
2. Verify `manifest.json`, then every artifact's `sha256` via
   `crypto.subtle.digest`.
3. Route artifacts to stores: `routing.valhalla.tar` → existing `packstore` +
   `getLocalValhalla().mount()`; `search.gazetteer.jsonl.gz` → gz kept at
   rest, decompressed at load into entries; `map.pmtiles` → Capacitor
   Filesystem (native) / OPFS (web) — the random-access seam.
4. Free-disk gate before download using manifest sizes (the
   `navigator.storage.estimate` pattern already in `download.ts`).

### 5.3 Search from the artifact

- Loader streams `search.gazetteer.jsonl.gz` into entries; the matcher gains
  `importance` in the score (stage 1's slot), `city`/`state`/`country` in the
  rows (stage 1's optional fields), `alt` in token matching, and `type`/`osm`
  in the icon/label mapping. The 120k trimming is gone; if the on-device index
  ever needs a budget it is applied at load as policy, never by throwing data
  away at build (D7).
- Multi-region `searchAll` (`src/search/all.ts`) keeps working — it already
  scores across gazetteer arrays.

### 5.4 Map from `map.pmtiles`

- `pmtiles` npm package + a custom `Source` over the stored file with a
  **whole-tile read cache** — the lesson from the Valhalla tile source
  (feasibility study §4.1: per-chunk reads made a cold route 25× slower; the
  same pathology applies to tile fetches).
- `maplibregl.addProtocol('pmtiles', …)`; `offlineStyleSpec` switches its
  `canopy-osm` GeoJSON sources to one vector source with `source-layer`
  `roads`/`water`/`green`, class filters and width ramps reused verbatim
  (`src/map/style.ts:543–619`). The GeoJSON basemap remains for raw imports.
- Attribution control carries `© OpenStreetMap contributors` on the tile
  source (test-asserted like `test/attribution.spec.ts`).

### 5.5 Routing for service regions

Service regions carry a pack and no `RoadGraph`; `local-valhalla` (WASM) is
therefore the *only* offline engine and the A\* branch is unreachable by
construction (D9). Engine trace rows say so. Cross-region routes between two
service regions use the mounted pack union — correct only when both came from
one build (see §7 risk 1; with this service that means one multi-file upload).

### 5.6 Guards and download path

- `importguard`/`mergeguard` do not run for bundles: nothing is parsed, and
  manifest sizes make the disk check exact (a service bundle never produces
  the 229 B/node peak at all).
- One-tap convenience (optional): `download.ts`-style fetch of a bundle URL;
  same-origin/mirror considerations as §7 gap 4 apply.

### 5.7 Tests / e2e

Fixture bundle (§4.8) → import → search ("123 main", a typo, a
location-biased query) → route (pack engine, maneuvers present) → map draws
(`test/e2e.mjs` "the map actually draws" block extended to the tile source) →
bundle budget re-measured (`pmtiles` reader ~10–15 kB gz expected).

---

## 6. What is not in scope / not done

- No in-app "upload my `.osm.pbf` to the service" flow beyond the §5.1 client —
  users can curl. Revisit on demand.
- Planet-scale uploads (`MAX_UPLOAD_MB` governs; a planet build is a CI job,
  not an upload).
- Multi-tenant auth, quotas per org, billing. API keys are single-tenant.
- Reverse geocoding and bbox filters (free with the artifact's coordinates —
  stage 3.5+ candidates).
- Query-time house-number linear referencing (D7's reserve option).
- MapLibre Native migration — the door is kept open (§3.3), not walked.
- Phone verification of the WASM engine (feasibility study §7: still the one
  unmeasured number).

---

## 7. Risks

1. **Cross-build border tiles (D2's cost).** Packs partitioned from *separate*
   builds can carry dangling cross-tile references at their borders
   (feasibility study §6). Mitigation: upload adjacent regions as one
   multi-file request; the manifest records input sets so the app can *detect*
   likely-mismatched packs and prefer hosted routing across them. If this
   bites in practice, the service gains stateful projects (the rejected D2
   alternative) without format changes.
2. **Importance is an approximation** of Nominatim's. Ordering of same-name
   places may differ from photon.komoot.io on real queries. Accept and
   measure against a corpus of queries in stage 3 acceptance.
3. **On-device search index size** at province scale (millions of entries) —
   token index memory and query latency. Streaming/lazy indexing is the known
   fix; budgeted, measured in stage 3.
4. **WASM memory ceiling alongside MapLibre** (feasibility study §7): start
   with the 128 MiB cap + 16k-label reservation policy; measure on device.
5. **`valhalla_build_tiles` version drift** vs the `valhalla-wasm` pin: tile
   format is stable across 3.x, but the fixture parity test
   (`test/valhalla-local.spec.ts` shape) is the guard; pin both in the
   manifest (`build.valhalla`).
6. **Unsorted uploads** from non-Geofabrik sources: handled by the osmium
   fallback, refused with actionable copy when osmium is absent.

---

## 8. Open questions

- Should `bundle` generation be precomputed at build time for retry-friendly
  `ETag`s, or stay lazy? (Lazy is fine at current volumes.)
- Do we want `places` point layers in `map.pmtiles` now for future labels
  (cheap), or wait for a labels decision (glyphs offline)?
- Retention defaults: 24 h TTL vs "until disk pressure"?
- Does the CA catalogue want FR/EN display-name preference rules in the
  matcher (locale-aware `alt` preference)?

---

## Appendix A — API examples

```bash
# submit (curl honours Expect: 100-continue for large bodies)
curl -H "Authorization: Bearer canopy_pk_…" \
     -F file=@alberta-latest.osm.pbf -F file=@saskatchewan-latest.osm.pbf \
     -F region=prairies \
     https://pack.example/v1/builds
# → 202 {"id":"bld_9c14f2a7","state":"queued","inputs":[…],"links":{…}}

curl -H "Authorization: Bearer canopy_pk_…" \
     https://pack.example/v1/builds/bld_9c14f2a7
# → {"id":…,"state":"running","stages":[{"name":"scan","state":"done","ms":812},…]}

curl -H "Authorization: Bearer canopy_pk_…" -OJ \
     https://pack.example/v1/builds/bld_9c14f2a7/bundle
# → bld_9c14f2a7.tar.gz  (manifest.json + 3 artifacts, deterministic)
```

Failure body (422):

```json
{"error": {"code": "input_unsorted",
  "message": "Input PBF is not type-sorted; valhalla_build_tiles requires sorted input.",
  "detail": "way 4821991 appears before way 4821002 in alberta-latest.osm.pbf. Run: osmium sort -o sorted.osm.pbf alberta-latest.osm.pbf"}}
```

## Appendix B — server module layout

```
server/
  Cargo.toml  Cargo.lock  Dockerfile  .dockerignore  README.md
  src/
    main.rs       # config (env), CLI dispatch (serve | admin …)
    api.rs        # router, extractors, error envelope
    auth.rs       # key verification (headers-first), key store for the CLI
    admin.rs      # key/jobs/doctor CLI commands
    jobs.rs       # job registry, semaphore, TTL sweeper
    pipeline.rs   # stage orchestration + progress reporting
    scan.rs       # osmpbf: sortedness, counts, bbox, sha256
    gaz.rs        # gazetteer: passes, containment, street merge, importance, alts
    render.rs     # roads/water/green extraction (mirrors buildDataset's render half)
    tiles.rs      # pyramid: per-zoom filter, simplify, clip, quantize
    mvt.rs        # MVT protobuf encoder (hand-rolled varint writer)
    pmtiles.rs    # PMTiles v3 writer (Hilbert ids, dedup, leaf dirs)
    pack.rs       # deterministic tar of .gph tiles
    valhalla.rs   # subprocess: inline config, multi-input, timeouts
    bundle.rs     # streaming tar.gz of manifest + artifacts
```

## Appendix C — stage sizing (rough)

| Stage | Work | Size |
|---|---|---|
| 1 | search UX rows + bias toggle, engine policy, map portability audit, copy, STATUS | M |
| 2 | scan/valhalla/pack | M |
| 2 | gazetteer (containment, merge, importance, alts) | M–L |
| 2 | tiles + MVT + PMTiles writer | L |
| 2 | API + auth + CLI + jobs | M |
| 2 | Docker + tests (incl. JS contract tests) | M |
| 3 | client + bundle ingest | M |
| 3 | search + map + routing integration | M–L |
| 3 | e2e + budgets + STATUS close-out | S–M |
