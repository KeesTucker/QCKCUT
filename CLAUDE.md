# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

QCKCUT is a browser-based highlight cutter: you drop long videos in, scrub them,
mark ranges as clips, and export a trimmed MP4. Sister project to QCKSCRL, which
does the same trick for photo carousels.

Everything runs client-side. Decoding, compositing and encoding all go through
the platform's hardware video pipeline via WebCodecs. Nothing is uploaded, and
there is no backend.

## Commands

Package manager is **pnpm** (pinned in `packageManager`).

```bash
pnpm install
pnpm dev              # Vite on http://localhost:5173
pnpm test             # the gate: 87 Playwright tests in real Chrome
pnpm build            # production bundle into dist/
pnpm preview          # serve that bundle
pnpm test:report      # open the HTML report
```

Single file or single test:

```bash
pnpm exec playwright test test/ui/clips.spec.mjs --project=ui
pnpm exec playwright test --project=ui -g "resize storm"
pnpm exec playwright test --project=ui test/ui/scrub.spec.mjs --debug
```

The browser is the locally installed Google Chrome (`channel: 'chrome'`), so
there is no browser download after `pnpm install`.

## Layout

```
index.html              Vite entry. Stays at the root; that is the convention.
vite.config.js
src/                    app.js, media.js, render.js, sequence.js, store.js, styles.css
test/
  fixture.mjs           encodes a synthetic clip in the browser
  mediabunny.mjs        re-export, see below
  fixtures.setup.mjs    the Playwright "setup" project
  lib/                  the app fixture and the clip definitions
  ui/                   specs
  media/                generated .mp4 fixtures, gitignored
```

`test/` rather than `tests/` is a coin flip in JS: Node core and the Mocha
lineage use `test/`, the Jest lineage uses `tests/` or `__tests__/`. Neither is
more correct. `src/` is close to universal.

## Vite

Vite serves `src/` and `test/` straight from source in dev, resolves the
`mediabunny` bare specifier, and bundles for production. Saving a file triggers a
full reload rather than true HMR, because `app.js` wires listeners at module
scope and has no `import.meta.hot` handlers. That is fine and deliberate: the
project is restored from IndexedDB on boot, so a reload puts your sources and
clips straight back.

Two things follow from Vite that are easy to trip over:

- **`page.evaluate` code is never transformed.** A bare `import('mediabunny')`
  inside an evaluate block has nothing to resolve it. Page-side test code goes
  through `/test/mediabunny.mjs`, a real module that re-exports the library so
  Vite rewrites the specifier.
- **Fixture media lives in `test/media/`, not a dot-directory.** Vite's static
  middleware is awkward about serving those.

## Architecture

### Five modules

- `store.js` — IndexedDB. Sources hold blobs, which localStorage cannot take.
- `media.js` — opening media, the decoder pool, filmstrip tile decoding.
- `sequence.js` — the timeline model. Pure and DOM-free, so it unit-tests cleanly.
- `render.js` — turning a range or a sequence into an MP4.
- `app.js` — state, rendering, and all DOM wiring.

`app.js` keeps QCKSCRL's shape: one mutable `S`, mutated and then followed by an
explicit `updateUI()` / `drawStrip()` / `renderClips()` call. There is no
reactive layer.

### A clip is a reference, never a copy

```js
S.sources = [{ id, name, blob, duration, width, height, codec, thumbs, thumbCount, poster }]
S.clips   = [{ id, sourceId, in, out, label }]
```

A clip is two numbers and a source id. That is the whole design: creating one
costs nothing, adjusting one edits two floats, and deleting one destroys no
media. It is also the exact shape a timeline clip will take when sequencing
lands, which will add only a `start` field for its position on the timeline.

`sourceOf(clip)` and `clipsFor(sourceId)` are the only ways to cross the
reference. Never denormalise source data onto a clip.

### The sequence stores order, not times

```js
S.timeline = [{ id, sourceId, in, out, label }]   // position IS the index
```

An item's start is the sum of the durations before it, computed by
`sequence.layout()` on demand. Nothing stores a start time. That removes gaps,
overlaps and the ripple pass after every trim: reordering is a splice, and
deleting closes the gap because there was never a gap to begin with.

