// The Dart side of the media engine.
//
// Two rules shape this file. First, every native call blocks the thread it runs
// on, and decoding a frame is milliseconds while an export is minutes, so none
// of it may happen on the UI isolate. Second, a QkSource is a warm decoder: it
// must live on one isolate and stay there, because tearing it down and
// reopening per scrub would be far slower than the seek it is avoiding.
//
// So there is one long-lived worker isolate that owns every open source, and the
// UI talks to it by message. Exports run there too and report progress back the
// same way.

import 'dart:async';
import 'dart:ffi';
import 'dart:io';
import 'dart:isolate';
import 'dart:typed_data';

import 'package:ffi/ffi.dart';
import 'package:path/path.dart' as p;

import 'bindings.dart';

/// Everything a freshly opened file turned out to be.
class SourceInfo {
  const SourceInfo({
    required this.duration,
    required this.width,
    required this.height,
    required this.rotation,
    required this.hasVideo,
    required this.hasAudio,
    required this.sampleRate,
    required this.channels,
    required this.hardwareDecoded,
    required this.videoCodec,
    required this.audioCodec,
  });

  final double duration;
  final int width;
  final int height;
  final int rotation;
  final bool hasVideo;
  final bool hasAudio;
  final int sampleRate;
  final int channels;

  /// Whether NVDEC actually carried the frames, not merely whether it was asked
  /// for. FFmpeg falls back to software silently, so this is the only claim
  /// worth putting in front of a user.
  final bool hardwareDecoded;

  final String? videoCodec;
  final String? audioCodec;
}

/// A decoded picture: RGBA at the size that was asked for.
class DecodedFrame {
  const DecodedFrame(
      this.pixels, this.width, this.height, this.timestamp, this.hardwareDecoded);

  final Uint8List pixels;
  final int width;
  final int height;
  final double timestamp;

  /// Whether NVDEC carried this frame. Reported here rather than on
  /// [SourceInfo] because the answer is not known at open time: FFmpeg falls
  /// back to software silently, so the only proof is a frame arriving on a CUDA
  /// surface, which has not happened yet when a file is first opened.
  final bool hardwareDecoded;
}

/// What the export should produce. Nulls mean "match the source", which is the
/// default and what most exports want.
class OutputSettings {
  const OutputSettings({
    this.width,
    this.height,
    this.fps,
    this.codec = QkCodec.h264,
    this.bitrate,
    this.fit = 0,
  });

  final int? width;
  final int? height;
  final double? fps;
  final int codec;
  final int? bitrate;
  final int fit;
}

/// One item of a sequence, as the engine needs it: the source's path rather
/// than a handle, because the render opens its own decoders and must not
/// disturb the warm ones the preview is using.
class SequenceItem {
  const SequenceItem({
    required this.path,
    required this.inPoint,
    required this.outPoint,
    this.rotate = 0,
    this.zoom,
    this.frameX = 0.5,
    this.frameY = 0.5,
    this.gain = 1.0,
    this.muted = false,
    this.dipDuration = 0,
  });

  final String path;
  final double inPoint;
  final double outPoint;
  final int rotate;

  /// Null means the item is left exactly as shot, and the project's own fit is
  /// used instead of a crop.
  final double? zoom;
  final double frameX;
  final double frameY;

  final double gain;
  final bool muted;

  /// The dip to black at this item's start. Half is taken from each side, so
  /// the sequence keeps its length.
  final double dipDuration;

  Map<String, Object?> toMap() => {
        'path': path,
        'inPoint': inPoint,
        'outPoint': outPoint,
        'rotate': rotate,
        'hasFrame': zoom != null ? 1 : 0,
        'zoom': zoom ?? 1.0,
        'frameX': frameX,
        'frameY': frameY,
        'gain': gain,
        'muted': muted ? 1 : 0,
        'dipDuration': dipDuration,
      };
}

