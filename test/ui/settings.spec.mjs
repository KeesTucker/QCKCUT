import { test, expect } from '../lib/app.mjs';

async function withSequence(app, clip = 'land') {
  await app.add(clip);
  await app.page.evaluate(() => { window.S.in = 0; window.S.out = 1.5; return window.appendRange(); });
}

async function renderSequence(app) {
  return app.page.evaluate(async () => {
    let captured = null;
    const realCreate = URL.createObjectURL;
    URL.createObjectURL = function (b) { captured = b; return realCreate.call(URL, b); };
    HTMLAnchorElement.prototype.click = function () {};
    await window.exportSequence();
    URL.createObjectURL = realCreate;

    const mb = await import('/test/mediabunny.mjs');
    const input = new mb.Input({ source: new mb.BlobSource(captured), formats: mb.ALL_FORMATS });
    const video = await input.getPrimaryVideoTrack();
    const packets = new mb.EncodedPacketSink(video);
    let frames = 0;
    for await (const _ of packets.packets()) frames++;
    const out = {
      width: await video.getDisplayWidth(),
      height: await video.getDisplayHeight(),
      duration: await video.computeDuration(),
      frames,
    };
    input.dispose();
    return out;
  });
}

test('output defaults to matching the source', async ({ app }) => {
  const s = await app.state();
  expect(s.settings).toEqual({ width: null, height: null, fps: null });
  await app.page.locator('#settingsBtn').click();
  await expect(app.page.locator('#resSel')).toHaveValue('auto');
  await expect(app.page.locator('#fpsSel')).toHaveValue('auto');
});

test('the settings persist with the project', async ({ app }) => {
  await app.page.locator('#settingsBtn').click();
  await app.page.locator('#resSel').selectOption('1080x1920');
  await app.page.locator('#fpsSel').selectOption('30');

  await expect.poll(async () => (await app.state()).settings)
    .toEqual({ width: 1080, height: 1920, fps: 30 });

  await app.page.reload();
  await app.page.waitForFunction(() => window.S?.project);
  expect((await app.state()).settings).toEqual({ width: 1080, height: 1920, fps: 30 });
});

test('settings belong to their own project', async ({ app }) => {
  await app.page.evaluate(() => window.setSettings({ width: 1280, height: 720 }));
  await app.page.evaluate(() => window.newProject('Other'));
  expect((await app.state()).settings).toEqual({ width: null, height: null, fps: null });
});

test('a resolution setting shapes the render', async ({ app }) => {
  test.setTimeout(120_000);
  await withSequence(app);              // land is 640x360
  await app.page.evaluate(() => window.setSettings({ width: 1080, height: 1920 }));

  const out = await renderSequence(app);
  expect([out.width, out.height]).toEqual([1080, 1920]);
  expect(out.duration).toBeCloseTo(1.5, 1);
});

test('a frame rate setting resamples the render', async ({ app }) => {
  test.setTimeout(120_000);
  await withSequence(app);              // the fixtures are 30fps
  await app.page.evaluate(() => window.setSettings({ fps: 10 }));

  const out = await renderSequence(app);
  // 1.5 seconds at ten a second.
  expect(out.frames).toBe(15);
  expect(out.duration).toBeCloseTo(1.5, 1);
});

test('auto keeps the source’s own timings', async ({ app }) => {
  test.setTimeout(120_000);
  await withSequence(app);
  const out = await renderSequence(app);
  // 30fps source, so roughly 45 frames rather than a resampled count.
  expect(out.frames).toBeGreaterThan(40);
  expect([out.width, out.height]).toEqual([640, 360]);
});

test('the settings reach a single clip export too', async ({ app }) => {
  test.setTimeout(120_000);
  await app.add('land');
  await app.page.evaluate(() => window.setSettings({ width: 1280, height: 720 }));

  const out = await app.page.evaluate(async () => {
    window.S.in = 0;
    window.S.out = 1;
    let captured = null;
    const realCreate = URL.createObjectURL;
    URL.createObjectURL = function (b) { captured = b; return realCreate.call(URL, b); };
    HTMLAnchorElement.prototype.click = function () {};
    await window.exportRange();
    URL.createObjectURL = realCreate;

    const mb = await import('/test/mediabunny.mjs');
    const input = new mb.Input({ source: new mb.BlobSource(captured), formats: mb.ALL_FORMATS });
    const video = await input.getPrimaryVideoTrack();
    const size = [await video.getDisplayWidth(), await video.getDisplayHeight()];
    input.dispose();
    return size;
  });
  expect(out).toEqual([1280, 720]);
});
