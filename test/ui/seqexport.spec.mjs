import { test, expect } from '../lib/app.mjs';

async function build(app, ...specs) {
  await app.add(...new Set(specs.map((s) => s.clip)));
  for (const { clip, in: start, out } of specs) {
    await app.page.evaluate(async ([name, a, b]) => {
      const source = window.S.sources.find((s) => s.name === `${name}.mp4`);
      await window.setActive(source.id);
      window.S.in = a;
      window.S.out = b;
      await window.appendRange();
    }, [clip, start, out]);
  }
}

/** Render the sequence and probe the resulting file. */
async function render(app, probeTimes = []) {
  return app.page.evaluate(async (times) => {
    let captured = null;
    const realCreate = URL.createObjectURL;
    const realClick = HTMLAnchorElement.prototype.click;
    let filename = null;
    URL.createObjectURL = function (b) { captured = b; return realCreate.call(URL, b); };
    HTMLAnchorElement.prototype.click = function () { filename = this.download; };
    try {
      await window.exportSequence();
    } finally {
      URL.createObjectURL = realCreate;
      HTMLAnchorElement.prototype.click = realClick;
    }

    const mb = await import('/test/mediabunny.mjs');
    const input = new mb.Input({ source: new mb.BlobSource(captured), formats: mb.ALL_FORMATS });
    const video = await input.getPrimaryVideoTrack();
    const audio = await input.getPrimaryAudioTrack();
    const sink = new mb.VideoSampleSink(video);
    const frames = [];
    for (const t of times) {
      const sample = await sink.getSample(t);
      frames.push(sample ? sample.timestamp : null);
      sample?.close();
    }
    const out = {
      filename,
      bytes: captured.size,
      format: (await input.getFormat()).name,
      duration: await input.computeDuration(),
      videoDuration: await video.computeDuration(),
      width: await video.getDisplayWidth(),
      height: await video.getDisplayHeight(),
      hasAudio: !!audio,
      audioDuration: audio ? await audio.computeDuration() : null,
      frames,
    };
    input.dispose();
    return out;
  }, probeTimes);
}

test('a sequence renders to one file as long as its parts', async ({ app }) => {
  test.setTimeout(120_000);
  await build(app, { clip: 'land', in: 0, out: 2 }, { clip: 'land', in: 3, out: 5 });

  const result = await render(app, [0, 1.5, 3.5]);
  expect(result.format).toBe('MP4');
  expect(result.videoDuration).toBeCloseTo(4, 1);
  expect(result.filename).toBe('sequence.mp4');
  expect(result.bytes).toBeGreaterThan(1000);
  // Decodable throughout, including past the seam at 2s.
  expect(result.frames.every((f) => f !== null)).toBe(true);
  expect(result.frames[2]).toBeGreaterThan(3);
});

test('the output takes the first item’s dimensions', async ({ app }) => {
  test.setTimeout(120_000);
  // Portrait first, then landscape: the landscape item must be letterboxed
  // into the portrait frame rather than resizing the file midway.
  await build(app, { clip: 'port', in: 0, out: 1 }, { clip: 'hd', in: 0, out: 1 });

  const result = await render(app, [0, 1.5]);
  expect([result.width, result.height]).toEqual([360, 640]);
  expect(result.videoDuration).toBeCloseTo(2, 1);
  expect(result.frames.every((f) => f !== null)).toBe(true);
});

test('audio is carried through and concatenated', async ({ app }) => {
  test.setTimeout(120_000);
  await build(app, { clip: 'tone', in: 0, out: 2 }, { clip: 'tone', in: 2, out: 4 });

  const result = await render(app);
  expect(result.hasAudio).toBe(true);
  expect(result.audioDuration).toBeCloseTo(4, 0);
});

test('a silent item leaves silence rather than dropping the track', async ({ app }) => {
  test.setTimeout(120_000);
  // land has no audio; tone does. The mix must still span both so the picture
  // and sound stay in step.
  await build(app, { clip: 'tone', in: 0, out: 2 }, { clip: 'land', in: 0, out: 2 });

  const result = await render(app);
  expect(result.hasAudio).toBe(true);
  expect(result.audioDuration).toBeCloseTo(4, 0);
  // The picture is exact. The container runs a little longer because AAC pads
  // to whole 1024-sample frames and adds encoder priming, so the audio track
  // slightly outlasts the video and the container reports the longer of the two.
  expect(result.videoDuration).toBeCloseTo(4, 1);
  expect(result.duration).toBeGreaterThanOrEqual(result.videoDuration);
  expect(result.duration).toBeLessThan(4.2);
});

test('duration is exactly the sum of the parts across many cuts', async ({ app }) => {
  test.setTimeout(120_000);
  await build(app,
    { clip: 'land', in: 0, out: 0.5 },
    { clip: 'land', in: 1, out: 1.5 },
    { clip: 'land', in: 2, out: 2.5 },
    { clip: 'land', in: 3, out: 3.5 },
    { clip: 'land', in: 4, out: 4.5 });

  const result = await render(app);
  // Frames are clamped to each item's boundary, so drift does not accumulate.
  expect(result.videoDuration).toBeCloseTo(2.5, 1);
});

