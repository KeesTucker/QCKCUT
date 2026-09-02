import { test, expect } from '../lib/app.mjs';

const badge = (app) => app.page.locator('#viewBadge');

async function build(app, ...specs) {
  await app.add(...new Set(specs.map((s) => s.clip)));
  for (const { clip, in: start, out } of specs) {
    await app.page.evaluate(async ([name, a, b]) => {
      const source = window.S.sources.find((s) => s.name === `${name}.mp4`);
      await window.setActive(source.id);
      window.S.in = a;
      window.S.out = b;
      await window.appendRange();
    }, [clip, start, out]);
  }
}

test('the badge says which of the two the viewer is showing', async ({ app }) => {
  await app.add('land');
  await expect(badge(app)).toBeVisible();
  await expect(app.page.locator('#viewKind')).toHaveText('Source');
  await expect(app.page.locator('#viewName')).toHaveText('land.mp4');

  await app.page.evaluate(() => window.setView('sequence'));
  await expect(app.page.locator('#viewKind')).toHaveText('Sequence');
});

test('touching the sequence track switches the viewer to it', async ({ app }) => {
  await build(app, { clip: 'land', in: 0, out: 1 });
  expect((await app.state()).view).toBe('source');

  await app.page.locator('#track').click({ position: { x: 5, y: 5 } });
  await expect.poll(async () => (await app.state()).view).toBe('sequence');
  await expect(app.page.locator('#viewKind')).toHaveText('Sequence');
});

test('touching the filmstrip switches it back to the source', async ({ app }) => {
  await build(app, { clip: 'land', in: 0, out: 1 });
  await app.page.evaluate(() => window.setView('sequence'));

  const box = await app.page.locator('#timeline').boundingBox();
  await app.page.mouse.move(box.x + 40, box.y + box.height / 2);
  await app.page.mouse.down();
  await app.page.mouse.up();

  await expect.poll(async () => (await app.state()).view).toBe('source');
});

test('the active area is outlined', async ({ app }) => {
  await build(app, { clip: 'land', in: 0, out: 1 });
  await expect(app.page.locator('#timeline')).toHaveClass(/watching/);
  await expect(app.page.locator('.sequence')).not.toHaveClass(/watching/);

  await app.page.evaluate(() => window.setView('sequence'));
  await expect(app.page.locator('.sequence')).toHaveClass(/watching/);
  await expect(app.page.locator('#timeline')).not.toHaveClass(/watching/);
});

test('the time readout follows the view', async ({ app }) => {
  await build(app, { clip: 'land', in: 0, out: 2 }, { clip: 'land', in: 3, out: 4 });
  await app.page.evaluate(() => window.seek(4));
  await expect(app.page.locator('#time')).toHaveText('0:04.00 / 0:06.00');

  await app.page.evaluate(() => window.setView('sequence'));
  // The sequence is three seconds long and starts at zero.
  await expect(app.page.locator('#time')).toHaveText('0:00.00 / 0:03.00');
});

test('one play button drives whichever is showing', async ({ app }) => {
  await build(app, { clip: 'land', in: 0, out: 1 });

  await app.page.evaluate(() => { window.S.in = 0; window.S.out = 0.6; window.togglePlay(); });
  await expect.poll(async () => (await app.state()).playing).toBe(true);
  expect((await app.state()).playingSeq).toBe(false);
  await app.page.evaluate(() => window.pause());

  await app.page.evaluate(() => window.setView('sequence'));
  await app.page.evaluate(() => { window.togglePlay(); });
  await expect.poll(async () => (await app.state()).playingSeq).toBe(true);
  expect((await app.state()).playing).toBe(false);
  await app.page.evaluate(() => window.stopSequence());
});

test('play is disabled when the showing thing has nothing to play', async ({ app }) => {
  await app.add('land');
  // Source view with a source loaded: playable.
  await expect(app.page.locator('#playBtn')).toBeEnabled();

  // Sequence view with an empty sequence: not.
  await app.page.evaluate(() => window.setView('sequence'));
  await expect(app.page.locator('#playBtn')).toBeDisabled();

  await app.page.evaluate(() => {
    window.S.in = 0;
    window.S.out = 1;
    return window.appendRange();
  });
  await expect(app.page.locator('#playBtn')).toBeEnabled();
});

test('clicking a sequence item shows the sequence at that point', async ({ app }) => {
  await build(app, { clip: 'land', in: 0, out: 2 }, { clip: 'hd', in: 3, out: 5 });

  await app.page.locator('#track .track-item').nth(1).click();

  await expect.poll(async () => (await app.state()).view).toBe('sequence');
  const s = await app.state();
  expect(s.seqPlayhead).toBeCloseTo(2, 2);
  // The viewer takes the sequence's shape, not the item's.
  const size = await app.page.evaluate(() => {
    const c = document.getElementById('preview');
    return [c.width, c.height];
  });
  expect(size).toEqual([640, 360]);
});

