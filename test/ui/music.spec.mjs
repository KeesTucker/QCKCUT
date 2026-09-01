import { test, expect } from '../lib/app.mjs';

const gain = (app) => app.page.locator('#musicGain');
const lane = (app) => app.page.locator('#musicTrack');

async function addMusic(app) {
  await app.page.evaluate(async () => {
    const blob = await (await fetch('/test/media/bed.wav')).blob();
    await window.setMusic(new File([blob], 'bed.wav', { type: 'audio/wav' }));
  });
}

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

test('dropping an audio file makes it the music bed, not a source', async ({ app }) => {
  await app.page.evaluate(async () => {
    const blob = await (await fetch('/test/media/bed.wav')).blob();
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'bed.wav', { type: 'audio/wav' }));
    document.dispatchEvent(
      new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });

  await expect.poll(async () => (await app.state()).music?.name).toBe('bed.wav');
  const s = await app.state();
  expect(s.sources, 'audio must not become a source').toHaveLength(0);
  expect(s.music.duration).toBeCloseTo(8, 0);
});

test('the music controls and waveform appear only with a bed loaded', async ({ app }) => {
  await expect(app.page.locator('#musicGainWrap')).toBeHidden();
  await expect(lane(app)).toBeHidden();

  await addMusic(app);
  await expect(app.page.locator('#musicGainWrap')).toBeVisible();
  await expect(lane(app)).toBeVisible();
  await expect(app.page.locator('#musicName')).toHaveText('bed.wav');
});

test('the waveform is drawn from the decoded buffer', async ({ app }) => {
  await addMusic(app);
  const painted = await app.page.evaluate(() => {
    const canvas = document.getElementById('musicTrack');
    const ctx = canvas.getContext('2d');
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let lit = 0;
    // Count pixels that are not the lane background.
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 60 && data[i + 1] < 90) lit++;
    }
    return lit;
  });
  expect(painted).toBeGreaterThan(100);
});

test('the level slider changes the gain and persists it', async ({ app }) => {
  await addMusic(app);
  await gain(app).fill('0.8');
  await expect.poll(async () => (await app.state()).music.gain).toBeCloseTo(0.8, 2);

  await app.page.reload();
  await expect.poll(async () => (await app.state()).music?.gain, { timeout: 20_000 })
    .toBeCloseTo(0.8, 2);
});

test('the bed survives a reload with its buffer rebuilt', async ({ app }) => {
  await addMusic(app);
  await app.page.reload();
  await expect.poll(async () => (await app.state()).music?.name, { timeout: 20_000 })
    .toBe('bed.wav');

  // The AudioBuffer cannot be stored, so it has to come back by decoding again.
  const ready = await app.page.evaluate(() => !!window.S.music?.buffer?.duration);
  expect(ready).toBe(true);
});

test('removing the bed clears it from the project', async ({ app }) => {
  await addMusic(app);
  await app.page.locator('#musicDrop').click();
  await expect(app.page.locator('#musicGainWrap')).toBeHidden();

  await app.page.reload();
  await app.page.waitForFunction(() => window.S !== undefined);
  expect((await app.state()).music).toBeNull();
});

test('music plays under the sequence', async ({ app }) => {
  await build(app, { clip: 'land', in: 0, out: 1 });
  await addMusic(app);

  const started = await app.page.evaluate(async () => {
    let sources = 0;
    const ctx = window.audio.audio();
    const real = ctx.createBufferSource.bind(ctx);
    ctx.createBufferSource = () => { sources++; return real(); };
    await window.playSequence();
    ctx.createBufferSource = real;
    return sources;
  });
  // land has no audio of its own, so anything scheduled is the bed.
  expect(started).toBeGreaterThan(0);
});

