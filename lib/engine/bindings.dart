// Raw FFI bindings to libqckcut_engine.
//
// Hand written rather than generated. The surface is small and stable, and a
// generated file would bury the one thing worth reading here: which calls block
// and therefore must not happen on the UI isolate.
//
// Every buffer handed across is allocated by Dart and owned by Dart. Nothing
// native is retained past the call except the opaque handles, which are freed
// through their own close functions.

import 'dart:ffi';

import 'package:ffi/ffi.dart';

// ─── Opaque handles ──────────────────────────────────────────────────────────

final class QkEngine extends Opaque {}

final class QkSource extends Opaque {}

final class QkPlayer extends Opaque {}

// ─── Structs ─────────────────────────────────────────────────────────────────

final class QkSourceInfo extends Struct {
  @Double()
  external double duration;
  @Int32()
  external int width;
  @Int32()
  external int height;
  @Int32()
  external int rotation;
  @Int32()
  external int hasVideo;
  @Int32()
  external int hasAudio;
  @Int32()
  external int sampleRate;
  @Int32()
  external int channels;
  @Int32()
  external int hwDecoded;
  external Pointer<Utf8> videoCodec;
  external Pointer<Utf8> audioCodec;
}

/// One item on the sequence clock. Its position is its index in the array, not
/// a stored start time, which is the same choice `core/sequence.dart` makes and
/// for the same reason: there are no gaps to manage and no overlaps to resolve.
final class QkSequenceItem extends Struct {
  external Pointer<Utf8> path;
  @Double()
  external double inPoint;
  @Double()
  external double outPoint;
  @Int32()
  external int rotate;
  @Int32()
  external int hasFrame;
  @Double()
  external double zoom;
  @Double()
  external double frameX;
  @Double()
  external double frameY;
  @Double()
  external double gain;
  @Int32()
  external int muted;
  @Double()
  external double dipDuration;
}

final class QkOutputSettings extends Struct {
  @Int32()
  external int width;
  @Int32()
  external int height;
  @Double()
  external double fps;
  @Int32()
  external int codec;
  @Int64()
  external int bitrate;
  @Int32()
  external int fit;
}

// ─── Status and codec enums ──────────────────────────────────────────────────

abstract final class QkStatus {
  static const ok = 0;
  static const errOpen = -1;
  static const errNoTrack = -2;
  static const errDecode = -3;
  static const errSeek = -4;
  static const errEncode = -5;
  static const errCancelled = -6;
  static const errArg = -7;
}

abstract final class QkCodec {
  static const h264 = 0;
  static const hevc = 1;
  static const av1 = 2;
  static const vp9 = 3;
  static const vp8 = 4;
  static const mpeg4 = 5;
  static const count = 6;
}

const int qkThumbHeight = 88;

typedef QkProgressCallback = Void Function(Double, Int32, Pointer<Void>);

/// The generated-style lookup table. One instance per process; see `engine.dart`.
class QkBindings {
  QkBindings(DynamicLibrary library) : _lib = library;

  final DynamicLibrary _lib;

  late final lastError =
      _lib.lookupFunction<Pointer<Utf8> Function(), Pointer<Utf8> Function()>('qk_last_error');

  late final version =
      _lib.lookupFunction<Pointer<Utf8> Function(), Pointer<Utf8> Function()>('qk_version');

  late final engineCreate = _lib.lookupFunction<Pointer<QkEngine> Function(),
      Pointer<QkEngine> Function()>('qk_engine_create');

  late final engineDestroy = _lib.lookupFunction<Void Function(Pointer<QkEngine>),
      void Function(Pointer<QkEngine>)>('qk_engine_destroy');

  late final engineHasCuda = _lib.lookupFunction<Int32 Function(Pointer<QkEngine>),
      int Function(Pointer<QkEngine>)>('qk_engine_has_cuda');

  late final engineGpuName = _lib.lookupFunction<Pointer<Utf8> Function(Pointer<QkEngine>),
      Pointer<Utf8> Function(Pointer<QkEngine>)>('qk_engine_gpu_name');

  late final canDecode = _lib.lookupFunction<Int32 Function(Pointer<QkEngine>, Int32),
      int Function(Pointer<QkEngine>, int)>('qk_can_decode');

  late final canEncode = _lib.lookupFunction<Int32 Function(Pointer<QkEngine>, Int32),
      int Function(Pointer<QkEngine>, int)>('qk_can_encode');

  late final codecLabel = _lib.lookupFunction<Pointer<Utf8> Function(Int32),
      Pointer<Utf8> Function(int)>('qk_codec_label');

  late final sourceOpen = _lib.lookupFunction<
      Pointer<QkSource> Function(Pointer<QkEngine>, Pointer<Utf8>),
      Pointer<QkSource> Function(Pointer<QkEngine>, Pointer<Utf8>)>('qk_source_open');

