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
pnpm test             # the gate: 257 Playwright tests in real Chrome
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
src/                    app.js, audio.js, media.js, render.js, sequence.js,
                        transitions.js, store.js, styles.css
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

### Seven modules

- `store.js` — IndexedDB. Sources hold blobs, which localStorage cannot take.
- `audio.js` — the AudioContext, playback scheduling, scrub grains, waveforms.
- `media.js` — opening media, the decoder pool, filmstrip tile decoding.
- `sequence.js` — the timeline model. Pure and DOM-free, so it unit-tests cleanly.
- `transitions.js` — what a transition looks like, also pure.
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

### Each project is its own database

`qckcut-<id>` per project, opened by `store.use(id)`. Switching closes one and
opens another, and deleting is `deleteDatabase`. The alternative, one database
with a `projectId` on every record, would put a filter in front of every read
for no benefit.

The project *list* is small scalar metadata, so it lives in localStorage
(`qckcut.projects`, `qckcut.active`). Blobs never go near it.

`forgetProject()` must clear the render caches (`clipsShape`, `trackShape`) and
`nextId` along with the state, or the new project renders against the old
project's cached shape.

Output settings (`{ width, height, fps }`, null meaning "match the source") live
in the project's own `settings` store, since they describe that project's
deliverable. `fps` makes sequence export a **resample**: it asks
`samplesAtTimestamps()` for the exact instants the output needs rather than
passing the source's timings through. Clip export gets the same treatment
through Conversion's `video` options.

### A source is video or audio

```js
{ id, name, blob, kind: 'video' | 'audio', duration, width, height, codec }
```

Audio-only sources are first class: they clip, they go on the sequence, they
export. What they do not have is pictures, so an audio source has **no
`entry.track` and no `entry.sink`**, and `width`/`height` are 0. Anything that
draws must check `media.isVideo(source)` first.

Consequences worth knowing:

- Its filmstrip is a waveform, not tiles. `buildStrip()` branches on kind.
- Its preview is a black placeholder with the file name.
- Playback has no frames to pace, so the playhead follows the clock directly.
- On the sequence it renders as black for its full duration. Skipping it would
  shorten the sequence and desync the audio mix.
- `sequenceShape()` finds the first item that *has* pictures, falling back to
  1280x720 for a sequence of nothing but sound.

`kind` is part of the stored record. It was not at first, and every restored
source came back looking like audio, so no filmstrip ever built.

### Lanes are parallel, and each is still index-packed

```js
S.timeline    = [...]                    // the video lane
S.audioTracks = [{ id, items: [...] }]   // parallel lanes, same item shape
```

Every lane packs its own items end to end from zero, so **position is still the
index** — no stored start times, no gaps, no overlaps, and rippling stays free.
`sequence.js` is unchanged and simply called once per lane.

`S.timeline` stays the video lane rather than becoming `tracks[0]`: it is
referenced at ~40 sites and across the specs, and renaming it would have been
churn for nothing.

The sequence is **as long as its longest lane** (`seqTotal()`), not the video
lane. Past the picture the render emits black so sound can play out over
nothing, and playback keeps the playhead moving over it. Anything that asks "is
there a sequence?" must use `seqTotal() > 0`, never `S.timeline.length`, or a
sound-only sequence cannot play or export.

Audio routes itself: an item whose source has no pictures goes to an audio lane
whatever lane it was aimed at, creating one if the project has none
(`laneFor()`). Dropping music on the picture lane put it *between* clips, which
is the bug lanes exist to fix.

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

### Filmstrips build one at a time, and only once

`queueStrip()` is **idempotent per source**. `setActive()` queues a build for a
source that has no strip yet, and both `addSource()` and `restore()` queue one
themselves straight after, so without the guard the strip filled left to right
and then immediately did it all again.

`stripsIdle()` counts queued builds as well as running ones, or a build that has
not started yet looks like no work at all.


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

### The audio clock is the master

Video used to be paced against `performance.now()`. That is fine for silent
media but drifts against sound: the audio hardware runs on its own crystal and
`AudioContext.currentTime` follows that, not the system timer. Once audio is
playing, `audio.audioClock(startAt)` becomes the timebase and frames are paced
against it. Silent media falls back to `audio.wallClock()`.

Both playback paths anchor `startAt` a beat (60ms) into the future, so the first
buffer is scheduled rather than already late.

Buffers are scheduled just in time, within a 0.75s lookahead, not all at once: a
long range would otherwise build thousands of nodes up front. Every scheduled
node is stopped when the run's `AbortController` fires, or sound outlives the
playback that started it.

### Mute is a preview control, not an edit

`S.muted` silences the preview only. Export still renders the music bed and all
item audio. A bed at zero *gain* is genuinely left out of the mix; a muted app
is not.

### Timestamps clamp into the item's own span

