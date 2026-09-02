import { test, expect } from '../lib/app.mjs';

const lanes = (app) => app.page.locator('#audioLanes .audio-lane');
const laneItems = (app, i = 0) => app.page.locator(`#audioLanes .audio-lane:nth-child(${i + 1}) .track-item`);
const videoItems = (app) => app.page.locator('#track .track-item');

async function setup(app) {
  await app.add('land');
  await app.page.evaluate(async () => {
    const blob = await (await fetch('/test/media/bed.wav')).blob();
    await window.addSource(new File([blob], 'bed.wav', { type: 'audio/wav' }));
  });
  await app.stripReady();
}

const sourceIdOf = async (app, name) =>
  (await app.state()).sources.find((s) => s.name === name).id;

/**
 * Mark a range on a named source and append it to the video lane. The source
 * has to be chosen explicitly: setup() adds the audio file last, so it is the
 * active one, and appending blind would put sound on the picture lane.
 */
async function appendFrom(app, name, start, end) {
  const id = await sourceIdOf(app, name);
  await app.page.evaluate(async ([sourceId, a, b]) => {
    await window.setActive(sourceId);
    window.S.in = a;
    window.S.out = b;
    await window.appendRange();
  }, [id, start, end]);
}

/** Put a whole source on a lane. Video lane when trackId is null. */
async function place(app, name, trackId = null, index = 0) {
  const id = await sourceIdOf(app, name);
  return app.page.evaluate(([sourceId, track, at]) =>
    window.addToSequence('source', sourceId, at, track), [id, trackId, index]);
}

test('an audio track can be added and removed', async ({ app }) => {
  await setup(app);
  await expect(lanes(app)).toHaveCount(0);

  await app.page.locator('#addAudioTrack').click();
  await expect(lanes(app)).toHaveCount(1);
  expect((await app.state()).audioTracks).toHaveLength(1);

  await lanes(app).first().hover();
  await lanes(app).first().locator('.lane-drop').click();
  await expect(lanes(app)).toHaveCount(0);
});

// The original bug: music dropped on the sequence pushed the video aside.
test('audio on its own lane does not displace the video', async ({ app }) => {
  await setup(app);
  await place(app, 'land.mp4');
  const before = (await app.state()).timeline.map((i) => [i.start, i.duration]);

  const track = (await app.page.evaluate(() => window.addAudioTrack())).id;
  await place(app, 'bed.wav', track);

  const s = await app.state();
  expect(s.timeline.map((i) => [i.start, i.duration]), 'video moved').toEqual(before);
  expect(s.timeline).toHaveLength(1);
  expect(s.audioTracks[0].items).toHaveLength(1);
  await expect(videoItems(app)).toHaveCount(1);
  await expect(laneItems(app)).toHaveCount(1);
});

test('each lane packs from zero, independently', async ({ app }) => {
  await setup(app);
  const track = (await app.page.evaluate(() => window.addAudioTrack())).id;

  await appendFrom(app, 'land.mp4', 0, 1);
  await appendFrom(app, 'land.mp4', 2, 3.5);
  await place(app, 'bed.wav', track);

  const s = await app.state();
  expect(s.timeline.map((i) => +i.start.toFixed(2))).toEqual([0, 1]);
  expect(s.audioTracks[0].items[0].start).toBe(0);
});

test('the sequence is as long as its longest lane', async ({ app }) => {
  await setup(app);
  // One second of video, eight seconds of audio.
  await appendFrom(app, 'land.mp4', 0, 1);
  const track = (await app.page.evaluate(() => window.addAudioTrack())).id;
  await place(app, 'bed.wav', track);

  const s = await app.state();
  expect(s.videoDuration).toBeCloseTo(1, 1);
  expect(s.sequenceDuration).toBeCloseTo(8, 0);
});

test('removing a video item leaves the audio lane alone', async ({ app }) => {
  await setup(app);
  await place(app, 'land.mp4');
  const track = (await app.page.evaluate(() => window.addAudioTrack())).id;
  await place(app, 'bed.wav', track);

  await app.page.evaluate(() => window.removeFromSequence(window.S.timeline[0].id));

  const s = await app.state();
  expect(s.timeline).toHaveLength(0);
  expect(s.audioTracks[0].items).toHaveLength(1);
  expect(s.audioTracks[0].items[0].start).toBe(0);
});

test('an item can be dragged from one lane to another', async ({ app }) => {
  await setup(app);
  await place(app, 'bed.wav');            // wrongly on the video lane
  const track = (await app.page.evaluate(() => window.addAudioTrack())).id;

  await app.page.evaluate((t) => window.moveBetweenLanes(null, 0, t, 0), track);

  const s = await app.state();
  expect(s.timeline).toHaveLength(0);
  expect(s.audioTracks[0].items).toHaveLength(1);
});

