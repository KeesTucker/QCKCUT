// Open media and the decoders behind it.
//
// A source is either video (with or without sound) or audio-only. Audio-only
// sources have no `track` and no video `sink`, so anything that draws pictures
// must check `isVideo(source)` first.
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
    const sound = await input.getPrimaryAudioTrack();

    if (!track && !sound) {
      input.dispose();
      throw new Error(`${source.name}: no video or audio track`);
    }
    if (track && !(await track.canDecode())) {
      const why = await explain(track);
      input.dispose();
      throw new Error(`${source.name}: ${why}`);
    }
    if (!track && !(await sound.canDecode())) {
      input.dispose();
      throw new Error(
        `${source.name}: this browser cannot decode ${sound.codec ?? 'that audio codec'}`);
    }

    entry = {
      input,
      track,
      sink: track ? new VideoSampleSink(track) : null,
      uses: 0,
      touched: 0,
    };
    open.set(source.id, entry);
  }
  entry.uses++;
  entry.touched = ++clock;
  evict();
  return entry;
}

// ─── What this browser can decode ────────────────────────────────────────────
// Codec availability is a property of the browser, its version and the machine
// it runs on, not of the file. HEVC is the sharp edge: Chrome needs hardware
// support, Firefox only gained it in 134-137 depending on platform (and on
// Windows behind a paid extension), and Safari has had it for years. So the
// only honest answer is to ask at runtime, which is what MDN recommends:
// https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API/Codec_selection

/** One representative config per codec, enough to answer "at all?". */
const PROBES = {
  video: [
    ['H.264', 'avc', 'avc1.640028'],
    ['HEVC / H.265', 'hevc', 'hvc1.1.6.L93.B0'],
    ['VP9', 'vp9', 'vp09.00.10.08'],
    ['VP8', 'vp8', 'vp8'],
    ['AV1', 'av1', 'av01.0.04M.08'],
  ],
  audio: [
    ['AAC', 'aac', 'mp4a.40.2'],
    ['Opus', 'opus', 'opus'],
    ['MP3', 'mp3', 'mp3'],
    ['FLAC', 'flac', 'flac'],
    ['Vorbis', 'vorbis', 'vorbis'],
  ],
};

const decodable = async (kind, codec) => {
  const Decoder = kind === 'video' ? globalThis.VideoDecoder : globalThis.AudioDecoder;
  if (!Decoder) return false;
  try {
    const { supported } = await Decoder.isConfigSupported(kind === 'video'
      ? { codec, codedWidth: 1920, codedHeight: 1080 }
      : { codec, sampleRate: 48_000, numberOfChannels: 2 });
    return !!supported;
  } catch {
    // An unrecognised codec string throws rather than answering false.
    return false;
  }
};

/** What this browser will decode, for the help dialog. */
export async function support() {
  const answer = { webCodecs: !!globalThis.VideoDecoder, video: [], audio: [] };
  for (const kind of ['video', 'audio']) {
    for (const [label, name, codec] of PROBES[kind]) {
      answer[kind].push({ label, name, supported: await decodable(kind, codec) });
    }
  }
  return answer;
}

/**
 * Why a track will not decode, in words worth reading. "cannot decode hevc" is
 * true but useless: what matters is whether this is the browser's limit or the
 * file's, and the user can act on the first by opening it somewhere else.
 */
async function explain(track) {
  const codec = track.codec ?? 'that codec';
  if (!globalThis.VideoDecoder) {
    return 'this browser has no WebCodecs support, so it cannot decode video here';
  }

  const string = await track.getCodecParameterString().catch(() => null);
  if (!string) return `this browser cannot decode ${codec}`;

  // Does it know the codec at all, or only not this flavour of it?
  const family = await decodable('video', string);
  if (!family) {
    return `this browser cannot decode ${codec}. `
      + 'Support depends on the browser and the machine, not the file, so it may open elsewhere';
  }
  return `${codec} decodes here, but not this file's ${string} `
    + `at ${track.codedWidth}×${track.codedHeight}`;
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

/** True for a source that has pictures to show. */
export const isVideo = (source) => source?.kind === 'video';

/** Metadata for a newly imported file. Does not keep the decoder open. */
export async function probe(source) {
  return using(source, async (entry) => {
    const duration = await entry.input.computeDuration();
    if (!entry.track) {
      const sound = await audioOf(entry);
      return { kind: 'audio', duration, width: 0, height: 0, codec: sound?.track.codec ?? null };
    }
    return {
      kind: 'video',
      duration,
      width: await entry.track.getDisplayWidth(),
      height: await entry.track.getDisplayHeight(),
      codec: entry.track.codec,
    };
  });
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
