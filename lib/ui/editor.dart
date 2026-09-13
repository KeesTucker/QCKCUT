// The editor: one source, scrubbed, with a range marked on it and exported.
//
// This is the vertical slice of the original's single-clip path. The sequence
// model is already ported in `core/`, so what is missing here is the timeline
// UI on top, not the thinking underneath it.

import 'dart:async';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';

import '../engine/bindings.dart' show QkCodec, qkThumbHeight;
import '../engine/engine.dart';

class EditorPage extends StatefulWidget {
  const EditorPage({super.key, required this.engine});

  final MediaEngine engine;

  @override
  State<EditorPage> createState() => _EditorPageState();
}

class _EditorPageState extends State<EditorPage> {
  int? _handle;
  String? _path;
  SourceInfo? _info;

  ui.Image? _preview;
  double _playhead = 0;
  double _inPoint = 0;
  double _outPoint = 0;

  List<ui.Image> _tiles = const [];
  String? _error;
  bool _busy = false;

  double? _exportProgress;

  /// Scrubbing fires far faster than a decode completes, so a request in flight
  /// means the next one waits and only the newest is served. Without this the
  /// decoder ends up a second behind the pointer and never catches up.
  bool _decoding = false;
  double? _queued;

  static const int _previewWidth = 960;
  static const int _previewHeight = 540;

  @override
  void dispose() {
    final handle = _handle;
    if (handle != null) widget.engine.close(handle);
    _preview?.dispose();
    for (final tile in _tiles) {
      tile.dispose();
    }
    super.dispose();
  }

  /// RGBA straight from the decoder into a texture, with no encode/decode
  /// round trip through PNG in between.
  Future<ui.Image> _decodeRgba(Uint8List pixels, int width, int height) {
    final completer = Completer<ui.Image>();
    ui.decodeImageFromPixels(
        pixels, width, height, ui.PixelFormat.rgba8888, completer.complete);
    return completer.future;
  }