`sequence.move(items, from, to)` takes `to` as an index into the array *before*
the move, which is what a drop position naturally gives you.

## Invariants that will bite you

These are not style preferences. Each one has already produced a bug with a
regression test named after it.

### Every VideoSample must be closed

A `VideoSample` wraps a GPU-resident `VideoFrame`. An unclosed one pins GPU
memory, and once the decoder's output queue fills it stalls silently. Every
`getSample` and every `for await (... of sink.samples())` body is wrapped in
`try/finally { sample.close() }`. Keep it that way.

### Every Input must be disposed

Each `Input` holds a hardware decoder, and the pool is finite. Opening one per
source and never closing them fails after roughly eight imports with a bare
`EncodingError: Decoding error` that names nothing.

`media.js` owns this. Sources are opened lazily through `acquire()`, and the
least recently touched **idle** entry is closed once `MAX_OPEN` (4) is exceeded.
Every `acquire()` needs a matching `release()`; use `using()` when the operation
is a single awaited call.

`using()` cannot wrap an async generator: it awaits its action, which for a
generator resolves before a single item is consumed, releasing the decoder while
it is still needed. `media.tiles()` acquires and releases by hand for that
reason.

### Filmstrips build one at a time

`evict()` will not close an in-use entry, so N parallel builds each holding a
decoder exhausts the pool with nothing evictable. `queueStrip()` serialises them
through a promise chain. Do not call `buildStrip()` directly from new code.

Each source also gets **its own** `AbortController` in `stripRuns`. A single
shared controller meant starting the second source's strip aborted the first,
leaving it with one tile out of twenty-three.

### Pixels never touch the CPU

Frames enter the GPU at decode and leave at encode. `sample.drawWithFit(ctx,…)`
keeps them there. One `getImageData`, `toBlob` or stray pixel read forces a
GPU→CPU sync and turns 60fps into single digits. The only `getImageData` in the
repo is in a test.

### Resize must never decode

Tiles are decoded once per source at a column count sized for
`window.screen.width`, then re-blitted by `drawStrip()` on resize with a
centre-crop per column. Calling `buildStrip()` from the resize handler spun up a
`CanvasSink` per event, exhausted the pool, flickered the strip, and took
playback down with it.

### Re-rendering must not detach a focused input

Detaching an element from the DOM blurs it, and `replaceChildren` detaches every
child even when you hand it back the same nodes. `renderClips()` therefore only
rebuilds when the list's *shape* changes (`shapeOf()`: the clip ids plus the
selected id); a pure value change goes through `syncClipRows()`, which updates
text in place. The editor node is likewise reused for as long as the same clip
stays selected, and `setField()` never overwrites a field that has focus.

Without all three, typing a time and pressing Enter could commit the old value,
because a background `updateUI()` had replaced the input in between.

### Mutate state before awaiting a write

`setClipRange()` applies the new range to `S` *before* `await store.putClip()`.
Persisting first leaves a window in which `clip.in` has changed but the timeline
selection has not, and that window is observable from outside.

The same shape of bug appears in tests: most UI actions start an async chain and
their intermediate states are visible. See "Async races in specs" below.

### Sequence export must not drift

`sink.samples(in, out)` also yields the frame that *spans* `out`. Letting its
full duration through pushes each item past its boundary, and the error
accumulates across every cut.

Worse, the audio mix is laid out on exact item boundaries while the picture is
frame-quantised, so clamping alone still lets the two drift apart by up to a
frame per cut. `render.js` therefore iterates frames by hand with one-frame
lookahead: a frame's duration is the gap to its successor, and an item's last
frame is held until exactly the cut.

Note that the *container* duration can still exceed the video by ~75ms when
audio is present: AAC pads to whole 1024-sample frames and adds encoder priming.
Assert on the video track's duration when you want an exact number.

### IndexedDB writes resolve on the transaction

`request.onsuccess` fires *before* the transaction commits. Resolving there and
then navigating away aborts the write, silently losing any edit made just before
a reload. `run()` in `store.js` resolves on `transaction.oncomplete`.

## How seeking works

`VideoSampleSink.getSample(t)` handles the keyframe hunt, forward decode, and
intra-GOP caching internally. This is the single biggest reason mediabunny earns
its place; hand-rolling it was estimated at most of a week.

