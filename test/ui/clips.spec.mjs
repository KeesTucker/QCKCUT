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

test('two presses of C mark a clip', async ({ app }) => {
  await app.add('land');
  await app.page.evaluate(() => window.seek(1));
  await app.page.keyboard.press('c');

  // The first press only arms it; nothing is kept yet.
  await expect(app.rows('clipList')).toHaveCount(0);
  expect((await app.state()).marking.at).toBeCloseTo(1, 2);

  await app.page.evaluate(() => window.seek(3));
  await app.page.keyboard.press('c');

  await expect(app.rows('clipList')).toHaveCount(1);
  const s = await app.state();
  expect(s.marking).toBeNull();
  expect(s.clips[0].in).toBeCloseTo(1, 1);
  expect(s.clips[0].out).toBeCloseTo(3, 1);
});

test('the selection follows the playhead while marking', async ({ app }) => {
  await app.add('land');
  await app.page.evaluate(() => window.seek(2));
  await app.page.keyboard.press('c');

  await app.page.evaluate(() => window.seek(4));
  let s = await app.state();
  expect(s.in).toBeCloseTo(2, 1);
  expect(s.out).toBeCloseTo(4, 1);

  // Marking backwards works too: the range is the span, not the order.
  await app.page.evaluate(() => window.seek(0.5));
  s = await app.state();
  expect(s.in).toBeCloseTo(0.5, 1);
  expect(s.out).toBeCloseTo(2, 1);
});

test('Esc cancels a mark and restores the range', async ({ app }) => {
  await app.add('land');
  await app.page.evaluate(() => { window.S.in = 1; window.S.out = 5; return window.seek(2); });
  await app.page.keyboard.press('c');
  await app.page.evaluate(() => window.seek(3));
  expect((await app.state()).out).toBeCloseTo(3, 1);

  await app.page.keyboard.press('Escape');

  const s = await app.state();
  expect(s.marking).toBeNull();
  expect(s.in).toBeCloseTo(1, 1);
  expect(s.out).toBeCloseTo(5, 1);
  await expect(app.rows('clipList')).toHaveCount(0);
});

test('a mark shorter than the minimum is dropped, not kept', async ({ app }) => {
  await app.add('land');
  await app.page.evaluate(() => window.seek(2));
  await app.page.keyboard.press('c');
  await app.page.keyboard.press('c');   // same spot: zero length

  await expect(app.rows('clipList')).toHaveCount(0);
  expect((await app.state()).marking).toBeNull();
});

test('switching source abandons a mark', async ({ app }) => {
  await app.add('land', 'hd');
  const land = (await app.state()).sources.find((x) => x.name === 'land.mp4').id;
  await app.page.evaluate((id) => window.setActive(id), land);
  await app.page.evaluate(() => window.seek(1));
  await app.page.keyboard.press('c');
  expect((await app.state()).marking).not.toBeNull();

  const hd = (await app.state()).sources.find((x) => x.name === 'hd.mp4').id;
  await app.page.evaluate((id) => window.setActive(id), hd);

  // A mark belongs to the source it was started on.
  expect((await app.state()).marking).toBeNull();
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
