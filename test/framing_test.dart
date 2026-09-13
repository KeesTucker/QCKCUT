// Framing, end to end.
//
// The claim the whole design rests on is that what you line up on screen is
// what comes out, because the preview and the engine compute the crop from the
// same arithmetic rather than each approximating the other. That is only worth
// anything if it is checked, so this renders real footage through the real
// engine and looks at which pixels came back.
//
// The fixture is four flat colour quadrants, which makes the question "did the
// crop land where it was asked to" answerable by averaging.

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:qckcut/core/frame.dart';
import 'package:qckcut/engine/engine.dart';

bool get _haveFfmpeg {
  try {
    return Process.runSync('ffmpeg', ['-version']).exitCode == 0;
  } catch (_) {
    return false;
  }
}

late Directory work;
late String quadrants;
late MediaEngine engine;

/// The average red, green and blue of a decoded frame.
Future<({double r, double g, double b})> averageColour(String path) async {
  final handle = await engine.open(path);
  final frame = await engine.frameAt(handle, 0.5, 160, 90);
  await engine.close(handle);

  var r = 0.0, g = 0.0, b = 0.0;
  final pixels = frame.pixels;
  final count = pixels.length ~/ 4;
  for (var i = 0; i < pixels.length; i += 4) {
    r += pixels[i];
    g += pixels[i + 1];
    b += pixels[i + 2];
  }
  return (r: r / count, g: g / count, b: b / count);
}

void main() {
  setUpAll(() async {
    if (!_haveFfmpeg) return;
    work = Directory.systemTemp.createTempSync('qckcut_framing_');
    quadrants = '${work.path}/quadrants.mp4';

    // 640x360, split into four 320x180 quadrants:
    //   red   green
    //   blue  white
    final made = Process.runSync('ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=red:size=320x180:d=2:r=30',
      '-f', 'lavfi', '-i', 'color=green:size=320x180:d=2:r=30',
      '-f', 'lavfi', '-i', 'color=blue:size=320x180:d=2:r=30',
      '-f', 'lavfi', '-i', 'color=white:size=320x180:d=2:r=30',
      '-filter_complex', '[0][1]hstack[top];[2][3]hstack[bottom];[top][bottom]vstack',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', quadrants,
    ]);
    expect(made.exitCode, 0, reason: made.stderr as String);
    engine = await MediaEngine.start();
  });

  tearDownAll(() {
    if (_haveFfmpeg && work.existsSync()) work.deleteSync(recursive: true);
  });

  // At zoom 2 on a 16:9 source into a 16:9 output the crop is exactly a
  // quarter of the picture, so each corner is nameable. `cropFor` says so, and
  // then the engine is asked whether it agrees.
  test('cropFor picks out exactly one quadrant at zoom 2', () {
    final crop = cropFor(
      width: 640,
      height: 360,
      outWidth: 320,
      outHeight: 180,
      frame: const Framing(zoom: 2, x: 0.25, y: 0.25),
    )!;
    expect(crop.left, 0);
    expect(crop.top, 0);
    expect(crop.width, 320);
    expect(crop.height, 180);
  });

  test('the engine crops where cropFor says it will', () async {
    Future<({double r, double g, double b})> render(
        String name, double x, double y) async {
      final out = '${work.path}/$name.mp4';
      await engine.exportSequence(
        items: [
          SequenceItem(
              path: quadrants,
              inPoint: 0,
              outPoint: 1,
              zoom: 2,
              frameX: x,
              frameY: y),
        ],
        outputPath: out,
        settings: const OutputSettings(width: 320, height: 180, fps: 30),
      );
      return averageColour(out);
    }

    final topLeft = await render('topleft', 0.25, 0.25);
    expect(topLeft.r, greaterThan(120), reason: 'top left should be red: $topLeft');
    expect(topLeft.g, lessThan(90));
    expect(topLeft.b, lessThan(90));

    final topRight = await render('topright', 0.75, 0.25);
    expect(topRight.g, greaterThan(90), reason: 'top right should be green: $topRight');
    expect(topRight.r, lessThan(90));

    final bottomLeft = await render('bottomleft', 0.25, 0.75);
    expect(bottomLeft.b, greaterThan(120),
        reason: 'bottom left should be blue: $bottomLeft');
    expect(bottomLeft.r, lessThan(90));

    final bottomRight = await render('bottomright', 0.75, 0.75);
    expect(bottomRight.r, greaterThan(180),
        reason: 'bottom right should be white: $bottomRight');
    expect(bottomRight.g, greaterThan(180));
    expect(bottomRight.b, greaterThan(180));
  }, timeout: const Timeout(Duration(minutes: 2)));

  // Without framing, a 16:9 source in a 9:16 output is letterboxed, so most of
  // the frame is black. With framing it is filled. That difference is the
  // entire point of the feature.
  test('framing fills a vertical output that letterboxing would not', () async {
    Future<double> brightness(String name, double? zoom) async {
      final out = '${work.path}/$name.mp4';
      await engine.exportSequence(
        items: [
          SequenceItem(
              path: quadrants, inPoint: 0, outPoint: 1, zoom: zoom, frameX: 0.25, frameY: 0.25),
        ],
        outputPath: out,
        settings: const OutputSettings(width: 180, height: 320, fps: 30),
      );
      final colour = await averageColour(out);
      return (colour.r + colour.g + colour.b) / 3;
    }

    final letterboxed = await brightness('vertical_plain', null);
    final framed = await brightness('vertical_framed', 1.0);

    // Framed, the crop is 9:16 out of the source and fills the output. Plain,
    // the picture is a thin band with black above and below it.
    expect(framed, greaterThan(letterboxed * 1.5),
        reason: 'framed $framed should be much brighter than letterboxed $letterboxed');
  }, timeout: const Timeout(Duration(minutes: 2)));
}