test('lanes and their order survive a reload, empty ones included', async ({ app }) => {
  await setup(app);
  const first = (await app.page.evaluate(() => window.addAudioTrack())).id;
  const second = (await app.page.evaluate(() => window.addAudioTrack())).id;
  await place(app, 'bed.wav', first);

  await app.page.reload();
  await app.page.waitForFunction(() => window.S?.project);
  await expect.poll(async () => (await app.state()).audioTracks.length, { timeout: 20_000 }).toBe(2);

  const s = await app.state();
  expect(s.audioTracks.map((t) => t.id)).toEqual([first, second]);
  expect(s.audioTracks[0].items).toHaveLength(1);
  expect(s.audioTracks[1].items, 'the empty lane was lost').toHaveLength(0);
});

test('a new project starts with no audio tracks', async ({ app }) => {
  await setup(app);
  await app.page.evaluate(() => window.addAudioTrack());
  await app.page.evaluate(() => window.newProject('Fresh'));

  expect((await app.state()).audioTracks).toHaveLength(0);
  await expect(lanes(app)).toHaveCount(0);
});

test('deleting a source clears it from every lane', async ({ app }) => {
  await setup(app);
  await place(app, 'land.mp4');
  const track = (await app.page.evaluate(() => window.addAudioTrack())).id;
  await place(app, 'bed.wav', track);

  const bedId = await sourceIdOf(app, 'bed.wav');
  await app.page.evaluate((id) => window.removeSource(id), bedId);

  const s = await app.state();
  expect(s.timeline).toHaveLength(1);
  expect(s.audioTracks[0].items).toHaveLength(0);
});

test('an audio lane is mixed into the render', async ({ app }) => {
  test.setTimeout(120_000);
  await setup(app);
  // land is silent, so any sound in the output can only be the lane.
  await appendFrom(app, 'land.mp4', 0, 1.5);

  const silent = await render(app);
  expect(silent.hasAudio, 'a silent video lane should have no audio').toBe(false);

  const track = (await app.page.evaluate(() => window.addAudioTrack())).id;
  await app.page.evaluate(async ([id, t]) => {
    await window.setActive(id);
    window.S.in = 0;
    window.S.out = 1;
    // A one second slice of the bed, on the audio lane.
    const clip = await window.addClip();
    await window.addToSequence('clip', clip.id, 0, t);
  }, [await sourceIdOf(app, 'bed.wav'), track]);

  const mixed = await render(app);
  expect(mixed.hasAudio).toBe(true);
  expect(mixed.videoDuration).toBeCloseTo(1.5, 1);
});

test('the picture goes black past the video, and the sound keeps going', async ({ app }) => {
  test.setTimeout(120_000);
  await setup(app);
  await appendFrom(app, 'land.mp4', 0, 1);
  const track = (await app.page.evaluate(() => window.addAudioTrack())).id;
  await place(app, 'bed.wav', track);   // eight seconds

  const out = await render(app, [0.5, 3]);
  expect(out.videoDuration).toBeCloseTo(8, 0);
  expect(out.hasAudio).toBe(true);
  // Inside the video, then well past it.
  expect(out.brightness[0], 'the picture should still be there at 0.5s').toBeGreaterThan(40);
  expect(out.brightness[1], 'past the video it should be black').toBeLessThan(20);
});

/** Render the sequence and probe the result. */
async function render(app, times = []) {
  return app.page.evaluate(async (probe) => {
    let captured = null;
    const realCreate = URL.createObjectURL;
    URL.createObjectURL = function (b) { captured = b; return realCreate.call(URL, b); };
    HTMLAnchorElement.prototype.click = function () {};
    await window.exportSequence();
    URL.createObjectURL = realCreate;

    const mb = await import('/test/mediabunny.mjs');
    const input = new mb.Input({ source: new mb.BlobSource(captured), formats: mb.ALL_FORMATS });
    const video = await input.getPrimaryVideoTrack();
    const sink = new mb.VideoSampleSink(video);
    const brightness = [];
    for (const t of probe) {
      const sample = await sink.getSample(t);
      const canvas = document.createElement('canvas');
      canvas.width = 32;
      canvas.height = 32;
      const ctx = canvas.getContext('2d');
      sample.drawWithFit(ctx, { fit: 'contain' });
      const { data } = ctx.getImageData(0, 0, 32, 32);
      let brightest = 0;
      for (let i = 0; i < data.length; i += 4) {
        brightest = Math.max(brightest, data[i], data[i + 1], data[i + 2]);
      }
      sample.close();
      brightness.push(brightest);
    }
    const out = {
      hasAudio: !!(await input.getPrimaryAudioTrack()),
      videoDuration: await video.computeDuration(),
      brightness,
    };
    input.dispose();
    return out;
  }, times);
}

