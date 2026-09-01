import { test, expect } from '../lib/app.mjs';

test('a clip is a reference to the source, not a copy', async ({ app }) => {
  await app.add('land');
  await app.page.evaluate(() => { window.S.in = 1.5; window.S.out = 3.5; });
  const clip = await app.page.evaluate(() => window.addClip());

  const s = await app.state();
  expect(s.clips).toHaveLength(1);
  expect(clip.sourceId).toBe(s.activeId);
  expect(clip.in).toBeCloseTo(1.5, 3);
  expect(clip.out).toBeCloseTo(3.5, 3);
  // No pixels were copied: a clip is two numbers and a reference.
  expect(Object.keys(clip).sort()).toEqual(['id', 'in', 'label', 'out', 'sourceId']);
  await expect(app.rows('clipList')).toHaveCount(1);
});

test('pressing C clips from the current in and out', async ({ app }) => {
  await app.add('land');
  await app.page.evaluate(() => { window.S.in = 1; window.S.out = 2; });
  await app.page.locator('#timeline').click({ position: { x: 5, y: 5 } });
  await app.page.evaluate(() => { window.S.in = 1; window.S.out = 2; });
  await app.page.keyboard.press('c');
  await expect(app.rows('clipList')).toHaveCount(1);
});

test('clips accumulate and are labelled per source', async ({ app }) => {
  await app.add('land');
  for (const [start, end] of [[0, 1], [2, 3], [4, 5]]) {
    await app.page.evaluate(([a, b]) => { window.S.in = a; window.S.out = b; return window.addClip(); }, [start, end]);
  }
  const s = await app.state();
  expect(s.clips.map((c) => c.label)).toEqual(['land 1', 'land 2', 'land 3']);
});

test('selecting a clip restores its source and range', async ({ app }) => {
  await app.add('land', 'port');
  const ids = (await app.state()).sources;
  const landId = ids.find((s) => s.name === 'land.mp4').id;

  await app.page.evaluate((id) => window.setActive(id), landId);
  await app.page.evaluate(() => { window.S.in = 2; window.S.out = 4; return window.addClip(); });

  // Move away, then come back via the clip.
  await app.page.evaluate((id) => window.setActive(id), ids.find((s) => s.name === 'port.mp4').id);
  expect((await app.state()).width).toBe(360);

  await app.rows('clipList').first().click();
  // selectClip awaits setActive, which assigns activeId before the range, so
  // poll on the last field it writes rather than the first.
  await expect.poll(async () => {
    const { activeId, in: start, out } = await app.state();
    return activeId === landId && Math.abs(start - 2) < 0.01 && Math.abs(out - 4) < 0.01;
  }).toBe(true);
  const s = await app.state();
  expect(s.playhead).toBeCloseTo(2, 1);
});

test('adjusting the range while a clip is selected edits that clip', async ({ app }) => {
  await app.add('land');
  await app.page.evaluate(() => { window.S.in = 1; window.S.out = 2; return window.addClip(); });

  await app.page.evaluate(() => { window.S.playhead = 3; });
  await app.page.locator('#markOut').click();

  await expect.poll(async () => (await app.state()).clips[0].out).toBeCloseTo(3, 1);
  // Still one clip: adjusting edits in place rather than creating another.
  expect((await app.state()).clips).toHaveLength(1);
});

test('deleting a clip leaves the source untouched', async ({ app }) => {
  await app.add('land');
  await app.page.evaluate(() => window.addClip());
  await app.rows('clipList').first().hover();
  await app.rows('clipList').first().locator('.item-drop').click();

  await expect(app.rows('clipList')).toHaveCount(0);
  const s = await app.state();
  expect(s.sources).toHaveLength(1);
  expect(s.duration).toBeCloseTo(6, 1);
});

test('a too-short range does not become a clip', async ({ app }) => {
  await app.add('land');
  const clip = await app.page.evaluate(() => {
    window.S.in = 1;
    window.S.out = 1.01;
    return window.addClip();
  });
  expect(clip).toBeNull();
  await expect(app.rows('clipList')).toHaveCount(0);
});
