import { test, expect } from '../lib/app.mjs';

// The ruler, playhead and joints all map time to pixels linearly across the
// track. Item widths must agree, or the two drift apart as items are added.
async function build(app, ...spans) {
  await app.add('hd');
  for (const [start, end] of spans) {
    await app.page.evaluate(async ([a, b]) => {
      window.S.in = a;
      window.S.out = b;
      await window.appendRange();
    }, [start, end]);
  }
}

async function geometry(app) {
  return app.page.evaluate(() => {
    const track = document.getElementById('track');
    const box = track.getBoundingClientRect();
    const style = getComputedStyle(track);
    const left = box.left + parseFloat(style.paddingLeft);
    const width = box.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const rows = window.sequence.layout(window.S.timeline);
    const total = rows.at(-1).end;
    return {
      left,
      width,
      items: [...track.querySelectorAll('.track-item')].map((el, i) => {
        const r = el.getBoundingClientRect();
        return {
          left: r.left,
          right: r.right,
          wantLeft: left + (rows[i].start / total) * width,
          wantRight: left + (rows[i].end / total) * width,
        };
      }),
      joints: [...document.querySelectorAll('.joint')].map((el) => {
        const r = el.getBoundingClientRect();
        return r.left + r.width / 2;
      }),
    };
  });
}

test('item edges sit exactly where their time says', async ({ app }) => {
  // Deliberately mixed lengths, including one short enough to have hit the old
  // min-width floor.
  await build(app, [0, 4], [4, 4.2], [5, 8], [8, 8.3], [9, 9.9]);

  const g = await geometry(app);
  expect(g.items).toHaveLength(5);
  for (const [i, item] of g.items.entries()) {
    expect(Math.abs(item.left - item.wantLeft), `item ${i} left edge`).toBeLessThan(1.5);
    expect(Math.abs(item.right - item.wantRight), `item ${i} right edge`).toBeLessThan(1.5);
  }
});

test('the last item does not absorb accumulated error', async ({ app }) => {
  await build(app, [0, 0.4], [1, 1.4], [2, 2.4], [3, 3.4], [4, 8]);

  const g = await geometry(app);
  const last = g.items.at(-1);
  expect(Math.abs(last.left - last.wantLeft), 'last item left edge').toBeLessThan(1.5);
  expect(Math.abs(last.right - last.wantRight), 'last item right edge').toBeLessThan(1.5);
});

test('every cut lines up with its joint', async ({ app }) => {
  await build(app, [0, 3], [3, 3.3], [4, 7]);

  const g = await geometry(app);
  // Joints are intro, one per cut, then outro.
  expect(g.joints).toHaveLength(4);
  for (let i = 1; i < g.items.length; i++) {
    expect(Math.abs(g.items[i].left - g.joints[i]), `cut ${i} misses its joint`)
      .toBeLessThan(1.5);
  }
  expect(Math.abs(g.items[0].left - g.joints[0]), 'start joint').toBeLessThan(1.5);
  expect(Math.abs(g.items.at(-1).right - g.joints.at(-1)), 'end joint').toBeLessThan(1.5);
});
