// Generates a synthetic test clip in the browser, so the repo carries no binary
// fixture and the test suite needs no ffmpeg.
import {
  AudioBufferSource, BufferTarget, CanvasSource, Mp4OutputFormat, Output, QUALITY_LOW,
} from 'mediabunny';

export async function makeClip({ seconds = 6, fps = 30, width = 640, height = 360, keyFrameInterval = 1, tone = 0 } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
  const source = new CanvasSource(canvas, {
    codec: 'avc',
    bitrate: QUALITY_LOW,
    keyFrameInterval,
  });
  output.addVideoTrack(source, { frameRate: fps });

  // An optional sine tone, so sequence export has real audio to concatenate.
  const audio = tone ? new AudioBufferSource({ codec: 'aac', bitrate: QUALITY_LOW }) : null;
  if (audio) output.addAudioTrack(audio);

  await output.start();

  if (audio) {
    const rate = 48_000;
    const buffer = new AudioBuffer({ numberOfChannels: 1, length: seconds * rate, sampleRate: rate });
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < channel.length; i++) {
      channel[i] = 0.25 * Math.sin((2 * Math.PI * tone * i) / rate);
    }
    await audio.add(buffer);
    audio.close();
  }

  const total = seconds * fps;
  for (let i = 0; i < total; i++) {
    const t = i / fps;
    // Hue ramp plus a travelling bar: both the frame index and the time are
    // readable straight off a screenshot.
    ctx.fillStyle = `hsl(${(t / seconds) * 320} 70% 45%)`;
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#fff';
    ctx.fillRect((i / total) * (width - 40), 0, 40, height);
    ctx.font = 'bold 48px monospace';
    ctx.fillStyle = '#000';
    ctx.fillText(`${t.toFixed(2)}s`, 24, height - 32);
    await source.add(t, 1 / fps);
  }

  source.close();
  await output.finalize();
  return new File([output.target.buffer], 'fixture.mp4', { type: 'video/mp4' });
}
