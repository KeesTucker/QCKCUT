// Turning a range or a sequence into an MP4.
//
// A single clip goes through Conversion, which passes packets through where it
// can and keeps the source's audio track untouched.
//
// A sequence cannot: its items come from different sources, with different
// codecs, resolutions and rotations. So every frame is drawn into one
// output-sized canvas and re-encoded. The draw stays on the GPU, and the encode
// uses the platform's hardware encoder, so this is far cheaper than it sounds.

import {
  ALL_FORMATS, AudioBufferSink, AudioBufferSource, BlobSource, BufferTarget,
  CanvasSource, Conversion, Input, Mp4OutputFormat, Output, QUALITY_HIGH,
  VideoSampleSink,
} from 'mediabunny';
import * as media from './media.js';
import * as transitions from './transitions.js';

/** Thrown when a render is stopped on purpose, so callers can tell it apart. */
export class Cancelled extends Error {
  constructor() {
    super('export cancelled');
    this.name = 'Cancelled';
  }
}

const stopIf = (signal) => {
  if (signal?.aborted) throw new Cancelled();
};

const EPSILON = 1e-6;
const AUDIO_RATE = 48_000;
const AUDIO_CHANNELS = 2;

/**
 * Render one range of one source. Keeps the source's audio, and passes packets
 * through untouched unless the output settings ask for a different shape.
 */
export async function renderClip(source, start, end, onProgress, settings = {}, signal) {
  // A fresh Input so export never disturbs the preview pool.
  const input = new Input({ source: new BlobSource(source.blob), formats: ALL_FORMATS });
  try {
    const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
    const video = {};
    if (settings.width && settings.height) {
      Object.assign(video, { width: settings.width, height: settings.height, fit: 'contain' });
    }
    if (settings.fps) video.frameRate = settings.fps;

    const conversion = await Conversion.init({
      input,
      output,
      trim: { start, end },
      ...(Object.keys(video).length ? { video } : {}),
    });
    if (onProgress) conversion.onProgress = (p) => onProgress(p, 'video');
    if (signal) {
      signal.addEventListener('abort', () => { conversion.cancel().catch(() => {}); }, { once: true });
    }
    await conversion.execute();
    stopIf(signal);
    return new Blob([output.target.buffer], { type: 'video/mp4' });
  } finally {
    input.dispose();
  }
}

/**
 * Render a laid-out sequence. `rows` come from `sequence.layout()`, `sourceOf`
 * resolves an item to its source. Output takes the first item's dimensions;
 * everything else is letterboxed into them.
 *
 * `onProgress(fraction, phase)` is called for both phases. Audio is mixed
 * before any picture is touched, and on a long sequence that is many seconds
 * with nothing to show for it, so the phase is reported rather than left to
 * look like a hang.
 */
export async function renderSequence(rows, sourceOf, onProgress, music = null, shape = null, fps = null, signal, plan = null, audioLanes = [], total = null) {
  // Video rows can legitimately be empty: a sequence may be sound over black.
  if (!rows.length && !(total > 0)) throw new Error('the sequence is empty');
  // The caller picks the shape, because the first item may be audio and have
  // no dimensions of its own.
  const size = shape ?? { width: sourceOf(rows[0].item)?.width, height: sourceOf(rows[0].item)?.height };
  if (!size?.width || !size?.height) throw new Error('the sequence has no dimensions');

  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext('2d');

  const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
  const video = new CanvasSource(canvas, { codec: 'avc', bitrate: QUALITY_HIGH });
  output.addVideoTrack(video);

  // Audio is mixed first: the track has to exist before the output starts, and
  // we only add one if at least one item actually has sound.
  // The sequence is as long as its longest lane, so the caller passes the
  // length rather than it being read off the video rows.
  const length = total ?? rows[rows.length - 1].end;
  if (!(length > 0)) throw new Error('the sequence is empty');
  onProgress?.(0, 'audio');
  const mixed = await mixAudio([rows, ...audioLanes], sourceOf, length, music, onProgress, signal);
  const audio = mixed ? new AudioBufferSource({ codec: 'aac', bitrate: QUALITY_HIGH }) : null;
  if (audio) output.addAudioTrack(audio);

  await output.start();
  if (audio) {
    await audio.add(mixed);
    audio.close();
  }
  onProgress?.(0, 'video');

  try {
    await renderFrames({ rows, sourceOf, ctx, canvas, video, total: length, fps, onProgress, signal, plan });
  } catch (error) {
    // A started Output holds an encoder, so it has to be cancelled either way.
    await output.cancel().catch(() => {});
    throw error;
  }

  video.close();
  await output.finalize();
  onProgress?.(1, 'video');
  return new Blob([output.target.buffer], { type: 'video/mp4' });
}

