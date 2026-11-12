# Canopy packserver

Stateless Rust build service: upload one or more `.osm.pbf` inputs, download a
verified `.tar.gz` containing Valhalla routing tiles, a real-data gazetteer,
and viewport-readable PMTiles MVT. No admin HTTP API, no hosted route endpoint,
no Cloudflare Tunnels. The app needs **your server address and an API key** in
Settings → Pack service. It remains fully offline after bundle installation.

## Direct public IPv6 + Caddy

1. Give the host a stable, globally routable IPv6 address. Publish a **DNS-only
   AAAA** record (e.g. `packs.example.org`) pointing directly to it. Do not proxy
   the record or configure a Cloudflare Tunnel. An IPv6-only host requires IPv6
   connectivity at the client; add direct IPv4/A records if IPv4-only clients
   must work too.
2. Allow inbound TCP 80/443 in the host AND provider IPv6 firewall (and UDP 443
   optionally for HTTP/3). Keep 8787 private. Verify IPv6 routing and AAAA DNS
   from another network before debugging TLS.
3. From `server/`: `docker compose up -d --build`. The container is non-root;
   its port is published **only on `[::1]:8787`**. The named volume is owned by
   UID 10001. For a bind mount, provision ownership/permissions explicitly.
4. Install Caddy 2.10+ on the host, set `PACKSERVER_HOST=packs.example.org` in its
   systemd environment, and use the included `Caddyfile`. Caddy obtains public
   TLS certificates via direct ACME challenges over IPv6 and streams to
   `[::1]:8787`. Validate: `caddy validate --config server/Caddyfile --adapter caddyfile`.
5. Create a key locally:

   ```sh
   docker compose exec packserver packserver admin key create --name phone
   ```

   Save the printed key now; plaintext is printed once, never stored. Enter
   `https://packs.example.org` and that key in the app. A raw IPv6 HTTPS URL such
   as `https://[2001:db8::1]` also needs a certificate trusted by the device;
   prefer a domain with AAAA DNS and Caddy automatic HTTPS.

6. Smoke from the repository root:

   ```sh
   PACKSERVER_URL=https://packs.example.org PACKSERVER_API_KEY=canopy_pk_… node server/smoke.mjs
   ```

**Auth and bandwidth:** the app server checks headers before polling any body;
Hyper sends `100 Continue` only when a valid request starts reading. Oversize
Content-Length is rejected immediately; chunked bodies are limited before disk
writes. Caddy must not buffer request bodies. An attacker can still send bytes
into a socket without waiting: only the public edge/firewall can control that
traffic. Caddy's size limit is defence in depth, not a replacement for the
service's auth-first rule. **Keep the `forward_auth` upload preflight in the
Caddyfile**: stock reverse proxying can send `100 Continue` before the backend
has rejected a bad key. The preflight is a bodyless authenticated
`GET /v1/auth-check`; it also checks the original upload Content-Length supplied
by Caddy. It grants no administrative capability and exposes no key metadata.
POST reauthenticates and enforces all streaming/rate limits itself. Keep the
global credential log filter: reverse-proxy **error logs** can contain request
headers even with access logging off. If adding an access logger, apply the
same `Authorization`/`X-API-Key` redaction there. No tunnel token is needed.

## API

```sh
curl -H 'Authorization: Bearer canopy_pk_…' -H 'Expect: 100-continue' \
  -F file=@alberta-latest.osm.pbf -F file=@saskatchewan-latest.osm.pbf \
  -F region=prairies https://packs.example.org/v1/builds
# 202: {id, state:"queued", inputs, links:{status,artifacts,bundle}}
curl -H 'X-API-Key: canopy_pk_…' https://packs.example.org/v1/builds/BUILD_ID
curl -H 'X-API-Key: canopy_pk_…' -OJ https://packs.example.org/v1/builds/BUILD_ID/bundle
```

`GET /healthz` is public liveness only. All `/v1` endpoints require a key.
`GET /v1/builds/{id}/artifacts` returns the manifest; append `/{artifact-name}`
for one allowlisted file with SHA-256 ETag. Bundle downloads are deterministic
streaming tar+gzip, never an extra disk copy. Errors use
`{error:{code,message,detail}}`; async build errors appear on the status record.
Multipart fields: `file` (1–128, unique `.osm.pbf` basenames), `region`,
`minzoom`, `maxzoom`, `gazcap` (0 = unlimited; cannot exceed a configured global
cap). Default zooms 5–16; supported range 0–16. Upload adjacent extracts together:
independent Valhalla border tiles are NOT guaranteed to connect. Input hashes
and build id let the app avoid cross-build routing.

