import { test, expect } from '../lib/app.mjs';

const toast = (app) => app.page.locator('#warnToast');

async function withSequence(app) {
  await app.add('land');
  await app.page.evaluate(() => { window.S.in = 0; window.S.out = 1; return window.appendRange(); });
}

test('marking from the sequence warns instead of cutting the wrong thing', async ({ app }) => {
  await withSequence(app);
  await app.page.evaluate(() => window.setView('sequence'));

  await app.page.keyboard.press('c');

  await expect(toast(app)).toBeVisible();
  await expect(app.page.locator('#warnTitle')).toHaveText('Showing the sequence');
  const s = await app.state();
  expect(s.marking, 'no mark should have been armed').toBeNull();
  expect(s.clips).toHaveLength(0);
});

test('the mark buttons warn too rather than acting on a hidden source', async ({ app }) => {
  await withSequence(app);
  const before = await app.state();
  await app.page.evaluate(() => window.setView('sequence'));

  await app.page.evaluate(() => window.markIn());
  await expect(toast(app)).toBeVisible();

  const after = await app.state();
  expect(after.in).toBeCloseTo(before.in, 3);
  expect(after.out).toBeCloseTo(before.out, 3);
});

test('going back to the source clears the warning and marking works', async ({ app }) => {
  await withSequence(app);
  await app.page.evaluate(() => window.setView('sequence'));
  await app.page.keyboard.press('c');
  await expect(toast(app)).toBeVisible();

  await app.page.evaluate(() => window.setView('source'));
  await expect(toast(app)).toBeHidden();

  await app.page.evaluate(() => window.seek(1));
  await app.page.keyboard.press('c');
  await app.page.evaluate(() => window.seek(3));
  await app.page.keyboard.press('c');
  await expect.poll(async () => (await app.state()).clips.length).toBe(1);
});

test('with no source at all the warning says to add one', async ({ app }) => {
  await app.page.evaluate(() => window.setView('sequence'));
  await app.page.evaluate(() => window.markClip());
  await expect(toast(app)).toBeVisible();
  await expect(app.page.locator('#warnMsg')).toContainText('Add a source first');
});

test('the warning fades on its own', async ({ app }) => {
  await withSequence(app);
  await app.page.evaluate(() => window.setView('sequence'));
  await app.page.keyboard.press('c');
  await expect(toast(app)).toBeVisible();
  // It clears itself rather than needing a dismiss.
  await expect(toast(app)).toBeHidden({ timeout: 8000 });
});
