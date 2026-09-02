import { test, expect } from '../lib/app.mjs';

const toast = (app) => app.page.locator('#warnToast');
const undo = (app) => app.page.evaluate(() => window.undo());
const redo = (app) => app.page.evaluate(() => window.redo());

test('undo steps back and says what it undid', async ({ app }) => {
  await app.add('land');
  await app.page.evaluate(() => { window.S.in = 0; window.S.out = 1; return window.addClip(); });
  expect((await app.state()).clips).toHaveLength(1);

  const label = await undo(app);

  expect(label).toBe('make clip');
  expect((await app.state()).clips).toHaveLength(0);
  await expect(toast(app)).toBeVisible();
  await expect(app.page.locator('#warnTitle')).toHaveText('Undone');
  await expect(app.page.locator('#warnMsg')).toHaveText('make clip');
});

test('redo puts it back', async ({ app }) => {
  await app.add('land');
  await app.page.evaluate(() => { window.S.in = 0; window.S.out = 1; return window.addClip(); });
  await undo(app);
  expect((await app.state()).clips).toHaveLength(0);

  const label = await redo(app);
  expect(label).toBe('make clip');
  expect((await app.state()).clips).toHaveLength(1);
  await expect(app.page.locator('#warnTitle')).toHaveText('Redone');
});

test('the keyboard drives it', async ({ app }) => {
  await app.add('land');
  await app.page.evaluate(() => { window.S.in = 0; window.S.out = 1; return window.appendRange(); });
  expect((await app.state()).timeline).toHaveLength(1);

  await app.page.keyboard.press('Meta+z');
  await expect.poll(async () => (await app.state()).timeline.length).toBe(0);

  await app.page.keyboard.press('Meta+Shift+z');
  await expect.poll(async () => (await app.state()).timeline.length).toBe(1);
});

test('it walks back through several edits in order', async ({ app }) => {
  await app.add('land');
  await app.page.evaluate(async () => {
    window.S.in = 0; window.S.out = 1; await window.appendRange();
    window.S.in = 2; window.S.out = 3; await window.appendRange();
    await window.moveInSequence(1, 0);
  });
  expect((await app.state()).timeline[0].in).toBeCloseTo(2, 1);

  expect(await undo(app)).toBe('reorder');
  expect((await app.state()).timeline[0].in).toBeCloseTo(0, 1);

  expect(await undo(app)).toBe('add to sequence');
  expect((await app.state()).timeline).toHaveLength(1);

  expect(await undo(app)).toBe('add to sequence');
  expect((await app.state()).timeline).toHaveLength(0);
});

test('a new edit throws away the redo stack', async ({ app }) => {
  await app.add('land');
  await app.page.evaluate(() => { window.S.in = 0; window.S.out = 1; return window.appendRange(); });
  await undo(app);
  expect((await app.state()).timeline).toHaveLength(0);

  await app.page.evaluate(() => { window.S.in = 3; window.S.out = 4; return window.appendRange(); });
  expect(await redo(app), 'the old future should be gone').toBeNull();
  expect((await app.state()).timeline).toHaveLength(1);
  expect((await app.state()).timeline[0].in).toBeCloseTo(3, 1);
});

test('undoing at the start does nothing rather than breaking', async ({ app }) => {
  await app.add('land');
  const depth = await app.page.evaluate(() => window.historyDepth());
  for (let i = 0; i < depth.past + 3; i++) await undo(app);
  expect(await undo(app)).toBeNull();
  const s = await app.state();
  expect(s.project).not.toBeNull();
});

test('deleting a source can be undone, media and all', async ({ app }) => {
  await app.add('land', 'port');
  await app.page.evaluate(async () => {
    window.S.in = 0; window.S.out = 1;
    await window.appendRange();
  });
  const before = await app.state();
  const victim = before.activeId;

  await app.page.evaluate((id) => window.removeSource(id), victim);
  expect((await app.state()).sources).toHaveLength(1);

  expect(await undo(app)).toMatch(/^delete /);
  const after = await app.state();
  expect(after.sources).toHaveLength(2);
  expect(after.timeline).toHaveLength(before.timeline.length);

  // The blob came back with it, so the source still decodes.
  const ts = await app.page.evaluate(async (id) => {
    const source = window.S.sources.find((x) => x.id === id);
    const sample = await window.media.using(source, ({ sink }) => sink.getSample(0.5));
    const t = sample?.timestamp ?? null;
    sample?.close();
    return t;
  }, victim);
  expect(ts).not.toBeNull();
});

test('undo survives a reload, because it wrote the project back', async ({ app }) => {
  await app.add('land');
  await app.page.evaluate(async () => {
    window.S.in = 0; window.S.out = 1; await window.appendRange();
    window.S.in = 2; window.S.out = 3; await window.appendRange();
  });
  await undo(app);
  expect((await app.state()).timeline).toHaveLength(1);

  await app.page.reload();
  await app.page.waitForFunction(() => window.S?.project);
  await expect.poll(async () => (await app.state()).timeline.length, { timeout: 20_000 }).toBe(1);
});

test('a trim is one step, not one per pointermove', async ({ app }) => {
  await app.add('hd');
  await app.page.evaluate(() => { window.S.in = 1; window.S.out = 3; return window.addClip(); });
  const start = await app.page.evaluate(() => window.historyDepth().past);

  const box = await app.page.locator('#timeline').boundingBox();
  const handle = app.page.locator('#handleOut');
  const at = await handle.boundingBox();
  await app.page.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
  await app.page.mouse.down();
  await app.page.mouse.move(box.x + box.width * 0.7, at.y + at.height / 2, { steps: 20 });
  await app.page.mouse.up();

  const added = (await app.page.evaluate(() => window.historyDepth().past)) - start;
  expect(added, 'the drag pushed a step per move').toBe(1);
});

test('switching project clears the history', async ({ app }) => {
  await app.add('land');
  await app.page.evaluate(() => { window.S.in = 0; window.S.out = 1; return window.appendRange(); });
  expect((await app.page.evaluate(() => window.historyDepth())).past).toBeGreaterThan(0);

  await app.page.evaluate(() => window.newProject('Other'));
  expect(await undo(app), 'undo reached into the last project').toBeNull();
  expect((await app.page.evaluate(() => window.historyDepth())).past).toBe(0);
});

test('per-clip level is undoable and named', async ({ app }) => {
  await app.add('tone');
  await app.page.evaluate(async () => {
    window.S.in = 0; window.S.out = 1;
    await window.appendRange();
    await window.setItemAudio(window.S.timeline[0].id, { gain: 0.2 });
  });
  expect((await app.state()).timeline[0].gain).toBeCloseTo(0.2, 2);

  expect(await undo(app)).toBe('clip level');
  expect((await app.state()).timeline[0].gain ?? 1).toBe(1);
});
