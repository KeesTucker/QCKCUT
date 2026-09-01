// The sequence model, kept pure and DOM-free so it can be reasoned about and
// tested on its own.
//
// A timeline item is the same reference shape as a clip: { sourceId, in, out }.
// Its position is its index, not a stored start time. That is deliberate: there
// are no gaps to manage, no overlaps to resolve, and rippling after a trim or a
// delete is automatic rather than a pass over every later item.

export const itemDuration = (item) => Math.max(0, item.out - item.in);

export const totalDuration = (items) =>
  items.reduce((sum, item) => sum + itemDuration(item), 0);

/**
 * Place every item on the sequence clock.
 * Returns rows of `{ item, index, start, duration, end }`.
 */
export function layout(items) {
  let start = 0;
  return items.map((item, index) => {
    const duration = itemDuration(item);
    const row = { item, index, start, duration, end: start + duration };
    start = row.end;
    return row;
  });
}

/** The row covering a sequence time, or null past the end. */
export function at(rows, time) {
  return rows.find((row) => time >= row.start && time < row.end) ?? null;
}

/** Where a sequence time falls inside its item's source. */
export const sourceTime = (row, time) => row.item.in + (time - row.start);

/** Insert an item, clamping the index into range. Returns a new array. */
export function insert(items, item, index) {
  const next = items.slice();
  next.splice(clampIndex(index, next.length), 0, item);
  return next;
}

/**
 * Move the item at `from` so it lands before what is currently at `to`.
 * `to` is an index into the array *before* the move, which is what a drop
 * position naturally gives you.
 */
export function move(items, from, to) {
  if (from < 0 || from >= items.length) return items;
  const next = items.slice();
  const [moved] = next.splice(from, 1);
  next.splice(clampIndex(from < to ? to - 1 : to, next.length), 0, moved);
  return next;
}

export const remove = (items, id) => items.filter((item) => item.id !== id);

/**
 * Which insertion slot a pointer sits in, given each rendered item's horizontal
 * bounds in the same coordinate space. Returns 0..bounds.length.
 */
export function slotAt(bounds, x) {
  for (let i = 0; i < bounds.length; i++) {
    if (x < (bounds[i].left + bounds[i].right) / 2) return i;
  }
  return bounds.length;
}

const clampIndex = (i, max) => (i < 0 ? 0 : i > max ? max : i);
