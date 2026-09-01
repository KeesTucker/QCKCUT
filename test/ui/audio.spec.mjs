import { test, expect } from '../lib/app.mjs';

// Chrome is launched with --autoplay-policy=no-user-gesture-required (see
// playwright.config.mjs), so the AudioContext can actually start.

test('playback schedules the source’s audio', async ({ app }) => {
  await app.add('tone');
  const result = await app.page.evaluate(async () => {
    const ctx = window.audio.audio();
    let scheduled = 0;
    const real = ctx.createBufferSource.bind(ctx);
    ctx.createBufferSource = () => { scheduled++; return real(); };

    window.S.in = 0;
    window.S.out = 1;
    window.S.playhead = 0;
    await window.play();
    ctx.createBufferSource = real;
    return { scheduled, state: ctx.state };
  });

  expect(result.state).toBe('running');
  expect(result.scheduled).toBeGreaterThan(0);
});

test('a silent source still plays, on the wall clock', async ({ app }) => {
  await app.add('land');   // no audio track
  const result = await app.page.evaluate(async () => {
    window.S.in = 0;
    window.S.out = 1;
    window.S.playhead = 0;
    const started = performance.now();
    let error = null;
    await window.play().catch((e) => { error = String(e); });
    return { error, elapsed: (performance.now() - started) / 1000, head: window.S.playhead };
  });

  expect(result.error).toBeNull();
  expect(result.head).toBeCloseTo(1, 1);
  expect(result.elapsed).toBeGreaterThan(0.7);
});

test('video stays paced to the audio clock, not decoded flat out', async ({ app }) => {
  await app.add('tone');
  const result = await app.page.evaluate(async () => {
    window.S.in = 0;
    window.S.out = 1.5;
    window.S.playhead = 0;
    const started = performance.now();
    await window.play();
    return (performance.now() - started) / 1000;
  });
  expect(result).toBeGreaterThan(1.1);
  expect(result).toBeLessThan(3.5);
});

test('muting stops audio being scheduled', async ({ app }) => {
  await app.add('tone');
  const scheduled = await app.page.evaluate(async () => {
    window.setMuted(true);
    const ctx = window.audio.audio();
    let count = 0;
    const real = ctx.createBufferSource.bind(ctx);
    ctx.createBufferSource = () => { count++; return real(); };
    window.S.in = 0;
    window.S.out = 1;
    window.S.playhead = 0;
    await window.play();
    ctx.createBufferSource = real;
    return count;
  });
  expect(scheduled).toBe(0);
  expect((await app.state()).muted).toBe(true);
});

test('M toggles sound and the icon follows', async ({ app }) => {
  await app.add('land');
  const mute = app.page.locator('#muteBtn');
  await expect(mute).toHaveAttribute('data-state', 'on');
  await expect(mute.locator('.sound')).toBeVisible();

  await app.page.keyboard.press('m');
  await expect(mute).toHaveAttribute('data-state', 'off');
  await expect(mute.locator('.muted')).toBeVisible();
  await expect(mute.locator('.sound')).toBeHidden();
  expect((await app.state()).muted).toBe(true);

  await app.page.keyboard.press('m');
  await expect(mute).toHaveAttribute('data-state', 'on');
});

test('dragging the filmstrip plays a scrub grain', async ({ app }) => {
  await app.add('tone');
  const played = await app.page.evaluate(async () => {
    const ctx = window.audio.audio();
    let count = 0;
    const real = ctx.createBufferSource.bind(ctx);
    ctx.createBufferSource = () => { count++; return real(); };

    const timeline = document.getElementById('timeline');
    const box = timeline.getBoundingClientRect();
    const fire = (type, x, id) => timeline.dispatchEvent(new PointerEvent(type, {
      pointerId: id, bubbles: true, clientX: x, clientY: box.top + box.height / 2,
    }));
    fire('pointerdown', box.left + box.width * 0.3, 1);
    await new Promise((r) => setTimeout(r, 300));
    fire('pointerup', box.left + box.width * 0.3, 1);
    await new Promise((r) => setTimeout(r, 100));

    ctx.createBufferSource = real;
    return count;
  });
  expect(played).toBeGreaterThan(0);
});

test('scrub grains are rate limited rather than one per move', async ({ app }) => {
  await app.add('tone');
  await app.page.evaluate(() => {
    window.__grains = 0;
    const ctx = window.audio.audio();
    const real = ctx.createBufferSource.bind(ctx);
    ctx.createBufferSource = () => { window.__grains++; return real(); };
  });

  // A real drag across the filmstrip: dozens of pointermove events.
  const box = await app.page.locator('#timeline').boundingBox();
  await app.page.mouse.move(box.x + 10, box.y + box.height / 2);
  await app.page.mouse.down();
  await app.page.mouse.move(box.x + box.width - 10, box.y + box.height / 2, { steps: 60 });
  await app.page.mouse.up();

  const grains = await app.page.evaluate(() => window.__grains);
  // One grain per move would be a stutter rather than feedback.
  expect(grains).toBeGreaterThan(0);
  expect(grains).toBeLessThan(20);
});

test('audio does not leak past the end of playback', async ({ app }) => {
  await app.add('tone');
  const stopped = await app.page.evaluate(async () => {
    const ctx = window.audio.audio();
    const live = [];
    const real = ctx.createBufferSource.bind(ctx);
    ctx.createBufferSource = () => {
      const node = real();
      let stopped = false;
      const stop = node.stop.bind(node);
      node.stop = (...a) => { stopped = true; return stop(...a); };
      live.push(() => stopped);
      return node;
    };

    window.S.in = 0;
    window.S.out = 3;
    window.S.playhead = 0;
    const playing = window.play();
    await new Promise((r) => setTimeout(r, 400));
    window.pause();
    await playing;
    ctx.createBufferSource = real;
    return { total: live.length, stopped: live.filter((f) => f()).length };
  });

  // Every node scheduled for the aborted run gets stopped.
  expect(stopped.total).toBeGreaterThan(0);
  expect(stopped.stopped).toBe(stopped.total);
});
