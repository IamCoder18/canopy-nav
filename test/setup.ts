/**
 * Test environment shim, run before every spec file.
 *
 * The memory guards read `globalThis.navigator.deviceMemory` (with a
 * `nav && …` guard in the source), but several specs *mutate* that property and
 * assume the `navigator` object exists. Node only ships a `navigator` global
 * from v21; CI runs Node 20, so `globalThis.navigator` is undefined there and
 * `'deviceMemory' in nav` / `nav.deviceMemory = 8` threw — the suite passed on
 * Node 21+ and failed on Node 20 for an environmental reason, not a real defect.
 *
 * Provide an empty `navigator` only when the runtime has none. On Node 21+ (and
 * in browsers) the real `navigator` is left untouched, so behaviour is unchanged
 * where the tests already ran green. An empty object still reports "no
 * deviceMemory", which is exactly the bare-environment case those tests assert.
 */
if (typeof (globalThis as { navigator?: unknown }).navigator === 'undefined') {
  Object.defineProperty(globalThis, 'navigator', {
    value: {},
    configurable: true,
    writable: true,
  });
}
