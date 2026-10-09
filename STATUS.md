# Canopy Nav — Status & Design Record

An Android app that recreates the **Android Auto / Google Maps** navigation UI,
with **fully offline OpenStreetMap routing**.

**Stack:** Capacitor + React 19 + TypeScript + Vite + MapLibre GL
**Repo:** https://github.com/IamCoder18/canopy-nav
**Latest release:** v0.11.3 (APK attached). Main is ahead by five passes, each recorded below:

- **§3.17–3.18** — §3.17 closes the ETA gap this document once called the most dangerous
  readout in the app. **Requirement #10 is implemented**: cross-region routing merges the
  extracts rather than stitching them at a bounding-box midpoint (§3.18), superseding
  §3.5.2's correction.
- **§10** — the audit pass: the service worker, real voice, attribution, and ~20 defects
  found by agents reading the built app in Chromium.
- **§11** — the third pass: focus and announcements, which turned out to be missing almost
  entirely, plus six contrast ratios measured against Google's published automotive numbers.
- **§12** — the engine audit: a priority queue that was not a heap, a parser that could hang
  an import forever, and four leaks.
- **§13** — the boundary pass: everything that crosses a boundary — a network, a disk, a
  service worker, two overlapping requests, a GPS fix — and refuses to be wrong quietly.
  Eleven defects, **three of them corrections to claims this document had been carrying**.
  §14 closes four more, and corrects two claims of this document's own — one of them
  the premise the largest gap in it rested on.
- **§14** — the type-scale pass. Leading was a length and did not scale; the bars'
  heights were constants nobody measured; a warning about being lost was invisible at
  ordinary text sizes; and the detector that was supposed to notice large text watched
  the one value the platform never changes. Along the way it **struck the largest gap in
  this document**, because the premise underneath it is contradicted by Chromium's own
  WebView documentation.
- **§14.16–14.17 + §15** — the memory pass, and the roadmap it opened. PBF now
  streams (it never did, and §14.16 called that the largest piece of engineering left in
  the app — it was much smaller than that); a heap gate refuses imports that would kill
  the WebView; the basemap no longer rebuilds a province at every zoom boundary. And the
  finding that reframed all of it: **Alberta has no sub-regional extracts**, so the fix
  that would have made the problem disappear is unavailable for the province that
  prompted it. §15 is what to do about it, ordered.

Each pass also had to fix defects **it introduced**, which are recorded in §11.5, §12.8 and
§13.6 rather than quietly corrected.

**The most recent pass is the shortest and the most consequential.** It was asked a
question about low-end hardware, and the answer turned out to be structural: a province
extract does not fit in a phone's heap, and the fix that would have made the question
moot — smaller sub-regional downloads — **does not exist for Alberta**, which was the
province in the question. Three things were built anyway (streaming PBF, a heap gate, a
basemap cache) and §15 is the plan for the problem they only partly solve. It is also the
first pass whose main finding is a limitation rather than a defect, and it is recorded as
one.

**The last two passes were both about measurements, and not in the way they were
expected to be.** §13 found six probes measuring something other than what they named,
and §14 found that the "five clipped labels" this document had ranked its largest gap by
were five line boxes shorter than their own glyphs — a defect with a one-line cause that
four passes of reading had not suspected, because the probe's name for it was accurate
and its arithmetic was not. Both passes are recorded with their measurements rather than
their conclusions, and both changed what "done" means here: a number is a claim until it
is re-derived, and a probe's label is not a finding until someone checks what it
evaluated.

**The pass that dominated §13 was not the defects it closed but the four measurements it
found were wrong** — §13.16. Three made the app look worse than it is and one made it look
better, and in every case the probe was measuring something other than the thing it named.
A boundary bug is one that stays quiet at a boundary, and so is a test that stays green
because it was never really testing: both are found by asking what the check actually
evaluated, which a pass or fail result does not tell you.

---

## Table of contents

