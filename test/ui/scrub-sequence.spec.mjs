import { test, expect } from '../lib/app.mjs';

const ruler = (app) => app.page.locator('#seqRuler');

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

test('the ruler appears only once the sequence has something on it', async ({ app }) => {
  await app.add('land');
  await expect(ruler(app)).toBeHidden();
  await app.page.evaluate(() => { window.S.in = 0; window.S.out = 1; return window.appendRange(); });
  await expect(ruler(app)).toBeVisible();
});

test('clicking the ruler jumps the sequence playhead', async ({ app }) => {
  await build(app, { clip: 'land', in: 0, out: 2 }, { clip: 'land', in: 3, out: 5 });

  const box = await ruler(app).boundingBox();
  await app.page.mouse.click(box.x + box.width * 0.75, box.y + box.height / 2);

  // Three quarters through a four second sequence.
  await expect.poll(async () => (await app.state()).seqPlayhead).toBeCloseTo(3, 1);
  expect((await app.state()).view).toBe('sequence');
});

test('dragging the ruler scrubs across the cuts', async ({ app }) => {
  await build(app, { clip: 'land', in: 0, out: 2 }, { clip: 'hd', in: 0, out: 2 });

  const box = await ruler(app).boundingBox();
  await app.page.mouse.move(box.x + 4, box.y + box.height / 2);
  await app.page.mouse.down();

  await app.page.mouse.move(box.x + box.width * 0.25, box.y + box.height / 2, { steps: 8 });
  // Generous: each move decodes a frame, and the whole suite runs in parallel.
  await expect.poll(async () => (await app.state()).seqPlayhead, { timeout: 15_000 })
    .toBeCloseTo(1, 0);

  // Past the cut at 2s, into the second item.
  await app.page.mouse.move(box.x + box.width * 0.85, box.y + box.height / 2, { steps: 12 });
  await app.page.mouse.up();

  const s = await app.state();
  expect(s.seqPlayhead).toBeGreaterThan(2);
  expect(s.seqPlayhead).toBeLessThanOrEqual(4);
});

test('the playhead marker follows the scrub', async ({ app }) => {
  await build(app, { clip: 'land', in: 0, out: 4 });
  const box = await ruler(app).boundingBox();

  // The marker only exists while the sequence is what the viewer follows, which
  // is what a real scrub does before it moves anything.
  await app.page.evaluate(() => window.setView('sequence'));
  const at = (fraction) => app.page.evaluate(async (f) => {
    const r = document.getElementById('seqRuler').getBoundingClientRect();
    await window.seekSequence(window.S.timeline.reduce((t, i) => t + (i.out - i.in), 0) * f);
    const head = document.getElementById('seqPlayheadEl').getBoundingClientRect();
    // The marker is 2px wide and offset by -1px to sit on the position.
    return { head: head.left + head.width / 2, left: r.left, right: r.right };
  }, fraction);

  const start = await at(0);
  const middle = await at(0.5);
  const end = await at(1);

  expect(Math.abs(start.head - start.left)).toBeLessThan(2);
  expect(middle.head).toBeGreaterThan(start.head + 10);
  expect(end.head).toBeGreaterThan(middle.head + 10);
  expect(Math.abs(end.head - end.right)).toBeLessThan(2);
  expect(box.width).toBeGreaterThan(0);
});

test('the preview shows the frame under the scrub, across a cut', async ({ app }) => {
  await build(app, { clip: 'land', in: 0, out: 2 }, { clip: 'hd', in: 4, out: 6 });

  const result = await app.page.evaluate(async () => {
    const read = () => {
      const c = document.getElementById('preview');
      const d = c.getContext('2d').getImageData(c.width >> 1, 8, 1, 1).data;
      return [d[0], d[1], d[2]];
    };
    // 3s into the sequence is 1s into the second item, so source time 5.
    await window.seekSequence(3);
    await new Promise((r) => setTimeout(r, 300));
    const shown = read();

    const hd = window.S.sources.find((s) => s.name === 'hd.mp4');
    const expected = await window.media.using(hd, async ({ sink }) => {
      const sample = await sink.getSample(5);
      const canvas = document.createElement('canvas');
      canvas.width = 64;
      canvas.height = 36;
      const ctx = canvas.getContext('2d');
      sample.drawWithFit(ctx, { fit: 'contain' });
      const d = ctx.getImageData(32, 2, 1, 1).data;
      sample.close();
      return [d[0], d[1], d[2]];
    });
    return { shown, expected };
  });

  for (let i = 0; i < 3; i++) {
    expect(Math.abs(result.shown[i] - result.expected[i]),
      `channel ${i}: showing ${result.shown}, expected ${result.expected}`).toBeLessThan(28);
  }
});

test('scrubbing the ruler stops playback rather than fighting it', async ({ app }) => {
  await build(app, { clip: 'land', in: 0, out: 4 });
  await app.page.evaluate(() => { window.setView('sequence'); window.togglePlay(); });
  await expect.poll(async () => (await app.state()).playingSeq).toBe(true);

  const box = await ruler(app).boundingBox();
  await app.page.mouse.click(box.x + box.width * 0.5, box.y + box.height / 2);

  await expect.poll(async () => (await app.state()).playingSeq).toBe(false);
});

// The items stay draggable for reordering, which is why the scrubber is its own
// strip rather than the track itself.
test('dragging an item still reorders instead of scrubbing', async ({ app }) => {
  await build(app,
    { clip: 'land', in: 0, out: 1 },
    { clip: 'land', in: 0, out: 2 },
    { clip: 'land', in: 0, out: 3 });

  await app.page.evaluate(`
    const dt = new DataTransfer();
    const fire = (el, type, x) => el.dispatchEvent(new DragEvent(type, {
      dataTransfer: dt, bubbles: true, cancelable: true, clientX: x, clientY: 0,
    }));
    const all = [...document.querySelectorAll('#track .track-item')];
    const firstBox = all[0].getBoundingClientRect();
    fire(all[2], 'dragstart');
    fire(document.getElementById('track'), 'dragover', firstBox.left + 2);
    fire(document.getElementById('track'), 'drop', firstBox.left + 2);
  `);

  await expect.poll(async () =>
    (await app.state()).timeline.map((i) => +i.duration.toFixed(1))).toEqual([3, 1, 2]);
});

// Regression: the empty hint used to be hidden by an adjacent-sibling rule on
// the track. Inserting the playhead between them broke the match silently, and
// the hint sat on top of the items.
test('the empty hint disappears once the sequence has items', async ({ app }) => {
  await app.add('land');
  await expect(app.page.locator('#trackEmpty')).toBeVisible();

  await app.page.evaluate(() => { window.S.in = 0; window.S.out = 1; return window.appendRange(); });
  await expect(app.page.locator('#trackEmpty')).toBeHidden();

  await app.page.evaluate(() => window.removeFromSequence(window.S.timeline[0].id));
  await expect(app.page.locator('#trackEmpty')).toBeVisible();
});
