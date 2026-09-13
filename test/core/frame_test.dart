import 'package:flutter_test/flutter_test.dart';
import 'package:qckcut/core/frame.dart';

void main() {
  group('rotated', () {
    test('swaps width and height on a quarter turn', () {
      expect(rotated(1920, 1080, 90).width, 1080);
      expect(rotated(1920, 1080, 270).height, 1920);
    });

    test('leaves half turns alone', () {
      expect(rotated(1920, 1080, 180).width, 1920);
    });

    test('turn wraps in both directions', () {
      expect(turn(270), 0);
      expect(turn(0, -90), 270);
    });
  });

  group('cropFor', () {
    // Nothing cropped means there is nothing to do, and the caller can skip the
    // work entirely.
    test('is null when the source already matches the output', () {
      expect(
        cropFor(width: 1920, height: 1080, outWidth: 1920, outHeight: 1080),
        isNull,
      );
    });

    test('crops 16:9 into 9:16 at the aspect of the output', () {
      final crop = cropFor(
          width: 1920, height: 1080, outWidth: 1080, outHeight: 1920)!;
      expect(crop.width / crop.height, closeTo(1080 / 1920, 0.01));
      expect(crop.height, 1080);
    });

    test('zoom tightens the crop', () {
      final wide = cropFor(
          width: 1920, height: 1080, outWidth: 1080, outHeight: 1920)!;
      final tight = cropFor(
          width: 1920,
          height: 1080,
          outWidth: 1080,
          outHeight: 1920,
          frame: const Framing(zoom: 2))!;
      expect(tight.width, lessThan(wide.width));
    });

    test('is clamped inside the picture however far you push it', () {
      final crop = cropFor(
          width: 1920,
          height: 1080,
          outWidth: 1080,
          outHeight: 1920,
          frame: const Framing(zoom: 1, x: 5, y: 5))!;
      expect(crop.left + crop.width, lessThanOrEqualTo(1920));
      expect(crop.top + crop.height, lessThanOrEqualTo(1080));
      expect(crop.left, greaterThanOrEqualTo(0));
    });

    test('works in rotated space', () {
      final crop = cropFor(
          width: 1920, height: 1080, rotate: 90, outWidth: 1080, outHeight: 1920);
      // Rotated, the source is already 1080x1920, so nothing is cropped.
      expect(crop, isNull);
    });
  });

  group('pan', () {
    test('dragging right looks further left', () {
      final moved = pan(const Framing(),
          dx: 100, dy: 0, width: 1920, height: 1080, outWidth: 1080, outHeight: 1920);
      expect(moved.x, lessThan(0.5));
    });

    test('cannot be dragged off the edge', () {
      final moved = pan(const Framing(),
          dx: 99999, dy: 0, width: 1920, height: 1080, outWidth: 1080, outHeight: 1920);
      expect(moved.x, 0);
    });

    test('is a no-op when there is nothing cropped', () {
      final moved = pan(const Framing(),
          dx: 100, dy: 0, width: 1920, height: 1080, outWidth: 1920, outHeight: 1080);
      expect(moved.x, 0.5);
    });
  });

  test('isDefault is true only for a frame left exactly as shot', () {
    expect(isDefault(null), isTrue);
    expect(isDefault(const Framing()), isTrue);
    expect(isDefault(const Framing(), 90), isFalse);
    expect(isDefault(const Framing(zoom: 2)), isFalse);
  });
}
