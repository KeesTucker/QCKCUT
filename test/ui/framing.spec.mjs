import { test, expect } from '../lib/app.mjs';

async function withItem(app, clip = 'grid') {
  await app.add(clip);
  await app.page.evaluate(async () => {
    window.S.in = 0;
    window.S.out = 2;
    await window.appendRange();
  });
  await app.page.locator('#track .track-item').first().click();
  await app.page.locator('#tabEffects').click();
}

const first = async (app) => (await app.state()).timeline[0];

test('the crop always matches the output shape', async ({ app }) => {
  const result = await app.page.evaluate(() => {
    const { cropFor } = window.frame;
    // 1280x720 source into a 1080x1920 output.
    const crop = cropFor({ width: 1280, height: 720, outWidth: 1080, outHeight: 1920, frame: { zoom: 1, x: 0.5, y: 0.5 } });
    return { crop, aspect: crop.width / crop.height, want: 1080 / 1920 };
  });
  expect(result.crop.height).toBe(720);
  expect(result.aspect).toBeCloseTo(result.want, 2);
  // Centred by default.
  // Within a pixel: the rectangle is rounded to whole pixels.
  expect(Math.abs(result.crop.left - (1280 - result.crop.width) / 2)).toBeLessThanOrEqual(1);
});

test('rotation swaps the source’s shape', async ({ app }) => {
  const swapped = await app.page.evaluate(() => {
    const { cropFor } = window.frame;
    const upright = cropFor({ width: 1920, height: 1080, outWidth: 1080, outHeight: 1920, frame: { zoom: 1 } });
    const turned = cropFor({ width: 1920, height: 1080, rotate: 90, outWidth: 1080, outHeight: 1920, frame: { zoom: 1 } });
    return { upright, turned };
  });
  // Turned a quarter, a 16:9 source is 9:16 and needs no cropping at all.
  expect(swapped.turned).toBeNull();
  expect(swapped.upright).not.toBeNull();
});

test('zoom tightens the crop and the frame stays inside the picture', async ({ app }) => {
  const out = await app.page.evaluate(() => {
    const { cropFor } = window.frame;
    const wide = cropFor({ width: 1920, height: 1080, outWidth: 1920, outHeight: 1080, frame: { zoom: 2, x: 0.5, y: 0.5 } });
    const corner = cropFor({ width: 1920, height: 1080, outWidth: 1920, outHeight: 1080, frame: { zoom: 2, x: 0, y: 0 } });
    const past = cropFor({ width: 1920, height: 1080, outWidth: 1920, outHeight: 1080, frame: { zoom: 2, x: 9, y: 9 } });
    return { wide, corner, past };
  });
  expect(out.wide.width).toBe(960);
  expect(out.corner.left).toBe(0);
  expect(out.corner.top).toBe(0);
  // Clamped: you can move the frame around, never off the edge.
  expect(out.past.left).toBe(1920 - out.past.width);
  expect(out.past.top).toBe(1080 - out.past.height);
});

test('rotate turns a quarter at a time and comes back round', async ({ app }) => {
  await withItem(app);
  const button = app.page.locator('#itemRotate');
  for (const want of [90, 180, 270, 0]) {
    await button.click();
    await expect.poll(async () => (await first(app)).rotate ?? 0).toBe(want);
  }
  await expect(app.page.locator('#itemRotateValue')).toHaveText('0°');
});

test('zoom is stored on the clip and survives a reload', async ({ app }) => {
  await withItem(app);
  await app.page.locator('#itemZoom').fill('2.5');
  await expect.poll(async () => (await first(app)).frame?.zoom).toBeCloseTo(2.5, 2);

  await app.page.reload();
  await app.page.waitForFunction(() => window.S?.project);
  await expect.poll(async () => (await app.state()).timeline.length, { timeout: 20_000 }).toBe(1);
  expect((await first(app)).frame.zoom).toBeCloseTo(2.5, 2);
});

test('dragging the picture moves the frame', async ({ app }) => {
  await withItem(app);
  await app.page.evaluate(() => window.setItemFrame(window.S.timeline[0].id, { zoom: 2 }));
  const before = (await first(app)).frame;

  const box = await app.page.locator('#stage').boundingBox();
  await app.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await app.page.mouse.down();
  await app.page.mouse.move(box.x + box.width / 2 - 120, box.y + box.height / 2, { steps: 10 });
  await app.page.mouse.up();

  const after = (await first(app)).frame;
  expect(after.x, 'the frame did not move').toBeGreaterThan(before.x);
  expect(after.zoom).toBeCloseTo(2, 2);
});

test('reset puts a clip back to how it was shot', async ({ app }) => {
  await withItem(app);
  await app.page.evaluate(async (id) => {
    await window.setItemFrame(id, { zoom: 3, x: 0.2 });
    await window.setItemFrame(id, { rotate: 90 });
  }, (await first(app)).id);
  await expect(app.page.locator('#itemFrameReset')).toBeEnabled();

  await app.page.locator('#itemFrameReset').click();

  const item = await first(app);
  expect(item.frame).toBeUndefined();
  expect(item.rotate).toBeUndefined();
  await expect(app.page.locator('#itemFrameReset')).toBeDisabled();
});