  late final sourceClose = _lib.lookupFunction<Void Function(Pointer<QkSource>),
      void Function(Pointer<QkSource>)>('qk_source_close');

  late final sourceInfo = _lib.lookupFunction<
      Int32 Function(Pointer<QkSource>, Pointer<QkSourceInfo>),
      int Function(Pointer<QkSource>, Pointer<QkSourceInfo>)>('qk_source_info');

  late final sourceFrameAt = _lib.lookupFunction<
      Int32 Function(Pointer<QkSource>, Double, Pointer<Uint8>, Int32, Int32),
      int Function(Pointer<QkSource>, double, Pointer<Uint8>, int, int)>('qk_source_frame_at');

  late final sourceNextFrame = _lib.lookupFunction<
      Int32 Function(Pointer<QkSource>, Pointer<Uint8>, Int32, Int32, Pointer<Double>),
      int Function(Pointer<QkSource>, Pointer<Uint8>, int, int,
          Pointer<Double>)>('qk_source_next_frame');

  late final sourceSeek = _lib.lookupFunction<Int32 Function(Pointer<QkSource>, Double),
      int Function(Pointer<QkSource>, double)>('qk_source_seek');

  late final sourceThumbnails = _lib.lookupFunction<
      Int32 Function(Pointer<QkSource>, Int32, Pointer<Uint8>, Int32),
      int Function(Pointer<QkSource>, int, Pointer<Uint8>, int)>('qk_source_thumbnails');

  late final thumbWidth = _lib.lookupFunction<Int32 Function(Pointer<QkSource>),
      int Function(Pointer<QkSource>)>('qk_thumb_width');

  late final sourceAudio = _lib.lookupFunction<
      Int64 Function(Pointer<QkSource>, Double, Double, Pointer<Float>, Int64),
      int Function(Pointer<QkSource>, double, double, Pointer<Float>, int)>('qk_source_audio');

  late final sourcePeaks = _lib.lookupFunction<
      Int32 Function(Pointer<QkSource>, Pointer<Float>, Int32),
      int Function(Pointer<QkSource>, Pointer<Float>, int)>('qk_source_peaks');

  late final exportClip = _lib.lookupFunction<
      Int32 Function(Pointer<QkEngine>, Pointer<Utf8>, Pointer<Utf8>, Double, Double,
          Pointer<QkOutputSettings>, Pointer<NativeFunction<QkProgressCallback>>, Pointer<Void>),
      int Function(Pointer<QkEngine>, Pointer<Utf8>, Pointer<Utf8>, double, double,
          Pointer<QkOutputSettings>, Pointer<NativeFunction<QkProgressCallback>>,
          Pointer<Void>)>('qk_export_clip');

  late final exportSequence = _lib.lookupFunction<
      Int32 Function(Pointer<QkEngine>, Pointer<QkSequenceItem>, Int32, Pointer<Utf8>,
          Pointer<QkOutputSettings>, Double, Double,
          Pointer<NativeFunction<QkProgressCallback>>, Pointer<Void>),
      int Function(Pointer<QkEngine>, Pointer<QkSequenceItem>, int, Pointer<Utf8>,
          Pointer<QkOutputSettings>, double, double,
          Pointer<NativeFunction<QkProgressCallback>>,
          Pointer<Void>)>('qk_export_sequence');

  // ─── Playback ──────────────────────────────────────────────────────────────

  late final playerCreate = _lib.lookupFunction<Pointer<QkPlayer> Function(),
      Pointer<QkPlayer> Function()>('qk_player_create');

  late final playerDestroy = _lib.lookupFunction<Void Function(Pointer<QkPlayer>),
      void Function(Pointer<QkPlayer>)>('qk_player_destroy');

  late final playerWrite = _lib.lookupFunction<
      Int32 Function(Pointer<QkPlayer>, Pointer<Float>, Int32),
      int Function(Pointer<QkPlayer>, Pointer<Float>, int)>('qk_player_write');

  late final playerClock = _lib.lookupFunction<Double Function(Pointer<QkPlayer>),
      double Function(Pointer<QkPlayer>)>('qk_player_clock');

  late final playerQueued = _lib.lookupFunction<Int32 Function(Pointer<QkPlayer>),
      int Function(Pointer<QkPlayer>)>('qk_player_queued');

  late final playerFlush = _lib.lookupFunction<Void Function(Pointer<QkPlayer>, Double),
      void Function(Pointer<QkPlayer>, double)>('qk_player_flush');

  late final playerPause = _lib.lookupFunction<Void Function(Pointer<QkPlayer>, Int32),
      void Function(Pointer<QkPlayer>, int)>('qk_player_pause');

  late final cancel = _lib.lookupFunction<Void Function(Pointer<QkEngine>),
      void Function(Pointer<QkEngine>)>('qk_cancel');

  late final uncancel = _lib.lookupFunction<Void Function(Pointer<QkEngine>),
      void Function(Pointer<QkEngine>)>('qk_uncancel');
}
