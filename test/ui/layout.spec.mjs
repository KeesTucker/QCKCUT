import { test, expect } from '../lib/app.mjs';

// Regression: the preview canvas is the source's native pixel size, which is
// usually bigger than the stage. It used to overflow and cover the timeline, so
// dragging the scrubber hit the canvas instead.
for (const clip of ['land', 'port', 'hd']) {
  test(`${clip}: preview never overlaps the timeline`, async ({ app }) => {
    await app.add(clip);
    const { stage, timeline, preview } = await app.boxes();
    expect(preview.bottom).toBeLessThanOrEqual(timeline.top + 1);
    expect(preview.bottom).toBeLessThanOrEqual(stage.bottom + 1);
    expect(preview.top).toBeGreaterThanOrEqual(stage.top - 1);
  });
}

test('preview stays inside the stage across window sizes', async ({ app }) => {
  await app.add('hd');
  for (const size of [{ width: 1440, height: 900 }, { width: 1000, height: 600 }, { width: 820, height: 900 }]) {
    await app.page.setViewportSize(size);
    const { stage, timeline, preview } = await app.boxes();
    expect(preview.bottom, `overlap at ${size.width}x${size.height}`).toBeLessThanOrEqual(timeline.top + 1);
    expect(preview.height).toBeLessThanOrEqual(stage.height + 1);
  }
});

test('the preview sits between the Sources and Clips panels', async ({ app }) => {
  await app.add('land');
  const { stage } = await app.boxes();
  const left = await app.page.locator('.panel-left').boundingBox();
  const right = await app.page.locator('.panel-right').boundingBox();
  expect(left.x + left.width).toBeLessThanOrEqual(stage.left + 1);
  expect(right.x).toBeGreaterThanOrEqual(stage.right - 1);
});

// Regression: the bottom rows could shrink, so adding the music lane pushed the
// sequence off the bottom of the window instead of squeezing the preview.
test('nothing is clipped off the bottom of the window', async ({ app }) => {
  await app.add('land');
  await app.page.evaluate(async () => {
    window.S.in = 0;
    window.S.out = 1;
    await window.appendRange();
    const blob = await (await fetch('/test/media/bed.wav')).blob();
    await window.setMusic(new File([blob], 'bed.wav', { type: 'audio/wav' }));
  });

  for (const size of [{ width: 1440, height: 900 }, { width: 1100, height: 700 }]) {
    await app.page.setViewportSize(size);
    const boxes = await app.page.evaluate(() => {
      const of = (sel) => {
        const { top, bottom, height } = document.querySelector(sel).getBoundingClientRect();
        return { top, bottom, height };
      };
      return {
        music: of('#musicTrack'),
        track: of('#track'),
        sequence: of('.sequence'),
        viewport: window.innerHeight,
      };
    });
    const where = `${size.width}x${size.height}`;
    expect(boxes.sequence.bottom, `sequence clipped at ${where}`)
      .toBeLessThanOrEqual(boxes.viewport + 1);
    expect(boxes.music.bottom, `music lane clipped at ${where}`)
      .toBeLessThanOrEqual(boxes.viewport + 1);
    // And the rows kept their real height rather than being squeezed flat.
    expect(boxes.track.height, `track squashed at ${where}`).toBeGreaterThan(40);
    expect(boxes.music.height, `music lane squashed at ${where}`).toBeGreaterThan(20);
  }
});
