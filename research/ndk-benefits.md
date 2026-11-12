# Where NDK beats what the app runs today

**Question.** For just the parts of the app that *benefit* from native (NDK)
code over what they run now (WASM, JS in a worker, WebView), what are the
benefits and drawbacks of moving each one — and how would the move work?

**Constraint.** Routing packs are never distributed from GitHub or any host:
packs must be built **on the device**. That makes on-device tile building the
point of this list rather than an option on it.

This note is deliberately simple; the measured numbers behind it are in
`valhalla-local-feasibility.md` (build cost, memory, the WASM-vs-native
routing benchmark).

Date: 2026-11-11.

---

## Where NDK actually helps

| Part | What it is now | Benefits of NDK | Drawbacks of NDK | How it would work |
|---|---|---|---|---|
| **1. Tile building**<br>(making Valhalla data from the map) | Doesn't exist on the phone at all — only a desktop tool | The **only** way to make packs on the device. No hosting, no downloads: "import a map, routing just works" | **~2–5 min per province** of build time; **~0.5–1 GB RAM spike** that can get the app killed mid-build; days of C++ toolchain setup; **separately built regions can't share border tiles**, so routing across two of them breaks | Compile Valhalla's `valhalla_build_tiles` with the NDK, run it on the imported `.osm.pbf` at import time (or in a background native process), save the `.tar` pack the app already uses |
| **2. Map parsing**<br>(.osm.pbf → road graph) | JavaScript in a web worker | **3–4× less memory** per road (≈30–50 B vs ≈120 B), so big provinces that today are **refused** (e.g. Alberta) would parse; also faster — the "Parsing / Building graph" wait shrinks | A C++ parser reading untrusted files: a bug can **crash the whole app** (JS bugs just show an error card) and is a security risk; the whole parse pipeline gets a second implementation to test and keep in sync | NDK library that streams the pbf and hands the finished graph to JS as one binary blob (so the slow crossing happens once, not per element) |
| **3. Map rendering** | MapLibre GL **JS** drawing inside the WebView | Smooth 60 fps map/puck animation, less battery/heat on long drives, no weird WebView graphics-driver glitches (this map has had "finally draws" problems before) | Not a small addition — it **replaces the entire map stack** with MapLibre Native; everything touching the map (styles, taps, chrome) needs rework and re-verification | Swap the map component for MapLibre **Native** through a Capacitor plugin; the app's UI stays as it is |
| **4. File storage**<br>(pack + tile reads) | IndexedDB / OPFS in the browser | Real files: no quota eviction, **packs survive restarts** (today's "pack vanished" failure), fast random reads into tiles | Almost none — this is existing native code behind the Capacitor Filesystem plugin, so it's a small job, not real NDK work | Move pack/tile storage to the native filesystem via the plugin; the tile cache code barely changes |

## Why the rest is not on the list

- **Routing itself:** WASM was **measured faster** than native (75 ms vs
  ~1.4–1.7× slower for a 739 km route). NDK would be a downgrade.
- **Turn-by-turn logic:** the fix for wrong turn timing is a better algorithm,
  and the one we have (Valhalla's map-matching) is already reachable through
  WASM.
- **Search:** fast already; nobody waits on it.

## The simple bottom line

- **#1 is the big one** now that tiles can't come from GitHub — everything
  else is optional.
- But #1's RAM spike is scary, so the safe play is: **#4 first** (easy, fixes
  the vanishing-pack bug), then **#1 in a separate native process** so a build
  failure can't take the app down, and **#2** only if province-sized maps
  should import at all.
- **#3** is a product decision, not an optimization — worth it only if the map
  still feels janky.
