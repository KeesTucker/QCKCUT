import { test, expect } from '../lib/app.mjs';

test('drop imports a clip and reads its dimensions', async ({ app }) => {
  await app.drop('land');
  const s = await app.state();
  expect(s.duration).toBeCloseTo(6, 1);
  expect([s.width, s.height]).toEqual([640, 360]);
  expect(s.in).toBe(0);
  expect(s.out).toBeCloseTo(6, 1);
});

test('dropping several files adds them all to Sources', async ({ app }) => {
  await app.drop('land', 'port', 'hd');
  await expect(app.rows('sourceList')).toHaveCount(3);
  const s = await app.state();
  expect(s.sources.map((x) => x.name)).toEqual(['land.mp4', 'port.mp4', 'hd.mp4']);
});

test('the filmstrip decodes a tile for every column', async ({ app }) => {
  await app.add('land');
  const s = await app.state();
  const active = s.sources.find((x) => x.id === s.activeId);
  expect(active.thumbCount).toBeGreaterThan(1);
  expect(active.thumbsDecoded).toBe(active.thumbCount);
});

test('controls are disabled until a clip is loaded', async ({ app }) => {
  for (const id of ['playBtn', 'exportBtn', 'markIn', 'markOut', 'addClip']) {
    await expect(app.page.locator(`#${id}`)).toBeDisabled();
  }
  await app.add('land');
  for (const id of ['playBtn', 'exportBtn', 'markIn', 'markOut', 'addClip']) {
    await expect(app.page.locator(`#${id}`)).toBeEnabled();
  }
});

test('selecting a source switches the preview to it', async ({ app }) => {
  await app.add('land', 'port');
  await app.rows('sourceList').first().click();
  await expect.poll(async () => (await app.state()).width).toBe(640);
  await app.rows('sourceList').nth(1).click();
  await expect.poll(async () => (await app.state()).width).toBe(360);
});