`sink.samples(in, out)` yields the frame *containing* `in`, which can start
before it, and the frame *spanning* `out`. Unclamped, the first gives a negative
timestamp on the opening item and the muxer refuses it outright
("timestamp must be a non-negative number"); the second runs each item past its
boundary. Both ends are clamped in `render.js` and in sequence playback.

Fixture in-points sat on frame boundaries, so only real footage hit the first
one. Off-boundary in-points are now in the suite.

### Export can be cancelled, and says what it is doing

`renderClip`/`renderSequence` take an `AbortSignal` and throw `render.Cancelled`,
which callers tell apart from a real failure. A started `Output` holds an
encoder, so a cancel has to `output.cancel()` rather than just stop looping.

Audio is mixed **before any picture is touched**, so on a long sequence that is
seconds with nothing on screen. Both phases report through one bar, the mix
taking its first quarter; a bar that restarts per phase reads as work being
redone. The first label is set before the first `await`.

While a render runs the header becomes the bar, the export button becomes
Cancel, and everything below is inert: an edit made halfway through would apply
to a project the render has already read past.

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
  `test/media/` (gitignored). No ffmpeg, no binaries in the repo. `bed.wav` is
  written by hand as PCM, so it needs no encoder extension.
- `app.stripReady()` waits on each source's `ready` flag, which is kind-aware:
  tiles decoded for video, peaks present for audio. Counting tiles would never
  succeed for a waveform.
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
- `setPointerCapture` throws if the pointer has already gone, so it is wrapped:
  an unguarded call took the whole drag down.
- The fixed rows (`.bar`, `.transport`, `.timeline`, `.sequence`) are `flex:
  none`. Without it they shrink and clip their own contents once the stack gets
  tall enough, rather than the preview giving up the space.
- **All three list panels cache their shape.** `renderSources()` also keys its
  rows by id and reuses the nodes, so importing appends a row rather than
  discarding the ones already there. Without it a poster arriving a moment after
  its import rebuilt the whole panel, which read as the list rendering twice.
- **The canvas holds its last frame forever.** Anything that changes what should
  be on screen has to repaint or wipe: `refreshPreview()` does that, and both
  switching project and deleting the last source used to leave a stale frame up.
- **Awaiting a seek means painted.** `seek()` and `seekSequence()` return the
  running drain rather than an immediate `undefined` when one is already in
  flight, or `await seek(x)` means "queued" and callers read a stale canvas.
- Only the area the viewer follows shows a playhead. Two white bars moving
  independently are two answers to "where am I".
- **A playback loop answers to its own run**, never to `S.playing` /
  `S.playingSeq`. Changing speed stops and restarts playback, and the new run
  sets the flag back to true before the old loop has noticed, so both painted at
  once at two different speeds. Each run holds an `AbortController` and checks
  `live()`; only the current run may write the final state.
- `updatePlayButton()` is the only thing that sets the play glyph. It is a
  toggle for whichever view is showing, so setting it from inside one playback
  path left sequence playback reading "play" the whole time it ran.
- `renderTrack()` rebuilds only when its contents change, for the same reason
  `renderClips()` does: a rebuild triggered by `pointerdown` detaches the element
  before its own `click` can land, so clicking a track item did nothing.
- `syncClipRows()` skips a label that is being renamed, or it overwrites the
  caret.
- The palette is shared with QCKSCRL (`--accent` #c084fc, `--accent2` #818cf8,
  `--grad` between them). Canvas code cannot read CSS custom properties, so
  `INK` in `app.js` mirrors it: keep the two in step.
- Tests measure canvas colour by **brightness, not channel**, so the palette can
  change without breaking them.
- Three dialogs share the `.help-overlay` / `.help-box` shell, so selectors in
  tests must be scoped by overlay id.
- The header carries the project, not the source: the badge over the picture
  already names what is showing, and repeating it was noise.
- The empty-sequence hint is hidden by `.sequence.has-items .empty`, not an
  adjacent-sibling rule: the playhead sits between the track and the hint, and
  the sibling match broke silently when it was added.

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

## One viewer, two things

`S.view` is `'source'` or `'sequence'`, and the badge in the preview's corner
says which. Touching the filmstrip makes it the source; touching the sequence
track makes it the sequence; the active area gets a `watching` outline. One play
button drives whichever is showing, so a press is never ambiguous.

The sequence is scrubbed from a **ruler strip above the items**, not the items
themselves: those are draggable for reordering, and the two gestures would
fight. Sequence time maps linearly onto the ruler because item widths are
already proportional to their durations.

One export button, and it follows the **sequence, not the view**: once anything
is on the sequence that is what export renders, whichever of the two you happen
to be watching. The sequence is the finished edit, so exporting a lone source
range from under one is almost never what was meant. Only an empty sequence
falls back to the marked range. The label says which.

Marking needs a source on screen, so `requireSource()` guards every route into
it and raises a toast otherwise. Cutting from the sequence would silently take
the range from whichever source happened to be selected, which is not what the
picture in front of you shows.

