// Transitions, kept pure so the preview and the render cannot disagree about
// what they look like.
//
// Every transition here works by darkening the picture that is already being
// drawn, so it needs one decoder and no overlap between items. That is what
// lets the same function drive both the preview and the export: they call
// `dimAt()` with the same numbers and paint the same black over the same frame.
//
// A cross dissolve is deliberately not in this set. It needs two items decoded
// at once and it overlaps them, which shortens the sequence, so it changes the
// layout as well as the painting. See NOTE at the bottom.

export const KINDS = {
  none: { label: 'None', duration: 0 },
  fade: { label: 'Fade', duration: 0.5 },
  dip: { label: 'Dip to black', duration: 0.6 },
};

export const DEFAULT_DURATION = 0.5;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * How black the frame at `time` should be, 0 (untouched) to 1 (fully black).
 *
 * `intro` and `outro` fade the very start and very end. `dips` are cuts between
 * items: each takes half its duration from the outgoing side and half from the
 * incoming one, so the sequence keeps its length.
 */
export function dimAt(time, { total = 0, intro = null, outro = null, dips = [] } = {}) {
  let dim = 0;

  if (intro?.type === 'fade' && intro.duration > 0 && time < intro.duration) {
    dim = Math.max(dim, 1 - clamp01(time / intro.duration));
  }

  if (outro?.type === 'fade' && outro.duration > 0 && total > 0) {
    const from = total - outro.duration;
    if (time > from) dim = Math.max(dim, clamp01((time - from) / outro.duration));
  }

  for (const dip of dips) {
    if (!dip || dip.duration <= 0) continue;
    const half = dip.duration / 2;
    const distance = Math.abs(time - dip.at);
    if (distance < half) dim = Math.max(dim, 1 - clamp01(distance / half));
  }

  return clamp01(dim);
}

/**
 * The boundaries a sequence has: before the first item, between each pair, and
 * after the last. Empty for an empty sequence, since there is nothing to join.
 */
export function boundaries(rows) {
  if (!rows.length) return [];
  const between = rows.slice(1).map((row) => ({
    key: `item:${row.item.id}`,
    kind: 'between',
    itemId: row.item.id,
    at: row.start,
    label: 'Transition',
  }));
  return [
    { key: 'intro', kind: 'intro', at: 0, label: 'Sequence start' },
    ...between,
    { key: 'outro', kind: 'outro', at: rows[rows.length - 1].end, label: 'Sequence end' },
  ];
}

/** Which transition kinds a given boundary can take. */
export const kindsFor = (boundary) =>
  boundary.kind === 'between' ? ['none', 'dip'] : ['none', 'fade'];

/** Gather what `dimAt` needs from the current sequence. */
export function plan(rows, transitions) {
  const total = rows.length ? rows[rows.length - 1].end : 0;
  const dips = rows.slice(1)
    .map((row) => {
      const set = row.item.transition;
      return set?.type === 'dip' && set.duration > 0
        ? { at: row.start, duration: set.duration }
        : null;
    })
    .filter(Boolean);
  return { total, intro: transitions?.intro ?? null, outro: transitions?.outro ?? null, dips };
}

// NOTE on cross dissolve: it would need the outgoing and incoming items decoded
// at the same instant, and the items would overlap by its duration, so the
// sequence would get shorter as you added them. That is a change to layout(),
// to the render loop, and to playback, rather than another entry in KINDS.
