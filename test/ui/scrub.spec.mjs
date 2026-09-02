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
  await app.page.evaluate(() => window.markIn());
  await app.page.evaluate(() => { window.S.playhead = 2; });
  await app.page.evaluate(() => window.markOut());

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

// Regression: marking a clip leaves its range selected, and play used to jump
// back to that range's start whenever the playhead was past its out point. So
// scrubbing ahead and pressing play replayed the last clip, and scrubbing felt
// like it did nothing.
test('playing after scrubbing past a clip continues from the playhead', async ({ app }) => {
  await app.add('hd');                       // ten seconds
  await app.page.evaluate(() => window.seek(1));
  await app.page.keyboard.press('c');
  await app.page.evaluate(() => window.seek(3));
  await app.page.keyboard.press('c');        // clip is 1..3, and selected
  expect((await app.state()).clips).toHaveLength(1);

  await app.page.evaluate(() => window.seek(6));
  const result = await app.page.evaluate(async () => {
    const playing = window.play();
    await new Promise((r) => setTimeout(r, 500));
    window.pause();
    await playing;
    return window.S.playhead;
  });

  expect(result, 'playback jumped back to the clip').toBeGreaterThan(6);
});

test('playing inside a marked clip still stops at its out point', async ({ app }) => {
  await app.add('hd');
  await app.page.evaluate(() => window.seek(1));
  await app.page.keyboard.press('c');
  await app.page.evaluate(() => window.seek(2));
  await app.page.keyboard.press('c');        // clip is 1..2

  await app.page.evaluate(() => window.seek(1.2));
  const head = await app.page.evaluate(async () => {
    await window.play();
    return window.S.playhead;
  });
  expect(head).toBeCloseTo(2, 1);
});

test('scrubbing before the in point plays from there, not from in', async ({ app }) => {
  await app.add('hd');
  await app.page.evaluate(() => { window.S.in = 5; window.S.out = 7; });
  await app.page.evaluate(() => window.seek(1));

  const result = await app.page.evaluate(async () => {
    const playing = window.play();
    await new Promise((r) => setTimeout(r, 400));
    window.pause();
    await playing;
    return window.S.playhead;
  });
  expect(result).toBeGreaterThan(1);
  expect(result, 'it jumped to the in point').toBeLessThan(4);
});

test('playing from the very end restarts at the in point', async ({ app }) => {
  await app.add('land');                     // six seconds
  await app.page.evaluate(() => { window.S.in = 1; window.S.out = 2; });
  await app.page.evaluate(() => window.seek(6));

  const head = await app.page.evaluate(async () => {
    await window.play();
    return window.S.playhead;
  });
  expect(head).toBeCloseTo(2, 1);
});
