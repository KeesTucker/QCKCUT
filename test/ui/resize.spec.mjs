import { test, expect } from '../lib/app.mjs';

// Regression: resize used to call buildStrip() on every event. Each call spun
// up a CanvasSink, the decoder pool ran dry, the strip flickered as it was
// cleared and repainted, and playback then failed outright.
test('a resize storm triggers no decoding and keeps the tiles', async ({ app }) => {
  await app.add('land');
  const before = await app.state();

  const builds = await app.page.evaluate(async () => {
    let count = 0;
    const real = window.buildStrip;
    window.buildStrip = (...a) => { count++; return real(...a); };
    for (let i = 0; i < 200; i++) window.dispatchEvent(new Event('resize'));
    await new Promise((r) => setTimeout(r, 300));
    window.buildStrip = real;
    return count;
  });

  expect(builds, 'resize must re-blit from cache, never decode').toBe(0);
  const after = await app.state();
  expect(after.sources[0].thumbsDecoded).toBe(before.sources[0].thumbsDecoded);
  expect(after.openDecoders).toBeLessThanOrEqual(before.openDecoders);
});

test('playback still works after a resize storm', async ({ app }) => {
  await app.add('land');
  await app.page.evaluate(async () => {
    for (let i = 0; i < 200; i++) window.dispatchEvent(new Event('resize'));
    await new Promise((r) => setTimeout(r, 300));
  });

  const result = await app.page.evaluate(async () => {
    window.S.in = 0;
    window.S.out = 1;
    window.S.playhead = 0;
    const started = performance.now();
    let error = null;
    await window.play().catch((e) => { error = String(e); });
    return { error, playhead: window.S.playhead, elapsed: (performance.now() - started) / 1000 };
  });

  expect(result.error).toBeNull();
  expect(result.playhead).toBeCloseTo(1, 1);
  // Paced to the wall clock, not decoded as fast as possible.
  expect(result.elapsed).toBeGreaterThan(0.7);
});

test('resizing redraws the strip at the new width', async ({ app }) => {
  await app.add('land');
  await app.page.setViewportSize({ width: 900, height: 800 });
  await expect.poll(async () => {
    const { strip, timeline } = await app.page.evaluate(() => ({
      strip: document.getElementById('strip').width,
      timeline: document.getElementById('timeline').clientWidth * (window.devicePixelRatio || 1),
    }));
    return Math.abs(strip - timeline) <= 1;
  }).toBe(true);
});
