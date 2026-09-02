import { test, expect } from '../lib/app.mjs';

const bar = (app) => app.page.locator('#exportBar');
const button = (app) => app.page.locator('#exportBtn');

async function withSequence(app, out = 4) {
  await app.add('hd');
  await app.page.evaluate(async (end) => {
    window.S.in = 0;
    window.S.out = end;
    await window.appendRange();
  }, out);
}

test('the header becomes a progress bar while rendering', async ({ app }) => {
  test.setTimeout(120_000);
  await withSequence(app);

  await app.page.evaluate(() => {
    HTMLAnchorElement.prototype.click = function () {};
    window.exportShowing();
  });

  await expect(bar(app)).toBeVisible();
  await expect(app.page.locator('#menu')).toBeHidden();
  await expect(button(app)).toHaveText('Cancel');
  await expect(button(app)).toBeEnabled();
  await expect(app.page.locator('body')).toHaveClass(/busy/);
  await expect(app.page.locator('#exportLabel')).not.toBeEmpty();

  await expect.poll(async () => app.page.evaluate(() => window.S.exporting), { timeout: 90_000 })
    .toBe(false);

  // And it puts itself away again.
  await expect(bar(app)).toBeHidden();
  await expect(app.page.locator('#menu')).toBeVisible();
  await expect(button(app)).toHaveText('Export sequence');
  await expect(app.page.locator('body')).not.toHaveClass(/busy/);
});

test('the bar fills as the render advances', async ({ app }) => {
  test.setTimeout(120_000);
  await withSequence(app);

  const widths = await app.page.evaluate(async () => {
    const fill = document.getElementById('exportFill');
    const seen = [];
    const timer = setInterval(() => seen.push(parseFloat(fill.style.width) || 0), 30);
    HTMLAnchorElement.prototype.click = function () {};
    await window.exportShowing();
    clearInterval(timer);
    return seen;
  });

  expect(widths.length).toBeGreaterThan(2);
  // Monotonic: a bar that goes backwards reads as the work being redone.
  for (let i = 1; i < widths.length; i++) {
    expect(widths[i]).toBeGreaterThanOrEqual(widths[i - 1]);
  }
  expect(Math.max(...widths)).toBeGreaterThan(20);
});

test('Cancel stops the render and downloads nothing', async ({ app }) => {
  test.setTimeout(120_000);
  await withSequence(app, 8);

  const result = await app.page.evaluate(async () => {
    let downloaded = false;
    HTMLAnchorElement.prototype.click = function () { downloaded = true; };
    const running = window.exportShowing();
    await new Promise((r) => setTimeout(r, 350));
    document.getElementById('exportBtn').click();   // now reads Cancel
    const blob = await running;
    return { blob, downloaded };
  });

  expect(result.blob).toBeNull();
  expect(result.downloaded, 'a cancelled render must not produce a file').toBe(false);
  // Said over the picture and then gone, rather than left sitting in the header.
  await expect(app.page.locator('#warnToast')).toBeVisible();
  await expect(app.page.locator('#warnTitle')).toHaveText('Render cancelled');
  await expect(app.page.locator('#status')).toBeEmpty();
  await expect(app.page.locator('#warnToast')).toBeHidden({ timeout: 8000 });
});

test('Escape cancels too', async ({ app }) => {
  test.setTimeout(120_000);
  await withSequence(app, 8);

  await app.page.evaluate(() => {
    HTMLAnchorElement.prototype.click = function () {};
    window.__run = window.exportShowing();
  });
  await expect(bar(app)).toBeVisible();

  await app.page.keyboard.press('Escape');
  await app.page.evaluate(() => window.__run);

  await expect.poll(async () => app.page.evaluate(() => window.S.exporting)).toBe(false);
  await expect(app.page.locator('#warnTitle')).toHaveText('Render cancelled');
});

test('the app is fully usable again after cancelling', async ({ app }) => {
  test.setTimeout(120_000);
  await withSequence(app, 8);

  await app.page.evaluate(async () => {
    HTMLAnchorElement.prototype.click = function () {};
    const running = window.exportShowing();
    await new Promise((r) => setTimeout(r, 300));
    window.cancelExport();
    await running;
  });

  await expect(app.page.locator('body')).not.toHaveClass(/busy/);
  await expect(button(app)).toHaveText('Export sequence');
  // Editing works, and so does rendering again.
  await app.page.evaluate(() => window.seek(2));
  expect((await app.state()).playhead).toBeCloseTo(2, 1);
  const ts = await app.page.evaluate(async () => {
    const source = window.S.sources[0];
    const sample = await window.media.using(source, ({ sink }) => sink.getSample(1));
    const t = sample?.timestamp ?? null;
    sample?.close();
    return t;
  });
  expect(ts).not.toBeNull();
});

test('shortcuts do nothing while a render runs', async ({ app }) => {
  test.setTimeout(120_000);
  await withSequence(app, 8);
  const before = await app.state();

  await app.page.evaluate(() => {
    HTMLAnchorElement.prototype.click = function () {};
    window.__run = window.exportShowing();
  });
  await expect(bar(app)).toBeVisible();

  await app.page.keyboard.press('c');
  await app.page.keyboard.press('m');
  await app.page.keyboard.press('t');

  const during = await app.state();
  expect(during.clips).toHaveLength(before.clips.length);
  expect(during.timeline).toHaveLength(before.timeline.length);
  expect(during.muted).toBe(before.muted);
  expect(during.marking).toBeNull();

  await app.page.evaluate(() => { window.cancelExport(); return window.__run; });
});

test('starting a render clears the last cancellation notice', async ({ app }) => {
  test.setTimeout(120_000);
  await withSequence(app, 8);

  await app.page.evaluate(async () => {
    HTMLAnchorElement.prototype.click = function () {};
    const running = window.exportShowing();
    await new Promise((r) => setTimeout(r, 300));
    window.cancelExport();
    await running;
  });
  await expect(app.page.locator('#warnToast')).toBeVisible();

  await app.page.evaluate(() => { window.__again = window.exportShowing(); });
  await expect(app.page.locator('#warnToast')).toBeHidden();

  await app.page.evaluate(() => { window.cancelExport(); return window.__again; });
});

// Regression: mixAudio was called with a signal it never declared, so a cancel
// did nothing until the picture started. On a long sequence the mix is the slow
// half, which is exactly when Cancel gets pressed.
test('cancelling during the audio mix stops it there', async ({ app }) => {
  test.setTimeout(120_000);
  await app.add('tone');
  await app.page.evaluate(async () => {
    for (let i = 0; i < 6; i++) {
      window.S.in = 0;
      window.S.out = 4.8;
      await window.appendRange();
    }
  });

  const result = await app.page.evaluate(async () => {
    let downloaded = false;
    HTMLAnchorElement.prototype.click = function () { downloaded = true; };
    const label = document.getElementById('exportLabel');
    const running = window.exportShowing();

    // Cancel while the label still says the mix is going.
    let phase = null;
    for (let i = 0; i < 200 && phase === null; i++) {
      if (label.textContent.startsWith('Mixing audio')) phase = 'audio';
      else if (label.textContent.startsWith('Rendering')) phase = 'video';
      else await new Promise((r) => setTimeout(r, 5));
    }
    window.cancelExport();
    const blob = await running;
    return { blob, downloaded, phase };
  });

  expect(result.phase, 'the mix should be reported before the picture').toBe('audio');
  expect(result.blob).toBeNull();
  expect(result.downloaded).toBe(false);
  await expect(app.page.locator('#warnTitle')).toHaveText('Render cancelled');
});
