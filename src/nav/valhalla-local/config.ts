/**
 * Runtime configuration for the in-process Valhalla engine.
 *
 * Adapted from `ecc521/valhalla-wasm`'s `web/routingCore.ts` (MIT, (c) ecc521),
 * which is itself the working config for `tyr::actor_t` in a WASM build. The
 * shape is not free: this Valhalla build validates the schema at actor
 * construction and refuses a partial config ("No such node
 * (service_limits.isochrone.max_contours)"), so every section its validator
 * touches is present here.
 *
 * Deliberate changes from the source config:
 *
 *  - `logging.type: ''` everywhere. The engine runs beside the driver's map;
 *    stdout chatter is noise in a WebView console and nothing else.
 *  - `max_cache_size` is 64 MB rather than 200 MB. This is the parsed-tile LRU
 *    inside the WASM heap; on a phone the engine is one of several tenants, and
 *    the raw-tile cache (`tilesource.ts`) absorbs re-reads. Raise it from the
 *    engine options if a device warrants it.
 */

export interface LocalValhallaConfigOptions {
  /** Parsed-tile LRU inside the engine, bytes. */
  maxCacheBytes?: number;
}

export function valhallaLocalConfig(opts: LocalValhallaConfigOptions = {}): Record<string, unknown> {
  return {
    mjolnir: {
      tile_dir: '/valhalla_tiles',
      include_bicycle: true,
      include_driving: true,
      include_pedestrian: true,
      // Tile caching is what keeps a route from re-reading and re-parsing every
      // tile on every access; each cached tile is read from storage once.
      use_lru_mem_cache: true,
      lru_mem_cache_hard_control: false,
      max_cache_size: opts.maxCacheBytes ?? 64 * 1024 * 1024,
      hierarchy: true,
      logging: { color: false, type: '' },
    },
    loki: {
      actions: [
        'locate', 'route', 'sources_to_targets', 'optimized_route', 'isochrone',
        'trace_route', 'trace_attributes', 'expansion', 'status',
      ],
      logging: { color: false, type: '' },
      service_defaults: {
        heading_tolerance: 60,
        minimum_reachability: 10,
        node_snap_tolerance: 50,
        radius: 0,
        search_cutoff: 35000,
        street_side_max_distance: 1000,
        street_side_tolerance: 5,
        mvt_min_zoom_road_class: [6, 7, 8, 9, 10, 11, 12, 13],
        mvt_min_zoom_other: [6, 7, 8, 9, 10, 11, 12, 13],
        mvt_min_zoom_path: [6, 7, 8, 9, 10, 11, 12, 13],
        mvt_cache_min_zoom: 12,
        mvt_cache_max_zoom: 16,
        mvt_cache_size: 100,
      },
    },
    costing_options: {
      auto: { country_crossing_penalty: 0.0 },
      pedestrian: { walking_speed: 5.1, use_ferry: 0.5 },
    },
    thor: { source_to_target_algorithm: 'select_optimal', service: { proxy: 'ipc:///tmp/thor' } },
    odin: { logging: { color: false, type: '' }, service: { proxy: 'ipc:///tmp/odin' } },
    meili: {
      mode: 'auto',
      grid: { cache_size: 100240, size: 500 },
      logging: { color: false, type: '' },
      default: {
        beta: 3, breakage_distance: 2000, geometry: false, gps_accuracy: 5.0,
        interpolation_distance: 10, max_route_distance_factor: 5, max_route_time_factor: 5,
        max_search_radius: 100, route: true, search_radius: 50, sigma_z: 4.07, turn_penalty_factor: 0,
      },
    },
    service_limits: {
      auto: { max_distance: 5000000.0, max_locations: 20, max_matrix_distance: 400000.0, max_matrix_location_pairs: 2500 },
      bicycle: { max_distance: 500000.0, max_locations: 50, max_matrix_distance: 200000.0, max_matrix_location_pairs: 2500 },
      pedestrian: {
        max_distance: 5000000.0, max_locations: 50, max_matrix_distance: 200000.0,
        max_matrix_location_pairs: 2500, max_transit_walking_distance: 10000, min_transit_walking_distance: 1,
      },
      truck: { max_distance: 5000000.0, max_locations: 20, max_matrix_distance: 400000.0, max_matrix_location_pairs: 2500 },
      isochrone: {
        max_contours: 4, max_distance: 25000.0, max_time_contour: 3600,
        max_distance_contour: 25000, max_locations: 1,
      },
      trace: {
        max_alternates: 3, max_alternates_shape: 100, max_distance: 200000.0,
        max_gps_accuracy: 100.0, max_search_radius: 100.0, max_shape: 16000,
      },
      skadi: { max_shape: 750000, min_resample: 10.0 },
      status: { allow_verbose: false },
      centroid: { max_distance: 200000.0, max_locations: 5 },
      max_alternates: 2, max_radius: 200, max_reachability: 50, max_exclude_locations: 50,
      max_exclude_polygons_length: 10000, max_timedep_distance: 500000,
      max_timedep_distance_matrix: 0, max_distance_disable_hierarchy_culling: 0,
    },
  };
}
