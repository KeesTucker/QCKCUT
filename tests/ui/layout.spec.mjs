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
