import { test, expect } from '../lib/app.mjs';

const controls = (app) => app.page.locator('#controls');
const play = (app) => app.page.locator('#playBtn');

test('the control box appears over the preview once a source is loaded', async ({ app }) => {
  await expect(controls(app)).toBeHidden();
  await app.add('land');
  await expect(controls(app)).toBeVisible();

  // It really is over the picture, not in the bar underneath.
  const { box, stage } = await app.page.evaluate(() => {
    const r = (sel) => {
      const { top, bottom, left, right } = document.querySelector(sel).getBoundingClientRect();
      return { top, bottom, left, right };
    };
    return { box: r('#controls'), stage: r('#stage') };
  });
  expect(box.bottom).toBeLessThanOrEqual(stage.bottom + 1);
  expect(box.top).toBeGreaterThanOrEqual(stage.top - 1);
  expect(box.left).toBeGreaterThan(stage.left);
});

test('the play button swaps glyph rather than label', async ({ app }) => {
  await app.add('land');
  await expect(play(app)).toHaveAttribute('data-state', 'paused');
  await expect(play(app).locator('.play')).toBeVisible();
  await expect(play(app).locator('.pause')).toBeHidden();

  await app.page.evaluate(() => { window.S.in = 0; window.S.out = 3; window.play(); });
  await expect(play(app)).toHaveAttribute('data-state', 'playing');
  await expect(play(app).locator('.pause')).toBeVisible();

  await app.page.evaluate(() => window.pause());
  await expect(play(app)).toHaveAttribute('data-state', 'paused');
});

test('the speed selector sets the rate', async ({ app }) => {
  await app.add('land');
  await app.page.locator('#rateSel').selectOption('2');
  expect((await app.state()).rate).toBe(2);
  await app.page.locator('#rateSel').selectOption('0.5');
  expect((await app.state()).rate).toBe(0.5);
});

test('a rate out of range is clamped', async ({ app }) => {
  await app.add('land');
  await app.page.evaluate(() => window.setRate(99));
  expect((await app.state()).rate).toBe(4);
  await app.page.evaluate(() => window.setRate(0));
  expect((await app.state()).rate).toBe(1);   // 0 is not a speed, so it resets
});

test('2x plays a range in about half the time', async ({ app }) => {
  await app.add('land');
  const timed = (rate) => app.page.evaluate(async (r) => {
    window.setRate(r);
    window.S.in = 0;
    window.S.out = 2;
    window.S.playhead = 0;
    const started = performance.now();
    await window.play();
    return (performance.now() - started) / 1000;
  }, rate);

  const normal = await timed(1);
  const fast = await timed(2);

  expect(normal).toBeGreaterThan(1.6);
  expect(fast).toBeLessThan(normal * 0.7);
  expect(fast).toBeGreaterThan(0.6);
});

test('half speed takes longer, and the playhead still lands on the out point', async ({ app }) => {
  await app.add('land');
  const result = await app.page.evaluate(async () => {
    window.setRate(0.5);
    window.S.in = 0;
    window.S.out = 1;
    window.S.playhead = 0;
    const started = performance.now();
    await window.play();
    return { elapsed: (performance.now() - started) / 1000, head: window.S.playhead };
  });
  expect(result.elapsed).toBeGreaterThan(1.5);
  expect(result.head).toBeCloseTo(1, 1);
});

test('audio is scheduled at the playback rate', async ({ app }) => {
  await app.add('tone');
  const rates = await app.page.evaluate(async () => {
    const ctx = window.audio.audio();
    const seen = [];
    const real = ctx.createBufferSource.bind(ctx);
    ctx.createBufferSource = () => {
      const node = real();
      seen.push(node);
      return node;
    };
    window.setRate(2);
    window.S.in = 0;
    window.S.out = 1;
    window.S.playhead = 0;
    await window.play();
    ctx.createBufferSource = real;
    return seen.map((n) => n.playbackRate.value);
  });
  expect(rates.length).toBeGreaterThan(0);
  expect(rates.every((r) => r === 2)).toBe(true);
});

test('the speed does not reach the export', async ({ app }) => {
  test.setTimeout(120_000);
  await app.add('land');
  await app.page.evaluate(() => window.setRate(4));

  const duration = await app.page.evaluate(async () => {
    window.S.in = 0;
    window.S.out = 2;
    let captured = null;
    const realCreate = URL.createObjectURL;
    URL.createObjectURL = function (b) { captured = b; return realCreate.call(URL, b); };
    HTMLAnchorElement.prototype.click = function () {};
    await window.exportRange();
    URL.createObjectURL = realCreate;

    const mb = await import('/test/mediabunny.mjs');
    const input = new mb.Input({ source: new mb.BlobSource(captured), formats: mb.ALL_FORMATS });
    const out = await input.computeDuration();
    input.dispose();
    return out;
  });
  // Speed is a preview control: the render is still two real seconds.
  expect(duration).toBeCloseTo(2, 1);
});