/// Which half of a render is running. Audio is mixed before any picture is
/// touched, and on a long sequence that is many seconds with nothing to show
/// for it, so it is reported rather than left to look like a hang.
enum RenderPhase { audio, video }

/// Thrown when a render is stopped on purpose, so callers can tell it apart
/// from a failure.
class Cancelled implements Exception {
  const Cancelled();
  @override
  String toString() => 'export cancelled';
}

class EngineException implements Exception {
  const EngineException(this.message, this.status);
  final String message;
  final int status;
  @override
  String toString() => message;
}

/// Where the shared library sits, in a built bundle and when running from source.
String _libraryPath() {
  const name = 'libqckcut_engine.so';
  final beside = File(p.join(p.dirname(Platform.resolvedExecutable), 'lib', name));
  if (beside.existsSync()) return beside.path;
  // `flutter run` leaves it in the CMake output rather than the bundle.
  for (final mode in ['debug', 'release', 'profile']) {
    final built = File(p.join(Directory.current.path, 'build', 'linux', 'x64', mode,
        'bundle', 'lib', name));
    if (built.existsSync()) return built.path;
  }
  final standalone = File(p.join(Directory.current.path, 'build', 'engine', name));
  if (standalone.existsSync()) return standalone.path;
  return name; // let the loader search, and report honestly if it cannot
}

// ─── The worker protocol ─────────────────────────────────────────────────────

class _Request {
  _Request(this.id, this.op, this.args);
  final int id;
  final String op;
  final Map<String, Object?> args;
}

class _Response {
  _Response(this.id, {this.value, this.error, this.status = 0, this.progress});
  final int id;
  final Object? value;
  final String? error;
  final int status;
  final double? progress;
}

/// The engine, as the UI sees it.
class MediaEngine {
  MediaEngine._(this._commands, this._responses, this.hasCuda, this.gpuName,
      this.decodable, this.encodable);

  final SendPort _commands;
  final Stream<_Response> _responses;

  final bool hasCuda;
  final String gpuName;

  /// What this machine can decode and encode, asked of the driver rather than
  /// answered from a table: NVDEC's codec set moves with the GPU generation.
  final List<String> decodable;
  final List<String> encodable;

  static MediaEngine? _instance;
  static MediaEngine get instance {
    final engine = _instance;
    if (engine == null) throw StateError('the engine has not been started');
    return engine;
  }

  int _nextId = 1;
  final _pending = <int, Completer<Object?>>{};
  final _progress = <int, void Function(double)>{};

  static Future<MediaEngine> start() async {
    if (_instance != null) return _instance!;

    final ready = ReceivePort();
    await Isolate.spawn(_workerMain, ready.sendPort, debugName: 'qckcut-engine');

    final stream = ready.asBroadcastStream();
    final first = await stream.first as Map<String, Object?>;
    final commands = first['port']! as SendPort;

    final responses = stream
        .where((message) => message is _Response)
        .cast<_Response>();

    final engine = MediaEngine._(
      commands,
      responses,
      first['cuda']! as bool,
      first['gpu']! as String,
      (first['decodable']! as List).cast<String>(),
      (first['encodable']! as List).cast<String>(),
    );
    engine._listen();
    _instance = engine;
    return engine;
  }

  void _listen() {
    _responses.listen((response) {
      if (response.progress != null) {
        _progress[response.id]?.call(response.progress!);
        return;
      }
      final completer = _pending.remove(response.id);
      _progress.remove(response.id);
      if (completer == null) return;
      if (response.error != null) {
        completer.completeError(response.status == QkStatus.errCancelled
            ? const Cancelled()
            : EngineException(response.error!, response.status));
      } else {
        completer.complete(response.value);
      }
    });
  }

  Future<Object?> _send(String op, Map<String, Object?> args,
      {void Function(double)? onProgress}) {
    final id = _nextId++;
    final completer = Completer<Object?>();
    _pending[id] = completer;
    if (onProgress != null) _progress[id] = onProgress;
    _commands.send(_Request(id, op, args));
    return completer.future;
  }