// Without this, dropping music on a fresh project put it between video clips,
// which is the bug lanes exist to fix.
test('audio makes its own lane when there is none', async ({ app }) => {
  await setup(app);
  await appendFrom(app, 'land.mp4', 0, 1);
  expect((await app.state()).audioTracks).toHaveLength(0);

  await place(app, 'bed.wav');      // aimed at the video lane

  const s = await app.state();
  expect(s.audioTracks, 'no lane was made for it').toHaveLength(1);
  expect(s.audioTracks[0].items).toHaveLength(1);
  expect(s.timeline, 'audio landed on the picture lane').toHaveLength(1);
  await expect(lanes(app)).toHaveCount(1);
});

test('audio joins the lane that already exists', async ({ app }) => {
  await setup(app);
  const track = (await app.page.evaluate(() => window.addAudioTrack())).id;
  await place(app, 'bed.wav');
  await place(app, 'bed.wav');

  const s = await app.state();
  expect(s.audioTracks, 'a second lane was made unnecessarily').toHaveLength(1);
  expect(s.audioTracks[0].id).toBe(track);
  expect(s.audioTracks[0].items).toHaveLength(2);
  expect(s.audioTracks[0].items[1].start).toBeCloseTo(8, 0);
});

test('T on an audio source appends to a lane, not the picture', async ({ app }) => {
  await setup(app);
  await appendFrom(app, 'land.mp4', 0, 1);

  const bed = await sourceIdOf(app, 'bed.wav');
  await app.page.evaluate(async (id) => {
    await window.setActive(id);
    window.S.in = 1;
    window.S.out = 3;
    await window.appendRange();
  }, bed);

  const s = await app.state();
  expect(s.timeline).toHaveLength(1);
  expect(s.audioTracks).toHaveLength(1);
  expect(s.audioTracks[0].items[0].duration).toBeCloseTo(2, 2);
});

test('video still goes on the picture lane', async ({ app }) => {
  await setup(app);
  await place(app, 'land.mp4');

  const s = await app.state();
  expect(s.timeline).toHaveLength(1);
  expect(s.audioTracks).toHaveLength(0);
});

test('a sequence of nothing but sound plays and renders', async ({ app }) => {
  test.setTimeout(120_000);
  await setup(app);
  await place(app, 'bed.wav');          // makes its own lane

  const s = await app.state();
  expect(s.timeline).toHaveLength(0);
  expect(s.sequenceDuration).toBeCloseTo(8, 0);
  await expect(app.page.locator('#playBtn')).toBeEnabled();
  await expect(app.page.locator('#exportBtn')).toHaveText('Export');

  // Trim it short so the render is quick, then check it comes out.
  await app.page.evaluate(() => {
    const item = window.S.audioTracks[0].items[0];
    item.out = 1;
  });
  const out = await render(app, [0.5]);
  expect(out.hasAudio).toBe(true);
  expect(out.videoDuration).toBeCloseTo(1, 1);
  expect(out.brightness[0], 'a sound-only sequence should be black').toBeLessThan(20);
});

// Regression: the transition handles used to live inside the video track's
// bottom padding, which took that height away from every lane below it.
test('audio lanes keep their height whatever the transitions do', async ({ app }) => {
  await setup(app);
  await appendFrom(app, 'land.mp4', 0, 1);
  await appendFrom(app, 'land.mp4', 2, 3);
  await place(app, 'bed.wav');

  const boxes = await app.page.evaluate(() => {
    const h = (sel) => document.querySelector(sel).getBoundingClientRect().height;
    return {
      lane: h('#audioLanes ol.track'),
      item: h('#audioLanes .track-item'),
      joints: h('#seqRuler'),
      video: h('#track'),
      videoItem: h('#track .track-item'),
    };
  });

  // An item fills its lane rather than being squeezed into part of it.
  expect(boxes.item).toBeGreaterThan(boxes.lane - 2);
  expect(boxes.videoItem).toBeGreaterThan(boxes.video - 2);
  expect(boxes.joints, 'the scrubber holding the joints').toBeGreaterThan(12);
  expect(boxes.item, 'the audio lane is squashed').toBeGreaterThan(30);
});
