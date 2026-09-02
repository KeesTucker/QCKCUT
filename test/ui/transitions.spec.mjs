import { test, expect } from '../lib/app.mjs';

const joints = (app) => app.page.locator('.joint');
const options = (app) => app.page.locator('#effectList .item');

async function build(app, count = 2) {
  await app.add('land');
  for (let i = 0; i < count; i++) {
    await app.page.evaluate(async (k) => {
      window.S.in = k * 2;
      window.S.out = k * 2 + 2;
      await window.appendRange();
    }, i);
  }
}

test('the pure model darkens only where a transition asks it to', async ({ app }) => {
  const result = await app.page.evaluate(() => {
    const { dimAt } = window.transitions;
    const plan = {
      total: 10,
      intro: { type: 'fade', duration: 1 },
      outro: { type: 'fade', duration: 1 },
      dips: [{ at: 5, duration: 1 }],
    };
    return {
      start: dimAt(0, plan),
      quarterIn: dimAt(0.5, plan),
      clearOfIntro: dimAt(2, plan),
      atCut: dimAt(5, plan),
      halfwayIntoDip: dimAt(4.75, plan),
      clearOfDip: dimAt(6, plan),
      beforeOutro: dimAt(8.5, plan),
      end: dimAt(10, plan),
      none: dimAt(3, { total: 10 }),
    };
  });

  expect(result.start).toBe(1);              // fully black at the very start
  expect(result.quarterIn).toBeCloseTo(0.5, 2);
  expect(result.clearOfIntro).toBe(0);
  expect(result.atCut).toBe(1);              // fully black on the cut itself
  expect(result.halfwayIntoDip).toBeCloseTo(0.5, 2);
  expect(result.clearOfDip).toBe(0);
  expect(result.beforeOutro).toBe(0);
  expect(result.end).toBe(1);
  expect(result.none).toBe(0);
});

test('a sequence gets a joint before, between and after', async ({ app }) => {
  await app.add('land');
  await expect(joints(app)).toHaveCount(0);

  await app.page.evaluate(() => { window.S.in = 0; window.S.out = 1; return window.appendRange(); });
  // One item: start and end only.
  await expect(joints(app)).toHaveCount(2);

  await app.page.evaluate(() => { window.S.in = 2; window.S.out = 3; return window.appendRange(); });
  await expect(joints(app)).toHaveCount(3);
});

test('clicking a joint switches the panel to Effects', async ({ app }) => {
  await build(app);
  await expect(app.page.locator('#sourcesPane')).toBeVisible();

  await joints(app).first().click();

  await expect(app.page.locator('#effectsPane')).toBeVisible();
  await expect(app.page.locator('#sourcesPane')).toBeHidden();
  await expect(app.page.locator('#tabEffects')).toHaveClass(/active/);
  await expect(app.page.locator('#effectWhere')).toHaveText('Sequence start');
  expect((await app.state()).boundary.kind).toBe('intro');
});

test('the options offered depend on which joint it is', async ({ app }) => {
  await build(app);

  await joints(app).first().click();
  await expect(options(app)).toHaveText(['None', 'Fade']);

  await joints(app).nth(1).click();
  await expect(app.page.locator('#effectWhere')).toHaveText('Transition');
  await expect(options(app)).toHaveText(['None', 'Dip to black']);
});

test('choosing a transition marks the joint and holds it', async ({ app }) => {
  await build(app);
  await joints(app).first().click();
  await options(app).filter({ hasText: 'Fade' }).click();

  await expect.poll(async () => (await app.state()).transitions.intro?.type).toBe('fade');
  await expect(joints(app).first()).toHaveClass(/set/);

  // Choosing None takes it off again.
  await options(app).filter({ hasText: 'None' }).click();
  await expect.poll(async () => (await app.state()).transitions.intro).toBeNull();
  await expect(joints(app).first()).not.toHaveClass(/set/);
});

test('a dip is stored on the item it leads into', async ({ app }) => {
  await build(app);
  await joints(app).nth(1).click();
  await options(app).filter({ hasText: 'Dip' }).click();

  const s = await app.state();
  expect(s.timeline[1].transition.type).toBe('dip');
  expect(s.timeline[0].transition ?? null).toBeNull();
});

test('the length slider changes the transition', async ({ app }) => {
  await build(app);
  await joints(app).first().click();
  await options(app).filter({ hasText: 'Fade' }).click();
  await expect(app.page.locator('#effectDurationWrap')).toBeVisible();

  await app.page.locator('#effectDuration').fill('1.2');
  await expect.poll(async () => (await app.state()).transitions.intro.duration).toBeCloseTo(1.2, 2);
  await expect(app.page.locator('#effectDurationValue')).toHaveText('1.20s');
});

