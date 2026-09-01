import { test, expect } from '../lib/app.mjs';

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

test('playback runs the whole sequence, paced to the clock', async ({ app }) => {
  await build(app, { clip: 'land', in: 0, out: 1 }, { clip: 'land', in: 3, out: 4 });

  const result = await app.page.evaluate(async () => {
    const started = performance.now();
    await window.playSequence();
    return { elapsed: (performance.now() - started) / 1000, head: window.S.seqPlayhead };
  });

  expect(result.head).toBeCloseTo(2, 1);
  // Real time, not decoded as fast as possible.
  expect(result.elapsed).toBeGreaterThan(1.5);
  expect(result.elapsed).toBeLessThan(4);
});

test('playback crosses a cut between two different sources', async ({ app }) => {
  await build(app, { clip: 'land', in: 0, out: 1 }, { clip: 'port', in: 0, out: 1 });

  const seen = await app.page.evaluate(async () => {
    // Record which source each painted frame came from, by canvas dimensions.
    const sizes = new Set();
    const preview = document.getElementById('preview');
    const timer = setInterval(() => sizes.add(`${preview.width}x${preview.height}`), 30);
    await window.playSequence();
    clearInterval(timer);
    return { sizes: [...sizes], head: window.S.seqPlayhead };
  });

  expect(seen.head).toBeCloseTo(2, 1);
  // The preview holds the sequence's own size across the cut rather than
  // resizing per item; items shaped differently are letterboxed.
  expect(seen.sizes).toEqual(['640x360']);
});

// Pre-roll opens the next item's source while the current one is still playing.
//
// Note on what this does NOT prove: on these fixtures (tens of kB, 2-second
// GOP) opening a source cold costs about 6ms, and the worst seam measured the
// same with pre-roll disabled. The timing benefit is a bet on real footage,
// where parsing a large moov and hunting a keyframe is far more expensive. So
// this asserts the mechanism rather than a duration, which is the part that can
// actually be observed here.
test('the next source is opened before the cut reaches it', async ({ app }) => {
  await build(app, { clip: 'land', in: 0, out: 1.5 }, { clip: 'hd', in: 5, out: 6 });

  const result = await app.page.evaluate(async () => {
    const rows = window.sequence.layout(window.S.timeline);
    const nextSourceId = rows[1].item.sourceId;
    const seam = rows[1].start;

    // Cold pool, so being open can only be pre-roll's doing.
    window.media.closeAll();

    let openedAt = null;
    const timer = setInterval(() => {
      if (openedAt === null && window.media.isOpen(nextSourceId)) {
        openedAt = window.S.seqPlayhead;
      }
    }, 5);
    await window.playSequence();
    clearInterval(timer);
    return { openedAt, seam };
  });

  expect(result.openedAt, 'next source was never opened').not.toBeNull();
  // Must be open early, not merely before the seam: without pre-roll it opens
  // *at* the cut, where the playhead is still a hair under seam, which would
  // satisfy a naive "< seam" assertion.
  expect(result.openedAt, `opened at ${result.openedAt}s, seam at ${result.seam}s`)
    .toBeLessThan(result.seam / 2);
});

test('stopping halts playback partway', async ({ app }) => {
  await build(app, { clip: 'land', in: 0, out: 3 });

  const result = await app.page.evaluate(async () => {
    const playing = window.playSequence();
    await new Promise((r) => setTimeout(r, 500));
    window.stopSequence();
    await playing;
    return { head: window.S.seqPlayhead, playing: window.S.playingSeq };
  });

  expect(result.playing).toBe(false);
  expect(result.head).toBeGreaterThan(0);
  expect(result.head).toBeLessThan(2.5);
});

test('playback resumes from where it stopped', async ({ app }) => {
  await build(app, { clip: 'land', in: 0, out: 3 });
  await app.page.evaluate(async () => {
    const playing = window.playSequence();
    await new Promise((r) => setTimeout(r, 400));
    window.stopSequence();
    await playing;
  });
  const paused = (await app.state()).seqPlayhead;

  await app.page.evaluate(async () => {
    const playing = window.playSequence();
    await new Promise((r) => setTimeout(r, 300));
    window.stopSequence();
    await playing;
  });

  expect((await app.state()).seqPlayhead).toBeGreaterThan(paused);
});

test('the decoder pool stays bounded across a multi-source sequence', async ({ app }) => {
  await build(app,
    { clip: 'land', in: 0, out: 0.6 },
    { clip: 'port', in: 0, out: 0.6 },
    { clip: 'hd', in: 0, out: 0.6 },
    { clip: 'land', in: 2, out: 2.6 });

  const max = await app.page.evaluate(() => window.media.MAX_OPEN);
  const peak = await app.page.evaluate(async () => {
    let peak = 0;
    const timer = setInterval(() => { peak = Math.max(peak, window.media.openCount()); }, 10);
    await window.playSequence();
    clearInterval(timer);
    return peak;
  });

  expect(peak, `peaked at ${peak}, pool is ${max}`).toBeLessThanOrEqual(max);
});
