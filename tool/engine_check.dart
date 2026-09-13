// Exercises the Dart side of the engine without starting the UI, so the FFI
// boundary can be checked on its own. Run it as:
//
//   dart run tool/engine_check.dart <file>

import 'dart:io';

import 'package:qckcut/engine/engine.dart';

Future<void> main(List<String> args) async {
  if (args.isEmpty) {
    stderr.writeln('usage: dart run tool/engine_check.dart <file>');
    exit(2);
  }

  final engine = await MediaEngine.start();
  print('CUDA:   ${engine.hasCuda ? engine.gpuName : "no"}');
  print('decode: ${engine.decodable.join(", ")}');
  print('encode: ${engine.encodable.isEmpty ? "(none)" : engine.encodable.join(", ")}');

  final handle = await engine.open(args.first);
  final info = await engine.info(handle);
  print('');
  print('${args.first}');
  print('  ${info.duration.toStringAsFixed(3)}s  ${info.width}x${info.height}  '
      '${info.videoCodec}  ${info.hardwareDecoded ? "NVDEC" : "software"}');
  if (info.hasAudio) {
    print('  audio ${info.audioCodec} ${info.sampleRate}Hz ${info.channels}ch');
  }

  final frame = await engine.frameAt(handle, info.duration / 2, 320, 180);
  print('  frame at midpoint: ${frame.pixels.length} bytes RGBA');

  final (tiles, tileWidth) = await engine.thumbnails(handle, 6);
  print('  ${tiles.length} tiles at ${tileWidth}x88');

  final out = '${Directory.systemTemp.path}/qk_dart_export.mp4';
  final seen = <double>[];
  try {
    await engine.exportClip(
      inputPath: args.first,
      outputPath: out,
      start: 0.5,
      end: 2.5,
      onProgress: seen.add,
    );
    final size = File(out).lengthSync();
    print('  export: $out (${(size / 1024).toStringAsFixed(0)} KB), '
        '${seen.length} progress ticks');
  } catch (error) {
    print('  export failed: $error');
  }

  await engine.close(handle);
  exit(0);
}