`seekSequence()` is **coalesced exactly like `seek()`**. `setView()` starts one
without awaiting it, so an overlapping call is easy to produce, and without
coalescing the two finish in whatever order their decodes complete and the
preview settles on a stale frame. The regression test compares the painted pixel
against the frame that point should show.

Speed (`S.rate`) applies to the preview only; export always renders at 1x. Both
clocks report elapsed *media* time already scaled by the rate, and callers
divide by it to get wall time when sleeping.

## Renaming

Double-click a name: source, clip, or sequence item. Chosen over a context menu
or a modal because there is no new surface to position, dismiss or keyboard-trap,
and a custom context menu has to fight the browser's own.

Renaming a clip does not touch a sequence item made from it, and vice versa:
each label is its own, because the same footage often wants a different name
where it sits.

The **range** is the opposite: an item made from a clip keeps that clip's id and
follows its trims, so the timeline shows the clip you have rather than the one
you had when you dragged it on. Items dragged straight from a source have no
`clipId` and are never touched, and deleting a clip costs its items nothing
because they hold their own range.

## Transitions

Every transition in `KINDS` works by **darkening the picture that is already
being drawn**, so it needs one decoder and no overlap. That is what lets
`transitions.dimAt()` drive the preview and the render from the same function:
they paint the same black over the same frame, so they cannot disagree.

A cross dissolve is deliberately absent. It needs two items decoded at the same
instant and it overlaps them, which shortens the sequence, so it is a change to
`layout()`, to the render loop and to playback rather than another entry in
`KINDS`.

Joints live in their own lane along the bottom of the track. They were first
drawn across its full height, which put them on top of the ruler (the scrub
surface) and on top of each item's remove button, since a cut lands exactly on
both.

## The bottom half resizes

Everything below the picture lives in `#tracks`, a fixed-height column the
splitter sets; the picture takes what is left. The height is kept in
localStorage rather than the project: it is how you like to work, not part of
the edit. The column scrolls, because lanes pile up faster than anyone drags.

Transition joints live **inside the sequence scrubber**. Over the clips they
landed on each item's remove button, since a cut is exactly where that button
sits; in a row of their own they cost height every lane wanted. They have no
click handler: the ruler underneath takes pointer capture, which retargets the
compatibility click away from them, so the ruler decides on `pointerup` whether
the press was a drag (scrub) or a tap (open the transition). For the same
reason the ruler must **not** `preventDefault()` on `pointerdown`.

## What Play plays

The marked range governs playback **only while the playhead is inside it**.
Outside it, playback runs from the playhead to the end of the source, and from
the very end it restarts at the in point.

Marking a clip leaves its range selected, which is right while you are working
on that clip. But the rule used to be "past the out point, jump back to in", so
scrubbing ahead and pressing play silently replayed the last clip and scrubbing
felt like it did nothing. Switching source and back appeared to fix it only
because `setActive()` resets the range.

## Marking a clip

`C` is a two-press flow: the first press drops an in point, the second closes
the clip, `Esc` cancels and puts the range back. Between the two the selection
follows the playhead, so you see the clip you are about to make.

`applyMark()` runs on **every seek of a drag**, so it deliberately calls
`updateRange()` / `updateMark()` / `drawStrip()` rather than `updateUI()`.
Rebuilding the side panels at scrub rate makes dragging crawl.

A mark belongs to the source it was started on, so `setActive()` clears it.

`I` and `O` still set the range by hand, and `addClip()` still makes a clip from
whatever the range currently is; `markClip()` is the shortcut layered on top.

## Sound

Playback plays the source's audio; dragging the filmstrip plays a short grain at
the playhead, rate-limited to one per 90ms so a fast drag is feedback rather
than a stutter. Grains are latest-wins.

The music bed is one audio file per project, set by dropping a file *or an
existing source* onto its waveform lane. Dropping audio anywhere else makes it a
source, since audio is now clippable in its own right. The bed plays under the
*sequence* only, never the source preview: the preview is for finding a moment
in one clip, and music there would only be in the way. Export mixes it in at its
gain, trimmed to the sequence length.

The bed's decoded `AudioBuffer` and its peaks cannot be stored, so both are
rebuilt from the blob on load. Peaks are computed once at `screen.width`
resolution and re-sampled when drawn, so resizing never re-scans the buffer.
They are normalised against the loudest peak, or a quiet track draws as a flat
line and tells you nothing.

**Tests need `--autoplay-policy=no-user-gesture-required`** (set in
`playwright.config.mjs`). Chrome keeps an AudioContext suspended until a real
user gesture, which a test run cannot reliably produce, and without the flag
every sound path is silently untestable.

## Not built yet

Playback speed multipliers. Video would be easy (the clock is already an
abstraction, so a rate is a division), and audio is easy too via
`AudioBufferSourceNode.playbackRate`, but that shifts pitch. Pitch-preserving
time-stretch needs a phase vocoder, which Web Audio does not provide.

Also: transitions, social export presets, and ducking music under speech. The
sequence is single-track, so items cannot overlap.