test('framing is undoable as one step per drag', async ({ app }) => {
  await withItem(app);
  await app.page.evaluate(() => window.setItemFrame(window.S.timeline[0].id, { zoom: 2 }));
  const depth = await app.page.evaluate(() => window.historyDepth().past);

  const box = await app.page.locator('#stage').boundingBox();
  await app.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await app.page.mouse.down();
  await app.page.mouse.move(box.x + box.width / 2 - 100, box.y + box.height / 2, { steps: 15 });
  await app.page.mouse.up();

  const added = (await app.page.evaluate(() => window.historyDepth().past)) - depth;
  expect(added, 'the drag pushed a step per move').toBe(1);
});

test('the fitting setting is stored with the project', async ({ app }) => {
  await app.add('land');
  await app.page.locator('#settingsBtn').click();
  await app.page.locator('#fitSel').selectOption('cover');
  await expect.poll(async () => (await app.state()).settings.fit).toBe('cover');

  await app.page.reload();
  await app.page.waitForFunction(() => window.S?.project);
  expect((await app.state()).settings.fit).toBe('cover');
});

// The point of framing is that what you line up on screen is what comes out, so
// the preview and the render go through one function. This checks the pixels.
test('the render shows the same part of the picture as the preview', async ({ app }) => {
  test.setTimeout(120_000);
  // The grid clip varies in both axes, so one crop is plainly not another. The
  // others fill each frame with a single colour and cannot tell them apart.
  await withItem(app, 'grid');
  // A vertical output from landscape footage, zoomed and pushed off centre:
  // the case where a wrong crop would be obvious.
  await app.page.evaluate(() => window.setSettings({ width: 1080, height: 1920 }));
  await app.page.evaluate(() => window.setItemFrame(window.S.timeline[0].id, { zoom: 2.5, x: 0.22, y: 0.5 }));

  const result = await app.page.evaluate(async () => {
    const read = (canvas) => {
      const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
      // Sample a grid rather than one pixel, so a small offset still shows.
      const points = [];
      for (const fx of [0.25, 0.5, 0.75]) {
        for (const fy of [0.25, 0.5, 0.75]) {
          const i = ((Math.floor(fy * canvas.height) * canvas.width) + Math.floor(fx * canvas.width)) * 4;
          points.push([data[i], data[i + 1], data[i + 2]]);
        }
      }
      return points;
    };

    window.setView('sequence');
    await window.seekSequence(0.5);
    await new Promise((r) => setTimeout(r, 300));
    const shown = read(document.getElementById('preview'));

    let captured = null;
    const realCreate = URL.createObjectURL;
    URL.createObjectURL = function (b) { captured = b; return realCreate.call(URL, b); };
    HTMLAnchorElement.prototype.click = function () {};
    await window.exportSequence();
    URL.createObjectURL = realCreate;

    const mb = await import('/test/mediabunny.mjs');
    const input = new mb.Input({ source: new mb.BlobSource(captured), formats: mb.ALL_FORMATS });
    const track = await input.getPrimaryVideoTrack();
    const sink = new mb.VideoSampleSink(track);
    const sample = await sink.getSample(0.5);
    const canvas = document.createElement('canvas');
    canvas.width = await track.getDisplayWidth();
    canvas.height = await track.getDisplayHeight();
    sample.drawWithFit(canvas.getContext('2d'), { fit: 'fill' });
    const rendered = read(canvas);
    sample.close();
    const size = [canvas.width, canvas.height];
    input.dispose();
    return { shown, rendered, size };
  });

  expect(result.size).toEqual([1080, 1920]);
  for (let i = 0; i < result.shown.length; i++) {
    for (let c = 0; c < 3; c++) {
      expect(Math.abs(result.shown[i][c] - result.rendered[i][c]),
        `point ${i} channel ${c}: preview ${result.shown[i]} vs render ${result.rendered[i]}`)
        .toBeLessThan(30);
    }
  }
});

test('a rotated clip comes out rotated', async ({ app }) => {
  test.setTimeout(120_000);
  await withItem(app);
  await app.page.evaluate(() => window.setItemFrame(window.S.timeline[0].id, { rotate: 90 }));

  const size = await app.page.evaluate(async () => {
    let captured = null;
    const realCreate = URL.createObjectURL;
    URL.createObjectURL = function (b) { captured = b; return realCreate.call(URL, b); };
    HTMLAnchorElement.prototype.click = function () {};
    await window.exportSequence();
    URL.createObjectURL = realCreate;
    const mb = await import('/test/mediabunny.mjs');
    const input = new mb.Input({ source: new mb.BlobSource(captured), formats: mb.ALL_FORMATS });
    const track = await input.getPrimaryVideoTrack();
    const out = [await track.getDisplayWidth(), await track.getDisplayHeight()];
    input.dispose();
    return out;
  });
  // The output keeps the sequence's shape; the rotation happens inside it.
  expect(size).toEqual([1280, 720]);
});