test('music is mixed into the exported sequence', async ({ app }) => {
  test.setTimeout(120_000);
  // land is silent, so any audio in the output can only be the bed.
  await build(app, { clip: 'land', in: 0, out: 1.5 });

  const before = await app.page.evaluate(async () => {
    let captured = null;
    const realCreate = URL.createObjectURL;
    URL.createObjectURL = function (b) { captured = b; return realCreate.call(URL, b); };
    HTMLAnchorElement.prototype.click = function () {};
    await window.exportSequence();
    URL.createObjectURL = realCreate;
    const mb = await import('/test/mediabunny.mjs');
    const input = new mb.Input({ source: new mb.BlobSource(captured), formats: mb.ALL_FORMATS });
    const has = !!(await input.getPrimaryAudioTrack());
    input.dispose();
    return has;
  });
  expect(before, 'silent sequence should have no audio track').toBe(false);

  await addMusic(app);
  const after = await app.page.evaluate(async () => {
    let captured = null;
    const realCreate = URL.createObjectURL;
    URL.createObjectURL = function (b) { captured = b; return realCreate.call(URL, b); };
    HTMLAnchorElement.prototype.click = function () {};
    await window.exportSequence();
    URL.createObjectURL = realCreate;
    const mb = await import('/test/mediabunny.mjs');
    const input = new mb.Input({ source: new mb.BlobSource(captured), formats: mb.ALL_FORMATS });
    const track = await input.getPrimaryAudioTrack();
    const out = {
      hasAudio: !!track,
      audioDuration: track ? await track.computeDuration() : null,
      videoDuration: await (await input.getPrimaryVideoTrack()).computeDuration(),
    };
    input.dispose();
    return out;
  });

  expect(after.hasAudio).toBe(true);
  // The bed is 8s but the sequence is 1.5s: music is cut at the end rather than
  // extending the render.
  expect(after.videoDuration).toBeCloseTo(1.5, 1);
  expect(after.audioDuration).toBeLessThan(2);
});

test('a muted bed is still written to the export', async ({ app }) => {
  test.setTimeout(120_000);
  await build(app, { clip: 'land', in: 0, out: 1 });
  await addMusic(app);
  await app.page.evaluate(() => window.setMuted(true));

  const hasAudio = await app.page.evaluate(async () => {
    let captured = null;
    const realCreate = URL.createObjectURL;
    URL.createObjectURL = function (b) { captured = b; return realCreate.call(URL, b); };
    HTMLAnchorElement.prototype.click = function () {};
    await window.exportSequence();
    URL.createObjectURL = realCreate;
    const mb = await import('/test/mediabunny.mjs');
    const input = new mb.Input({ source: new mb.BlobSource(captured), formats: mb.ALL_FORMATS });
    const has = !!(await input.getPrimaryAudioTrack());
    input.dispose();
    return has;
  });
  // Mute is a preview control, not an edit: it must not silence the render.
  expect(hasAudio).toBe(true);
});

test('a bed at zero gain is left out of the mix', async ({ app }) => {
  test.setTimeout(120_000);
  await build(app, { clip: 'land', in: 0, out: 1 });
  await addMusic(app);
  await app.page.evaluate(() => window.setMusicGain(0));

  const hasAudio = await app.page.evaluate(async () => {
    let captured = null;
    const realCreate = URL.createObjectURL;
    URL.createObjectURL = function (b) { captured = b; return realCreate.call(URL, b); };
    HTMLAnchorElement.prototype.click = function () {};
    await window.exportSequence();
    URL.createObjectURL = realCreate;
    const mb = await import('/test/mediabunny.mjs');
    const input = new mb.Input({ source: new mb.BlobSource(captured), formats: mb.ALL_FORMATS });
    const has = !!(await input.getPrimaryAudioTrack());
    input.dispose();
    return has;
  });
  expect(hasAudio).toBe(false);
});

// A quiet track drew as a flat line before the peaks were normalised, which
// told you nothing about its shape.
test('the waveform is normalised and reflects the level', async ({ app }) => {
  await addMusic(app);

  const measure = () => app.page.evaluate(() => {
    const canvas = document.getElementById('musicTrack');
    const ctx = canvas.getContext('2d');
    const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let tallest = 0;
    for (let x = 0; x < width; x += 4) {
      let lit = 0;
      for (let y = 0; y < height; y++) {
        // Only the solid bar, not the faint full-amplitude one behind it.
        if (data[(y * width + x) * 4 + 3] > 0 && data[(y * width + x) * 4] > 120) lit++;
      }
      tallest = Math.max(tallest, lit);
    }
    return tallest;
  });

  await app.page.evaluate(() => window.setMusicGain(1));
  const loud = await measure();
  await app.page.evaluate(() => window.setMusicGain(0.2));
  const quiet = await measure();

  // Normalisation means a full-gain waveform nearly fills the lane...
  expect(loud).toBeGreaterThan(12);
  // ...and lowering the level visibly shrinks it.
  expect(quiet).toBeLessThan(loud / 2);
});
