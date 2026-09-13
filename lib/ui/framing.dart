// Framing: lining an item up inside the output.
//
// The crop is computed by `core/frame.dart`, the same pure function the engine
// mirrors when it renders. That is deliberate and it is the whole point of the
// original's design: what you line up on screen is what comes out, because both
// sides do the arithmetic the same way rather than each approximating the
// other.
//
// Nothing here asks the engine to re-decode. The preview already holds the
// whole frame; panning and zooming are a source rectangle moving over it, which
// is a repaint. That is what makes dragging feel immediate rather than like
// scrubbing.

import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';

import '../core/frame.dart';
import '../core/output.dart';

/// Draws a source frame as the output will see it.
class FramedPainter extends CustomPainter {
  FramedPainter({
    required this.image,
    required this.rotate,
    required this.framing,
    required this.fit,
    required this.showGuides,
  });

  /// The whole source frame, already the right way up: the engine applies the
  /// container's rotation, so only the item's own turn is left to do here.
  final ui.Image image;

  final int rotate;
  final Framing? framing;
  final Fit fit;
  final bool showGuides;

  @override
  void paint(Canvas canvas, Size size) {
    canvas.drawRect(Offset.zero & size, Paint()..color = Colors.black);

    // The source's shape after the item's own rotation, which is the space the
    // crop is expressed in.
    final turned = rotate == 90 || rotate == 270;
    final sourceWidth = turned ? image.height.toDouble() : image.width.toDouble();
    final sourceHeight = turned ? image.width.toDouble() : image.height.toDouble();

    final crop = cropFor(
      width: image.width.toDouble(),
      height: image.height.toDouble(),
      rotate: rotate,
      outWidth: size.width,
      outHeight: size.height,
      frame: framing,
    );

    // Where in the rotated source we are looking, and where it lands on screen.
    final Rect look;
    final Rect onto;
    if (crop != null) {
      // A crop already matches the output's shape, so it fills it exactly.
      look = Rect.fromLTWH(crop.left.toDouble(), crop.top.toDouble(),
          crop.width.toDouble(), crop.height.toDouble());
      onto = Offset.zero & size;
    } else {
      look = Rect.fromLTWH(0, 0, sourceWidth, sourceHeight);
      onto = switch (fit) {
        Fit.fill => Offset.zero & size,
        Fit.cover => _cover(sourceWidth, sourceHeight, size),
        Fit.contain => _contain(sourceWidth, sourceHeight, size),
      };
    }

    canvas.save();
    canvas.clipRect(Offset.zero & size);

    if (rotate != 0) {
      // Rotate about the middle of where the picture is going, then draw the
      // source rectangle into the un-rotated version of that box.
      final centre = onto.center;
      canvas.translate(centre.dx, centre.dy);
      canvas.rotate(rotate * math.pi / 180);
      canvas.translate(-centre.dx, -centre.dy);
    }

    // `look` is in rotated space; the image is not, so it has to come back.
    final source = _unrotate(look, image.width.toDouble(), image.height.toDouble(), rotate);
    final destination = rotate == 90 || rotate == 270
        ? Rect.fromCenter(
            center: onto.center, width: onto.height, height: onto.width)
        : onto;

    canvas.drawImageRect(
      image,
      source,
      destination,
      Paint()..filterQuality = FilterQuality.medium,
    );
    canvas.restore();

    if (showGuides) _guides(canvas, size);
  }

  /// Turn a rectangle in rotated display space back into image coordinates.
  static Rect _unrotate(Rect rect, double width, double height, int rotate) {
    switch (((rotate % 360) + 360) % 360) {
      case 90:
        return Rect.fromLTWH(rect.top, width - rect.right, rect.height, rect.width);
      case 180:
        return Rect.fromLTWH(
            width - rect.right, height - rect.bottom, rect.width, rect.height);
      case 270:
        return Rect.fromLTWH(height - rect.bottom, rect.left, rect.height, rect.width);
      default:
        return rect;
    }
  }

