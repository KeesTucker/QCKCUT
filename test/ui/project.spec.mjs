import { test, expect } from '../lib/app.mjs';

// Sources hold blobs, so the project lives in IndexedDB. Surviving a reload is
// what makes a no-build dev loop bearable.
test('sources and clips survive a reload', async ({ app }) => {
  await app.add('land', 'port');
  await app.page.evaluate(() => { window.S.in = 1; window.S.out = 3; return window.addClip(); });
  const before = await app.state();

  await app.page.reload();
  await expect.poll(async () => (await app.state()).sources.length, { timeout: 20_000 }).toBe(2);

  const after = await app.state();
  expect(after.sources.map((s) => s.name)).toEqual(before.sources.map((s) => s.name));
  // Codec is part of the record, so the header does not come back as "?".
  expect(await app.page.evaluate(() => window.S.sources.map((s) => s.codec))).toEqual(['avc', 'avc']);
  expect(after.clips).toHaveLength(1);
  expect(after.clips[0].in).toBeCloseTo(1, 3);
  expect(after.clips[0].out).toBeCloseTo(3, 3);
});

test('a restored project rebuilds filmstrips and stays decodable', async ({ app }) => {
  await app.add('land');
  await app.page.reload();
  await app.stripReady();

  const s = await app.state();
  const active = s.sources.find((x) => x.id === s.activeId);
  expect(active.thumbsDecoded).toBe(active.thumbCount);
  expect(s.openDecoders).toBeGreaterThan(0);
});

test('removing a source removes it from the project too', async ({ app }) => {
  await app.add('land', 'port');
  const id = (await app.state()).sources[0].id;
  await app.page.evaluate((x) => window.removeSource(x), id);
  await app.page.reload();
  await expect.poll(async () => (await app.state()).sources.length, { timeout: 20_000 }).toBe(1);
  expect((await app.state()).sources[0].name).toBe('port.mp4');
});

// Regression: writes resolved on request.onsuccess, which fires before the
// transaction commits. Reloading straight after an edit aborted the write.
test('an edit made immediately before a reload is not lost', async ({ app }) => {
  await app.add('land');
  await app.page.evaluate(async () => {
    const clip = await window.addClip();
    await window.setClipRange(clip.id, 2.25, 4.5);
  });

  await app.page.reload();
  await expect.poll(async () => (await app.state()).clips.length, { timeout: 20_000 }).toBe(1);
  const clip = (await app.state()).clips[0];
  expect(clip.in).toBeCloseTo(2.25, 2);
  expect(clip.out).toBeCloseTo(4.5, 2);
});

// Regression: `kind` was not part of the stored record, so every restored
// source came back looking like audio and its filmstrip never built.
test('a restored source remembers whether it has pictures', async ({ app }) => {
  await app.add('land');
  await app.page.evaluate(async () => {
    const blob = await (await fetch('/test/media/bed.wav')).blob();
    await window.addSource(new File([blob], 'bed.wav', { type: 'audio/wav' }));
  });
  await app.stripReady();

  await app.page.reload();
  await expect.poll(async () => (await app.state()).sources.length, { timeout: 20_000 }).toBe(2);
  await app.stripReady();

  const kinds = Object.fromEntries((await app.state()).sources.map((s) => [s.name, s.kind]));
  expect(kinds).toEqual({ 'land.mp4': 'video', 'bed.wav': 'audio' });
});
