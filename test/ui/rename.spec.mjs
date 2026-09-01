import { test, expect } from '../lib/app.mjs';

const clipName = (app) => app.page.locator('#clipList .item-name').first();
const sourceName = (app) => app.page.locator('#sourceList .item-name').first();
const itemName = (app) => app.page.locator('#track .track-item-name').first();

async function withClip(app) {
  await app.add('land');
  await app.page.evaluate(() => { window.S.in = 1; window.S.out = 3; return window.addClip(); });
}

test('double-clicking a clip name renames it', async ({ app }) => {
  await withClip(app);
  await expect(clipName(app)).toHaveText('land 1');

  await clipName(app).dblclick();
  const field = clipName(app).locator('input');
  await expect(field).toBeFocused();
  await field.fill('the good bit');
  await field.press('Enter');

  await expect(clipName(app)).toHaveText('the good bit');
  await expect.poll(async () => (await app.state()).clips[0].label).toBe('the good bit');
});

test('Escape puts the old name back', async ({ app }) => {
  await withClip(app);
  await clipName(app).dblclick();
  await clipName(app).locator('input').fill('nope');
  await clipName(app).locator('input').press('Escape');

  await expect(clipName(app)).toHaveText('land 1');
  expect((await app.state()).clips[0].label).toBe('land 1');
});

test('clicking away keeps the edit', async ({ app }) => {
  await withClip(app);
  await clipName(app).dblclick();
  await clipName(app).locator('input').fill('kept on blur');
  await app.page.locator('#stage').click({ position: { x: 20, y: 20 } });

  await expect.poll(async () => (await app.state()).clips[0].label).toBe('kept on blur');
});

test('an empty name is refused', async ({ app }) => {
  await withClip(app);
  await clipName(app).dblclick();
  await clipName(app).locator('input').fill('   ');
  await clipName(app).locator('input').press('Enter');

  await expect(clipName(app)).toHaveText('land 1');
  expect((await app.state()).clips[0].label).toBe('land 1');
});

test('typing a name does not fire app shortcuts', async ({ app }) => {
  await withClip(app);
  await clipName(app).dblclick();
  // c, i, o and m would otherwise mark, set in/out and mute.
  await clipName(app).locator('input').fill('');
  await app.page.keyboard.type('comic');
  await clipName(app).locator('input').press('Enter');

  const s = await app.state();
  expect(s.clips).toHaveLength(1);
  expect(s.clips[0].label).toBe('comic');
  expect(s.marking).toBeNull();
  expect(s.muted).toBe(false);
});

test('sources rename too', async ({ app }) => {
  await app.add('land');
  await sourceName(app).dblclick();
  await sourceName(app).locator('input').fill('holiday.mp4');
  await sourceName(app).locator('input').press('Enter');

  await expect.poll(async () => (await app.state()).sources[0].name).toBe('holiday.mp4');
  await expect(app.page.locator('#viewName')).toHaveText('holiday.mp4');
});

test('sequence items rename independently of the clip they came from', async ({ app }) => {
  await withClip(app);
  const clipId = (await app.state()).clips[0].id;
  await app.page.evaluate((id) => window.addToSequence('clip', id, 0), clipId);

  await itemName(app).dblclick();
  await itemName(app).locator('input').fill('opening shot');
  await itemName(app).locator('input').press('Enter');

  const s = await app.state();
  expect(s.timeline[0].label).toBe('opening shot');
  // The clip it was copied from is untouched: an item is its own reference.
  expect(s.clips[0].label).toBe('land 1');
});

test('a rename survives a reload', async ({ app }) => {
  await withClip(app);
  await clipName(app).dblclick();
  await clipName(app).locator('input').fill('keeper');
  await clipName(app).locator('input').press('Enter');
  await expect.poll(async () => (await app.state()).clips[0].label).toBe('keeper');

  await app.page.reload();
  await expect.poll(async () => (await app.state()).clips.length, { timeout: 20_000 }).toBe(1);
  expect((await app.state()).clips[0].label).toBe('keeper');
});

test('a background update does not clobber a name being typed', async ({ app }) => {
  await withClip(app);
  await clipName(app).dblclick();
  await clipName(app).locator('input').fill('half typed');

  // Something else re-renders the panel while the caret is in the field.
  await app.page.evaluate(() => window.selectClip(window.S.clips[0].id));

  await expect(clipName(app).locator('input')).toBeFocused();
  await expect(clipName(app).locator('input')).toHaveValue('half typed');
});
