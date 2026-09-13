// How a source frame is placed inside the output frame.
//
// Pure, and shared by the preview and the render, because the whole point of
// framing is that what you line up on screen is what comes out. The crop is
// applied after rotation and before resizing, so every number here is in the
// rotated display space.

import 'dart:math' as math;

import 'package:meta/meta.dart';

/// The rectangle of a source to show.
@immutable
class Crop {
  const Crop({required this.left, required this.top, required this.width, required this.height});

  final int left;
  final int top;
  final int width;
  final int height;
}

/// How tight (`zoom`) and where (`x`, `y`, the centre in fractions of the
/// source). Two degrees of freedom is what reframing 16:9 into 9:16 needs, and
/// it means there is no way to produce a squashed picture.
@immutable
class Framing {
  const Framing({this.zoom = 1, this.x = 0.5, this.y = 0.5});

  final double zoom;
  final double x;
  final double y;

  Framing copyWith({double? zoom, double? x, double? y}) =>
      Framing(zoom: zoom ?? this.zoom, x: x ?? this.x, y: y ?? this.y);
}

/// The default framing: dead centre, no zoom.
const Framing defaultFrame = Framing();

const double maxZoom = 6;

@immutable
class Size2 {
  const Size2(this.width, this.height);
  final double width;
  final double height;
}

/// Rotation swaps the picture's width and height.
Size2 rotated(double width, double height, [int rotate = 0]) =>
    (rotate == 90 || rotate == 270) ? Size2(height, width) : Size2(width, height);

int turn(int rotate, [int by = 90]) => (((rotate + by) % 360) + 360) % 360;

double _clamp(double v, double lo, double hi) => v < lo ? lo : (v > hi ? hi : v);

/// The rectangle of the source to show, given the output's shape.
///
/// The crop always matches the output's aspect ratio. Returns null when the
/// source already matches the output and nothing is cropped, so callers can
/// skip the work entirely.
Crop? cropFor({
  required double width,
  required double height,
  int rotate = 0,
  required double outWidth,
  required double outHeight,
  Framing? frame,
}) {
  if (width == 0 || height == 0 || outWidth == 0 || outHeight == 0) return null;
  final source = rotated(width, height, rotate);
  final f = frame ?? defaultFrame;

  // The largest rectangle of the output's shape that fits inside the source,
  // then tightened by the zoom.
  final aspect = outWidth / outHeight;
  final widest = math.min(source.width, source.height * aspect);
  final cropWidth = widest / _clamp(f.zoom, 1, maxZoom);
  final cropHeight = cropWidth / aspect;

  final untouched = f.zoom <= 1 &&
      (cropWidth - source.width).abs() < 0.5 &&
      (cropHeight - source.height).abs() < 0.5;
  if (untouched) return null;

  // Kept inside the picture: you can move the frame around, never off the edge.
  //
  // Rounded before being clamped, not after. Rounding each of left and width on
  // its own can put their sum a pixel past the source edge, which is a crop
  // rectangle no decoder will accept; doing the clamp in whole pixels means the
  // result is inside the picture by construction.
  final width_ = math.min(cropWidth, source.width).round();
  final height_ = math.min(cropHeight, source.height).round();
  final left = _clamp(f.x * source.width - cropWidth / 2, 0,
          math.max(0, source.width - width_))
      .round();
  final top = _clamp(f.y * source.height - cropHeight / 2, 0,
          math.max(0, source.height - height_))
      .round();

  return Crop(
    left: math.min(left, math.max(0, source.width.round() - width_)),
    top: math.min(top, math.max(0, source.height.round() - height_)),
    width: width_,
    height: height_,
  );
}

/// Move the framing by a drag across the preview. [dx]/[dy] are in output
/// pixels; the result is a new centre in source fractions.
Framing pan(
  Framing? frame, {
  required double dx,
  required double dy,
  required double width,
  required double height,
  int rotate = 0,
  required double outWidth,
  required double outHeight,
}) {
  final current = frame ?? defaultFrame;
  final crop = cropFor(
      width: width,
      height: height,
      rotate: rotate,
      outWidth: outWidth,
      outHeight: outHeight,
      frame: current);
  if (crop == null) return current;

  final source = rotated(width, height, rotate);
  // Dragging right should move the picture right, which means looking further
  // left, hence the negation.
  return current.copyWith(
    x: _clamp(current.x - (dx / outWidth) * (crop.width / source.width), 0, 1),
    y: _clamp(current.y - (dy / outHeight) * (crop.height / source.height), 0, 1),
  );
}

/// True when an item is left exactly as shot.
bool isDefault(Framing? frame, [int rotate = 0]) =>
    rotate == 0 && (frame == null || (frame.zoom == 1 && frame.x == 0.5 && frame.y == 0.5));
