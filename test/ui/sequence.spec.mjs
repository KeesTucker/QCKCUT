import { test, expect } from '../lib/app.mjs';

const items = (app) => app.page.locator('#track .track-item');

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

test('the pure model places items by order, not stored times', async ({ app }) => {
  const result = await app.page.evaluate(() => {
    const { layout, totalDuration, at, sourceTime } = window.sequence;
    const list = [
      { id: 'a', in: 1, out: 3 },     // 2s
      { id: 'b', in: 10, out: 10.5 }, // 0.5s
      { id: 'c', in: 0, out: 4 },     // 4s
    ];
    const rows = layout(list);
    return {
      starts: rows.map((r) => r.start),
      ends: rows.map((r) => r.end),
      total: totalDuration(list),
      atStart: at(rows, 0)?.item.id,
      atSeam: at(rows, 2)?.item.id,
      atLast: at(rows, 3)?.item.id,
      pastEnd: at(rows, 99),
      // 2.25s into the sequence is 0.25s into item b, which starts at 10.
      inSource: sourceTime(at(rows, 2.25), 2.25),
    };
  });
  expect(result.starts).toEqual([0, 2, 2.5]);
  expect(result.ends).toEqual([2, 2.5, 6.5]);
  expect(result.total).toBe(6.5);
  expect(result.atStart).toBe('a');
  expect(result.atSeam).toBe('b');
  expect(result.atLast).toBe('c');
  expect(result.pastEnd).toBeNull();
  expect(result.inSource).toBeCloseTo(10.25, 6);
});

test('move and insert behave like a drop position', async ({ app }) => {
  const result = await app.page.evaluate(() => {
    const { move, insert, remove, slotAt } = window.sequence;
    const ids = (list) => list.map((x) => x.id).join('');
    const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const bounds = [{ left: 0, right: 10 }, { left: 10, right: 20 }, { left: 20, right: 30 }];
    return {
      toEnd: ids(move(list, 0, 3)),
      toFront: ids(move(list, 2, 0)),
      noop: ids(move(list, 1, 1)),
      middle: ids(move(list, 0, 2)),
      inserted: ids(insert(list, { id: 'z' }, 1)),
      clamped: ids(insert(list, { id: 'z' }, 99)),
      removed: ids(remove(list, 'b')),
      slots: [slotAt(bounds, 1), slotAt(bounds, 12), slotAt(bounds, 29), slotAt([], 5)],
    };
  });
  expect(result.toEnd).toBe('bca');
  expect(result.toFront).toBe('cab');
  expect(result.noop).toBe('abc');
  expect(result.middle).toBe('bac');
  expect(result.inserted).toBe('azbc');
  expect(result.clamped).toBe('abcz');
  expect(result.removed).toBe('ac');
  expect(result.slots).toEqual([0, 1, 3, 0]);
});

test('T appends the current range to the sequence', async ({ app }) => {
  await build(app, { clip: 'land', in: 1, out: 3 });
  await expect(items(app)).toHaveCount(1);
  const s = await app.state();
  expect(s.sequenceDuration).toBeCloseTo(2, 2);
  expect(s.timeline[0].start).toBe(0);
});

test('items lay end to end with no gaps', async ({ app }) => {
  await build(app,
    { clip: 'land', in: 0, out: 2 },
    { clip: 'hd', in: 1, out: 4 },
    { clip: 'port', in: 0.5, out: 1.5 });

  const s = await app.state();
  expect(s.timeline.map((i) => +i.start.toFixed(2))).toEqual([0, 2, 5]);
  expect(s.sequenceDuration).toBeCloseTo(6, 2);
  await expect(items(app)).toHaveCount(3);
});

test('dropping a clip on the track adds it at that position', async ({ app }) => {
  await build(app, { clip: 'land', in: 0, out: 2 }, { clip: 'land', in: 3, out: 4 });
  await app.page.evaluate(() => {
    window.S.in = 4.5;
    window.S.out = 5.5;
    return window.addClip();
  });
  // Drop the clip into the middle slot.
  const clipId = (await app.state()).clips[0].id;
  await app.page.evaluate((id) => window.addToSequence('clip', id, 1), clipId);

  const s = await app.state();
  expect(s.timeline).toHaveLength(3);
  expect(s.timeline[1].duration).toBeCloseTo(1, 2);
  expect(s.timeline.map((i) => +i.start.toFixed(2))).toEqual([0, 2, 3]);
});