  /// Open a file and keep its decoder warm. Returns a handle to close later.
  Future<int> open(String path) async => await _send('open', {'path': path}) as int;

  Future<void> close(int handle) => _send('close', {'handle': handle});

  Future<SourceInfo> info(int handle) async {
    final map = await _send('info', {'handle': handle}) as Map<String, Object?>;
    return SourceInfo(
      duration: map['duration']! as double,
      width: map['width']! as int,
      height: map['height']! as int,
      rotation: map['rotation']! as int,
      hasVideo: map['hasVideo']! as bool,
      hasAudio: map['hasAudio']! as bool,
      sampleRate: map['sampleRate']! as int,
      channels: map['channels']! as int,
      hardwareDecoded: map['hardwareDecoded']! as bool,
      videoCodec: map['videoCodec'] as String?,
      audioCodec: map['audioCodec'] as String?,
    );
  }

  /// The frame covering [timestamp], letterboxed into [width] x [height].
  Future<DecodedFrame> frameAt(int handle, double timestamp, int width, int height) async {
    final map = await _send('frameAt', {
      'handle': handle,
      'timestamp': timestamp,
      'width': width,
      'height': height,
    }) as Map<String, Object?>;
    return DecodedFrame(map['pixels']! as Uint8List, width, height, timestamp,
        map['hardwareDecoded']! as bool);
  }

  /// Filmstrip tiles: keyframes only, never a delta frame decoded to fill one.
  Future<(List<Uint8List>, int)> thumbnails(int handle, int count) async {
    final map = await _send('thumbnails', {'handle': handle, 'count': count})
        as Map<String, Object?>;
    return ((map['tiles']! as List).cast<Uint8List>(), map['tileWidth']! as int);
  }

  Future<void> exportClip({
    required String inputPath,
    required String outputPath,
    required double start,
    required double end,
    OutputSettings settings = const OutputSettings(),
    void Function(double)? onProgress,
  }) =>
      _send('export', {
        'in': inputPath,
        'out': outputPath,
        'start': start,
        'end': end,
        'width': settings.width ?? 0,
        'height': settings.height ?? 0,
        'fps': settings.fps ?? 0.0,
        'codec': settings.codec,
        'bitrate': settings.bitrate ?? 0,
        'fit': settings.fit,
      }, onProgress: onProgress);

  /// Render a laid-out sequence to one file.
  Future<void> exportSequence({
    required List<SequenceItem> items,
    required String outputPath,
    OutputSettings settings = const OutputSettings(),
    double introFade = 0,
    double outroFade = 0,
    void Function(double)? onProgress,
  }) {
    if (items.isEmpty) throw StateError('the sequence is empty');
    return _send('exportSequence', {
      'items': [for (final item in items) item.toMap()],
      'out': outputPath,
      'width': settings.width ?? 0,
      'height': settings.height ?? 0,
      'fps': settings.fps ?? 0.0,
      'codec': settings.codec,
      'bitrate': settings.bitrate ?? 0,
      'fit': settings.fit,
      'intro': introFade,
      'outro': outroFade,
    }, onProgress: onProgress);
  }

  /// Ask a running export to stop. It ends with a [Cancelled].
  void cancel() => _commands.send(_Request(0, 'cancel', const {}));
}

// ─── The worker ──────────────────────────────────────────────────────────────

