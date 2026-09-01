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

const EPSILON = 1e-6;
const AUDIO_RATE = 48_000;
const AUDIO_CHANNELS = 2;

/** Render one range of one source. Keeps the source's audio. */
export async function renderClip(source, start, end, onProgress) {
  // A fresh Input so export never disturbs the preview pool.
  const input = new Input({ source: new BlobSource(source.blob), formats: ALL_FORMATS });
  try {
    const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
    const conversion = await Conversion.init({ input, output, trim: { start, end } });
    if (onProgress) conversion.onProgress = onProgress;
    await conversion.execute();
    return new Blob([output.target.buffer], { type: 'video/mp4' });
  } finally {
    input.dispose();
  }
}

/**
 * Render a laid-out sequence. `rows` come from `sequence.layout()`, `sourceOf`
 * resolves an item to its source. Output takes the first item's dimensions;
 * everything else is letterboxed into them.
 */
export async function renderSequence(rows, sourceOf, onProgress) {
  if (!rows.length) throw new Error('the sequence is empty');
  const first = sourceOf(rows[0].item);
  if (!first) throw new Error('the first item has no source');

  const canvas = document.createElement('canvas');
  canvas.width = first.width;
  canvas.height = first.height;
  const ctx = canvas.getContext('2d');

  const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
  const video = new CanvasSource(canvas, { codec: 'avc', bitrate: QUALITY_HIGH });
  output.addVideoTrack(video);

  // Audio is mixed first: the track has to exist before the output starts, and
  // we only add one if at least one item actually has sound.
  const total = rows[rows.length - 1].end;
  const mixed = await mixAudio(rows, sourceOf, total);
  const audio = mixed ? new AudioBufferSource({ codec: 'aac', bitrate: QUALITY_HIGH }) : null;
  if (audio) output.addAudioTrack(audio);

  await output.start();
  if (audio) {
    await audio.add(mixed);
    audio.close();
  }

  for (const row of rows) {
    const source = sourceOf(row.item);
    if (!source) continue;
    await media.using(source, async ({ track }) => {
      const sink = new VideoSampleSink(track);
      // Iterated by hand so each frame can see the next one. A frame's duration
      // is the gap to its successor, and the item's last frame is held until
      // exactly the cut. Without that the picture is frame-quantised while the
      // audio mix uses exact boundaries, so the two drift apart by up to a
      // frame per cut.
      const frames = sink.samples(row.item.in, row.item.out)[Symbol.asyncIterator]();
      const atOf = (timestamp) => row.start + (timestamp - row.item.in);
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

        const lookahead = await frames.next();
        try {
          // Letterbox rather than stretch: items are not all the same shape.
          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          sample.drawWithFit(ctx, { fit: 'contain' });

          const at = atOf(sample.timestamp);
          const nextAt = !lookahead.done && !past(lookahead.value)
            ? atOf(lookahead.value.timestamp)
            : row.end;
          await video.add(at, Math.max(0, nextAt - at) || undefined);
          onProgress?.(Math.min(1, at / total));
        } finally {
          sample.close();
        }
        step = lookahead;
      }
    });
  }

  video.close();
  await output.finalize();
  onProgress?.(1);
  return new Blob([output.target.buffer], { type: 'video/mp4' });
}

/**
 * Flatten every item's audio onto one buffer at a single rate, so sources that
 * disagree about sample rate or channel count still line up. Items with no
 * audio simply leave silence, which is what keeps the picture in sync.
 * Returns null when nothing in the sequence has sound.
 */
async function mixAudio(rows, sourceOf, total) {
  if (total <= 0) return null;
  const context = new OfflineAudioContext(
    AUDIO_CHANNELS, Math.ceil(total * AUDIO_RATE), AUDIO_RATE);
  let found = false;

  for (const row of rows) {
    const source = sourceOf(row.item);
    if (!source) continue;
    await media.using(source, async ({ input }) => {
      const track = await input.getPrimaryAudioTrack();
      if (!track || !(await track.canDecode())) return;
      found = true;

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
        node.connect(context.destination);
        node.start(at, offset, Math.min(buffer.duration - offset, room));
      }
    });
  }

  return found ? context.startRendering() : null;
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