test('a whole source can go on the track', async ({ app }) => {
  await app.add('land');
  const id = (await app.state()).sources[0].id;
  await app.page.evaluate((x) => window.addToSequence('source', x, 0), id);
  const s = await app.state();
  expect(s.timeline).toHaveLength(1);
  expect(s.timeline[0].in).toBe(0);
  expect(s.timeline[0].out).toBeCloseTo(6, 1);
});

test('reordering ripples every later item', async ({ app }) => {
  await build(app,
    { clip: 'land', in: 0, out: 1 },
    { clip: 'land', in: 0, out: 2 },
    { clip: 'land', in: 0, out: 3 });
  expect((await app.state()).timeline.map((i) => +i.duration.toFixed(1))).toEqual([1, 2, 3]);

  await app.page.evaluate(() => window.moveInSequence(2, 0));

  const s = await app.state();
  expect(s.timeline.map((i) => +i.duration.toFixed(1))).toEqual([3, 1, 2]);
  expect(s.timeline.map((i) => +i.start.toFixed(1))).toEqual([0, 3, 4]);
  expect(s.sequenceDuration).toBeCloseTo(6, 2);
});

test('removing an item closes the gap', async ({ app }) => {
  await build(app,
    { clip: 'land', in: 0, out: 1 },
    { clip: 'land', in: 0, out: 2 },
    { clip: 'land', in: 0, out: 3 });

  await items(app).nth(1).hover();
  await items(app).nth(1).locator('.track-item-drop').click();

  await expect(items(app)).toHaveCount(2);
  const s = await app.state();
  expect(s.timeline.map((i) => +i.start.toFixed(1))).toEqual([0, 1]);
  expect(s.sequenceDuration).toBeCloseTo(4, 2);
});

test('clicking an item moves the sequence playhead to its start', async ({ app }) => {
  await build(app,
    { clip: 'land', in: 0, out: 2 },
    { clip: 'hd', in: 3, out: 5 });

  await items(app).nth(1).click();

  // The viewer follows the sequence rather than jumping the source preview.
  await expect.poll(async () => {
    const s = await app.state();
    return s.view === 'sequence' && Math.abs(s.seqPlayhead - 2) < 0.01;
  }).toBe(true);
  expect((await app.state()).activeItemId).toBe((await app.state()).timeline[1].id);
});

test('deleting a source removes its sequence items too', async ({ app }) => {
  await build(app, { clip: 'land', in: 0, out: 2 }, { clip: 'hd', in: 0, out: 2 });
  const landId = (await app.state()).sources.find((s) => s.name === 'land.mp4').id;

  await app.page.evaluate((id) => window.removeSource(id), landId);

  const s = await app.state();
  expect(s.timeline).toHaveLength(1);
  expect(s.timeline[0].sourceId).not.toBe(landId);
  expect(s.timeline[0].start).toBe(0);
});

test('the sequence survives a reload in order', async ({ app }) => {
  await build(app,
    { clip: 'land', in: 0, out: 1 },
    { clip: 'hd', in: 2, out: 4 },
    { clip: 'port', in: 0, out: 1.5 });
  const before = (await app.state()).timeline.map((i) => [i.sourceId, +i.in.toFixed(2)]);

  await app.page.reload();
  await expect.poll(async () => (await app.state()).timeline.length, { timeout: 20_000 }).toBe(3);

  const after = (await app.state()).timeline.map((i) => [i.sourceId, +i.in.toFixed(2)]);
  expect(after).toEqual(before);
  expect((await app.state()).sequenceDuration).toBeCloseTo(4.5, 2);
});

test('export follows the sequence, not the view', async ({ app }) => {
  await app.add('land');
  const button = app.page.locator('#exportBtn');

  // The label never changes; the tooltip says what it will render.
  await expect(button).toHaveText('Export');
  await expect(button).toHaveAttribute('title', /marked range/);
  await expect(button).toBeEnabled();

  await app.page.evaluate(() => window.setView('sequence'));
  await expect(button, 'the view must not change what export means')
    .toHaveAttribute('title', /marked range/);

  // Once the sequence has something, that is the deliverable.
  await app.page.evaluate(() => window.setView('source'));
  await app.page.evaluate(() => { window.S.in = 0; window.S.out = 1; return window.appendRange(); });
  await expect(button).toHaveAttribute('title', /whole sequence/);
  await expect(button).toBeEnabled();

  // Still the sequence, even while watching a source.
  await app.page.evaluate(() => window.setView('source'));
  await expect(button).toHaveAttribute('title', /whole sequence/);
});