test('transitions survive a reload', async ({ app }) => {
  await build(app);
  await app.page.evaluate(() => window.setTransition({ kind: 'intro', key: 'intro' }, 'fade', 0.8));
  await app.page.evaluate(() => {
    const id = window.S.timeline[1].id;
    return window.setTransition({ kind: 'between', key: `item:${id}`, itemId: id }, 'dip', 0.4);
  });

  await app.page.reload();
  await app.page.waitForFunction(() => window.S?.project);
  await expect.poll(async () => (await app.state()).timeline.length, { timeout: 20_000 }).toBe(2);

  const s = await app.state();
  expect(s.transitions.intro).toEqual({ type: 'fade', duration: 0.8 });
  expect(s.timeline[1].transition).toEqual({ type: 'dip', duration: 0.4 });
});

test('the preview actually goes black at the start of a fade', async ({ app }) => {
  await build(app, 1);
  await app.page.evaluate(() => window.setTransition({ kind: 'intro', key: 'intro' }, 'fade', 1));

  const readings = await app.page.evaluate(async () => {
    const read = () => {
      const c = document.getElementById('preview');
      const { data } = c.getContext('2d').getImageData(0, 0, c.width, c.height);
      let brightest = 0;
      for (let i = 0; i < data.length; i += 4) {
        brightest = Math.max(brightest, data[i], data[i + 1], data[i + 2]);
      }
      return brightest;
    };
    window.setView('sequence');
    await window.seekSequence(0);
    const atStart = read();
    await window.seekSequence(0.5);
    const halfway = read();
    await window.seekSequence(1.5);
    const clear = read();
    return { atStart, halfway, clear };
  });

  expect(readings.atStart, 'the first frame of a fade should be black').toBeLessThan(12);
  expect(readings.halfway).toBeGreaterThan(readings.atStart);
  expect(readings.clear).toBeGreaterThan(readings.halfway);
});

test('the render matches the preview', async ({ app }) => {
  test.setTimeout(120_000);
  await build(app, 1);
  await app.page.evaluate(() => window.setTransition({ kind: 'intro', key: 'intro' }, 'fade', 1));

  const result = await app.page.evaluate(async () => {
    let captured = null;
    const realCreate = URL.createObjectURL;
    URL.createObjectURL = function (b) { captured = b; return realCreate.call(URL, b); };
    HTMLAnchorElement.prototype.click = function () {};
    await window.exportSequence();
    URL.createObjectURL = realCreate;

    const mb = await import('/test/mediabunny.mjs');
    const input = new mb.Input({ source: new mb.BlobSource(captured), formats: mb.ALL_FORMATS });
    const sink = new mb.VideoSampleSink(await input.getPrimaryVideoTrack());
    const brightnessAt = async (t) => {
      const sample = await sink.getSample(t);
      const canvas = document.createElement('canvas');
      canvas.width = 32;
      canvas.height = 32;
      const ctx = canvas.getContext('2d');
      sample.drawWithFit(ctx, { fit: 'contain' });
      const { data } = ctx.getImageData(0, 0, 32, 32);
      let brightest = 0;
      for (let i = 0; i < data.length; i += 4) {
        brightest = Math.max(brightest, data[i], data[i + 1], data[i + 2]);
      }
      sample.close();
      return brightest;
    };
    const out = { start: await brightnessAt(0), clear: await brightnessAt(1.5) };
    input.dispose();
    return out;
  });

  expect(result.start, 'the rendered fade should start black').toBeLessThan(20);
  expect(result.clear).toBeGreaterThan(60);
});

test('a new project starts with no transitions', async ({ app }) => {
  await build(app);
  await app.page.evaluate(() => window.setTransition({ kind: 'intro', key: 'intro' }, 'fade', 1));
  await app.page.evaluate(() => window.newProject('Fresh'));

  const s = await app.state();
  expect(s.transitions).toEqual({ intro: null, outro: null });
  expect(s.boundary).toBeNull();
  await expect(app.page.locator('#sourcesPane')).toBeVisible();
});

// Regression: joints first sat across the whole track height, which put them on
// top of the ruler (the scrub surface) and on top of each item's remove button.
test('joints do not cover the ruler or the item controls', async ({ app }) => {
  await build(app);

  const boxes = await app.page.evaluate(() => {
    const rect = (el) => {
      const { top, bottom, left, right } = el.getBoundingClientRect();
      return { top, bottom, left, right };
    };
    return {
      ruler: rect(document.getElementById('seqRuler')),
      track: rect(document.getElementById('track')),
      joints: [...document.querySelectorAll('.joint')].map(rect),
      drops: [...document.querySelectorAll('#track .track-item-drop')].map(rect),
    };
  });

  expect(boxes.joints.length).toBeGreaterThan(0);
  for (const joint of boxes.joints) {
    // Inside the scrubber, so they cost no vertical space of their own...
    expect(joint.top).toBeGreaterThanOrEqual(boxes.ruler.top - 1);
    expect(joint.bottom).toBeLessThanOrEqual(boxes.ruler.bottom + 1);
    // ...and clear of the clips, whose remove buttons sit exactly on a cut.
    expect(joint.bottom, 'a joint overlaps the clips').toBeLessThanOrEqual(boxes.track.top + 1);
    for (const drop of boxes.drops) {
      const overlaps = joint.left < drop.right && joint.right > drop.left
        && joint.top < drop.bottom && joint.bottom > drop.top;
      expect(overlaps, 'a joint is over an item remove button').toBe(false);
    }
  }
});
