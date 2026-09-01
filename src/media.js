// Open media and the decoders behind it.
//
// Every Input holds a hardware decoder, and the pool is finite: opening one per
// source and never closing them fails opaquely with "Decoding error" after a
// handful of imports. So sources are opened lazily, kept warm while in use, and
// the least recently touched idle one is closed once we exceed MAX_OPEN.

import { ALL_FORMATS, AudioBufferSink, BlobSource, CanvasSink, Input, VideoSampleSink } from 'mediabunny';

export const MAX_OPEN = 4;
export const THUMB_H = 88;

const open = new Map();   // sourceId -> { input, track, sink, uses, touched }
let clock = 0;

/**
 * Open a source, or return the already-open one. Every acquire must be paired
 * with a release, or the entry pins a decoder forever.
 */
export async function acquire(source) {
  let entry = open.get(source.id);
  if (!entry) {
    const input = new Input({ source: new BlobSource(source.blob), formats: ALL_FORMATS });
    const track = await input.getPrimaryVideoTrack();
    if (!track) {
      input.dispose();
      throw new Error(`${source.name}: no video track`);
    }
    if (!(await track.canDecode())) {
      input.dispose();
      throw new Error(`${source.name}: cannot decode ${track.codec ?? 'this codec'}`);
    }
    entry = { input, track, sink: new VideoSampleSink(track), uses: 0, touched: 0 };
    open.set(source.id, entry);
  }
  entry.uses++;
  entry.touched = ++clock;
  evict();
  return entry;
}

export function release(sourceId) {
  const entry = open.get(sourceId);
  if (entry && entry.uses > 0) entry.uses--;
  evict();
}

/** Acquire for the duration of one operation. */
export async function using(source, action) {
  const entry = await acquire(source);
  try {
    return await action(entry);
  } finally {
    release(source.id);
  }
}

function evict() {
  if (open.size <= MAX_OPEN) return;
  const idle = [...open.entries()]
    .filter(([, entry]) => entry.uses === 0)
    .sort((a, b) => a[1].touched - b[1].touched);
  for (const [id, entry] of idle) {
    if (open.size <= MAX_OPEN) break;
    entry.input.dispose();
    open.delete(id);
  }
}

export function close(sourceId) {
  const entry = open.get(sourceId);
  if (!entry) return;
  entry.input.dispose();
  open.delete(sourceId);
}

export function closeAll() {
  for (const entry of open.values()) entry.input.dispose();
  open.clear();
}

export const openCount = () => open.size;
export const isOpen = (id) => open.has(id);

/**
 * The audio side of an open source, or null when it has none or we cannot
 * decode it. Resolved once and cached on the entry, since the answer cannot
 * change for a given file.
 */
export async function audioOf(entry) {
  if (entry.audio === undefined) {
    const track = await entry.input.getPrimaryAudioTrack();
    entry.audio = track && (await track.canDecode())
      ? { track, sink: new AudioBufferSink(track) }
      : null;
  }
  return entry.audio;
}

// ─── Reading a source ────────────────────────────────────────────────────────

/** Metadata for a newly imported file. Does not keep the decoder open. */
export async function probe(source) {
  return using(source, async ({ input, track }) => ({
    duration: await input.computeDuration(),
    width: await track.getDisplayWidth(),
    height: await track.getDisplayHeight(),
    codec: track.codec,
  }));
}

/** Thumbnail tile width for a source, at THUMB_H tall. */
export const tileWidth = (source) =>
  Math.max(1, Math.round((THUMB_H * source.width) / source.height));

/**
 * Decode filmstrip tiles, yielding each as it arrives so a long source becomes
 * scannable immediately. Keyframes only: never decode a delta frame to fill a
 * thumbnail.
 */
export async function* tiles(source, count, signal) {
  // Acquired explicitly rather than through using(): that helper awaits its
  // action, which for a generator resolves before a single tile is consumed,
  // releasing the decoder while it is still needed. The finally here runs when
  // the generator completes or the caller breaks out of it.
  const { track } = await acquire(source);
  try {
    const sink = new CanvasSink(track, { height: THUMB_H, fit: 'contain', poolSize: 2 });
    const times = tileTimestamps(source.duration, count);
    for await (const wrapped of sink.canvasesAtTimestamps(times, { keyPacketsOnly: true })) {
      if (signal?.aborted) return;
      yield wrapped ? copy(wrapped.canvas) : null;
    }
  } finally {
    release(source.id);
  }
}

/** Evenly spaced sample points, one per equal slice of the duration. */
export function tileTimestamps(duration, count) {
  const step = duration / count;
  return Array.from({ length: count }, (_, i) => (i + 0.5) * step);
}

// The sink recycles canvases through a pool, so a retained reference would be
// overwritten by a later frame. Take our own copy.
function copy(source) {
  const tile = document.createElement('canvas');
  tile.width = source.width;
  tile.height = source.height;
  tile.getContext('2d').drawImage(source, 0, 0);
  return tile;
}