test('the export button renders the sequence even from source view', async ({ app }) => {
  test.setTimeout(120_000);
  await app.add('land');
  await app.page.evaluate(() => { window.S.in = 0; window.S.out = 1.5; return window.appendRange(); });
  // Watching a source, with a different range marked than the sequence holds.
  await app.page.evaluate(() => { window.setView('source'); window.S.in = 3; window.S.out = 5.5; });

  const duration = await app.page.evaluate(async () => {
    let captured = null;
    const realCreate = URL.createObjectURL;
    URL.createObjectURL = function (b) { captured = b; return realCreate.call(URL, b); };
    HTMLAnchorElement.prototype.click = function () {};
    document.getElementById('exportBtn').click();
    await new Promise((r) => setTimeout(r, 50));
    while (window.S.exporting) await new Promise((r) => setTimeout(r, 100));
    URL.createObjectURL = realCreate;

    const mb = await import('/test/mediabunny.mjs');
    const input = new mb.Input({ source: new mb.BlobSource(captured), formats: mb.ALL_FORMATS });
    const out = await (await input.getPrimaryVideoTrack()).computeDuration();
    input.dispose();
    return out;
  });

  // 1.5s of sequence, not the 2.5s marked on the source.
  expect(duration).toBeCloseTo(1.5, 1);
});

// The handlers above are exercised through their functions; these drive the
// real drag events, so the payload encoding, the slot maths and the wiring in
// between are covered too.
const DRAG = `
  const dt = new DataTransfer();
  const fire = (el, type, x) => el.dispatchEvent(new DragEvent(type, {
    dataTransfer: dt, bubbles: true, cancelable: true, clientX: x, clientY: 0,
  }));
`;

test('dragging a clip row onto the track appends it', async ({ app }) => {
  await app.add('land');
  await app.page.evaluate(() => { window.S.in = 1; window.S.out = 2.5; return window.addClip(); });

  await app.page.evaluate(DRAG + `
    const row = document.querySelector('#clipList .item');
    const track = document.getElementById('track');
    fire(row, 'dragstart');
    fire(track, 'dragover', track.getBoundingClientRect().right - 5);
    fire(track, 'drop', track.getBoundingClientRect().right - 5);
  `);

  await expect(items(app)).toHaveCount(1);
  const s = await app.state();
  expect(s.timeline[0].duration).toBeCloseTo(1.5, 2);
});

test('dropping on the left half of an item inserts before it', async ({ app }) => {
  await build(app, { clip: 'land', in: 0, out: 2 });
  await app.page.evaluate(() => { window.S.in = 4; window.S.out = 5; return window.addClip(); });

  await app.page.evaluate(DRAG + `
    const row = document.querySelector('#clipList .item');
    const first = document.querySelector('#track .track-item');
    const box = first.getBoundingClientRect();
    fire(row, 'dragstart');
    // Left of the midpoint means "before this item".
    fire(document.getElementById('track'), 'dragover', box.left + box.width * 0.2);
    fire(document.getElementById('track'), 'drop', box.left + box.width * 0.2);
  `);

  await expect(items(app)).toHaveCount(2);
  const s = await app.state();
  expect(s.timeline[0].duration).toBeCloseTo(1, 2);
  expect(s.timeline[1].duration).toBeCloseTo(2, 2);
});

test('dragging a track item to the front reorders the sequence', async ({ app }) => {
  await build(app,
    { clip: 'land', in: 0, out: 1 },
    { clip: 'land', in: 0, out: 2 },
    { clip: 'land', in: 0, out: 3 });

  await app.page.evaluate(DRAG + `
    const all = [...document.querySelectorAll('#track .track-item')];
    const last = all[2];
    const firstBox = all[0].getBoundingClientRect();
    fire(last, 'dragstart');
    fire(document.getElementById('track'), 'dragover', firstBox.left + 2);
    fire(document.getElementById('track'), 'drop', firstBox.left + 2);
  `);

  await expect.poll(async () =>
    (await app.state()).timeline.map((i) => +i.duration.toFixed(1))).toEqual([3, 1, 2]);
});

test('a drag that is not ours is ignored by the track', async ({ app }) => {
  await build(app, { clip: 'land', in: 0, out: 1 });
  const after = await app.page.evaluate(`
    const dt = new DataTransfer();
    dt.setData('text/plain', 'not for us');
    const track = document.getElementById('track');
    for (const type of ['dragover', 'drop']) {
      track.dispatchEvent(new DragEvent(type, {
        dataTransfer: dt, bubbles: true, cancelable: true, clientX: 10, clientY: 0,
      }));
    }
    ({
      over: track.classList.contains('over'),
      marks: track.querySelectorAll('.drop-before, .drop-after').length,
    });
  `);
  // No hover state and no insertion marker: the track never engaged.
  expect(after).toEqual({ over: false, marks: 0 });
  await expect(items(app)).toHaveCount(1);
});
