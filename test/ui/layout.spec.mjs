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
      const tracks = document.getElementById('tracks');
      return {
        music: of('#musicTrack'),
        track: of('#track'),
        sequence: of('.sequence'),
        tracks: of('#tracks'),
        scroll: tracks.scrollHeight - tracks.clientHeight,
        viewport: window.innerHeight,
      };
    });
    const where = `${size.width}x${size.height}`;
    // The tracks live in a resizable, scrollable column, so what matters is
    // that the column itself is on screen and its contents are reachable.
    expect(boxes.tracks.bottom, `tracks clipped at ${where}`)
      .toBeLessThanOrEqual(boxes.viewport + 1);
    expect(boxes.tracks.height, `tracks squashed at ${where}`).toBeGreaterThan(120);
    expect(boxes.sequence.bottom, `sequence unreachable at ${where}`)
      .toBeLessThanOrEqual(boxes.tracks.bottom + boxes.scroll + 1);
    // And the rows kept their real height rather than being squeezed flat.
    expect(boxes.track.height, `track squashed at ${where}`).toBeGreaterThan(40);
    expect(boxes.music.height, `music lane squashed at ${where}`).toBeGreaterThan(20);
  }
});

test('the splitter trades height between the picture and the tracks', async ({ app }) => {
  await app.add('land');
  const heights = () => app.page.evaluate(() => ({
    tracks: document.getElementById('tracks').getBoundingClientRect().height,
    stage: document.getElementById('stage').getBoundingClientRect().height,
  }));

  const before = await heights();
  await app.page.evaluate(() => window.setTracksHeight(before => 0));   // ignored arg
  await app.page.evaluate(() => window.setTracksHeight(document.getElementById('tracks').offsetHeight + 90));
  const after = await heights();

  expect(after.tracks).toBeGreaterThan(before.tracks + 60);
  expect(after.stage, 'the picture did not give up the room').toBeLessThan(before.stage - 60);
});

test('the tracks cannot be dragged away entirely', async ({ app }) => {
  await app.add('land');
  await app.page.evaluate(() => window.setTracksHeight(10));
  const height = await app.page.evaluate(() =>
    document.getElementById('tracks').getBoundingClientRect().height);
  expect(height).toBeGreaterThan(120);
});

test('the chosen height comes back on reload', async ({ app }) => {
  await app.add('land');
  await app.page.evaluate(() => window.setTracksHeight(300));
  await app.page.reload();
  await app.page.waitForFunction(() => window.S?.project);
  const height = await app.page.evaluate(() =>
    document.getElementById('tracks').getBoundingClientRect().height);
  expect(height).toBeCloseTo(300, -1);
});
