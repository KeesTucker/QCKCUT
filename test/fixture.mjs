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

/**
 * An audio-only file for the music bed. Written as a WAV by hand: it needs no
 * encoder extension, and decodeAudioData accepts it everywhere.
 */
export function makeMusic({ seconds = 8, freq = 220, rate = 44_100 } = {}) {
  const frames = Math.floor(seconds * rate);
  const bytes = new ArrayBuffer(44 + frames * 2);
  const view = new DataView(bytes);
  const ascii = (at, text) => [...text].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + frames * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);        // PCM header size
  view.setUint16(20, 1, true);         // format: PCM
  view.setUint16(22, 1, true);         // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);  // byte rate
  view.setUint16(32, 2, true);         // block align
  view.setUint16(34, 16, true);        // bits per sample
  ascii(36, 'data');
  view.setUint32(40, frames * 2, true);

  for (let i = 0; i < frames; i++) {
    // A slow fade so the waveform has visible shape rather than a flat block.
    const envelope = 0.2 + 0.8 * Math.abs(Math.sin((Math.PI * i) / frames));
    const value = Math.sin((2 * Math.PI * freq * i) / rate) * envelope * 0.6;
    view.setInt16(44 + i * 2, value * 0x7fff, true);
  }
  return new File([bytes], 'bed.wav', { type: 'audio/wav' });
}
