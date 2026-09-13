// Exercises the real engine against a real file.
//
// Not a unit test and not pretending to be one: it loads the shared library,
// decodes with whatever hardware this machine has, and writes actual MP4s. That
// is the point. The pure model is covered in test/core; what can only go wrong
// at the FFI boundary and in FFmpeg has to be checked against the real thing.
//
// Skipped rather than failed when ffmpeg is not on PATH, since the fixtures are
// generated with it.

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:qckcut/engine/engine.dart';

late final Directory work;
late final String fixture;
late final MediaEngine engine;

bool get _haveFfmpeg {
  try {
    return Process.runSync('ffmpeg', ['-version']).exitCode == 0;
  } catch (_) {
    return false;
  }
}

/// Asked of ffmpeg rather than of our own engine, because `skip:` is evaluated
/// when the file is collected and `setUpAll` has not run yet. Reading it off
/// the engine there silently skipped every test that depended on it.
bool get _haveNvenc {
  try {
    final result = Process.runSync('ffmpeg', ['-hide_banner', '-encoders']);
    return (result.stdout as String).contains('nvenc');
  } catch (_) {
    return false;
  }
}

/// Probe one field out of a file, so the assertions read against ffprobe rather
/// than against our own engine reporting on itself.
String probe(String path, String entries, {String stream = 'v:0'}) {
  final result = Process.runSync('ffprobe', [
    '-hide_banner', '-loglevel', 'error',
    '-select_streams', stream,
    '-show_entries', entries,
    '-of', 'default=nw=1:nk=1',
    path,
  ]);
  return (result.stdout as String).trim();
}

