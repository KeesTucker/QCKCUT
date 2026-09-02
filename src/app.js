import * as audio from './audio.js';
import * as media from './media.js';
import * as render from './render.js';
import * as sequence from './sequence.js';
import * as store from './store.js';

// ─── State ───────────────────────────────────────────────────────────────────
// One mutable object, mutated then followed by an explicit render call.
//
// A clip is a *reference* into a source, never a copy: { sourceId, in, out }.
// That is what makes clips free to create, adjust and delete after the fact, and
// it is the same shape a timeline clip will take when sequencing lands.

const S = {
  sources: [],      // { id, name, blob, duration, width, height, codec, thumbs, thumbCount, poster }
  clips: [],         // { id, sourceId, in, out, label }
  timeline: [],     // { id, sourceId, in, out, label } — order is the timing
  music: null,      // { name, blob, buffer, peaks, gain, duration }
  activeId: null,
  activeClipId: null,
  activeItemId: null,
  seqPlayhead: 0,
  playingSeq: false,
  marking: null,    // { at, wasIn, wasOut } while a clip is being marked
  playhead: 0,
  in: 0,
  out: 0,
  playing: false,
  exporting: false,
  muted: false,
  rate: 1,          // preview speed; never affects the export
  view: 'source',   // which of the two things the viewer is showing
};

const MIN_RANGE = 0.05;   // shortest selection we allow, seconds

const active = () => S.sources.find((s) => s.id === S.activeId) ?? null;
const sourceOf = (clip) => S.sources.find((s) => s.id === clip.sourceId) ?? null;
const clipsFor = (sourceId) => S.clips.filter((c) => c.sourceId === sourceId);
const sourceById = (id) => S.sources.find((s) => s.id === id) ?? null;
const sequenceRows = () => sequence.layout(S.timeline);

let nextId = 1;
const mintId = (prefix) => `${prefix}${nextId++}`;

// ─── DOM refs ────────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);
const stage = $('stage');
const preview = $('preview');
const pctx = preview.getContext('2d');
const drop = $('drop');
const timeline = $('timeline');
const strip = $('strip');
const sctx = strip.getContext('2d');
const selection = $('selection');
const handleIn = $('handleIn');
const handleOut = $('handleOut');
const playheadEl = $('playheadEl');
const markEl = $('markEl');
const playBtn = $('playBtn');
const exportBtn = $('exportBtn');
const markInBtn = $('markIn');
const markOutBtn = $('markOut');
const addClipBtn = $('addClip');
const addSourceBtn = $('addSource');
const sourceList = $('sourceList');
const clipList = $('clipList');
const track = $('track');
const seqDurationEl = $('seqDuration');
const muteBtn = $('muteBtn');
const rateSel = $('rateSel');
const viewBadge = $('viewBadge');
const viewKind = $('viewKind');
const viewName = $('viewName');
const sequenceEl = document.querySelector('.sequence');
const seqRuler = $('seqRuler');
const seqPlayheadEl = $('seqPlayheadEl');
const warnToast = $('warnToast');
const warnTitle = $('warnTitle');
const warnMsg = $('warnMsg');
const controls = $('controls');
const hintEl = $('hint');
const musicGainWrap = $('musicGainWrap');
const musicGain = $('musicGain');
const musicName = $('musicName');
const musicDrop = $('musicDrop');
const musicTrack = $('musicTrack');
const mctx = musicTrack.getContext('2d');
const fileNameEl = $('fileName');
const statusEl = $('status');
const timeEl = $('time');
const rangeEl = $('range');