1. [Everything that was asked for](#1-everything-that-was-asked-for)
   — including row 10, corrected from "Done" to **Not done** (§3.5.2)
2. [Verification state](#2-verification-state)
   — [the gate itself had stopped looking](#21-the-gate-itself-had-stopped-looking--which-is-the-eighth)
   — [a gate recorded as 14/14 that failed one run in four](#22-a-gate-recorded-as-1414-that-failed-one-run-in-four)
3. [Features: what, how, why](#3-features-what-how-why)
4. [Bugs found and fixed](#4-bugs-found-and-fixed)
5. [Architecture decisions](#5-architecture-decisions)
6. [Project layout](#6-project-layout)
7. [Known gaps](#7-known-gaps)
8. [Commands and workflows](#8-commands-and-workflows)
9. [The plan, and what happened to it](#9-the-plan-and-what-happened-to-it)
10. [The audit pass](#10-the-audit-pass)
   — [claims that were false](#101-claims-that-were-false)
11. [The third pass: what a driver actually gets](#11-the-third-pass-what-a-driver-actually-gets)
   — [measured against the published numbers](#114-measured-against-the-published-numbers)
12. [The engine audit](#12-the-engine-audit)
   — [a priority queue that was not a heap](#121-a-priority-queue-that-was-not-a-heap)
13. [The boundary pass](#13-the-boundary-pass)
   — [two more claims this document was carrying, and a third](#132-two-more-claims-this-document-was-carrying-and-a-third)
   — [six probes measured something other than what they named](#1316-six-probes-measured-something-other-than-what-they-named)
14. [The type-scale pass: the last layout defect](#14-the-type-scale-pass-the-last-layout-defect)
   — [the leading was a length, so it did not follow the type](#141-the-leading-was-a-length-so-it-did-not-follow-the-type)
   — [the bars were measured by nobody](#142-the-bars-were-measured-by-nobody)
   — [a warning the driver could not see](#143-a-warning-the-driver-could-not-see)
   — [the alert goes above the instruction](#144-the-alert-goes-above-the-instruction)
   — [what it measures now](#145-what-it-measures-now)
   — [what is still open](#146-what-is-still-open)
   — [the detector was watching for the wrong thing](#148-the-detector-was-watching-for-the-wrong-thing)
   — [the largest gap in this document rested on a false premise](#149-the-largest-gap-in-this-document-rested-on-a-false-premise)
   — [a reroute cannot be refused by moving the driver](#1410-a-reroute-cannot-be-refused-by-moving-the-driver-and-a-reason-that-vanished)
   — [five defects in the regions screen](#1411-five-defects-in-the-regions-screen-from-reading-it-rather-than-running-it)
   — [A\*'s optimality guarantee was void for a different reason](#1412-as-optimality-guarantee-was-void-for-a-different-reason-than-121-fixed)
   — [two more stale claims, and one real gap](#1413-two-more-claims-that-were-stale-and-one-that-is-a-real-gap)
   — [the imported road network was never drawn](#1414-the-imported-road-network-was-never-drawn)
   — [three more, and the shape they share](#1415-three-more-and-the-shape-they-share-with-1414)
   — [two more code defects](#1416-two-more-code-defects-one-of-which-is-the-largest-thing-found-in-this-pass)
   — [the guard's refusal said nothing](#1418-the-guards-refusal-said-nothing-and-153s-coverage-found-it)
   — [driving the guard through the UI](#1419-153-item-9--driving-the-guard-through-the-ui-and-what-it-cost)
   — [the crop, and a guard that refused it anyway](#1420-the-crop-and-a-guard-that-refused-it-anyway)
15. [The roadmap](#15-the-roadmap)
    — [Make the biggest extract that fits actually fit](#151-make-the-biggest-extract-that-fits-actually-fit)
    — [Make the delivery path work on device](#152-make-the-delivery-path-work-on-device)
    — [Verification](#153-verification-what-has-not-been-run-and-the-gate-that-should-catch-it)
    — [UI and UX polish](#154-ui-and-ux-polish)
    — [The drive simulator — a debug setting](#155-the-drive-simulator--a-debug-setting)
    — [Process, for whoever picks this up](#156-process-for-whoever-picks-this-up)

---

## 1. Everything that was asked for

This is the full list of requests made during the project, and where each one
stands. **Bold** = fully working and verified.

| # | Request | Status | Where |
|---|---|---|---|
| 1 | Android app using Expo **or** Capacitor — agent's choice | **Done.** Capacitor chosen (§5.1) | — |
| 2 | Visually mimic an Android Auto screen as closely as possible | **Done.** AAOS design tokens taken from Google's published specs. App bar and grid cell are now real tokens rather than CSS literals (§3.14) | `src/theme.ts` |
| 3 | Prefer TypeScript | **Done.** ~10,400 lines TS/TSX. Exactly one hand-written Java file on Android (`MainActivity.java`, immersive mode only) plus XML themes; everything else is TypeScript | `android/` |
| 4 | Other libraries allowed (e.g. Ferrostar) | Considered and rejected — Ferrostar duplicates what the built-in engine does and adds no offline win here | §5.2 |
| 5 | Support `.osm` files | **Done.** Both formats read natively: XML via a chunked scanner, `.osm.pbf` via a protobuf reader. The PBF coordinate bug (§4.1) meant this was *not* working for real extracts until this revision | `src/osm/engine.worker.ts`, `src/osm/pbf.ts` |
| 6 | Use Valhalla for car navigation | **Done** as an optional provider; **not** the on-device default (§5.3) | `src/nav/valhalla.ts` |
| 7 | Use Nominatim for geocoding start/destination | **Done** as an optional online provider | `src/nav/geocode.ts` |
| 8 | 100% local, no WiFi | **Done.** Offline engine, offline gazetteer, offline map rendering, offline persistence | §3.2–3.4 |
| 9 | Multi-region: download by city/province (Alberta, BC…), route between them | **Partly done.** Download, streaming, catalogue and cross-region *search* all work. **Cross-region routing does not route correctly** — it stitches at a bounding-box midpoint rather than merging; see row 10 and §7 gap 1. **And province-scale extracts no longer import at all** — Alberta is 334 MB with no smaller alternative, and the heap guard refuses it (§7 gap 13, §15.1) | §3.5 |
| 10 | Merging the two regions rather than stitching | **Done.** `merge.ts` is now called. Cross-region routing is one A\* over a merged graph, cached per region set, behind a memory guard that refuses with a reason rather than returning a wrong line. Requirement was previously recorded as **NOT DONE**; §3.18 is the implementation and §3.5.2 is superseded | `src/osm/regions.ts`, `src/osm/mergeguard.ts` |
| 11 | Is self-hosting Valhalla on Android unreasonable? | Answered: not unreasonable, but not achievable in the time available (§5.3) | — |
| 12 | Keep hosted Valhalla as an option | **Done.** Three hosted presets plus a custom endpoint — FOSSGIS, Simplerouting.io, and your own `valhalla_service` — each individually selectable and probeable, alongside the offline engine | §3.6, §3.6.1 |
| 13 | Handle losing connectivity mid-trip | **Done.** Provider chain + snapshotted route + honest degradation | §3.7 |
| 14 | GitHub repo (public) | **Done** | [repo](https://github.com/IamCoder18/canopy-nav) |
| 15 | CI that builds a release with the APK on tags | **Done.** 15 releases, APK attached automatically (v0.1.0 was uploaded by hand) | `.github/workflows/release.yml` |
| 16 | Small increments: one fix/feature per release | **Done.** 17 tags, 15 releases | §8 |
| 17 | Unit tests for everything; subagents for tests and browser verification | **Done.** 1189 unit tests across 60 files, plus 5 browser suites and one browser gate | `test/`, `tools/` |
| 18 | Every screen and function verified in real Chromium at mobile size | **Done for what the suites cover.** 10 screens at 3 viewports (50 checks each, 150 total), plus 39 e2e checks covering engine selection, provenance, a streamed import and the full off-route reroute flow — the last being the gap this requirement once named as uncovered. Not covered: cross-region routing (§7 gap 1), and the emulator is not a phone | `test/screens.mjs` |
| 19 | Keep going until every issue fixed | **Ongoing.** See §7 for the gap list and §9 for what has actually been built and what has not, including the fixes that measurement contradicted | — |
| 20 | Host on 0.0.0.0 so it can be tested | **Done.** `npm run serve` (`tools/serve.mjs`), in the repo rather than `/tmp`; APK served at `/dl/canopy-nav.apk` | §3.14 |
| 21 | Update STATUS.md continuously | **This document** | — |

---

## 2. Verification state

| Gate | Command | Result |
|---|---|---|
| Types | `npx tsc --noEmit` | clean |
| Lint | `npm run lint` | **0 errors**, 27 warnings (ratchet — see §10.3) |
| Unit tests | `npm test` | **1189 passing**, 60 files |
| End-to-end | `npm run e2e` | **69 checks** against the built bundle — +11 for the memory guard, +2 for the crop (§14.19, §14.20) |
| Screen coverage | `node test/screens.mjs` | **53 checks × 3 viewports = 159** (phone-portrait 412×915, phone-landscape 892×412, head-unit 1280×720) |
| Focus & keyboard | `npm run focus` | **15 checks** in a real browser |
| Document audit | `npm run status` | every `wc -l`, cross-reference, current total, browser-gate figure and `npm run` in this file, checked against disk |
| Offline shell | `npm run swshell` | a captive portal answered 2 navigations, then the network went off: the app still boots, 5 launcher tiles |
| Reflow at large text | `npm run reflow` | **12 checks, all passing** — was 3 failing at the start of §14 |
| Text-scale detection | `npm run textscale` | **13 checks** — the large-text layout switches on for every way a platform can scale text (§14.8). Was recorded as 14 and as passing; it failed **3 of 12 runs** (§2.2) |
| Bundle budget | `npm run bundle` | entry 112.0 kB / 130, initial 117.5 / 150, largest 282.0 / 300, total JS 417.8 / 460 (gzip) |
| Offline cold start | verified in-browser | reload with the network off renders the app: 5 tiles, map sized, 0 console errors |
| Release | v0.11.3 tag | **CI green, Release green**, APK attached |
| APK | `npm run apk` | debug APK, `com.canopy.nav`, minSdk 23, targetSdk 35 |
| Device | Android 14 emulator, API 34, 2340×1080 | installs, runs, **zero console output**, real GPS confirmed |

The e2e count moved from 39 to 44 in §10 and to 46 in §13; the screen count from
150 to 153 in §10 and 159 at the last re-derivation. The lint and bundle rows are
*gates*, not new measurements: before §10 nothing failed when the entry chunk grew
or when a hook dependency went stale, because nothing was watching. The offline
shell row is a gate for the same reason and was added in §13: the defect it covers
is invisible to every other suite, because every other suite assumes the app
opens.

**The unit-test count in this table was wrong in the previous revision** — it
read 828, which was accurate for the §12 revision, and 792 before that. The 828
was right; the *table* was not, because two rows above it still said 792. Both
numbers were in this file at once, which is the error this section is about.

**Every count in this table is measured**, by counting `PASS` lines from an
actual run or by counting call sites in the source. Three figures in this
document were wrong at some point, and each time the error was the same shape: a
number written down once and never re-read.

- The e2e count was recorded as 23 when it was 33.
- The screen-coverage figure was recorded as "29 checks × 3 = 87", which no
  configuration could produce. `screens.mjs` calls `visit()` 11 times per
  viewport, and each visit emits 3 checks, plus 2 standalone ones: 35 per
  viewport, 105 on the all-pass path at the time; it now runs 50 per viewport, 150
  in total, after the navigation controls gained coverage (§4.8).
- **The screen suite was running at 42 checks, not 105**, across a month of
  commits, because of a regression described in §9. It reported "all checks
  passed" the entire time. This is the same failure mode as §3.16's red CI runs:
  a green result nobody re-derived is not a green result.

That third one matters most, because the gate that exists to catch layout bugs
was silently visiting four screens instead of eleven — and when it was restored
it failed immediately, exposing three real 412dp overflow bugs (§4.6).

**Note on the device gate — superseded.** This section previously recorded three
`Expected value to be of type number, but found null instead` warnings on every
cold start, noted as pre-existing and traced to nothing. They have since been
diagnosed and fixed.

**How they were found.** A subagent was given the symptom, the constraint that it
was pre-existing (proved earlier by rebuilding the v0.11.1 baseline APK and
diffing logcat), and the instruction that a negative result with evidence was a
fine answer. It captured the console location, then served controlled variants
of the upstream style to isolate the offending layers one at a time.

**What they were.** Never app code. MapLibre's expression parser throws when an
order comparison (`<`, `<=`, `>`, `>=`) compares an untyped `["get", …]` against a
number and the property is absent, then `StyleExpression.evaluate` catches it and
logs the message — once per layer, on the first tile containing such a feature.
Three layers in OpenFreeMap's `liberty` style do exactly that:
`highway-shield-non-us`, `highway-shield-us-interstate` and `road_shield_us`, all
filtering on `["<=", ["get", "ref_length"], 6]`. A named road with no route ref
has no `ref_length`. The filter result was correct throughout; only the log was
noise, but it read as a fault in this app on every launch.

**The fix** (§3.15) guards those comparisons in `buildStyle`. Verified at **0**
occurrences in Chromium after panning and zooming through dozens of tiles, against
3 before. The device gate above is now genuinely clean: `adb logcat` filtered for
`Capacitor/Console`, `AndroidRuntime` and `FATAL` returns **nothing at all** on a
cold start, where the same filter previously returned three warnings per launch.
That was the last known console output in the project.

### Test breakdown

Every count below is measured by counting `PASS` lines from a run, grouped by file, not
retyped by hand. The table is the complete set: **60 files, 1189 tests**. The previous
revision's table listed 24 of 38 files and carried several stale counts.

**One count here is 47 and it owns only 13 tests.** `attribution.spec.ts:29` is
`import { contrast } from './contrast.spec'` — it imports the *spec file*, so vitest
collects contrast's `describe` blocks into attribution's run **whether or not the run is
scoped to attribution**. Run attribution alone and it reports 47; run the whole suite and
it reports 47; count its own `it(` calls and there are 13. `13 + 34 = 47`.

This was established by subtraction rather than assumed, and the table carries the number
the audit compares against — the **run's** count, not the file's own. The consequence is
that **the 1189 total double-counts contrast's 34 tests**: 1155 distinct test cases are
declared across 60 files. Both figures are recorded rather than reconciled by lowering the
total, because `tools/status-audit.mjs` checks the sum a run reports and a "corrected"
total would fail it for the right reason on the wrong number.

**A gate that passes for the wrong reason, recorded because it happened.** Writing
`13` — the honest per-file count — makes `npm run status` report
`§2 breakdown counts attribution.spec.ts at 13, the run has 47` with `VITEST_JSON` set.
That FAIL is not a bug in the gate and the "fix" is not to make the file's own count
appear; it is a real disagreement between two defensible numbers, and the one that belongs
in a column labelled "tests in this file's run" is the run's.

**The audit's own hint was wrong twice, and the correction was also wrong.** It printed
`VITEST_JSON=/tmp/r.json npx vitest run --reporter=json`, which writes JSON to *stdout* and
therefore does not work under vitest 3.2. This note then "corrected" it to
`--outputFile=/tmp/r.json` alone — **also wrong**, and it was wrong in the same direction:
`--outputFile` only takes effect once a reporter is selected, so the command writes the
*default* reporter's output to that path and produces no JSON at all. Both flags are
required:

```bash
npx vitest run --reporter=json --outputFile=/tmp/r.json && VITEST_JSON=/tmp/r.json npm run status
```

Measured rather than inferred: `--outputFile` alone leaves no file behind, and the audit
prints the same "no vitest JSON report found" it printed for the first wrong form — so the
second "fix" would have been as invisible as the first. That is a correction of a
correction, and the only reason it was caught is that this pass ran the hint rather than
reading it.

| File | Tests | Covers |
|---|---|---|
| `geo.spec.ts` | 67 | polyline codec and every refusal case, haversine, bearing, formatting boundaries, `simplify`, `snapToPolyline` |
| `regions.spec.ts` | 64 | `RegionLibrary`, bbox helpers, `catalogFor`, `searchAll` ranking, `bestFor`, cross-region routing |
| `providers.spec.ts` | 46 | provider chain, fallback, `requiresKey`, 4xx handling, `localToRoute` bbox reduction |
| `valhalla.spec.ts` | 46 | request body, headers, response parsing, multi-leg, unit normalisation, a response missing what it needs |
| `engines.spec.ts` | 38 | engine selection policy, plan ordering, per-engine readiness reasons, the attempt trace, strict mode |
| `merge.spec.ts` | 37 | node-ID union, direction permissions, dead-edge sweep, >2^21 node regression |
| `download.spec.ts` | 37 | streaming, progress, abort, retry/resume, HTML-error detection, truncation, disk cache, poisoned part files |
| `engine.spec.ts` | 35 | OSM parsing, graph construction, one-ways, A\* route quality, geometry continuity, index isolation and keying, and that `buildDataset` consumes its inputs |
| `contrast.spec.ts` | 34 | every ink token against every dark surface, printed as a table |
| `stream.spec.ts` | 30 | streaming XML parse ≡ whole-file parse across chunk sizes, incl. 1-char and seeded fuzz |
| `geocode.spec.ts` | 29 | throttle serialisation and 1 req/s spacing, viewbox, place mapping |
| `progress.spec.ts` | 29 | the three ETA properties as properties: monotone, never zero before arrival, last-good-kept |
| `settings.spec.ts` | 29 | every setting round-trips, a malformed endpoint is not "Ready", quota failures reported |
| `audit-regressions.spec.ts` | 33 | source-level guards for the §10/§11 defects, each verified to fail when reintroduced, and the multi-zoom basemap shape |
| `xmlentities.spec.ts` | 24 | entity expansion structurally impossible; hostile documents terminate |
| `reroute.spec.ts` | 23 | off-route confirmation window, storm guards, backoff growth, tracker reset semantics, banner content |
| `persist.spec.ts` | 22 | typed-array round-trip, quota errors, corrupt records, rehydration |
| `staleposition.spec.ts` | 21 | the stale-position guard, and the driver-moving-away case it used to refuse (§13.4) |
| `errorboundary.spec.ts` | 20 | a render throw shows a recovery card rather than a blank screen |
| `mapstyle.spec.ts` | 20 | offline style LOD: every line layer has a low-zoom floor, arterials branch on class |
| `requests.spec.ts` | 19 | `RequestGate`: supersession, cancellation, and that an abandoned request writes nothing |
| `shellcheck.spec.ts` | 18 | the service worker's shell predicate, and that the fetch handler consults it |
| `import.spec.ts` | 21 | a bad file is refused and never replaces a working map, and that the memory guard gates the import and `forceMemory` overrides it |
| `navigation.spec.ts` | 17 | off-route detection, speed-scaled thresholds, traffic verdicts |
| `serve.spec.ts` | 16 | test-server path containment and no side effects on import |
| `renderzoom.spec.ts` | 14 | zoom LOD re-application and reduced motion |
| `reroute-backoff.spec.ts` | 14 | backoff growth to its cap |
| `reroute-gate.spec.ts` | 7 | backoff and request sequencing together: an abandoned retry leaves no trace, a real failure leaves one |
| `textscale-layout.spec.ts` | 13 | the type scale's leading is a multiplier, the bars are measured not assumed, and the alert precedes the instruction |
| `chrome.spec.ts` | 10 | the bar-height observer: it publishes, it republishes on a resize, it cleans up |
| `textscale.spec.ts` | 16 | the large-text detector sees either way a platform can scale text |
| `reroute-reason.spec.ts` | 11 | a failed reroute keeps saying why, for as long as the driver is lost |
| `mirror.spec.ts` | 25 | the download mirror's allowlist: host, path shape, extension, and every trick it refuses |
| `attribution.spec.ts` | 47 | the ODbL credit is present, well-formed, and not re-suppressed. **This file's own 13 tests plus the 34 of `contrast.spec.ts`**, which it imports at line 29 — see the note above this table |
| `mergeguard.spec.ts` | 13 | merge memory guard: three outcomes, the boundary at ratio 1, scaling with region count |
| `reroute-failure.spec.ts` | 13 | a failed reroute leaves the route and its guidance alone |
| `catalogue-row.spec.ts` | 8 | the unavailable reason is one line until asked otherwise, and reachable without a mouse |
| `probebound.spec.ts` | 6 | the catalogue probe is bounded, and every entry reaches a verdict |
| `steps.spec.ts` | 8 | why the turn list is empty — three causes, three honest explanations |
| `pbfcrop.spec.ts` | 12 | the crop: a cropped parse equals the unfiltered one restricted to the same box, on both readers and against the XML parser; a road leaving the box splits into runs rather than joining across the gap |
| `worker-crop.spec.ts` | 5 | the crop across all three seams: `engine.ts`'s postMessage, both of the worker's PBF paths, and the reader's filter — driven through the worker's real `onmessage` handler, with a `Worker` stub for the message |
| `pbf.spec.ts` | 28 | PBF vs XML parser equivalence on a hand-built file and the whole fixture; **the streaming reader** against the whole-file one at every chunk size, starvation, bounded read-ahead, and the same corrupt inputs |
| `theme.spec.ts` | 13 | `theme.ts` ↔ `styles.css` token-name agreement, fallbacks present, no bare literals |
| `importguard.spec.ts` | 25 | the import memory guard: pinned constants, three outcomes, the ratio-1 boundary, an assumed budget is never unlimited, monotonicity across the whole size range, and a refusal that names a way out (§15.2) |
| `basemapcache.spec.ts` | 14 | the offline basemap LRU: several zooms resident, zoom-independent layers built once, eviction order, dataset isolation (§15.4) |
| `reroute-strict.spec.ts` | 9 | strict mode bounds the plan rather than aborting it |
| `styletiles.spec.ts` | 9 | tile-style order-comparison guard: the actual shield filter, idempotency |
| `basemap.spec.ts` | 6 | a basemap substitution is reported rather than silent |
| `astar-admissible.spec.ts` | 6 | A\*'s heuristic is admissible: the returned route is the cheapest by **time**, checked against Dijkstra on the real fixture |
| `strict-plan.spec.ts` | 6 | `strict` constrains the plan, not the walk — and the two docstrings now agree |
| `mapsources.spec.ts` | 6 | every source id the app writes to is one the style declares — a layer id is not a source id |
| `threshold-prose.spec.ts` | 11 | the numbers a comment states, so a comment cannot disagree with the code quietly |
| `stream-progress.spec.ts` | 10 | streaming progress without a size hint, and four comments that had drifted — including the one that claimed PBF was never streamed, which is now false |
| `minheap.spec.ts` | 6 | the heap invariant, plus the broken implementation kept and asserted to fail |
| `pbfgeo.spec.ts` | 6 | absolute coordinates against the PBF spec, via the real encoder |
| `streamscale.spec.ts` | 6 | the streaming parse holds a small multiple of the document, not the document |
| `tdz.spec.ts` | 5 | no `useMemo` in `App` closes over a binding declared later |
| `app-render.spec.ts` | 4 | `App` renders; the root landmark is labelled and names the current screen |
| `icons.spec.ts` | 4 | every maneuver kind renders distinct geometry |
| `status-audit.spec.ts` | 18 | STATUS.md checked by mutating it: a stale figure in every place one is stated, a dead anchor, a wrong `×`, and the limit — it cannot read a claim for truth |

Browser gates, measured the same way:

| Suite | Checks | Command |
|---|---|---|
| `test/e2e.mjs` | 69 | `npm run e2e` |
| `test/screens.mjs` | 159 (53 × 3 viewports) | `npm run screens` |
| `tools/focus.mjs` | 15 | `npm run focus` |
| `tools/sw-shellcheck.mjs` | 1 (offline boot after a captive portal) | `npm run swshell` |
| `tools/reflow.mjs` | 12 passing — a diagnostic, §12.7; green as of §14 | `npm run reflow` |

**Seven counts in this document have now been wrong at least once, and each was wrong the
same way.** The e2e count (§2). The screen figure, recorded as both "29 × 3 = 87" and "50 × 3
= 150" in different sections of *this* file while the true value was 51 × 3 = 153 — §2 was
right and §6 and §9.2 were stale, which is the more awkward direction, because the correct
number was sitting in the document the whole time. And the unit-test total, which sat at 702
through three commits that added 53 tests.

The fifth, in this revision, is the one that makes the other four legible: **§2 and the
breakdown table below carried two different totals at once** — 792 and 828 — because each
was correct when written and only one was re-read. A number that is written once and never
re-derived is a claim, not a measurement, and every one of these was found by re-running
the gate rather than by reading harder.

That is now mechanical rather than aspirational: the breakdown table is generated from
`vitest --reporter=json` grouped by file, the browser counts are counted from `PASS`
lines of an actual run, and `npm run status` checks the whole document against disk.

**That gate exists because this file was found wrong six times**, and its limit is
worth stating so it is not over-trusted: it checks *forms*, not *claims*. Every count
in it has been wrong at some point while sitting in the right format. What caught
those was re-deriving, and three of the corrections in §13 came from a measurement
rather than from a gate — a polyline that could not produce the `NaN` it was blamed
for, a field that was never persisted, and a "0-gap collision" that was an 8px gap.
A check that cannot read prose for truth is worth having and is not sufficient.

The sixth is the one that should have been caught by that: this revision's first pass at
the numbers left §2 saying 904 while the table said 901, because the two were edited in
separate steps and only one of them was re-read. The machinery above reduces the cost of
that error; it does not remove the need to look.

The seventh is the one the gate **missed**, and that is why the gate grew. §6 said 17
focus checks; §2 and §8 said 15, and 15 was right — counted off an actual run. Two of
the three figures in the document agreed with each other and were both wrong, which is
the one configuration a value check cannot see and a *disagreement* check catches
immediately. Nothing about that failure was subtle; it was that no check existed for
the shape of error that had just occurred twice already.

Two further claims have since turned out to be wrong about *code* rather than about a
number, and both are recorded where they were stated: §14.10's note that a serialiser
branch was "currently unreachable" when a test covers it, and §14.9's premise about how
Android delivers a font setting, which Chromium's own documentation contradicts. The
shape is the same and it is the shape §13.16 is about: **a claim, written once, about
something nobody re-reads.** What is new is that two of the six were about code, which
no amount of testing the code would have caught.

Writing that new check produced two more instances of the fault it exists to catch,
both inside twenty minutes. It first excluded historical figures by paragraph, and a
prose note three rows above the §2 table — about a count being wrong *in the previous
revision* — hid a genuinely wrong e2e figure two rows below it. Then it bound each
gate's name to its number, after the first version attributed one gate's count to
another: a single line carrying both a historical e2e count and the screens figures
gave the *screens* gate the e2e number, because both names appear on it. A check is
code, and code written once and never seen to fail is exactly as much a claim as a
number written once.

Which is why this paragraph, and §13.16, both describe the failures without quoting
the stale figures verbatim: reproducing the pattern in order to explain it puts the
pattern back into the document, and the check is right to object.

### 2.1 The gate itself had stopped looking — which is the eighth

The failure above is why `npm run status` grew a *disagreement* check: two figures in this
file can both be wrong the same way and agree with each other, which no value check can
see. This pass found that the disagreement check, and the totals check beside it, had
**both been reading nothing at all** — and had been reporting green while they did.

**The totals check matched exactly three digits.** Every pattern reading this file's
unit-test total was written `(\d{3})`, and the total was 828 when they were written. When
the suite passed 1000 tests they all stopped matching at once: `(\d{3})` consumed the
first three digits of a four-digit total and the pattern then demanded a space where the
fourth digit was, so the match failed. No error, no changed output, no warning. The
functions returned empty arrays, and **a check over an empty list agrees with itself** —
so `one(unitTotals, …)` was comparing `[]` against `[]`, finding no disagreement, and
succeeding at the one thing it exists to detect.

**The browser-gate check could only see a bold table cell.** Every pattern was written
against the §2 table's `**55 checks**` form or one prose phrasing. §6's layout block and
§8's command block state the same figures in monospace, and neither was readable. So two
sections carried a stale e2e figure while §2 carried the right one — a wrong count, twice,
in the part of the document that exists to check counts.

Both are one defect, and it is the defect this section is written about: **a check that
cannot see the thing it names.** "No matches" and "no problems" are indistinguishable in
the output and in review, which is why neither could be found by reading the audit's
source. What found them was substituting one figure in a copy of this file and asking
whether the audit objected — so `test/status-audit.spec.ts` (18 tests) now does exactly
that: break one thing, require a complaint, and assert the exit code as well as the text.
All four of its central assertions were each **verified to fail** with the corresponding
fix reverted: the three-digit width, the code-block patterns, the complaint that an anchor
matching nothing is itself a problem, and the leading-indent requirement that had been
excluding every `tools/` row. That last one is the same defect a third time, and it was
visible in the source on sight — `^\s{2,4}` against a table whose `tools/` rows are not
indented. Nobody looked, because the output said "all checks passed".

**And writing it reproduced the fault it exists to catch, which is why its own anchors are
derived rather than written.** The suite hardcoded the total in the strings it substitutes
into this file — and six of its eighteen tests failed with `anchor appears 0 times` the
moment the total moved. A figure written once into a test, never re-derived, failing in
exactly the way the document is written about. So the total is now read out of this file at
run time, every anchor interpolates it, and the mismatch error says outright that a moved
figure is the likely cause.

That is the ninth wrong count in this document's history and the first to arrive *inside the
machinery built to prevent them*, which is a fair summary of the difficulty. It is also why
this subsection is longer than the fix it describes: the fix is three regexes and an anchor
list, and the reasoning is the part that will still be needed.

**It paid for itself at once, by finding an eighth wrong figure that predates this pass.**
(That is the eighth; the one above it is the ninth.)
§11.7 says **17** focus checks where §2, §6 and §8 all say 15, and 15 is right — counted
off an actual run. The seventh failure above *is* a stray 17 for this same gate, and §2
records that the original one lived in §6 and was fixed there, so this is a **third**
copy, surviving for the same reason the others did: two readers of it agreed, and one said
"keyboard and focus checks" where the others said "keyboard/focus" — a phrasing no pattern
matched. The gate built to catch that class had never been able to read any of the three.

The honest limit, now asserted rather than assumed: this catches *forms*. The new suite
includes a case proving it cannot catch a claim — rewriting a sentence to say the opposite
of the truth still passes, and the test says so in its own body rather than implying a
strength it does not have. A check that cannot read prose for truth is worth having and is
not sufficient, and this section's whole history is the argument for that sentence.

### 2.2 A gate recorded as 14/14 that failed one run in four

Running the gates rather than reading them turned up something the tables above had
recorded as clean. `npm run textscale` is a **gate** — it is in `npm run status`'s own
reasoning, it is a required row in the table above, and it was written to prove §14.8's
central claim, that the app notices a text scale delivered *either* way. Measured across
twelve consecutive runs: **three failed.** The §2 row said "**14 checks**", green, and
that row had been carried without a re-run.

**What it was reporting.** Not a product failure. Three checks failed with
`eta-value is (none)` and `eta-bar flex-wrap: (no navigation screen)` — that is, *the
navigation screen was not there*. `openNavigating()` drove the app there through a chain
of fixed sleeps:

```
click .search-field  →  wait 400ms  →  fill search
   →  wait 1000ms  →  click .result-row  →  wait 2000ms
   →  click button.primary-btn  →  wait 1200ms
```

On a loaded machine the search screen had not opened at 400 ms, `.fill` threw, and — this
is the part that mattered — the throw was swallowed by a `.catch(() => {})` on the line
above. The run continued down a path that silently did nothing and reported the *absence
of the element it had never reached* as though the app had failed to apply its
large-text layout.

**So the gate was reporting a harness failure in the vocabulary of a product failure**,
which is worse than being broken, because it names the wrong thing to fix. §13.7 is about
exactly this — a harness failure and a product failure must be distinguishable from
outside — and this file cites §13.7 in a comment thirty lines above the code doing it.

Four changes, in the order the reasoning required:

1. **Every sleep became a wait.** `waitForSelector` for the search input, the result row
   and the Start button, each with its own timeout. The sleeps were standing in for waits
   that were never written.
2. **Each step reports which one ran out.** "never reached the navigation screen" is a
   symptom; `no result row appeared for "Elbow"` is a diagnosis, and a harness failure you
   cannot localise gets re-run rather than read.
3. **The precondition is asserted**, not assumed: `waitForNavigationScreen` requires both
   an ETA bar *and* a laid-out ETA value, because `attached` alone would let a zero-size
   box satisfy it.
4. **Harness failures are counted separately** and printed under their own heading. When
   the harness misses, the dependent checks are `SKIP`ped rather than `FAIL`ed — a green
   gate that measured nothing is the worst outcome available, so that state is now
   unreachable.

Measured after: **12 of 12 runs green**, against 9 of 12 before. And the fix is not merely
"less flaky" — verified against a deliberately broken `src/textscale.ts` (the detector
pinned to `normal`), where the gate reports **6 product failures naming the real cause**
and zero harness failures. A gate that stops firing when the thing it watches is broken is
worse than the flaky version, so that reversal is the check that matters.

The count also changed, and the document was carrying the wrong one: it is **13 checks**,
not 14. Same class as everything else in this section, which is why it is recorded here
rather than quietly edited.

---

## 3. Features: what, how, why

### 3.1 Android Auto UI recreation

**What.** An Android Auto / Automotive OS interface: launcher-style home screen,
search, route preview, turn-by-turn navigation with an ETA bar and maneuver
banner, steps list, settings, and an offline-map screen.

**How.** `src/theme.ts` encodes the design system as typed tokens, taken from
Google's published *Design for Driving* documentation:

- **Colour.** The AAOS grayscale palette (`#0E1013`, `#17181B`, `#202124`,
  `#282A2D`, `#3C4043`, `#5F6368`, `#9AA0A6`, `#E8EAED`, `#F1F3F4`) and the
  elevation ramp, night mode: `+1 #0E1013`, `+2 #17181B`, `+3 #202124`. Accent
  `#60A8F0`.
- **Layout.** The 8dp grid; padding scale `P0–P8` = 4/8/12/16/24/32/48/64/96dp;
  keylines `KL0–KL4` per width class; side margins = 12% of app working space.
- **Type.** Full scale — Display 1–3, Body 1–3, Sub 1–3 — following the AAOS rule that
  Roboto is used below 32dp and Google Sans at 32dp and up, with bold avoided in
  favour of Medium.
- **Components.** 76dp minimum touch target, 44/36/24dp icon sizes, 116/128dp
  list rows and `R2`=8dp / `R4`=full corner radii are tokens in `theme.ts`. The
  96dp app bar and 158dp minimum grid cell were CSS literals in `styles.css` and
  are now `STRUCTURE.APP_BAR` / `STRUCTURE.GRID_CELL` (§3.14), published as CSS
  custom properties with literal fallbacks so a missing token cannot collapse the
  layout.

Icons are hand-drawn SVG (`src/icons.tsx`) — 29 maneuver kinds covering
slight/sharp turns, U-turns, ramps, forks, exits, roundabouts, ferries and
arrival, plus system icons.

**Why.** Reading the real spec rather than eyeballing screenshots is what makes
the result defensible, and it means the layout adapts by documented rules
instead of hardcoded magic numbers. Hand-drawn icons avoid shipping Google's
proprietary assets while matching their visual language.

### 3.2 Offline OSM pipeline

**What.** Import an `.osm` (XML) or `.osm.pbf` (protobuf) extract and get a
routable road graph, a searchable gazetteer, and renderable map geometry — with
no network.

**How.** `src/osm/engine.worker.ts` runs in a Web Worker and does four things:

1. **Parse.** Both formats, whole or streamed (§3.12). XML via a streaming regex
   scanner; PBF via
   `src/osm/pbf.ts`, a protobuf reader handling BlobHeader/Blob framing, zlib
   inflation through `DecompressionStream`, and DenseNodes delta decoding.
   The format is sniffed from the file's first 16 bytes in the *client*
   (`src/osm/engine.ts`), before the worker is told which format it has, and
   falls back to the extension only if the bytes are inconclusive. Both formats
   arrive through the same picker, which is why the bytes are the primary signal.
2. **Build a graph.** Nodes on routable ways become vertices; directed edges
   carry `travel_seconds` and a permission flag pair. Speeds come from a table
   matching Valhalla's `auto` defaults. One-ways, `access` and `maxspeed` are
   honoured.
3. **Compact.** Pure-geometry nodes (park boundaries, watercourses) are stripped,
   leaving only the connected core — otherwise a province reports millions of
   spurious "disconnected components".
4. **Index.** A nested-`Map` spatial hash over cell indices for O(1) nearest-node
   lookup.

Separately it builds a **gazetteer**: place nodes, named POIs, streets, and
`addr:housenumber`/`addr:street` pairs, plus *interpolated* house numbers
placed along each street roughly every 25 m, so "123 Main St" resolves.

**Why.** The Worker keeps tens of seconds of parsing off the UI thread. Sniffing
the format from bytes rather than the extension means a mislabelled file still
works. Compact-then-index keeps memory and component counts honest. House-number
interpolation is what turns "search a place" into "search an address".

### 3.3 Offline routing

**What.** A\* over the parsed graph producing a route, a distance, a duration,
and a per-street step list.

**How.** Unidirectional A\* with three deliberate choices:

- **Costs are travel seconds**, not distance, so the heuristic is a
  straight-line distance divided by an optimistic speed — admissible, so the
  result is optimal.
- **Pass-through nodes carry a 6-second penalty**, which biases the frontier onto
  real junctions and is what makes it fast on dense networks.
- **Flags mean "direction permitted"** and are set, never masked.

The fixture is a 9×9 Manhattan grid, so the shortest *distance* between two
corners is hand-computable and is what `engine.spec.ts` asserts against (a
metre bound, both above and below the optimum). **No test asserts a duration.**
An earlier version of this document claimed a figure of 860.4 s was "asserted
against a hand-computed bound"; there is no such assertion and no such number in
the repo, so the claim has been removed rather than softened. There is also no
separate Dijkstra reference implementation to check optimality against, which is
the honest limit of what is verified here: the distance bound is a sanity check
on a grid, not a general optimality proof.

**Why.** Bidirectional A\* was implemented first and rejected. Its search found
the correct optimum but its reconstruction returned a 3-point path with a 0.042°
teleport — the `h/2` termination fired early and the two halves were stitched
without verifying they connect. A valid-but-broken path is far worse than a
slower correct one, so it was replaced. The code and comments record this so it
isn't retried blindly.

### 3.4 Offline search

**What.** Find cities, streets, addresses, POIs and amenities by name.

**How.** An in-memory gazetteer ranked by match quality (exact > prefix >
substring), then category importance, then distance. A category-chip row is
derived from what the downloaded map *actually contains*, so it only offers
questions the data can answer. With more than one region loaded, every gazetteer
is searched and each hit is labelled with its region.

**Why.** Purely in-memory and synchronous, so results appear instantly with no
network. Deriving chips from the data avoids offering a category that would
return nothing. Labelling by region stops a distant hit looking identical to one
underfoot.

### 3.5 Multi-region

#### 3.5.1 Download

**What.** "Download Alberta" — fetch a real Geofabrik extract.

**How.** `src/regions/download.ts`:

- **Streams** with `response.body.getReader()`; chunks are retained and progress
  reported from the byte count. A province `.osm.pbf` is 100–900 MB and
  `arrayBuffer()` on that OOMs a phone.
- **Sniffs the format** from the first 512 bytes (never judging on fewer than
  16) and separates OSM XML from an HTML page. A URL that 404s, sits behind a captive portal or a sign-in wall
  answers with HTML; feeding that to the parser yields a baffling error, so it
  is rejected up front with a message naming the cause.
- **Derives the filename** from the sniffed format, not the URL.
- **Retries** resume with `Range`/`If-Range`, reusing bytes already held.
  Retryable: network drop, truncation, 408/429/5xx. Not retryable: 404, bad
  payloads.
- **Checks free space** up front via `navigator.storage.estimate()` and refuses
  early rather than failing at 80%.
- **Caches** the finished extract through Capacitor Filesystem (native only) so a
  later launch works offline, and clears it when the region is removed.

The Regions screen probes each catalogue URL and greys out dead ones, shows
byte-accurate progress with an explicit "size unknown" when `Content-Length` is
absent, and offers Cancel.

**Why.** Streaming is the only way a phone survives a 900 MB download. Detecting
HTML is the difference between "couldn't reach it" and a parser crash. An absent
content length shows as unknown rather than a fake 0% that reads as stalled.

#### 3.5.2 Merging — how cross-region routing actually works

**Superseded.** This subsection used to be a correction: the merge existed, was
correct, was thoroughly tested, and the app never called it. It is now wired in.
The implementation is §3.18; what follows is kept because the *shape* of the old
bug is the most useful thing in this section, and because the test fixture that
could not detect it is still the most instructive artefact in the repo.

**What used to happen.** `src/osm/merge.ts` was imported by three spec files and by
nothing in `src/`. Cross-region routing went:

```
RegionLibrary.route()  ->  plan()  ->  boundaryPoint(a, b)
                                     |
     routeIn(regionA, origin, mid)  +  routeIn(regionB, mid, destination)
                                     |
                     concatenate geometries, sum metres and time
```

`RegionLibrary.route()` returned `{ ..., stitched: true }` for this path — the code
named what it was doing.

**Why that was wrong, not merely imperfect.** `boundaryPoint` returned the midpoint
of the closest points between the two regions' **bounding boxes**, after rejecting
pairs further apart than `ADJACENCY_GAP_M`. That point came from box arithmetic
and had no relationship to the road network. Each leg then snapped it to the
nearest node *within its own region*. For Calgary to Vancouver the driver was
routed via whichever node happened to be nearest a box-derived midpoint — in the
Rockies, at the closest point between two rectangles, rather than the actual
highway crossing.

The failure mode was not a visible seam. The two legs shared a point, so the line
was continuous. It was a **wrong route**, which is worse, because it looks right.

**Why it was never noticed, and why the tests could not have caught it.** This is
the part worth keeping. Single-region routing is unaffected and is the common case;
the cross-region path only runs when two regions are downloaded and the two ends
fall in different ones.

But there is a second, sharper reason, and it is the generalisable one. **The
existing cross-region test fixture cannot distinguish stitching from merging, and
never could.** Its two bboxes touch along a shared edge, so `boundaryPoint`
returns the centre of their overlap — which, for a straight road at lat 0, *is*
the shared OSM node. The stitched route and the merged route are byte-identical.
`test/merge.spec.ts` has the same blind spot from the other direction: its
`makeRegion` helper defaults every bbox to `[0, 0, 1, 1]`, so the boxes are
identical and the stitch point lands on the shared span's centre.

So requirement #10 sat under a row marked "Done", then under a row marked "Not
done", with roughly 800 lines of tests passing throughout, because every test that
touched this code was structurally incapable of distinguishing the two
implementations. It is the same failure as §4.1 (parser and fixture sharing a wrong
constant, so the round trip agreed with itself) and §4.6 (a suite visiting four
screens instead of eleven and reporting success). Three instances of one pattern:
**a test that cannot fail is worse than no test, because it is counted.**

The replacement fixture is in `test/regions.spec.ts` and is built to defeat exactly
this: the real through-road is 1–2–3, the bboxes overlap in a rectangle centred
11 km off that road, and each extract carries a `Loop` way reaching the centre.
Stitching hands the driver from one `Loop` to the other, a **fourfold** detour
through a junction that exists only as box arithmetic; merging takes 1–2–3. All
four new assertions were verified to fail against the old stitching code.

`RoadGraph.regionOf` is still serialised for every region by `regions/persist.ts`
even though it is only meaningful for merged graphs. It is now at least reachable
— a merged graph is one the app can build — but the persisted bytes are still
wasted for single-region entries.

### 3.6 Online providers

**What.** Valhalla for routing, Nominatim for geocoding, when a network exists.

**How.** `src/nav/providers.ts` defines a chain:

| Provider | Network | Notes |
|---|---|---|
| Offline (.osm) | No | Default. Self-contained A\*. |
| Valhalla — FOSSGIS | Yes | Public demo, live-tested (Valhalla 3.9.0) |
| Valhalla — Simplerouting.io | Yes | Requires an API key; refuses to send without one |
| Valhalla — custom | Optional | Your own `valhalla_service` |

**Why.** See §5.3 for why Valhalla is not the on-device default. Nominatim is
throttled to 1 req/s with a promise chain so concurrent calls serialise and never
overlap, as its usage policy requires.

### 3.6.1 Choosing and seeing engines

**What.** Pick which engine routes, decide whether another may substitute, and
see which one actually answered the last request.

**How.** `src/nav/engines.ts` holds selection and readiness;
`src/nav/providers.ts` keeps only the mechanics of fetching a route. Selection
is two orthogonal controls:

| Control | Values |
|---|---|
| Route with | Any online engine, Offline (.osm), FOSSGIS, Simplerouting.io, custom |
| If it cannot route | Use another engine (default) / Fail instead |

Those are separate because "I want Valhalla" and "let me have the offline engine
if Valhalla is down" are different requests, and one radio group cannot express
both. "Any online engine" expands to every hosted engine in registry order, so
"any" means genuinely any. `planRoute` turns a selection into the ordered plan
`resolveRoute` walks.

Every engine on the plan gets a trace row — including ones never reached, marked
`not tried`. A trace listing only what was attempted cannot answer "why did it
use that engine", which is the only reason to keep one. `degraded` deliberately
keeps its old narrow meaning (only reasons that cost something: no link, no key)
so the banner and its tests are untouched; the trace carries the detail the
banner has no room for.

**Why.** This fixed a real honesty bug rather than only adding a panel. The
status pill named the *selected* engine, so pinning FOSSGIS, letting it fail and
falling back to the offline engine still displayed "Valhalla — FOSSGIS" — a
locally-computed route wearing a hosted provider's name, implying turn-by-turn
the offline engine does not produce. Provenance is now recorded as state at the
moment of the request rather than derived from the selection, precisely because
the two diverge exactly when something failed. Traffic also asks the engine that
served the route rather than the top of the plan, so congestion is never
attributed to a different server than the one that produced the geometry.

Selection policy lives in its own module so it is testable without routing, and
the import direction is one-way (`engines.ts` → `providers.ts`) so the routing
core stays free of selection policy.

**Default.** `{ preferred: 'local', allowFallback: true }` — the offline engine
first, hosted engines behind it for pairs the extract does not cover. Strictly
more capable than the previous behaviour, which was local-only with no fallback.

### 3.7 Mid-trip connectivity loss

**What.** Signal drops halfway through a drive.

**How.** Three mechanisms. Note that rerouting is *not* among the things lost with
signal — the offline engine and the snapshotted geometry are enough to recompute a
route with no network at all, which §3.11.1 depends on.

1. **Provider chain.** Online engines are tried when a network is believed to
   exist; the local engine is always the fallback, so a route never fails
   outright. Which engine answered is recorded and displayed (§3.6.1), and the
   driver chooses both the preference and whether substitution is allowed.
2. **Snapshotted route.** Once fetched, geometry, maneuvers, ETA and steps are
   all resolved client-side. Guidance continues with no network at all. Rerouting
   (§3.11) works from the snapshotted geometry too.
3. **Honest degradation.** Traffic is labelled by its real confidence
   (`live` / `estimated` / `none`); verified traffic data is *kept* when signal
   drops, labelled "last known — no signal to refresh", because blanking true
   information is worse than showing it with a caveat.

**Why.** A navigation app that loses guidance when a tunnel eats the signal is
useless. Degrading to the offline engine costs nothing and saves the trip, and
because that engine needs no network it can also *re-route* — so losing signal
costs traffic data and nothing else.

### 3.8 Region persistence

**What.** Don't re-parse a province on every launch.

**How.** `src/regions/persist.ts` stores the *parsed dataset* in IndexedDB, keyed
by region id, in two object stores written in one transaction so a region is
never listed but unloadable. Typed arrays are packed by copying their exact
`ArrayBuffer` bytes (a `subarray` view would otherwise store a much larger
buffer) and validated on load. Corrupt or version-mismatched records are skipped
with a warning rather than taking the library down. Quota failures name the
region, the shortfall, and the largest other region to remove.

**Why.** Parsing takes tens of seconds; caching the parsed form makes startup
instant. A separate metadata mirror means listing the manage screen never reads
a dataset.

### 3.9 Traffic and layers

**What.** The two dead buttons in the navigation control stack now do real,
honest things.

**How.**

- **Traffic** toggles a congestion overlay computed from Valhalla's own per-stretch
  `length`/`time`, binned **relative to the route's median speed** — "slower than
  the rest of this trip", not an arbitrary km/h threshold. Enabled only when a
  provider produced a verdict; otherwise disabled with the reason in its
  `aria-label`, the status line and the layers panel.
- **Layers** opens a panel listing only layers with a real backing source.
- **`progressAlong` is driven by the driver's actual position**, snapped onto the
  route and rejected beyond the off-route threshold. The timer survives only when
  no fix places the car on the route.

**Why.** A dead button in a driving app is worse than no button. And `estimateTraffic()`
is deliberately unused: it bins by point spacing and labels everything `unknown`,
so painting from it would be drawing fiction — no imagery source exists for
satellite either, so that layer was omitted rather than shipping a grey rectangle.

### 3.10 Location

**What.** Real position, speed and heading.

**How.** `src/nav/location.ts` subscribes to `navigator.geolocation` — the
WebView's own API, backed by the platform LocationManager — falling back
device → browser → simulated, with the active mode always shown in the status
pill so it is never ambiguous.

**Why.** `@capacitor/geolocation` was tried first and **failed on device only**:
its native object is a Proxy, and awaiting the returned value calls `then()` *on
the plugin*, failing with `Geolocation.then() is not implemented on android`.
There is no proxy in a browser, so browser testing could never have caught it.
The WebView API returns a real Promise and is the same path the browser build
already exercises, so device and desktop share one implementation.

### 3.11 Rerouting

**What.** The app notices you have left the route and gives you a new one,
without ever taking the old one away first.

**How.** `nav/offroute.ts` holds the *primitives* — a speed-scaled tolerance, a
6-second confirmation hold, a reroute origin taken from the projected point
rather than the raw fix. `nav/reroute.ts` holds the *policy* — when to act, how
long to wait afterwards, what to tell the driver — as pure functions over a
plain state, so the storm guards are testable without React, timers or a network.
The navigation effect in `App.tsx` supplies the fix and does what the policy asks;
it makes no decisions of its own.

Three invariants, in priority order:

1. **A reroute never removes guidance.** The existing route and its maneuvers stay
   on screen for the whole request, so a driver who is lost is never also left
   without directions. A failed attempt restores nothing because nothing was
   removed.
2. **One attempt at a time.** `busy` latches until the attempt finishes, so a
   fix storm cannot queue requests that would race and overwrite each other.
3. **Back off after failure**, doubling to a 120 s cap. Retrying a dead engine
   every few seconds drains the battery and will not start working on its own.

**Why.** This closes the last gap where an implemented feature was not reachable
by the user. `offroute.ts` had six exports and the app called two, so the tracker
and the reroute origin were unit-tested and never invoked — the app did not
reroute on its own. Requirement #18 named "rerouting mid-turn" as the specific
uncovered flow, and that is now driven end to end in `test/e2e.mjs`: the geolocation
fix is walked over 4 km off the line, held past the confirmation window, and the
suite asserts the driver is told, that guidance survives, and that the notice
clears on return.

Four bugs surfaced while building it, all in the first implementation and all
caught by the tests:

- `finishReroute` reset the tracker on failure as well as success. After a
  *failed* reroute the driver is still off the original route, so discarding the
  tracker threw away the evidence that says so — and the app sat in "suspect" for
  another 6 s window while its own backoff said otherwise.
- The first-failure backoff was 15 s against a 30 s settle, so the first failure
  *shortened* the wait. Retrying a dead engine faster than you would settle a
  fresh route is backwards.
- The rejoin distance was shown for a merely-*suspect* driver, i.e. "rejoining in
  700 m" off a single outlier fix. Now only once the deviation is confirmed.
- `CONFIRM_MS` was private, so the confirmation window was a magic number to any
  caller reasoning about when a reroute is allowed. Exported as
  `CONFIRM_WINDOW_MS`.

### 3.11.1 The frozen-position loop, and three banner defects

**What.** A stuck GPS fix rerouted every 30 seconds, forever. Found by an audit,
not by a test — the tests were all green while it was happening.

**How.** `watchPosition` keeps its last value when a signal drops (tunnel,
revoked permission, cold GNSS), and the error callback never invalidated it. The
reroute effect fed that frozen position to the policy as though it were live, so
the deviation from the line never changed, never cleared, and re-confirmed after
every settle window. **Measured before the fix: 20 requests in ten minutes,
exactly 30 s apart, with `failures` pinned at zero** — because every attempt
*succeeded* and reset the counter. Neither the busy latch nor the backoff could
help; both guard against repeated *failure*, and this was repeated success.

Closed at two levels:

1. `LocationState.stale` is a first-class signal, set when no fix has arrived for
   20 s. The reroute effect refuses to act on a stale position.
2. `madeProgress` requires a candidate reroute to actually move the driver nearer
   the destination. A reroute that does not is evidence of a stale fix, not of a
   driver who is lost.

The second guard is deliberately *evidence-based* rather than time-based, which is
what makes it survive a freeze of any duration: it asks "has anything changed?"
rather than "how long has it been?".

**Also fixed in the same pass, all found by the same audits:**

- **The maneuver banner's distance was wrong.** `distToNext` multiplied a
  shape-index *ratio* between two maneuvers — which carries no distance
  information — by the remaining distance. The headline number therefore shrank
  with the length of the *trip* rather than the next leg: a turn two streets away
  read as half the remaining journey, and the imminent-turn dimming below 40 m
  never fired at all. Now measured along the road.
- **Offline routes showed "0 m / Continue" for the whole trip.** The offline
  engine emits no maneuvers, so `guidance` is null and the banner read
  `localGuidance` for exactly one field — the remaining distance — while ignoring
  the turns it had already derived from bearing change. Since the offline engine
  is the *default*, the largest number on the navigation screen was meaningless
  for most users. It now falls through to the derived turn, and says "Arriving at
  your destination" when there is none.
- **A failure reason survived about one second.** `observeFix` rebuilds `message`
  on every fix, so "API key required" was replaced a second later by a bare
  "retrying in 29 s" and stayed that way for the full wait. `RerouteState.reason`
  now holds it and the countdown folds it in.

### 3.12 Streaming the OSM parse

**What.** Importing a 900 MB province no longer requires holding it in memory
twice.

**How.** `parseOsmXmlStream` consumes an async chunk stream and retains only the
incomplete tail. Everything up to the last safe element boundary is scanned and
dropped. Two details carry the weight:

- `TextDecoder` runs with `{stream: true}`, so a multi-byte UTF-8 sequence split
  across two reads is held in decoder state rather than becoming replacement
  characters. Decoding each chunk independently corrupts every non-ASCII place
  name, subtly, and only on large files.
- The boundary rule is "after a complete `<node>`/`<way>`", expressed with the
  same grammar the scanner consumes.

`parseOsmXml` (whole string) and the streaming path share `scanSegment` and one
boundary function. That is deliberate: two implementations of the same parser
would eventually disagree about a malformed element, and the streaming one is
the one that runs where a silent divergence is hardest to notice. Equivalence is
then a testable property rather than an aspiration.

**Why.** The download already streamed — only the parse did not, so peak memory
was roughly twice the file size. The `ReadableStream` is passed in the *transfer*
list, not cloned: Chrome rejects a cloned stream outright ("a ReadableStream could
not be cloned because it was not transferred"), and transferring also moves the
handle instead of copying it.

PBF still collects to a contiguous buffer. Protobuf framing needs sequential
access, so it cannot be chunked at an element boundary the way XML can. That is
stated at the call site rather than left to be discovered.

Two bugs, both mine, both caught by the tests:

- The first cut rule was "after any `>` whose remainder looks like a tag start",
  which split a tagged node across two segments: the opening `<node id=...>` ended
  one, the `<tag>` children and `</node>` the next, and neither half matched. A
  tagged placemark and its way were silently dropped. Only the
  one-character-at-a-time chunking test catches this, because it is the only
  chunking guaranteed to land inside an element.
- I had commented that a `ReadableStream` is structured-cloneable rather than
  transferable. That is false, and the browser corrected me immediately.

### 3.13 Offline map level of detail

**What.** The offline map is legible when zoomed out, which it was not.

**How.** The geometry was never missing — `roadsToGeoJSON` already mirrors every
road in the dataset into a MapLibre `GeoJSONSource`. The width ramp's first stop
was zoom 10, and a province fits the viewport at about zoom 6, so every road drew
at a single flat pixel. Arterials are now held near their high width down to zoom
6, and the low-zoom value itself branches on class; minor roads moved to their own
layer with a floor and lower opacity when far out; water is floored too.

**Why.** This is a style problem that looked like a data problem, and I had it
filed as a weeks-long MBTiles pipeline before checking. The tell is that one pixel
of motorway is indistinguishable from one pixel of service road: a single
`line-width` expression cannot make one class thick at zoom 6 and another almost
invisible, which is why arterials and minor roads had to become separate layers.

`offlineStyle` moved from `MapView.tsx` into `style.ts` as `offlineStyleSpec`,
taking the overlay layers as an argument. It had to move for the test to be worth
anything — `maplibre-gl` pulls in a DOM — and an earlier draft of the test rebuilt
the layer list locally and asserted against that copy, which would have passed
even if the shipped style had drifted.

**What is not claimed.** These assertions are structural: every line layer has a
floor below zoom 10, arterials branch on class at low zoom, minor roads recede.
They are not pixel comparisons, because the only extract available offline is a
19-way fixture and it cannot show what a province looks like at zoom 6. Asserting
on those pixels would be a reassurance, not evidence.

### 3.14 Structural tokens and the test server

**What.** Two requirements that were marked "Done" now rest on things the repo
owns, rather than on CSS literals and a script in `/tmp`.

**How.** `STRUCTURE.APP_BAR` (96) and `STRUCTURE.GRID_CELL` (158) live in
`theme.ts` and are published as CSS custom properties by `applyThemeTokens()`.
CSS cannot import from TypeScript, so the duplication does not vanish — it moves
from nine call sites to one seam. Every `var()` keeps a literal fallback, because
a token that fails to resolve is `height: auto`: a silently collapsed app bar
rather than an error. `test/theme.spec.ts` pins the contract the type system
cannot see, that `theme.ts` and `styles.css` agree on the names.

`tools/serve.mjs` replaces `/tmp/opencode/serve/serve.mjs` (requirement #20),
with `npm run serve` and `npm run screens`.

**Why.** Neither was a visual or functional bug; both were claims that stopped
being reproducible the moment you looked for them. The server is the one piece of
this project exposed to a network, so its path handling is tested: note the
behaviour is *clamping*, not refusing — `/../../../etc/passwd` resolves to
`<ROOT>/etc/passwd`, which does not exist and falls through to the SPA shell. The
property that matters is that the result never leaves `ROOT`, and that is what the
tests assert.

### 3.15 Tile-style remapping and the type-assertion warnings

**What.** Three console warnings on every cold start are gone, and the tile style
is repainted to Google's palette on the way in.

**How.** `buildStyle()` fetches OpenFreeMap's `liberty` style and post-processes
it: `remapPaint` rewrites fill, line and text colours toward Google's palette,
and `guardOrderComparisons` wraps order comparisons that read a bare property.

**Why the guard exists.** MapLibre's expression parser wraps `<`, `<=`, `>` and
`>=` in a runtime type assertion when one side is statically untyped, so
`["<=", ["get", "ref_length"], 6]` asserts that the value is a number. A tile
feature with no `ref_length` — any named road without a route number — makes that
assertion throw, and `StyleExpression.evaluate` catches it and logs
`Expected value to be of type number, but found null instead`, once per layer, on
the first such tile. Three layers in `liberty` do this:
`highway-shield-non-us`, `highway-shield-us-interstate` and `road_shield_us`.

Wrapping as `["all", ["has", prop], cmp]` makes the comparison unreachable for
features that lack the property, because `all` short-circuits. The filter result
was already `false` for those features, so nothing about what is drawn changes —
only the log. The transform is idempotent, since a remap that wraps twice is a
trap for the next caller even though `buildStyle` always re-fetches.

Worth recording as a process note: this was found by handing a subagent a symptom,
the evidence that it predated the current work, and explicit permission to report
a negative result. It isolated the three layers by serving controlled style
variants, and reproduced the throw against the style-spec alone with no browser.

### 3.16 Release pipeline

**What.** Public repo; a tag produces a release with an APK.

**How.** `.github/workflows/ci.yml` runs typecheck → unit tests → build → E2E
with **both** fixture formats → screen coverage at three viewports, uploading
screenshots as artifacts. `.github/workflows/release.yml` re-runs typecheck, unit
tests and the build, then compiles the APK on `v*` tags and attaches it to a
GitHub Release with install instructions. The Release workflow deliberately does
**not** re-run the browser suites — they need Chromium and roughly two minutes,
and the CI workflow is already the gate on the same commit.

**Why.** Tag-per-change was requested explicitly, and it makes every fix
independently revertible and independently verifiable.

**A CI bug this record should not hide.** The screen-coverage step was added in
v0.8.0 and failed on *every* run afterwards: `ci.yml` started `vite preview` on
port 4192 while `screens.mjs` defaulted to 4193, so the step connected to nothing
and reported `ERR_CONNECTION_REFUSED`. Seven consecutive pushes were red and I
did not notice, because I was verifying locally rather than reading the CI
status. Both now use 4192 explicitly. The lesson: "CI runs the full gate" is only
true if someone reads the run results.

### 3.17 The ETA readout

**What.** The number on the navigation screen that a driver acts on without
checking.

**What was wrong.** It was recomputed from scratch on every fix, from whichever
part of the route line happened to be nearest, and it had no memory of where the
car already was. Two failures, both measured in the running app:

1. **It could increase while the car drove forwards.** A route that runs beside
   itself — a divided highway, an overpass, a loop back past the way you came —
   has two near-equal candidates, and the nearer one can be *behind* the driver.
   Remaining distance then grew. Observed flipping between `0 m` and `670 m` on a
   36 m move.
2. **It read `0 m` to destination while the driver was 900 m off course.** Past
   the off-route threshold, "closest point on the route" stops being a fact about
   the car and becomes an arbitrary point on a line. If that point was near the
   end, the bar said *arrived*.

The two halves of the app disagreed. `progressAlong` was already monotonic and
already refused untrustworthy fixes; the ETA path did neither, and re-projected
each fix from scratch. So the drawn "already driven" line and the distance beside
it could not both be right.

**How.** Three properties, in priority order, as pure policy in
`src/nav/progress.ts`:

- **Never zero before the last vertex.** Zero remaining means arrived. It is not
  reachable by a car short of the end, structurally rather than by convention.
- **Never increasing as the car drives forward.** You cannot un-drive a road. This
  also rejects GPS jitter, stale fixes and doubling-back routes, none of which
  un-drive it.
- **When the fix is unusable, keep the last trustworthy number.** Blanking true
  information is worse than showing it with a caveat — the same reasoning that
  keeps verified traffic when signal drops (§3.7). But it is never *invented*
  from a fix too far off the line to place the car.

Underneath, `geo.ts` gained `snapAlong`, which measures a position in **metres from
the start** rather than as a segment index. The index could not express three
things: arrival (a multi-vertex line's last segment is never "the destination"),
distance (it counts vertices, so the same road is a different number of steps
depending on tessellation density), and position within a segment (it names the
segment's *start*, reporting a car mid-segment as a whole segment behind).
`vertexAt` is its inverse for the readouts that are inherently per-vertex.

And `formatDistance` no longer rounds a nonzero distance to `0 m`. Snapping 4 m to
the nearest 5 m gives 0, and "0 m to destination" is a statement about the world,
not a rounding artefact — a driver still on the road reads it as *you have
arrived* and stops looking. It rounds **up** to one step, which over-estimates
the distance remaining rather than under-estimating it. A genuine zero still
prints `0`.

**Why the tests are property tests.** `test/progress.spec.ts` drives a whole route
with the geometry that caused the failure, rather than asserting single
hand-picked cases that would only prove those cases. The fixtures that matter are
a route whose three sections run 11 m apart with ±2 m of GPS noise, and a
mid-junction fix reported *between* two levels of road. The first attempt at the
noise fixture passed with the monotonic clamp deleted, because ±2 m cannot flip an
11 m gap — the test was decorative. It was replaced with one that discriminates,
and the clamp, the off-route guard and the zero-floor were each verified to fail
when removed.

### 3.18 Cross-region routing, by merging

**What.** A route whose ends fall in different downloaded extracts.

**How.** `RegionLibrary.route()` merges the participating regions and runs one A\*
over the merged graph. `merge.ts` is unchanged: it was already correct, and the
whole of the previous gap was that nothing called it.

Four things had to be decided, and none of them was the merge itself.

**Where the merged graph lives.** On the library, as a private cache keyed by the
sorted region ids, invalidated in `add()` and `remove()`. Not as a synthetic
`Region`: `add()` fires `emit()`, so a phantom entry would appear in the region
list with a Remove button that deletes nothing, and would be counted in the
"N loaded · X MB" chip and iterated by the gazetteer aggregation. A merge is also
invalid the moment a region is re-imported, which is why the cache is cleared
rather than merely keyed.

**Whether to attempt it at all.** `mergeRegions` holds every source graph, a boxed
JavaScript `Map`/`Array` copy of the nodes and edges, *and* the typed-array result
at once, so peak is 2–3× one graph rather than one. For two provinces that is not a
question of speed. `src/osm/mergeguard.ts` decides from static size **before** any
of it runs, from the graph's own declared shape (≈96 B/node, ≈24 B/edge, both
derived from the actual typed arrays plus the per-query A\* scratch and the spatial
index, not guessed), and has three outcomes:

- **proceed**;
- **proceed, and say the headroom is thin** — below 75% of budget it warns rather
  than hoping;
- **refuse**, with the shortfall and the budget both named in MB.

The middle outcome is the point. A yes/no guard either gets the WebView killed
mid-merge — which on Android is a silent tab kill, not an error — or refuses
hardware that would have coped. `navigator.deviceMemory` is a coarse Chromium-only
bucket and `performance.memory` is non-standard, so when neither answers the guard
*assumes* 512 MB and says it assumed; reading a missing value as unlimited would
be the worst of the three options.

**What to do when it refuses.** Nothing, which is the correct answer. A
cross-region route that cannot be afforded has no honest approximation, because
the line it would replace is the wrong one, and wrong-but-continuous is the worst
thing to hand a driver. `route()` is nullable for three unrelated reasons — no
region covers the pair, no path exists, the merge did not fit — and the caller
cannot tell them apart from the null, so the actionable one is recorded on
`lastRefusal` and surfaced. Telling a driver "no route" when the truth is "this
device cannot compute this route" is how a reachable destination becomes an
unreachable one.

**What stays the same.** `plan()` is untouched. It decides *which* regions a query
needs, and that part was never the bug. `stitched` is now always `false` for a
route the app actually serves, and the flag survives on the return type so no
caller's signature changed — `App.tsx` and `RegionsScreen.tsx` compile unmodified.
`merge.ts` has zero runtime imports (both are `import type`), so importing it into
`osm/regions.ts` creates no cycle.

**Why the memory limit is still the open part.** The guard decides from *declared*
graph size, on a device that will not reliably report its heap. That is a static
estimate against a dynamic constraint, and it is the honest limit of what has been
built: correct for small extracts, and *refusing* rather than guessing for large
ones. Merging two real provinces on a real phone is still unverified (§7).

### 3.19 Two gates for render-time failures

**The problem.** This project tests pure logic under node, with no DOM. That is a
good trade — it is why 792 tests run in eight seconds — and it has a blind spot with
a demonstrated cost.

A `useMemo` callback runs *during render*, so anything it closes over must already
be initialised. The ETA fix added a `routePos` ref **below** the two guidance
memos that read it. That is a temporal dead zone, and reading it throws
`ReferenceError: Cannot access 'routePos' before initialization`. All 747 unit
tests passed. The app rendered nothing but the error boundary's recovery card —
and because the boundary exists and works as designed, it failed *quietly*, which
is the worst way for this to fail. Only `test/e2e.mjs` caught it, because only the
browser suite renders `App`.

**What was added.**

- **`test/tdz.spec.ts`** finds `App()`'s body by brace matching, collects its 81
  component-scope bindings — including array-destructured `useState`, which is most
  of them — and asserts that no `useMemo` callback reads one declared later.
  Scoped to `useMemo` deliberately: an effect runs after the commit and a
  `useCallback` is only *created*, so a click handler reading a later-declared
  helper is fine, and asserting on those would mean asserting on most of the file.
  The wider scan is kept as a printed inventory rather than a failure, because it
  cannot tell the two cases apart. Verified to fail, with a line-referenced
  message, when the ref is moved back down.
- **`test/app-render.spec.ts`** renders `App` through the server renderer with the
  map chunk mocked, so a first-render throw is a unit-test failure. It does **not**
  close the original gap and does not pretend to: on a first render both guidance
  memos return early, because there is no route and no dataset yet, so the bug
  needs a route to exist. What it does buy is that the root landmark and the crash
  card are asserted somewhere cheaper than a browser suite.

**The finding that came out of writing the first one.** The scan immediately
reported `beginRouteProgress` read 100 lines above its declaration — inside a
`useCallback`, therefore harmless, because it only runs on a click. It was moved
anyway, and the ordering rule is now uniform: everything a memo needs is declared
with the memos. The alternative was a permanent, documented, load-bearing exception
to a rule, which is how the original bug happened.

**Why this is in the document at length.** Because the shape is the lesson, and it
is the fifth time in this project's history that a gate reported success while
unable to see the thing it existed to see: §3.16's seven red pushes, §4.6's
screen-coverage regression, §4.1's shared wrong constant, §3.5.2's fixture that
could not distinguish two implementations, and now this. The general form is that
**a green result nobody re-derives is not a green result**, and the corollary that
matters more: a suite that has never been seen to fail has not been tested.

**The audit pass that followed.** With the gates in, three browser audits drove the
app at 412×915 / 892×412 / 1280×720 with geolocation pinned to the on-disk fixture
east of Edinburgh. They returned a ranked set of defects, most of which are closed
in the "Close the defects the browser audits found, measured in Chromium" commit:
preview-actions clipped at 412dp, the home-bar brand truncated to "Ca…",
`nav-controls` overlapping `nav-bottom` by 20dp, `pill-gps` at 4.27:1, the
attribution dark-theme rule being dead against the lazily-loaded MapLibre CSS, an
invalid `color: ink.secondary` inside a stylesheet plus a tofu `⏱` glyph, the
imminent-turn dimming that was computed and never consumed (the same shape as the
§4.6 dead affordances), and the catalogue button whose accessible name read as a
single word. All verified in a live probe before they were declared fixed.

Deferred by name, so they are not lost. **Two are now closed and one of the estimates
was wrong by 3×** — see the note on each, and §13.12.

- The offline **inferred guidance is unreachable on the fixture**, because the
  local engine returns a 2–3 point geometry for a short route and the step
  inference loop needs at least seventeen. The honest "No turn-by-turn" empty
  state is correct behaviour for data that has no turns; a route whose geometry
  is too sparse to infer from should either produce steps some other way or say
  so more plainly. **Closed** (§13.14) — the empty state was right and its
  *explanation* was wrong, which is the more damaging direction: it sent the
  driver to Settings to change a setting that would not have changed the answer.
- The primary CTAs and the bottom search controls have no pressed state yet. A
  focus ring exists on every control; the press-down visual is the first thing an
  AAOS designer adds and is the first thing a screen reader assistant does not.
  **Closed** in an earlier revision — see the §11.8 table.
- The Regions catalogue repeats an unavailable entry's reason as a multi-line red
  paragraph that balloons the row to ~365dp at 412dp; row height is nominally
  116dp. Fold the reason into one line and expand on demand. **Closed** (§13.11) —
  and the estimate was low: the row measured **1139dp**, and the reason paragraph
  868dp of it. Measuring it needs the probes stubbed, because the real catalogue is
  CORS-blocked and the measurement would otherwise depend on the network.
- The off-route notice touches the maneuver banner's edge at 1280×720. A 0-gap
  border-to-border look, on a surface that has a 12–16dp radius elsewhere.
  **Closed, and the claim was wrong.** Re-measured at 1280×720, 412×915 and
  892×412: the gap is **8px** in all three — the stack's own `gap` — so there was
  never a collision. The note was never checked by a probe that could see this
  pair at all: `reflow.mjs`'s `PIECES` holds the banner *stack*, and the `nested`
  exemption skips stack-versus-child, so the notice and the card inside it were
  never compared.

  What the measurement did find is the thing underneath the claim, and it is real:
  the two are siblings in one flex column with the **same fill**
  (`rgba(14, 16, 19, 0.94)`), the same width, an 8px gap and **different radii** —
  16px and 8px. Two identical dark surfaces with mismatched corners read as one
  panel split in two. The notice now matches the card's 16px; the 4px amber rule is
  what distinguishes them, which is its whole job. §13.13.

---

## 4. Bugs found and fixed

Every one was invisible until something forced it into the open. Several were
found only by the tests written to check them.

### 4.1 Catastrophic

**Real `.osm.pbf` extracts decoded 100× too small.** The OSM PBF spec stores
coordinates as integers in units of **1e-7 degrees** — nanodegrees. The parser
divided by 1e-9, and so did `tools/osm2pbf.mjs`, which builds the test fixtures.
The round trip therefore agreed with itself and **every test passed**.

Any real Geofabrik extract, written to the spec, was read 100× too small. Andorra's
42.42 N arrived as 0.4242 — the country in the Gulf of Guinea. Every distance,
every route, every bounding box and every cross-region comparison was wrong, and
nothing on screen said so: the map drew, search returned results, the app looked
like it was working. **This was the most consequential bug in the project's
history.**

It was invisible for the same reason the `.nav-panel` corruption (§4.7) was: a
self-consistent round trip cannot detect a mistake both halves share. Only the
*specification* can, and nothing in the suite was written against it. Fixed in all
three places (both parser paths, the encoder, the test helpers) with the fixture
regenerated, and `test/pbfgeo.spec.ts` now asserts absolute facts — Edinburgh is at
~51.5 N, not ~0.515 — going through the real encoder rather than a helper.

It also means the cross-region gap (§7 gap 1) was partly theoretical until this
fix: there was no correctly-parsed province on the device to stitch between.

**Inverted one-way direction flags** — no edge was ever created.
Flags mean "direction *permitted*", but the builder tested
`!(flags & FLAG_ONEWAY_B)`. For a normal two-way road (flags = 3) that is
`!(2)` = false, so nothing was added. The fixture builds **288 directed edges**
once fixed; before the fix it produced a graph with almost no edges at all, 73
nodes with no incident edge, and every route returning `null`. The single
highest-impact bug in the project — and invisible until the fixture made me
count edges instead of assuming they existed.

**Merged graphs turned every two-way road one-way.**
Dedup keyed on the *unordered* node pair, so the reverse record collided with
the forward one already stored and was dropped. Routing in the reverse direction
returned `null` — cross-region routing was broken.

**The offline fallback crashed on long routes.**
`Math.min(...geometry.map(...))` spreads one argument per point and overflows the
stack past ~125k points — trivially reached on a provincial extract, and inside
the code path that exists to save a trip when signal drops.

**Unitless `line-height` blanked all text.**
Tokens declared `lineHeight: 32`. React serialises that without a unit, so it
reached CSS as a *multiplier* — a 768px line box on a 24px font. Glyphs were drawn at the
vertical centre of that box, far below it, and clipped away by `overflow: hidden`.
`elementFromPoint` kept reporting a normal-looking box, which is why it read as a
paint bug for so long. The brand title, subtitle, hint card and buttons were all
blank. Now pinned by a type that makes a bare number a compile error.

**A trace that could not explain itself, introduced while fixing the above.**
Adding the attempt trace meant deciding what `degraded` meant, and I first made it
record *every* skip — so a missing endpoint surfaced as a degraded banner entry
and the "no route" message blamed an offline map that had never been consulted.
Four existing tests caught it. The distinction that holds: `degraded` is only
what actually *cost* something (no link, no key), while the trace carries the
full detail including engines that were never reached.

### 4.2 Correctness

- **`strict` mode aborted the engine walk instead of bounding it.** My first
  implementation threw as soon as any pinned engine failed, which is fine for a
  single named engine but makes "any online engine" a lie: its plan *is* three
  hosted engines, and walking between them is precisely what that option means.
  Correct semantics are "the plan is the whole world" — never append the offline
  engine, always explain why nothing answered. Caught by a unit test asserting
  that a strict `any-online` request reaches the second hosted engine and never
  reaches `local`.
- **Spatial index aliased cells 131° apart.** `(floor(lon/cell) << 16) ^ …`
  coerces to int32, so the longitude cell index exceeded the 16 bits the shift
  preserves. Cells 131° of longitude apart — up to 14,600 km at the equator,
  ~9,000 km at mid-latitudes — shared a bucket, so `nearest()` near the
  antimeridian searched the wrong side of the planet.
- **`pairKey` aliased node pairs above 2^21 nodes** (directed variant: 2²⁰). A
  province is well past that, so distinct roads collided and border roads
  vanished. Both are now nested `Map` keys, which cannot overflow.
- **Off-route distance measured in degrees.** A degree of longitude is ~cos(lat)
  smaller than a degree of latitude, so an east–west deviation was understated by
  roughly a third at mid-northern latitudes and fell under the detection
  threshold — broken in the direction it most needed to work.
- **Every online search was malformed.** Nominatim's `viewbox` was built
  `[lat, lon]` when the API documents x as longitude — Berlin requested as
  lon 53.1, lat 14.
- **Valhalla:** `summary.length` passed through in km while consumers expected
  metres ("Distance 0 m"); the arrival point was duplicated; every leg after the
  first was discarded.
- **`bestFor` returned the loosest bbox**, so a point inside a loaded city routed
  against the province-wide graph.
- **Relaxing a one-way masked flags instead of clearing them**, turning a usable
  road into one impassable in neither direction.
- **`snapToPolyline` returned `Infinity`** for a degenerate line, which reads as
  "infinitely off route".
- **Two-point routes could never complete** — the segment index is always 0, so
  arrival never fired.
- **`Place.bbox` used Nominatim's `[S,N,W,E]`** while the whole app uses
  `[W,S,E,N]`.

### 4.3 UI

- **Occluded first list row** — `padding-top: 0` under an absolutely-positioned
  app bar hid it on every list screen.
- **Narrow-screen overflow** — a hard `min-width: 420px` on a 412dp phone, an ETA
  bar pushing buttons off-screen, three 156dp buttons needing 468px.
- **Category chips searched names for the literal word "city"** and matched
  nothing; they now filter by tag category.
- **Side arrivals rendered as a centred pin.** `destination-left` and
  `destination-right` were declared in the icon union and mapped from Valhalla
  maneuver types 5 and 6, but had no `case` in the switch, so they fell through
  to `default`. `test/icons.spec.ts` now asserts every declared kind renders
  distinct geometry, which is what catches a missing case.
- **The status pill named the selected engine, not the serving one.** Pin a
  hosted provider, let it fail, and the offline engine answered while the pill
  still read "Valhalla — FOSSGIS" — a local route wearing a hosted provider's
  name, implying turn-by-turn the offline engine does not produce. Invisible
  because the two only diverge on failure, which the browser suite never
  provoked. Fixed with §3.6.1.
- **Invisible nav icons** were the same *kind* of bug as above: a hardcoded
  default colour rather than one inherited from context.

### 4.4 Device-only

Both found by booting an Android 14 emulator and installing the APK — neither was
reachable from browser testing.

- **Geolocation was broken on device** (`Geolocation.then() is not implemented on
  android`). See §3.10.
- **System bars overlapped the app bar.** Android 15 draws edge-to-edge and the
  WebView reports no safe-area insets, so `env()` stayed 0. The activity is now
  immersive — which is what Android Auto does anyway.

  *Found later, by reading the two files against each other:*
  `capacitor.config.ts` also set `adjustMarginsForEdgeToEdge: 'force'`, which
  contradicts the immersive activity. Forcing Capacitor to inset the WebView for
  system bars that `applyImmersiveMode()` has just hidden means padding the app by
  the height of chrome that is not on screen, and the config comment described the
  margin handling as the solution — so it documented a mechanism the app does not
  use. Now `'auto'`. This is the same shape as §3.6.1's status pill: two places
  each believed they owned a decision, and the UI was the only thing that could
  say which one was lying.

### 4.5 Build hygiene

**`npx cap sync` never prunes removed files**, so stale JS chunks were packaged
into the APK and served at runtime — which made a fix look like it had not
landed, and sent me chasing a "still broken" error twice. `npm run sync` now
clears the asset directory first.

### 4.6 Four controls the user could not reach

Every one declared, wired to real work, and never invoked. Same class as
`offroute.ts` (§3.11) and found by an audit of props declared-but-unread rather
than by any failing test.

- **No way to clear the route.** `HomeScreen` accepted `onClear`, bound to real
  state-clearing work, and never called it. A destination, once set, was held for
  the life of the session: the red pin stayed on the map and the Continue card
  never went away. The only other clearing paths were importing a file or
  computing a new route. Now a Clear button sits beside Continue.
- **The preview card's Time icon never rendered.** `PreviewRow` declared an
  optional `icon` prop, a caller passed one, and the component neither
  destructured nor rendered it. It also had no styling, so rendering it alone
  would not have lined up.
- **Map taps were a guaranteed no-op.** `MapView` registers a real MapLibre click
  handler and a 550 ms long-press timer; `App` passed neither. Wiring it exposed a
  second defect: the registration effect runs once with `[]`, so its closures
  capture mount-time props and any handler passed later would never be seen.
  Fixed with refs.
- **Dragging a file onto the home screen did nothing.** `onImportFile` was the
  fourth dead prop in this class.

### 4.7 The corrupt CSS rule and a green gate over 4 screens

Four bugs, none of which any test had been in a position to catch, and three of
which were behind a broken gate.

- **A bare git object SHA sat inside `.nav-panel` in `styles.css`**, splitting the
  rule in two. Twelve declarations — `bottom`, `width`, `max-height`,
  `overflow-y`, `pointer-events`, `z-index`, `display`, `padding`,
  `border-bottom`, `text-align`, `color` — ended up after the `.panel-head` rules
  at top level, where a CSS parser drops them. The layers popover kept only
  `position`, `left`, `border-radius`, `background` and `box-shadow`, and since
  `.nav-root` is `pointer-events: none` the panel had no `pointer-events: auto`:
  every row passed clicks to the map underneath. The same orphaned block was
  duplicated inside `@media (max-height: 520px)`, where its
  `max-height: calc(100% - 424px)` goes negative at 412dp tall. Both merged back;
  the short-screen case gets its own values because the tall ones do not transfer.
- **The screen-coverage suite was visiting 4 screens instead of 11.** Unwinding
  after a newly-added screen used `page.goBack()`, but this app navigates by React
  state and pushes no history entries, so `goBack()` left the app for
  `about:blank`. Every later selector then failed, and because each block is
  guarded the run still printed "all checks passed" — while reporting 42 checks
  instead of 105. The gate built to catch layout bugs had been reporting green
  over a third of its scope.
- **Restoring those 63 checks failed immediately**, exposing three real 412dp
  overflow bugs that the regression had been hiding: `.chip` was declared twice
  with conflicting sizes (a 44dp status label and a 76dp interactive chip, the
  later block winning for both); the Regions catalogue row's action cluster was
  wider than the row and `flex-shrink: 0` defeated wrapping; and the app bar's
  status chip, "1 loaded · 13.0 KB", ran off the right edge of a 412dp screen.
- **`adjustMarginsForEdgeToEdge: 'force'` contradicted the immersive activity**
  (§4.4's second item), insetting the WebView for system bars that
  `MainActivity` had just hidden.

The common thread is that each of these was invisible to a passing gate, and two
of them were found by auditing rather than by running anything. The `.nav-panel`
corruption is the sharpest: it had been committed, it broke a control, and the
screens suite had not visited that screen for a month.

### 4.8 The screen suite had zero coverage of the navigation controls

Added in the same pass as §4.7, because the reason these survived is that
nothing ever opened the panels they live in. `test/screens.mjs` now drives the
navigation screen, opens the layers popover, and asserts it is **sized, clickable,
stacked above the map, populated, and closes**.

Verified as a real test rather than a decorative one: deleting
`pointer-events: auto` from `.nav-panel` — the exact shipped regression — turns
three viewports red with "panel none / row auto".

A note on the process, because the mistake is the useful part: the first attempt
to wire `onMapClick` put a `useRef` **inside** the effect body. A hook called in
an effect is not a hook, and the app rendered a blank screen with React error
#321. Only the screen suite noticed, because a blank home screen is exactly what
"home renders content" checks for.

---

## 5. Architecture decisions

### 5.1 Capacitor over Expo

**Decided:** Capacitor. **Why:** the map is MapLibre GL (WebGL) and the OSM parser
runs in a Web Worker. Expo/React Native would mean sacrificing one or the other,
or wrapping a WebView anyway — in which case Capacitor is the honest choice. The
secondary benefit proved decisive: the web build is directly testable in a
browser, so most iteration never needed an emulator at all.

### 5.2 Ferrostar not used

**Considered.** Ferrostar is a mature TypeScript navigation SDK with Valhalla
support and a WASM core. It was rejected because it duplicates what the built-in
engine already does, adds a Rust/WASM build dependency, and — decisively — offers
no offline advantage here, since its offline story still requires a hosted
routing provider. Building the engine directly gave full control over the OSM
ingestion path that the multi-region requirement depends on.

### 5.3 Valhalla is not the on-device default

**Answering the earlier question directly:** self-hosting Valhalla on Android is
*not unreasonable* — Valhalla 3.5+ builds with CMake and the NDK route is known.
It is unreasonable as a 30-minute task: protobuf, boost, luajit, prime_server,
sqlite3, GEOS and zlib all need arm64 sysroot variants, and the effort is
measured in days with a real chance of ending in a linker error. Pre-building
Valhalla tiles on a desktop does not remove this — it still needs
`valhalla_service` compiled for arm64 to consume them.

So the default engine is TypeScript, and Valhalla remains a selectable provider
for anyone who *does* want to do the native build.

### 5.4 Web-first, with `navigator.geolocation` rather than the Capacitor plugin

See §3.10. Two implementations of the same thing that can silently diverge is
worse than one that works on both platforms.

### 5.5 Immutable shared tokens

Design tokens live in `theme.ts` and are consumed as typed objects. Bug 4.1's
root cause was a *type* gap, so the fix was a type: `TypeToken` pins `lineHeight`
to `` `${number}px` ``, making the original mistake a compile error rather than
invisible blank text.

### 5.6 Degrade, never fail

A recurring principle across providers, traffic, location and persistence: every
optional capability returns a typed "unavailable" verdict instead of throwing,
and the UI states what is actually known. Nothing in this app implies data it
does not have.

---

## 6. Project layout

Every line count below is `wc -l`, re-measured for this revision. An earlier version of
this section carried thirteen stale ones; §9.3 records a previous audit finding three, and
the same class of error keeps recurring because a line count is cheap to write and never
checked. Treat this table as a snapshot with a date, not a fact.

```
src/
  App.tsx                4092  screens, navigation state, focus + announcements,
                                keyboard shortcuts, request gates, Home/Work places
  textscale.ts            222  detects the platform's font scale, whichever way it is applied (§12.7, §14.8)
  shellcheck.ts            77  is this document the app? (the service worker's guard)
  sw.ts                   264  offline shell service worker
  errors.ts                54  describeError: a message for any thrown value
  settings.ts             347  typed, validated, quota-safe persistence
  theme.ts                367  AAOS design tokens (colour, type, layout, shape)
  icons.tsx               421  29 maneuver kinds + system icons, hand-drawn SVG
  geo.ts                  364  polyline codec, haversine, formatting, snapping,
                                + snapAlong (metres along a line) and vertexAt
  styles.css             2961  layout, insets, responsive rules

  osm/
    engine.worker.ts     1292  parse (whole + streaming) -> graph -> index -> gazetteer, + A*
    pbf.ts               1007  .osm.pbf protobuf reader, whole-buffer and streaming
    engine.ts             442  worker client, format sniff, GeoJSON mirroring
    regions.ts            465  RegionLibrary, catalogue, bbox helpers, merge cache
    merge.ts              318  union-find merge of adjacent extracts
    mergeguard.ts         201  can a merge be afforded here? three outcomes
    importguard.ts        351  can a parse be afforded here? three outcomes (§15.2)
    tags.ts                36  shared node-tag filter

  nav/
    valhalla.ts           502  Valhalla /route client, response validation
    reroute.ts            415  reroute policy: when to act, backoff, banner,
                                        and why a refusal keeps saying why (§14.10)
    providers.ts          416  provider chain, attempt trace, connectivity
    requests.ts           107  RequestGate: one live route request at a time
    chrome.ts             117  the two bars' measured heights, as --eta-h and --nav-h
    steps.ts               66  why the turn list is empty: three causes, three answers
    engines.ts            239  engine selection, readiness, provenance
    geocode.ts            235  Nominatim client, 1 req/s throttle
    location.ts           256  device/browser/simulated location
    offroute.ts           120  deviation detection primitives, reroute origin
    progress.ts           126  ETA policy: monotone, never zero, keep last good
    maneuver.ts            85  Valhalla maneuver codes -> icons
    traffic.ts            163  fastest-of-N-alternates traffic verdict
    voice.ts              125  spoken guidance, deduped per meaning

  map/
    MapView.tsx           578  MapLibre view, tile/offline style switch, basemap LRU
    style.ts              520  Google palette, tile remap, offline LOD style

  regions/
    download.ts          1493  streaming downloader, resume, part-file handling
    RegionsScreen.tsx    1247  manage, catalogue, cross-region route test
    persist.ts            650  IndexedDB caching of parsed datasets
    store.ts              395  RegionLibrary singleton, per-region workers, memory gate

test/            1189 unit tests, 60 files
test/e2e.mjs           69 browser checks, built bundle
test/screens.mjs       53 checks x 3 viewports (159 total)
tools/osm2pbf.mjs        322 XML -> PBF encoder (builds the test fixtures;
                             extract slicing is done by osmium on a desktop)
tools/serve.mjs         306 LAN static server for on-device manual testing
tools/bundle-budget.mjs 153 gzip size budget; fails on regression
tools/reflow.mjs        368 chrome overlap at 100/175/200% text (§13.8) — a
                             diagnostic, still not a gate: it needs a
                             browser and takes minutes, and one that
                             reports nothing stops being read (§12.7)
tools/textscale-check.mjs 376 does the app notice a text scale that leaves
                             the root font size alone (§14.8) — a gate;
                             was 3-in-12 flaky (§2.2)
tools/focus.mjs         297 15 keyboard/focus checks in a real browser (§11)
tools/shots.mjs         195 screenshot every screen + computed styles (§11)
tools/sw-shellcheck.mjs  99 offline boot after a captive portal (§13.3) — a gate
tools/status-audit.mjs   406 STATUS.md checked against the files it describes
tools/diag-route.mjs     55 throwaway used to read a failing e2e check (§3.19)
```

`App.tsx` at 3936 lines is the largest file in the project and is now the main obstacle to
working on it: the guidance model, the routing orchestration, the reroute effect and every
screen live in one component, so a change to any of them risks all of them, and the failure
mode is a render-time throw that only a browser suite can see (§3.19). Splitting the
screens and the guidance model out is the obvious next structural step, and it is listed
now precisely so that it is not rediscovered as if it were new.

---

## 7. Known gaps

Ordered by how much they matter. **This list is renumbered** — it ran to 18 in the
previous revision and now has 12 entries, because gaps closed here were removed rather
than left as struck-through tombstones. References elsewhere in this file to "gap 16"
or "gap 18" are to the *old* numbering and say so; the current numbers are 1–12.

1. **Never run on physical hardware.** Everything is browser-verified plus one
   Android 14 emulator. WebView behaviour, real GPS quality, SAF file import and
   on-phone memory pressure are unproven. The one gap no amount of further work
   here can close — it needs a phone. *(Was gap 2; renumbered, and the old gap 1
   is closed — see below.)*
2. **A real province has never been parsed on device.** Streaming (§3.12) is
   verified for equivalence and against a 19-way fixture; peak memory on an
   actual 100–900 MB extract is unmeasured. Streaming removes the ~2× file-size
   spike but does not prove the parse fits a phone. This also bounds the merge:
   the guard in §3.18 estimates from declared graph size and refuses rather than
   guessing, but a refusal on a real province has never been seen.

   **Superseded in part by §14.17.** The PBF path *is* streamed now, so the ~2×
   file-size spike is gone for the format production uses, and the parse peak is
   bounded by one blob. Two things are still true and one is now much worse:
   peak memory has still never been measured on hardware, the boxed node map is
   still the dominant term, and the heap guard in `importguard.ts` **refuses
   province-sized extracts on every device** — which turns this from "unproven"
   into "known to fail, deliberately". See §7 gap 13 and §15.1.
3. **The offline LOD refreshes on zoom, but is unverified at province scale.**
   There was no `zoomend` listener at all, so the level of detail only changed as
   a side effect of a GPS fix and at a standstill the map visibly refused to gain
   detail — fixed in §11. What is still unverified is the other half: §3.13's
   assertions are structural (every line layer has a floor below zoom 10,
   arterials branch on class at low zoom), and the only extract available offline
   is the tiny fixture, which cannot show what a province looks like at zoom 6.
   See that section for why the claims are worded the way they are.
4. **SAF file import untested on device, and one-tap download is CORS-blocked
   everywhere.** Two things, and they are the reason device runs have never
   produced a map.

   *The picker.* The file picker cannot be driven through `adb shell input`, so
   device runs start with no map loaded and the offline engine correctly reports
   "No offline map loaded". Browser-tested only.

   *The catalogue.* Measured, from Node (no CORS involved) against the real URL:

   ```
   status 200 · 351,019,667 bytes · accept-ranges: bytes
   Access-Control-Allow-Origin: null
   ```

   Geofabrik serves the file perfectly and sends **no** CORS header, so a
   cross-origin `fetch` is blocked before any response is formed. Valhalla, the
   working routing provider, sends `*`. In a browser this is total: one-tap region
   download cannot work, ever, from any code.

   **What the driver used to be told instead, and no longer is.** The probe returns
   this as a *verdict* carrying a sentence written for it — naming the host,
   explaining that extract hosts do not allow cross-origin reads, and pointing at
   Import as the route that works. `startDownload` was reading `avail.ok` and
   `avail.status` and discarding that sentence, replacing it with *"The catalogue URL
   may have moved, or this device may be offline"* — both clauses false for the only
   failure that actually happens. Fixed in §14.11. A dead-but-routable host is now
   also distinguished from a cancellation, which it was being reported as.

   **On device this is unverified, and the likely answer is that it is also
   blocked** — the Capacitor WebView's origin is `https://localhost`, so the same
   rule applies, and `CapacitorHttp` is *not* enabled in `capacitor.config.ts`.
   The documented bypass is not a safe one either: Capacitor's own documentation
   says large transfers over the bridge cause issues and points at
   `@capacitor/file-transfer` instead. Enabling `CapacitorHttp` patches
   `window.fetch` *globally*, which would replace this app's streaming 900 MB
   download — the thing §3.12 exists to make survivable — with a whole-body bridge
   transfer. That is a trade, not a fix, and it is not one to take blind.

   The app already handles the browser case honestly: `networkMessage` names the
   block, says the connection is fine, and offers the route that works — download
   the file yourself and use Import. So this is a **capability** gap, not a defect.
   The genuine defect would be a device that reports "could not be reached" when
   the real answer is "the platform blocked it", and that is unproven either way.
5. **A reroute that is *refused* cannot be produced in a browser.** Everything around it
   is covered; this one case is not, and §14.10 records why with the measurements. The
   policy is unit-tested to its cap (`reroute-backoff.spec.ts`), the sequencing on its
   own (`requests.spec.ts`), the two together (`reroute-gate.spec.ts`), and the *reason*
   a failure keeps reporting itself (`reroute-reason.spec.ts` — which closed a real
   defect found while chasing this).

   The browser suite asserts the three properties around it that *are* reachable: the
   driver is told, the reroute is answered **by the offline map with no network request
   at all**, and nothing ever claims a new way was found.

   **Correction to an earlier note here.** A previous revision recorded that "reroutes
   use `enginePlan`, whose first entry is the offline engine on the default selection,
   so the request is answered by the imported fixture", and concluded that a refusal was
   therefore unreachable. The first half is right — `local` is first in
   `planRoute` — and the conclusion was wrong twice over, because the offline engine
   does answer, and it succeeds. §14.10 has the measurements. It needs either a hook
   that exposes reroute state to the test, or an online engine as the selected one.
6. **Offline turn-by-turn infers turns** from bearing changes. Real instructions
   need Valhalla. Measured against Valhalla on one 4 km stretch it missed three of
   seven real maneuvers, invented one and reversed one direction — so the app now
   *labels* inferred guidance as inferred (§10.5). The inference itself is still
   wrong often enough that it should not be relied on for navigation.
7. **zstd PBF blobs are rejected by name.** Geofabrik still ships zlib, so this is
   future-proofing only. Worth recording why it is *not* fixed: no platform
   `DecompressionStream` format decodes zstd, and a hand-written decoder is a
   large, security-sensitive dependency to add for a format nobody publishes yet.
   The honest form is the current one — name it and say so — rather than a
   plausible-looking partial implementation.
8. **Emulator cutout band.** A black band remains where the emulator simulates a
   display cutout. Believed cosmetic and device-specific; not confirmed.
9. **Optional: NDK cross-compile Valhalla** to replace the local engine with real
   turn-by-turn. Gaps 6 and 9 share one dependency, and §5.3's objection is
   external rather than about effort: arm64 sysroot builds of boost, luajit,
   prime_server, GEOS and zlib either exist or they do not. Worth a bounded
   feasibility spike before committing anything.
10. **Chrome still covers ~98% of the viewport** at phone portrait, and ~142% of
    its height in landscape. Every element is 76dp or larger because the design
    says so, and none of them is in the wrong place — but a driver looking at this
    sees very little map. The first thing a designer would cut, and the one change
    that should not be made without one.
11. ~~**The platform's font-size setting does nothing, and the navigation screen
    cannot cope when the text is large anyway.**~~ **Closed** (§14), and the gap's
    own premise was wrong.

    This was the largest item in this document for four passes, and **both halves of
    it rested on a false claim** — see §14.9. The claim was that Android's font setting
    reaches a WebView by scaling the root font size and that "absolute `px` lengths are
    not affected by it". Chromium's own WebView documentation says the platform
    multiplies *text*, via `setTextZoom`, whatever unit it was specified in — so the
    `rem` conversion this gap nominated as "the real fix" **would have achieved
    nothing**.

    What was real, and is now fixed:

    - **The leading was a px length**, so it did not follow the platform's scale, and
      at 175% every text element had a line box shorter than its own glyphs. The token
      emits Google's leading as a ratio now (§14.1). Five "clipped labels" → **zero**.
    - **The bars' heights were constants** next to content-dependent boxes, so anything
      anchored to them collided once the text grew (§14.2). They are measured now.
    - **The detector watched the one value the platform does not change.** Root font
      size stays 16px under a text scale, so `data-textsize` never became `large` and
      **none of the above would ever have been used**. It reads a rendered probe as
      well (§14.8).
    - **The off-route notice was invisible at 100% text** on a landscape phone
      (§14.3), and is now above the maneuver card rather than below it (§14.4).

    `npm run reflow` is green at all three text sizes and `npm run textscale` covers
    the detection. **The `rem` conversion is struck**, not deferred: it would not have
    fixed anything, and §14.9 records why with the sources.

    What remains unverifiable is the confirmation this cannot get: §7 gap 1, that none
    of it has been seen on a physical device.
12. ~~**`RoadGraph.regionOf` is a merged-graph-only field that the persistence
    layer still knows about.**~~ **Closed as a misdescription**, and it took two
    corrections to get to the bottom of it.

    The original claim was that it "is persisted for every region … the bytes are
    still wasted on single-region entries". **False** — §13.4 established the parser
    never sets the field, so there are no bytes to waste.

    What replaced it was that "the serialiser has a branch that is currently
    unreachable". **Also false.** The branch is reachable through the public API and
    is covered: `test/persist.spec.ts` asserts *"restores a merged graph including the
    optional regionOf array"*, round-tripping a real `mergeRegions` output through
    write and read and comparing the array. It is live code with a test over it.

    What is true, and all there is: **no app flow ever persists a merged graph**, so
    that path is defensive rather than exercised in the running app. That is a
    statement about the caller, not about the serialiser — and the alternative,
    deleting the field, would silently remove the only thing that would let a merged
    graph round-trip if §3.18's merge cache were ever made persistent.

    Two corrections to one two-sentence note, in four passes. It is the cheapest item
    in this document and it took longest to describe accurately, which is the
    argument for measuring a claim before writing it down rather than after.
13. **Alberta cannot be imported, and there is no smaller Alberta to import
    instead.** The newest gap, and the only one that is a *design* limit rather than
    an unmeasured risk.

    **Verified against the source, 2026-10-07.** Geofabrik's Alberta extract page
    reports *"No sub regions are defined for this region"*, and
    `alberta-latest.osm.pbf` is **334 MB**. So the highest-leverage fix for
    low-end hardware — offer smaller sub-regional extracts instead of provinces —
    **is unavailable for this province.** That was the whole of the first
    recommendation, and it was wrong for the one province that prompted it.

    §14.17's heap guard then makes it explicit rather than accidental: at
    `PBF_BYTES_PER_NODE = 8` and `PARSE_BYTES_PER_NODE = 112`, 334 MB estimates to
    ~44 M nodes and ~4.9 GB, which exceeds the budget on an 8 GiB device. The app
    now **refuses**, with a message naming `osmium extract -b` as the way out.

    The refusal is correct. What is not shipped is any way to act on it *inside the
    app* — the message sends a driver to a desktop they may not have. §15.1 is the
on-device bbox crop that closes that, and it is the first item there for a
    reason: without it, the largest catalogue entries are unusable and the guard is
    only a well-worded wall.

### 14.18 The guard's refusal said nothing, and §15.3's coverage found it

`RegionsScreen` calls `canImport(file.size)`, which returns a `reason` written
carefully — the file's size, the memory it needs, the budget this device reported, why
the system would kill the parse rather than raise, and the one command that fixes it —
and then **discarded it**, replacing the whole thing with *"This device is not expected
to have enough memory to read that file."* Same shape as §10.5's dead catalogue probe:
the diagnosis is computed and thrown away.

It matters more here than there, because the override exists precisely so a driver can
**disagree** with the estimate. `forceMemory` is documented as "a user who has just
watched a progress bar say 'this needs 4 GB' is entitled to disagree with it" — and the
user was never shown the 4 GB. The card now renders `reason` itself, with
`white-space: pre-line` so the indented `osmium` line stays copyable.

### 14.19 §15.3 item 9 — driving the guard through the UI, and what it cost

The refusal path had **no browser coverage at all**. `test/importguard.spec.ts` covers
`canImport` and `test/import.spec.ts` covers `importRegionFile`'s use of it, but nothing
rendered the card — so §14.18 shipped behind two green unit suites, on the one control
that stands between a 334 MB file and a killed WebView. §3.19's exact shape.

Eleven checks now drive it. Making them *true* took three attempts, and **every failure
was a correct check the test had misdiagnosed** — worth recording, because two of them
would have been "fixed" by changing code that was right:

1. **40 MB of zeros.** `importPreflight` reported "it is not OpenStreetMap data" — right.
   It sniffs the first 32 bytes, and zeros are neither XML nor a PBF blob header.
2. **The same file with a real `<osm version="0.6">` head.** Preflight passed it, and *no
   refusal appeared* — because 40 MB was not big enough. `navigator.deviceMemory` reports
   **16** in this Chromium, so `rawHeapBytes` grants 8 GB and 40 MB estimates to ~560 MB:
   a ratio of 0.07. The guard was working exactly as designed and the fixture simply fit.
3. **A size derived from the budget.** `estimateParseBytes` is `bytes / 8 * 112`, so the
   file that overflows a budget of *B* is `B × 8 / 112`. The fixture is built from the
   stubbed device figure, and the suite prints both numbers so the margin is visible rather
   than asserted. A "big enough" number written once is this document's recurring failure,
   and deriving it is the fix.

Two details that make it a real test rather than a plausible one:

- **The device figure is stubbed down, in its own context, via `addInitScript`** — because
  this block tests the guard's *wiring* (refuse, offer an override, honour it, let it be
  dismissed) and its constants are already pinned directly by `test/importguard.spec.ts`.
  Testing wiring needs a low-end device, and a 2 GB phone is exactly that. `addInitScript`
  runs before the app's modules, so the stub is in place when `rawHeapBytes` first reads
  it; applied later it would pass for the wrong reason.
- **The override asserts the *absence of the memory message*, not that an import
  succeeded.** §14.17 records why: `importRegionFile` returns `null` for a refusal *and*
  for a failure, so "the return value was non-null" cannot tell them apart, and the first
  version of this assertion would have passed while proving nothing. A separate check
  waits for the parser's own verdict, so "honoured" is distinguished from "silently never
  ran".

One probe failed first for the best possible reason: *"refusing does not also start the
parse"* matched `/Parsing/` against `body.innerText`, and the guard's own refusal copy
contains the word — the message was explaining that parsing was refused. It now asserts on
`.progress-card` not existing, which is what the progress indicator actually is.


### 14.20 The crop, and a guard that refused it anyway

§15.1 item 2, built on §15.1.1's measurement. The reader takes a box, drops every node
outside it **as it decodes**, keeps the ways that touch what is left, and reports what it
kept. The Regions screen's refusal now offers *"Import just the area I'm in"*, which is what
makes it reachable — `src/osm/merge.ts` was 318 correct lines plus ~800 lines of unreachable
tests for a release, and an uncalled crop is that defect again.

**The box is sized from the device, not from a constant.** `affordableBoxAround` inverts the
chain §15.1.1 measured: budget ÷ 229 B per kept node ÷ 12,400 nodes per km² (Manhattan, the
densest place in the sweep), square root. A fixed 0.12° is wrong at both ends — on a 2 GB
phone it is ~8.8 M nodes and the WebView dies, which is the exact failure the guard exists
to prevent; on a 16 GB machine it is needlessly small.

**And a fixed box was the first version, so the button did nothing.** `onAreaOnly` caught its
own failure and returned without importing. That is §10.5's shape — a control wired to
nothing, reported as working because nothing threw — and it is invisible to every suite,
because the suite never clicked it. It was found by a reversal, which is the only reason it
was found at all.

**The bigger defect: the guard refused the crop on the whole file's size.** `importRegionFile`
ran `canImport(file.size)` unconditionally, so an import carrying a crop was refused before
the crop was considered — 146 MB refused on a file the crop would have read a fraction of.
§15.1.1 named this exactly: once a crop exists the surviving node count is a function of the
box, not the file, so a size-derived estimate is the wrong *shape*. Refusing for a reason
that no longer applies is the same failure as returning a wrong route — confidently, and
about something other than the thing asked.

A cropped import is therefore **warned**, not refused, and the warning says the honest thing:
the cost is unknown until the parse reports it. That weakens the guard deliberately, and the
mitigation is that `parseOsmPbfStream` reports `keptNodes`, so the measurement arrives
immediately after instead of a second guess standing in for it.

**Two more defects, both in the builder rather than the reader.** `buildDataset` skipped a
way's missing refs and joined the survivors, which draws a straight segment across whatever
was dropped. For corrupt data that is metres of error; under a crop it is kilometres, across
ground the driver cannot see, and the router will route along it. Refs are now collected as
*runs*, and a road leaving the cropped area ends at the edge. Behaviour is unchanged when
nothing was dropped, because then there is one run.

And `LatLng` is `[lon, lat]` while a crop box is `west, south, east, north` — the opposite
order, and a transposed box is a plausible-looking crop of the wrong hemisphere. Spelled
out rather than destructured.

**What the browser suite proves, and what it does not.** Two checks in `test/e2e.mjs`: the
refusal offers the area crop, and clicking it is *requested*, passes the guard, and reaches
the parser. It cannot prove the filter was **applied** — the fixture is padding, so a cropped
and an uncropped parse both end in "contains no OpenStreetMap data". Two reversals (`store.ts`
dropping `req.crop`, and the guard re-refusing the whole file) left that check **green**,
which is how the limit was found rather than assumed.

So "applied" is proven in `test/worker-crop.spec.ts`, driving the worker's real `onmessage`
handler against the real PBF fixture — whose content is scattered from lon -115 to -1.32, so
a box around Edinburgh keeps some and drops the rest and a no-op filter cannot pass. Five
reversals, each verified to fail: the worker's stream path, its whole-buffer path, `engine.ts`'s
`postMessage`, the reader's box test, and `cropIgnored`.

Two of those reversals were *first* green, and both were the same mistake: the earlier version
posted only `bytes`, so the stream path — the one production uses — was never executed, and
the test drove the worker directly, so `engine.ts` was never executed either. A test that runs
one of two paths proves the one it ran.

**One more finding, about the harness rather than the app.** A `vite preview` server had been
holding port 4192 for **3.8 days**, so every browser gate in this pass was served a bundle
built long before the change under test. Two reversals reported green because the page was
running old code. `npm run e2e` does not start its own server — it documents that one should
be running — which makes "is the server serving the current build?" a question every browser
reversal has to answer, and one this pass answered wrongly twice. Killed and restarted; the
figures in §2 are from the fresh server.

### Closed in the §3.17–3.19 pass

| Was gap | Now |
|---|---|
| Cross-region routing stitched at a bounding-box midpoint and produced a wrong route (§7 gap 1, the "most serious open gap") | One A\* over a merged graph, cached, behind a memory guard that refuses with a reason. §3.18, §3.5.2 |
| `merge.ts` was 318 lines of dead code plus ~800 lines of unreachable tests | Called by `RegionLibrary.route()`; requirement #10 implemented |
| The ETA could read `0 m` while route remained, and increase while driving forwards (§7 gap 12, "the most dangerous readout in the app") | Three properties as pure policy, asserted as properties. §3.17 |
| A `useMemo` closing over a later-declared ref broke the whole app with all 747 unit tests green | `test/tdz.spec.ts` and `test/app-render.spec.ts`. §3.19 |

### Closed by the engine audit (§12)

| Was | Now |
|---|---|
| **The A\* priority queue was not a heap.** One priority slot per *node*, and A\* pushes a node once per relaxation — so the stale entry compared as the re-priced one, `pop()` stopped returning the minimum, and the optimality guarantee was void. The default engine. | Priorities travel with their entry. `test/minheap.spec.ts` asserts the invariant **and keeps the broken implementation in the file asserting it does not pass**. §12.1 |
| **A crashed parser hung the import forever.** `onerror` logged and returned, so an OOM on a 900 MB extract left `buildPromise` pending: no error, no retry, no way out but force-quitting. | `onerror`, `onmessageerror` and `dispose()` all settle the build through one helper, and take the progress card down. §12.2 |
| **The banner said "In 0 m, turn left onto a road already turned onto"** for the whole final leg — `?? active` is a maneuver *behind* the driver, so the measured leg collapsed to a single point. | Falls back to the last leg, which measures to the destination vertex. §12.3 |
| **A stored record missing `counts` crashed the app on launch**, in a `useState` initialiser during render, with no Settings screen to recover from | Validated on read like every sibling field. Verified to fail without the fix. §12.4 |
| The GPS watch was never cleared — the receiver stayed hot for the life of the WebView | `clearWatch` on the captured id. §12.5 |
| `speak()` latched its dedup key before calling the platform, so a WebView with no TTS engine swallowed every instruction once and never retried, while the button read "Mute" | The key is released on failure. §12.5 |
| `DEFAULT_ENGINE_IDS` listed three ids that do not exist, so any caller relying on it silently reverted a saved hosted engine to `local` | The real ids. §12.5 |
| A blank place label round-tripped as lowercase `"home"` | Capitalised fallback, matching `readPlaces`. §12.5 |
| The platform's font setting did nothing, and the navigation screen overlapped itself when the text was large | **Half.** Detection ships; the banner-stack fix ships and is re-measured; the control column's does not, because it made that column worse. §12.7, §7 gap 11 |

### Closed by the third pass (§11)

| Was | Now |
|---|---|
| A letter could not be typed anywhere: the `m` mute shortcut sat above the typing guard with an unconditional `preventDefault` | The guard is first. §11, `test/focus.mjs` |
| Focus was destroyed on every screen change, so the next Tab restarted from the top of the document | A screen change announces itself, takes focus, and sets `document.title`. §11.1 |
| Every "unavailable — and here is why" sentence was inside a `disabled` button, so it could never be reached | `aria-disabled` throughout, with the activation refused. §11.2 |
| Arrival was never announced or spoken for any Valhalla route, because `next` is built with `?? active` and so was never null | Derived from progress. `test/audit-regressions.spec.ts` |
| The distance to the next turn was capped at 9999 m and the capped value was *spoken* | The true distance. §10 |
| Non-major turns were painted at display3 and spoken as nothing | Every instruction change is spoken and announced |
| Valhalla's own error text reached the driver in a red card | Translated to something actionable; the raw text kept in the trace |
| Home and Work routed to two fixed points in the English Channel | The driver's own saved destinations, unset until set |
| With no GPS the map opened on London while the app's position was Calgary — 7,000 km apart | One exported placeholder, and the map opens on it |
| The maneuver arrow had no background for every non-major turn (declarations stranded between rules) | The declarations are inside the rule; the suite parses the stylesheet |
| The ETA bar sat under the system status bar and the nav bar in the gesture area (padding shorthand resetting an inset longhand) | One shorthand with the inset folded in |
| The launcher computed to one column at phone portrait — five 158dp tiles in an 886px scroll | Two columns, sized to fit |
| The app bar ellipsised to "Canopy …" and "Onl…" at 412px | The wordmark has a short form; the pill is sized by its content |
| A successful fallback route painted a warning in the red error card above Start | Warnings have their own tone, and a fallback is the expected path |
| The whole provincial road network was re-serialised to GeoJSON once a second | Cached per dataset and zoom |
| Overlays were applied from props frozen at the start of a style boot, so a route chosen in that window drew nothing | Read live from a ref |
| Zooming gained no new roads on the offline map | `zoomend` re-applies, and `prefers-reduced-motion` is honoured |
| Every settings *read* was unguarded, so a WebView whose `getItem` throws opened on the crash card | `safeGet` throughout |
| Region deletion discarded the reason it had built for itself; a refused write freed no bytes and said nothing | Awaited and reported |
| A 900 MB download outlived the Regions screen | Aborted on unmount |
| The catalogue availability probe fired every URL at once, with no deadline, under a comment claiming it was lazy | Four at a time, 10s each, cancelled on unmount |
| The focus ring measured 1.97:1 on the map | A three-layer sandwich that passes on both extremes |
| Progress was a firehose in a live region, or absent entirely on Regions | The number is the progressbar's value; the region carries the stage |
| `<main>` did not exist and three screens had no heading | `<main>`, a heading per screen, `aria-modal` on both dialogs |

### Closed by the audit pass (§10)

These were all live gaps or missing capabilities before §10, and are recorded here
so the list above is not read as the whole story:

| Was | Now |
|---|---|
| Offline did not survive a reload — the browser served its own disconnected page | Service worker precaches the shell; verified by reloading with the network off || Mute controlled no audio at all | Real spoken guidance via the Web Speech API; disabled-with-a-reason where no engine exists |
| No map attribution was displayed — an ODbL breach | Credit declared on the map sources and rendered; regression-guarded in `test/attribution.spec.ts` |
| The parser accepted `lat="-200"` and invented 74,756 addresses | Coordinates bounded in both readers; bounding box no longer reports its sentinel |
| A corrupt/empty/road-free `.osm` silently replaced a working map | Refused with a specific message; the map is left untouched |
| No settings survived a reload — 0 of 5 | All persist, validated on read, with quota failures reported |
| An engine labelled "Unavailable" was fully selectable | Inert, with the reason in the row |
| No focus ring anywhere in the app (UA default, 1.06:1) | A ring that survives both the dark chrome and the light map canvas |
| The import file picker was unreachable by keyboard | A real button driving a visually-hidden input |
| `m` (documented as mute) opened the search screen; Escape ended an active trip | Named keys matched first; Escape unwinds one level and never ends a trip |
| The online geocoder was 100% dead — its host did not resolve | Fixed, and the readiness reason now names the real cause |
| `geocode.ts` had no request timeout | 12 s, composed with caller aborts; verified against a hanging host |
| The off-route banner printed `6978332 m off the route` | Says what the driver acts on; the rejoin distance is formatted in their units |

Closed since the last release (v0.11.1): app bar / grid cell are now tokens
(§3.14), the test server is in the repo (§3.14), reroute is wired (§3.11), the XML
parse streams (§3.12), the offline LOD fix (§3.13), the corrupt `.nav-panel` rule
and the screen-coverage regression that hid three layout bugs (§4.6, §9), and the
three cold-start console warnings (§3.15).

---

## 8. Commands and workflows

```bash
npm install
npm run dev          # vite dev server
npm test             # 1189 unit tests
npm run e2e          # 69 browser checks against the built bundle
npm run build        # typecheck + production build
npm run preview      # serve the built bundle
npm run sync         # build, clear android assets, cap sync
npm run apk          # sync + gradlew assembleDebug
npm run typecheck
npm run screens      # screen coverage at 3 viewports
npm run focus        # 15 keyboard and focus checks in a real browser
npm run swshell      # offline boot after a captive portal (a gate)
npm run reflow       # large-text reflow — a diagnostic; was failing, green as of §14
npm run textscale    # does the app notice a text scale that leaves the root alone
npm run status       # STATUS.md checked against disk
# with per-file test counts, feed it a real run:
VITEST_JSON=/tmp/r.json npx vitest run --reporter=json && VITEST_JSON=/tmp/r.json npm run status
npm run serve        # LAN server for on-device testing (see below)
```

**JDK 21 is required.** Gradle 8.11 cannot run on Java 25
(`Unsupported class file major version 69`). `npm run apk` defaults `JAVA_HOME`
to JDK 21.

### Releasing

```bash
npm test && npm run e2e && npm run screens
git commit -am "..." && git tag -a v0.11.4 -m "..." && git push origin main --tags
```

**Then read the CI run.** Per §3.16, that is the only thing that makes "CI runs
the full gate" true.

The Release workflow runs typecheck, unit tests and the build, then attaches the
APK; the browser suites run on CI for the same commit. **15 releases across 17
tags**, latest v0.11.3. `v0.7.0` and `v0.10.0` have tags whose Release runs
failed, and v0.11.2 needed one re-tag for the same reason (§9) — so a green tag is
not evidence of a green release, and the release list is the thing to read.

### Android device testing

```bash
sdkmanager "emulator" "system-images;android-34;google_apis;x86_64"
avdmanager create avd -n canopy -k "system-images;android-34;google_apis;x86_64" -d pixel_6
sudo gpasswd -a "$USER" kvm          # /dev/kvm is root:kvm 0660
sg kvm -c "$ANDROID_HOME/emulator/emulator -avd canopy -no-window -no-audio -gpu swiftshader_indirect"
adb install -r -g app/build/outputs/apk/debug/app-debug.apk
adb emu geo fix <lon> <lat>          # required, or the app reports "Simulated GPS"
adb logcat -d | grep -i "Capacitor/Console"
```

`adb emu geo fix` matters: without a real position the location-driven route
progress and off-route detection cannot be exercised.

### Local state that does not survive a reboot

```bash
npx playwright install chromium     # build 1243 for playwright-core 1.63
```

The `canopy` AVD already exists (`~/.android/avd/canopy.avd`, Android 14 /
google_apis x86_64) and `/dev/kvm` is present, so a boot is ~15 min with `sg kvm
-c`. `test/fixture.osm` can be pushed to `/sdcard/Download/` but the SAF picker
still cannot be driven by `adb shell input` (gap 5), so device runs begin with no
map loaded.

---

## 9. The plan, and what happened to it

The work was planned in blocks and then spent across several sessions. This
section records it because **the record of the estimate is itself the useful
part**: the first plan was padded by roughly 5×, and correcting it changed which
gaps looked expensive. Several blocks were then added mid-flight by audits rather
than by planning, and those found more than the plan did.

### 9.1 The plan

| Block | Work | Closes | Outcome |
|---|---|---|---|
| 1 | Unblock the e2e gate (`playwright install chromium`) | — | **Done** |
| 2 | Engine selection + provenance visibility | req #2, #18 | **Done** (§3.6.1) |
| 3 | Wire rerouting into the navigation screen | req #18 | **Done** (§3.11) |
| 4 | Streaming parse | §7 gap 2 | **Done** (§3.12) |
| 5 | Emulator: exercise nav + reroute on device | §7 gap 1 | **Partly done** |
| 6 | Zoomed-out offline density as a style/LOD fix | §7 gap 3 | **Done** (§3.13) |
| 7 | Tag, read the CI result, update STATUS | req #16, #21 | **Done** — v0.11.2 and v0.11.3 released, both workflows green |
| 8 | *Added by audit:* dead-code + STATUS reviews | — | §9.3 below |
| 9 | *Added by audit:* reroute failure paths, frozen-position loop | — | §3.11.1 |
| 10 | *Added by audit:* PBF coordinate correctness | req #5 | §4.1 |
| 11 | ETA readout: monotone, and `0 m` means arrived | req #19, §7 gap 12 | **Done** (§3.17) |
| 12 | Wire cross-region merging, behind a memory guard | req #10, §7 gap 1 | **Done** (§3.18) |
| 13 | *Added by the crash of block 11:* gates for render-time failures | — | **Done** (§3.19) |
| 14 | Every boundary: network, disk, service worker, request sequencing, a GPS fix | req #19, §7 gaps 11–18 *(the previous numbering; the list is now 1–12)* | **Eleven closed; the layout half of gap 11 left open, and not attempted again** (§13) |

Block 14 was also not planned. It came from a single question applied to every
place this app meets something it does not control — *what does this do when the
thing on the other side goes wrong?* — and three of its six defects turned out to
be corrections to claims this document itself had been carrying (§13.4).

Blocks 8–10 were not planned. They came from asking what was still broken rather
than what was still missing, and they found the single most consequential bug in
the project (§4.1) plus a live reroute loop that had been shipping.

### 9.2 Release and CI

Block 7 is the one that only completes if someone looks at the result, and looking
caught a failure every time: the first Release run died in the test step, and two
later pushes failed because a spec read a fixture that was never committed and
then wrote scratch to a machine-local path.

That is four times in this project's history that a "green" local story turned
out to be wrong — §3.16's seven red pushes, §4.6's screen-coverage regression, and
these two CI failures. Every one was caught by reading the run output rather than
trusting the summary, and the last two only appeared *because* the work was
pushed. Verifying against a clean export of the git index, from a different
working directory, is now the habit rather than running the suite in place.

The "Closes" column now names §7 gaps as they are numbered *in this revision*.
The gap list was renumbered twice, and earlier versions of this table pointed at
the wrong numbers — which is the same class of error as the counts in §2: a
cross-reference written once and never re-checked after something beneath it moved.

### 9.3 What the audits found

Blocks 1–7 were complete, so the remaining budget went to asking what was still
*wrong* rather than what was still missing. Eight subagents were run in parallel
against non-overlapping ground — one returned nothing at all, which is itself worth
noting, since a subagent that fails silently is indistinguishable from one that
found nothing until you read its report. The ones that returned findings found
things I would not have gone looking for:

- A **dead-code audit** found the `.nav-panel` corruption and, more importantly,
  that `src/osm/merge.ts` — 318 lines plus ~800 lines of tests — is unreachable
  from the app. That makes requirement #10 false, which corrects §1 and §3.5.2
  and is now §7 gap 1.
- A **launch-warning investigation** traced the three cold-start console warnings
  to three layers of the upstream tile style (§3.15), and closed a gap that had
  been recorded as merely "untraced".
- A **STATUS.md audit** checked the document against the code and found that its
  own correction note was wrong about the e2e count, that the screen-coverage
  figure was unreachable, that §3.15 was referenced but never existed, that three
  §6 line counts were stale, that §1 row 12 overstated the provider count, and
  that §3.3's "asserted against a hand-computed bound" described an assertion
  that does not exist. All corrected here.
- A **dead-affordance audit** found four controls declared, wired to real work and
  never invoked — including no way to clear a route, and map taps that were a
  guaranteed no-op (§4.6) — and established that the whole navigation control
  stack had **zero** browser coverage, which is why the `.nav-panel` regression
  shipped (§4.7).
- A **reroute test pass** found that a frozen GPS fix rerouted every 30 s forever,
  measured at 20 requests in ten minutes, and that a failure reason was erased
  after one second (§3.11.1).
- A **cross-region investigation**, asked only to quantify how wrong stitching is,
  reported the PBF coordinate bug on its way past (§4.1). Worth noting the
  investigation was authorised as documentation-only and the fix was not: the
  measurement turned out to matter more than the thing it was measuring.

The screen-coverage regression (§4.6) was self-inflicted, and it is the most
useful thing in this section: I added a screen to the suite, broke the unwind with
`goBack()`, and the suite kept reporting "all checks passed" over a third of its
scope for the rest of the session. Had the audit not independently re-derived the
expected check count, it would still be broken.

### 9.4 Estimates, corrected twice

The original plan budgeted 30 minutes for `npx playwright install chromium` (a
one-line download), 45 minutes to replace 10 CSS literals, and 15 minutes to boot
an emulator that was **already running**. Two substantive corrections came out of
checking rather than assuming:

- **The offline map is an afternoon, not a quarter.** I had filed it as a
  weeks-long MBTiles pipeline. `MapView.tsx:174-176` already mirrors the parsed
  geometry into MapLibre `GeoJSONSource`s, so the data was never missing and only
  the level-of-detail was wrong.
- **The emulator was available all along.** I had written off the whole device
  axis on the grounds that there is no phone. `/dev/kvm` and a booted AVD were
  sitting there. The device gap narrowed to *physical* hardware only.

### 9.5 What actually happened

**Session one: 38 minutes of wall clock**, covering blocks 1, 2, half of 5, and
the STATUS half of 7. Then work stopped.

The stop was my error and worth recording plainly: after finishing a coherent
unit of work I ended the turn by *asking whether to continue*, when the plan had
already specified reroute as the next block and the instruction had been to work.
That cost roughly nine idle hours against a six-hour budget. The lesson is
narrower than "ask less": when a plan names the next step and the next step is
not destructive or ambiguous, continuing is not a decision that needs sign-off.

**Session two** picked up block 3 and did not stop: rerouting, streaming parse,
the LOD fix, the two owed requirement items, and the duplicate system-bar
handling. Unit tests went 380 → 516, e2e checks 23 → 39.

**Session three** did the audit work described above, and a fourth pass followed
it: unit tests 527 → 599, screen checks 42 → 150, and the two document
corrections above.

What the fourth pass found is the most important result in this record. A subagent
asked to quantify cross-region routing reported, alongside its measurements, that
`src/osm/pbf.ts` divides coordinates by 1e-9 where the spec says 1e-7 — so every
real `.osm.pbf` extract was being read 100× too small, putting Andorra at 0.42 N.
The parser and the fixture encoder shared the wrong constant, so the round trip
agreed with itself and the whole suite was green. I verified it before acting, and
it is worse than it looks: it also means most of gap 1 was theoretical until the
fix, because there was no correctly-parsed province on the device to stitch
between. Fixed in §4.1.

The generalisable lesson, and the reason it is written down at length: **a
self-consistent round trip cannot detect a mistake both halves share.** Two
audits in a row found bugs that every passing test was structurally unable to
see — this one and the `.nav-panel` corruption — and both were found by asking
"what is *specification* here, and is it written down anywhere?" rather than by
running the suite again.

Two process notes, because both cost real time:

- A restarted server killed the emulator mid-session and a verification run was
  lost, which briefly looked like a regression in the streaming import. It was
  not — re-running against a fresh preview server cleared it. **A failed check
  after an interruption is a hypothesis, not a finding.**
- One subagent's cleanup used a `pkill` pattern broad enough to take down a
  preview server another process was using. The same class of problem as §4.6: a
  tool acting outside the scope it was given, and no error raised.
### 9.6 Owed, and then done

Requirement #2's app-bar/grid-cell tokens (~15 min) and requirement #20's
`serve.mjs` living in `/tmp` (~20 min) were identified but never scheduled. Both
were dropped by stopping early rather than by a decision to skip them. **Both are
now done** — see §3.14.

### 9.7 Carried forward

**Session four** closed the two gaps this document had called most serious, in the
order the gaps were ranked rather than the order they were convenient.

**The ETA readout (§3.17) first**, because it was the most dangerous *readout* in
the app and it was bounded. The root cause turned out to be that the ETA re-projected
every fix from scratch while `progressAlong` was already monotonic — the two halves
disagreed, and only one of them had been thought about. Fixing it needed a new
primitive (`snapAlong`, in metres) before it needed any new policy, because a segment
index cannot express arrival at all.

**Cross-region merging (§3.18) second**, and it was the larger of the two by some
distance. The merge itself needed nothing: `merge.ts` was already correct and already
tested, and the entire gap was that nothing called it. All the work was in the four
surrounding decisions — where the merged graph lives, whether to attempt it, what to do
when it cannot be afforded, and what to tell the driver when it is refused. The last of
those is the one worth keeping: `route()` returns `null` for three unrelated reasons and
the caller cannot tell them apart, so "this device cannot compute this route" was
indistinguishable from "no route exists", which is how a reachable destination becomes an
unreachable one.

**Then a mistake, and the gates that came out of it.** The ETA fix declared `routePos`
below the two memos that read it. A `useMemo` callback runs during render, so that is a
temporal dead zone, and it threw on every screen. All 747 unit tests passed. The app
rendered the error boundary's recovery card and nothing reported a crash — the boundary
working correctly is what made it quiet. Only `test/e2e.mjs` caught it.

The process note is the same one as §9.2's and §4.6's, and it is now the fifth
occurrence: **a green result nobody re-derived is not a green result.** What is new is the
corollary, which cost the most to learn: *a suite that has never been seen to fail has not
been tested.* The e2e suite had a real bug in it for a whole session and the fix was to
read the failing check's actual page text rather than reason about the code, which is why
`tools/diag-route.mjs` exists. The first attempt to close the gap — a render smoke test —
turned out **not** to catch it, because both guidance memos return early on a first render
and the bug needs a route to exist. Shipping it as if it closed the gap would have been
the same mistake in a new place, so it is documented as buying something smaller, and the
static ordering check that does catch it is in `test/tdz.spec.ts`.

Two things that came out of writing those tests are worth more than the tests. The
ordering scan immediately reported a *second* instance of the same hazard —
`beginRouteProgress` read a hundred lines above its declaration, harmless only because it
runs on a click — and it was moved anyway, because a permanent documented exception to a
rule is how the original bug happened. And the first draft of the noise fixture in
`test/progress.spec.ts` passed with the monotonic clamp deleted: ±2 m of GPS noise cannot
flip an 11 m gap, so the test was decorative. Both are recorded because the temptation to
ship a green test that proves nothing is the strongest one in this project, and it has now
been resisted four separate times.

**Counts, re-derived rather than remembered:** 702 → 792 unit tests across 30 → 36 files;
e2e 44; screens 53 × 3 = 159; total JS 410.4 → 412.3 kB gzip. Thirteen line counts in §6
were stale and are now `wc -l` output. Note the direction of that last one: §2 carried the
correct screen figure (153) while §6 and §9.2 carried 150, so the error was not always a
number that was too large — which is the least useful thing to know about a class of
error, and the reason "just re-run it" is the only reliable instruction.

**Cross-region routing is no longer the most serious open item.** §7 has been
renumbered, and the old gap 1 is closed. What remains at the top is gap 1: never run on
physical hardware, which needs a phone and no amount of further work here.

### 9.8 Carried forward

**v0.11.2 is released**: 15 commits, CI green, Release green, APK attached. The
first Release run failed — 511 tests passed and then vitest died with
`process.exit unexpectedly called with "1"`, because `tools/serve.mjs` ran a
`process.exit(1)` start-up check *on import* and CI runs the tests before the
build. Fixed, with a regression test that reproduces the CI condition; the
original version of that test passed with the guard deliberately removed, because
`dist/` exists locally. Verified by breaking the guard again.

### 9.9 Serving for manual testing

```bash
npm run build && npm run apk    # dist/ and the debug APK
npm run serve                   # 0.0.0.0:8080, prints the LAN URL
```

Serves `dist/` with the APK at `/dl/canopy-nav.apk`. It lives in the repo
(`tools/serve.mjs`) rather than in `/tmp`, where a cleanup silently killed the
manual-testing setup. The scripts this replaces:

```bash
npm run screens                  # screen coverage at 3 viewports
```

---

## 10. The audit pass

Ten browser audits were run in parallel, each owning one area of the app and
instructed to drive the **built bundle** in Chromium and report on UI, UX,
performance and anything that did not behave as intended. All ten reports are in
`/tmp/opencode/audits/`. What follows is what they found, what was done about it,
and — more usefully — what they found that is still not fixed.

The headline is that **auditing found four defects where the app claimed a
capability it did not have.** Those are worse than a crash, because a crash is
visible and a claim is believed.

### 10.1 Claims that were false

**The offline promise did not survive a reload.** The app's central claim is
that it works with no network, and that was true right up until you reloaded the
page: with no network the browser never reached the app at all and served its own
`ERR_INTERNET_DISCONNECTED` page. Nothing had cached the bundle, because the app
lives at a real origin. In a car that is the *common* case — a driver opening the
app in a tunnel before the WebView has ever cached it — and there was no way
forward from that screen.

There is now a service worker (`src/sw.ts`), built as its own Vite entry,
precaching the shell. Getting it to work took four attempts, and each failure
looked like success, which is the only reason they are written down:

| Attempt | What happened | Why it failed |
|---|---|---|
| 1 | `sw-<hash>.ts` emitted | `new URL('./sw.ts', …)` makes Vite treat the worker as a *static asset*; the output was untranspiled TypeScript, which no browser can execute |
| 2 | Cache held `index.html` and nothing else | JS and CSS filenames are content-hashed, so offline every module script 404'd |
| 3 | `ERR_FAILED` on the entry script, with the bytes sitting in the cache | `cache.match(req)` honours `Vary`, and module scripts are requested with `crossorigin` |
| 4 | Favicon still failed | `public/` assets never appear in the bundle |

Verified by reloading under `setOffline(true)`: the app renders, all five
launcher tiles are present, the map is sized to the viewport, zero console
errors.

**The Mute button muted nothing.** An exhaustive search of `src/` and the Android
assets for `AudioContext`, `new Audio`, `speechSynthesis`, `vibrate` and any
bundled audio returned zero functional hits. The control toggled a boolean whose
only consumers were its own icon and its own label.

That is the most damaging shape a defect can take here: a driver taps Mute, hears
nothing change, and concludes voice prompts are off — a wrong conclusion that
*looks* like the safe one. `src/nav/voice.ts` now drives real spoken guidance
through the Web Speech API, announcing a step once per *meaning* change rather
than on every position tick, and interrupting itself for a new maneuver so an
instruction is never queued behind a stale one. Where the WebView has no speech
engine the control stays visible but disabled with the reason in its accessible
name — a missing control reads as a missing feature, a disabled one explains
itself.

**The parser invented 74,756 places.** `+a.lat` is `NaN` for a missing attribute,
and the node was stored regardless. A malformed extract carrying `lat="-200"`
produced a gazetteer full of invented addresses — "Neg 1200", "Neg 12300" —
presented in search results as `address / Offline`. Coordinates are now bounded in
both readers. The bounding box also no longer reports its uninitialised sentinel
as `180.000, 90.000, -180.000, -90.000` when nothing was parsed.

**No map attribution was displayed at all.** `attributionControl: false` at
construction plus `.maplibregl-ctrl-attrib { display: none }` meant the app showed
no credit anywhere, in either map mode, while every road, label and POI it draws
is OpenStreetMap data. That is a breach of the ODbL, not a cosmetic bug. The
credit is now declared on the map sources and rendered by the library's own
control.

### 10.2 The audit found a regression this project introduced

The bundle split (§10.4) put MapLibre's stylesheet in a separate lazily-loaded
chunk, so it arrived *after* the entry CSS. `.maplibregl-map { position: relative }`
and `.map { position: absolute; inset: 0 }` tie on specificity, so which won came
down to stylesheet order — and the map's always won. **The map rendered nothing
at all**: the container collapsed to 0px and the canvas fell back to 412×300.

It passed the e2e suite, because that suite asserts horizontal overflow and text
visibility, not that a map drew anything. It was caught by an audit that
screenshotted and counted pixels. The fix sizes a wrapper the library has no
opinion about, rather than raising specificity — which would work today and break
silently the next time MapLibre adds a class.

Worth recording as a process point: **the existing gates could not see it.** A new
check now asserts the map container and canvas fill the viewport and that tiles
were actually fetched.

### 10.3 What is now enforced rather than written down

| Gate | Command | Enforces |
|---|---|---|
| Lint | `npm run lint` | Type-aware rules; ratcheted at 27 warnings, so growth must be deliberate |
| Bundle budget | `npm run bundle` | Entry 130 kB, initial 150 kB, largest chunk 300 kB, total JS 460 kB (gzip) |
| Attribution | `test/attribution.spec.ts` | The ODbL credit is present, well-formed, and not re-suppressed |
| Import safety | `test/import.spec.ts` | A bad file is refused and never replaces a working map |
| Settings | `test/settings.spec.ts` | Every setting round-trips; a malformed endpoint is not "Ready" |
| XML safety | `test/xmlentities.spec.ts` | Entity expansion is structurally impossible; hostile documents terminate |
| Crash safety | `test/errorboundary.spec.ts` | A render throw shows a recovery card rather than a blank screen |
| Document | `npm run status` | Every line count, cross-reference, current total, browser-gate figure and `npm run` in this file, checked against the files it describes |

The bundle budget and the lint ratchet are both *ratchets*: raising a number is a
deliberate edit to a file, not drift. That is the same reasoning as the screen
suite in §9 — a green result nobody re-derives is not a green result.

### 10.4 Sizes

| | Before | After |
|---|---|---|
| Entry JS (gzip) | 398.8 kB | **105.7 kB** (−74%) |
| Entry CSS (gzip) | 13.1 kB, render-blocking | **4.4 kB**, deferred with the map |
| Largest chunk | — | 281.6 kB (MapLibre), loaded on first paint |
| Unit tests | 599 | **702** |

MapLibre and the region manager are `React.lazy`. Neither is needed to render the
first frame, and the entry chunk is parsed on a phone's main thread before
anything is interactive.

> These are the numbers as of §10. Two further passes added work and, in the
> engine audit, took the total to **828 across 38 files** (the figures as of that
> revision), and the boundary pass to
> **1026 across 54** — see §11, §12 and §13. The figures above are left as written
> because §10.4 is a record of what *that* pass changed, and editing them would
> make it a record of something else. §2 carries the current figures, measured.

### 10.5 Everything the audits changed, and everything they left

The audits produced 8 written reports (two of ten agents timed out; both were
relaunched) covering ~250 browser scenarios. Below is the complete accounting, so
that §7 can be read as a summary rather than the whole record.

#### Fixed — the app claimed something it did not do

| # | Defect | Evidence it is gone |
|---|---|---|
| 1 | Offline did not survive a reload; the browser served its own disconnected page | Reload under `setOffline(true)`: app renders, 5 tiles, map sized, 0 console errors |
| 2 | Mute muted nothing — no audio subsystem existed anywhere | `src/nav/voice.ts`; control is disabled-with-a-reason where no engine exists |
| 3 | No map attribution displayed anywhere — an ODbL breach | Rendered and asserted by `test/attribution.spec.ts` |
| 4 | The parser invented 74,756 addresses from `lat="-200"` | Coordinates bounded in both readers |
| 5 | The bounding box reported its uninitialised sentinel as data | Degenerate-but-true box when nothing parsed |
| 6 | `m` (mute) opened search; Escape ended an active trip | Verified in-browser: mute toggles, navigation survives Escape |
| 7 | An "Unavailable" engine was fully selectable | `disabled`, with the reason in the row |
| 8 | Nothing persisted — 0 of 5 settings survived a reload | Units verified surviving a reload in-browser |
| 9 | The online geocoder's host did not resolve at all | `.org` verified answering 200; `.de` confirmed NXDOMAIN |
| 10 | `geocode.ts` had no timeout — "Searching…" forever | Verified against a host that never answers |
| 11 | `6978332 m off the route` — unformatted, always metric | Qualitative wording; rejoin distance formatted in the user's units |
| 12 | The ETA bar pushed Exit off-screen (x=506 in 412px) | No overflow at any of the three viewports |
| 13 | The control column sat 137.7px left of its own `right` offset, on the banner | Absolutely-positioned the widest child; measured clear |
| 14 | The off-route notice painted over the maneuver instruction | One top-down flow: bar, notice, card, controls |

#### Fixed — a regression this project introduced

Splitting the bundle put MapLibre's stylesheet in a lazy chunk, so it loaded
after the entry CSS; `.maplibregl-map { position: relative }` tied on
specificity and won on order. **The map rendered nothing.** 39 e2e and 150 screen
checks passed throughout. Fixed by sizing a wrapper the library has no opinion
about; the e2e suite now asserts the map draws, and was verified to fail when the
map is deliberately collapsed.

#### Fixed — correctness and safety

- A corrupt, empty, truncated, non-OSM or road-free `.osm` silently replaced a
  working map. Now refused, with the map untouched.
- The format sniff let the extension overrule the bytes, so a PBF named `.osm`
  imported as an empty region.
- `OsmEngine`'s constructor sat outside the try block, so its failure escaped
  `importRegionFile` and the catch then double-faulted, replacing a real diagnosis
  with "Cannot read properties of undefined".
- The availability probe never cancelled its one-byte ranged GET — a 16× over-fetch.
- Quota failures silently lost an imported region on the next launch.
- `MapView`'s `cancelled` flag was dead code, racing two style boots.
- The long-press timer outlived the component.
- Numeric XML character references used `fromCharCode` (UTF-16 code units), so
  `&#128512;` rendered as a private-use glyph instead of an emoji.
- A NUL byte had got into `engine.ts`, making the file binary to every text tool.

#### Fixed — accessibility

No focus ring existed anywhere in the app (UA default, 1.06:1 measured); the
import picker was unreachable by keyboard; `user-scalable=no` failed WCAG 1.4.4;
`prefers-reduced-motion` was unhandled; there were no landmarks or headings; the
arrival event was never announced; error text was 16px with no dismiss and no
role; the steps screen told a user who had imported a map to import a map.

#### Still open — not fixed, listed so it is not lost

1. **Inferred turn-by-turn is unreliable, and now says so.** Against Valhalla on
   one 4 km stretch it missed three of seven real maneuvers, invented one,
   reversed one, and the step *count* varied with polyline tessellation density
   rather than with the road. The steps screen labels inferred guidance as
   inferred; the inference itself is unchanged. Needs real maneuver data — §7 gap 6.
2. ~~**A tile-host failure substitutes the style silently**~~ — **closed** in §13.11.
   The map now reports the style it adopted and the layers panel names the difference
   between what was asked for and what is drawn.
3. **Chrome covers ~98% of the viewport** at phone portrait (§7 gap 10).
4. **Nothing has run on physical hardware** (§7 gap 1). No further work here
   closes it.

**Closed since this section was written.** The two entries this list used to carry at
the top — the ETA reading `0 m` while route remained, and cross-region routing being
wrong — are both fixed, in §3.17 and §3.18, and the tile-host silence in §13.11. They
were left in place in the list above only long enough to be renumbered against the new
§7; the substance is in §7's closed tables and in §13.

#### Two things a second opinion would help with

- The 20 s routing and 12 s geocoding timeouts are reasoned, not measured against
  real latency tails.
- The narrow-screen navigation layout uses `:has()`. It is supported in current
  Chromium and Safari; on an older Android WebView the layout falls back to
  overlapping elements rather than breaking.

---

### 10.6 Commands added

```bash
npm run lint      # type-aware ESLint, ratcheted at 27 warnings
npm run bundle    # gzip size budget on the built output; fails on regression
npm run check     # typecheck + lint + unit tests
```

---

## 11. The third pass: what a driver actually gets

§10 audited the *code*. This one drove the built app in Chromium at three
viewports, read it, and compared it against Google's published automotive
specifications. It found that the things this app is *for* were the things a
keyboard or screen-reader user could not reach.

### 11.1 One root cause behind most of it

There was exactly one `focus()` call in the whole app, and it targeted the search
field. Every other transition swapped React state, which unmounts the control
that was just activated, so focus fell to `<body>` and the next Tab restarted
from the top of the document — on the Regions screen, roughly sixty catalogue
rows. Because a bare letter also opened search, pressing `s` after tapping
Settings both lost your place and navigated away.

That is not a keyboard-user problem alone. On a head unit driven by a rotary
controller or a switch, losing focus is losing the app.

Screens now announce themselves, take focus, and set `document.title` — which was
the static string "Canopy Nav" for the life of the process, so nine screens were
nine identical entries in a task switcher. Search and the route preview had no
heading at all, so heading navigation skipped them.

**The rule is "the heading is the fallback", not "the heading wins".** The first
version focused it unconditionally, which is right for Settings, Engines, Regions
and the turn list and wrong for Search — arriving there put the caret on a
visually hidden heading, and typing did nothing. A screen that claims focus
during its own commit keeps it.

### 11.2 Every reason a control was unusable, was unreachable

`disabled` removes a control from the tab order. Every sentence in the app
written to explain *why* something cannot be used — "Unavailable — no offline map
loaded", "This download URL could not be reached", "Voice guidance unavailable on
this device" — lived inside a `disabled` button. The Engines screen read as
"here are some engines, pick one", with the chosen one impossible to explore.

All of them are `aria-disabled` now, with the activation refused. The e2e check
asserted the old behaviour, so it was rewritten to assert the property that was
actually wanted: the row stays focusable *and* carries its reason.

### 11.3 The navigation announcements were never heard

`NavOverlay` mounts only while navigating, so its live region was created *with*
"In 240 m, turn right" already inside it. NVDA, JAWS and TalkBack all commonly
discard content inserted into a live region in the same commit that creates the
region — so the first instruction of every trip, the one needed to leave the
parking lot, was never announced. It only worked from the second maneuver.

It was also unthrottled: the region carried an **unbucketed** distance inside
`aria-atomic="true"`, while a comment three lines above claimed the distance was
deliberately excluded for exactly that reason. A driver using assistive
technology got "In 340 metres, turn right. In 330 metres, turn right." queued
without end, and because the queue never drained, the next maneuver arrived late
or not at all.

The distance stays — a turn instruction without one is not an instruction — and
is bucketed to the same 50 m step the speech path already used.

Progress updates had the mirror-image problem: the parser emits per segment and
the downloader per stream chunk, so the live text was "1%. 2%. 2%…" for the
minutes an import takes. The number is now the `progressbar`'s value; the region
carries only the stage. The two Regions cards had no role at all.

### 11.4 Measured against the published numbers

The design system claims a 4.5:1 floor and a 24dp minimum type size. Measured:

| Element | Was | Against |
|---|---|---|
| Focus ring, on the map | **1.97:1** | SC 1.4.11 wants 3:1 |
| "Not set" on an unset launcher tile | **2.87:1** | 4.5:1 |
| "Not set" on a solid tile | 4.49:1 | 4.5:1 — by one hundredth |
| Error card, over the transparent launcher panel | **3.39:1** | 4.5:1 |
| Offline chip, 18px over a blurred map | 4.34:1 | 4.5:1 (18px is not "large") |
| The hint's type size | 17px, 15px | 24dp minimum, 18px smallest step |

Three of those were not contrast problems but **dependency** problems: the tile,
the error card and the chip were translucent, so their ratios moved with whatever
was behind them — a road, or nothing. All three are opaque now, which makes the
ratio a property of the design system rather than of the screen.

The focus ring is a different shape of problem: **no single colour passes on
near-black and near-white**. So it is now a three-layer sandwich — dark, light,
dark — where each band is judged against whichever surface it is adjacent to. A
single ring would have worked today and failed silently the next time a control
moved.

The attribution was 11px — half the design system's smallest step — at a
~13×16px tap target, and the pinned progress card painted over it for the whole
duration of every download. The ODbL requires it displayed.

### 11.5 Two things this pass broke, and how they were caught

Recorded because both are the same shape as §3.19 and §4.6.

**Hiding the app bar's summary line below 600px took the map state with it.** The
line said "12,481 routable ways · 2 regions"; it was also the launcher's only
statement of whether a map existed, so at phone width a loaded province and an
empty app looked identical. Worse than the truncated label it replaced.

`test/screens.mjs` caught it — by asserting `/\d+ routable ways/` against the
launcher's text. That check had been passing for the wrong reason: the feature it
guarded is fine, dropping a fixture onto a fresh launcher yields "19 routable
ways · 1 region". It went red the moment the string moved off screen, which is
the argument for having it.

**The same suite also had a 6-second sleep** where the parse runs in a Worker, so
it failed on the first viewport of a run and passed on the second. It polls now. A
fixed wait is a coin toss dressed as a test, and a flaky red gets ignored.

### 11.6 The harness had to be fixed before it could report anything

`tools/focus.mjs`'s first Tab check dispatched a synthetic `KeyboardEvent` from
the page. That does not move focus — the browser's own key handling implements
Tab — so the check reported success without having moved anything. A green result
from a test that could not have failed. This is the sixth instance of that shape
in this project and the fastest so far to catch, because the test was written
knowing about the previous five.

### 11.7 What the new gates are

```bash
npm run focus   # 15 keyboard and focus checks in a real browser
npm run shots   # every screen, 3 viewports, computed styles recorded
npm run reflow  # chrome overlap at 100% / 175% / 200% text  (a diagnostic, not a gate)
```

`shots.mjs` writes the *computed* style of named elements beside the image, so a
defect CSS error recovery silently discarded — which is how the maneuver arrow
lost its background for every non-major turn — appears as a recorded value rather
than as an opinion about a picture. It also flags any text element whose content
is wider than its box, which is the commonest polish defect and the least visible
in a screenshot.

`test/audit-regressions.spec.ts` holds 25 source-level guards for the defects
above, each verified to fail when its defect is reintroduced (the mute shortcut,
the orphaned CSS declarations and the padding-shorthand rule were all put back
deliberately to confirm the gates bit). It strips comments
and string literals before matching, because several of these files quote the old
code in the note explaining the fix — a test that fails on a correct file trains
people to delete the explanation.

### 11.8 Closed from this pass

- **The map had no accessible name and was the first tab stop on every screen**,
  before the app bar that is visually at the top. It is a `role="img"` now, with a
  name composed from live state — the route, the basemap's actual source, and the
  traffic state. Those are the three facts a sighted driver gets for free and no
  one else gets at all.
- **The turn list had no list semantics**, so a screen reader could not report
  "item 3 of 24" or jump to the fourth — which is the entire way a turn list is
  navigated. It is an `<ol>` now.

### 11.9 Still open from this pass

1. **The navigation screen cannot reflow, and the platform's font setting does
   not reach this app at all.** One defect, two causes.

   *The setting.* On Android the system font size reaches a WebView by scaling
   the **root** font size, and absolute `px` lengths are unaffected by it. Every
   token here emits an absolute `px`, so the setting a driver uses because the
   display is not big enough at a glance — the exact audience AAOS's 24dp
   minimum type size exists for — **does nothing**. Converting the type scale to
   `rem` is the real fix: large, mechanical, and safe to do one token at a time.

   *The layout.* `overflow: hidden` on `html`/`body`, `position: fixed` on
   `.app`, and every part of the navigation screen `position: absolute` against
   `inset: 0`. Nothing scrolls, so a banner that grows has nowhere to go.

   Measured by `tools/reflow.mjs` at 200% on an 892x412 landscape phone:

   | | |
   |---|---|
   | Banner stack vs bottom bar | **560 x 20px intersection** |
   | Off-route notice vs bottom bar | **560 x 20px intersection** |
   | Chrome labels clipped | all 7 — "14 min", "5.2 km", "310 m", "Turn left.", "Steps", "Exit", "Overview" |
   | Control column | leaves the viewport |

   The instruction is unreadable and unreachable. This is the largest single
   piece of work left in the app.

   **Partly shipped; the rest deliberately not.** `src/textscale.ts` measures the
   resolved root font size and sets `<html data-textsize="large">` above one
   documented threshold. That part is correct, reacts to a change made while the
   app is open, and is worth having on its own — the app no longer ignores a
   setting without saying so.

   The layout that responds to it is **not** shipped. The first attempt bounded
   the banner stack (`bottom` plus `overflow-y: auto`), which worked and is
   measured working. Its control-column rule did not: the base rule's
   `flex-wrap` and `max-height` won somewhere, the column stayed 168px wide and
   grew *upward* out of the viewport, and every position the probe reported was
   worse than before — `y=-296` in a 412px viewport, 604px tall. So that half was
   reverted, and the measurements were left in `styles.css` in place of a rule
   that degrades the layout.

   A change measured to make things worse is worse than no change, and shipping
   it because a deadline was close is the exact failure §3.19 records.

   The banner stack's lower bound **does** ship. `tools/reflow.mjs` reports
   `{"overflowY":"auto","bottom":"96px"}` and the banner stack no longer
   intersects the bottom bar — the one collision that was measured, fixed and
   re-measured. The control-column override is still absent, because it made that
   column worse: as a wrapping row inside its own 168px width it grew *upward* out
   of the viewport, `y=-296` in a 412px viewport.

   `tools/reflow.mjs` is **not** in `npm run check`: it fails, and a gate that
   always fails is a gate people learn to ignore. It is a diagnostic, and
   `styles.css` records what it reports.

   **Both of those are now fixed — see §14**, and this section is left as it was
   written because its reasoning is what §14 had to correct: the probe was right
   that something was wrong and wrong about what. The clipped chrome labels were
   line boxes shorter than their own glyphs (§14.1), not labels too small for their
   own box, so the `rem` conversion this section nominated would not have fixed
   them. The control column's overlap was a `max-height: none` that undid the base
   rule's bound (§14.2).

2. ~~Confirming a region removal loses focus~~ — **closed.** The Remove button
   stays mounted and hidden, focus moves to Confirm, cancelling returns focus to
   it. It was also claiming `role="alertdialog"`, which implies modality and an
   assertive live region, and is neither true of an inline pair of buttons.
3. ~~Search results have no list semantics~~ — **closed.** A `<ul>` wrapping only
   the rows, so the count is reported without counting the status cards above it.

None of the remaining items blocks ordinary use at the design system's own type
sizes.

---

## 12. The engine audit

§11 audited the interface. This one went back to the engine and its supporting
modules — the graph, the worker, the queue, the persistence layer — and found
nine live defects. Three of them are serious enough to lead with, and all three
share a property that is worth naming: **each was invisible to every existing
gate, and each was invisible to the driver too.**

---

### 12.1 A priority queue that was not a heap

`MinHeap` in `osm/engine.worker.ts` stored its priorities in a `Float64Array`
indexed by **node id** — one slot per node, shared by every entry for that node:

```ts
private p: Float64Array;
constructor(n: number) { this.p = new Float64Array(n); }
push(node: number, pri: number) {
  this.p[node] = pri;      // <-- overwrites the previous entry's priority
  this.a.push(node);
  ...
}
```

A\* pushes a node once per relaxation, so the sequence the search actually
performs is:

```
push(X, 100)   // p[X] = 100,  heap holds (X, 100)
push(X,  50)   // p[X] =  50,  heap holds (X, 100) and (X, 50)
```

Every comparison in `sift-up` and `sift-down` reads through `p[node]`, so the
stale entry at 100 now **compares as 50**. The array is no longer ordered by the
priority it will report, `pop()` does not return the minimum, and A\*'s expansion
order is invalid.

That voids the optimality guarantee the heuristic directly above it is explicitly
built to preserve. The engine is the app's **default** — it is what
`DEFAULT_SELECTION` selects and what an offline driver always gets — so the
practical effect was the difference between a shortest path and a merely plausible
one, on any network where a node is re-relaxed. That is to say on essentially all
of them.

**Nothing detected it.** A suboptimal route is still a route: still drawn, still
plausible, still arriving at the destination. It is wrong by a few percent and
looks correct. Neither the unit suite nor the 40 browser checks route far enough
for the difference to show, and no test asserted optimality — the suite asserted
that a route *exists*.

Fixed by giving each entry its own priority in two parallel arrays, so each
travels with its node through every swap.

`test/minheap.spec.ts` asserts the invariant directly, and — this is the part that
matters — **keeps the broken implementation in the file and asserts that it does
not pass.** A guard nobody has seen fail is not a guard. That is the ninth time
this project has written that sentence down, and the ninth time it has been the
reason a defect was caught rather than shipped.

One honest note on writing it: the first version of the third test asserted that
the popped *node sequence* matched a stable sort. It failed, and the failure was
not a heap bug — a heap makes no promise about the order of equal-priority
entries. The test now asserts what is actually specified: priorities come out
**non-decreasing**, and every entry pushed is popped exactly once. Asking for more
than the structure promises produces a red that looks like a defect and is not.

---

### 12.2 A parser that could hang forever

`OsmEngine`'s worker error handler logged and returned:

```ts
this.worker.onerror = (e) => { console.error('OSM worker error', e); };
```

Every failure that arrives as a **worker-level** error rather than as a
`postMessage` therefore left `buildPromise` pending forever:

| Failure | How it arrives |
|---|---|
| A throw during the worker's module initialisation | `onerror` |
| An OOM on a 900 MB parse | `onerror` — in a Worker this is not a catchable exception |
| The worker's own chunk failing to load | `onerror` |

`importRegionFile` awaits `engine.build(file)`. So nothing returned, `onError`
never fired, `onProgress(null)` never fired, the previously-loaded region was
never restored (`store.ts` restores it in a branch that was unreachable), and the
user's only recourse was force-quitting. The progress card sat at whatever stage
it had reached — usually "Reading extract, 0%" — with no error and no retry.

**An error that is caught and merely logged is not caught.**

Two holes are now closed by one helper, so all three paths leave the same state:

- `onerror` and `onmessageerror` both settle the build. The second matters for a
  message that cannot be *deserialised*, which is also not a catchable throw in
  the worker.
- `dispose()` settles any in-flight build. `terminate()` does not fire `onerror`,
  so a build interrupted by *replacing* a region hung the same way — reached by a
  different route, with the same symptom.
- `onProgress?.(null)` is sent on the way out, so the progress card comes down. The
  handler's type had to admit `null` for that: it already did at the call site
  (`store.ts` passes `BuildProgress | null`), and `null` is how the import screen
  learns to take its card away.

---

### 12.3 `?? active` made the banner say "In 0 m, turn left"

Still live after §11's arrival fix, as a consequence of the same line.

Valhalla's last maneuver before the destination is **not** the destination
maneuver — it is the final turn onto the destination road. So on any route with a
real final leg (a river crossing, a motorway, "continue for 30 km"):

```
legs.slice(activeIdx + 1).find((m) => m.type !== 4)  →  undefined
next = undefined ?? active                            →  a maneuver behind the driver
```

and then:

```ts
const leg = geometry.slice(here, Math.max(here, next.begin_shape_index) + 1);
```

`next.begin_shape_index` is behind `here`, so `Math.max` collapses to `here`, so
`leg` is a single point, so `distToNext` is **0**. Three consequences at once:

- `imminent` (`distToTurn < 40`) was true, so the instruction rendered
  **dimmed-as-imminent** for an entire motorway;
- the voice effect said **"In 0 m, turn left onto *a road already turned onto*`**,
  assertively, repeatedly, for the whole final leg;
- and the live region announced the same sentence every bucket boundary.

It now falls back to the **last leg**, which measures to the destination vertex.
That is the honest answer when there are no more turns: what remains is the rest
of the drive. The index is also clamped to the geometry's end, so a maneuver index
from a malformed response cannot measure from a point that does not exist.

---

### 12.4 A stored record missing `counts` crashed the app on launch

`counts` was the one field in a stored region record that was **not** validated,
and it is also the one field read without a guard — `counts.routable
.toLocaleString()` on the launcher, `counts.ways` on Settings, both during render.

Every sibling in `deserializeDataset` is defensively defaulted. `bbox` gets a
degenerate-but-true box. `gaz`, `roads`, `water` and `green` each get `[]`.

So a record written by an older build, or truncated by a crash mid-`put`,
deserialised with `counts === undefined`, and `HomeScreen` threw
`TypeError: Cannot read properties of undefined (reading 'routable')` **during the
first render** — the top-level `ErrorBoundary`, on launch, with the message naming
an internal field and no Settings screen to reach.

The crash card's own reassurance that "your imported maps are still saved" was
**true and useless**.

The tell was in the same file: `toMeta` already defaulted `counts`. The meta
mirror and the dataset disagreed about whether the field was trustworthy, and only
one of them was read by a render path.

`test/persist.spec.ts` now reaches past the module's own API and deletes the field
from the record on disk — because a test that goes through the same writer it is
testing cannot produce malformed input for it. Verified to fail without the fix.

---

### 12.5 Four leaks, each with a consequence

None of these crash anything. Each costs something a driver would notice, or
battery they would notice.

| Leak | Consequence |
|---|---|
| `watchPosition`'s id was discarded, so only `cancelled` stopped the *callback* | The platform location provider stays active and the GNSS receiver stays hot for the life of the WebView. On a head unit that is a measurable battery drain — and `useLocation` takes an `enabled` flag whose entire purpose is to release the GPS on screens that do not need it. A browser StrictMode double-mount opened two watches and cleaned up one. |
| `speak()` latched `lastKey` **before** calling the platform | A WebView exposing `speechSynthesis` with no TTS engine installed — the common Android-without-Google-TTS case — throws on every call while `isVoiceAvailable()` still reports `true`. The mute button read "Mute voice guidance", nothing was ever said, and each instruction was swallowed exactly once and never retried. That is the precise lie `voice.ts` says it exists to prevent. |
| `DEFAULT_ENGINE_IDS` listed `'valhalla'`, `'simplerouting'`, `'custom'` | None of those are real ids — the real ones are `valhalla-fossgis`, `valhalla-simplerouting`, `valhalla-custom`. Any caller relying on the default had every saved hosted engine validated as unknown and **silently rewritten to `'local'`** on restart, with no message. `App` passes the live list, so production was never affected; the default was the trap for the next call site, and its doc comment asserted the ids matched. |
| A place saved with a blank label fell back to `|| slot` | It round-tripped as lowercase `"home"`, because `readPlaces` only substitutes a capitalised name when the stored label is *empty* — and `"home"` is not empty. The launcher tile read "home". |

---

### 12.6 What this pass did not fix

Recorded so they are not lost, with the same reasoning §11.9 uses: these are real,
they were found, and finishing them properly needs more than the time this pass
had.

**Five of the seven were closed by the boundary pass (§13), and one of them was
recorded here with the wrong mechanism** — see the note under each. The list is left
as written because it is a record of what this pass found, and §13.4 records what
turned out to be true.

1. **`doRoute` has no request sequencing.** Two overlapping route requests both
   write `route`, `provenance` and `fitNonce`, so the preview can show
   destination A's line under destination B's label, and the first `finally`
   clears `routing` while the second request is still outstanding. The
   `trafficProbe` sequence-number pattern already exists in the same file for
   exactly this. → **closed** (§13.6).
2. **The reroute request has no cancellation.** Pressing Exit mid-reroute lets the
   abandoned response install a route, and its `finally` writes `finishReroute`
   onto freshly reset state — resurrecting `status: 'failed'` for a trip that no
   longer exists. → **closed** (§13.6).
3. **Two concurrent downloads clobber each other's `AbortController`,** so the
   first becomes uncancellable and the second's progress row is overwritten.
   → **closed** (§13.10).
4. **A `.part` file poisoned by a `not-osm` rejection is never cleaned up,** so
   every retry resumes from bad bytes. And `readBinary` returns `null` on an
   out-of-memory base64 decode, which `resumeFrom` reads as "no partial file" and
   therefore **deletes the user's partial download.** → **both closed** (§13.4).
5. **`decodePolyline` manufactures `[NaN, NaN]`** from a truncated response, which
   becomes `"NaN hr NaN min"` on the ETA bar and `dist: Infinity` in the off-route
   tracker — a permanent reroute loop. → **closed, and the stated mechanism was
   wrong.** A truncated polyline cannot produce a non-finite coordinate: `NaN << s`
   is `0`, so the truncated read contributes a zero delta and appends a *finite*
   point 30.9 km away. The `NaN hr NaN min` readout was real and came from a
   summary with no `time`. Both are fixed (§13.1, §13.2).
6. **The service worker overwrites the precached shell with any 200,** so a
   captive portal's login page becomes the cached `index.html` and the app can
   never boot offline again. It is worse than the `ERR_INTERNET_DISCONNECTED` page
   §10 was written to fix. → **closed**, and it was the most consequential defect
   found across any pass (§13.3).
7. **The stale-position guard refuses to reroute a driver who is moving *away*
   from the destination**, which is exactly what missing an exit looks like. The
   banner says "waiting for a position update" while positions arrive fine.
   → **closed** (§13.5).

---

### 12.7 The reflow, shipped half

The one item from §11.9 that moved, and it moved partly on purpose.

`src/textscale.ts` **ships**: it measures the resolved root font size and sets
`<html data-textsize="large">` above one documented threshold, reacts to a change
made while the app is open, and costs one measurement when nothing moved. That
part is correct and worth having on its own — the app no longer silently ignores a
setting whose entire audience is the one AAOS's 24dp minimum type size exists for.

The layout that responds to it is **half shipped**. The banner stack's lower bound
works, and is measured working twice: `tools/reflow.mjs` reports
`{"overflowY":"auto","bottom":"96px"}` and the banner stack no longer intersects
the bottom bar.

The control-column override is not there, because writing it made that column
*worse*. The base rule's `flex-wrap: wrap` and its `max-height` mean a row
override wraps inside the column's own 168px width and grows **upward** out of the
viewport — `y=-296` in a 412px viewport, 604px tall, where before the change it was
merely cramped. Reverted.

`tools/reflow.mjs` is deliberately **not** in `npm run check`. It used to fail, and a
gate that always fails is a gate people learn to ignore — the same conclusion §10.3
reached about a green result nobody re-derives. It is a diagnostic; `styles.css` carries
the measurements and this section carries the reasoning.

**Update (§14): it no longer fails.** All 12 checks pass at all three text sizes. That
does not make it a gate, because it needs a browser and takes minutes, and because a
diagnostic that reports *nothing* tends to stop being read — so it stays a diagnostic and
is now listed in §2 as a passing row.

Two things it still reported as failing, honestly: the control column, and clipped
chrome labels. **Both are fixed in §14**, and so is this section's diagnosis. The labels
were clipped because their *leading* was a length that did not scale with their font
(§14.1) — which is why the `rem` conversion nominated here would not have fixed them, and
why §13.15 had to correct the count to five before anything could be.

---

### 12.8 On the probes themselves

Both new browser harnesses reported success before they were capable of failing,
and both were caught by asking a more basic question than "did it report green?".

- `focus.mjs` checked that Tab moved focus by dispatching a synthetic
  `KeyboardEvent` from the page. The browser's own key handling implements Tab, so
  nothing moved and the check passed. It went through `page.keyboard.press`.
- `reflow.mjs` scaled `:root { font-size }` and reported "chrome does not overlap
  itself" three times over — because every token emits an absolute `px`, so the
  stimulus never arrived. It now scales what the tokens actually render, sets the
  attribute the way the app sets it, and verifies the attribute stuck before
  measuring.

Forcing `data-textsize` directly does not work at all: `textscale.ts` re-measures
every two seconds and **correctly** resets it, because the root size really was
16px. A harness that fights the app's own detection measures a state the app could
never be in.

One flaky check, recorded rather than hidden: `test/e2e.mjs`'s catalogue wait has
failed once while the whole suite was green around it. 120s is above the probe's
worst case (~20 entries, 4 at a time, 10s deadline each ≈ 50s), so the cause is
probably the probe competing with the map's tile requests on a cold browser.
Raising the number until it stopped happening would have hidden the cause.

---

## 13. The boundary pass

§12 audited the engine. This one went after every place where this app meets
something it does not control — a network, a disk, a service worker, two
overlapping requests, a GPS fix — and asked one question of each: *what does this
do when the thing on the other side goes wrong?*

Eleven defects. Three are corrections to claims this
document has been carrying, which is the more interesting half: two were wrong
about a mechanism, and one was wrong about code that does not exist in the state
it was described.

---

### 13.1 A truncated polyline decoded to a plausible, wrong destination

`§7 gap 16` in the *previous* numbering (there is no gap 16 now — the list is
renumbered and this one is closed) and `§12.6` item 5 both recorded: *"A truncated response makes the ETA
read `NaN hr NaN min` … `decodePolyline` manufactures `[NaN, NaN]`"*.

**The symptom is real. The mechanism is not.** Measured, before changing anything:

```
'?'.charCodeAt(5)   -> NaN     // past the end of the string
NaN << 3            -> 0       // the shift coerces to 0
NaN >= 0x1f         -> false   // so the varint loop stops as if it had finished
```

The truncated read therefore contributed a delta of **zero** and appended a
*finite* point. An exhaustive sweep of all 224³ three-character strings over the
plausible byte range produced **zero** non-finite coordinates. A four-point leg
trimmed by one character decoded to four points whose last was **30.9 km** from
the true endpoint.

That is the worse of the two failures. `NaN` is visibly wrong; a plausible wrong
endpoint draws, reports a distance, and arrives somewhere.

`decodePolyline` now refuses: a truncated stream, a character outside the
encoding's ASCII 63–126 range, an implausibly long value, and a shape that
decodes off the planet (latitude beyond ±90, longitude beyond ±180). Those last
bounds are facts about the world rather than about the format, and the test
asserts that ±180/±90 and an antimeridian crossing still decode — a check that
only accepted "somewhere sensible" would one day stop precaching the app's shell
with no visible failure.

### 13.2 `NaN hr NaN min` was a missing number, not a corrupt one

The symptom the polyline was blamed for has its own cause, and it is a different
kind of failure: **absent** rather than malformed. A response whose
`trip.summary` carried a `length` and no `time` left `summary.time` as
`undefined`, and because every comparison against `undefined` is false the value
fell through the formatter's branches and printed itself. Measured:

```
formatDuration(undefined)  -> "NaN hr NaN min"
formatDuration(NaN)        -> "NaN hr NaN min"
formatDistance(NaN)        -> "NaN km"
```

Fixed at three levels, because three levels were each independently sufficient to
produce it:

- `formatDuration` / `formatDistance` refuse a non-finite value and print `—`.
  A formatter is the last place that can say "this is not a duration".
- `parseTrip` validates the summary it is given: a response with no summary is
  refused with a sentence naming the cause, because `rawSummary.length` was a
  `TypeError` reaching the driver as an internal message.
- A summary with a length and no `time` keeps the time **missing**, as `NaN`,
  deliberately rather than `0`. `0` would be a claim — `<1 min` for a two-hour
  drive. `NaN` is inert in every consumer, because `NaN || fallback` is the
  fallback, and the geometry is good so the trip is still worth showing.

`maneuvers` is now defaulted to `[]` rather than passed through as `undefined`,
for the same reason: the guidance model walks it as an array.

### 13.3 A captive portal could take the app's offline shell away, permanently

`§12.6` item 6, and the most consequential defect in this pass.

The service worker's fetch handler cached **any** 200 over `./index.html`. A
captive portal answers a navigation with exactly that: HTTP 200, `text/html`, a
login form. Once that page was in the cache it *was* the app's shell — every
later offline load served it, and there was nothing the user could do about it
from inside the app, because the app never opened. Strictly worse than the
`ERR_INTERNET_DISCONNECTED` page the worker exists to prevent, and the same class
of defect: a network state nobody handled.

`src/shellcheck.ts` decides, from a redirect check, the status, the content type
and two independent marks in the body (`<div id="root">` **and** a module
script — either alone is what any modern page has). It fails closed, because the
cost of a false positive is permanent and the cost of a false negative is one
online load that is not precached.

**Verified in a real browser, before and after**, because this one cannot be seen
by reading code: `npm run swshell` stands up a server that answers every
navigation with a portal page, loads the app so the real shell is precached, puts
the portal in front of it, then turns the network off.

```
before:  OFFLINE launcher tiles: 0    looks like a portal login page: true
after:   OFFLINE launcher tiles: 5    looks like a portal login page: false
```

The response is still **returned** to the page. Refusing to cache it is not the
same as refusing to serve it, and someone in a hotel lobby should get whatever
the network gave them.

One harness detail worth keeping: `if (isAppShell(fresh))` without the `await`
compiles, runs, and caches every 200 — a `Promise` is always truthy. That is the
original defect restored by deleting one character, so the test asserts against
that spelling as well as the right one.

### 13.4 Two more claims this document was carrying, and a third

**A poisoned part file was permanent — and the poison was detectable at the time.**
`§12.6` item 4 was half right. A `not-osm` rejection can land *after* bytes are
already on disk: the sniff only decides once 16 bytes have arrived, so the first
chunk of a short response is written to the part file before the second one
settles the verdict. The download then fails correctly and leaves a part file
holding the head of somebody's HTML error page, beside a `.part.json` that made
it look resumable.

Every later attempt resumed from those bytes and failed the same way, forever,
reporting a format problem that named the wrong cause. Two fixes, and the second
is the one that would have been missed by reading the code: the rejected payload
now deletes its own prefix, **and** `resumeFrom` sniffs the persisted prefix
rather than trusting it. The prefix *is* the head of the whole file by
construction — `PartSink` only ever appends to a path the previous attempt
cleared — so the sniff that could not be done at the time is available on the
next attempt.

**An out-of-memory read was destroying the user's download.** `readBinary` returns
`null` on any failure, and `resumeFrom` read that as "no partial file" and
deleted it. On a 620 MB province an OOM in the base64 decode therefore threw away
a transfer that had already transferred most of it, silently. The file exists —
its size was taken by `fileSize` moments earlier — so a `null` is a statement
about *this attempt*, not about the bytes on disk. Three ways this can now refuse
and they are deliberately different: no validator (the bytes cannot be resumed
safely, so they go), not OSM (worthless, so they go), unreadable (nothing is
deleted; the next attempt starts from zero and the stale part is cleared when it
does).

**`RoadGraph.regionOf` was never persisted for a single-region entry.** Gap 12 in
the previous revision said it was "persisted for every region … the bytes are
still wasted on single-region entries". There are no bytes: `regionOf` is only
ever set by `mergeRegions`, the parser never assigns it, and a merged graph lives
in the library's cache and is never written to storage. Checked by grepping every
assignment rather than by reading the serialiser. The gap is restated in §7 as the
cosmetic thing it actually is.

### 13.5 The stale-position guard was refusing the driver it existed to help

`§7 gap 18` in the previous numbering — renumbered since, and closed by this
section — recorded: *"The stale-position guard refuses to reroute a driver moving away
from the destination — which is what missing an exit looks like. The banner says
'waiting for a position update' while positions arrive perfectly well."*

Two mistakes, both made by the same reasoning and both only findable by measuring.

**The first test was the wrong axis.** `madeProgress` required the candidate start
to be measurably *nearer the destination* than the last one. That closed the
frozen-fix loop and it silenced the case the banner exists to speak to: a driver
who misses an exit is genuinely off-route and their projected start moves *away*
from the destination as they continue, which is precisely the evidence their
position is live. Half of all off-route corrections involve moving away from the
destination, so there is no direction that is right for everyone.

**The replacement test was also the wrong axis, once.** The obvious correction —
"has the position moved at all" — was first applied to the *projected* start,
reasoning that the projection is what a reroute would be built from. A projection
is clamped to the line's extent. Measured against the fixture's 3-vertex route, a
driver receding perpendicular from it projects to the **same western endpoint**,
from 111 m of deviation to 594 m:

```
step  fixDev  origin(=projection)  movedSince
   0    111m  [-114.06500,51.04500]        -
   1    167m  [-114.06600,51.04500]   69.9m
   ...
   5    389m  [-114.07000,51.04500]   69.9m
   6    450m  [-114.07000,51.04500]    0.0m   <- 60 m driven, "nothing changed"
   8    594m  [-114.07000,51.04500]    0.0m
```

So the baseline is now the **raw fix** (`RerouteState.lastFix`), which has no
ceiling. A driver stationary in a car park jitters a metre or two and is caught by
the 10 m floor; a driver 600 m from where they were is not.

The new tests cover both directions, and — the part that matters — a fourth test
that drives the *frozen* case across six settle windows and asserts exactly one
request, so it is impossible to satisfy the new tests by deleting the guard.

### 13.6 Two overlapping route requests, and a request that outlived its trip

`§12.6` items 1 and 2, and the clearest instance of a pattern this project has hit
five times: two places independently writing the same state, neither checking
whether its answer still mattered.

`resolveRoute` can be outstanding for twenty seconds. Two searches in quick
succession both wrote `route`, `provenance` and `fitNonce`, so a late answer
installed itself over a newer one — destination A's geometry under destination B's
label — and the first `finally` cleared the spinner while the second request was
still running.

The reroute case is worse. `resetReroute()` runs whenever navigation ends, so
pressing Exit mid-request *did* clear the state, and then the abandoned response
arrived, installed a route on the preview screen, and wrote
`finishReroute(..., ok: false)` over the reset — resurrecting `status: 'failed'`
and its banner for a trip that no longer existed.

`nav/requests.ts` is a `RequestGate`: a token per request, `assertLive(token)`
which **throws** rather than returning a boolean, and a `SupersededError` the
`catch` recognises so an abandoned request reports nothing. Throwing is the point:
a call site that forgets the check produces the original bug a minute later
instead of a compile error.

It is a counter and not an `AbortController`, which is the opposite of what a
reader will expect, and the reason is worth stating: `routeOnGraph` is a
synchronous A\* walk that no abort can interrupt. Correctness comes from
discarding the stale answer, not from stopping the work. `resolveRoute` now also
threads a signal through to `routeOnValhalla`, purely so a twenty-second socket
the driver has abandoned stops occupying the radio.

### 13.7 The gate that was reporting a network fault as a UI defect

Worth recording because it is the tenth time in this project, and the fastest.

`test/e2e.mjs`'s "every catalogue row has a download control" counted rows whose
label was `Download`, `Unavailable` or `Downloading`. A row still reading
`Checking…` was therefore counted as having no control at all — so on a slow link
the suite reported a UI defect it had just timed out on. The same commit passed and
failed across runs with nothing changed but how long Geofabrik took to answer
sixteen HEAD requests. Measured here: **14.6 s** wall clock for sixteen probes
four at a time, with four of them burning their full 10 s deadline, and the
catalogue is CORS-blocked in a browser (Geofabrik sends no
`Access-Control-Allow-Origin` on either the 307 or the 200 — Valhalla sends `*`),
so on this machine every row settles as `Unavailable` in about half a second *or*
takes ten seconds, with nothing in between.

The check is now structural — one `.pill-btn` in each row's `.region-actions`
cluster, which is true or false regardless of the network — and the probe settling
is a separate claim with its own budget. Three consecutive runs green.

### 13.8 The reflow probe was measuring a state no device is ever in

`§12.7` recorded the banner stack's lower bound as "measured working", quoting
`tools/reflow.mjs`. The probe did not measure it in the state that ships.

`reflow.mjs` waited for the **root font size** to exceed the threshold rather than
for the `data-textsize` attribute. The probe itself writes the root size, so that
condition was satisfied the instant it was checked, and the reflow was measured
against `data-textsize="normal"` — which `textscale.ts` correctly resets within its
2 s poll, and which no device with a large font setting is ever in. The
`[data-textsize="large"] .banner-stack` rule was therefore *never in effect* while
the probe reported `overflow-y: visible`.

With the probe waiting for the attribute, the real numbers are: **100%** clean;
**175%** the stack bounded and scrolling, no collision, labels still clipped;
**200%** no collision, the off-route notice scrolled 20 px out of view, the same
labels clipped. *How many* labels is corrected in §13.15 — this measurement counted
the instruction as clipped when it is in fact scrollable.

A second probe defect hid behind the first: pieces were measured with
`getBoundingClientRect`, which reports the *layout* box. For a child of a scrolling
container that extends past the clip, so the off-route notice was reported as
overlapping the bottom bar when it was in fact clipped by `.banner-stack`. The
reported "banner stack x bottom bar (560x20px)" collision was an artefact of the
same rule. Measuring the *visible* rect — intersected with every clipping ancestor
— separates the two claims, and "scrolled out of reach" is now its own check rather
than being folded into the clipping count.

### 13.9 What this pass tried and removed

A column layout for the three pieces of navigation chrome, scoped to
`[data-textsize="large"]`, making the two bars' heights intrinsic so the banner
stack takes what is left. It is the right shape and it is what §12.7 asks for.

Measured: it removed one of the two reported collisions and fixed **none** of the
clipped labels — which live *inside* the two bars, so bounding the stack can never
reach them. Worse, the one collision it removed turned out to be the probe artefact
of §13.8, so its real effect was nil. §13.15 records what the target actually was,
which is smaller than this section assumed.

Reverted, and the measurements recorded in `styles.css` beside the rule that ships.
That is the third time this project has written a layout change down after
measuring it to be no better, and the conclusion is now the same each time: the
remaining work is not "add a rule", it is "stop hard-coding a height and deriving
a layout from it". **§14 is that work**, and it did not need the `rem` conversion this
section nominated — the fix was measuring the bars, and a different premise about the
platform. §14.9.

### 13.10 One handle for every download

`§12.6` item 3, the last of that list still open.

`RegionsScreen` held a single `abortRef` for the whole screen. Two consequences,
both invisible in a single-download run:

- **The first download became uncancellable.** A second Download tap overwrote the
  handle, so the Cancel button and the unmount cleanup both reached only the newest
  transfer. The first kept consuming a metered connection with nothing able to stop
  it.
- **A superseded download could wipe the live one's progress row.** `dl` is one
  value for the screen, and the `finally` cleared it unconditionally — so a slow
  Alberta download finishing after a fast British Columbia one cleared *its*
  progress mid-flight.

It is now a `Map<regionId, AbortController>`. Each download owns its handle; the
`finally` releases the row only if it still owns it (`downloads.current.get(id) ===
ctrl`), so a superseded transfer cannot clear its replacement's row; unmount aborts
*every* handle rather than the last one; and Cancel aborts by the row's own id, so
the control always cancels the thing the driver can see.

A second download of the same region now **replaces** the first rather than racing
it, which is the honest behaviour for a screen with one progress row and one Cancel
button. Two downloads of *different* regions can still run concurrently, and that is
deliberate — downloading two provinces at once is a reasonable thing to want, and
each now has its own row and its own cancellation.

### 13.11 A catalogue row was 1139dp against a nominal 116dp

`§3.19` deferred this with an estimate: *"repeats an unavailable entry's reason as a
multi-line red paragraph that balloons the row to ~365dp at 412dp; row height is nominally
116dp. Fold the reason into one line and expand on demand."*

Measured rather than assumed, with every catalogue probe answered deterministically (a
500) so the number does not depend on the network:

| | recorded | measured |
|---|---|---|
| row height at 412dp | ~365dp | **1139dp** |
| the reason alone | — | **868dp** |
| same row at 1280dp | — | 255dp |

Nearly ten times the row, sixteen times over. The screen was nothing but red paragraphs
and the row a driver needed was in the middle of it. Measuring this against the live
Geofabrik URLs does not work at all, because those probes are CORS-blocked (§7 gap 4), so
whether a reason exists depends on the network — and a layout measurement that depends on
the network is a number that will be stale.

The reason is now a `<button>` carrying the whole sentence, folded to one line with
`aria-expanded`, expandable and collapsible. A button rather than the `title` attribute
the note might have suggested, because §11.2's entire finding is that a `title` is
unreachable on the only kind of device this app has. Result: **1139dp → 299dp**, and the
reason one line.

299 rather than 116 is the row's real content — four text lines (name, size and country,
URL, reason) at this type scale — so that part is layout, not ballooning.

### 13.12 The screen could stay undecided forever, and look like a hang

The e2e gate I added in §13.7 failed roughly one run in four. The obvious reading is
"slow network, raise the budget", which §12.8 explicitly warns against. Instrumenting the
probe instead showed it takes **12.2 s, 18.2 s and 40.0 s** on three consecutive runs of the
same build against the same network — the 40 s being the worst case the app can already
produce: 16 entries, 4 at a time, each burning its full 10 s deadline.

The real defect is one level up. **Every individual probe was bounded; the screen was
not.** And because `setAvailability` is called once, after every worker finishes, the rows
are *atomic*: a probe that took 95 s showed sixteen "Checking…" and zero decided rows. On
screen that is indistinguishable from a probe that has hung, which is exactly what the
suite reported.

So the screen now stops waiting for stragglers after 75 s — derived from the catalogue
size and the per-probe deadline, not chosen — and reports whatever the deadline caught as
unavailable *with a reason*, because "we do not know" must not become "yes, you can
download this", and a row with no verdict is the one state the screen cannot represent.
The gate's budget is set from the app's own bound rather than tuned: 150 s against a
75 s bound, so the suite can only fail this if the app overruns the limit it set for
itself.

Four consecutive e2e runs green afterwards — and then it kept failing, one run in three.
**The budget was never actually in force.** `page.waitForFunction` takes
`(pageFunction, arg, options)`, and the options were being passed as `arg`. Every call
silently fell back to Playwright's default **30 s**, so the "150 s derived from the app's
bound" was a number in the source and nothing more.

What made it diagnosable rather than another shrug at the network was the wall clock:
every failing run returned at **30003 ms**. Not 30 s of network, not 29 s — 30.003 s,
three times running, a number only a default timeout produces. The predicate had timed
out, the `catch` swallowed it, and the check then measured sixteen live "Checking…" rows
and correctly called the screen unsettled.

So the defect was the *opposite* of the usual harness failure — the gate was too
**strict**, reporting a screen that had not yet finished as one that never would. Both
directions are the same mistake: a probe measuring something other than the thing it
names. Three previous instances are §13.8's overlap arithmetic, §13.15's `scrollHeight`,
and §11.9's synthetic Tab. This one is mine, from this pass, in code I had just written.

Verified afterwards on both sides: cutting the budget to 1.5 s makes the check fail with
`0 decided, 16 still checking`, and restoring it passes. A gate that has only ever
passed is not known to work. §13.16 collects all four of these.

Worth recording alongside it: the *gate* was the symptom and the *product* was the
defect. A driver looking at sixteen "Checking…" rows had been told nothing, and no test
in the project asserted that the screen ever reaches a verdict — which is the assertion
that took four revisions and a probe defect to make trustworthy.

### 13.13 A "0-gap" collision that was never a collision — and the defect under it

§3.19's fourth deferred item, and the one §13.8 made me re-measure, because the
figure came from a probe whose overlap arithmetic could not tell a genuine
collision from a clipped child.

Two things were true and the note had them the wrong way round.

**There was no collision.** Measured at 1280×720, 412×915 and 892×412, the gap
between the maneuver card and the off-route notice is **8px** in all three — the
banner stack's own `gap`. And the probe never looked at that pair: `reflow.mjs`'s
`PIECES` contains the banner *stack*, and its `nested` exemption skips
stack-versus-child, so the notice and the card inside it were never compared. A
deferred item carrying a specific pixel figure, which no probe in the project could
have produced.

**The real defect was underneath it.** The two are siblings in one flex column with
the same fill, the same width, an 8px gap, and different corners — 16px on the card,
8px on the notice. Two identical dark surfaces with mismatched radii read as one
panel split in two, which is a version of the "looks accidental" complaint the note
was making, arrived at by a different route. The notice now matches at 16px; the 4px
amber rule on its left edge is what tells them apart, and that is what it is for.

This is the fourth time in this project that a recorded measurement turned out to be
unreproducible, and the second time the cause was a probe that could not see the
thing it was quoted for (§4.6's screen suite visiting four screens; §11.9's focus
check dispatching a synthetic Tab). The general form is worth keeping: **a number
attached to a specific element is a claim about a measurement, and the measurement
has to name the thing it measured.**

### 13.14 An empty turn list that blamed the wrong thing

§3.19's first deferred item, and the last one open.

The empty state said, for every route with no steps:

> `<engine> answered this route but does not supply turn-by-turn guidance.`

That is correct for exactly one of the three situations that produce an empty list.
The other two are about the **route**, not the engine — and the offline engine emits
no maneuvers *ever*, so an empty list offline always means one of them:

- the route is too coarse for the inference to read any bend from (fewer than 17
  vertices, and the sampler needs 8 either side of a candidate), or
- the inference ran and found no turn worth stopping for.

Both were reported as a missing engine capability. The cost is concrete: a driver
whose route simply has nothing in it is told to go and change their routing engine,
and on the sparse route is told to go and change an engine for a route that is too
short to have turns in the first place. §11's own principle — nothing implies data
it does not have — applies to *reasons* as much as to values.

`nav/steps.ts` now decides the copy, as a pure function with all three branches
tested. The sparse case offers both routes out, because both are real: a longer
route gives the inference more to work with, and a Valhalla engine gives real
instructions regardless. The "nothing here" case offers neither, because no setting
would help.

It is a separate module rather than three branches of JSX for the reason §12.7 gives:
a decision that is not testable without React is a decision nobody will test, and
this one had been wrong for the life of the feature.

### 13.15 The "seven clipped labels" were five, and the instruction was never one of them

`§12.7`, `§11.9` and `§3.19` have all carried a figure of **seven clipped chrome
labels** at large text. Re-measured: it is **five**, and the two that dropped off the
list are the two that matter most.

The probe's test was `scrollHeight > clientHeight` on each text element. On an element
inside a *scrolling* ancestor that is not clipping — the text is reachable by
scrolling. Which produced this:

```
before:  "14 min", "5.2 km", "310 m", "Turn left.", "Steps", "Exit", "Overview"
after:   "14 min", "5.2 km", "Steps", "Exit", "Overview"
         (plus 2 scrollable, not clipped: "310 m", "Turn left.")
```

So **the instruction — the only thing that screen exists for — was never clipped.**
It is reachable, and it scrolls. The five that are clipped are chrome: two values in
the ETA bar and three button labels in the bottom bar, all inside bars whose `height`
is a fixed token.

This is §13.8's mistake one level down, and the third probe defect of this family in
this project. There, `getBoundingClientRect` reported a clipped child as a visible
overlap. Here, `scrollHeight` reports a scrollable child as a clipped one. Both made a
measurement look worse than the screen is, and in this case it made **the priority
look wrong**: the document has called this "the largest single piece of work left in
the app" partly on the strength of a figure that included the reachable parts.

What remains is five labels in two fixed-height bars. That is still a real defect at
175% and 200%, and it is still not fixable by bounding the banner stack — it would
take the space the bars need. But it is five chrome labels, not "the instruction is
unreadable and unreachable", and the fix is the `rem` conversion plus intrinsic bar
heights: the two halves of §7 gap 11, which is one defect with two causes.

No further CSS was attempted. A second attempt at the same shape, with the same known
limitation and a now-known-smaller target, is the shape of decision §3.19 warns about.

**Both closed in §14** — and the nominated fix was the wrong one. Intrinsic bar heights
were needed, but intrinsic *leading* was what the five labels needed: their line boxes
were shorter than their own glyphs, which no bar height could fix. §14.9 removed the
`rem` conversion from consideration entirely: it would have addressed neither.

### 13.16 Six probes measured something other than what they named

The clearest pattern across this pass and the next, and worth one section of its own
because the instances are independent and the conclusions are the same. The fifth row was
added by §14, forty minutes after the other four.

| | measured | should have measured |
|---|---|---|
| §13.8 | a clipped child's rect, reported as a visible overlap | whether two *visible* surfaces collide |
| §13.15 | `scrollHeight` on a text node, reported as clipping | whether the text is reachable |
| §11.9 | a synthetic `Tab` dispatch | whether focus moves on real input |
| §13.12 | a 30 s default timeout, reported as "the probe never settles" | whether the app overruns its own 75 s bound |
| §14.7 | a stubbed `ResizeObserver` whose callback the test called directly | whether the module observed anything at all |
| §14.10 | an interception that was never reached, asserted as a refusal | whether a reroute can fail at all |

Three of these made a screen look **worse** than it is — a clipped child counted as an
overlap, a scrollable label counted as clipped, an unreachable one that was reachable.
Three made it look **better**, and all three were mine: a gate with its budget silently reverted
to 30 s called a screen unsettled that was merely not finished, and a test whose stub
called its own callback made a module that observed nothing look tested, and an
interception nothing ever hit made an unreachable failure look like a detected one. The
first was caught by a wall clock that read `30003 ms`; the other two only by deleting the
code and watching the test stay green.

The general form is the one worth keeping, because each instance looked like a product
defect until measured: **a probe's failure and a product's failure look identical from
the outside.** Both are "the check failed". Distinguishing them means asking what the
check actually evaluated, which is not a thing a green or red result tells you. In every
case here the tell was a number that was too round to be real — a `0`-gap collision, a
count of seven where the instruction was never clipped, a timeout of exactly 30.003 s.

The honest summary of this pass is therefore not "nine defects fixed". It is: four
measurements corrected, and the defects found underneath three of them.

### 13.17 What this pass also closed

- **A tile-host failure substituted the map style silently.** Correct
  degradation, no sentence anywhere. `MapView` now reports the style it actually
  adopted and the layers panel distinguishes what was *asked for* from what is
  *drawn* — `online && basemap === 'offline'` says the tiles could not be loaded,
  while a deliberate offline session says what it is drawing. Reported after the
  boot's cancellation check, so an abandoned boot does not announce a source the
  map never adopted, and through a ref so a caller that re-creates its callback
  does not re-boot the style every render.
- **`resolveRoute` reported a cancelled request as a routing failure.** The abort
  surfaces as a `RoutingError` from `fetchWithTimeout`, so a cancelled online
  request fell through to the *next* engine — asking the offline engine for a
  route nobody wanted, and quite possibly drawing it.

### Closed by the boundary pass (§13)

| Was | Now |
|---|---|
| A truncated polyline decoded to a finite endpoint **30.9 km** from the truth | Refused, with the cause carried for the engine trace. §13.1 |
| A summary with no `time` printed `NaN hr NaN min`; one with no summary threw a `TypeError` into the UI | Validated at three levels; a missing duration stays missing and prints `—`. §13.2 |
| A captive portal's login page could become the app's shell **permanently** | The shell is verified before it is cached; verified in a browser, before and after. §13.3 |
| A part file poisoned by a `not-osm` rejection made every retry fail identically, forever | The prefix is sniffed on resume, and a rejected payload deletes its own. §13.4 |
| An OOM while reading a partial download **deleted the partial download** | Unreadable is not unusable: nothing is deleted, and the next attempt resumes. §13.4 |
| Two overlapping route requests raced; Exit mid-reroute installed the abandoned route and resurrected `status: 'failed'` | A `RequestGate` that throws on a stale answer and reports nothing. §13.6 |
| The stale-position guard refused to reroute a driver moving *away* from the destination | It asks whether the position moved, comparing raw fixes so a clamped projection cannot read as motionless. §13.5 |
| A tile-host failure changed the basemap without saying so | The layers panel names the difference between requested and drawn. §13.17 |
| An e2e check counted a slow network as a missing UI control | Structural count, with probe settling as its own claim. §13.7 |
| The reflow probe measured `data-textsize="normal"` at 200% and clipped children as overlaps | It waits for the attribute and measures visible rects. §13.8 |
| Two concurrent downloads shared one `AbortController`: the first was uncancellable and either could wipe the other's progress row | A handle per region, released only by its owner. §13.10 |
| A catalogue row ballooned to **1139dp** against a nominal 116dp, one line per reason paragraph | One line, expandable, reachable without a mouse. §13.11 |
| The Regions screen could show sixteen "Checking…" rows indefinitely, and looked identical to a hang | Bounded at 75 s, derived; every entry reaches a verdict with a reason. §13.12 |
| The gate for the above never used its own budget — `waitForFunction`'s options were passed as its argument, so it ran on Playwright's 30 s default and reported a slow probe as a hung one | `undefined` passed explicitly; verified to fail at 1.5 s and pass at 150 s. §13.12 |
| Two sibling cards with the same fill and different corners, read as one panel split in two | The notice matches the card's 16px radius. §13.13 |
| An empty turn list blamed the engine for a route that had no turns in it | Three causes, three honest explanations, in a tested function. §13.14 |

---

## 14. The type-scale pass: the last layout defect

§7 gap 11 had been open across four passes and described as "the largest single piece of
work left in the app". It was two defects wearing one coat, and neither was the one the
coat suggested.

### 14.1 The leading was a length, so it did not follow the type

`theme.ts` typed `lineHeight` as a `` `${number}px` `` string, and the comment above it
explained why that was deliberate: React writes a *number* into `line-height` verbatim, a
bare number in CSS is a multiplier rather than a length, and `line-height: 32` on a 24px
font would produce a 768px line box. The reasoning is correct. The conclusion was wrong,
because it weighed one class of mistake and ignored the cost of avoiding it.

Android's font scale multiplies text. A **length stays the length it was**. So at 175%:

| | 100% | 175% | what that means |
|---|---|---|---|
| `body1` type | 32dp | 56dp | the platform scaled the text |
| `body1` leading | 40dp | **40dp** | and nothing scaled the line box |
| glyphs needing | ~42dp | ~52dp | 12dp of overflow per line |

Measured across the navigation screen at 175%, **every text element** had its line box
shorter than its glyphs: 12px on the ETA values, 14px on the distance, 8px on each of the
three button labels, and 12px spread across the five lines of one maneuver instruction.
`tools/reflow.mjs` had been reporting five of these as *clipped labels* for two passes —
which is what that overflow looks like from outside the element, and is the fifth time in
this project that a probe's name for a finding has been the finding.

The fix is one type change. Google's published leading (`64/56`, `40/32`, `32/24`) is a
ratio, and the token now emits that ratio, with the dp pair kept in the table as the
source of truth so the specification stays legible:

```
display1: step(sans, 56, 64, 0)     // 56dp type, 64dp leading, per Design for Driving
```

At 100% the rendered line box is within **0.002px** of the published figure — the cost of
rounding a ratio to 4dp — and at 175% the overflow is **zero everywhere**.

### 14.2 The bars were measured by nobody

With the leading fixed, the ETA bar grew — correctly, because its numbers now wrap to two
lines at 200% instead of being clipped. And that immediately broke two other things,
which is the useful part, because it exposed the shape of the original defect:

- `.banner-stack`'s `top: calc(var(--app-bar, 96px) + …)` no longer cleared the bar that
  had just become 128px tall, so the maneuver card was drawn underneath it. Measured
  **168 × 8px** of overlap at 200%.
- `.nav-controls`' `max-height: none` in the short-screen block put its four buttons across
  the bottom bar by **4px**.

Both were the same mistake as the gap they came from: **a position written as a constant
next to something whose height depends on its content.** §13.9 had already concluded that
"the honest fix is to stop deriving layout from constants"; this is that fix.

`src/nav/chrome.ts` publishes the bars' *measured* heights as `--eta-h` and `--nav-h`, via
a `ResizeObserver`, and every anchored position reads them with the design token as the
fallback — so the first paint is right, and so is any platform without the observer:

```css
top:    calc(var(--eta-h, var(--app-bar, 96px)) + var(--inset-top) + 24px);
bottom: calc(var(--nav-h, var(--navbot, 128px)) + var(--inset-bottom));
```

The measurements are written as **separate properties** from the design tokens on purpose.
`--app-bar` says how tall a bar *should* be and `--eta-h` says how tall it *is*; collapsing
them would make each bar's height an input to itself.

### 14.3 A warning the driver could not see

Bounding the stack below exposed a defect that had been there the whole time, at **100%
text**, on the commonest layout in the app.

`.banner-stack` had **no lower bound at all** except under `[data-textsize="large"]`. On an
892×412 landscape phone the stack ran from y=120 to y=384 while the bottom bar began at
y=316 — so all 56px of **"You have left the route" sat behind the navigation controls**. A
driver who has left the route was told nothing. At 175% and 200% `reflow` reported it as
entirely out of view.

Nothing caught it, and the reason is worth keeping: `reflow.mjs` compares the pieces in
its `PIECES` list, and the notice is a *child* of the stack rather than a peer of it, so
the pair that was actually colliding was never compared. §13.8 established that this
probe cannot see some pairs; this is a third one, and the only remedy so far has been to
look at what a probe is pointed at rather than at what it reports.

Bounded at every text size now, and the stack scrolls instead of overflowing — the trade
§13.15 had already settled, that a banner you can scroll to is correct and one you cannot
see is not.

### 14.4 The alert goes above the instruction

Bounding the stack raised a second question: when the cards do not both fit — 216px of
room against 264px of cards on a landscape phone — which one is below the fold?

With the notice second, the answer was **the alert**, which §13.13 had explicitly reasoned
against: it said the notice sat beneath so it would never cover "the maneuver is the one
they act on immediately". That reasoning assumed both cards fit. They do not, and not
closely.

So the order is reversed: the off-route notice is first, the maneuver card second. A driver
who is not told they have gone off-route will keep following the road they are on — and
the instruction they can still see is precisely the wrong thing to keep following. The
cost lands on the instruction, which scrolls and is reachable, which §13.15 already
established is the acceptable way for an instruction to be unavailable.

This reverses a recorded decision, so it is recorded here with the measurement that
reversed it rather than as a quiet improvement.

### 14.5 What it measures now

`npm run reflow` is green — **all 12 checks at all three text sizes**, for the first time
in the project's history:

| | 100% | 175% | 200% |
|---|---|---|---|
| before | 4 checks, 3 failing | 4 checks, 1 failing | 4 checks, 3 failing |
| after | **4 passing** | **4 passing** | **4 passing** |
| clipped labels | 0 | **5 → 0** | **5 → 0** |
| chrome overlaps | 1 (68px, unreported) | 0 | 1 (new, then fixed) |
| off-route notice | **invisible** | out of view | out of view |

Verified independently at **three viewports × three text sizes**, all nine combinations
clean: 892×412, 412×915 and 1280×720 at 100%, 175% and 200%.

`reflow` is still a diagnostic rather than a gate, for the reason §10.3 gives — a gate
that always failed was a gate people learned to ignore — but it no longer fails, so that
reason has gone with it. It is listed in §2 as a passing row for the first time.

### 14.6 What is still open

**Written before §14.8 and §14.9, and superseded by both.** It is left in place because
the reasoning was coherent and the premise underneath it was false — which is the more
instructive record, and §14.9 is the correction.

What it claimed was open: *"The platform's font-size setting still does nothing to this
app, because every token is an absolute `px` and the `rem` conversion was never done."*

What §14.9 established is that the setting **does** reach this app's type — the platform
multiplies text, and text is what `px` sizes — so a `rem` conversion would have changed
nothing, and the remaining work described here as "a mechanical sweep of `theme.ts` and
`styles.css`" was work that did not need doing. The real remaining item was one line of
detection (§14.8).

So of the four items this section listed:

- ~~the navigation screen cannot cope when the text is large~~ — **closed**, §14.1–14.4.
- ~~the `rem` conversion is the fix~~ — **struck**, §14.9.
- **the platform's font scale never reached this app** — **false**, §14.9. It reached the
  *type*; what it never reached was the *layout*, because the detector watched the wrong
  value (§14.8).
- ~~the layout that responds to the platform's font setting does not exist~~ —
  **closed**, §14.1–14.4, and switched on by §14.8.

Nothing is left of gap 11 except the confirmation no amount of local work can supply:
§7 gap 1, that none of this has been seen on a physical device.

### 14.7 Two things this pass got wrong on the way

Recorded because both are the shape §13.16 is about, and one of them is mine.

**The fix was tested wrong, twice, before it was tested right.** The obvious experiment —
scale the text, then apply a unitless `line-height` — appeared to do nothing. It computed
the ratio *after* scaling, so it faithfully preserved the bug: 40/56 is the broken ratio,
and re-expressing it as a number reproduced 40px exactly. The second attempt failed for a
different reason: the ratio table was passed across a `page.evaluate` boundary, and DOM
references do not survive serialisation, so every lookup missed. Both produced a clean
"no improvement" from a fix that works. Measuring the ratio *before* scaling made it work
immediately, and the real numbers came out on the first honest run.

**The new test suite had a test that could not fail.** `chrome.spec.ts` stubbed
`ResizeObserver` and let the test call the captured callback directly. Deleting every
`observe()` call from the module left that test **passing** — it was exercising a closure,
not an observation, which is the module's entire mechanism. The stub now registers a
callback per observed element, and `fire(el)` only reaches an element that was actually
observed; with that, deleting `observe()` fails two tests. Worth stating plainly: I found
this by deliberately breaking the code rather than by reading the test, which is the only
reason it was found at all.


### 14.8 The detector was watching for the wrong thing

§14.6 leaves one thing open: *"The platform's font-size setting still does nothing,
because every token is an absolute `px`."* That sentence contains a second claim, and
nobody had checked it:

> On Android, the system font-size setting reaches a WebView by scaling the **root font
> size**. Absolute `px` lengths are not affected by it.

It is in `textscale.ts`'s own header, and it is the reason the detector watched the root
font size and nothing else. It could not be checked, because §7 gap 1 is that this app
has never run on physical hardware.

**It is also only half true, and the half that is false is the dangerous one.** A
platform has more than one way to scale text, and the two leave *different evidence*:

| how the platform scales it | root font size | a 16px probe's rendered height | old detector |
|---|---|---|---|
| nothing | 16px | 19px | `normal` — correct |
| the root font size is enlarged | 28px | 19px — unchanged | `large` — correct |
| rendered text is scaled | 16px — **unchanged** | **33px** | **`normal` — blind** |
| the page is zoomed | 16px — unchanged | **33px** | **`normal` — blind** |

Measured in Chromium at 892×412, with a probe span carrying an inline `font-size: 16px`.
The third row is `WebSettings.setTextZoom`, which is how Android WebView applies a text
scale — so under it this app rendered at 175% type with **every large-text rule off**,
which is exactly the collision §12.7 measured and §14.1 fixed. The layout work was
necessary and, on its own, insufficient: the app would never have known to use it.

The detector now reads both signals and takes whichever fires, which is the honest
position when the platform's behaviour is unverified:

```ts
if (reading.rootPx > TEXT_SCALE_THRESHOLD_PX) return 'large';
if (reading.probePx !== null && reading.probePx > PROBE_THRESHOLD_PX) return 'large';
return 'normal';
```

**Neither signal is treated as necessary**, because the two are *mutually blind* to each
other — the probe is deliberately absolute so that it cannot mistake a root enlargement
for no scaling, and the root reading cannot see a text zoom. That is asserted directly.

The probe's threshold is **24px, derived**: an unscaled 16px line box measures 19px here
and 33px at 1.75×, so 24px sits between them at roughly 125% — which is the same boundary
`TEXT_SCALE_THRESHOLD_PX` expresses as 20/16. The two thresholds are one scale seen two
ways, so neither mechanism starts reflowing before the other.

`npm run textscale` is the proof, and it is the only thing in the project that can be:
14 checks over four scenarios, each of which asserts its *precondition* before asserting
the outcome — that the root really is still 16px, and that the text really did grow. With
the probe signal removed it fails **4 checks**, including the two that matter, and the
failure is reported as a named failure rather than a timeout that kills the process.

#### Three things this got wrong on the way

**The gate's own simulation was worse than the bug.** It scaled text with
`html, body, body * { font-size: 1.75em }`, which compounds once per ancestor: the root
went to 28px and a single ETA value to **1407px**. The check that was supposed to prove
the app notices a scale was itself triggering the mechanism it meant to exclude, and it
would have passed for the wrong reason. It now multiplies each element's size **from its
own original**, so nothing compounds.

**The probe was invisible in a way that made it unmeasurable.** `visibility: hidden` is
laid out, so it measured correctly under a real scale — but `tools/reflow.mjs` skips
invisible elements, and so did the first version of this gate, so the probe was skipped
by the very tools meant to test it. It now uses `opacity: 0`, which is equally invisible
and equally laid out but is not something a measuring loop filters on.

**And then `test/screens.mjs` failed 39 checks**, all of them "no horizontal overflow —
SPAN@-9999..-9975". The probe was parked off-screen at `left: -9999px`, the usual trick,
and the screens suite was right: an element 9999px outside the viewport *is* overflow. It
is `position: fixed` at the origin now, with `pointer-events: none`. Worth recording
because it is the second time in this project that a new feature's own gate found a real
problem in something that already existed — the first was the catalogue row in §13.11.

#### What is still unverified

**Which mechanism a real device uses.** This cannot be settled here, and §7 gap 1 stands.
What §14.8 establishes is weaker and more useful: the app responds correctly to *each*
mechanism, so whichever one the device uses, the layout turns on.

**The last sentence of this subsection was itself a stale claim**, and it stood for a pass
after §14.9 struck the thing it names. It read *"The remaining half of gap 11 — making the
setting reach the type at all — is still the `rem` conversion."* The platform applies its
font setting as a multiplier **on text**, and text is what `px` sizes, so the setting
already reached this app's type and a `rem` conversion would have changed nothing. There
is no remaining half. Corrected here rather than left, because it is the same shape as the
rest of §2's list — a claim about code that nobody re-read — and because it was the only
one in this document that survived *being named as false in an adjacent section*.

Two of §14.8's own figures were also worth keeping: it claims the app responds to `setTextZoom`
and to a changed root font size, which are the two mechanisms Chromium documents. Neither
can be exercised from a browser, which is why the gate asserts the *responses* rather than
the setting arriving.

### 14.9 The largest gap in this document rested on a false premise

§14.6 kept one sentence of gap 11 open and described the rest as `rem` conversion work:

> the platform's font-size setting still does nothing, because every token is an
> absolute `px`

The reasoning underneath it was in `textscale.ts`'s own header, and it had been there
since the file was written:

> On Android, the system font-size setting reaches a WebView by scaling the **root font
> size**. Absolute `px` lengths are not affected by it.

If that is true, `rem` is the fix. If it is false, `rem` is a large refactor that changes
nothing. **It is false**, and Chromium's own documentation says so twice — from
`android_webview/docs/web-page-layout.md`:

> "Font Scale is only affected by the TextZoom setting."

> `setTextZoom` — "Sets the text zoom of the page in percent."

Which is the whole answer. The platform applies its font setting as a multiplier **on
text**, and text is what `px` sizes — so the setting reaches this app's type whatever unit
that type is written in. The same document recommends
`setLayoutAlgorithm(WebSettings.LayoutAlgorithm.TEXT_AUTOSIZING)` for browser-like
behaviour, and notes the System WebView Shell uses it. Corroborated from the field:
developers building Android WebView apps report that *"the Android Web View's font scaling
mechanism is always enabled in web content and will automatically scale font sizes defined
using the `px` unit"*, and that the usual workaround people reach for is
`setTextZoom(100)` — a call you only need if px text is being scaled.

**So: the `rem` conversion is struck rather than deferred.** Four passes of this document
ranked gap 11 as the largest single piece of work left in the app on the strength of a
premise that the platform's own documentation contradicts.

#### What was actually wrong, and it was not the units

Three things, and the first is the reason the other two went unnoticed:

1. **The detector watched the wrong value.** `data-textsize` is the only thing that turns
   on the large-text layout, and it was driven by the root font size — which a text
   scale leaves at 16px. So the layout never switched on. §14.8 fixed it.
2. **The leading was a length**, so it did not follow the scale that *was* applied.
   §14.1 fixed it.
3. **The bars' heights were constants**, so anything anchored to them collided once the
   text grew. §14.2 fixed it.

The order matters. (2) and (3) are real layout defects and were worth fixing on their own
merits — a driver who zooms, or whose platform autosizes text, gets the same collisions
whether or not the setting is honoured. But on a device they were unreachable: the
detector never fired, so `data-textsize` never became `large`, so rules (2) and (3) exist
to handle never applied. **§14's layout work was necessary and not sufficient, and the
insufficiency was one line of detection.**

#### How a false premise survives four passes

The same shape as §13.16, one level up. A claim is made about a platform, in a comment,
with a mechanism nobody can check without hardware; it is load-bearing for a large piece
of work; and every subsequent pass reasons *from* it rather than *about* it. §12.7, §13.8,
§13.15 and §14.6 all refined *how* to cope with large text and none asked whether the
platform was producing any.

The correction came from looking for the mechanism's documentation rather than for a
second opinion on the app — and the answer was in the platform's own repo, in a document
about layout, under a heading about hardwareness. The lesson worth keeping is narrow and
usable: **a claim about a platform's mechanism is checkable from the platform's
documentation, and being unable to run it locally is not a reason to assume it.**

#### What is still not verified

No device. §7 gap 1 stands, and this correction rests on documentation plus two Chromium
measurements rather than on a phone — so the specific Android version, the specific
Capacitor WebView configuration and the actual scale factor remain unconfirmed. What the
correction does settle is the direction: `rem` was not the answer, and the detection was.

It also leaves something genuinely open, and it is the more interesting half: because the
platform scales **text** and not **layout**, a scale leaves every box the same size while
the glyphs inside it grow. That is not a bug to work around — it is the behaviour to
design against, and §14's floors, measured bounds and scrolling stack are the response to
it.

### 14.10 A reroute cannot be refused by moving the driver — and a reason that vanished

§7 gap 5's open half. Four attempts, and the first three were all reasonable. What they
established is more useful than a green check would have been.

#### Attempt 1: intercept the engine

Installed a 500 from Valhalla before starting. All four checks passed — **and they also
passed with the interception removed**, because nothing had failed. The conclusion drawn
at the time was "reroutes use the offline engine, so the request is answered locally",
recorded in §7 gap 5. The premise was right and the conclusion was still wrong.

#### Attempt 2: drive the device somewhere unreachable

Two things were wrong with this, and both are about the harness rather than the app.

**Chromium fires `watchPosition` once per `setGeolocation`.** Measured: 0 fixes before a
change, 1 after one call, 9 after eight. The tracker needs two fixes more than
`CONFIRM_WINDOW_MS` apart, so **every off-route check in the e2e suite had been passing
against a screen that had never once attempted a reroute** — the pre-existing ones
included. `drive()` in the suite now emits a moving stream, because of this.

**And §13.5's stale-position guard holds a stationary driver.** It compares raw fixes, so
a device parked at one position reads as motionless and is told "waiting for a position
update" for ever — correctly, since a car at a red light should not be told it is off
route. Each tick therefore walks a few metres.

#### Attempt 3: put the engine away mid-trip

With a working `drive()`, the reroute fired and succeeded — **for a fix in Swindon, ~60 km
outside the imported extract.** That is the finding, and it is a property of the product
rather than of the test:

> `rerouteOrigin` returns a point **on the route** — `track.correction`, or
> `route[snappedIndex + 3]` — never the driver's actual position.

So the engine is asked for a path between two points the route already connects. Moving
the driver as far as the device can go cannot make that path not exist, and no amount of
interception will make it fail.

#### Attempt 4: make the graph the one that answers not know the route

The remaining possibility is that the *offline* graph does not contain the pair — so the
route was produced by Valhalla (asserted, not assumed: the preview says so), and Valhalla
was then taken away. Measured result: **2 requests intercepted and the reroute still
succeeded.** The offline extract covers the same roads. Even a route the offline engine
did not draw is between two real places in the extract, and it can route between them.

A refusal therefore needs the loaded extract not to cover the reroute pair, and the only
way to arrange that is to change the dataset mid-trip — which means leaving navigation,
because the Regions screen is not reachable from it. **That is the whole of what is open,
and it is a harness limit with a specific reason rather than an untried idea.**

#### What the suite asserts instead

Three properties that are reachable, and one of them is the point of the whole app:

```
PASS  the route came from the offline map - Offline .osm
PASS  the driver is told they have left the route
PASS  the reroute is answered by the offline map, with no request leaving the device
PASS  the app never claims it found a new way
PASS  guidance survives the reroute
```

The offline one is verified to bite: putting the online engine first in `localStorage`
turns it red, reports `Valhalla`, and shows `1 routing requests attempted`.

#### The real defect this turned up

Instrumenting the failure path to find a browser-reachable one found a bug instead.

`finishReroute` keeps *why* an attempt failed in `reason`, and its own comment says:

> The reason outlives the next fix: `message` alone is rebuilt every fix and becomes a
> bare countdown a second later.

True for the countdown branch. **False for the branch that mattered.** `observeFix`
checks the tracker's state first, and when a driver who has gone off route comes back
onto the line and off it again — the tracker returns to `suspect` — it rebuilt `message`
as a flat `"You have left the route"` without consulting `reason`. Measured in the
browser: the first refusal showed *"Off route — Could not reach the routing server —
check your connection"*, and **every fix after it said only "You have left the route".**

So the app told the driver why once, and then stopped, for as long as they drove the
wrong way — which is exactly when the reason is worth the most. Same shape as §13.14's
`stepsEmptyReason`: a screen reporting the *situation* and discarding the *cause*.

`observeFix` now carries `reason` into that branch, and `reroute-reason.spec.ts` pins
four things about it — that it survives the suspect branch, that it survives the
countdown, that it appears in the **banner** and not only in state, and that it stops
being reported once a reroute succeeds. Verified to fail on three separate reversions.

#### What the three attempts have in common

Each was a way of asking the *simulator* to behave differently, and the answer was that
the app's own design already removes the difference: a reroute is asked for between two
points on a path that exists, by a graph that covers them. The one thing that would make
it fail — losing the extract — is not something a driver does mid-turn.

That is worth more than the check I went looking for, and it is the same lesson as §14.9
in a different place: **when a test cannot be made to fail, the first question is whether
the failure it is looking for is reachable at all.**

### 14.11 Five defects in the regions screen, from reading it rather than running it

Found by having a second pass over `settings.ts`, `persist.ts`, `download.ts` and
`RegionsScreen.tsx` looking for defects with no browser involved. Four are fixed and
verified; the fifth is recorded unfixed with its evidence, because the fix is not the
obvious one.

#### 1. Two downloads ran at once, and my own §13.10 note said they had their own rows

`startDownload` aborted `downloads.current.get(entry.id)` — a download of the **same**
region. Two *different* regions could therefore run concurrently: 380 MB and 1.4 GB on a
metered automotive connection, sharing the one `dl` row, so the row flickered between
them at stream-chunk rate and the single Cancel button aborted whichever happened to be
showing while the other ran on unstoppably.

The code comment said *"One at a time, deliberately"*, and `downloads`' own comment listed
"two downloads could also be started at all" as the problem the `Map` fixed. **A `Map`
does not fix that.** It makes each download cancellable; it does not prevent the second.

And §13.10 recorded the opposite as a deliberate decision — that two regions "can still
run concurrently, and that is deliberate", on the grounds that *"each now has its own row
and its own cancellation."* **There is one row.** That sentence described a capability
this screen does not have, and it is what kept the guard permissive. A documented
decision is still a decision; it was simply wrong, and it survived because nothing
compared it to the JSX.

`startDownload` now aborts every live handle before starting, and the Download button
refuses a second region while one is in flight.

#### 2. A quota failure on the download path was reported as success

`store.ts` does `void saveRegion(...).catch(err => onPersistError?.(err.message))`. With
no callback the rejection is **handled and then discarded** — no unhandled-rejection
warning, no report. So an import that parses perfectly and then fails to persist — a
quota exhaustion, which `persist.ts` goes to real trouble to word, naming the region, its
size and which other region to delete — reported success: the row says loaded, the chip
says "1 loaded", and the region is gone on next launch with nothing said at any point.

`App.tsx` documents this exact bug for the *import* path, in a comment, and fixes it
there:

> it was passed by nobody in the repo — so a device that ran out of room silently lost
> the region on next launch while the UI said "1 loaded"

The **download** path was left, and it is the path most likely to exhaust a quota,
because the file has already been downloaded. Both call sites now pass both callbacks,
and a test asserts *every* `importRegionFile` call site does — because the defect was
purely that two of three looked identical at the file level.

#### 3. The probe's own diagnosis was computed and thrown away

`checkRegionAvailable` never throws for a network failure; it **returns** a verdict whose
`error` is a sentence `networkMessage` writes specifically for it — naming the host,
saying extract hosts do not allow cross-origin reads, and pointing at Import as the route
that works. `startDownload` read `avail.ok` and `avail.status` and dropped `avail.error`,
replacing it with:

> The catalogue URL may have moved, or this device may be offline.

Both clauses are false for the case that actually happens (§7 gap 4: CORS). The file's own
comment on the *older* wording calls this the bug — *"the old wording told the user to
'check the device's network' when their network was fine"* — and it was back.

Worse, the same block reported a **probe timeout** as a cancellation. A hung host aborts
after 15 s, `checkRegionAvailable` throws `aborted(entry, 0, null)`, and the driver was
told they had cancelled a download they had never started. `timedOut` now distinguishes
them, and says what actually happened: the host accepted the connection and sent nothing.

`clearTimeout` also moved into a `finally` — it sat *after* the `await`, so the throw
skipped it and left a 15-second timer armed, holding its closure, on a path the code was
written to make unreachable.

#### 4. An error response's body was never released

`fetch` resolves on headers, so a `503`'s HTML body is still streaming when `fetchOnce`
throws — and `retryable()` treats 429/500/503 as worth another attempt, so this ran up to
three times with every previous error page still being pulled in the background.

The `try`/`finally` that owns the reader is not entered on that path, so nothing released
it. `checkRegionAvailable` discards on all four of its exits for exactly this reason,
justified there by a measurement — *"opening the regions screen transferred 9,961,472
bytes for a 619,019-byte file"*. The same leak, one function over.

The test for it was wrong twice before it was right: the first version called
`res.body.cancel()` itself and counted that, which passes with the discard removed; the
second observes the stream's own `cancel` callback, which only the code under test can
provoke. **0 releases without the fix, 3 with.**

#### 5. On a device, the resume copy is never written — recorded, not fixed

`download.ts` writes the finished file to the device with:

```ts
await b.fs.writeFile({ path: dest, directory: b.dir, data: file });
```

`file` is a `File`. `@capacitor/filesystem`'s own type declaration says:

> `data: string | Blob` — **Note: Blob data is only supported on Web.**

And this branch runs **only** when `Capacitor.isNativePlatform()` is true. So on a real
device the write rejects every time, the resume copy never exists, `cachedRegion` never
hits, and an interrupted download restarts from byte zero. The module contradicts itself
twelve hundred lines earlier: `readBinary`'s comment says *"Native returns base64 (Blob
is web-only)"* — and then hands a Blob to `writeFile`.

**Not fixed here, deliberately.** The obvious fix is to convert to base64, and at 380 MB
to 900 MB that is a 500 MB to 1.2 GB string across the bridge — the same cost that made
§13 decline to enable `CapacitorHttp` wholesale, and the reason Capacitor's own guidance
is `@capacitor/file-transfer`. A chunked base64 writer is implementable, and shipping one
that can only be exercised on hardware I do not have (§7 gap 1) is how this project ends
up with a plausible-looking untested path — §12.2 is the precedent for what that costs.

What *was* fixed is the sentence the failure produces. It used to read:

> "It will only be available until the app is closed."

**That is false**, and it is the most alarming line in the file. The finished file is
imported and persisted separately by `saveRegion`, so the **map** survives a restart and
a reboot — which is the entire point of downloading it. What the cache is for is
`cachedRegion`: resuming an *interrupted* download. Telling a driver their province will
vanish when it will not is how you make people avoid the part that works. It now says
the map is saved and that an interrupted download will have to start again.

#### The general form

Four of these five are the same mistake, and it is the one this project keeps making:
**a comment stating an invariant that the code does not enforce.** "One at a time."
"the reason outlives the next fix." "this path is unreachable." "Blob data is web-only,
and we are handing it a Blob."

A comment is a claim about code, so it needs the same treatment as a number: re-derived,
or checked. §2's `npm run status` now checks the shapes it can, and four of these five
turned out to be checkable as source invariants — which is not the same as true, and is
why the fifth is recorded rather than asserted.

### 14.12 A\*'s optimality guarantee was void for a different reason than §12.1 fixed

§12.1 found that the priority queue was not a heap — one slot per *node* rather than per
entry, so a stale entry compared as the re-priced one and `pop()` stopped returning the
minimum. `test/minheap.spec.ts` proves that, and keeps the broken implementation in the
file asserting that it does not pass.

A correct queue is necessary and not sufficient. A\* also needs `h` never to
overestimate, and that half had no test and was broken:

```ts
const OPT_SPEED = 60 * 0.27778; // 60 m/s
```

**It is 16.667 m/s, which is 60 km/h**, and the fastest class in the table is `motorway`
at 105 km/h — 29.167 m/s. So the heuristic assumed 0.0600 s/m while a motorway edge
really costs 0.0343 s/m: it **overestimated on motorway, trunk and primary edges**, which
is inadmissible, and the route A\* returned was not the cheapest.

`OPT_SPEED` is now derived from the table, so it cannot drift from it again:

```ts
const OPT_SPEED = Math.max(...Object.values(SPEED)) / 3.6;
```

Measured on the repo's own `test/fixture.osm` graph: **2 of 593** random node pairs came
back suboptimal before the fix, 0 after. Small, and on the *default* engine.

#### Why `test/engine.spec.ts` never saw it

Its quality assertion compares against "the grid optimum" in **metres**. But the cost
model is travel **time**, and the two disagree exactly where this bug lives: a motorway
detour a few metres longer is the right answer by distance and the wrong answer by time.
Measured in metres, the defect is invisible.

#### Writing the test took four corrections, all recorded in the file

Worth listing, because each looked like a passing test:

1. **A synthetic grid could not reproduce the violation at all.** With a regular lattice
   the overestimate is uniform across nodes, so the pop order — and the answer — usually
   comes out right. The grid passed with the broken value in place, at both a 4.2× and a
   10.5× speed spread. Irregular geometry is what makes it bite.
2. **The grid fixture was malformed.** `edgeStart` is per *node*, not per edge; the
   first version pushed one offset per edge, giving 121 entries for 36 nodes, and a
   quarter of the pairs reported "no route" — which reads like a heuristic failure.
3. **The first flags were `1` and `2`**, which are the engine's one-way bits, so half the
   grid became one-way.
4. **The reference was wrong twice, and both times in the direction of a false pass.**
   Its nearest-node lookup disagreed with `index.nearest` on a quarter of the pairs, and
   it then walked every edge **ignoring one-way flags** — reporting a cheaper optimum
   than the engine could legally reach, as 41 "suboptimal" routes that were not. A
   reference that is wrong in the permissive direction makes the subject look worse.

The file's own header says the grid section is a regression net rather than the thing
that catches the bug, and says where the bug is actually caught: the real fixture, with
one-ways, where the engine's own `stepCost` and the reference agree.

### 14.13 Two more claims that were stale, and one that is a real gap

From the same pass, both cheap:

- **`roadsToGeoJSON`'s "Default 0 means no filtering"** was stale, and stale in the
  dangerous direction. `RENDER_MIN_ZOOM` drops every class above the supplied zoom, so the
  default keeps only what is drawable at zoom 0 — **one class of fifteen**. Measured on a
  dataset of one `residential`, one `service` and one `motorway`: the no-argument call
  returns the motorway alone. The *code* is right, and `test/renderzoom.spec.ts` asserts
  it; a caller who read the comment would render a motorway-only map and believe it
  complete. Comment corrected.
- **`simplify` promises "at most `max` points"** and delivers `max + 1`, because the
  strided loop yields up to `max` and the final-point guarantee then appends one.
  `test/geo.spec.ts` permits it. Left as it is and the comment corrected: the extra point
  is the *destination*, and tightening the bound would let a caller drop it.

**And `strict` — where reading it carefully inverted the diagnosis.** The audit reported
that `strict` "never stops the walk" and that the code let `local` serve. The first half
is a **docstring** problem and the second is real, but they are not the same defect, and
acting on the report as written would have "fixed" behaviour that is correct.

`src/nav/providers.ts` held **two docstrings that disagreed**:

- `RouteRequest.strict` — "Treat the plan as the whole world: **never append** the
  offline engine… Walking *within* the plan is still allowed — that is what `any-online`
  means, since its plan is three hosted engines and stopping at the first failure would
  make the choice a lie."
- `resolveRoute` — "`strict` **stops the walk** after the first real attempt."

**The field is right.** There are three online providers, so an `any-online` plan has
three entries, and a strict walk that stopped at the first failure would report
`fellBack` for a selection the user never made. So `resolveRoute`'s docstring was wrong,
and wrong in the direction that reads like a *stronger* guarantee than exists — the
expensive direction, because a reader trusts it. Corrected, and the behaviour it
described is now stated rather than implied.

The real defect was underneath: `strict` means "never append the offline engine", and
the legacy call shape — which builds a plan from a bare `provider` when none is supplied
— appended it unconditionally:

```ts
meta(req.provider)?.online ? [req.provider, 'local'] : [req.provider]
```

So `resolveRoute({ provider: 'valhalla-fossgis', strict: true })` built
`['valhalla-fossgis', 'local']`, and when the pinned engine could not route, **the
offline engine answered** — the one thing the flag exists to prevent, reached by the one
call shape that did not consult it. `&& !strict` added.

It survived because the failure is **invisible in the message**: the local engine's own
failure never reaches `degraded`, so the closing wording is identical whether or not it
was consulted. That is why the test asserts on the *outcome* — with a routable map, does
`local` answer? — rather than on the text, which cannot tell.

Both app call sites pass an explicit `plan`, and `planRoute` omits `local` when fallback
is off, so nothing in the app reached it. `test/engines.spec.ts` missed it for the
matching reason: it notes that "a strict plan never contains the offline engine", which
is a true statement about `planRoute`'s output and was being treated as a property of
`resolveRoute`.

`test/strict-plan.spec.ts` pins both halves — that `strict` confines a *derived* plan,
and that it does **not** stop a walk through a plan it was handed — plus that the two
docstrings now agree. Verified to fail on three separate reversals.

Writing it took five corrections, and three of them were the test passing for the wrong
reason: `from`/`to` are `LatLng` **tuples**, so passing `{lat, lon}` objects made the
offline engine read `undefined` and return null; `valhalla-custom` is correctly skipped
without an endpoint, which read as the walk stopping early; and `NoRouteError` carries
no `attempts`, so scraping the message for evidence of a fallback was never going to
work.

### 14.14 The imported road network was never drawn

The most consequential defect found in this pass, and it is a one-word bug.

`applyOverlays` in `src/map/MapView.tsx` wrote the imported `.osm` road network like
this:

```ts
set('canopy-osm-roads', layers.roads);
```

**`canopy-osm-roads` is the id of the _layer_ that draws arterials. The _source_ every
road layer reads is `canopy-osm`** — `canopy-osm-casing`, `canopy-osm-minor` and
`canopy-osm-roads` all declare `source: 'canopy-osm'` in `style.ts`, and
`overlaySources()` declares `canopy-osm`, `canopy-osm-water` and `canopy-osm-green`.

So `m.getSource('canopy-osm-roads')` returned `undefined`, and `set` took the branch it
has to have:

```ts
const set = (id: string, data: GeoJSON.FeatureCollection) => {
  const src = m.getSource(id) as maplibregl.GeoJSONSource | undefined;
  if (src && 'setData' in src) src.setData(data);   // a miss is a no-op, by design
};
```

That tolerance exists because sources do not exist until a style loads, and it is
correct. It is also what swallowed this: **water and green rendered, roads did not, and
nothing errored.** In the app's primary mode.

#### Why it survived

The id *looks right*. `canopy-osm-roads` is exactly the layer you would check to confirm
roads are being styled, so the name was never suspect — the mistake was not a typo but
a **category** error, and a name that reads correctly across the boundary is the worst
kind.

And the tests were all pointed at the wrong thing:

- `test/basemap.spec.ts` asserts on the **text** of `MapView.tsx` — that
  `basemapFor(p.dataset, …)` is called — not that its output reaches anything.
- `test/mapstyle.spec.ts` asserts the **layers**.
- `test/attribution.spec.ts` asserts the **sources**.
- Nothing cross-checked the ids the writer uses against the ids the style declares, which
  is the only check that would have caught it.

Three suites, each correct, and the seam between them unexamined.

#### The check that was missing

`test/mapsources.spec.ts` resolves **every** id passed to `set(…)` against
`overlaySources()`, asserts none of them is a layer id, and — in the other direction —
asserts that every road layer's declared `source` is a declared source. It is a
static check, because the defect is a static one: two tables of identifiers that must
agree and did not.

It also asserts it found any ids at all, because a regex matching nothing would make
every other assertion pass for the wrong reason.

Verified to fail three ways: the original bug restored, a second layer id substituted
for water, and a source left unwritten.

#### What this says about the other five findings in the same pass

Three more came out of the same audit and are recorded in §14.15; two are stale comments.
The pattern across all of them is that **the code was right about everything except one
identifier, one threshold, or one sentence**, and in every case the evidence needed to
catch it already existed elsewhere in the repository — `overlaySources()` had the right
ids, `SPEED` had the right speeds, `RENDER_MIN_ZOOM` had the right classes. Nothing was
missing except the join.

### 14.15 Three more, and the shape they share with §14.14

From the same audit, and each corrected:

- **`regions.ts`'s "Fall back to whichever single region covers the most of the span."**
  There is no span-overlap computation. `plan()` is an unconditional **origin-first**
  preference: `if (a) return …; if (b) return …`. So a journey 1 km inside Alberta's
  edge and then 2 500 km into Quebec returns `{region: Alberta}`, and `route()` asks
  Alberta's graph for a destination it has never heard of. The helper that *would*
  implement the stated criterion — `bboxOverlapFrac`, exported from the same file and
  unit-tested — is **never called by anything in `src/`**.

  `test/regions.spec.ts` pins the opposite behaviour ("falls back to a single plan when
  the two regions are not neighbours" asserts `plan.region.id === 'a'`, the origin's), so
  a fix implementing the comment would fail the suite. That is the correct outcome for a
  behaviour change and the wrong outcome for a bug fix, which is why this is recorded
  rather than changed: **which one is the defect — the comment or the code — is a
  product decision**, and it changes which regions a loaded pair can route between.

  The comment now describes what the code does, and says plainly that the criterion is
  available and unapplied, so the decision is visible in the file rather than only here.

- **`offRouteThreshold`'s "growing to ~90 m at 30 m/s (108 km/h)".** The code returns
  `25 + Math.min(65, speed * 2)`, which at 30 m/s is **85 m**. The 90 m ceiling is only
  reached at 32.5 m/s. The "~" was doing the work of hiding a 5 m discrepancy in a
  threshold a reader would use to reason about motorway tolerance. Corrected to state
  both numbers.

- **`GEOCODE_TIMEOUT_MS`'s "the same 20 s figure … as `VALHALLA_TIMEOUT_MS`"**, two lines
  below "12 s is comfortably longer than a real request". The constant is `12_000`; the
  sentence is a leftover from when it was 20 s. Corrected.

#### The shape

§14.14 was one identifier. These are one threshold, one sentence, one stale figure, and
one helper that exists but is never called. In **every** case the correct value was
already written down somewhere else in the repository — `overlaySources()` had the source
ids, `SPEED` had the motorway speed, `VALHALLA_TIMEOUT_MS` had the 20 s, and
`bboxOverlapFrac` was exported and tested.

Nothing was missing. The **joins** were.

### 14.16 Two more code defects, one of which is the largest thing found in this pass

#### Closed here: a comment that named a test which does not exist

`App.tsx`'s search effect says `props.location` is intentionally not a dependency and
that "`test/search-debounce.spec.ts` fails if the raw array comes back". **That file has
never existed** — it is the only one of the ten `test/*.spec.ts` files cited from `src/`
that is absent. The invariant is in fact upheld (`locationRef.current` is read instead),
and what actually covers it is `test/audit-regressions.spec.ts`, which asserts the string
`props.location` is absent from the dependency list.

So this is not a behaviour bug. It is a comment naming the mechanism that keeps an
invariant true, and the mechanism was not there to be found — a reader trusting it would
look for a test and conclude there is none. Corrected to name the test that exists, and
`test/stream-progress.spec.ts` now asserts that **every** `test/*.spec.ts` path cited from
`src/` exists.

#### Closed here: the streaming parser's dead progress state

`parseOsmXmlStream`'s docstring claimed that without a size hint "progress is reported
against the high-water mark". It was not: a variable named `high` was accumulated on
every window cut and **never read anywhere in the repo** — the fingerprint of reporting
that was removed and not re-wired — so a caller passing no hint got one value,
`onProgress(0.5)`, after the last chunk.

`test/stream.spec.ts` could not see it, because it asserts monotonicity and a terminal
`0.5`, and a one-element `[0.5]` satisfies both.

The dead state is gone and the comment now says what happens. **The tempting repair was
wrong**, which is the part worth recording: `high / seen` looks like a rising fraction and
is **1.0** from the first boundary onward, so it is not a fraction of anything — and any
other rising value without a denominator is *invented*, claiming the parse is 40% done when
nothing knows that. That is §13.14's defect in a new place: a surface reporting something
the data does not support. The honest answer is one terminal report, and that is what
ships. Production is unaffected either way — `engine.ts` always passes `file.size`.

#### Open, and it is the largest thing in this pass: focus is never returned

`App.tsx` keeps a `returnFocus` ref described as "the element focused before the last
screen change, so `Back` returns to it", keyed by screen name so that "returning to the
launcher from Settings should return to the card that was pressed".

**Nothing ever reads it.** `rg -n "returnFocus" src/` returns two hits: the declaration
and the assignment inside `go()`. The only focus work a screen change does is

```tsx
if (mounted.current && document.activeElement === document.body) {
  focusQuietly(headingRef.current);
}
```

So launcher → tap the **Settings** tile → press Back lands focus on the Home `<h1>`,
never on the tile that was pressed — and because `go()` **overwrites** the record on the way
back, the original entry is gone too. The scenario the comment describes is the one §11 was
written for, and this path is the gap in it. Nothing in the suite covers it:
`test/focus.mjs`'s 15 checks never leave a screen and come back.

Recorded, not fixed: restoring focus means reading the ref on back-navigation and focusing
a possibly-unmounted element, which needs a "is it still in the document" guard and a
decision about whether to fall back to the heading. That is a focus-behaviour change to a
screen §11 already reworked twice, and it belongs in its own pass with the focus suite
extended to cover it — not in the last hour of one.

#### Superseded: the PBF reader is never streamed, and the comment says it is

§14.16 recorded this as *open* — "the largest single piece of engineering left in the app",
with the honest note that it was recorded rather than fixed. **It is now fixed**, and the
claim in that subsection is superseded: PBF streams.

What was true then, and is what the defect actually was:

- `engine.ts` took `await file.arrayBuffer()` unconditionally on the PBF path, so the whole
  extract was resident **on the main thread** before a byte reached the worker.
- `engine.worker.ts` then read that stream to completion, concatenated every chunk into a
  second full-size `Uint8Array`, and parsed that. **Two copies of a province.**
- Meanwhile the comment three lines above said the stream exists so a multi-hundred-MB
  extract is "parsed in a bounded window instead of being held whole, which is the
  difference between parsing a province and being OOM-killed by one."

Now: `engine.ts` transfers a `ReadableStream` (transfer, not copy — an untransferred
`ReadableStream` throws "could not be cloned because it was not transferred"), and
`parseOsmPbfStream` in `pbf.ts` holds **one blob at a time**.

**Why PBF can stream at all, which is not obvious.** XML streams because an element
boundary is findable in the buffer (`elementBoundary`). A protobuf field is a varint of
unknown length, so there is no element boundary to cut on. What PBF *does* have is a
self-delimiting **blob** boundary: `BlobHeader` carries `datasize`, so a reader knows
exactly where the current blob ends before reading any of it. `ByteQueue.ensure(n)` waits
for `n` bytes and `take(n)` hands them over, which is the whole mechanism.

**`take` copies, deliberately.** A view into a queued chunk would be one `await` from being
overwritten by the next `ensure`, and `readBlobPayload` is async — so an uncompressed
(`raw`) blob would be parsed from memory that had been recycled. That failure is silent:
wrong coordinates, a plausible-looking extract, a wrong route. The cost is one allocation
of at most `datasize` bytes per blob (~8 MB), transient and immediately collectable. A
lifetime that is a property of the call order rather than of the type is not worth the
allocation it saves.

`MAX_BLOB_HEADER` is enforced on the streaming path too, and it was not at first. Without
it a garbage header length becomes a request for gigabytes: the reader appears to *hang*
rather than reject. Three tests here failed for real reasons during this work — the type
error on the `ReadableStream` adapter, a blob-range helper that sliced from the body
instead of the length prefix (so the reader began mid-record), and a budget calculation
that **doubled** the assumed heap and made this pass's guard more permissive than
`mergeguard`'s on the same device. All three are recorded because all three were the kind
of bug that passes a review.

#### Closed here: nothing measured RAM before starting

`download.ts` asks `navigator.storage.estimate()` about free **disk**. That is the right
question for the download and the wrong one for the parse: a 334 MB extract has room on
disk and does not have room in the heap.

What happens without a check is worse than an exception. **An out-of-heap WebView is killed
by the system**: no `throw`, no `worker.onerror`, so `OsmEngine`'s handler never fires,
`buildPromise` never settles, and the user sees the app return to its launcher with the
progress bar simply gone. `onerror` converts a *throw* into a message; an OOM is not a
throw, so the one mechanism built for this could never have caught it.

`src/osm/importguard.ts` now refuses before `new OsmEngine()` exists. Three outcomes, as
`mergeguard`: proceed / proceed-but-warn / refuse-with-a-reason. The estimate is
`bytes / 8` nodes × `PARSE_BYTES_PER_NODE` (112 — the boxed `RawNode` peak, *not* the 96 B
of a resident graph, which would under-estimate by roughly half).

**`forceMemory` exists because the estimate is a constant times a file size, not a
measurement.** Unlike `mergeguard`, which measures real typed arrays, this one guesses, and
a user who has watched a progress bar say "needs 4 GB" is entitled to disagree. The Regions
screen asks the guard *before* running the import — the file is still in hand there, which
it is not after a refusal — and offers "try importing it anyway". An import that dies was
asked for.

#### Closed here: the basemap rebuilt the whole province at every zoom boundary

`basemapFor` held a **single** `WeakMap` slot, `dataset -> {zoom, roads, water, green}`,
with a hit only when `entry.zoom === zoom`. So crossing an integer zoom boundary — the
most common camera movement there is, and the one the LOD exists to make *cheaper* — threw
away the entire provincial road network and re-serialised it on the main thread. Pinch out,
pinch back, whole province built twice. **A guard that pays full price at exactly the
boundary it was added to smooth is not a guard.**

Two further things were rebuilt needlessly: `water` and `green` do not vary with zoom at
all (`RENDER_MIN_ZOOM` applies to roads only), so they were re-walked and re-allocated per
crossing to produce identical values.

Now: a 3-entry LRU keyed on integer zoom, and the zoom-independent layers built once per
dataset. Zooming across a boundary usually finds the arriving level already resident,
because the level just left is still there.

### 14.17 The memory pass: what it does *not* fix

The three changes are recorded under §14.16's "Superseded" heading, because that is the
defect they closed. What is left undone is the reason §15 exists.

**Streaming removes the file from the peak. It does not remove the node map.** OSM PBF
writes every node before every way, so when the ways arrive and name the nodes they
reference, the coordinates are already gone from the stream. A reader cannot discard nodes
as it goes; the map is required until the last way is seen.

`buildDataset` therefore *consumes* its inputs — it clears the node map and empties the way
array before returning, so the parse peak is not held for the life of the region. That is
help and it is not sufficient. For Alberta's ~44 M nodes the boxed map is the dominant
term, and §15.1 is about that.

**And the province still does not parse.** On the pinned constants a 334 MB extract is
refused on *every* device, including an 8 GiB one: ~4.9 GB estimated against a ~2 GB
budget. The guard is right and the product consequence is that the largest catalogue
entries are now unusable by default. §15.1 exists because of this, and §7 gap 13 is the
same fact as a gap.

**One measurement was wrong while writing this.** The `BoundingClientRect`-style reasoning
was fine but the *assumption* that a refused import could be distinguished from a
successful one by its return value was not: `importRegionFile` returns `null` on failure
*and* on a guarded refusal, so a test asserting "the override let it through" by checking
for a non-null dataset cannot tell the two apart. It asserted nothing and was rewritten to
assert on the *absence of the memory message* instead — which is the actual claim. The same
applies to the streaming tests: two of the three failures in this work were tests that
measured the wrong thing (a blob range sliced from the body rather than the length prefix,
and a "bounded prefix" assertion that omitted `totalBytes`, so it sampled at end of file
because there was only ever one progress report). §13.16 is about exactly this and it has
now produced a fifth instance in one afternoon.

---

## 15. The roadmap

Everything not yet done, ordered so that each step is worth doing before the next. This
section was written in one sitting after the memory pass (§14.17) and is the most
opinionated part of this document: it is a judgement about what to do next, not a
measurement.

### 15.1 Make the biggest extract that fits actually fit

The thesis of everything below. The app's hard limit today is memory, and the fix is to
stop asking the device to hold a province. In order:

**1. Verify the bbox-filter assumption against real data, before writing it.** OSM PBF
blobs are not required to be geographically sorted, and the streaming crop depends on
reading them once and discarding what is outside the box. If blobs interleave, the
filter is still correct but the *peak* is not bounded by the box. **This is a
half-day investigation that decides the shape of everything after it**, so it goes
first. Fetch one real Geofabrik file (Alberta is 334 MB; a smaller province is fine) and
report blob count, blob size distribution, and whether node coordinates are
geographically clustered per blob.

#### 15.1.1 The answer, and it inverts the premise

**Done**, and the premise was wrong. Six real Geofabrik files were measured with a
standalone decoder written against `osmformat.proto` rather than against `src/osm/pbf.ts`,
so that it was able to disagree with the shipped parser. Two streaming passes per file,
memory-flat in the blob count.

| file | size | OSMData blobs | nodes | ways |
|---|---|---|---|---|
| monaco | 0.66 MiB | 8 | 41,708 | 6,249 |
| andorra | 3.33 MiB | 68 | 501,887 | 26,721 |
| malta | 8.51 MiB | 119 | 789,467 | 148,678 |
| bremen | 20.23 MiB | 252 | 1,665,822 | 329,294 |
| iceland | 61.83 MiB | 1,395 | 10,583,300 | 537,915 |
| **new-york** | **474.35 MiB** | **8,026** | **56,819,669** | **7,301,791** |

**Node blobs are exactly 8,000 nodes each** (osmium's default; the only other size is the
final partial block), and they are **not geographically clustered at all**. 99.9% of
consecutive blobs' bounding boxes *overlap*; essentially none are nested and none are
disjoint. The first New York node blob is 8,000 nodes spanning lon [−79.89, −73.99],
lat [40.76, 45.00] — most of the state. Blobs are runs of 8,000 consecutive **node ids**,
which correlate with creation date, not geography.

So the assumption §15.1 was written on is false, and §15.1 said what would follow:
*"the filter is still correct but the peak is not bounded by the box."* Half of that is
right and the important half is wrong.

**The peak is bounded by the box anyway — for a different reason.** The crop filters
**per node at decode time**, not per blob, so a node outside the box is never stored at
all. Blob interleaving is therefore irrelevant to the peak: the node map grows
monotonically to exactly the final kept count and holds no out-of-box node at any point.
Measured, in all six files: **peak resident nodes = 1.00× the in-box count.** And measured
as heap, with `src/osm/pbf.ts` copied verbatim and only a bbox added:

```
bremen, no crop     1,665,822 nodes   peak heap 385.3 MiB
bremen, 1/16 crop       59,199 nodes   peak heap  44.0 MiB     8.8x lower
andorra, no crop       501,887 nodes   peak heap 107.1 MiB
andorra, 1/16 crop     118,457 nodes   peak heap  34.2 MiB     3.1x lower
```

**Two facts that change the implementation, and one that changes the plan:**

- **Single pass is safe, on a stronger ordering than §15.1 assumed.** In all six files node
  blobs are a contiguous prefix, way blobs a contiguous suffix, and **zero blobs contain
  both** — no way ever precedes any node. "Keep in-box nodes, then keep ways whose refs
  survive" therefore cannot miss a way. This answers item 5 favourably, for this writer.
- **Dilate by hundreds of metres, not kilometres.** 94.8–99.1% of ways touching the box are
  already *entirely* inside it with **zero** dilation; `+0.005°` (≈555 m) reaches
  99.3–99.9% for 19k–39k extra nodes. Ways whose refs were absent from the file: **0.00%**.
- **Divide the *clip box*, not the node extent.** `osmium extract` pulls in nodes referenced
  by ways crossing the boundary — measured up to **5,463 km** away in New York and 1,606 km
  in Malta. The raw node extent is 6.5–27.5× the clip box's area, so "1/16 of the file"
  sized from raw min/max is a box covering 99.98% of Malta's nodes. The `HeaderBlock` bbox is
  the honest footprint, and it is free: it is blob 0.

**The headline risk is not the crop. It is delivery.** The crop is a *memory* fix and not a
*bandwidth* fix: 100% of the file is still downloaded and 64–75% is still inflated,
whatever the box. On New York, every box from 1/4 down to 1/4096 of the state needed the
same 64.4% of the bytes read. §15.1 item 3 — "the driver picks an area, not a province" —
does **not** shrink the download, so §15.2 stays on the critical path and cannot be
deferred behind the crop.

And **area-bounded is not the same as city-sized**, which the roadmap had implied.
Measured slope on Bremen: `peak MiB = 36.4 + 229 × kept nodes`, r ≈ 0.999. Against a ~2 GB
budget that admits ~8 M nodes. On New York that is roughly an **86 km** box — not a city.
A 10.7 km box over Manhattan still keeps 1.42 M nodes ≈ 325 MiB, because density is what
it is:

| box | side | nodes kept | % of NY nodes | bytes read |
|---|---|---|---|---|
| 1/4 | 342 km | 30,559,914 | 53.8% | 64.4% |
| 1/16 | 171 km | 23,347,422 | 41.1% | 64.4% |
| 1/64 | 86 km | 14,877,099 | 26.2% | 64.4% |
| 1/256 | 43 km | 8,919,762 | 15.7% | 64.4% |
| 1/1024 | 21 km | 3,490,618 | 6.1% | 64.4% |
| 1/4096 | 10.7 km | 1,423,000 | 2.5% | 64.4% |

**And item 4 cannot be done by re-tuning a constant**, which is the finding that changed
this section's plan. `importguard` estimates nodes as `bytes / 8`. Measured file bytes per
node across the six files: **6.1** (iceland), 7.0 (andorra), 8.8 (NY), 11.3 (malta), 12.7
(bremen), **16.6** (monaco) — so 8 under-counts small extracts by up to 2×, in the
permissive direction. And `BYTES_PER_NODE = 112` against a measured **229 B per kept
node** is a 2.0× under-estimate, also permissive. Both are corrected below. But the deeper
problem stands: **once a crop exists, the surviving node count is not knowable before the
node phase has been read**, so a file-size-only estimate is structurally the wrong shape.
What the guard needs is an area × density estimate, and a count reported *during* the node
phase — which is why item 2 now builds that count rather than only a filtered dataset.

**One hypothesis of the investigation's was wrong, and is recorded because that is the
point of asking with permission to answer negatively.** The reader was suspected of being
100× out on coordinates again (§4.1), because `DenseNodes.granularity` is never read. It is
not: fields 17 and 19 are **absent from every one of the 1,323–8,026 DenseNodes blocks in
all six files**, the stored values are true nanodegrees, and `/1e7` is correct. Running the
shipped reader on real Andorra returns lat [42.32, 42.78]. Separately, the `HeaderBlock`
bbox in these files is in 1e-9 degrees — 100× the DenseNodes unit — which is irrelevant to
the reader because it skips it, and is why a naive "compare against the header" check fails.

**One comment corrected as a side effect:** `pbf.ts` describes a blob as "~8 MB in a
Geofabrik file". Measured maximum `datasize` across all six files is **1.03 MiB** and
maximum `raw_size` **2.24 MiB**, so the per-blob transient is ~3.5 MB. The ceiling it sits
under is 96 MiB, so nothing was at risk — but the figure was 8× high, and it is the kind of
number a reader uses to reason about a streaming window.

**2. The on-device bbox crop.** Add a bbox filter to `parseOsmPbfStream`: keep nodes
inside a dilated box, then keep ways whose refs survive. Peak memory becomes a function
of *area* rather than *province* — Calgary metro is a few million nodes against
Alberta's ~44 M. No new format and no writer: build the dataset straight from the
filtered stream. Roughly a hundred lines on the reader §14.17 left behind.

*Shape confirmed by §15.1.1, with three constraints the roadmap did not have: the filter is
per-node rather than per-blob, the box is the `HeaderBlock` bbox dilated by ~555 m, and the
reader must report the kept-node count as it goes so the guard can be checked against a
measurement instead of a size.*

**3. Make the crop reachable from the UI.** The driver picks an area, not a province.
A map-based picker, a "download the area I'm in" default, and recent areas. The memory
guard's refusal message should point here rather than at `osmium` once it exists.

**4. Then re-derive the guard's constants against measurement.** `PBF_BYTES_PER_NODE`
and `PARSE_BYTES_PER_NODE` are pinned guesses. After (1) and (2) there will be real
numbers, and the guard should use them. Until then it over-refuses, which is safe and
annoying.

**5. Only after all of that: consider whether the node map can be dropped entirely.**
`buildDataset` could consume ways and node coordinates together and never materialise
the map — but only if the format's ordering allows, which is what (1) determines.

**What this does not reach.** A driver who genuinely needs province-wide routing on a
phone will not get it from any of the above. That case wants MVT tiles plus a prebuilt
routing graph, streamed by viewport — the Organic Maps / Maps.me shape. It is a
different architecture, not a bigger version of this one, and it should not be started
until (1)–(4) are done and measured.

### 15.2 Make the delivery path work on device

Independent of 15.1 and blocked on nothing.

**6. Decide the download strategy, given the CORS wall.** §7 gap 4 measures it:
Geofabrik sends `Access-Control-Allow-Origin: null` on both the 307 and the 200, so
one-tap download from a WebView is impossible from any client-side change. Options, in
order of preference:

   - **`@capacitor/file-transfer`.** Downloads natively to a file on disk, with
     progress and abort, and does not go through the JS heap at all. This is the
     documented Capacitor answer for large transfers, and it sidesteps the streaming
     question entirely because the file never enters memory.
   - **`CapacitorHttp`.** Works, and STATUS.md already records why it is not the
     answer: it patches `window.fetch` **globally**, which would replace the streaming
     downloader §3.12 exists to make survivable with a whole-body bridge transfer.
   - **Keep manual import as the documented path**, and fix the copy so it is honest
     rather than apologetic.

   Whatever is chosen, the user's own server is not involved — the phone fetches from
   Geofabrik directly. **A Cloudflare Tunnel in front of the app is not in the data
   path** and its terms are not a constraint on any of this. Worth writing down,
   because it is a natural wrong assumption.

**7. Then revisit `importguard`'s refusal copy** so it names the option that exists on
the device rather than a desktop tool.

### 15.3 Verification: what has not been run, and the gate that should catch it

The standing constraint from §7 gaps 1 and 2, plus what this pass added.

**8. Every change in §15.1 and §15.2 verified in Chromium before it is called done.**
Specifically, and not as a substitute for unit tests:

   - a real `.osm.pbf` streaming through the built bundle (`E2E_FIXTURE=fixture.osm.pbf`
     already does this in CI);
   - the bbox crop against a **real multi-blob file**, not the fixture;
   - a memory reading, from `performance.memory` where available and `adb shell dumpsys
     meminfo` otherwise, at peak — reported as a number, not a verdict;
   - the guard's three outcomes through the actual UI, including the override button.

**9. Extend `test/e2e.mjs` to cover the guard.** It currently does not import anything the
guard would refuse, so the refusal path has no browser coverage at all. It should: pick a
file whose declared size trips the guard, assert the message, click the override, assert
the import proceeds.

**10. Add a memory gate.** `tools/` has gates for offline boot, focus, reflow and text
scale, all cheap. A gate that parses the fixture and asserts peak heap stays under a
budget would catch the next regression in this area that a unit test cannot see.

### 15.4 UI and UX polish

Grouped by what a driver would notice.

**Onboarding and first run (11–15).** 11. The app opens with no map and a launcher that
does not explain why; a first-run screen should say what an extract is and how to get
one. 12. Download progress needs a cancel that is honest about what is discarded.
13. The availability probe greys out dead catalogue entries — show *why* inline, not on
expand. 14. Region names collide across countries (`ca-on` vs a hypothetical other
`on`); disambiguate visibly. 15. After an import, say what was loaded in the driver's
own terms — "Calgary area · 412,000 roads · routes offline" — rather than a byte count.

**The navigation screen, which is the product (16–24).** 16. Off-route detection
tuning against real driving speeds. 17. Voice guidance interruption when the driver
also has the phone in conversation — a duck, not a mute. 18. Night mode that follows
the system without a setting to find. 19. Lane guidance for multi-lane exits, which
Android Auto shows and this app cannot yet. 20. The ETA bar's remaining-distance field
in the offline case, which §3.11.1 fixed once; re-check at real scale. 21. Search
results ranked by *drive time* rather than straight-line distance, which is the only
ranking that matches the decision being made. 22. Saved places with a Home/Work pair
already claimed in `App.tsx` but never exercised. 23. Fuel-range and charging stops,
which AAOS shows for EVs and which this app has no concept of. 24. A "what is this
screen" affordance, since the UI is a deliberate imitation and a driver who has not used
AAOS has no anchor for it.

**The regions screen (25–29).** 25. Storage breakdown per region, so deleting the right
one is obvious. 26. Region expiry — extracts are snapshots and the app does not say how
old one is. 27. Batch operations: download two adjacent provinces in one action.
28. A map preview of the imported area before routing is attempted. 29. Import from
a URL, for the self-hosted case where CORS is not in play.

**Accessibility and platform fit (30–34).** 30. Re-check every touch target against
the 76dp AAOS minimum now that screens have changed. 31. Screen-reader pass over the
navigation screen specifically, where the information is visual and spoken. 32.
Keyboard shortcuts for the debug simulator below, so it is usable without a touchscreen.
33. Automotive-mode detection, so the app does not offer gestures a head unit cannot do.
34. Handlebars: the app is `allowMixedContent` and unverified against a real head unit.

### 15.5 The drive simulator — a debug setting

Explicitly a **debug affordance**, off by default, and the single highest-value item here
for verifying guidance. §3.11 fixed offline turn-by-turn by inferring turns from bearing
changes, and §7 gap 6 records that inference missing three of seven real maneuvers,
inventing one and reversing one. **There is currently no way to check that quickly**:
every manoeuvre bug so far has been found by reading the built app in Chromium.

**35. A synthetic drive.** Replay a route as a moving vehicle: interpolate along the
route geometry at a chosen speed, feed the result through the *real* `watchPosition` →
`offroute` → `progress` → guidance path, and let the app's own logic produce every
number on screen. No production code path is stubbed, which is the point — a simulator
that bypasses the reroute policy would not find reroute bugs.

**36. Speed and pause controls**, plus a scrub bar, so a manoeuvre can be replayed at
0.25× without waiting.

**37. Deliberate fault injection**, because this is what finds bugs:
   - drive off the route by N metres, on demand;
   - drop the fix for 30 s (the frozen-position loop of §3.11.1);
   - jump to a waypoint mid-route;
   - reverse along the route;
   - teleport to a distant point.

**38. A guidance trace panel** that logs every maneuver as it is derived: bearing
change, distance, the icon chosen, the spoken text. This turns "the turn was wrong" from
an argument into a diff, and it is what §7 gap 6 has needed for four passes.

**39. Deterministic seed and replay.** A route plus a fault script should reproduce the
same run, so a bug found in a browser can become a fixture.

**40. Chromium coverage for all of it**, per §15.3's rule. The simulator is the answer to
"how do we verify directions without a car", and an unverified simulator is just another
thing to trust.

### 15.6 Process, for whoever picks this up

**41. Verify in Chromium, always.** `npm run e2e`, `npm run screens`, `npm run focus`,
`npm run textscale`, `npm run reflow`, `npm run status`. The emulator is not a phone
(§7 gap 1) and a green unit run does not mean a screen works — §3.19 exists because
every suite in this repo passes and the screen suite was visiting four screens.

**42. Use subagents, and here is what they are good for in this repo.** They have found
real defects here repeatedly, and the pattern that works is *giving a symptom, a
constraint, and permission to answer negatively*:

   - **Auditing** — "read the built app in Chromium and find things that are wrong."
     `explore` for code, `general` for browser work.
   - **Writing tests for a defect you already found** — give the subagent the defect and
     make it prove the test fails without the fix. A test that cannot fail is worse than
     no test, because it is counted (§3.5.2).
   - **Measuring** — line counts, test counts, per-file counts. Note the trap in §2:
     run spec files individually, because `attribution.spec.ts` imports
     `contrast.spec.ts`.
   - **Adversarial review of a measurement** — "here is the number, re-derive it." This
     project has found seven wrong counts and two wrong probes by exactly this.
   - **Investigating a question with a negative answer allowed** — e.g. "does Geofabrik
     publish Alberta sub-regions?" The answer was no, and that redirected the whole
     plan. A subagent asked to confirm something will find something if told to look.

   Not good for: deciding what to build next (there is no ground truth to check
   against), or anything requiring a decision about what the app should *be*.

**43. Re-derive every number before writing it.** `npm run status` catches the mechanical
shapes. It cannot read prose for truth, and §13.8's seven-clipped-labels figure would have
passed it.

**44. Record a defect's *absence* as carefully as its presence.** Half this section is
things that turned out not to be broken. The reasoning is what stops the next person
redoing the work.

---

## Attribution

Map data © OpenStreetMap contributors, [ODbL](https://www.openstreetmap.org/copyright).
Routing via [Valhalla](https://github.com/valhalla/valhalla) and geocoding via
[Nominatim](https://nominatim.org/), both OpenStreetMap projects. Base tiles from
[OpenFreeMap](https://openfreemap.org/). Design specifications from Google's
*Design for Driving* documentation.
