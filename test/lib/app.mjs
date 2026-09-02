import { test as base, expect } from '@playwright/test';

// A loaded page plus the helpers the specs need. Mirrors QCKSCRL: the fixture
// asserts on teardown that the page logged no errors, so a spec cannot pass
// while the console is on fire.
export const test = base.extend({
  app: async ({ page }, use) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

    // Each test starts from a clean slate: no projects, no databases. Projects
    // are separate databases, so clearing one store is no longer enough.
    await page.goto('/');
    await page.evaluate(async () => {
      await window.store.close();
      localStorage.clear();
      const dbs = await indexedDB.databases();
      await Promise.all(dbs
        .filter((d) => d.name?.startsWith('qckcut'))
        .map((d) => new Promise((done) => {
          const request = indexedDB.deleteDatabase(d.name);
          request.onsuccess = request.onerror = request.onblocked = () => done();
        })));
    });
    await page.reload();
    await page.waitForFunction(() => window.S?.project);

    const app = {
      page,
      errors,

      /** Import one of the rendered test clips by name. */
      async add(...names) {
        for (const name of names) {
          await page.evaluate(async (n) => {
            const blob = await (await fetch(`/test/media/${n}.mp4`)).blob();
            await window.addSource(new File([blob], `${n}.mp4`, { type: 'video/mp4' }));
          }, name);
        }
        await app.stripReady();
      },

      /** Drop clips onto the page, exercising the real import path. */
      async drop(...names) {
        await page.evaluate(async (ns) => {
          const dt = new DataTransfer();
          for (const n of ns) {
            const blob = await (await fetch(`/test/media/${n}.mp4`)).blob();
            dt.items.add(new File([blob], `${n}.mp4`, { type: 'video/mp4' }));
          }
          document.dispatchEvent(
            new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
        }, names);
        await expect.poll(() => app.state().then((s) => s.sources.length)).toBe(names.length);
        await app.stripReady();
      },

      /** Wait for every source's filmstrip to finish decoding. */
      async stripReady() {
        await expect.poll(async () => {
          const s = await app.state();
          return s.stripsIdle && s.sources.length > 0 && s.sources.every((x) => x.ready);
        }, { timeout: 30_000 }).toBe(true);
      },

      state: () => page.evaluate(() => window.snapshot()),

      /** Geometry of the boxes that must never overlap. */
      boxes: () => page.evaluate(() => {
        const r = (id) => {
          const { top, bottom, left, right, width, height } = document.getElementById(id).getBoundingClientRect();
          return { top, bottom, left, right, width, height };
        };
        return { stage: r('stage'), timeline: r('timeline'), preview: r('preview') };
      }),

      rows: (listId) => page.locator(`#${listId} .item`),
    };

    await use(app);
    expect(errors, `page logged errors:\n${errors.join('\n')}`).toEqual([]);
  },
});

export { expect };
