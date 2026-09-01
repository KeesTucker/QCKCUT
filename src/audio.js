// Sound for the preview.
//
// The important idea here is the clock. Video used to be paced against
// performance.now(), which is fine on its own but drifts against audio: the
// audio hardware runs on its own crystal and AudioContext.currentTime follows
// that, not the system timer. Once sound is playing, the audio clock becomes
// the master and video is paced against it, so the two cannot separate.

let context = null;

/** The shared AudioContext, created on first use. */
export function audio() {
  context ??= new AudioContext();
  return context;
}

/**
 * Browsers keep an AudioContext suspended until a user gesture. Call this from
 * any click or keypress; it is cheap and idempotent.
 */
export function unlock() {
  const ctx = audio();
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

export const now = () => audio().currentTime;

/**
 * A playback clock in seconds since the range started.
 *
 * `wallClock` is the fallback for silent media. `audioClock` reads the same
 * timebase the sound is scheduled on, which is what keeps them locked.
 */
export function wallClock() {
  const started = performance.now();
  return () => (performance.now() - started) / 1000;
}

export function audioClock(startAt) {
  return () => audio().currentTime - startAt;
}

/** How far ahead of the playhead we schedule buffers. */
const LOOKAHEAD = 0.75;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Schedule a track's audio for the range [from, to), starting at `startAt` on
 * the audio clock. Resolves once everything is scheduled, which is well before
 * it finishes sounding, so callers drive their own stopping.
 *
 * Buffers are scheduled just in time rather than all at once: a long range
 * would otherwise create thousands of nodes up front.
 */
export async function schedule({ sink, from, to, startAt, destination, signal }) {
  const ctx = audio();
  const out = destination ?? ctx.destination;

  for await (const { buffer, timestamp } of sink.buffers(from, to)) {
    if (signal?.aborted) return;

    const when = startAt + (timestamp - from);
    while (!signal?.aborted && when - ctx.currentTime > LOOKAHEAD) {
      await sleep(60);
    }
    if (signal?.aborted) return;

    // A buffer can start before the range does, so trim from the front rather
    // than scheduling in the past, which would drop it silently.
    const offset = when < ctx.currentTime ? ctx.currentTime - when : 0;
    if (offset >= buffer.duration) continue;

    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(out);
    node.start(Math.max(when, ctx.currentTime), offset);
    signal?.addEventListener('abort', () => { try { node.stop(); } catch {} }, { once: true });
  }
}

/**
 * Play a short grain of audio at one point, for scrubbing. Latest wins: a new
 * grain replaces whatever is still sounding, so dragging does not pile up into
 * noise.
 */
const GRAIN = 0.12;
let grain = null;

export async function scrub(sink, at, gain = 1) {
  const ctx = unlock();
  stopScrub();
  const wrapped = await sink.getBuffer(at);
  if (!wrapped) return;

  const offset = Math.max(0, Math.min(at - wrapped.timestamp, wrapped.buffer.duration));
  const node = ctx.createBufferSource();
  const volume = ctx.createGain();
  volume.gain.value = gain;
  node.buffer = wrapped.buffer;
  node.connect(volume).connect(ctx.destination);
  node.start(ctx.currentTime, offset, GRAIN);
  grain = node;
  node.onended = () => { if (grain === node) grain = null; };
}

export function stopScrub() {
  if (!grain) return;
  try { grain.stop(); } catch {}
  grain = null;
}

/** Decode a whole file to an AudioBuffer, for the music bed. */
export async function decode(blob) {
  return audio().decodeAudioData(await blob.arrayBuffer());
}

/**
 * Reduce a buffer to `count` peak amplitudes for drawing a waveform.
 * Pure apart from reading the buffer.
 */
export function peaks(buffer, count) {
  const data = buffer.getChannelData(0);
  const per = Math.max(1, Math.floor(data.length / count));
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    let peak = 0;
    const start = i * per;
    for (let j = start; j < start + per && j < data.length; j++) {
      const value = data[j] < 0 ? -data[j] : data[j];
      if (value > peak) peak = value;
    }
    out[i] = peak;
  }
  return out;
}

/**
 * Peaks for a whole track, read straight from the decoder rather than by
 * decoding the file into one AudioBuffer. A long song held whole is tens of
 * megabytes; this streams it and keeps only the peaks.
 */
export async function peaksFromSink(sink, duration, count, signal) {
  const out = new Float32Array(count);
  if (duration <= 0) return out;
  const perSecond = count / duration;

  for await (const { buffer, timestamp } of sink.buffers()) {
    if (signal?.aborted) return out;
    const data = buffer.getChannelData(0);
    const rate = buffer.sampleRate;
    for (let i = 0; i < data.length; i++) {
      const bucket = Math.floor((timestamp + i / rate) * perSecond);
      if (bucket < 0 || bucket >= count) continue;
      const value = data[i] < 0 ? -data[i] : data[i];
      if (value > out[bucket]) out[bucket] = value;
    }
  }
  return out;
}

/** The largest value in a peaks array, never zero so it is safe to divide by. */
export const loudest = (peaks) => peaks.reduce((a, b) => (b > a ? b : a), 0) || 1;
