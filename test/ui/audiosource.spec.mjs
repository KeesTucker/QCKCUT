import { test, expect } from '../lib/app.mjs';

async function addAudio(app, name = 'bed.wav') {
  await app.page.evaluate(async (n) => {
    const blob = await (await fetch('/test/media/bed.wav')).blob();
    await window.addSource(new File([blob], n, { type: 'audio/wav' }));
  }, name);
  await app.stripReady();
}

test('an audio file imports as a source with no dimensions', async ({ app }) => {
  await addAudio(app);
  const s = await app.state();
  expect(s.sources).toHaveLength(1);
  expect(s.sources[0].kind).toBe('audio');
  expect(s.sources[0].duration).toBeCloseTo(8, 0);
  expect(s.kind).toBe('audio');
  expect([s.width, s.height]).toEqual([0, 0]);
});

test('its filmstrip is a waveform rather than tiles', async ({ app }) => {
  await addAudio(app);
  const drawn = await app.page.evaluate(() => {
    const source = window.S.sources[0];
    const canvas = document.getElementById('strip');
    const ctx = canvas.getContext('2d');
    const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let lit = 0;
    for (let i = 0; i < data.length; i += 4) {
      // The waveform is drawn blue; video tiles never are.
      if (data[i + 2] > 150 && data[i] < 180) lit++;
    }
    return { lit, peaks: source.peaks?.length ?? 0, thumbs: source.thumbs.length };
  });
  expect(drawn.peaks).toBeGreaterThan(100);
  expect(drawn.lit).toBeGreaterThan(200);
});

test('scrubbing and playing an audio source work without frames', async ({ app }) => {
  await addAudio(app);
  await app.page.evaluate(() => window.seek(3));
  expect((await app.state()).playhead).toBeCloseTo(3, 1);

  const result = await app.page.evaluate(async () => {
    window.S.in = 0;
    window.S.out = 1;
    window.S.playhead = 0;
    const started = performance.now();
    let error = null;
    await window.play().catch((e) => { error = String(e); });
    return { error, head: window.S.playhead, elapsed: (performance.now() - started) / 1000 };
  });
  expect(result.error).toBeNull();
  expect(result.head).toBeCloseTo(1, 1);
  expect(result.elapsed).toBeGreaterThan(0.7);
});

test('an audio source can be clipped like any other', async ({ app }) => {
  await addAudio(app);
  await app.page.evaluate(() => window.seek(1));
  await app.page.keyboard.press('c');
  await app.page.evaluate(() => window.seek(4));
  await app.page.keyboard.press('c');

  await expect(app.rows('clipList')).toHaveCount(1);
  const s = await app.state();
  expect(s.clips[0].in).toBeCloseTo(1, 1);
  expect(s.clips[0].out).toBeCloseTo(4, 1);
});

test('an audio clip can go on the sequence', async ({ app }) => {
  await addAudio(app);
  await app.page.evaluate(async () => {
    window.S.in = 1;
    window.S.out = 3;
    await window.appendRange();
  });

  await expect(app.page.locator('#track .track-item.audio')).toHaveCount(1);
  const s = await app.state();
  expect(s.sequenceDuration).toBeCloseTo(2, 2);
});

test('a mixed sequence takes its shape from the first item with pictures', async ({ app }) => {
  await app.add('port');
  await addAudio(app);

  // Audio first, then video: the audio item has no dimensions to offer.
  await app.page.evaluate(async () => {
    const sound = window.S.sources.find((s) => s.kind === 'audio');
    await window.setActive(sound.id);
    window.S.in = 0;
    window.S.out = 1;
    await window.appendRange();

    const video = window.S.sources.find((s) => s.kind === 'video');
    await window.setActive(video.id);
    window.S.in = 0;
    window.S.out = 1;
    await window.appendRange();
  });

  const shape = await app.page.evaluate(() =>
    window.sequenceShape(window.sequence.layout(window.S.timeline)));
  expect(shape).toEqual({ width: 360, height: 640 });
});

test('a sequence of only audio still has a size', async ({ app }) => {
  await addAudio(app);
  await app.page.evaluate(async () => {
    window.S.in = 0;
    window.S.out = 1;
    await window.appendRange();
  });
  const shape = await app.page.evaluate(() =>
    window.sequenceShape(window.sequence.layout(window.S.timeline)));
  expect(shape).toEqual({ width: 1280, height: 720 });
});

test('sequence playback crosses from video into audio', async ({ app }) => {
  await app.add('land');
  await addAudio(app);
  await app.page.evaluate(async () => {
    const video = window.S.sources.find((s) => s.kind === 'video');
    await window.setActive(video.id);
    window.S.in = 0;
    window.S.out = 0.8;
    await window.appendRange();

    const sound = window.S.sources.find((s) => s.kind === 'audio');
    await window.setActive(sound.id);
    window.S.in = 0;
    window.S.out = 0.8;
    await window.appendRange();
  });

  const result = await app.page.evaluate(async () => {
    let error = null;
    await window.playSequence().catch((e) => { error = String(e); });
    return { error, head: window.S.seqPlayhead };
  });
  expect(result.error).toBeNull();
  expect(result.head).toBeCloseTo(1.6, 1);
});

test('an audio item renders as black and keeps its place in the export', async ({ app }) => {
  test.setTimeout(120_000);
  await app.add('land');
  await addAudio(app);
  await app.page.evaluate(async () => {
    const video = window.S.sources.find((s) => s.kind === 'video');
    await window.setActive(video.id);
    window.S.in = 0;
    window.S.out = 1;
    await window.appendRange();

    const sound = window.S.sources.find((s) => s.kind === 'audio');
    await window.setActive(sound.id);
    window.S.in = 0;
    window.S.out = 1;
    await window.appendRange();
  });

  const result = await app.page.evaluate(async () => {
    let captured = null;
    const realCreate = URL.createObjectURL;
    URL.createObjectURL = function (b) { captured = b; return realCreate.call(URL, b); };
    HTMLAnchorElement.prototype.click = function () {};
    await window.exportSequence();
    URL.createObjectURL = realCreate;

    const mb = await import('/test/mediabunny.mjs');
    const input = new mb.Input({ source: new mb.BlobSource(captured), formats: mb.ALL_FORMATS });
    const video = await input.getPrimaryVideoTrack();
    const audioTrack = await input.getPrimaryAudioTrack();
    const sink = new mb.VideoSampleSink(video);

    // A frame from inside the audio item should be black.
    const sample = await sink.getSample(1.5);
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    const ctx = canvas.getContext('2d');
    sample.drawWithFit(ctx, { fit: 'contain' });
    const { data } = ctx.getImageData(0, 0, 32, 32);
    let brightest = 0;
    for (let i = 0; i < data.length; i += 4) brightest = Math.max(brightest, data[i], data[i + 1], data[i + 2]);
    sample.close();

    const out = {
      videoDuration: await video.computeDuration(),
      hasAudio: !!audioTrack,
      brightest,
    };
    input.dispose();
    return out;
  });

  // The audio item holds its two seconds rather than being skipped.
  expect(result.videoDuration).toBeCloseTo(2, 1);
  expect(result.brightest, 'the audio item should render black').toBeLessThan(20);
  expect(result.hasAudio).toBe(true);
});
