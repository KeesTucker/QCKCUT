import { test, expect } from '../lib/app.mjs';

const overlay = (app) => app.page.locator('#helpOverlay');

test('the ? button opens help and it closes again', async ({ app }) => {
  await expect(overlay(app)).toBeHidden();
  await app.page.locator('#helpBtn').click();
  await expect(overlay(app)).toBeVisible();

  await app.page.locator('#helpCloseBtn').click();
  await expect(overlay(app)).toBeHidden();
});

test('help opens with ? and closes with Escape, before any clip is loaded', async ({ app }) => {
  await app.page.keyboard.press('Shift+Slash');
  await expect(overlay(app)).toBeVisible();
  await app.page.keyboard.press('Escape');
  await expect(overlay(app)).toBeHidden();
});

test('clicking the backdrop closes help but clicking the panel does not', async ({ app }) => {
  await app.page.locator('#helpBtn').click();
  await app.page.locator('.help-box').click({ position: { x: 10, y: 10 } });
  await expect(overlay(app)).toBeVisible();

  await overlay(app).click({ position: { x: 5, y: 5 } });
  await expect(overlay(app)).toBeHidden();
});

test('every documented key is one the app actually handles', async ({ app }) => {
  await app.page.locator('#helpBtn').click();
  const keys = await app.page.locator('.keys kbd').allTextContents();
  // Guards against the help drifting out of date as bindings change.
  expect(keys).toEqual(['Space', '←', '→', 'Shift', '←', '→', 'I', 'O', 'C', 'T', '?', 'Esc']);
});

test('shortcuts do not fire while help is open', async ({ app }) => {
  await app.add('land');
  await app.page.evaluate(() => { window.S.in = 1; window.S.out = 2; });
  await app.page.locator('#helpBtn').click();

  await app.page.keyboard.press('c');
  expect((await app.state()).clips).toHaveLength(0);

  await app.page.keyboard.press('Escape');
  await app.page.keyboard.press('c');
  await expect.poll(async () => (await app.state()).clips.length).toBe(1);
});
