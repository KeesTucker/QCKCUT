import { test, expect } from '../lib/app.mjs';

async function withTone(app) {
  await app.add('tone');                      // carries a 440Hz tone
  await app.page.evaluate(async () => {
    window.S.in = 0;
    window.S.out = 1.5;
    await window.appendRange();
  });
  await app.page.locator('#track .track-item').first().click();
  await app.page.locator('#tabEffects').click();
}

const item = async (app) => (await app.state()).timeline[0];

test('a clip starts at full level and unmuted', async ({ app }) => {
  await withTone(app);
  await expect(app.page.locator('#clipAudioBox')).toBeVisible();
  await expect(app.page.locator('#transitionBox')).toBeHidden();
  await expect(app.page.locator('#itemGainValue')).toHaveText('100%');
  await expect(app.page.locator('#itemMute')).toHaveAttribute('data-state', 'on');

  const one = await item(app);
  expect(one.gain ?? 1).toBe(1);
  expect(one.muted ?? false).toBe(false);
});

test('the level slider sets that clip only', async ({ app }) => {
  await withTone(app);
  await app.page.evaluate(async () => {
    window.S.in = 2;
    window.S.out = 3;
    await window.appendRange();
  });

  const first = (await app.state()).timeline[0].id;
  await app.page.evaluate((id) => window.setItemAudio(id, { gain: 0.3 }), first);

  const s = await app.state();
  expect(s.timeline[0].gain).toBeCloseTo(0.3, 2);
  expect(s.timeline[1].gain ?? 1, 'the other clip moved too').toBe(1);
});

test('mute is a toggle and disables the slider', async ({ app }) => {
  await withTone(app);
  await app.page.locator('#itemMute').click();

  await expect(app.page.locator('#itemMute')).toHaveAttribute('data-state', 'off');
  await expect(app.page.locator('#itemGain')).toBeDisabled();
  expect((await item(app)).muted).toBe(true);

  await app.page.locator('#itemMute').click();
  await expect(app.page.locator('#itemMute')).toHaveAttribute('data-state', 'on');
  await expect(app.page.locator('#itemGain')).toBeEnabled();
});

test('a quiet clip says so on the track', async ({ app }) => {
  await withTone(app);
  const el = app.page.locator('#track .track-item').first();
  await expect(el.locator('.track-item-gain')).toHaveCount(0);

  await app.page.evaluate(async () => {
    await window.setItemAudio(window.S.timeline[0].id, { gain: 0.4 });
  });
  await expect(el).toHaveClass(/silent/);
  await expect(el.locator('.track-item-gain')).toHaveText('40%');

  await app.page.evaluate(async () => {
    await window.setItemAudio(window.S.timeline[0].id, { muted: true });
  });
  await expect(el.locator('.track-item-gain')).toHaveText('muted');
});

test('the level survives a reload', async ({ app }) => {
  await withTone(app);
  await app.page.evaluate(async () => {
    await window.setItemAudio(window.S.timeline[0].id, { gain: 0.25, muted: false });
  });

  await app.page.reload();
  await app.page.waitForFunction(() => window.S?.project);
  await expect.poll(async () => (await app.state()).timeline.length, { timeout: 20_000 }).toBe(1);
  expect((await app.state()).timeline[0].gain).toBeCloseTo(0.25, 2);
});

test('a muted clip schedules nothing during playback', async ({ app }) => {
  await withTone(app);

  const count = async () => app.page.evaluate(async () => {
    const ctx = window.audio.audio();
    let nodes = 0;
    const real = ctx.createBufferSource.bind(ctx);
    ctx.createBufferSource = () => { nodes++; return real(); };
    window.S.seqPlayhead = 0;
    await window.playSequence();
    ctx.createBufferSource = real;
    return nodes;
  });

  const loud = await count();
  expect(loud, 'the tone should have been scheduled').toBeGreaterThan(0);

  await app.page.evaluate(async () => {
    await window.setItemAudio(window.S.timeline[0].id, { muted: true });
  });
  expect(await count(), 'a muted clip still scheduled sound').toBe(0);
});

test('a muted clip is silent in the render, and an unmuted one is not', async ({ app }) => {
  test.setTimeout(120_000);
  await withTone(app);

  const hasAudio = () => app.page.evaluate(async () => {
    let captured = null;
    const realCreate = URL.createObjectURL;
    URL.createObjectURL = function (b) { captured = b; return realCreate.call(URL, b); };
    HTMLAnchorElement.prototype.click = function () {};
    await window.exportSequence();
    URL.createObjectURL = realCreate;
    const mb = await import('/test/mediabunny.mjs');
    const input = new mb.Input({ source: new mb.BlobSource(captured), formats: mb.ALL_FORMATS });
    const track = await input.getPrimaryAudioTrack();
    input.dispose();
    return !!track;
  });

  expect(await hasAudio()).toBe(true);

  await app.page.evaluate(async () => {
    await window.setItemAudio(window.S.timeline[0].id, { muted: true });
  });
  // The only source of sound was that clip, so muting it empties the track.
  expect(await hasAudio(), 'mute did not reach the render').toBe(false);
});

test('clicking a joint shows the transition, not the clip', async ({ app }) => {
  await withTone(app);
  await expect(app.page.locator('#clipAudioBox')).toBeVisible();

  await app.page.evaluate(() => window.selectBoundary('intro'));
  await expect(app.page.locator('#transitionBox')).toBeVisible();
  await expect(app.page.locator('#clipAudioBox')).toBeHidden();
});
