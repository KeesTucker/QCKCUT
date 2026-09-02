import { test, expect } from '../lib/app.mjs';

const rows = (app) => app.page.locator('#projectList .project-row');
const name = (app) => app.page.locator('#projectName');

test('a first run opens a project ready to work in', async ({ app }) => {
  const s = await app.state();
  expect(s.project).not.toBeNull();
  await expect(name(app)).toHaveText('Untitled');
});

test('the project name renames in place', async ({ app }) => {
  await name(app).dblclick();
  await name(app).locator('input').fill('Holiday reel');
  await name(app).locator('input').press('Enter');

  await expect(name(app)).toHaveText('Holiday reel');
  await expect.poll(async () => (await app.state()).project.name).toBe('Holiday reel');

  await app.page.reload();
  await app.page.waitForFunction(() => window.S?.project);
  await expect(name(app)).toHaveText('Holiday reel');
});

test('New starts an empty project without disturbing the old one', async ({ app }) => {
  await app.add('land');
  await app.page.evaluate(() => { window.S.in = 0; window.S.out = 1; return window.addClip(); });
  const first = (await app.state()).project.id;

  await app.page.locator('#newProject').click();
  await expect.poll(async () => (await app.state()).project.id).not.toBe(first);

  const fresh = await app.state();
  expect(fresh.sources).toHaveLength(0);
  expect(fresh.clips).toHaveLength(0);

  // The first project still has its contents.
  await app.page.evaluate((id) => window.openProject(id), first);
  await expect.poll(async () => (await app.state()).sources.length).toBe(1);
  expect((await app.state()).clips).toHaveLength(1);
});

test('Open lists the projects and switches between them', async ({ app }) => {
  await app.page.evaluate(() => window.renameProject('First'));
  await app.page.evaluate(() => window.newProject('Second'));

  await app.page.locator('#openProject').click();
  await expect(rows(app)).toHaveCount(2);
  await expect(app.page.locator('#projectList .project-row.current')).toContainText('Second');

  await rows(app).filter({ hasText: 'First' }).click();
  await expect.poll(async () => (await app.state()).project.name).toBe('First');
});

test('deleting a project removes it and its media', async ({ app }) => {
  await app.page.evaluate(() => window.renameProject('Keep'));
  await app.page.evaluate(() => window.newProject('Bin'));
  await app.add('land');

  await app.page.locator('#openProject').click();
  await rows(app).filter({ hasText: 'Bin' }).locator('.item-drop').click();

  await expect.poll(async () => (await app.state()).project.name).toBe('Keep');
  const remaining = await app.page.evaluate(() => window.store.projects().map((p) => p.name));
  expect(remaining).toEqual(['Keep']);

  // Its database went with it.
  const left = await app.page.evaluate(async () =>
    (await indexedDB.databases()).filter((d) => d.name?.startsWith('qckcut-')).length);
  expect(left).toBe(1);
});

test('deleting the last project leaves a fresh one open', async ({ app }) => {
  const id = (await app.state()).project.id;
  await app.page.evaluate((x) => window.dropProject(x), id);

  const s = await app.state();
  expect(s.project).not.toBeNull();
  expect(s.project.id).not.toBe(id);
  expect(s.sources).toHaveLength(0);
});

test('media does not leak between projects', async ({ app }) => {
  await app.add('land');
  await app.page.evaluate(() => window.newProject('Empty'));

  const s = await app.state();
  expect(s.sources).toHaveLength(0);
  expect(s.timeline).toHaveLength(0);
  expect(s.music).toBeNull();
  // And the decoder pool was let go with it.
  expect(s.openDecoders).toBe(0);
});

test('the last project opened comes back on reload', async ({ app }) => {
  await app.page.evaluate(() => window.newProject('Second'));
  const id = (await app.state()).project.id;

  await app.page.reload();
  await app.page.waitForFunction(() => window.S?.project);
  expect((await app.state()).project.id).toBe(id);
});