void _workerMain(SendPort ready) {
  final bindings = QkBindings(DynamicLibrary.open(_libraryPath()));
  final engine = bindings.engineCreate();

  String label(int codec) => bindings.codecLabel(codec).toDartString();

  final decodable = <String>[];
  final encodable = <String>[];
  for (var c = 0; c < QkCodec.count; c++) {
    if (bindings.canDecode(engine, c) != 0) decodable.add(label(c));
    if (bindings.canEncode(engine, c) != 0) encodable.add(label(c));
  }

  final commands = ReceivePort();
  ready.send({
    'port': commands.sendPort,
    'cuda': bindings.engineHasCuda(engine) != 0,
    'gpu': bindings.engineGpuName(engine).toDartString(),
    'decodable': decodable,
    'encodable': encodable,
  });

  final sources = <int, Pointer<QkSource>>{};
  var nextHandle = 1;

  String lastError() => bindings.lastError().toDartString();

  commands.listen((message) {
    final request = message as _Request;

    // Cancel has to be handled without queueing behind the export it is meant
    // to stop, which it is: the native side reads an atomic flag, so this is
    // safe to call while a decode is in flight.
    if (request.op == 'cancel') {
      bindings.cancel(engine);
      return;
    }

    void reply(Object? value) => ready.send(_Response(request.id, value: value));
    void fail(String error, [int status = QkStatus.errArg]) =>
        ready.send(_Response(request.id, error: error, status: status));

    try {
      switch (request.op) {
        case 'open':
          final path = (request.args['path']! as String).toNativeUtf8();
          try {
            final source = bindings.sourceOpen(engine, path);
            if (source == nullptr) {
              fail(lastError(), QkStatus.errOpen);
              return;
            }
            final handle = nextHandle++;
            sources[handle] = source;
            reply(handle);
          } finally {
            calloc.free(path);
          }

        case 'close':
          final source = sources.remove(request.args['handle']! as int);
          if (source != null) bindings.sourceClose(source);
          reply(null);

        case 'info':
          final source = sources[request.args['handle']! as int];
          if (source == null) return fail('that source is not open');
          final out = calloc<QkSourceInfo>();
          try {
            final status = bindings.sourceInfo(source, out);
            if (status != QkStatus.ok) return fail(lastError(), status);
            final info = out.ref;
            reply({
              'duration': info.duration,
              'width': info.width,
              'height': info.height,
              'rotation': info.rotation,
              'hasVideo': info.hasVideo != 0,
              'hasAudio': info.hasAudio != 0,
              'sampleRate': info.sampleRate,
              'channels': info.channels,
              'hardwareDecoded': info.hwDecoded != 0,
              'videoCodec':
                  info.videoCodec == nullptr ? null : info.videoCodec.toDartString(),
              'audioCodec':
                  info.audioCodec == nullptr ? null : info.audioCodec.toDartString(),
            });
          } finally {
            calloc.free(out);
          }

        case 'frameAt':
          final source = sources[request.args['handle']! as int];
          if (source == null) return fail('that source is not open');
          final width = request.args['width']! as int;
          final height = request.args['height']! as int;
          final buffer = calloc<Uint8>(width * height * 4);
          try {
            final status = bindings.sourceFrameAt(
                source, request.args['timestamp']! as double, buffer, width, height);
            if (status != QkStatus.ok) return fail(lastError(), status);
            // Asked after the decode, not before: that is the only point at
            // which the hardware question has a true answer.
            final probe = calloc<QkSourceInfo>();
            var hardware = false;
            try {
              if (bindings.sourceInfo(source, probe) == QkStatus.ok) {
                hardware = probe.ref.hwDecoded != 0;
              }
            } finally {
              calloc.free(probe);
            }
            // Copied out of native memory before the buffer is freed; the list
            // then travels to the UI isolate by value.
            reply({
              'pixels': Uint8List.fromList(buffer.asTypedList(width * height * 4)),
              'hardwareDecoded': hardware,
            });
          } finally {
            calloc.free(buffer);
          }

        case 'thumbnails':
          final source = sources[request.args['handle']! as int];
          if (source == null) return fail('that source is not open');
          final count = request.args['count']! as int;
          final tileWidth = bindings.thumbWidth(source);
          if (tileWidth <= 0) return fail('that source has no pictures');
          final tileBytes = tileWidth * qkThumbHeight * 4;
          final buffer = calloc<Uint8>(count * tileBytes);
          try {
            final status = bindings.sourceThumbnails(source, count, buffer, tileWidth);
            if (status != QkStatus.ok) return fail(lastError(), status);
            final tiles = <Uint8List>[
              for (var i = 0; i < count; i++)
                Uint8List.fromList(
                    buffer.asTypedList(count * tileBytes).sublist(i * tileBytes, (i + 1) * tileBytes)),
            ];
            reply({'tiles': tiles, 'tileWidth': tileWidth});
          } finally {
            calloc.free(buffer);
          }

        case 'export':
          // Deliberately not awaited: the worker must stay responsive so cancel
          // and further decodes are still served while this runs.
          unawaited(_runExport(bindings, engine, ready, request, lastError));

        case 'exportSequence':
          unawaited(_runSequence(bindings, engine, ready, request, lastError));

        default:
          fail('unknown request ${request.op}');
      }
    } catch (error) {
      fail('$error');
    }
  });
}

