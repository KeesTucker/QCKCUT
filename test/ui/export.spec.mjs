import { test, expect } from '../lib/app.mjs';

test('export writes a trimmed, decodable mp4', async ({ app }) => {
  test.setTimeout(60_000);
  await app.add('hd');

  const result = await app.page.evaluate(async () => {
    window.S.in = 2;
    window.S.out = 6;

    // Capture the blob instead of downloading it.
    let captured = null;
    const realCreate = URL.createObjectURL;
    const realClick = HTMLAnchorElement.prototype.click;
    let filename = null;
    URL.createObjectURL = function (b) { captured = b; return realCreate.call(URL, b); };
    HTMLAnchorElement.prototype.click = function () { filename = this.download; };
    try {
      await window.exportRange();
    } finally {
      URL.createObjectURL = realCreate;
      HTMLAnchorElement.prototype.click = realClick;
    }

    const mb = await import('/test/mediabunny.mjs');
    const input = new mb.Input({ source: new mb.BlobSource(captured), formats: mb.ALL_FORMATS });
    const track = await input.getPrimaryVideoTrack();
    const sink = new mb.VideoSampleSink(track);
    const first = await sink.getSample(0);
    const last = await sink.getSample(3.9);
    const out = {
      filename,
      bytes: captured.size,
      format: (await input.getFormat()).name,
      duration: await input.computeDuration(),
      width: await track.getDisplayWidth(),
      height: await track.getDisplayHeight(),
      firstTs: first?.timestamp ?? null,
      lastTs: last?.timestamp ?? null,
    };
    first?.close();
    last?.close();
    input.dispose();
    return out;
  });

  expect(result.format).toBe('MP4');
  expect(result.duration).toBeCloseTo(4, 1);
  expect([result.width, result.height]).toEqual([1280, 720]);
  expect(result.bytes).toBeGreaterThan(1000);
  expect(result.filename).toBe('hd-clip.mp4');
  // The export is re-timed to start at zero, not offset by the in point.
  expect(result.firstTs).toBeCloseTo(0, 1);
  expect(result.lastTs).toBeGreaterThan(3.5);
});

test('the app is usable again after an export', async ({ app }) => {
  test.setTimeout(60_000);
  await app.add('land');
  await app.page.evaluate(async () => {
    window.S.in = 1;
    window.S.out = 3;
    HTMLAnchorElement.prototype.click = function () {};
    await window.exportRange();
  });

  await expect(app.page.locator('#exportBtn')).toBeEnabled();
  const ts = await app.page.evaluate(async () => {
    const source = window.S.sources.find((x) => x.id === window.S.activeId);
    const sample = await window.media.using(source, ({ sink }) => sink.getSample(2));
    const t = sample?.timestamp ?? null;
    sample?.close();
    return t;
  });
  expect(ts).not.toBeNull();
});

test('a clip exports under its own label', async ({ app }) => {
  await app.add('land');
  await app.page.evaluate(() => { window.S.in = 1; window.S.out = 2; return window.addClip(); });
  const name = await app.page.evaluate(() => {
    const clip = window.S.clips[0];
    const source = window.S.sources.find((s) => s.id === clip.sourceId);
    return window.exportName(source, clip);
  });
  expect(name).toBe('land-1.mp4');
});

test('an untitled range never exports over its source name', async ({ app }) => {
  await app.add('land');
  const name = await app.page.evaluate(() => window.exportName(window.S.sources[0], undefined));
  expect(name).toBe('land-clip.mp4');
  expect(name).not.toBe('land.mp4');
});
