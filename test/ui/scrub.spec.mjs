import { test, expect } from '../lib/app.mjs';

test('dragging the timeline scrubs to the pointer position', async ({ app }) => {
  await app.add('land');
  const timeline = app.page.locator('#timeline');
  const box = await timeline.boundingBox();

  await app.page.mouse.move(box.x + box.width * 0.25, box.y + box.height / 2);
  await app.page.mouse.down();
  await app.page.mouse.move(box.x + box.width * 0.75, box.y + box.height / 2, { steps: 20 });
  await app.page.mouse.up();

  const s = await app.state();
  expect(s.playhead).toBeCloseTo(6 * 0.75, 0);
});

test('a fast scrub coalesces instead of queueing every decode', async ({ app }) => {
  await app.add('hd');
  const elapsed = await app.page.evaluate(async () => {
    const duration = window.snapshot().duration;
    const started = performance.now();
    // 300 requests fired without awaiting: only the newest should survive.
    for (let i = 0; i < 300; i++) window.seek((i / 300) * duration);
    await window.seek(5);
    return performance.now() - started;
  });
  // Decoding all 300 would take many seconds.
  expect(elapsed).toBeLessThan(3000);
  const s = await app.state();
  expect(s.playhead).toBeCloseTo(5, 1);
});

test('seeking lands on the requested time across the whole clip', async ({ app }) => {
  await app.add('hd');
  const results = await app.page.evaluate(async (times) => {
    const out = [];
    for (const t of times) {
      const source = window.S.sources.find((x) => x.id === window.S.activeId);
      const sample = await window.media.using(source, ({ sink }) => sink.getSample(t));
      out.push({ want: t, got: sample?.timestamp ?? null });
      sample?.close();
    }
    return out;
  }, [0, 1.5, 4.25, 7.9, 9.5]);

  for (const { want, got } of results) {
    expect(got, `seek to ${want}`).not.toBeNull();
    // The frame containing the requested time, so at most one frame early.
    expect(got).toBeGreaterThan(want - 0.1);
    expect(got).toBeLessThanOrEqual(want + 0.001);
  }
});

test('mark in and out clamp to a valid range', async ({ app }) => {
  await app.add('land');
  await app.page.evaluate(() => { window.S.playhead = 4; });
  await app.page.locator('#markIn').click();
  await app.page.evaluate(() => { window.S.playhead = 2; });
  await app.page.locator('#markOut').click();

  const s = await app.state();
  expect(s.in).toBeCloseTo(4, 2);
  // out can never fall below in.
  expect(s.out).toBeGreaterThan(s.in);
});

test('keyboard steps a frame and jumps a second', async ({ app }) => {
  await app.add('land');
  await app.page.evaluate(() => window.seek(3));
  await app.page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await app.state()).playhead).toBeCloseTo(3 + 1 / 30, 2);
  await app.page.keyboard.press('Shift+ArrowLeft');
  await expect.poll(async () => (await app.state()).playhead).toBeCloseTo(3 + 1 / 30 - 1, 2);
});