/// Progress has to cross a thread boundary, and the export call blocks whoever
/// makes it, so it cannot be the isolate that also has to report.
///
/// The arrangement: the export runs on its own short-lived isolate, and the
/// native callback writes the latest fraction into a slot in native memory that
/// was handed to it as the `user` pointer. The worker isolate, which is not
/// blocked, polls that slot on a timer and forwards it. The callback therefore
/// only ever runs on the same thread that called into native, which is the one
/// case `Pointer.fromFunction` actually supports.
void _onNativeProgress(double fraction, int phase, Pointer<Void> user) {
  if (user == nullptr) return;
  final slot = user.cast<Double>();
  slot[0] = fraction;
  slot[1] = phase.toDouble();
}

/// Runs on the export isolate. Everything crosses as an address, because a
/// pointer is only meaningful inside this one process and that is where it stays.
int _exportOnIsolate(Map<String, Object?> job) {
  final bindings = QkBindings(DynamicLibrary.open(job['lib']! as String));
  final callback = Pointer.fromFunction<QkProgressCallback>(_onNativeProgress);
  return bindings.exportClip(
    Pointer<QkEngine>.fromAddress(job['engine']! as int),
    Pointer<Utf8>.fromAddress(job['in']! as int),
    Pointer<Utf8>.fromAddress(job['out']! as int),
    job['start']! as double,
    job['end']! as double,
    Pointer<QkOutputSettings>.fromAddress(job['settings']! as int),
    callback,
    Pointer<Void>.fromAddress(job['slot']! as int),
  );
}

Future<void> _runExport(QkBindings bindings, Pointer<QkEngine> engine, SendPort ready,
    _Request request, String Function() lastError) async {
  final inPath = (request.args['in']! as String).toNativeUtf8();
  final outPath = (request.args['out']! as String).toNativeUtf8();
  final settings = calloc<QkOutputSettings>();
  // Two doubles: the fraction, and the phase. Audio is mixed before any picture
  // is touched and on a long sequence that is many seconds with nothing to show,
  // so which phase is running is worth reporting rather than leaving it to look
  // like a hang.
  final slot = calloc<Double>(2);

  settings.ref
    ..width = request.args['width']! as int
    ..height = request.args['height']! as int
    ..fps = request.args['fps']! as double
    ..codec = request.args['codec']! as int
    ..bitrate = request.args['bitrate']! as int
    ..fit = request.args['fit']! as int;

  bindings.uncancel(engine);

  final ticker = Timer.periodic(const Duration(milliseconds: 100), (_) {
    ready.send(_Response(request.id, progress: slot[0]));
  });

  try {
    final status = await Isolate.run(() => _exportOnIsolate({
          'lib': _libraryPath(),
          'engine': engine.address,
          'in': inPath.address,
          'out': outPath.address,
          'start': request.args['start']! as double,
          'end': request.args['end']! as double,
          'settings': settings.address,
          'slot': slot.address,
        }));

    ticker.cancel();
    if (status != QkStatus.ok) {
      // The message belongs to the thread that failed, so it is read on the
      // export isolate's behalf here only because the call has already returned.
      ready.send(_Response(request.id, error: lastError(), status: status));
      return;
    }
    ready.send(_Response(request.id, progress: 1.0));
    ready.send(_Response(request.id, value: null));
  } catch (error) {
    ticker.cancel();
    ready.send(_Response(request.id, error: '$error', status: QkStatus.errEncode));
  } finally {
    ticker.cancel();
    calloc.free(inPath);
    calloc.free(outPath);
    calloc.free(settings);
    calloc.free(slot);
  }
}