  Future<void> _open() async {
    const group = XTypeGroup(
      label: 'video',
      extensions: ['mp4', 'mov', 'mkv', 'webm', 'm4v', 'avi', 'mp3', 'wav', 'flac', 'm4a'],
    );
    final file = await openFile(acceptedTypeGroups: const [group]);
    if (file == null) return;

    setState(() {
      _busy = true;
      _error = null;
    });

    try {
      final previous = _handle;
      if (previous != null) await widget.engine.close(previous);

      final handle = await widget.engine.open(file.path);
      final info = await widget.engine.info(handle);

      setState(() {
        _handle = handle;
        _path = file.path;
        _info = info;
        _playhead = 0;
        _inPoint = 0;
        _outPoint = info.duration;
        _tiles = const [];
      });

      if (info.hasVideo) {
        await _showFrame(0);
        unawaited(_loadThumbnails(handle));
      }
    } catch (error) {
      setState(() => _error = '$error');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _loadThumbnails(int handle) async {
    try {
      final (tiles, tileWidth) = await widget.engine.thumbnails(handle, 12);
      final images = <ui.Image>[];
      for (final tile in tiles) {
        images.add(await _decodeRgba(tile, tileWidth, qkThumbHeight));
      }
      if (!mounted) return;
      setState(() => _tiles = images);
    } catch (_) {
      // A filmstrip that will not decode is not worth interrupting the edit for.
    }
  }

  /// Show the frame at [at], collapsing requests that arrive while one is out.
  Future<void> _showFrame(double at) async {
    final handle = _handle;
    if (handle == null) return;
    if (_decoding) {
      _queued = at;
      return;
    }
    _decoding = true;
    try {
      final frame = await widget.engine
          .frameAt(handle, at, _previewWidth, _previewHeight);
      final image = await _decodeRgba(frame.pixels, frame.width, frame.height);
      if (!mounted) {
        image.dispose();
        return;
      }
      setState(() {
        _preview?.dispose();
        _preview = image;
      });
    } catch (error) {
      if (mounted) setState(() => _error = '$error');
    } finally {
      _decoding = false;
      final next = _queued;
      _queued = null;
      if (next != null) unawaited(_showFrame(next));
    }
  }

  Future<void> _export() async {
    final path = _path;
    if (path == null || _outPoint <= _inPoint) return;

    final target = await getSaveLocation(
      suggestedName: 'cut.mp4',
      acceptedTypeGroups: const [XTypeGroup(label: 'mp4', extensions: ['mp4'])],
    );
    if (target == null) return;

    setState(() {
      _exportProgress = 0;
      _error = null;
    });

    try {
      await widget.engine.exportClip(
        inputPath: path,
        outputPath: target.path,
        start: _inPoint,
        end: _outPoint,
        settings: const OutputSettings(codec: QkCodec.h264),
        onProgress: (fraction) {
          if (mounted) setState(() => _exportProgress = fraction);
        },
      );
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Wrote ${target.path}')),
      );
    } on Cancelled {
      if (mounted) setState(() => _error = 'Export cancelled');
    } catch (error) {
      if (mounted) setState(() => _error = '$error');
    } finally {
      if (mounted) setState(() => _exportProgress = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    final info = _info;
    final theme = Theme.of(context);

    return Scaffold(
      body: Column(
        children: [
          _Toolbar(
            engine: widget.engine,
            busy: _busy,
            onOpen: _open,
            onExport: info != null && _outPoint > _inPoint && _exportProgress == null
                ? _export
                : null,
            onCancel: _exportProgress != null ? widget.engine.cancel : null,
            progress: _exportProgress,
          ),
          if (_error != null)
            Container(
              width: double.infinity,
              color: theme.colorScheme.errorContainer,
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
              child: Text(_error!,
                  style: TextStyle(color: theme.colorScheme.onErrorContainer)),
            ),
          Expanded(
            child: Container(
              color: Colors.black,
              alignment: Alignment.center,
              child: _preview != null
                  ? FittedBox(
                      fit: BoxFit.contain,
                      child: SizedBox(
                        width: _preview!.width.toDouble(),
                        height: _preview!.height.toDouble(),
                        child: RawImage(image: _preview, filterQuality: FilterQuality.medium),
                      ),
                    )
                  : Text(
                      info == null ? 'Open a file to start' : 'No pictures in this file',
                      style: theme.textTheme.titleMedium
                          ?.copyWith(color: Colors.white38),
                    ),
            ),
          ),
          if (info != null) _Filmstrip(tiles: _tiles),
          if (info != null)
            _Scrubber(
              info: info,
              playhead: _playhead,
              inPoint: _inPoint,
              outPoint: _outPoint,
              onScrub: (at) {
                setState(() => _playhead = at);
                unawaited(_showFrame(at));
              },
              onMarkIn: () => setState(() {
                _inPoint = _playhead;
                if (_outPoint <= _inPoint) _outPoint = info.duration;
              }),
              onMarkOut: () => setState(() {
                _outPoint = _playhead;
                if (_inPoint >= _outPoint) _inPoint = 0;
              }),
            ),
          if (info != null) _StatusBar(info: info, path: _path),
        ],
      ),
    );
  }
}

// ─── Pieces ──────────────────────────────────────────────────────────────────

class _Toolbar extends StatelessWidget {
  const _Toolbar({
    required this.engine,
    required this.busy,
    required this.onOpen,
    this.onExport,
    this.onCancel,
    this.progress,
  });

  final MediaEngine engine;
  final bool busy;
  final VoidCallback onOpen;
  final VoidCallback? onExport;
  final VoidCallback? onCancel;
  final double? progress;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Material(
      color: const Color(0xFF1B1D22),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
        child: Row(
          children: [
            Text('QCKCUT', style: theme.textTheme.titleMedium),
            const SizedBox(width: 16),
            FilledButton.tonalIcon(
              onPressed: busy ? null : onOpen,
              icon: const Icon(Icons.folder_open, size: 18),
              label: const Text('Open'),
            ),
            const SizedBox(width: 8),
            FilledButton.icon(
              onPressed: onExport,
              icon: const Icon(Icons.file_download, size: 18),
              label: const Text('Export range'),
            ),
            if (progress != null) ...[
              const SizedBox(width: 16),
              SizedBox(
                width: 160,
                child: LinearProgressIndicator(value: progress),
              ),
              const SizedBox(width: 8),
              Text('${(progress! * 100).toStringAsFixed(0)}%'),
              const SizedBox(width: 8),
              TextButton(onPressed: onCancel, child: const Text('Cancel')),
            ],
            const Spacer(),
            // Said plainly, because whether this is the GPU or the CPU is the
            // difference between an export taking a minute and an hour.
            _Chip(
              label: engine.hasCuda ? 'CUDA ready' : 'CPU only',
              good: engine.hasCuda,
            ),
            const SizedBox(width: 8),
            Tooltip(
              message: 'Encode: ${engine.encodable.isEmpty ? "software only" : engine.encodable.join(", ")}\n'
                  'Decode: ${engine.decodable.join(", ")}',
              child: const Icon(Icons.info_outline, size: 18, color: Colors.white38),
            ),
          ],
        ),
      ),
    );
  }
}

class _Chip extends StatelessWidget {
  const _Chip({required this.label, required this.good});
  final String label;
  final bool good;