## CLI

```text
packserver serve
packserver admin key create --name ci [--expires 2027-01-01]
packserver admin key list [--json]
packserver admin key revoke KEY_ID
packserver admin jobs list [--json]
packserver admin jobs prune [--all]
packserver admin doctor
```

Keys are random, SHA-256 hashed in `keys.json` (0600); atomic locked updates
allow immediate revocation while serving. Expiry is midnight UTC on the date.
Builds belong to their submitting key. Restart forgets in-process jobs; re-submit
after restarting. Old artifacts/orphans are swept every minute after TTL.
Doctor reports binary versions, free disk, data usage and effective config.
Job listings include diagnostic snapshots, not restart-persistent liveness.
Pruning skips builds/downloads with active file leases, even with `--all`.

## Configuration

All environment names start `PACKSERVER_`:

| Suffix | Default |
|---|---|
| PORT | 8787 |
| DATA_DIR | /var/lib/packserver |
| VALHALLA_BIN | valhalla_build_tiles (image: pinned pyvalhalla 3.9.1 binary) |
| OSMIUM_BIN | osmium |
| MAX_UPLOAD_MB | 2048 |
| MAX_CONCURRENT_BUILDS | 2 |
| JOB_TTL_SECS | 86400 |
| MIN_ZOOM / MAX_ZOOM | 5 / 16 |
| GAZ_CAP | 0 |
| CONCURRENT_UPLOADS / UPLOADS_PER_HOUR | 2 / 10 per key |
| THREADS / BUILD_TIMEOUT_SECS | 2 / 7200 |

Use an 8 GB host as a starting point for two province builds: native Valhalla,
not the Rust orchestrator, dominates RSS (~2.4 GB measured in the feasibility
study). Gazetteer extraction retains selected ways and referenced nodes, not
all nodes. Relation membership is scanned first, then ways and nodes; extra
relation scan preserves untagged multipolygon members. Geometry stays resident;
tile buckets exist for one zoom at a time, encoded tiles spill to disk. Upload
size is the governor, NOT a promise to support a planet. Gazetteer matching is
unlimited real entries: continuous importance is an approximation without
Wikipedia weights. No fabricated addresses or interpolation samples.

Retained disk includes three artifacts, manifest and a bounded diagnostic tail
in build failures. Running builds also need raw inputs, optionally sorted
copies, native intermediate files, and a PMTiles spool. Budget several times
the upload cap per simultaneous job. Apply host/container memory and disk
limits appropriate to your extracts. Builds share no project state; overlapping
OSM elements in union inputs are deduplicated by element id for search/render.

## Gates and fixtures

```sh
cd server
cargo test --locked
docker build -t canopy-packserver .
# Start the image/compose, create a key, then run smoke.mjs as above.
```

Unit/API/pipeline tests use a stub Valhalla builder. The ignored real-binary test
needs Valhalla and osmium. JS contract tests use `test/packserver/` fixtures and
the real `pmtiles` reader, gazetteer loader, tar parser, and WASM routing engine.
App verification stays `npm run verify`; Rust is an independent gate.
The smoke also verifies that bad keys and oversized requests receive a final
rejection without `100 Continue`, including when run through Caddy. For a real
native-builder → app bundle ingest → WASM route check, run a Vite dev server
and set `PACKSERVER_APP_URL=http://localhost:5173` alongside the smoke variables
(requires the root npm dependencies and a Playwright Chromium installation).
To exercise the **shipped Caddyfile** too, run
`PACKSERVER_BACKEND_URL=http://[::1]:8787 PACKSERVER_API_KEY=… node server/edge-smoke.mjs`.
It creates an isolated loopback Caddy, tests the header-first refusals and an
intentional proxy error (asserting the key is redacted), then removes its files.
It never changes public DNS, certificates or a running Caddy configuration.
The independent `.github/workflows/packserver.yml` gate runs Rust tests and the
native Docker smoke; the existing app CI runs the JS/bundle/browser contracts.

Unpack the transport once. Routing tar stays uncompressed for lazy `.gph`
reads; gazetteer gzip stays compressed at rest; `map.pmtiles` lives in OPFS or
Android private files with range reads. Both tile formats use whole-tile caches.
All map data requires displayed © OpenStreetMap contributors attribution (ODbL).