/// Runs on the export isolate, same arrangement as the single clip: the call
/// blocks whoever makes it, so it is not the isolate that also has to report.
int _sequenceOnIsolate(Map<String, Object?> job) {
  final bindings = QkBindings(DynamicLibrary.open(job['lib']! as String));
  final callback = Pointer.fromFunction<QkProgressCallback>(_onNativeProgress);
  return bindings.exportSequence(
    Pointer<QkEngine>.fromAddress(job['engine']! as int),
    Pointer<QkSequenceItem>.fromAddress(job['items']! as int),
    job['count']! as int,
    Pointer<Utf8>.fromAddress(job['out']! as int),
    Pointer<QkOutputSettings>.fromAddress(job['settings']! as int),
    job['intro']! as double,
    job['outro']! as double,
    callback,
    Pointer<Void>.fromAddress(job['slot']! as int),
  );
}

Future<void> _runSequence(QkBindings bindings, Pointer<QkEngine> engine, SendPort ready,
    _Request request, String Function() lastError) async {
  final maps = (request.args['items']! as List).cast<Map<String, Object?>>();
  final outPath = (request.args['out']! as String).toNativeUtf8();
  final settings = calloc<QkOutputSettings>();
  final slot = calloc<Double>(2);
  final items = calloc<QkSequenceItem>(maps.length);

  // Every path has to outlive the call, so they are allocated up front and
  // freed together rather than one per item inside the loop.
  final paths = <Pointer<Utf8>>[];

  settings.ref
    ..width = request.args['width']! as int
    ..height = request.args['height']! as int
    ..fps = request.args['fps']! as double
    ..codec = request.args['codec']! as int
    ..bitrate = request.args['bitrate']! as int
    ..fit = request.args['fit']! as int;

  for (var i = 0; i < maps.length; i++) {
    final map = maps[i];
    final path = (map['path']! as String).toNativeUtf8();
    paths.add(path);
    items[i]
      ..path = path
      ..inPoint = map['inPoint']! as double
      ..outPoint = map['outPoint']! as double
      ..rotate = map['rotate']! as int
      ..hasFrame = map['hasFrame']! as int
      ..zoom = map['zoom']! as double
      ..frameX = map['frameX']! as double
      ..frameY = map['frameY']! as double
      ..gain = map['gain']! as double
      ..muted = map['muted']! as int
      ..dipDuration = map['dipDuration']! as double;
  }

  bindings.uncancel(engine);

  final ticker = Timer.periodic(const Duration(milliseconds: 100), (_) {
    ready.send(_Response(request.id, progress: slot[0]));
  });

  try {
    final status = await Isolate.run(() => _sequenceOnIsolate({
          'lib': _libraryPath(),
          'engine': engine.address,
          'items': items.address,
          'count': maps.length,
          'out': outPath.address,
          'settings': settings.address,
          'intro': request.args['intro']! as double,
          'outro': request.args['outro']! as double,
          'slot': slot.address,
        }));

    ticker.cancel();
    if (status != QkStatus.ok) {
      ready.send(_Response(request.id, error: lastError(), status: status));
      return;
    }
    ready.send(_Response(request.id, progress: 1.0));
    ready.send(_Response(request.id, value: null));
  } catch (error) {
    ticker.cancel();
    ready.send(_Response(request.id, error: '$error', status: QkStatus.errEncode));
  } finally {
    ticker.cancel();
    for (final path in paths) {
      calloc.free(path);
    }
    calloc.free(items);
    calloc.free(outPath);
    calloc.free(settings);
    calloc.free(slot);
  }
}
