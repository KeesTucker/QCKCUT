import { test } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FIXTURES, FIXTURE_DIR } from './lib/clips.mjs';

// Encodes each test clip in the browser and writes it to disk. Done once per
// run so the specs stay fast, and it keeps binaries out of the repo.
test('render test clips', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await mkdir(FIXTURE_DIR, { recursive: true });

  for (const [name, options] of Object.entries(FIXTURES)) {
    const bytes = await page.evaluate(async (opts) => {
      const { makeClip } = await import('/test/fixture.mjs');
      const file = await makeClip(opts);
      return [...new Uint8Array(await file.arrayBuffer())];
    }, options);
    await writeFile(join(FIXTURE_DIR, `${name}.mp4`), Buffer.from(bytes));
  }

  const music = await page.evaluate(async () => {
    const { makeMusic } = await import('/test/fixture.mjs');
    return [...new Uint8Array(await makeMusic().arrayBuffer())];
  });
  await writeFile(join(FIXTURE_DIR, 'bed.wav'), Buffer.from(music));
});
