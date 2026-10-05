/**
 * Durable settings.
 *
 * Every one of these was `useState` with a literal default and nothing else, so
 * the engine choice, the fallback policy, the unit system, the API key and the
 * custom endpoint were all forgotten the moment the app was closed. In a car
 * that is not a papercut: a driver who chose imperial units, or pointed the app
 * at their own Valhalla, had to redo it on every single launch — and, worse,
 * silently got *different routing* than they had configured, because the app
 * fell back to its own default engine without saying so.
 *
 * The store is deliberately small and synchronous:
 *
 *  - **Synchronous first read.** `localStorage` is read in the `useState`
 *    initialiser, so the first render already has the saved value. Reading it in
 *    an effect would render the defaults first and then correct them, which is
 *    the flash this avoids.
 *  - **Validated on read.** A corrupt or hand-edited entry falls back to the
 *    default instead of putting the app into an impossible state.
 *  - **Quota-safe.** `localStorage.setItem` throws in a private window or when
 *    full. Nothing here is worth failing an import over, so writes are guarded
 *    and a failure is reported through `onError` rather than thrown.
 *
 * Run with `npx vitest run test/settings.spec.ts`.
 */

/** Key namespace. Prefixed so it cannot collide with anything else on the origin. */
const PREFIX = 'canopy.settings.';

export const SETTINGS_KEYS = {
  selection: `${PREFIX}engine`,
  units: `${PREFIX}units`,
  apiKey: `${PREFIX}apiKey`,
  endpoint: `${PREFIX}endpoint`,
  places: `${PREFIX}places`,
} as const;

/** The fallback policy is part of the engine selection object. */
export interface StoredSelection {
  engine: string;
  fallback: string;
}

/** Defaults, matching what the screens showed before persistence existed. */
export const DEFAULT_UNITS = 'metric' as const;
export const DEFAULT_SELECTION: StoredSelection = { engine: 'local', fallback: 'fallback' };

/**
 * Engine ids accepted when the caller does not supply the live list.
 *
 * Matches `PROVIDERS` in `nav/providers.ts` plus the synthetic `any-online`. The
 * app always passes the real list; this exists so the module is testable and so
 * a caller cannot accidentally disable validation by passing nothing.
 */
export const DEFAULT_ENGINE_IDS: readonly string[] = [
  'local', 'valhalla', 'simplerouting', 'custom', 'any-online',
];

/** Minimal slice of `Storage`, so tests can pass a stub. */
export interface Store {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * `localStorage` when it is usable, otherwise `null`.
 *
 * Access itself throws in some embedded WebViews when storage is disabled by
 * policy, so the *read* of `window.localStorage` is guarded too — not just the
 * writes.
 */
export function defaultStore(): Store | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    // Touch it: Safari's private mode has the object but throws on write.
    const probe = `${PREFIX}__probe`;
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return null;
  }
}

/**
 * `getItem`, guarded.
 *
 * `defaultStore()` probes with a write and a delete, which catches the cases it
 * is aimed at — no `localStorage`, or an object that throws on write. It does
 * **not** catch a store whose `getItem` throws: some enterprise WebViews and
 * ITM-managed profiles deny reads by policy while permitting the object to
 * exist.
 *
 * That distinction mattered: every reader below called `store.getItem(...)`
 * bare, from inside a `useState` initialiser. A throwing `getItem` therefore
 * threw *during the first render*, and the app opened on the crash card with
 * `readUnits` as the message and no settings screen to fix it from. The module's
 * own header claimed "the read of `window.localStorage` is guarded too — not
 * just the writes", which was true of the probe and false of the reads.
 */
