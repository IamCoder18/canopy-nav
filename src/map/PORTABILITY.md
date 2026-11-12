# Map renderer boundary

`style.ts` constructs style-spec v8 dictionaries. Online and offline layers use
the same palettes/filters/width ramps. `offlineStyleSpec(overlays, pmtilesUrl)`
changes only the basemap source and `source-layer`s, not navigation overlays.
OSM attribution is declared on sources and displayed by the renderer control.

`MapView.tsx` is the JS adapter: camera events, follow projection, DOM container,
and `addProtocol`. These lifecycle/gesture/projection APIs are JS-specific and
must be implemented by the native host, not imported into routing or search.
Camera centre/bearing leave it as plain coordinates/numbers. `overlays.ts`
updates standard GeoJSON sources; renderer source mutation is confined there.
The PMTiles reader's `Source` uses stored-file byte ranges, with a bounded cache
of whole tile requests, rather than any MapLibre JS internals.

For MapLibre Native, keep the style dictionaries, GeoJSON overlay payloads,
PMTiles archive and the routing/search stores. Replace `MapView` camera and
event binding, `GeoJSONSource.setData`, and protocol registration with the SDK's
file/PMTiles source. `MapView`'s style-swap effect is the attachment seam; raw
imports keep their GeoJSON basemap. No renderer migration is included here.
The existing 290 kB gzip MapLibre vendor budget is unchanged.