// ─── Format helpers (pure) ───────────────────────────────────────────────────

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function timecode(seconds) {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(2).padStart(5, '0')}`;
}

/** Default label for the nth clip of a source: "clip.mp4 2". */
export function clipLabel(sourceName, index) {
  return `${sourceName.replace(/\.[^.]+$/, '')} ${index + 1}`;
}

/**
 * Parse a timecode back to seconds. Accepts "1:23.45", "83.45" or "5".
 * Returns null for anything it cannot read, so callers can revert the field.
 */
export function parseTimecode(text) {
  const trimmed = String(text ?? '').trim();
  const match = /^(?:(\d+):)?(\d+(?:\.\d+)?)$/.exec(trimmed);
  if (!match) return null;
  const seconds = Number(match[2]);
  if (match[1] && seconds >= 60) return null;   // 1:75 is a typo, not 2:15
  const total = (match[1] ? Number(match[1]) * 60 : 0) + seconds;
  return Number.isFinite(total) ? total : null;
}

/**
 * Name for an exported file. A clip exports under its own label; an untitled
 * range gets a suffix so it never collides with the source it came from.
 */
export function exportName(source, clip) {
  const base = clip?.label ?? `${source.name.replace(/\.[^.]+$/, '')}-clip`;
  return `${base.replace(/\s+/g, '-')}.mp4`;
}

// ─── Painting ────────────────────────────────────────────────────────────────
// A VideoSample wraps a GPU-resident VideoFrame. `draw` keeps it there; nothing
// in this file ever reads pixels back to the CPU.

let held = null;   // the acquired decoder entry for the active source

// Canvas has no access to CSS custom properties, so the palette is mirrored
// here. Keep these in step with :root in styles.css.
const INK = {
  ground: '#0a0a0a',
  lane: '#111',
  placeholder: '#6b6b76',
  accent: '192, 132, 252',    // --accent  #c084fc
  accent2: '129, 140, 248',   // --accent2 #818cf8
};

function paint(sample) {
  pctx.fillStyle = '#000';
  pctx.fillRect(0, 0, preview.width, preview.height);
  sample.drawWithFit(pctx, { fit: 'contain' });
}

/** What the preview shows for a source, or a sequence item, with no pictures. */
function paintSilence(label) {
  pctx.fillStyle = '#000';
  pctx.fillRect(0, 0, preview.width, preview.height);
  if (!label) return;
  pctx.fillStyle = INK.placeholder;
  pctx.font = `${Math.round(preview.height / 16)}px ui-monospace, Menlo, monospace`;
  pctx.textAlign = 'center';
  pctx.textBaseline = 'middle';
  pctx.fillText(label, preview.width / 2, preview.height / 2);
}

// ─── Scrubbing ───────────────────────────────────────────────────────────────
// Coalesced: at most one decode in flight, and only the newest requested time
// survives. Without this a fast drag queues hundreds of decodes and the preview
// lags seconds behind the pointer.

let pendingSeek = null;
let seeking = false;

export async function seek(time) {
  const source = active();
  if (!source || !held || !Number.isFinite(time)) return;
  S.playhead = clamp(time, 0, source.duration);
  updateTransport();
  if (S.marking) applyMark();
  if (!held.sink) {
    paintSilence(source.name);   // audio-only: there is no frame to fetch
    return;
  }
  pendingSeek = S.playhead;
  if (seeking) return;

  seeking = true;
  try {
    while (pendingSeek !== null) {
      const want = pendingSeek;
      pendingSeek = null;
      const sample = await held.sink.getSample(want);
      if (!sample) continue;
      try {
        paint(sample);
      } finally {
        sample.close();
      }
    }
  } finally {
    seeking = false;
  }
}

// ─── Playback ────────────────────────────────────────────────────────────────
// Sequential decode through the selection, paced to the wall clock. Iterating
// forward is far cheaper than seeking per frame, since there is no repeated
// keyframe hunt.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Aborting this stops any sound scheduled for the current playback.
let playRun = null;

export async function play() {
  if (S.playing || !held) return;
  S.playing = true;
  playBtn.dataset.state = 'playing';

  const from = S.playhead >= S.out - 0.02 ? S.in : S.playhead;
  const stopping = new AbortController();
  playRun = stopping;

  // Start the sound first, then take its clock. Video paced against
  // performance.now() drifts against the audio hardware's own timebase.
  const rate = S.rate;
  const sound = S.muted ? null : await media.audioOf(held);
  let elapsed = audio.wallClock(rate);
  if (sound) {
    const ctx = audio.unlock();
    const startAt = ctx.currentTime + 0.06;   // a beat to get the first buffer out
    elapsed = audio.audioClock(startAt, rate);
    audio.schedule({ sink: sound.sink, from, to: S.out, startAt, signal: stopping.signal, rate })
      .catch(fail);
  }

  if (!held.sink) {
    // Audio only: there are no frames to pace, so the playhead follows the
    // clock directly until the range ends or playback is stopped.
    try {
      paintSilence(active()?.name);
      while (S.playing) {
        const at = from + elapsed();
        S.playhead = Math.min(at, S.out);
        updateTransport();
        if (at >= S.out) break;
        await sleep(40);
      }
    } finally {
      stopping.abort();
      if (playRun === stopping) playRun = null;
      if (S.playing) { S.playhead = S.out; updateTransport(); }
      pause();
    }
    return;
  }

  let painted = false;
  try {
    for await (const sample of held.sink.samples(from, S.out)) {
      try {
        if (!S.playing) break;
        const due = sample.timestamp - from;
        // elapsed() is media time, so the gap converts to wall time by the rate.
        const wait = ((due - elapsed()) / rate) * 1000;
        // Drop a late frame rather than falling further behind, but never drop
        // the first one or the preview stays blank on a slow start.
        if (wait < -50 && painted) continue;
        if (wait > 0) await sleep(wait);
        if (!S.playing) break;
        paint(sample);
        painted = true;
        S.playhead = sample.timestamp;
        updateTransport();
      } finally {
        sample.close();
      }
    }
  } finally {
    stopping.abort();
    if (playRun === stopping) playRun = null;
    if (S.playing) {
      S.playhead = S.out;
      updateTransport();
    }
    pause();
  }
}

export function pause() {
  S.playing = false;
  playRun?.abort();
  playRun = null;
  audio.stopScrub();
  playBtn.dataset.state = 'paused';
}

// ─── Filmstrip ───────────────────────────────────────────────────────────────
// Decoded once per source, at a column count generous enough for the widest
// window this display can produce. Resizing re-blits from that cache instead of
// decoding again: a CanvasSink per resize event exhausts the decoder pool and
// takes playback down with it.

// One controller per source, not one globally: a shared controller meant
// starting the second source's strip aborted the first, leaving it with a
// single tile.
const stripRuns = new Map();

// Builds run one at a time. Each holds its source's decoder for the duration,
// and the pool cannot evict an entry that is in use, so building several at
// once would exhaust it exactly the way we are trying to avoid.
let stripQueue = Promise.resolve();

export function queueStrip(source) {
  stripQueue = stripQueue.then(() => buildStrip(source)).catch(fail);
  return stripQueue;
}

export async function buildStrip(source) {
  stripRuns.get(source.id)?.abort();
  const run = new AbortController();
  stripRuns.set(source.id, run);

  try {
    if (media.isVideo(source)) await buildTiles(source, run.signal);
    else await buildWaveform(source, run.signal);
  } finally {
    if (stripRuns.get(source.id) === run) stripRuns.delete(source.id);
  }
}

async function buildTiles(source, signal) {
  source.thumbCount = Math.max(1, Math.ceil((window.screen?.width ?? 1920) / media.tileWidth(source)));
  source.thumbs = [];
  if (source.id === S.activeId) drawStrip();

  for await (const tile of media.tiles(source, source.thumbCount, signal)) {
    if (signal.aborted) return;
    source.thumbs.push(tile);
    if (!source.poster && tile) {
      source.poster = tile;
      source.posterUrl = tile.toDataURL();
    }
    if (source.id === S.activeId) drawStrip();
    if (source.thumbs.length === 1) { renderSources(); renderTrack(); }
  }
}

// An audio source has no pictures, so its filmstrip is its waveform. Peaks are
// read straight from the decoder rather than by holding the whole file as one
// AudioBuffer.
async function buildWaveform(source, signal) {
  source.thumbCount = 1;   // "built" for the purposes of the strip being ready
  source.thumbs = [];
  await media.using(source, async (entry) => {
    const sound = await media.audioOf(entry);
    if (!sound) return;
    const count = Math.ceil(window.screen?.width ?? 1920);
    source.peaks = await audio.peaksFromSink(sound.sink, source.duration, count, signal);
    source.loudest = audio.loudest(source.peaks);
  });
  if (signal.aborted) return;
  source.thumbs = [null];
  if (source.id === S.activeId) drawStrip();
  renderSources();
  renderTrack();
}

/** True when no filmstrip is still decoding. For tests. */
export const stripsIdle = () => stripRuns.size === 0;

export function drawStrip() {
  const source = active();
  const cssW = timeline.clientWidth;
  if (!cssW) return;
  const dpr = window.devicePixelRatio || 1;
  strip.width = Math.round(cssW * dpr);
  strip.height = Math.round(media.THUMB_H * dpr);
  sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  sctx.fillStyle = INK.ground;
  sctx.fillRect(0, 0, cssW, media.THUMB_H);
  if (!source?.thumbCount) return;

  if (media.isVideo(source)) {
    const colW = cssW / source.thumbCount;
    for (let i = 0; i < source.thumbs.length; i++) {
      const tile = source.thumbs[i];
      if (!tile) continue;
      // Centre-crop into the column so a narrow window never squashes the frame.
      const sw = Math.min(tile.width, (colW / media.THUMB_H) * tile.height);
      sctx.drawImage(tile, (tile.width - sw) / 2, 0, sw, tile.height,
        i * colW, 0, colW + 0.5, media.THUMB_H);
    }
  } else {
    drawWaveform(sctx, source, cssW, media.THUMB_H);
  }
  drawClipMarks(cssW, source);
}

/** The whole of a source's audio, normalised, filling the given box. */
function drawWaveform(ctx, source, width, height) {
  if (!source.peaks) return;
  const middle = height / 2;
  const room = height - 10;
  ctx.fillStyle = `rgba(${INK.accent2}, .85)`;
  for (let x = 0; x < Math.floor(width); x++) {
    const at = Math.floor((x / width) * source.peaks.length);
    const peak = source.peaks[Math.min(at, source.peaks.length - 1)] / source.loudest;
    const h = Math.max(1, peak * room);
    ctx.fillRect(x, middle - h / 2, 1, h);
  }
}

// Every clip of this source shows as a band on its own filmstrip, so you can see
// what you have already taken without leaving the timeline.
function drawClipMarks(cssW, source) {
  sctx.fillStyle = `rgba(${INK.accent}, .30)`;
  sctx.strokeStyle = `rgba(${INK.accent}, .95)`;
  sctx.lineWidth = 1;
  for (const clip of clipsFor(source.id)) {
    const x = (clip.in / source.duration) * cssW;
    const w = ((clip.out - clip.in) / source.duration) * cssW;
    sctx.fillRect(x, media.THUMB_H - 8, w, 8);
    sctx.beginPath();
    sctx.moveTo(x + .5, 0);
    sctx.lineTo(x + .5, media.THUMB_H);
    sctx.stroke();
  }
}

// ─── Rendering the UI ────────────────────────────────────────────────────────

const xForTime = (t) => (t / (active()?.duration || 1)) * timeline.clientWidth;
const timeForX = (x) => (x / timeline.clientWidth) * (active()?.duration || 0);

function updateTransport() {
  if (S.view === 'sequence') {
    const total = sequence.totalDuration(S.timeline);
    timeEl.textContent = `${timecode(S.seqPlayhead)} / ${timecode(total)}`;
  } else {
    timeEl.textContent = `${timecode(S.playhead)} / ${timecode(active()?.duration ?? 0)}`;
  }
  playheadEl.style.left = `${xForTime(S.playhead)}px`;
}

/** Header line for a source. Audio has no dimensions worth advertising. */
const describe = (source) => media.isVideo(source)
  ? `${source.name} · ${source.width}×${source.height} · ${source.codec ?? '?'}`
  : `${source.name} · audio · ${source.codec ?? '?'}`;

function updateMark() {
  timeline.classList.toggle('marking', !!S.marking);
  if (S.marking) markEl.style.left = `${xForTime(S.marking.at)}px`;
}

function updateRange() {
  const left = xForTime(S.in);
  const right = xForTime(S.out);
  selection.style.left = `${left}px`;
  selection.style.width = `${Math.max(0, right - left)}px`;
  handleIn.style.left = `${left}px`;
  handleOut.style.left = `${right}px`;
  rangeEl.textContent = `in ${timecode(S.in)} · out ${timecode(S.out)} · ${timecode(S.out - S.in)}`;
}

function renderSources() {
  sourceList.replaceChildren(...S.sources.map((source) => {
    const entry = document.createElement('li');
    const { el } = row({
      active: source.id === S.activeId,
      name: source.name,
      meta: media.isVideo(source)
        ? `${timecode(source.duration)} · ${source.width}×${source.height}`
        : `${timecode(source.duration)} · audio`,
      onSelect: () => setActive(source.id).catch(fail),
      onDrop: () => removeSource(source.id).catch(fail),
      drag: { kind: 'source', id: source.id },
      rename: { read: () => source.name, write: (next) => renameSource(source.id, next) },
    });
    const poster = document.createElement('canvas');
    poster.width = 56;
    poster.height = 32;
    if (source.poster) {
      poster.getContext('2d').drawImage(source.poster, 0, 0, 56, 32);
    }
    el.prepend(poster);
    entry.append(el);
    return entry;
  }));
}

// Rebuilding the list detaches its nodes, and detaching a focused input blurs
// it. So the list is only rebuilt when its structure actually changes; a pure
// value change updates the existing rows in place.
let clipRows = new Map();
let clipsShape = null;

const shapeOf = () => `${S.clips.map((c) => c.id).join(',')}|${S.activeClipId}`;

function renderClips() {
  if (shapeOf() === clipsShape) return syncClipRows();
  clipsShape = shapeOf();
  clipRows = new Map();

  clipList.replaceChildren(...S.clips.map((clip) => {
    const source = sourceOf(clip);
    const selected = clip.id === S.activeClipId;
    const entry = document.createElement('li');
    const parts = row({
      active: selected,
      name: clip.label,
      meta: clipMeta(clip, source),
      onSelect: () => selectClip(clip.id).catch(fail),
      onDrop: () => removeClip(clip.id).catch(fail),
      drag: { kind: 'clip', id: clip.id },
      rename: { read: () => clip.label, write: (next) => renameClip(clip.id, next) },
    });
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    parts.el.prepend(swatch);
    entry.append(parts.el);
    if (selected) entry.append(clipEditor(clip, source));
    clipRows.set(clip.id, parts);
    return entry;
  }));
}

function syncClipRows() {
  for (const clip of S.clips) {
    const parts = clipRows.get(clip.id);
    if (!parts) continue;
    const source = sourceOf(clip);
    if (!parts.name.dataset.editing) parts.name.textContent = clip.label;
    parts.meta.textContent = clipMeta(clip, source);
    if (editor?.clipId === clip.id) syncEditor(clip, source);
  }
}

const clipMeta = (clip, source) =>
  `${timecode(clip.out - clip.in)} · ${source?.name ?? 'missing'}`;

// The editor node is reused for as long as the same clip stays selected.
// Rebuilding it on every updateUI() destroys whatever is being typed, and loses
// the value between entering it and the Enter that commits it.
let editor = null;   // { clipId, node, start, end, meta }

/** Start and end fields, shown under the selected clip. */
function clipEditor(clip, source) {
  if (editor?.clipId !== clip.id) editor = buildEditor(clip);
  syncEditor(clip, source);
  return editor.node;
}

function buildEditor(clip) {
  const node = document.createElement('div');
  node.className = 'editor';
  const start = field('Start', (value) => setClipRange(clip.id, value, null));
  const end = field('End', (value) => setClipRange(clip.id, null, value));
  const meta = document.createElement('div');
  meta.className = 'editor-meta';
  node.append(start.wrap, end.wrap, meta);
  return { clipId: clip.id, node, start, end, meta };
}

function syncEditor(clip, source) {
  setField(editor.start, clip.in);
  setField(editor.end, clip.out);
  editor.meta.textContent =
    `${timecode(clip.out - clip.in)} of ${source ? timecode(source.duration) : '?'}`;
}

// `committed` is what Escape and a failed parse revert to. Never overwrite a
// field while it has focus, or a background update eats the caret mid-edit.
function setField(target, seconds) {
  target.committed = timecode(seconds);
  if (document.activeElement !== target.input) target.input.value = target.committed;
}

function field(label, commit) {
  const wrap = document.createElement('label');
  wrap.className = 'field';
  const caption = document.createElement('span');
  caption.textContent = label;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'field-input';
  input.spellcheck = false;
  input.setAttribute('aria-label', label);
  wrap.append(caption, input);

  const target = { wrap, input, committed: '' };
  const revert = () => { input.value = target.committed; };

  // 'change' covers both blur and Enter.
  input.addEventListener('change', () => {
    const parsed = parseTimecode(input.value);
    if (parsed === null) return revert();
    commit(parsed).catch(fail);
  });
  input.addEventListener('keydown', (event) => {
    event.stopPropagation();       // app shortcuts must not fire while typing
    if (event.key === 'Enter') input.blur();
    else if (event.key === 'Escape') { revert(); input.blur(); }
  });

  return target;
}

/**
 * Set one or both ends of a clip. Pass null to leave an end alone. The range is
 * clamped into the source, so a typo cannot produce an inverted or out-of-range
 * clip.
 */
export async function setClipRange(id, start, end) {
  const clip = S.clips.find((c) => c.id === id);
  if (!clip) return null;
  const duration = sourceOf(clip)?.duration ?? 0;

  let nextIn = clamp(start ?? clip.in, 0, Math.max(0, duration - MIN_RANGE));
  let nextOut = clamp(end ?? clip.out, nextIn + MIN_RANGE, duration);
  nextIn = Math.min(nextIn, nextOut - MIN_RANGE);

  clip.in = nextIn;
  clip.out = nextOut;

  // Apply to state before awaiting the write. Persisting first leaves a window
  // where the clip and the timeline selection disagree, which is observable.
  const mirrored = S.activeClipId === clip.id && S.activeId === clip.sourceId;
  if (mirrored) {
    S.in = clip.in;
    S.out = clip.out;
    S.playhead = clamp(S.playhead, clip.in, clip.out);
  }
  updateUI();

  await store.putClip(clip);
  if (mirrored) await seek(S.playhead);
  return clip;
}

/**
 * Double-click a label to rename it in place.
 *
 * Chosen over a context menu or a modal: there is no new surface to position,
 * dismiss or keyboard-trap, the thing being renamed stays exactly where it is,
 * and it is the pattern people already know from file managers and layer lists.
 * A custom context menu also has to fight the browser's own.
 */
function renameable(label, read, write) {
  label.title = 'Double-click to rename';
  label.addEventListener('dblclick', (event) => {
    event.stopPropagation();
    if (label.dataset.editing) return;
    label.dataset.editing = '1';

    const input = document.createElement('input');
    input.className = 'rename';
    input.value = read();
    label.replaceChildren(input);
    input.focus();
    input.select();

    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      delete label.dataset.editing;
      const next = input.value.trim();
      if (save && next && next !== read()) {
        // Show the new name straight away rather than after the write.
        label.replaceChildren(document.createTextNode(next));
        write(next).catch(fail);
      } else {
        label.replaceChildren(document.createTextNode(read()));
      }
    };

    input.addEventListener('keydown', (e) => {
      e.stopPropagation();          // app shortcuts must not fire while typing
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    // Clicks inside the field must not reach the row behind it.
    for (const type of ['click', 'pointerdown', 'dblclick']) {
      input.addEventListener(type, (e) => e.stopPropagation());
    }
  });
}

function row({ active: isActive, name, meta, onSelect, onDrop, drag, rename }) {
  const item = document.createElement('div');
  item.className = `item${isActive ? ' active' : ''}`;
  item.tabIndex = 0;

  const text = document.createElement('div');
  text.className = 'item-text';
  const title = document.createElement('div');
  title.className = 'item-name';
  title.textContent = name;
  const sub = document.createElement('div');
  sub.className = 'item-meta';
  sub.textContent = meta;
  text.append(title, sub);

  const remove = document.createElement('button');
  remove.className = 'item-drop';
  remove.textContent = '×';
  remove.title = 'Remove';
  remove.addEventListener('click', (event) => {
    event.stopPropagation();
    onDrop();
  });

  if (rename) renameable(title, rename.read, rename.write);

  if (drag) {
    item.draggable = true;
    item.addEventListener('dragstart', (event) => {
      event.dataTransfer.setData(DRAG_TYPE, JSON.stringify(drag));
      event.dataTransfer.effectAllowed = 'copy';
    });
  }

  item.append(text, remove);
  item.addEventListener('click', onSelect);
  item.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect();
    }
  });
  return { el: item, name: title, meta: sub };
}

const setStatus = (text) => { statusEl.textContent = text; };
const setHint = (text) => { hintEl.textContent = text; };

function updateUI() {
  const source = active();
  const loaded = !!source;
  timeline.classList.toggle('empty', !loaded);
  drop.classList.toggle('hidden', S.sources.length > 0);
  controls.classList.toggle('hidden', !loaded && !S.timeline.length);
  for (const b of [markInBtn, markOutBtn, addClipBtn]) b.disabled = !loaded;

  const onSequence = S.view === 'sequence';
  playBtn.disabled = onSequence ? !S.timeline.length : !loaded;
  // Export renders whatever the viewer is showing, and says so.
  exportBtn.textContent = onSequence ? 'Export sequence' : 'Export clip';
  exportBtn.disabled = S.exporting || (onSequence ? !S.timeline.length : !loaded);
  fileNameEl.textContent = loaded ? describe(source) : 'no clip';
  renderSources();
  renderClips();
  renderTrack();
  renderMusic();
  updateRange();
  updateMark();
  updateView();
  updateTransport();
  updateSeqPlayhead();
  drawStrip();
}

// ─── Sources ─────────────────────────────────────────────────────────────────

export async function addSource(file) {
  setStatus(`reading ${file.name}…`);
  const source = { id: mintId('s'), name: file.name, blob: file, thumbs: [], thumbCount: 0, poster: null, posterUrl: null };
  Object.assign(source, await media.probe(source));
  S.sources.push(source);
  await store.putSource(source);
  await setActive(source.id);
  setStatus('');
  queueStrip(source);
  return source;
}

export async function setActive(id) {
  if (S.activeId === id) return;
  pause();
  // Hold the decoder for the source on screen so scrubbing never waits on an
  // open, and let the pool evict whatever falls out of use.
  if (held) media.release(S.activeId);
  held = null;
  S.marking = null;   // a mark belongs to the source it was started on
  S.activeId = id;

  const source = active();
  if (!source) {
    updateUI();
    return;
  }
  held = await media.acquire(source);
  if (media.isVideo(source)) {
    preview.width = source.width;
    preview.height = source.height;
  } else {
    // No pictures. A modest canvas is enough for the placeholder.
    preview.width = 640;
    preview.height = 360;
  }
  S.playhead = 0;
  S.in = 0;
  S.out = source.duration;
  S.activeClipId = null;
  updateUI();
  await seek(0);
  if (!source.thumbCount) queueStrip(source);
}

export async function removeSource(id) {
  // Clips and sequence items referencing this source go with it; nothing else
  // points at a source.
  for (const clip of clipsFor(id)) await store.dropClip(clip.id);
  S.clips = S.clips.filter((c) => c.sourceId !== id);
  if (S.timeline.some((item) => item.sourceId === id)) {
    S.timeline = S.timeline.filter((item) => item.sourceId !== id);
    S.seqPlayhead = 0;
    await store.putTimeline(S.timeline);
  }

  if (S.activeId === id) {
    if (held) media.release(id);
    held = null;
    S.activeId = null;
  }
  media.close(id);
  S.sources = S.sources.filter((s) => s.id !== id);
  await store.dropSource(id);

  if (!S.activeId && S.sources.length) await setActive(S.sources[0].id);
  else updateUI();
}

// ─── Clips ────────────────────────────────────────────────────────────────────
// A clip is only ever a reference. Creating one copies two numbers, so there is
// nothing to be careful about: adjust, re-adjust or delete freely.

// Marking a clip is two presses of C: the first drops an in point, the second
// closes the clip. Escape puts the range back the way it was. Between the two
// the selection follows the playhead, so you see the clip you are about to make
// rather than having to imagine it.

export function beginMark() {
  const source = active();
  if (!source) return null;
  clearWarning();
  S.marking = { at: S.playhead, wasIn: S.in, wasOut: S.out };
  applyMark();
  return S.marking;
}

export function cancelMark() {
  if (!S.marking) return false;
  S.in = S.marking.wasIn;
  S.out = S.marking.wasOut;
  S.marking = null;
  updateUI();
  return true;
}

/** Track the pending selection between the mark and the playhead. */
function applyMark() {
  if (!S.marking) return;
  S.in = Math.min(S.marking.at, S.playhead);
  S.out = Math.max(S.marking.at, S.playhead);
  // Deliberately not updateUI(): this runs on every seek of a drag, and
  // rebuilding the side panels each time would make scrubbing crawl.
  updateRange();
  updateMark();
  drawStrip();
}

/**
 * C, the one shortcut that does the whole job: start a mark, or finish it.
 * Returns the clip when one was made.
 */
export async function markClip() {
  if (!requireSource()) return null;
  const source = active();
  if (!S.marking) {
    beginMark();
    setHint('marking… C again to keep it, Esc to cancel');
    return null;
  }

  applyMark();
  const span = S.out - S.in;
  S.marking = null;
  if (span < MIN_RANGE) {
    setHint('too short to keep');
    updateUI();
    return null;
  }
  setHint('');
  return addClip();
}

export async function addClip() {
  const source = active();
  if (!source || S.out - S.in < MIN_RANGE) return null;
  clearWarning();
  const clip = {
    id: mintId('c'),
    sourceId: source.id,
    in: S.in,
    out: S.out,
    label: clipLabel(source.name, clipsFor(source.id).length),
  };
  S.clips.push(clip);
  await store.putClip(clip);
  S.activeClipId = clip.id;
  updateUI();
  return clip;
}

export async function selectClip(id) {
  const clip = S.clips.find((c) => c.id === id);
  if (!clip) return;
  await setActive(clip.sourceId);
  S.activeClipId = clip.id;
  S.in = clip.in;
  S.out = clip.out;
  S.playhead = clip.in;
  updateUI();
  await seek(clip.in);
}

export async function renameSource(id, name) {
  const source = sourceById(id);
  if (!source || !name) return null;
  source.name = name;
  await store.putSource(source);
  updateUI();
  return source;
}

export async function renameClip(id, label) {
  const clip = S.clips.find((c) => c.id === id);
  if (!clip || !label) return null;
  clip.label = label;
  await store.putClip(clip);
  updateUI();
  return clip;
}

export async function renameItem(id, label) {
  const item = S.timeline.find((i) => i.id === id);
  if (!item || !label) return null;
  item.label = label;
  await store.putTimeline(S.timeline);
  updateUI();
  return item;
}

export async function removeClip(id) {
  S.clips = S.clips.filter((c) => c.id !== id);
  if (S.activeClipId === id) S.activeClipId = null;
  await store.dropClip(id);
  updateUI();
}

// Adjusting in/out while a clip is selected edits that clip in place, which is
// what "resized and adjusted after the fact" means.
async function syncActiveClip() {
  const clip = S.clips.find((c) => c.id === S.activeClipId);
  if (!clip) return;
  clip.in = S.in;
  clip.out = S.out;
  await store.putClip(clip);
  renderClips();
}

// ─── Sequence ────────────────────────────────────────────────────────────────
// The track holds items in order; an item's position on the sequence clock is
// derived from the items before it, never stored. Reordering is a splice, and
// trimming or deleting ripples for free.

const DRAG_TYPE = 'application/x-qckcut';

// Aborting this stops any sound scheduled for the running sequence.
let seqRun = null;

// A sequence of nothing but audio still has to be *some* size, so fall back
// when no item has pictures.
const DEFAULT_SHAPE = { width: 1280, height: 720 };

/** The output size for a sequence: the first item that has pictures. */
export function sequenceShape(rows) {
  for (const row of rows) {
    const source = sourceById(row.item.sourceId);
    if (media.isVideo(source)) return { width: source.width, height: source.height };
  }
  return DEFAULT_SHAPE;
}

// Rebuilt only when its contents actually change. Replacing the children on
// every updateUI() detaches them, and a rebuild triggered by pointerdown
// destroys the element before its own click can land.
let trackShape = null;

const trackShapeOf = () => S.timeline
  .map((i) => `${i.id}:${(i.out - i.in).toFixed(3)}:${i.label}:${sourceById(i.sourceId)?.posterUrl ? 1 : 0}`)
  .join(',') + `|${S.activeItemId}`;

function renderTrack() {
  const rows = sequenceRows();
  const total = rows.length ? rows[rows.length - 1].end : 0;
  seqDurationEl.textContent = timecode(total);

  if (trackShapeOf() === trackShape) return;
  trackShape = trackShapeOf();

  track.replaceChildren(...rows.map((row) => {
    const source = sourceById(row.item.sourceId);
    const el = document.createElement('li');
    const kinds = [media.isVideo(source) ? '' : ' audio', row.item.id === S.activeItemId ? ' active' : ''];
    el.className = `track-item${kinds.join('')}`;
    el.dataset.id = row.item.id;
    el.dataset.index = String(row.index);
    // Width tracks duration so the track reads as a timeline, with a floor so
    // a very short item stays clickable.
    el.style.flex = `${Math.max(row.duration, 0.01)} 1 0`;
    el.draggable = true;
    if (source?.posterUrl) el.style.backgroundImage = `url(${source.posterUrl})`;

    const name = document.createElement('div');
    name.className = 'track-item-name';
    name.textContent = row.item.label;
    renameable(name, () => row.item.label, (next) => renameItem(row.item.id, next));
    const time = document.createElement('div');
    time.className = 'track-item-time';
    time.textContent = timecode(row.duration);

    const drop = document.createElement('button');
    drop.className = 'track-item-drop';
    drop.textContent = '\u00d7';
    drop.title = 'Remove from sequence';
    drop.addEventListener('click', (event) => {
      event.stopPropagation();
      removeFromSequence(row.item.id).catch(fail);
    });

    el.append(name, time, drop);
    el.addEventListener('click', () => selectItem(row.item.id).catch(fail));
    el.addEventListener('dragstart', (event) => {
      event.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ kind: 'item', index: row.index }));
      event.dataTransfer.effectAllowed = 'move';
      el.classList.add('dragging');
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      clearDropMarks();
    });
    return el;
  }));
}

/** Build a timeline item from a clip, or from a whole source. */
function itemFrom(kind, id) {
  if (kind === 'clip') {
    const clip = S.clips.find((c) => c.id === id);
    if (!clip) return null;
    return { id: mintId('t'), sourceId: clip.sourceId, in: clip.in, out: clip.out, label: clip.label };
  }
  const source = sourceById(id);
  if (!source) return null;
  return {
    id: mintId('t'),
    sourceId: source.id,
    in: 0,
    out: source.duration,
    label: source.name.replace(/\.[^.]+$/, ''),
  };
}

export async function addToSequence(kind, id, index = S.timeline.length) {
  const item = itemFrom(kind, id);
  if (!item) return null;
  S.timeline = sequence.insert(S.timeline, item, index);
  S.activeItemId = item.id;
  updateUI();
  await store.putTimeline(S.timeline);
  return item;
}

export async function removeFromSequence(id) {
  S.timeline = sequence.remove(S.timeline, id);
  if (S.activeItemId === id) S.activeItemId = null;
  S.seqPlayhead = 0;
  updateUI();
  await store.putTimeline(S.timeline);
}

export async function moveInSequence(from, to) {
  S.timeline = sequence.move(S.timeline, from, to);
  updateUI();
  await store.putTimeline(S.timeline);
}

/** Jump the preview to a sequence item's first frame. */
export async function selectItem(id) {
  const rows = sequenceRows();
  const row = rows.find((r) => r.item.id === id);
  if (!row) return;
  pause();
  stopSequence();
  S.activeItemId = id;
  S.seqPlayhead = row.start;
  S.view = 'sequence';   // clicking an item means you want to watch the sequence
  updateUI();
  await seekSequence(row.start);
}

// Drag and drop onto the track.

const dropPayload = (event) => {
  try {
    return JSON.parse(event.dataTransfer.getData(DRAG_TYPE));
  } catch {
    return null;
  }
};

function clearDropMarks() {
  track.classList.remove('over');
  for (const el of track.children) el.classList.remove('drop-before', 'drop-after');
}

/** Which insertion slot the pointer is over, 0..length. */
function slotFor(event) {
  const bounds = [...track.children].map((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right };
  });
  return sequence.slotAt(bounds, event.clientX);
}

function markSlot(slot) {
  const children = [...track.children];
  for (const el of children) el.classList.remove('drop-before', 'drop-after');
  if (!children.length) return;
  if (slot >= children.length) children[children.length - 1].classList.add('drop-after');
  else children[slot].classList.add('drop-before');
}

for (const type of ['dragenter', 'dragover']) {
  track.addEventListener(type, (event) => {
    if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
    event.preventDefault();
    event.stopPropagation();
    track.classList.add('over');
    markSlot(slotFor(event));
  });
}

track.addEventListener('dragleave', (event) => {
  if (!track.contains(event.relatedTarget)) clearDropMarks();
});

track.addEventListener('pointerdown', () => setView('sequence'));

/** A grain of whatever is under the sequence playhead, for scrub feedback. */
async function scrubSequenceAudio(time) {
  if (S.muted) return;
  const at = performance.now();
  if (at - lastGrain < GRAIN_GAP) return;
  lastGrain = at;

  const row = sequence.at(sequenceRows(), time);
  const source = row && sourceById(row.item.sourceId);
  if (!source) return;
  await media.using(source, async (entry) => {
    const sound = await media.audioOf(entry);
    if (sound) await audio.scrub(sound.sink, sequence.sourceTime(row, time));
  });
}

function scrubSequence(event) {
  if (!S.timeline.length) return;
  const time = seqTimeForX(event.clientX);
  seekSequence(time).catch(fail);
  scrubSequenceAudio(time).catch(fail);
}

seqRuler.addEventListener('pointerdown', (event) => {
  if (!S.timeline.length) return;
  event.preventDefault();
  setView('sequence');
  stopSequence();
  capture(seqRuler, event.pointerId);
  scrubSequence(event);
});

seqRuler.addEventListener('pointermove', (event) => {
  if (seqRuler.hasPointerCapture(event.pointerId)) scrubSequence(event);
});

seqRuler.addEventListener('pointerup', () => audio.stopScrub());

track.addEventListener('drop', (event) => {
  if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
  event.preventDefault();
  event.stopPropagation();
  const slot = slotFor(event);
  const payload = dropPayload(event);
  clearDropMarks();
  if (!payload) return;
  if (payload.kind === 'item') moveInSequence(payload.index, slot).catch(fail);
  else addToSequence(payload.kind, payload.id, slot).catch(fail);
});

// Playback across the whole sequence.

/**
 * Open the next item's decoder while the current one plays, then hand it
 * straight back. The LRU keeps it open, so the acquire at the cut is instant
 * and its first keyframe is already decoded. Without this every cut stalls for
 * the length of a keyframe hunt.
 */
function preroll(row) {
  const source = row && sourceById(row.item.sourceId);
  if (!source) return;
  media.using(source, async ({ sink }) => {
    const sample = await sink.getSample(row.item.in);
    sample?.close();
  }).catch(() => {});
}

export async function playSequence() {
  if (S.playingSeq || !S.timeline.length) return;
  pause();
  S.playingSeq = true;

  const rows = sequenceRows();
  const total = rows[rows.length - 1].end;
  if (S.seqPlayhead >= total - 0.02) S.seqPlayhead = 0;

  // The preview takes the sequence's own dimensions; items shaped differently
  // are letterboxed into it, matching what export produces.
  const shape = sequenceShape(rows);
  preview.width = shape.width;
  preview.height = shape.height;

  const origin = S.seqPlayhead;
  const stopping = new AbortController();
  seqRun = stopping;

  // One clock for the whole sequence, anchored before the first frame. Each
  // item's audio is scheduled onto it at that item's own offset, so sound stays
  // continuous across the cuts even though the decoders change.
  const rate = S.rate;
  const ctx = audio.unlock();
  const startAt = ctx.currentTime + 0.06;
  const elapsed = S.muted ? audio.wallClock(rate) : audio.audioClock(startAt, rate);
  if (!S.muted) startMusic(startAt, origin, total - origin, rate);

  let painted = false;
  try {
    for (const [i, row] of rows.entries()) {
      if (!S.playingSeq) break;
      if (row.end <= origin) continue;
      const source = sourceById(row.item.sourceId);
      if (!source) continue;

      const entry = await media.acquire(source);
      preroll(rows[i + 1]);
      const from = sequence.sourceTime(row, Math.max(origin, row.start));

      if (!S.muted) {
        const sound = await media.audioOf(entry);
        if (sound) {
          audio.schedule({
            sink: sound.sink,
            from,
            to: row.item.out,
            startAt: startAt + (Math.max(origin, row.start) - origin) / rate,
            signal: stopping.signal,
            rate,
          }).catch(fail);
        }
      }

      try {
        if (!entry.sink) {
          // Audio item: black picture, and the playhead follows the clock.
          paintSilence(row.item.label);
          painted = true;
          while (S.playingSeq) {
            const at = origin + elapsed();
            S.seqPlayhead = Math.min(at, row.end);
            updateTransport();
            updateSeqPlayhead();
            if (at >= row.end) break;
            await sleep(40);
          }
          continue;
        }

        for await (const sample of entry.sink.samples(from, row.item.out)) {
          try {
            if (!S.playingSeq) break;
            const at = row.start + (sample.timestamp - row.item.in);
            const wait = ((at - origin - elapsed()) / rate) * 1000;
            if (wait < -50 && painted) continue;
            if (wait > 0) await sleep(wait);
            if (!S.playingSeq) break;
            paint(sample);
            painted = true;
            S.seqPlayhead = at;
            updateTransport();
            updateSeqPlayhead();
          } finally {
            sample.close();
          }
        }
      } finally {
        media.release(source.id);
      }
    }
  } finally {
    stopping.abort();
    if (seqRun === stopping) seqRun = null;
    if (S.playingSeq) S.seqPlayhead = total;
    stopSequence();
  }
}

export function stopSequence() {
  S.playingSeq = false;
  seqRun?.abort();
  seqRun = null;
  stopMusic();
  renderTrack();
}

export async function exportSequence() {
  if (S.exporting || !S.timeline.length) return null;
  S.exporting = true;
  stopSequence();
  pause();
  exportBtn.disabled = true;

  try {
    const rows = sequenceRows();
    const started = performance.now();
    const blob = await render.renderSequence(rows, (item) => sourceById(item.sourceId),
      (p) => setStatus(`rendering sequence ${Math.round(p * 100)}%`), S.music,
      sequenceShape(rows));
    const took = (performance.now() - started) / 1000;
    render.download(blob, 'sequence.mp4');
    const total = rows[rows.length - 1].end;
    setStatus(`rendered ${(blob.size / 1e6).toFixed(1)} MB in ${took.toFixed(1)}s (${(total / took).toFixed(1)}\u00d7)`);
    return blob;
  } finally {
    S.exporting = false;
    updateUI();
  }
}


// ─── Music bed ───────────────────────────────────────────────────────────────
// One bed per project. It plays under the sequence only, not the source
// preview: the preview is for finding a moment in one clip, and music there
// would just be in the way.

export async function setMusic(file, gain = 0.35, name = file.name ?? 'music') {
  const buffer = await audio.decode(file);
  S.music = {
    name,
    blob: file,
    buffer,
    duration: buffer.duration,
    gain,
    peaks: null,
    loudest: 1,
  };
  await store.putMusic(S.music);
  updateUI();
  return S.music;
}

export async function removeMusic() {
  stopMusic();
  S.music = null;
  await store.dropMusic();
  updateUI();
}

export async function setMusicGain(gain) {
  if (!S.music) return;
  S.music.gain = clamp(gain, 0, 1);
  if (musicNode) musicNode.level.gain.value = S.music.gain;
  await store.putMusic(S.music);
  renderMusic();
}

function renderMusic() {
  const music = S.music;
  musicGainWrap.hidden = !music;
  musicTrack.hidden = !music;
  if (!music) return;

  musicName.textContent = music.name;
  if (musicGain.value !== String(music.gain)) musicGain.value = String(music.gain);

  const cssW = musicTrack.clientWidth;
  if (!cssW) return;
  const dpr = window.devicePixelRatio || 1;
  const height = 30;
  musicTrack.width = Math.round(cssW * dpr);
  musicTrack.height = Math.round(height * dpr);
  mctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  mctx.fillStyle = INK.lane;
  mctx.fillRect(0, 0, cssW, height);

  // Peaks are computed once for the widest window this display can produce,
  // then re-sampled on redraw, so resizing never re-scans the buffer.
  if (!music.peaks) {
    music.peaks = audio.peaks(music.buffer, Math.ceil(window.screen?.width ?? 1920));
    // Normalised, or a quiet track draws as a flat line and tells you nothing
    // about its shape.
    music.loudest = music.peaks.reduce((a, b) => (b > a ? b : a), 0) || 1;
  }

  const total = sequence.totalDuration(S.timeline);
  const span = total > 0 ? total : music.duration;
  // The bed is cut at the end of the sequence, so only the part that will be
  // heard is drawn, stretched across the lane.
  const heard = Math.min(1, span / music.duration);
  const columns = Math.floor(cssW);
  const middle = height / 2;
  const room = height - 6;

  for (let x = 0; x < columns; x++) {
    const at = Math.floor((x / columns) * heard * music.peaks.length);
    const peak = music.peaks[Math.min(at, music.peaks.length - 1)] / music.loudest;
    // The faint bar is the track itself; the solid one is what you will hear at
    // the current level.
    const full = Math.max(1, peak * room);
    const level = Math.max(1, peak * music.gain * room);
    mctx.fillStyle = `rgba(${INK.accent}, .22)`;
    mctx.fillRect(x, middle - full / 2, 1, full);
    mctx.fillStyle = `rgba(${INK.accent}, .9)`;
    mctx.fillRect(x, middle - level / 2, 1, level);
  }
}

// Playback of the bed is one buffer source, started at an offset into the
// sequence and stopped when playback stops.
let musicNode = null;

function startMusic(startAt, offset, duration, rate = 1) {
  stopMusic();
  const music = S.music;
  if (!music || S.muted || music.gain <= 0) return;
  if (offset >= music.buffer.duration) return;

  const ctx = audio.unlock();
  const node = ctx.createBufferSource();
  const level = ctx.createGain();
  level.gain.value = music.gain;
  node.buffer = music.buffer;
  // The bed is tied to sequence time, so it has to follow the rate too, or it
  // slides away from the picture.
  node.playbackRate.value = rate;
  node.connect(level).connect(ctx.destination);
  node.start(Math.max(startAt, ctx.currentTime), offset,
    Math.min(music.buffer.duration - offset, duration));
  musicNode = { node, level };
}

function stopMusic() {
  if (!musicNode) return;
  try { musicNode.node.stop(); } catch {}
  musicNode = null;
}

musicGain.addEventListener('input', () => setMusicGain(Number(musicGain.value)).catch(fail));
musicDrop.addEventListener('click', () => removeMusic().catch(fail));

/** Use an existing source as the bed, without importing the file twice. */
export async function setMusicFromSource(id) {
  const source = sourceById(id);
  if (!source) return null;
  return setMusic(source.blob, S.music?.gain ?? 0.35, source.name);
}

for (const type of ['dragenter', 'dragover']) {
  musicTrack.addEventListener(type, (event) => {
    const types = event.dataTransfer?.types ?? [];
    if (!types.includes(DRAG_TYPE) && !types.includes('Files')) return;
    event.preventDefault();
    event.stopPropagation();
    musicTrack.classList.add('over');
  });
}

musicTrack.addEventListener('dragleave', () => musicTrack.classList.remove('over'));

musicTrack.addEventListener('drop', (event) => {
  const types = event.dataTransfer?.types ?? [];
  const ours = types.includes(DRAG_TYPE);
  if (!ours && !types.includes('Files')) return;
  event.preventDefault();
  event.stopPropagation();
  musicTrack.classList.remove('over');

  if (ours) {
    const payload = dropPayload(event);
    if (payload?.kind === 'source') setMusicFromSource(payload.id).catch(fail);
    return;
  }
  const file = [...(event.dataTransfer.files ?? [])][0];
  if (file) setMusic(file).catch(fail);
});

// ─── Sound toggle ────────────────────────────────────────────────────────────

export function setMuted(muted) {
  S.muted = muted;
  if (muted) {
    audio.stopScrub();
    stopMusic();
  }
  muteBtn.dataset.state = muted ? 'off' : 'on';
  muteBtn.setAttribute('aria-label', muted ? 'Unmute' : 'Mute');
}

/** Preview speed. Export always renders at 1x. */
export function setRate(rate) {
  S.rate = clamp(Number(rate) || 1, 0.25, 4);
  if (rateSel.value !== String(S.rate)) rateSel.value = String(S.rate);
  // A rate change mid-playback would need every scheduled buffer rescheduled,
  // so restart instead: far simpler, and imperceptible at these lengths.
  if (S.playing) { pause(); play().catch(fail); }
  else if (S.playingSeq) { stopSequence(); playSequence().catch(fail); }
}

rateSel.addEventListener('change', () => setRate(rateSel.value));

muteBtn.addEventListener('click', () => setMuted(!S.muted));

// Capturing can throw if the pointer has already gone (a cancelled gesture, or
// a synthetic event), and that must not take the drag down with it.
const capture = (el, pointerId) => {
  try {
    el.setPointerCapture(pointerId);
  } catch {
    /* the drag still works, it just stops tracking outside the element */
  }
};

// ─── Timeline interaction ────────────────────────────────────────────────────
// The whole strip is one scrub surface. Handles capture the pointer first, so
// dragging a handle trims instead of scrubbing.

function dragTime(event) {
  const rect = timeline.getBoundingClientRect();
  return clamp(timeForX(event.clientX - rect.left), 0, active()?.duration ?? 0);
}

// Scrub audio: a short grain at the playhead, latest wins, and only while the
// pointer is actually dragging. Firing it on every seek would also fire on
// arrow keys and on programmatic seeks, which is noise rather than feedback.
let lastGrain = 0;
const GRAIN_GAP = 90;   // ms between grains, so a fast drag does not stutter

async function scrubAudio(time) {
  if (S.muted || !held) return;
  const at = performance.now();
  if (at - lastGrain < GRAIN_GAP) return;
  lastGrain = at;
  const sound = await media.audioOf(held);
  if (sound) await audio.scrub(sound.sink, time);
}

timeline.addEventListener('pointerdown', (event) => {
  if (!held) return;
  setView('source');
  pause();
  capture(timeline, event.pointerId);
  const t = dragTime(event);
  seek(t).catch(fail);
  scrubAudio(t).catch(fail);
});

timeline.addEventListener('pointermove', (event) => {
  if (!timeline.hasPointerCapture(event.pointerId)) return;
  const t = dragTime(event);
  seek(t).catch(fail);
  scrubAudio(t).catch(fail);
});

timeline.addEventListener('pointerup', () => audio.stopScrub());

function bindHandle(el, which) {
  el.addEventListener('pointerdown', (event) => {
    if (!held) return;
    event.stopPropagation();
    pause();
    capture(el, event.pointerId);
  });
  el.addEventListener('pointermove', (event) => {
    if (!el.hasPointerCapture(event.pointerId)) return;
    const t = dragTime(event);
    const duration = active().duration;
    if (which === 'in') S.in = clamp(t, 0, S.out - MIN_RANGE);
    else S.out = clamp(t, S.in + MIN_RANGE, duration);
    updateRange();
    drawStrip();
    seek(t).catch(fail);
  });
  el.addEventListener('pointerup', () => syncActiveClip().catch(fail));
}

bindHandle(handleIn, 'in');
bindHandle(handleOut, 'out');

playBtn.addEventListener('click', () => togglePlay());

markInBtn.addEventListener('click', () => {
  if (!requireSource()) return;
  S.in = clamp(S.playhead, 0, S.out - MIN_RANGE);
  updateRange();
  drawStrip();
  syncActiveClip().catch(fail);
});

markOutBtn.addEventListener('click', () => {
  if (!requireSource()) return;
  S.out = clamp(S.playhead, S.in + MIN_RANGE, active()?.duration ?? 0);
  updateRange();
  drawStrip();
  syncActiveClip().catch(fail);
});

addClipBtn.addEventListener('click', () => markClip().catch(fail));
addSourceBtn.addEventListener('click', () => pickFiles());

document.addEventListener('keydown', (event) => {
  if (event.target.tagName === 'INPUT') return;
  if (event.key === '?') { event.preventDefault(); return openHelp(); }
  if (event.key === 'm') return setMuted(!S.muted);
  if (event.key === 'Escape') {
    if (helpOpen()) return closeHelp();
    if (cancelMark()) return setHint('');
  }
  if (!held || helpOpen()) return;
  const frame = 1 / 30;
  if (event.code === 'Space') { event.preventDefault(); togglePlay(); }
  else if (event.code === 'ArrowLeft') { pause(); seek(S.playhead - (event.shiftKey ? 1 : frame)).catch(fail); }
  else if (event.code === 'ArrowRight') { pause(); seek(S.playhead + (event.shiftKey ? 1 : frame)).catch(fail); }
  else if (event.key === 'i') markInBtn.click();
  else if (event.key === 'o') markOutBtn.click();
  else if (event.key === 'c') markClip().catch(fail);
  else if (event.key === 't') appendRange().catch(fail);
});

// ─── Export ──────────────────────────────────────────────────────────────────
// Conversion re-encodes through the platform's hardware encoder and keeps the
// audio track. A fresh Input is used so export never disturbs the pool.

export async function exportRange() {
  const source = active();
  if (S.exporting || !source) return null;
  S.exporting = true;
  pause();
  stopSequence();
  exportBtn.disabled = true;

  try {
    const started = performance.now();
    const blob = await render.renderClip(source, S.in, S.out,
      (p) => setStatus(`exporting ${Math.round(p * 100)}%`));
    const took = (performance.now() - started) / 1000;
    render.download(blob, exportName(source, S.clips.find((c) => c.id === S.activeClipId)));
    setStatus(`exported ${(blob.size / 1e6).toFixed(1)} MB in ${took.toFixed(1)}s (${((S.out - S.in) / took).toFixed(1)}\u00d7)`);
    return blob;
  } finally {
    S.exporting = false;
    updateUI();
  }
}

exportBtn.addEventListener('click', () => exportShowing().catch(fail));

/** Append the current in/out of the active source straight to the sequence. */
export async function appendRange() {
  const source = active();
  if (!source || S.out - S.in < MIN_RANGE) return null;
  const item = {
    id: mintId('t'),
    sourceId: source.id,
    in: S.in,
    out: S.out,
    label: clipLabel(source.name, S.timeline.filter((i) => i.sourceId === source.id).length),
  };
  S.timeline = sequence.insert(S.timeline, item, S.timeline.length);
  S.activeItemId = item.id;
  updateUI();
  await store.putTimeline(S.timeline);
  return item;
}

// ─── Which thing the viewer follows ──────────────────────────────────────────
// There is one viewer and two things it can show. Touching the filmstrip makes
// it the source; touching the sequence track makes it the sequence. The play
// button drives whichever is showing, so there is never a question of what a
// press will start.

export function setView(view) {
  if (S.view === view) return;
  pause();
  stopSequence();
  S.view = view;
  if (view === 'source') clearWarning();
  updateUI();
  if (view === 'sequence') seekSequence(S.seqPlayhead).catch(fail);
  else seek(S.playhead).catch(fail);
}

function updateView() {
  const source = active();
  const showing = S.view === 'sequence';
  viewBadge.classList.toggle('hidden', !source && !S.timeline.length);
  viewKind.textContent = showing ? 'Sequence' : 'Source';
  viewName.textContent = showing
    ? `${S.timeline.length} item${S.timeline.length === 1 ? '' : 's'}`
    : (source?.name ?? '');
  timeline.classList.toggle('watching', !showing);
  sequenceEl.classList.toggle('watching', showing);
}

// Coalesced exactly like seek(): overlapping calls otherwise finish in whatever
// order their decodes happen to complete, and the preview settles on a stale
// frame. setView() starts one without awaiting it, so this is easy to hit.
let pendingSeqSeek = null;
let seekingSeq = false;

// The ruler spans exactly the items' area, so sequence time maps linearly onto
// it: item widths are already proportional to their durations.
const seqTotal = () => sequence.totalDuration(S.timeline);

function seqTimeForX(clientX) {
  const rect = seqRuler.getBoundingClientRect();
  if (!rect.width) return 0;
  return clamp(((clientX - rect.left) / rect.width) * seqTotal(), 0, seqTotal());
}

function updateSeqPlayhead() {
  const total = seqTotal();
  sequenceEl.classList.toggle('has-items', total > 0);
  if (!total) return;
  const rect = seqRuler.getBoundingClientRect();
  const wrap = seqRuler.offsetLeft;
  seqPlayheadEl.style.left = `${wrap + (S.seqPlayhead / total) * rect.width}px`;
}

/** Show a still of the sequence at a point on its own clock. */
export async function seekSequence(time) {
  const rows = sequenceRows();
  const total = rows.length ? rows[rows.length - 1].end : 0;
  S.seqPlayhead = clamp(time, 0, total);
  updateTransport();
  updateSeqPlayhead();

  const shape = sequenceShape(rows);
  // Assigning width clears the canvas even when the value is unchanged.
  if (preview.width !== shape.width) preview.width = shape.width;
  if (preview.height !== shape.height) preview.height = shape.height;

  pendingSeqSeek = S.seqPlayhead;
  if (seekingSeq) return;

  seekingSeq = true;
  try {
    while (pendingSeqSeek !== null) {
      const want = pendingSeqSeek;
      pendingSeqSeek = null;

      const row = sequence.at(rows, want);
      if (!row) {
        paintSilence(rows.length ? '' : 'empty sequence');
        continue;
      }
      const source = sourceById(row.item.sourceId);
      if (!media.isVideo(source)) {
        paintSilence(row.item.label);
        continue;
      }
      await media.using(source, async ({ sink }) => {
        const sample = await sink.getSample(sequence.sourceTime(row, want));
        if (!sample) return;
        try {
          paint(sample);
        } finally {
          sample.close();
        }
      });
    }
  } finally {
    seekingSeq = false;
  }
}

// Things you tried to do that cannot work, said over the picture rather than
// failing quietly. Borrowed from QCKSCRL.
let warnTimer = 0;

export function warn(title, message) {
  warnTitle.textContent = title;
  warnMsg.textContent = message;
  warnToast.classList.add('visible');
  clearTimeout(warnTimer);
  warnTimer = setTimeout(() => warnToast.classList.remove('visible'), 4000);
}

export function clearWarning() {
  clearTimeout(warnTimer);
  warnToast.classList.remove('visible');
}

/**
 * Marking cuts a range out of a source, so it needs a source on screen. Doing
 * it from the sequence would silently cut from whichever source happened to be
 * selected, which is not what the picture in front of you shows.
 */
function requireSource() {
  if (S.view === 'source' && active()) return true;
  warn('Showing the sequence',
    active()
      ? 'Clips are cut from a source. Click the filmstrip to go back to one.'
      : 'Add a source first, then click its filmstrip.');
  return false;
}

/** One export button for both, matching the play button. */
export function exportShowing() {
  return S.view === 'sequence' ? exportSequence() : exportRange();
}

/** One play button for both. */
export function togglePlay() {
  if (S.view === 'sequence') {
    return S.playingSeq ? stopSequence() : playSequence().catch(fail);
  }
  return S.playing ? pause() : play().catch(fail);
}

// ─── Help ────────────────────────────────────────────────────────────────────

const helpOverlay = $('helpOverlay');
const openHelp = () => helpOverlay.classList.add('visible');
const closeHelp = () => helpOverlay.classList.remove('visible');
const helpOpen = () => helpOverlay.classList.contains('visible');

$('helpBtn').addEventListener('click', openHelp);
$('helpCloseBtn').addEventListener('click', closeHelp);
helpOverlay.addEventListener('click', (event) => {
  if (event.target === helpOverlay) closeHelp();
});

// ─── Wiring ──────────────────────────────────────────────────────────────────

function fail(error) {
  console.error(error);
  setStatus(error?.message ?? String(error));
}

const isVideo = (file) =>
  file.type.startsWith('video/') || /\.(mp4|mov|webm|mkv|m4v)$/i.test(file.name);
const isAudio = (file) =>
  file.type.startsWith('audio/') || /\.(mp3|m4a|aac|wav|flac|ogg|opus)$/i.test(file.name);

async function addFiles(files) {
  // Audio is a source like any other: it can be clipped and put on the
  // sequence. The music bed is set by dropping onto its own lane instead.
  for (const file of files) {
    if (isVideo(file) || isAudio(file)) await addSource(file).catch(fail);
  }
}

function pickFiles() {
  const picker = document.createElement('input');
  picker.type = 'file';
  picker.accept = 'video/*,audio/*';
  picker.multiple = true;
  picker.onchange = () => addFiles([...picker.files]).catch(fail);
  picker.click();
}

for (const type of ['dragenter', 'dragover']) {
  document.addEventListener(type, (event) => {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    drop.classList.add('over');
  });
}

document.addEventListener('dragleave', (event) => {
  if (!event.relatedTarget) drop.classList.remove('over');
});

document.addEventListener('pointerdown', () => audio.unlock(), { capture: true });

document.addEventListener('drop', (event) => {
  drop.classList.remove('over');
  const files = [...(event.dataTransfer?.files ?? [])];
  if (!files.length) return;   // not ours; leave the browser to its default
  event.preventDefault();
  addFiles(files).catch(fail);
});

drop.addEventListener('click', pickFiles);

let resizeTimer = 0;
window.addEventListener('resize', () => {
  drawStrip();
  renderMusic();
  updateRange();
  updateMark();
  updateView();
  updateTransport();
  updateSeqPlayhead();
  // Only devicePixelRatio can change what needs decoding (dragging to a
  // different-density display), and that is rare enough to settle for.
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(drawStrip, 120);
});

/** Restore the project from IndexedDB. */
export async function restore() {
  const [sources, clips, timeline, music] = await Promise.all([
    store.allSources(), store.allClips(), store.allTimeline(), store.getMusic(),
  ]);
  if (music) {
    // The decoded buffer and its peaks are rebuilt; neither is storable.
    const buffer = await audio.decode(music.blob).catch(() => null);
    if (buffer) {
      S.music = { ...music, buffer, duration: buffer.duration, peaks: null, loudest: 1 };
    }
  }
  if (!sources.length) {
    updateUI();
    return;
  }
  const known = (id) => sources.some((s) => s.id === id);
  S.sources = sources.map((s) => ({
    ...s,
    // Older records predate `kind`; anything with dimensions had pictures.
    kind: s.kind ?? (s.width > 0 ? 'video' : 'audio'),
    thumbs: [],
    thumbCount: 0,
    poster: null,
    posterUrl: null,
    peaks: null,
    loudest: 1,
  }));
  S.clips = clips.filter((c) => known(c.sourceId));
  S.timeline = timeline.filter((i) => known(i.sourceId));
  // Ids are minted from a counter, so continue past whatever was restored.
  nextId = Math.max(0, ...[...S.sources, ...S.clips, ...S.timeline]
    .map((r) => Number(String(r.id).slice(1)) || 0)) + 1;
  await setActive(S.sources[0].id);
  for (const source of S.sources) queueStrip(source);
}

/** A JSON-safe view of the app, for tests. */
export function snapshot() {
  const source = active();
  return {
    sources: S.sources.map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.kind,
      duration: s.duration,
      width: s.width,
      height: s.height,
      thumbCount: s.thumbCount,
      thumbsDecoded: s.thumbs.filter(Boolean).length,
      // A video source is ready when every tile is decoded; an audio one when
      // its peaks are in. "Tiles decoded" means nothing for a waveform.
      ready: media.isVideo(s)
        ? s.thumbCount > 0 && s.thumbs.filter(Boolean).length === s.thumbCount
        : !!s.peaks,
    })),
    clips: S.clips.map((c) => ({ ...c })),
    timeline: sequenceRows().map(({ item, index, start, duration, end }) =>
      ({ ...item, index, start, duration, end })),
    sequenceDuration: sequence.totalDuration(S.timeline),
    activeId: S.activeId,
    activeClipId: S.activeClipId,
    activeItemId: S.activeItemId,
    seqPlayhead: S.seqPlayhead,
    playingSeq: S.playingSeq,
    muted: S.muted,
    rate: S.rate,
    view: S.view,
    marking: S.marking ? { at: S.marking.at } : null,
    kind: source?.kind ?? null,
    music: S.music
      ? { name: S.music.name, gain: S.music.gain, duration: S.music.duration }
      : null,
    playhead: S.playhead,
    in: S.in,
    out: S.out,
    playing: S.playing,
    duration: source?.duration ?? 0,
    width: source?.width ?? 0,
    height: source?.height ?? 0,
    openDecoders: media.openCount(),
    stripsIdle: stripsIdle(),
  };
}

setMuted(false);
setRate(1);
updateUI();

// Test hooks. The UI tests reach in by these names.
Object.assign(window, {
  S, media, store, snapshot, restore,
  seek, play, pause, addSource, setActive, removeSource,
  addClip, markClip, beginMark, cancelMark, selectClip, removeClip,
  renameSource, renameClip, renameItem, exportRange, buildStrip, queueStrip, drawStrip, stripsIdle,
  sequence, render, addToSequence, removeFromSequence, moveInSequence, selectItem,
  appendRange, playSequence, stopSequence, exportSequence, sequenceShape,
  setView, seekSequence, togglePlay, seqTimeForX, exportShowing, warn, clearWarning,
  audio, setMusic, setMusicFromSource, removeMusic, setMusicGain, setMuted, setRate,
  timecode, parseTimecode, clamp, clipLabel, exportName, setClipRange,
});

restore().catch(fail);