async function renderFrames({ rows, sourceOf, ctx, canvas, video, total, fps, onProgress, signal, plan }) {
  // The same darkening the preview applies, from the same function.
  const darken = (at) => {
    const dim = plan ? transitions.dimAt(at, plan) : 0;
    if (dim <= 0) return;
    ctx.fillStyle = `rgba(0, 0, 0, ${dim})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  };

  for (const row of rows) {
    stopIf(signal);
    const source = sourceOf(row.item);
    if (!source) continue;

    // An audio-only item still occupies time, so it renders as black rather
    // than being skipped, which would shorten the sequence and desync the mix.
    if (!media.isVideo(source)) {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await video.add(row.start, row.duration);
      onProgress?.(Math.min(1, row.end / total), 'video');
      continue;
    }

    // A fixed frame rate is a resample: ask for the exact instants the output
    // needs rather than passing the source's own timings through.
    if (fps) {
      await media.using(source, async ({ track }) => {
        const sink = new VideoSampleSink(track);
        const count = Math.max(1, Math.round(row.duration * fps));
        const times = Array.from({ length: count }, (_, k) => row.item.in + k / fps);
        let k = 0;
        for await (const sample of sink.samplesAtTimestamps(times)) {
          const at = row.start + k / fps;
          k++;
          if (!sample) continue;
          if (signal?.aborted) { sample.close(); throw new Cancelled(); }
          try {
            ctx.fillStyle = '#000';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            sample.drawWithFit(ctx, { fit: 'contain' });
            darken(at);
            await video.add(at, 1 / fps);
            onProgress?.(Math.min(1, at / total), 'video');
          } finally {
            sample.close();
          }
        }
      });
      continue;
    }

    await media.using(source, async ({ track }) => {
      const sink = new VideoSampleSink(track);
      // Iterated by hand so each frame can see the next one. A frame's duration
      // is the gap to its successor, and the item's last frame is held until
      // exactly the cut. Without that the picture is frame-quantised while the
      // audio mix uses exact boundaries, so the two drift apart by up to a
      // frame per cut.
      const frames = sink.samples(row.item.in, row.item.out)[Symbol.asyncIterator]();
      // samples() also yields the frame *containing* the in point, which can
      // start before it. Clamped into the item's own span, so the first frame
      // of the sequence lands at 0 rather than slightly before it, which the
      // muxer rejects outright.
      const atOf = (timestamp) => {
        const at = row.start + (timestamp - row.item.in);
        return at < row.start ? row.start : at > row.end ? row.end : at;
      };
      const past = (sample) => sample.timestamp >= row.item.out - EPSILON;

      let step = await frames.next();
      while (!step.done) {
        const sample = step.value;
        // samples() also yields the frame that *spans* the end time.
        if (past(sample)) {
          sample.close();
          await frames.return?.();
          break;
        }

        if (signal?.aborted) {
          sample.close();
          await frames.return?.();
          throw new Cancelled();
        }

        const lookahead = await frames.next();
        try {
          // Letterbox rather than stretch: items are not all the same shape.
          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          const at = atOf(sample.timestamp);
          sample.drawWithFit(ctx, { fit: 'contain' });
          darken(at);
          const nextAt = !lookahead.done && !past(lookahead.value)
            ? atOf(lookahead.value.timestamp)
            : row.end;
          await video.add(at, Math.max(0, nextAt - at) || undefined);
          onProgress?.(Math.min(1, at / total), 'video');
        } finally {
          sample.close();
        }
        step = lookahead;
      }
    });
  }


  // An audio lane can outrun the picture. The sequence keeps its full length,
  // so the tail is black rather than the sound being cut off.
  const pictureEnd = rows.length ? rows[rows.length - 1].end : 0;
  if (total > pictureEnd + EPSILON) {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (fps) {
      for (let at = pictureEnd; at < total - EPSILON; at += 1 / fps) {
        stopIf(signal);
        await video.add(at, 1 / fps);
      }
    } else {
      await video.add(pictureEnd, total - pictureEnd);
    }
    onProgress?.(1, 'video');
  }
}

/**
 * Flatten every item's audio onto one buffer at a single rate, so sources that
 * disagree about sample rate or channel count still line up. Items with no
 * audio simply leave silence, which is what keeps the picture in sync.
 * The music bed is mixed in underneath at its own gain, and is cut off at the
 * end of the sequence rather than extending it.
 *
 * Returns null when there is nothing to hear at all.
 */
async function mixAudio(lanes, sourceOf, total, music, onProgress, signal) {
  if (total <= 0) return null;
  const context = new OfflineAudioContext(
    AUDIO_CHANNELS, Math.ceil(total * AUDIO_RATE), AUDIO_RATE);
  let found = false;

  if (music?.buffer && music.gain > 0) {
    found = true;
    const node = context.createBufferSource();
    const level = context.createGain();
    level.gain.value = music.gain;
    node.buffer = music.buffer;
    node.connect(level).connect(context.destination);
    node.start(0, 0, Math.min(music.buffer.duration, total));
  }

  // Every lane is scheduled onto the same context: they are parallel, so their
  // sound simply sums.
  const steps = lanes.reduce((n, lane) => n + lane.length, 0) || 1;
  let done = 0;
  for (const lane of lanes) {
    for (const row of lane) {
      // The mix is the slow half on a long sequence, so a cancel has to land
      // here too. It was previously handed a signal it never declared, so
      // Cancel did nothing until the picture started.
      stopIf(signal);
      onProgress?.(done++ / steps, 'audio');
      if (await scheduleRow(context, row, sourceOf, total)) found = true;
    }
  }

  if (!found) return null;
  // startRendering() is proportional to the sequence length and reports
  // nothing, so say what is happening before disappearing into it.
  onProgress?.(1, 'audio');
  return context.startRendering();
}

/** Schedule one item's audio at its place on the sequence clock. */
async function scheduleRow(context, row, sourceOf, total) {
  const source = sourceOf(row.item);
  if (!source) return false;

  // Per-item level, the same number the preview uses. Zero is skipped outright:
  // a silent node still costs a decode.
  const level = row.item.muted ? 0 : row.item.gain ?? 1;
  if (level <= 0) return false;

  return media.using(source, async ({ input }) => {
    const track = await input.getPrimaryAudioTrack();
    if (!track || !(await track.canDecode())) return false;

    const sink = new AudioBufferSink(track);
    for await (const { buffer, timestamp } of sink.buffers(row.item.in, row.item.out)) {
      // Packet granularity means a buffer can start before the in point, so
      // trim from the front rather than scheduling at a negative time.
      const when = row.start + (timestamp - row.item.in);
      const offset = when < 0 ? -when : 0;
      const at = Math.max(0, when);
      const room = Math.min(row.end, total) - at;
      if (room <= 0 || offset >= buffer.duration) continue;

      const node = context.createBufferSource();
      node.buffer = buffer;
      if (level < 1) {
        const gain = context.createGain();
        gain.gain.value = level;
        node.connect(gain).connect(context.destination);
      } else {
        node.connect(context.destination);
      }
      node.start(at, offset, Math.min(buffer.duration - offset, room));
    }
    return true;
  });
}

/** Hand a rendered blob to the browser as a download. */
export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  // Revoking synchronously after click() races the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
