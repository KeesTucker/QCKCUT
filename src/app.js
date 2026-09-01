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
  activeId: null,
  activeClipId: null,
  activeItemId: null,
  seqPlayhead: 0,
  playingSeq: false,
  playhead: 0,
  in: 0,
  out: 0,
  playing: false,
  exporting: false,
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
const playBtn = $('playBtn');
const exportBtn = $('exportBtn');
const markInBtn = $('markIn');
const markOutBtn = $('markOut');
const addClipBtn = $('addClip');
const addSourceBtn = $('addSource');
const sourceList = $('sourceList');
const clipList = $('clipList');
const track = $('track');
const seqPlayBtn = $('seqPlay');
const seqExportBtn = $('seqExport');
const seqDurationEl = $('seqDuration');
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

function paint(sample) {
  pctx.fillStyle = '#000';
  pctx.fillRect(0, 0, preview.width, preview.height);
  sample.drawWithFit(pctx, { fit: 'contain' });
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

export async function play() {
  if (S.playing || !held) return;
  S.playing = true;
  playBtn.textContent = 'Pause';

  const from = S.playhead >= S.out - 0.02 ? S.in : S.playhead;
  const startedAt = performance.now();
  let painted = false;

  try {
    for await (const sample of held.sink.samples(from, S.out)) {
      try {
        if (!S.playing) break;
        const due = (sample.timestamp - from) * 1000;
        const wait = due - (performance.now() - startedAt);
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
    if (S.playing) {
      S.playhead = S.out;
      updateTransport();
    }
    pause();
  }
}

export function pause() {
  S.playing = false;
  playBtn.textContent = 'Play';
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

  source.thumbCount = Math.max(1, Math.ceil((window.screen?.width ?? 1920) / media.tileWidth(source)));
  source.thumbs = [];
  if (source.id === S.activeId) drawStrip();

  try {
    for await (const tile of media.tiles(source, source.thumbCount, run.signal)) {
      if (run.signal.aborted) return;
      source.thumbs.push(tile);
      if (!source.poster && tile) {
        source.poster = tile;
        source.posterUrl = tile.toDataURL();
      }
      if (source.id === S.activeId) drawStrip();
      if (source.thumbs.length === 1) renderSources();
    }
  } finally {
    if (stripRuns.get(source.id) === run) stripRuns.delete(source.id);
  }
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
  sctx.fillStyle = '#0b0c0f';
  sctx.fillRect(0, 0, cssW, media.THUMB_H);
  if (!source?.thumbCount) return;

  const colW = cssW / source.thumbCount;
  for (let i = 0; i < source.thumbs.length; i++) {
    const tile = source.thumbs[i];
    if (!tile) continue;
    // Centre-crop into the column so a narrow window never squashes the frame.
    const sw = Math.min(tile.width, (colW / media.THUMB_H) * tile.height);
    sctx.drawImage(tile, (tile.width - sw) / 2, 0, sw, tile.height,
      i * colW, 0, colW + 0.5, media.THUMB_H);
  }
  drawClipMarks(cssW, source);
}

// Every clip of this source shows as a band on its own filmstrip, so you can see
// what you have already taken without leaving the timeline.
function drawClipMarks(cssW, source) {
  sctx.fillStyle = 'rgba(255, 77, 61, .28)';
  sctx.strokeStyle = 'rgba(255, 77, 61, .9)';
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
  const duration = active()?.duration ?? 0;
  timeEl.textContent = `${timecode(S.playhead)} / ${timecode(duration)}`;
  playheadEl.style.left = `${xForTime(S.playhead)}px`;
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
      meta: `${timecode(source.duration)} · ${source.width}×${source.height}`,
      onSelect: () => setActive(source.id).catch(fail),
      onDrop: () => removeSource(source.id).catch(fail),
      drag: { kind: 'source', id: source.id },
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
    parts.name.textContent = clip.label;
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

function row({ active: isActive, name, meta, onSelect, onDrop, drag }) {
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

function updateUI() {
  const source = active();
  const loaded = !!source;
  timeline.classList.toggle('empty', !loaded);
  drop.classList.toggle('hidden', S.sources.length > 0);
  for (const b of [playBtn, exportBtn, markInBtn, markOutBtn, addClipBtn]) b.disabled = !loaded;
  fileNameEl.textContent = loaded
    ? `${source.name} · ${source.width}×${source.height} · ${source.codec ?? '?'}`
    : 'no clip';
  renderSources();
  renderClips();
  renderTrack();
  updateRange();
  updateTransport();
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
  S.activeId = id;

  const source = active();
  if (!source) {
    updateUI();
    return;
  }
  held = await media.acquire(source);
  preview.width = source.width;
  preview.height = source.height;
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

export async function addClip() {
  const source = active();
  if (!source || S.out - S.in < MIN_RANGE) return null;
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

function renderTrack() {
  const rows = sequenceRows();
  const total = rows.length ? rows[rows.length - 1].end : 0;
  seqDurationEl.textContent = timecode(total);
  seqPlayBtn.disabled = !rows.length;
  seqExportBtn.disabled = !rows.length || S.exporting;

  track.replaceChildren(...rows.map((row) => {
    const source = sourceById(row.item.sourceId);
    const el = document.createElement('li');
    el.className = `track-item${row.item.id === S.activeItemId ? ' active' : ''}`;
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
  S.activeItemId = id;
  S.seqPlayhead = row.start;
  await setActive(row.item.sourceId);
  S.in = row.item.in;
  S.out = row.item.out;
  S.playhead = row.item.in;
  updateUI();
  await seek(row.item.in);
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
  seqPlayBtn.textContent = 'Stop';

  const rows = sequenceRows();
  const total = rows[rows.length - 1].end;
  if (S.seqPlayhead >= total - 0.02) S.seqPlayhead = 0;

  // The preview takes the sequence's own dimensions; items shaped differently
  // are letterboxed into it, matching what export produces.
  const first = sourceById(rows[0].item.sourceId);
  if (first) {
    preview.width = first.width;
    preview.height = first.height;
  }

  const origin = S.seqPlayhead;
  const startedAt = performance.now();
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

      try {
        for await (const sample of entry.sink.samples(from, row.item.out)) {
          try {
            if (!S.playingSeq) break;
            const at = row.start + (sample.timestamp - row.item.in);
            const wait = (at - origin) * 1000 - (performance.now() - startedAt);
            if (wait < -50 && painted) continue;
            if (wait > 0) await sleep(wait);
            if (!S.playingSeq) break;
            paint(sample);
            painted = true;
            S.seqPlayhead = at;
            seqDurationEl.textContent = `${timecode(at)} / ${timecode(total)}`;
          } finally {
            sample.close();
          }
        }
      } finally {
        media.release(source.id);
      }
    }
  } finally {
    if (S.playingSeq) S.seqPlayhead = total;
    stopSequence();
  }
}

export function stopSequence() {
  S.playingSeq = false;
  seqPlayBtn.textContent = 'Play sequence';
  renderTrack();
}

export async function exportSequence() {
  if (S.exporting || !S.timeline.length) return null;
  S.exporting = true;
  stopSequence();
  pause();
  seqExportBtn.disabled = true;

  try {
    const rows = sequenceRows();
    const started = performance.now();
    const blob = await render.renderSequence(rows, (item) => sourceById(item.sourceId),
      (p) => setStatus(`rendering sequence ${Math.round(p * 100)}%`));
    const took = (performance.now() - started) / 1000;
    render.download(blob, 'sequence.mp4');
    const total = rows[rows.length - 1].end;
    setStatus(`rendered ${(blob.size / 1e6).toFixed(1)} MB in ${took.toFixed(1)}s (${(total / took).toFixed(1)}\u00d7)`);
    return blob;
  } finally {
    S.exporting = false;
    renderTrack();
  }
}

seqPlayBtn.addEventListener('click', () => (S.playingSeq ? stopSequence() : playSequence().catch(fail)));
seqExportBtn.addEventListener('click', () => exportSequence().catch(fail));

// ─── Timeline interaction ────────────────────────────────────────────────────
// The whole strip is one scrub surface. Handles capture the pointer first, so
// dragging a handle trims instead of scrubbing.

function dragTime(event) {
  const rect = timeline.getBoundingClientRect();
  return clamp(timeForX(event.clientX - rect.left), 0, active()?.duration ?? 0);
}

timeline.addEventListener('pointerdown', (event) => {
  if (!held) return;
  pause();
  timeline.setPointerCapture(event.pointerId);
  seek(dragTime(event)).catch(fail);
});

timeline.addEventListener('pointermove', (event) => {
  if (timeline.hasPointerCapture(event.pointerId)) seek(dragTime(event)).catch(fail);
});

function bindHandle(el, which) {
  el.addEventListener('pointerdown', (event) => {
    if (!held) return;
    event.stopPropagation();
    pause();
    el.setPointerCapture(event.pointerId);
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

playBtn.addEventListener('click', () => (S.playing ? pause() : play().catch(fail)));

markInBtn.addEventListener('click', () => {
  S.in = clamp(S.playhead, 0, S.out - MIN_RANGE);
  updateRange();
  drawStrip();
  syncActiveClip().catch(fail);
});

markOutBtn.addEventListener('click', () => {
  S.out = clamp(S.playhead, S.in + MIN_RANGE, active()?.duration ?? 0);
  updateRange();
  drawStrip();
  syncActiveClip().catch(fail);
});

addClipBtn.addEventListener('click', () => addClip().catch(fail));
addSourceBtn.addEventListener('click', () => pickFiles());

document.addEventListener('keydown', (event) => {
  if (event.target.tagName === 'INPUT') return;
  if (event.key === '?') { event.preventDefault(); return openHelp(); }
  if (event.key === 'Escape' && helpOpen()) return closeHelp();
  if (!held || helpOpen()) return;
  const frame = 1 / 30;
  if (event.code === 'Space') { event.preventDefault(); S.playing ? pause() : play().catch(fail); }
  else if (event.code === 'ArrowLeft') { pause(); seek(S.playhead - (event.shiftKey ? 1 : frame)).catch(fail); }
  else if (event.code === 'ArrowRight') { pause(); seek(S.playhead + (event.shiftKey ? 1 : frame)).catch(fail); }
  else if (event.key === 'i') markInBtn.click();
  else if (event.key === 'o') markOutBtn.click();
  else if (event.key === 'c') addClip().catch(fail);
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
    exportBtn.disabled = false;
  }
}

exportBtn.addEventListener('click', () => exportRange().catch(fail));

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

async function addFiles(files) {
  for (const file of files) {
    if (file.type.startsWith('video/') || /\.(mp4|mov|webm|mkv|m4v)$/i.test(file.name)) {
      await addSource(file).catch(fail);
    }
  }
}

function pickFiles() {
  const picker = document.createElement('input');
  picker.type = 'file';
  picker.accept = 'video/*';
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
  updateRange();
  updateTransport();
  // Only devicePixelRatio can change what needs decoding (dragging to a
  // different-density display), and that is rare enough to settle for.
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(drawStrip, 120);
});

/** Restore the project from IndexedDB. */
export async function restore() {
  const [sources, clips, timeline] = await Promise.all([
    store.allSources(), store.allClips(), store.allTimeline(),
  ]);
  if (!sources.length) return;
  const known = (id) => sources.some((s) => s.id === id);
  S.sources = sources.map((s) => ({ ...s, thumbs: [], thumbCount: 0, poster: null, posterUrl: null }));
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
    sources: S.sources.map((s) => ({ id: s.id, name: s.name, duration: s.duration, width: s.width, height: s.height, thumbCount: s.thumbCount, thumbsDecoded: s.thumbs.filter(Boolean).length })),
    clips: S.clips.map((c) => ({ ...c })),
    timeline: sequenceRows().map(({ item, index, start, duration, end }) =>
      ({ ...item, index, start, duration, end })),
    sequenceDuration: sequence.totalDuration(S.timeline),
    activeId: S.activeId,
    activeClipId: S.activeClipId,
    activeItemId: S.activeItemId,
    seqPlayhead: S.seqPlayhead,
    playingSeq: S.playingSeq,
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

updateUI();

// Test hooks. The UI tests reach in by these names.
Object.assign(window, {
  S, media, store, snapshot, restore,
  seek, play, pause, addSource, setActive, removeSource,
  addClip, selectClip, removeClip, exportRange, buildStrip, queueStrip, drawStrip, stripsIdle,
  sequence, render, addToSequence, removeFromSequence, moveInSequence, selectItem,
  appendRange, playSequence, stopSequence, exportSequence,
  timecode, parseTimecode, clamp, clipLabel, exportName, setClipRange,
});

restore().catch(fail);