test('switching view stops whatever was playing', async ({ app }) => {
  await build(app, { clip: 'land', in: 0, out: 3 });
  await app.page.evaluate(() => { window.S.in = 0; window.S.out = 3; window.play(); });
  await expect.poll(async () => (await app.state()).playing).toBe(true);

  await app.page.evaluate(() => window.setView('sequence'));
  await expect.poll(async () => (await app.state()).playing).toBe(false);
});

// Regression: seekSequence was not coalesced, so two overlapping calls finished
// in whatever order their decodes completed and the preview kept a stale frame.
// setView() starts one without awaiting, which makes this easy to hit.
test('overlapping sequence seeks settle on the newest frame', async ({ app }) => {
  await build(app, { clip: 'hd', in: 1, out: 4 });

  const result = await app.page.evaluate(async () => {
    const read = () => {
      const c = document.getElementById('preview');
      const d = c.getContext('2d').getImageData(c.width >> 1, 8, 1, 1).data;
      return [d[0], d[1], d[2]];
    };

    // setView fires a seek to 0 without awaiting it; then ask for a later point.
    window.setView('sequence');
    await window.seekSequence(1.2);
    await new Promise((r) => setTimeout(r, 400));
    const shown = read();

    // What the frame at that point should actually look like.
    const source = window.S.sources[0];
    const expected = await window.media.using(source, async ({ sink }) => {
      const sample = await sink.getSample(2.2);   // item.in 1 + 1.2 into the sequence
      const canvas = document.createElement('canvas');
      canvas.width = 64;
      canvas.height = 36;
      const ctx = canvas.getContext('2d');
      sample.drawWithFit(ctx, { fit: 'contain' });
      const d = ctx.getImageData(32, 2, 1, 1).data;
      sample.close();
      return [d[0], d[1], d[2]];
    });

    return { shown, expected, head: window.S.seqPlayhead };
  });

  expect(result.head).toBeCloseTo(1.2, 2);
  for (let i = 0; i < 3; i++) {
    expect(Math.abs(result.shown[i] - result.expected[i]),
      `channel ${i}: showing ${result.shown} but the frame at 1.2s is ${result.expected}`)
      .toBeLessThan(24);
  }
});

// Clicking an item should leave the panels agreeing with the timeline: the
// source it came from active, and the clip it was made from selected.
test('a sequence item selects its source and its clip', async ({ app }) => {
  await app.add('land', 'hd');
  const hd = (await app.state()).sources.find((s) => s.name === 'hd.mp4');
  await app.page.evaluate((id) => window.setActive(id), hd.id);

  const clip = await app.page.evaluate(() => {
    window.S.in = 2;
    window.S.out = 4;
    return window.addClip();
  });
  await app.page.evaluate((id) => window.addToSequence('clip', id, 0), clip.id);

  // Move away to a different source entirely.
  const land = (await app.state()).sources.find((s) => s.name === 'land.mp4');
  await app.page.evaluate((id) => window.setActive(id), land.id);
  expect((await app.state()).activeId).toBe(land.id);

  await app.page.locator('#track .track-item').first().click();

  // selectItem awaits setActive, which assigns activeId before the clip and the
  // range, so poll the whole condition rather than the first field written.
  await expect.poll(async () => {
    const state = await app.state();
    return state.activeId === hd.id
      && state.activeClipId === clip.id
      && Math.abs(state.in - 2) < 0.01
      && Math.abs(state.out - 4) < 0.01;
  }).toBe(true);
  const s = await app.state();
  // And the viewer is still following the sequence, not the source.
  expect(s.view).toBe('sequence');

  await expect(app.page.locator('#sourceList .item.active .item-name')).toHaveText('hd.mp4');
  await expect(app.page.locator('#clipList .item.active')).toHaveCount(1);
});

test('an item dragged from a source selects the source but no clip', async ({ app }) => {
  await app.add('land');
  const id = (await app.state()).sources[0].id;
  await app.page.evaluate((x) => window.addToSequence('source', x, 0), id);

  await app.page.locator('#track .track-item').first().click();

  const s = await app.state();
  expect(s.activeId).toBe(id);
  expect(s.activeClipId).toBeNull();
});

test('only the area being watched shows a playhead', async ({ app }) => {
  await app.add('land');
  await app.page.evaluate(() => { window.S.in = 0; window.S.out = 2; return window.appendRange(); });

  await expect(app.page.locator('#playheadEl')).toBeVisible();
  await expect(app.page.locator('#seqPlayheadEl')).toBeHidden();

  await app.page.evaluate(() => window.setView('sequence'));
  await expect(app.page.locator('#seqPlayheadEl')).toBeVisible();
  await expect(app.page.locator('#playheadEl')).toBeHidden();
});