function safeGet(store: Store | null, key: string): string | null {
  try {
    return store?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/**
 * Saved Home and Work, as coordinates.
 *
 * ## Why these exist
 *
 * The launcher had `Home` and `Work` tiles wired to `[-0.1276, 51.5072]` and
 * `[-0.142, 51.5]` — two points in the English Channel — and a tile labelled
 * "Home" reads as *your* home. Tapping one asked the routing engine for a trip
 * to a fixed point in the ocean, and on an offline extract it answered
 * "No route found in the offline map for this pair", which is a confusing way to
 * say "this button does not do what its label says".
 *
 * There is no correct hard-coded value: it depends on where the driver is. So
 * they are unset until someone sets them, and a tile with no destination says so
 * rather than pretending.
 */
export interface SavedPlace {
  /** `[lon, lat]`, validated finite and in range on the way in *and* out. */
  pos: [number, number];
  label: string;
}

const isFiniteLonLat = (v: unknown): v is [number, number] =>
  Array.isArray(v) &&
  v.length === 2 &&
  typeof v[0] === 'number' && typeof v[1] === 'number' &&
  Number.isFinite(v[0]) && Number.isFinite(v[1]) &&
  Math.abs(v[0]) <= 180 && Math.abs(v[1]) <= 90;

/** The two slots the launcher offers. */
export type PlaceSlot = 'home' | 'work';

export function readPlaces(store: Store | null = defaultStore()): Partial<Record<PlaceSlot, SavedPlace>> {
  const raw = safeGet(store, SETTINGS_KEYS.places);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Partial<Record<PlaceSlot, SavedPlace>> = {};
    for (const slot of ['home', 'work'] as const) {
      const entry = (parsed as Record<string, unknown>)[slot];
      // Validated on read as well as on write: this is untrusted durable state,
      // and `persisted.ts` makes the same argument about region records.
      if (entry && typeof entry === 'object' && isFiniteLonLat((entry as SavedPlace).pos)) {
        const label = String((entry as SavedPlace).label ?? '').slice(0, 80).trim();
        out[slot] = { pos: (entry as SavedPlace).pos, label: label || slot[0].toUpperCase() + slot.slice(1) };
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function writePlace(
  slot: PlaceSlot,
  value: SavedPlace | null,
  store: Store | null = defaultStore(),
): string | null {
  const current = readPlaces(store);
  if (!value) delete current[slot];
  else if (isFiniteLonLat(value.pos)) {
    current[slot] = { pos: value.pos, label: value.label.slice(0, 80).trim() || slot };
  } else {
    // Refuse to store a coordinate that is not a coordinate, rather than
    // writing something that reads back as a place on the ocean.
    return 'That is not a valid location.';
  }
  if (!Object.keys(current).length) {
    clear(SETTINGS_KEYS.places, store);
    return null;
  }
  return persist(store, SETTINGS_KEYS.places, JSON.stringify(current));
}

export function readUnits(store: Store | null = defaultStore()): 'metric' | 'imperial' {
  const raw = safeGet(store, SETTINGS_KEYS.units);
  return raw === 'imperial' ? 'imperial' : 'metric';
}

export function writeUnits(
  value: 'metric' | 'imperial',
  store: Store | null = defaultStore(),
): string | null {
  return persist(store, SETTINGS_KEYS.units, value);
}

/**
 * Read the engine selection, tolerating anything.
 *
 * Both halves are validated independently, so an entry saved by a build with a
 * different engine list still yields a usable selection rather than an object
 * whose `engine` is `undefined`. `allowed` is passed by the caller, derived from
 * the live provider list, so a renamed or removed engine degrades to the default
 * rather than leaving the selection pointing at nothing.
 */
export function readSelection(
  allowed: readonly string[] = DEFAULT_ENGINE_IDS,
  store: Store | null = defaultStore(),
): StoredSelection {
  const raw = safeGet(store, SETTINGS_KEYS.selection);
  if (!raw) return { ...DEFAULT_SELECTION };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_SELECTION };
  }
  if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULT_SELECTION };
  const o = parsed as Record<string, unknown>;
  const engine = typeof o.engine === 'string' && allowed.includes(o.engine) ? o.engine : DEFAULT_SELECTION.engine;
  const fallback = o.fallback === 'strict' ? 'strict' : DEFAULT_SELECTION.fallback;
  return { engine, fallback };
}

export function writeSelection(
  value: StoredSelection,
  store: Store | null = defaultStore(),
): string | null {
  return persist(store, SETTINGS_KEYS.selection, JSON.stringify(value));
}

export function readApiKey(store: Store | null = defaultStore()): string {
  // Trimmed on read as well as write: a pasted key usually carries a newline,
  // and a trailing \n in a header value is a request that fails mysteriously.
  return (safeGet(store, SETTINGS_KEYS.apiKey) ?? '').trim();
}

export function writeApiKey(value: string, store: Store | null = defaultStore()): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    clear(SETTINGS_KEYS.apiKey, store);
    return null;
  }
  return persist(store, SETTINGS_KEYS.apiKey, trimmed);
}

export function readEndpoint(store: Store | null = defaultStore()): string {
  return (safeGet(store, SETTINGS_KEYS.endpoint) ?? '').trim();
}

export function writeEndpoint(value: string, store: Store | null = defaultStore()): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    clear(SETTINGS_KEYS.endpoint, store);
    return null;
  }
  return persist(store, SETTINGS_KEYS.endpoint, trimmed);
}

/**
 * Write one value, returning a message when storage refused.
 *
 * Returns `null` on success. Quota and private-browsing failures are reported to
 * the user rather than thrown, because losing a preference must never take an
 * import or a route down with it.
 */
function persist(store: Store | null, key: string, value: string): string | null {
  if (!store) {
    return 'This browser will not let the app save settings, so they reset when you close it.';
  }
  try {
    store.setItem(key, value);
    return null;
  } catch (e) {
    const quota = e instanceof DOMException &&
      (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED');
    return quota
      ? 'Not enough storage to save this setting.'
      : 'This setting could not be saved.';
  }
}

function clear(key: string, store: Store | null): void {
  try {
    store?.removeItem(key);
  } catch {
    // Nothing useful to do; the value is already unreadable.
  }
}

/**
 * Validate a user-supplied Valhalla endpoint.
 *
 * Returns `null` when usable, or a message saying exactly what is wrong.
 *
 * Without this, `not a url`, `htp:/broken`, and whitespace-only all produced an
 * engine row reading "Ready" — because readiness asked whether a string was
 * *present*, not whether it could ever be fetched. An address that is
 * syntactically impossible has to be called out where it can still be fixed,
 * rather than at the first route request.
 *
 * Lives here rather than in the screen because `nav/engines.ts` needs it for
 * readiness, and importing the app from a nav module would be a cycle.
 *
 * `http` is allowed deliberately: a self-hosted `valhalla_service` on a home LAN
 * is the documented use case and `192.168.x.x` has no certificate. Mixed content
 * is the browser's to report, not something to preempt here.
 */
export function validateEndpoint(raw: string): string | null {
  const value = raw.trim();
  // Empty means "not configured", which the readiness logic reports separately
  // and more usefully. Validating it here would duplicate that message.
  if (!value) return null;
  if (/\s/.test(value)) return 'An address cannot contain spaces.';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return `“${value}” is not a valid URL. It needs to start with http:// or https:// — for example http://192.168.1.10:8002`;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return `“${url.protocol.replace(':', '')}” is not supported. Use http:// or https://.`;
  }
  if (!url.hostname) return 'That URL has no host name in it.';
  return null;
}

/** A custom endpoint is only "configured" if it is also well-formed. */
export function isEndpointUsable(raw: string): boolean {
  return raw.trim().length > 0 && validateEndpoint(raw) === null;
}