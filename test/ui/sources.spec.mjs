import { test, expect } from '../lib/app.mjs';

// The decoder pool is finite and fails opaquely when exhausted, so the bin must
// keep at most MAX_OPEN inputs alive no matter how many sources exist.
test('the open decoder count stays bounded as sources are added', async ({ app }) => {
  const max = await app.page.evaluate(() => window.media.MAX_OPEN);
  for (let i = 0; i < 10; i++) {
    await app.add(['land', 'port', 'hd'][i % 3]);
    const s = await app.state();
    expect(s.openDecoders, `after ${i + 1} imports`).toBeLessThanOrEqual(max);
  }
  expect((await app.state()).sources).toHaveLength(10);
});

test('cycling through many sources never exhausts the decoders', async ({ app }) => {
  await app.add('land', 'port', 'hd');
  const ids = (await app.state()).sources.map((s) => s.id);

  const max = await app.page.evaluate(() => window.media.MAX_OPEN);
  for (let i = 0; i < 12; i++) {
    const id = ids[i % ids.length];
    await app.page.evaluate((x) => window.setActive(x), id);
    const s = await app.state();
    expect(s.activeId).toBe(id);
    expect(s.openDecoders).toBeLessThanOrEqual(max);
  }

  // And the active source is still decodable at the end.
  const ts = await app.page.evaluate(async () => {
    const source = window.S.sources.find((s) => s.id === window.S.activeId);
    return window.media.using(source, async ({ sink }) => {
      const sample = await sink.getSample(0.5);
      const t = sample?.timestamp ?? null;
      sample?.close();
      return t;
    });
  });
  expect(ts).not.toBeNull();
});

test('the active source keeps its decoder held while others are evicted', async ({ app }) => {
  await app.add('land', 'port', 'hd');
  const s = await app.state();
  const isOpen = await app.page.evaluate((id) => window.media.isOpen(id), s.activeId);
  expect(isOpen).toBe(true);
});

test('removing a source drops it and its clips', async ({ app }) => {
  await app.add('land');
  await app.page.evaluate(() => window.addClip());
  expect((await app.state()).clips).toHaveLength(1);

  await app.rows('sourceList').first().hover();
  await app.rows('sourceList').first().locator('.item-drop').click();

  await expect.poll(async () => (await app.state()).sources.length).toBe(0);
  expect((await app.state()).clips).toHaveLength(0);
});

test('removing the active source falls back to another', async ({ app }) => {
  await app.add('land', 'port');
  const before = await app.state();
  await app.page.evaluate((id) => window.removeSource(id), before.activeId);
  const after = await app.state();
  expect(after.sources).toHaveLength(1);
  expect(after.activeId).toBe(after.sources[0].id);
});

// Regression: buildStrip shared one AbortController across all sources, so
// starting the second source's filmstrip aborted the first and left it with a
// single tile. Every source must end up with a complete strip.
test('every source gets a complete filmstrip, not just the last one', async ({ app }) => {
  await app.add('land', 'port', 'hd');
  const s = await app.state();
  expect(s.sources).toHaveLength(3);
  for (const source of s.sources) {
    expect(source.thumbCount, `${source.name} has no columns`).toBeGreaterThan(1);
    expect(source.thumbsDecoded, `${source.name} strip incomplete`).toBe(source.thumbCount);
  }
});

// Each build holds its source's decoder, and the pool cannot evict an in-use
// entry, so parallel builds would exhaust it. Sampling the open count during a
// burst of imports is the observable form of that invariant.
test('importing a burst of sources never exceeds the decoder pool', async ({ app }) => {
  const max = await app.page.evaluate(() => window.media.MAX_OPEN);
  await app.page.evaluate(() => {
    window.__peak = 0;
    window.__sampler = setInterval(() => {
      window.__peak = Math.max(window.__peak, window.media.openCount());
    }, 5);
  });

  await app.add('land', 'port', 'hd', 'land', 'port', 'hd');

  const peak = await app.page.evaluate(() => {
    clearInterval(window.__sampler);
    return window.__peak;
  });

  expect(peak, `peaked at ${peak} open decoders, pool is ${max}`).toBeLessThanOrEqual(max);
  const s = await app.state();
  expect(s.sources).toHaveLength(6);
  for (const source of s.sources) {
    expect(source.thumbsDecoded, `${source.name} strip incomplete`).toBe(source.thumbCount);
  }
});

// Regression: the preview canvas holds its last frame, so deleting the last
// source left its final frame on screen with nothing to explain it.
test('deleting the last source clears the preview', async ({ app }) => {
  await app.add('land');
  await app.page.evaluate(() => window.seek(2));

  const painted = await app.page.evaluate(() => {
    const c = document.getElementById('preview');
    const d = c.getContext('2d').getImageData(c.width >> 1, c.height >> 1, 1, 1).data;
    return Math.max(d[0], d[1], d[2]);
  });
  expect(painted).toBeGreaterThan(40);

  const id = (await app.state()).sources[0].id;
  await app.page.evaluate((x) => window.removeSource(x), id);

  const brightest = await app.page.evaluate(() => {
    const c = document.getElementById('preview');
    const { data } = c.getContext('2d').getImageData(0, 0, c.width, c.height);
    let max = 0;
    for (let i = 0; i < data.length; i += 4) max = Math.max(max, data[i], data[i + 1], data[i + 2]);
    return max;
  });
  expect(brightest, 'the deleted source is still on screen').toBeLessThan(20);
});

test('deleting one of several repaints with the one that takes over', async ({ app }) => {
  await app.add('land', 'port');
  const s = await app.state();
  await app.page.evaluate((id) => window.removeSource(id), s.activeId);

  await expect.poll(async () => (await app.state()).sources.length).toBe(1);
  // Something is still showing: the source that took over, not a blank canvas.
  const brightest = await app.page.evaluate(() => {
    const c = document.getElementById('preview');
    const { data } = c.getContext('2d').getImageData(0, 0, c.width, c.height);
    let max = 0;
    for (let i = 0; i < data.length; i += 4) max = Math.max(max, data[i], data[i + 1], data[i + 2]);
    return max;
  });
  expect(brightest).toBeGreaterThan(40);
});