  static Rect _contain(double width, double height, Size into) {
    final scale = math.min(into.width / width, into.height / height);
    return Rect.fromCenter(
        center: into.center(Offset.zero), width: width * scale, height: height * scale);
  }

  static Rect _cover(double width, double height, Size into) {
    final scale = math.max(into.width / width, into.height / height);
    return Rect.fromCenter(
        center: into.center(Offset.zero), width: width * scale, height: height * scale);
  }

  /// Thirds, and a safe area. Drawn only while framing, because the rest of the
  /// time they are in the way of judging the picture.
  void _guides(Canvas canvas, Size size) {
    final line = Paint()
      ..color = Colors.white.withValues(alpha: 0.28)
      ..strokeWidth = 1;
    for (var i = 1; i < 3; i++) {
      final x = size.width * i / 3;
      final y = size.height * i / 3;
      canvas.drawLine(Offset(x, 0), Offset(x, size.height), line);
      canvas.drawLine(Offset(0, y), Offset(size.width, y), line);
    }
    canvas.drawRect(
      Rect.fromLTWH(size.width * 0.05, size.height * 0.05, size.width * 0.9,
          size.height * 0.9),
      Paint()
        ..color = Colors.white.withValues(alpha: 0.35)
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1,
    );
  }

  @override
  bool shouldRepaint(FramedPainter old) =>
      old.image != image ||
      old.rotate != rotate ||
      old.fit != fit ||
      old.showGuides != showGuides ||
      old.framing?.zoom != framing?.zoom ||
      old.framing?.x != framing?.x ||
      old.framing?.y != framing?.y;
}

/// The preview, with dragging and scrolling wired to the framing when it is on.
class FramedPreview extends StatelessWidget {
  const FramedPreview({
    super.key,
    required this.image,
    required this.outputAspect,
    required this.rotate,
    required this.framing,
    required this.fit,
    required this.framingMode,
    this.onFramingChanged,
  });

  final ui.Image? image;
  final double outputAspect;
  final int rotate;
  final Framing? framing;
  final Fit fit;
  final bool framingMode;
  final ValueChanged<Framing>? onFramingChanged;

  @override
  Widget build(BuildContext context) {
    final picture = image;
    if (picture == null) {
      return const ColoredBox(color: Colors.black);
    }

    return ColoredBox(
      color: Colors.black,
      child: Center(
        child: AspectRatio(
          aspectRatio: outputAspect,
          child: LayoutBuilder(
            builder: (context, constraints) {
              final size =
                  Size(constraints.maxWidth, constraints.maxHeight);

              final canvas = CustomPaint(
                painter: FramedPainter(
                  image: picture,
                  rotate: rotate,
                  framing: framing,
                  fit: fit,
                  showGuides: framingMode,
                ),
                size: size,
              );

              if (!framingMode || onFramingChanged == null) return canvas;

              return MouseRegion(
                cursor: SystemMouseCursors.move,
                child: Listener(
                  // Scroll to zoom, which is what every tool that has a zoom
                  // does, so it needs no explaining.
                  onPointerSignal: (signal) {
                    if (signal is! PointerScrollEvent) return;
                    final current = framing ?? defaultFrame;
                    final step = signal.scrollDelta.dy > 0 ? 0.9 : 1.0 / 0.9;
                    final zoom = (current.zoom * step).clamp(1.0, maxZoom);
                    onFramingChanged!(current.copyWith(zoom: zoom));
                  },
                  child: GestureDetector(
                    behavior: HitTestBehavior.opaque,
                    onPanUpdate: (details) {
                      // `pan` is the pure one from core/frame.dart, so a drag
                      // here and the crop the engine computes at render time
                      // cannot disagree.
                      onFramingChanged!(pan(
                        framing,
                        dx: details.delta.dx,
                        dy: details.delta.dy,
                        width: picture.width.toDouble(),
                        height: picture.height.toDouble(),
                        rotate: rotate,
                        outWidth: size.width,
                        outHeight: size.height,
                      ));
                    },
                    child: canvas,
                  ),
                ),
              );
            },
          ),
        ),
      ),
    );
  }
}
