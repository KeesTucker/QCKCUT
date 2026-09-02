// How a source frame is placed inside the output frame.
//
// Pure, and shared by the preview and the render, because the whole point of
// framing is that what you line up on screen is what comes out. mediabunny's
// `drawWithFit` crops *after* rotation and before resizing, so every number
// here is in the rotated display space.

/** Rotation swaps the picture's width and height. */
export const rotated = (width, height, rotate = 0) =>
  (rotate === 90 || rotate === 270 ? { width: height, height: width } : { width, height });

export const turn = (rotate = 0, by = 90) => (((rotate + by) % 360) + 360) % 360;

/** The default framing: dead centre, no zoom. */
export const DEFAULT_FRAME = { zoom: 1, x: 0.5, y: 0.5 };

export const MAX_ZOOM = 6;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * The rectangle of the source to show, given the output's shape.
 *
 * The crop always matches the output's aspect ratio, so framing has only two
 * degrees of freedom: how tight (`zoom`) and where (`x`, `y`, the centre in
 * fractions of the source). That is what reframing 16:9 into 9:16 actually
 * needs, and it means there is no way to produce a squashed picture.
 *
 * Returns null when the source already matches the output and nothing is
 * cropped, so callers can skip the work entirely.
 */
export function cropFor({ width, height, rotate = 0, outWidth, outHeight, frame }) {
  if (!width || !height || !outWidth || !outHeight) return null;
  const source = rotated(width, height, rotate);
  const { zoom = 1, x = 0.5, y = 0.5 } = frame ?? DEFAULT_FRAME;

  // The largest rectangle of the output's shape that fits inside the source,
  // then tightened by the zoom.
  const aspect = outWidth / outHeight;
  const widest = Math.min(source.width, source.height * aspect);
  const cropWidth = widest / clamp(zoom, 1, MAX_ZOOM);
  const cropHeight = cropWidth / aspect;

  const untouched = zoom <= 1
    && Math.abs(cropWidth - source.width) < 0.5
    && Math.abs(cropHeight - source.height) < 0.5;
  if (untouched) return null;

  // Kept inside the picture: you can move the frame around, never off the edge.
  const left = clamp(x * source.width - cropWidth / 2, 0, Math.max(0, source.width - cropWidth));
  const top = clamp(y * source.height - cropHeight / 2, 0, Math.max(0, source.height - cropHeight));

  return {
    left: Math.round(left),
    top: Math.round(top),
    width: Math.round(Math.min(cropWidth, source.width)),
    height: Math.round(Math.min(cropHeight, source.height)),
  };
}

/**
 * Move the framing by a drag across the preview. `dx`/`dy` are in output
 * pixels; the result is a new centre in source fractions.
 */
export function pan(frame, { dx, dy, width, height, rotate = 0, outWidth, outHeight }) {
  const current = { ...DEFAULT_FRAME, ...frame };
  const crop = cropFor({ width, height, rotate, outWidth, outHeight, frame: current });
  if (!crop) return current;

  const source = rotated(width, height, rotate);
  // Dragging right should move the picture right, which means looking further
  // left, hence the negation.
  return {
    ...current,
    x: clamp(current.x - (dx / outWidth) * (crop.width / source.width), 0, 1),
    y: clamp(current.y - (dy / outHeight) * (crop.height / source.height), 0, 1),
  };
}

/** True when an item is left exactly as shot. */
export const isDefault = (frame, rotate = 0) =>
  !rotate && (!frame || (frame.zoom === 1 && frame.x === 0.5 && frame.y === 0.5));