  @override
  Widget build(BuildContext context) {
    final colour = good ? const Color(0xFF4CC38A) : const Color(0xFFE5A33C);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: colour.withValues(alpha: 0.15),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(label, style: TextStyle(color: colour, fontSize: 12)),
    );
  }
}

class _Filmstrip extends StatelessWidget {
  const _Filmstrip({required this.tiles});
  final List<ui.Image> tiles;

  static const double _height = qkThumbHeight * 1.0;

  @override
  Widget build(BuildContext context) {
    if (tiles.isEmpty) {
      return const SizedBox(height: _height);
    }
    return SizedBox(
      height: _height,
      child: Row(
        children: [
          for (final tile in tiles)
            Expanded(
              child: RawImage(image: tile, fit: BoxFit.cover),
            ),
        ],
      ),
    );
  }
}

class _Scrubber extends StatelessWidget {
  const _Scrubber({
    required this.info,
    required this.playhead,
    required this.inPoint,
    required this.outPoint,
    required this.onScrub,
    required this.onMarkIn,
    required this.onMarkOut,
  });

  final SourceInfo info;
  final double playhead;
  final double inPoint;
  final double outPoint;
  final ValueChanged<double> onScrub;
  final VoidCallback onMarkIn;
  final VoidCallback onMarkOut;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
      child: Row(
        children: [
          Text(_time(playhead), style: const TextStyle(fontFeatures: [ui.FontFeature.tabularFigures()])),
          Expanded(
            child: Slider(
              value: playhead.clamp(0, info.duration),
              max: info.duration <= 0 ? 1 : info.duration,
              onChanged: onScrub,
            ),
          ),
          Text(_time(info.duration),
              style: const TextStyle(fontFeatures: [ui.FontFeature.tabularFigures()])),
          const SizedBox(width: 16),
          OutlinedButton(onPressed: onMarkIn, child: Text('In  ${_time(inPoint)}')),
          const SizedBox(width: 8),
          OutlinedButton(onPressed: onMarkOut, child: Text('Out  ${_time(outPoint)}')),
        ],
      ),
    );
  }

  static String _time(double seconds) {
    if (seconds.isNaN || seconds < 0) seconds = 0;
    final minutes = seconds ~/ 60;
    final rest = seconds - minutes * 60;
    return '$minutes:${rest.toStringAsFixed(2).padLeft(5, '0')}';
  }
}

class _StatusBar extends StatelessWidget {
  const _StatusBar({required this.info, this.path});
  final SourceInfo info;
  final String? path;

  @override
  Widget build(BuildContext context) {
    final bits = <String>[
      if (path != null) path!.split('/').last,
      if (info.hasVideo) '${info.width}x${info.height}',
      if (info.videoCodec != null) info.videoCodec!,
      if (info.rotation != 0) 'rotated ${info.rotation}',
      if (info.hasAudio) '${info.audioCodec} ${info.sampleRate}Hz ${info.channels}ch',
      info.hardwareDecoded ? 'NVDEC' : 'software decode',
    ];
    return Container(
      width: double.infinity,
      color: const Color(0xFF1B1D22),
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
      child: Text(bits.join('   ·   '),
          style: const TextStyle(fontSize: 12, color: Colors.white54)),
    );
  }
}