test('a sequence with no audio anywhere gets no audio track', async ({ app }) => {
  test.setTimeout(120_000);
  await build(app, { clip: 'land', in: 0, out: 1 }, { clip: 'port', in: 0, out: 1 });

  const result = await render(app);
  expect(result.hasAudio).toBe(false);
  expect(result.videoDuration).toBeCloseTo(2, 1);
});

test('the app is usable again after rendering a sequence', async ({ app }) => {
  test.setTimeout(120_000);
  await build(app, { clip: 'land', in: 0, out: 1 });
  await render(app);

  await expect(app.page.locator('#exportBtn')).toBeEnabled();
  const ts = await app.page.evaluate(async () => {
    const source = window.S.sources.find((s) => s.id === window.S.activeId);
    const sample = await window.media.using(source, ({ sink }) => sink.getSample(2));
    const t = sample?.timestamp ?? null;
    sample?.close();
    return t;
  });
  expect(ts).not.toBeNull();
});

// The audio mix is laid out on exact item boundaries. If the picture were only
// frame-quantised the two would drift apart by up to a frame per cut, so each
// item's last frame is held until exactly its boundary.
test('picture and sound stay locked to the same boundaries', async ({ app }) => {
  test.setTimeout(120_000);
  // Boundaries deliberately off the 30fps grid.
  await build(app,
    { clip: 'tone', in: 0, out: 1.17 },
    { clip: 'land', in: 0.4, out: 1.63 },
    { clip: 'tone', in: 2.1, out: 3.29 });

  const expected = 1.17 + 1.23 + 1.19;
  const result = await render(app);
  expect(result.videoDuration).toBeCloseTo(expected, 2);
  expect(result.hasAudio).toBe(true);
});

// Regression: audio is mixed before any picture is touched, and nothing
// reported during it, so a long sequence sat on a dead-looking button for
// seconds before the first "rendering" appeared.
test('export says something immediately, and names both phases', async ({ app }) => {
  test.setTimeout(120_000);
  await build(app, { clip: 'tone', in: 0, out: 1.5 });   // tone carries audio

  const seen = await app.page.evaluate(async () => {
    const label = document.getElementById('exportLabel');
    const seen = [];
    const record = () => {
      const text = label.textContent;
      if (text && seen.at(-1) !== text) seen.push(text);
    };
    const timer = setInterval(record, 5);

    HTMLAnchorElement.prototype.click = function () {};
    document.getElementById('exportBtn').click();
    // Whatever it says, it must say it before yielding.
    const immediate = label.textContent;

    while (window.S.exporting) await new Promise((r) => setTimeout(r, 20));
    clearInterval(timer);
    return { immediate, seen, status: document.getElementById('status').textContent };
  });

  expect(seen.immediate, 'the button looked dead on click').not.toBe('');
  expect(seen.seen.some((t) => t.startsWith('Mixing audio'))).toBe(true);
  expect(seen.seen.some((t) => t.startsWith('Rendering'))).toBe(true);
  expect(seen.status).toMatch(/^rendered /);

  // Audio is mixed first, so its progress must appear before the picture's.
  const firstAudio = seen.seen.findIndex((t) => t.startsWith('Mixing audio'));
  const firstVideo = seen.seen.findIndex((t) => t.startsWith('Rendering'));
  expect(firstAudio).toBeLessThan(firstVideo);
});

test('a silent sequence still reports before it starts', async ({ app }) => {
  test.setTimeout(120_000);
  await build(app, { clip: 'land', in: 0, out: 1 });     // land has no audio

  const immediate = await app.page.evaluate(() => {
    HTMLAnchorElement.prototype.click = function () {};
    document.getElementById('exportBtn').click();
    return document.getElementById('exportLabel').textContent;
  });
  expect(immediate).not.toBe('');
  await expect.poll(async () => app.page.evaluate(() => window.S.exporting), { timeout: 60_000 })
    .toBe(false);
});

// Regression: samples(in, out) yields the frame *containing* the in point,
// which can start before it. For the first item that made `at` negative and the
// muxer refused it with "timestamp must be a non-negative number". Every
// in-point here deliberately falls between frames at 30fps.
test('in points that are not on a frame boundary still render', async ({ app }) => {
  test.setTimeout(120_000);
  await build(app,
    { clip: 'land', in: 1.137, out: 2.611 },
    { clip: 'hd', in: 0.409, out: 1.283 });

  const result = await render(app, [0, 1.2, 2]);
  expect(result.videoDuration).toBeCloseTo(1.474 + 0.874, 1);
  expect(result.frames.every((f) => f !== null)).toBe(true);
  expect(result.frames[0]).toBeGreaterThanOrEqual(0);
});

test('a first item starting mid-frame does not produce a negative timestamp', async ({ app }) => {
  test.setTimeout(120_000);
  // 0.017s is half a frame in at 30fps, so the containing frame starts at 0.
  await build(app, { clip: 'land', in: 0.017, out: 1.017 });
  const result = await render(app, [0]);
  expect(result.frames[0]).toBe(0);
  expect(result.videoDuration).toBeCloseTo(1, 1);
});
