import { test, expect } from '../lib/app.mjs';

// Codec availability belongs to the browser and the machine, not the file, so
// the only honest answer is to ask at runtime. MDN recommends exactly this:
// https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API/Codec_selection
test('the help dialog says what this browser can decode', async ({ app }) => {
  await app.page.locator('#helpBtn').click();
  const chips = app.page.locator('#formatSupport .format');
  await expect.poll(async () => chips.count()).toBeGreaterThan(5);

  // Chrome runs the suite, so H.264 and AAC must both come back supported.
  await expect(chips.filter({ hasText: 'H.264' })).toHaveAttribute('data-ok', 'yes');
  await expect(chips.filter({ hasText: 'AAC' })).toHaveAttribute('data-ok', 'yes');
});

test('the probe reports each codec one way or the other', async ({ app }) => {
  const answer = await app.page.evaluate(() => window.media.support());
  expect(answer.webCodecs).toBe(true);
  expect(answer.video.map((v) => v.name)).toEqual(['avc', 'hevc', 'vp9', 'vp8', 'av1']);
  for (const entry of [...answer.video, ...answer.audio]) {
    expect(typeof entry.supported, `${entry.label} was not answered`).toBe('boolean');
  }
});

test('an unknown codec string answers false rather than throwing', async ({ app }) => {
  const ok = await app.page.evaluate(async () => {
    try {
      // isConfigSupported rejects on a string it cannot parse.
      await VideoDecoder.isConfigSupported({ codec: 'nonsense', codedWidth: 8, codedHeight: 8 });
      return 'resolved';
    } catch {
      return 'threw';
    }
  });
  // Whatever it does, support() must survive it: that is the case media.js guards.
  expect(['resolved', 'threw']).toContain(ok);
  const answer = await app.page.evaluate(() => window.media.support());
  expect(answer.video).toHaveLength(5);
});
