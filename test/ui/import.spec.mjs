import { test, expect } from '../lib/app.mjs';

test('drop imports a clip and reads its dimensions', async ({ app }) => {
  await app.drop('land');
  const s = await app.state();
  expect(s.duration).toBeCloseTo(6, 1);
  expect([s.width, s.height]).toEqual([640, 360]);
  expect(s.in).toBe(0);
  expect(s.out).toBeCloseTo(6, 1);
});

test('dropping several files adds them all to Sources', async ({ app }) => {
  await app.drop('land', 'port', 'hd');
  await expect(app.rows('sourceList')).toHaveCount(3);
  const s = await app.state();
  expect(s.sources.map((x) => x.name)).toEqual(['land.mp4', 'port.mp4', 'hd.mp4']);
});

test('the filmstrip decodes a tile for every column', async ({ app }) => {
  await app.add('land');
  const s = await app.state();
  const active = s.sources.find((x) => x.id === s.activeId);
  expect(active.thumbCount).toBeGreaterThan(1);
  expect(active.thumbsDecoded).toBe(active.thumbCount);
});

test('controls are disabled until a clip is loaded', async ({ app }) => {
  for (const id of ['playBtn', 'exportBtn']) {
    await expect(app.page.locator(`#${id}`)).toBeDisabled();
  }
  await app.add('land');
  for (const id of ['playBtn', 'exportBtn']) {
    await expect(app.page.locator(`#${id}`)).toBeEnabled();
  }
});

test('selecting a source switches the preview to it', async ({ app }) => {
  await app.add('land', 'port');
  await app.rows('sourceList').first().click();
  await expect.poll(async () => (await app.state()).width).toBe(640);
  await app.rows('sourceList').nth(1).click();
  await expect.poll(async () => (await app.state()).width).toBe(360);
});

// Regression: the Sources panel was rebuilt on every updateUI(), so importing a
// clip rendered the row once empty and again when its poster arrived. The list
// is now rebuilt only when it actually changes; a poster is drawn in place.
test('a source row is built once, not rebuilt when its poster lands', async ({ app }) => {
  await app.page.evaluate(async () => {
    const blob = await (await fetch('/test/media/land.mp4')).blob();
    // Deliberately not awaited: we want to mark the row before the strip runs.
    window.__importing = window.addSource(new File([blob], 'land.mp4', { type: 'video/mp4' }));
  });

  await app.page.waitForSelector('#sourceList .item');
  await app.page.evaluate(() => {
    document.querySelector('#sourceList .item').dataset.probe = 'original';
  });

  await app.page.evaluate(() => window.__importing);
  await app.stripReady();

  const after = await app.page.evaluate(() => {
    const el = document.querySelector('#sourceList .item');
    const canvas = el.querySelector('canvas');
    const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    let lit = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 0) lit++;
    return { probe: el.dataset.probe, lit };
  });

  expect(after.probe, 'the row was rebuilt rather than updated').toBe('original');
  expect(after.lit, 'the poster never got drawn').toBeGreaterThan(100);
});

test('importing more sources leaves the existing rows alone', async ({ app }) => {
  await app.add('land');
  await app.page.evaluate(() => {
    document.querySelector('#sourceList .item').dataset.probe = 'first';
  });

  await app.add('port');
  await expect(app.rows('sourceList')).toHaveCount(2);

  const probe = await app.page.evaluate(() =>
    document.querySelector('#sourceList .item').dataset.probe);
  // A new row is added; the one already there is not thrown away.
  expect(probe).toBe('first');
});

// Regression: import failures went to the console and the header only, which is
// nowhere anyone looks. A file that will not open has to say so.
/** Drop a file the way a person would, rather than calling the importer. */
async function dropJunk(app, name) {
  await app.page.evaluate((filename) => {
    // Valid bytes, no media in them.
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(2048)], filename, { type: 'video/mp4' }));
    document.dispatchEvent(
      new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, name);
}

test('a file that will not open says so over the picture', async ({ app }) => {
  app.allowErrors(/unsupported or unrecognizable/i);
  await dropJunk(app, 'broken.mp4');

  await expect(app.page.locator('#warnToast')).toBeVisible();
  await expect(app.page.locator('#warnTitle')).toHaveText('That did not work');
  await expect(app.page.locator('#warnMsg')).not.toBeEmpty();
  expect((await app.state()).sources, 'a broken file became a source').toHaveLength(0);
});

test('the failure names the file', async ({ app }) => {
  app.allowErrors(/unsupported or unrecognizable/i);
  await dropJunk(app, 'holiday.mp4');
  // mediabunny's own wording carries no filename, so we add it.
  await expect(app.page.locator('#warnMsg')).toContainText('holiday.mp4');
});
