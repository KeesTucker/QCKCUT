import { test, expect } from '../lib/app.mjs';

const editor = (app) => app.page.locator('#clipList .editor');
const startField = (app) => editor(app).locator('input').first();
const endField = (app) => editor(app).locator('input').nth(1);

async function makeClip(app, start, end) {
  await app.add('land');
  return app.page.evaluate(([a, b]) => {
    window.S.in = a;
    window.S.out = b;
    return window.addClip();
  }, [start, end]);
}

test('the editor is hidden until a clip is selected', async ({ app }) => {
  await app.add('land');
  await expect(editor(app)).toHaveCount(0);

  await app.page.evaluate(() => { window.S.in = 1; window.S.out = 2; return window.addClip(); });
  // Adding selects it, so the editor opens.
  await expect(editor(app)).toHaveCount(1);

  await app.page.evaluate(() => { window.S.activeClipId = null; window.snapshot(); });
  await app.page.evaluate(() => window.selectClip('nope'));
});

test('only the selected clip shows an editor', async ({ app }) => {
  await app.add('land');
  for (const [a, b] of [[0, 1], [2, 3], [4, 5]]) {
    await app.page.evaluate(([x, y]) => { window.S.in = x; window.S.out = y; return window.addClip(); }, [a, b]);
  }
  await expect(app.rows('clipList')).toHaveCount(3);
  await expect(editor(app)).toHaveCount(1);

  await app.rows('clipList').first().click();
  await expect(editor(app)).toHaveCount(1);
  await expect.poll(async () => (await app.state()).activeClipId).toBe((await app.state()).clips[0].id);
});

test('the fields show the clip range as timecode', async ({ app }) => {
  await makeClip(app, 1.25, 3.5);
  await expect(startField(app)).toHaveValue('0:01.25');
  await expect(endField(app)).toHaveValue('0:03.50');
});

test('typing a start time moves the clip', async ({ app }) => {
  await makeClip(app, 1, 3);
  await startField(app).fill('0:02.50');
  await startField(app).press('Enter');

  await expect.poll(async () => (await app.state()).clips[0].in).toBeCloseTo(2.5, 2);
  // The selected clip drives the timeline selection too.
  expect((await app.state()).in).toBeCloseTo(2.5, 2);
});

test('typing an end time resizes the clip', async ({ app }) => {
  await makeClip(app, 1, 3);
  await endField(app).fill('5');
  await endField(app).press('Enter');

  await expect.poll(async () => (await app.state()).clips[0].out).toBeCloseTo(5, 2);
  expect((await app.state()).clips[0].in).toBeCloseTo(1, 2);
});

test('plain seconds and mm:ss.dd are both accepted', async ({ app }) => {
  const parsed = await app.page.evaluate(() => [
    window.parseTimecode('0:01.25'),
    window.parseTimecode('1:00'),
    window.parseTimecode('83.5'),
    window.parseTimecode('5'),
    window.parseTimecode(' 2.5 '),
  ]);
  expect(parsed).toEqual([1.25, 60, 83.5, 5, 2.5]);
});

test('nonsense is rejected and the field reverts', async ({ app }) => {
  const rejected = await app.page.evaluate(() => [
    window.parseTimecode('abc'),
    window.parseTimecode(''),
    window.parseTimecode('1:75'),
    window.parseTimecode('--3'),
  ]);
  expect(rejected).toEqual([null, null, null, null]);

  await makeClip(app, 1, 3);
  await startField(app).fill('banana');
  await startField(app).press('Enter');

  await expect(startField(app)).toHaveValue('0:01.00');
  expect((await app.state()).clips[0].in).toBeCloseTo(1, 2);
});

test('an out-of-range time is clamped, never inverted', async ({ app }) => {
  await makeClip(app, 1, 3);

  // Past the end of a 6s source.
  await endField(app).fill('99');
  await endField(app).press('Enter');
  await expect.poll(async () => (await app.state()).clips[0].out).toBeCloseTo(6, 1);

  // Start pushed beyond the end.
  await startField(app).fill('50');
  await startField(app).press('Enter');
  const clip = (await app.state()).clips[0];
  expect(clip.in).toBeLessThan(clip.out);
  expect(clip.out).toBeLessThanOrEqual(6.001);
});

test('edited ranges survive a reload', async ({ app }) => {
  await makeClip(app, 1, 3);
  await endField(app).fill('0:04.75');
  await endField(app).press('Enter');
  await expect.poll(async () => (await app.state()).clips[0].out).toBeCloseTo(4.75, 2);

  await app.page.reload();
  await expect.poll(async () => (await app.state()).clips.length, { timeout: 20_000 }).toBe(1);
  expect((await app.state()).clips[0].out).toBeCloseTo(4.75, 2);
});

test('typing in a field does not fire app shortcuts', async ({ app }) => {
  await makeClip(app, 1, 3);
  const before = await app.state();

  await startField(app).click();
  await app.page.keyboard.type('cio');   // clip, mark in, mark out
  await app.page.keyboard.press('Escape');

  const after = await app.state();
  expect(after.clips).toHaveLength(before.clips.length);
  expect(after.in).toBeCloseTo(before.in, 3);
  expect(after.out).toBeCloseTo(before.out, 3);
});

// The editor node persists while the same clip stays selected: rebuilding it on
// every updateUI() destroyed whatever was being typed.
test('a background update does not clobber a field being typed into', async ({ app }) => {
  await makeClip(app, 1, 3);
  await startField(app).click();
  await startField(app).fill('0:02.50');

  // Something else re-renders the panel while the caret is still in the field.
  // Not a click: that would move focus for ordinary browser reasons.
  await app.page.evaluate(() => window.selectClip(window.S.clips[0].id));

  await expect(startField(app)).toBeFocused();
  await expect(startField(app)).toHaveValue('0:02.50');

  await startField(app).press('Enter');
  await expect.poll(async () => (await app.state()).clips[0].in).toBeCloseTo(2.5, 2);
});