Measured on a 60s 720p clip with a 2-second GOP: cold random seek 13.6ms average,
backwards frame-stepping 17.9ms average. Export runs at roughly 3x realtime.

Two distinct paths, and they are not interchangeable:

- **Scrubbing** uses `getSample`, coalesced so at most one decode is in flight
  and only the newest requested time survives. Without the coalescing a fast drag
  queues hundreds of decodes and the preview lags seconds behind the pointer.
- **Playback** iterates `sink.samples(from, to)` and paces to the wall clock.
  Iterating forward is far cheaper than seeking per frame because there is no
  repeated keyframe hunt.

## Test conventions

- Specs import `test` from `test/lib/app.mjs`, not from `@playwright/test`. The
  `app` fixture clears IndexedDB, reloads, and exposes `add()`, `drop()`,
  `state()`, `boxes()` and `rows()`. On teardown it asserts the page logged **no**
  errors, so a spec cannot pass while the console is on fire.
- `app.state()` reads `window.snapshot()` rather than poking at `S` directly, so
  specs do not couple to internal field layout.
- `app.stripReady()` waits for *every* source's strip, not just the active one.
  Waiting only on the active source is what let the shared-AbortController bug
  through.
- Test clips are encoded in the browser by the `setup` project into
  `test/media/` (gitignored). No ffmpeg, no binaries in the repo.
- **Fixtures use `keyFrameInterval: 2`.** An all-keyframe clip makes every
  seeking test pass for the wrong reason.
- `window.*` test hooks are assigned at the bottom of `app.js`. Add to that
  object when a spec needs a new entry point.

### Async races in specs

Most UI actions start an async chain, and intermediate states are observable.
`selectClip` assigns `activeId` inside `setActive` before it assigns the range,
so polling on `activeId` succeeds while `in`/`out` are still stale. Poll on the
last field the operation writes, or on the whole condition at once.

A test that passes alone and fails in the full run is usually this, not
infrastructure. Reproduce with `--repeat-each=4` before assuming flake, and read
the failure: twice now the "flaky" test was reporting a real ordering bug.

## Other gotchas

- `S.thumbs` holds **copies**. `CanvasSink` recycles its canvases through a pool,
  so a retained reference gets overwritten by a later frame.
- The preview canvas is the source's native pixel size, usually larger than the
  stage. It is `position: absolute` with `object-fit: contain` because a
  percentage `max-height` resolves against a content-sized track and is silently
  ignored, which let the canvas cover the timeline.
- Adding a keybinding means updating the help table in `index.html`;
  `test/ui/help.spec.mjs` asserts the two agree.
- Renaming an IndexedDB store needs a `VERSION` bump in `store.js` and a
  `deleteObjectStore` in the upgrade path. Currently at v2, which renamed `cuts`
  to `clips`.
- `store.clearAll()` clears the database, not the in-memory `S`. Reload after it.
- `row()` returns `{ el, name, meta }`, not an element, so callers can update the
  text nodes in place instead of rebuilding the row.

## Sequence playback and pre-roll

Playback walks the rows, holding one decoder at a time and firing `preroll()` at
the next item's source before the cut. Pre-roll acquires, decodes the first
keyframe, and releases immediately: the LRU keeps the entry open, so the acquire
at the cut is instant.

**Be honest about what pre-roll buys here.** On these fixtures (tens of kB,
2-second GOP) opening a source cold costs about 6ms, and the worst measured seam
was identical with pre-roll disabled. It is a bet on real footage, where parsing
a large moov and hunting a keyframe are far more expensive. The test therefore
asserts the *mechanism* (the next source is open well before the cut) rather
than a duration, because a duration assertion passes either way and proves
nothing.

Sequence export re-encodes rather than passing packets through, because items
come from different sources with different codecs, resolutions and rotations.
Every frame is drawn into one output-sized canvas. Output takes the **first
item's** dimensions; anything shaped differently is letterboxed.

## Not built yet

Audio preview. Export carries audio, and sequence export mixes it across items
(inserting silence for items that have none), but the in-app preview is
video-only. Also no music bed, no transitions, and no social export presets.