void main() {
  setUpAll(() async {
    if (!_haveFfmpeg) return;
    work = Directory.systemTemp.createTempSync('qckcut_test_');
    fixture = '${work.path}/fixture.mp4';
    final made = Process.runSync('ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=5',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
      fixture,
    ]);
    expect(made.exitCode, 0, reason: made.stderr as String);
    engine = await MediaEngine.start();
  });

  tearDownAll(() {
    if (_haveFfmpeg && work.existsSync()) work.deleteSync(recursive: true);
  });

  group('capabilities', () {
    test('reports what this machine can decode', () {
      expect(engine.decodable, contains('H.264'));
    });

    // Encoding is the half that needs a GPU, so this says what is true here
    // rather than asserting a GPU exists.
    test('reports encoders consistently with CUDA', () {
      if (engine.hasCuda) {
        expect(engine.encodable, isNotEmpty);
      } else {
        expect(engine.encodable, isEmpty);
      }
    });
  }, skip: !_haveFfmpeg);

  group('sources', () {
    test('reads a file back as it was made', () async {
      final handle = await engine.open(fixture);
      final info = await engine.info(handle);
      expect(info.width, 640);
      expect(info.height, 360);
      expect(info.duration, closeTo(5, 0.1));
      expect(info.hasVideo, isTrue);
      expect(info.hasAudio, isTrue);
      expect(info.videoCodec, 'h264');
      await engine.close(handle);
    });

    test('a file that is not there fails with something worth reading', () {
      expect(
        () => engine.open('${work.path}/nothing.mp4'),
        throwsA(isA<EngineException>()),
      );
    });

    test('decodes a frame at an arbitrary instant', () async {
      final handle = await engine.open(fixture);
      final frame = await engine.frameAt(handle, 2.5, 320, 180);
      expect(frame.pixels.length, 320 * 180 * 4);
      // testsrc2 is a bright pattern, so a frame of it is not black. This is
      // the assertion that catches a pipeline that runs and produces nothing,
      // which is exactly how the first sequence render failed.
      final sum = frame.pixels.fold<int>(0, (a, b) => a + b);
      expect(sum / frame.pixels.length, greaterThan(16));
      await engine.close(handle);
    });

    test('seeking backwards lands on the right frame', () async {
      final handle = await engine.open(fixture);
      final late_ = await engine.frameAt(handle, 4.0, 64, 36);
      final early = await engine.frameAt(handle, 0.5, 64, 36);
      final again = await engine.frameAt(handle, 4.0, 64, 36);
      expect(early.pixels, isNot(equals(late_.pixels)));
      // Coming back to the same instant must give the same picture, or a scrub
      // that passes over a point twice would show two different frames.
      expect(again.pixels, equals(late_.pixels));
      await engine.close(handle);
    });

    test('decodes filmstrip tiles', () async {
      final handle = await engine.open(fixture);
      final (tiles, width) = await engine.thumbnails(handle, 6);
      expect(tiles, hasLength(6));
      expect(width, greaterThan(0));
      for (final tile in tiles) {
        expect(tile.length, width * 88 * 4);
      }
      await engine.close(handle);
    });
  }, skip: !_haveFfmpeg);

  group('rotation', () {
    // A file with a display matrix, made in two passes because -display_rotation
    // is an input option: it is applied on the way in and written on the way out.
    late String rotated;

    setUpAll(() {
      if (!_haveFfmpeg) return;
      final flat = '${work.path}/flat.mp4';
      rotated = '${work.path}/rotated.mp4';
      Process.runSync('ffmpeg', [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=2',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', flat,
      ]);
      Process.runSync('ffmpeg', [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-display_rotation', '90', '-i', flat, '-c', 'copy', rotated,
      ]);
    });

    test('reports the display shape, not the coded one', () async {
      final handle = await engine.open(rotated);
      final info = await engine.info(handle);
      // Coded 640x360, but a player shows it portrait, and that is what the
      // rest of the app lays out against.
      expect(info.width, 360);
      expect(info.height, 640);
      expect(info.rotation, isNot(0));
      await engine.close(handle);
    });

    // The contract is that `info` reports the display shape, so the pixels have
    // to come back the same way up or anything shot on a phone previews on its
    // side while the numbers claim otherwise. Checked against ffmpeg's own
    // autorotation rather than against our own reasoning about sign conventions.
    test('decodes the picture the same way up as ffmpeg does', () async {
      final handle = await engine.open(rotated);
      final frame = await engine.frameAt(handle, 1.0, 320, 180);
      await engine.close(handle);

      final mine = '${work.path}/mine.rgba';
      File(mine).writeAsBytesSync(frame.pixels);

      final reference = '${work.path}/reference.rgba';
      final made = Process.runSync('ffmpeg', [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-ss', '1', '-i', rotated, '-frames:v', '1',
        '-vf', 'scale=320:180:force_original_aspect_ratio=decrease,'
            'pad=320:180:(ow-iw)/2:(oh-ih)/2,format=rgba',
        '-f', 'rawvideo', reference,
      ]);
      expect(made.exitCode, 0, reason: made.stderr as String);

      final theirs = File(reference).readAsBytesSync();
      expect(theirs, hasLength(frame.pixels.length));

      // Mean absolute difference. Scalers differ, so this is never zero; a
      // quarter or half turn out of place puts it an order of magnitude higher.
      var total = 0;
      for (var i = 0; i < theirs.length; i++) {
        total += (frame.pixels[i] - theirs[i]).abs();
      }
      final difference = total / theirs.length;
      expect(difference, lessThan(12),
          reason: 'the picture does not match ffmpeg, difference $difference');
    });
  }, skip: !_haveFfmpeg);

  group('clip export', () {
    test('a plain trim keeps the source codec and the audio', () async {
      final out = '${work.path}/clip.mp4';
      await engine.exportClip(
          inputPath: fixture, outputPath: out, start: 1.0, end: 3.0);
      expect(File(out).lengthSync(), greaterThan(0));
      expect(probe(out, 'stream=codec_name'), 'h264');
      expect(probe(out, 'stream=codec_name', stream: 'a:0'), 'aac');
    });

    test('asking for a different codec re-encodes and cuts exactly', () async {
      final out = '${work.path}/clip_hevc.mp4';
      final ticks = <double>[];
      await engine.exportClip(
        inputPath: fixture,
        outputPath: out,
        start: 1.0,
        end: 3.0,
        settings: const OutputSettings(codec: 1), // HEVC
        onProgress: ticks.add,
      );
      expect(probe(out, 'stream=codec_name'), 'hevc');
      // The transcode path cuts where asked, unlike the remux path which has to
      // start at a keyframe.
      expect(double.parse(probe(out, 'format=duration', stream: 'v')),
          closeTo(2.0, 0.15));
      expect(ticks, isNotEmpty);
    }, skip: !_haveNvenc);
  }, skip: !_haveFfmpeg);

  group('sequence export', () {
    test('lays items end to end and keeps the total length', () async {
      final out = '${work.path}/seq.mp4';
      await engine.exportSequence(
        items: [
          SequenceItem(path: fixture, inPoint: 0.5, outPoint: 1.5),
          SequenceItem(path: fixture, inPoint: 2.0, outPoint: 3.0, rotate: 90),
          SequenceItem(path: fixture, inPoint: 3.0, outPoint: 4.0, zoom: 1.5),
        ],
        outputPath: out,
        settings: const OutputSettings(width: 640, height: 360, fps: 30),
      );
      expect(double.parse(probe(out, 'format=duration', stream: 'v')),
          closeTo(3.0, 0.1));
      expect(probe(out, 'stream=width'), '640');
      expect(probe(out, 'stream=height'), '360');
      expect(probe(out, 'stream=codec_name', stream: 'a:0'), 'aac');
    });

    test('an empty sequence is refused rather than producing an empty file', () {
      expect(
        () => engine.exportSequence(items: const [], outputPath: '${work.path}/x.mp4'),
        throwsA(isA<StateError>()),
      );
    });
  }, skip: !_haveFfmpeg);

  group('playback', () {
    // Muted deliberately. The clock, the ring buffer and the latency correction
    // all behave identically on silence, and a test suite that beeps at whoever
    // runs it is a test suite people stop running.
    test('the audio clock advances and does not run past the sequence', () async {
      if (!engine.canPlay) return;  // no audio device, e.g. in CI

      await engine.play([
        SequenceItem(path: fixture, inPoint: 0, outPoint: 2, muted: true),
      ], 0);

      final samples = <double>[];
      for (var i = 0; i < 12; i++) {
        await Future<void>.delayed(const Duration(milliseconds: 100));
        samples.add(engine.position);
      }
      await engine.stopPlayback();

      // It must move.
      expect(samples.last, greaterThan(0.3),
          reason: 'the clock never advanced: $samples');
      // It must never go backwards, or the picture would jump back with it.
      for (var i = 1; i < samples.length; i++) {
        expect(samples[i], greaterThanOrEqualTo(samples[i - 1] - 1e-6));
      }
      // And it must not outrun what was queued.
      expect(samples.last, lessThan(2.5));
    });

    test('starting from an offset starts the clock there', () async {
      if (!engine.canPlay) return;

      await engine.play([
        SequenceItem(path: fixture, inPoint: 0, outPoint: 4, muted: true),
      ], 1.5);
      await Future<void>.delayed(const Duration(milliseconds: 120));
      final at = engine.position;
      await engine.stopPlayback();

      expect(at, greaterThanOrEqualTo(1.5));
      expect(at, lessThan(2.2));
    });
  }, skip: !_haveFfmpeg);
}
