// The editor.
//
// Import sources on the left, scrub the selected one in the middle, mark a
// range and add it to the sequence along the bottom. That is the whole loop the
// original was built around, and it is deliberately the same one here.

import 'dart:async';
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter/services.dart';

import '../core/frame.dart';
import '../core/output.dart';
import '../core/sequence.dart' as seq;
import '../core/transitions.dart' as transitions;
import '../engine/engine.dart';
import '../state/project.dart';
import 'framing.dart';
import 'media_types.dart';
import 'settings_dialog.dart';
import 'timeline.dart';

class EditorPage extends StatefulWidget {
  const EditorPage({super.key, required this.engine, required this.project});

  final MediaEngine engine;

  /// Made by the caller rather than here, because opening a saved project is
  /// asynchronous and a widget cannot wait for it before its first build.
  final Project project;

  @override
  State<EditorPage> createState() => _EditorPageState();
}

class _EditorPageState extends State<EditorPage> with SingleTickerProviderStateMixin {
  Project get _project => widget.project;

  ui.Image? _preview;
  double _playhead = 0;      // within the selected source
  double _inPoint = 0;
  double _outPoint = 0;

  /// When the timeline is being scrubbed the preview follows the sequence
  /// rather than the source, because that is what the playhead means there.
  double? _sequenceAt;

  /// Framing is a mode rather than always-on: dragging the preview has to mean
  /// one thing, and the rest of the time it should not move the picture.
  bool _framing = false;

  String? _error;
  bool _busy = false;
  double? _progress;
  String _phase = '';
  bool _hardware = false;

  /// Roughly how many pixels across to decode a preview at. The exact size is
  /// the source's own aspect, because the framing overlay crops this image and
  /// letterbox bars baked into it would be cropped along with the picture.
  static const int _previewAcross = 1024;

  /// Playback. The ticker only decides *when* to ask for a frame; *which*
  /// frame comes from the engine's audio clock, never from the ticker's own
  /// elapsed time, because the sound card and the system timer disagree about
  /// how long a second is and the picture would slide against the sound.
  Ticker? _ticker;
  bool _playing = false;

  /// Scrubbing fires far faster than a decode completes, so a request in flight
  /// means the next one waits and only the newest is served. Without this the
  /// decoder ends up a second behind the pointer and never catches up.
  bool _decoding = false;
  ({int handle, double at})? _queued;

  @override
  void initState() {
    super.initState();
    _project.addListener(_onProjectChanged);
    if (_project.missing.isNotEmpty) {
      final names = _project.missing.map((s) => s.name).join(', ');
      _error = 'Could not reopen: $names. '
          'The project remembers paths, so putting the files back is enough.';
    }
    final first = _project.sources.isEmpty ? null : _project.sources.first;
    if (first != null && first.hasVideo) {
      _outPoint = first.info.duration;
      unawaited(_showSourceFrame(first, 0));
    }
  }

  @override
  void dispose() {
    _ticker?.dispose();
    unawaited(widget.engine.stopPlayback());
    _project.removeListener(_onProjectChanged);
    // Owned by the caller, which made it; disposing it here would tear down a
    // project the app may still be about to save.
    _preview?.dispose();
    super.dispose();
  }

  void _onProjectChanged() => setState(() {});

  Future<ui.Image> _toImage(Uint8List pixels, int width, int height) {
    final completer = Completer<ui.Image>();
    ui.decodeImageFromPixels(
        pixels, width, height, ui.PixelFormat.rgba8888, completer.complete);
    return completer.future;
  }

  // ─── Import ────────────────────────────────────────────────────────────────

  Future<void> _import() async {
    final files = await openFiles(acceptedTypeGroups: importGroups());
    if (files.isEmpty) return;

    setState(() { _busy = true; _error = null; });
    try {
      for (final file in files) {
        final source = await _project.import(file.path);
        if (source.hasVideo) {
          _inPoint = 0;
          _outPoint = source.info.duration;
          _playhead = 0;
          await _showSourceFrame(source, 0);
        }
      }
    } catch (error) {
      setState(() => _error = '$error');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  // ─── Preview ───────────────────────────────────────────────────────────────

  Future<void> _showSourceFrame(Source source, double at) =>
      _decode(source.handle, at);

  /// The decode size for a source: its own shape, so nothing is padded.
  (int, int) _previewSize(Source source) {
    final width = source.info.width;
    final height = source.info.height;
    if (width <= 0 || height <= 0) return (_previewAcross, _previewAcross * 9 ~/ 16);
    final scale = _previewAcross / width;
    return (
      math.max(2, (width * scale).round() & ~1),
      math.max(2, (height * scale).round() & ~1),
    );
  }

  Future<void> _decode(int handle, double at) async {
    if (_decoding) {
      _queued = (handle: handle, at: at);
      return;
    }
    _decoding = true;
    try {
      Source? owner;
      for (final source in _project.sources) {
        if (source.handle == handle) owner = source;
      }
      final (width, height) =
          owner == null ? (_previewAcross, 576) : _previewSize(owner);
      final frame = await widget.engine.frameAt(handle, at, width, height);
      final image = await _toImage(frame.pixels, frame.width, frame.height);
      if (!mounted) { image.dispose(); return; }
      setState(() {
        _preview?.dispose();
        _preview = image;
        _hardware = frame.hardwareDecoded;
      });
    } catch (error) {
      if (mounted) setState(() => _error = '$error');
    } finally {
      _decoding = false;
      final next = _queued;
      _queued = null;
      if (next != null) unawaited(_decode(next.handle, next.at));
    }
  }

  /// Show what the sequence looks like at [at]: the item covering that instant,
  /// at the source time it maps to.
  Future<void> _showSequenceFrame(double at) async {
    final row = seq.at(_project.rows, at);
    if (row == null) return;
    final source = _project.sourceOf(row.item);
    if (source == null || !source.hasVideo) return;
    await _decode(source.handle, seq.sourceTime(row, at));
  }

  Future<void> _openSettings() async {
    final result = await showDialog<(OutputShape, int)>(
      context: context,
      builder: (context) => OutputSettingsDialog(
        shape: _project.output,
        codec: _project.codec,
        engine: widget.engine,
      ),
    );
    if (result == null) return;
    _project.setOutput(result.$1);
    _project.setCodec(result.$2);
  }

  // ─── Playback ──────────────────────────────────────────────────────────────

  Future<void> _togglePlay() async {
    if (_playing) {
      await _stopPlayback();
      return;
    }
    if (_project.items.isEmpty) return;

    final from = (_sequenceAt ?? 0) >= _project.duration ? 0.0 : (_sequenceAt ?? 0);
    setState(() { _playing = true; _sequenceAt = from; _error = null; });

    try {
      await widget.engine.play(_project.renderItems, from);
    } catch (error) {
      setState(() { _playing = false; _error = '$error'; });
      return;
    }

    _ticker ??= createTicker(_onTick);
    _ticker!.start();
  }

  Future<void> _stopPlayback() async {
    _ticker?.stop();
    setState(() => _playing = false);
    await widget.engine.stopPlayback();
  }

  void _onTick(Duration _) {
    if (!_playing) return;
    // The audio clock is the master. The ticker is only what wakes us up.
    final at = widget.engine.position;
    if (at >= _project.duration) {
      unawaited(_stopPlayback());
      return;
    }
    setState(() => _sequenceAt = at);
    unawaited(_showSequenceFrame(at));
  }

  // ─── Export ────────────────────────────────────────────────────────────────

  Future<void> _exportSequence() async {
    if (_project.items.isEmpty) return;
    final target = await getSaveLocation(
      suggestedName: 'sequence.mp4',
      acceptedTypeGroups: const [XTypeGroup(label: 'mp4', extensions: ['mp4'])],
    );
    if (target == null) return;

    setState(() { _progress = 0; _phase = 'audio'; _error = null; });
    try {
      await widget.engine.exportSequence(
        items: _project.renderItems,
        outputPath: target.path,
        settings: OutputSettings(
          width: _project.output.width,
          height: _project.output.height,
          fps: _project.output.fps,
          codec: _project.codec,
          fit: _project.output.fit.index,
        ),
        introFade: _project.intro?.duration ?? 0,
        outroFade: _project.outro?.duration ?? 0,
        onProgress: (fraction) {
          if (mounted) setState(() => _progress = fraction);
        },
      );
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text('Wrote ${target.path}')));
    } on Cancelled {
      if (mounted) setState(() => _error = 'Export cancelled');
    } catch (error) {
      if (mounted) setState(() => _error = '$error');
    } finally {
      if (mounted) setState(() => _progress = null);
    }
  }

  // ─── Build ─────────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    final source = _project.selectedSource;

    return Shortcuts(
      shortcuts: const {
        SingleActivator(LogicalKeyboardKey.keyZ, control: true): _UndoIntent(),
        SingleActivator(LogicalKeyboardKey.keyZ, control: true, shift: true):
            _RedoIntent(),
        SingleActivator(LogicalKeyboardKey.keyI): _MarkInIntent(),
        SingleActivator(LogicalKeyboardKey.keyO): _MarkOutIntent(),
        SingleActivator(LogicalKeyboardKey.space): _PlayIntent(),
      },
      child: Actions(
        actions: {
          _UndoIntent: CallbackAction<_UndoIntent>(onInvoke: (_) => _project.undo()),
          _RedoIntent: CallbackAction<_RedoIntent>(onInvoke: (_) => _project.redo()),
          _MarkInIntent: CallbackAction<_MarkInIntent>(
              onInvoke: (_) => setState(() => _inPoint = _playhead)),
          _MarkOutIntent: CallbackAction<_MarkOutIntent>(
              onInvoke: (_) => setState(() => _outPoint = _playhead)),
          _PlayIntent: CallbackAction<_PlayIntent>(
              onInvoke: (_) => unawaited(_togglePlay())),
        },
        child: Focus(
          autofocus: true,
          child: Scaffold(
            body: Column(
              children: [
                _toolbar(),
                if (_error != null) _errorBar(),
                Expanded(
                  child: Row(
                    children: [
                      _SourceList(project: _project, busy: _busy, onImport: _import,
                          onPick: (s) {
                        _project.selectSource(s.id);
                        setState(() {
                          _sequenceAt = null;
                          _playhead = 0;
                          _inPoint = 0;
                          _outPoint = s.info.duration;
                        });
                        if (s.hasVideo) unawaited(_showSourceFrame(s, 0));
                      }),
                      const VerticalDivider(width: 1),
                      Expanded(child: _previewArea(source)),
                    ],
                  ),
                ),
                if (source != null) _scrubber(source),
                ItemInspector(project: _project),
                Timeline(
                  project: _project,
                  playhead: _sequenceAt ?? 0,
                  onScrub: (at) {
                    // Scrubbing while playing would have two things driving the
                    // playhead, so playback gives way to the hand on the strip.
                    if (_playing) unawaited(_stopPlayback());
                    setState(() => _sequenceAt = at);
                    unawaited(_showSequenceFrame(at));
                  },
                ),
                _statusBar(source),
              ],
            ),
          ),
        ),
      ),
    );
  }

  /// The item the framing controls act on: whichever is selected on the strip.
  seq.Item? get _selectedItem {
    for (final item in _project.items) {
      if (item.id == _project.selectedItemId) return item;
    }
    return null;
  }

  Widget _previewArea(Source? source) {
    if (_preview == null) {
      return Container(
        color: Colors.black,
        alignment: Alignment.center,
        child: Text(
            source == null
                ? 'Import a file to start'
                : 'No pictures in ${source.name}',
            style: const TextStyle(color: Colors.white38)),
      );
    }

    final shape = _project.outputShape;
    final item = _selectedItem;

    return Stack(
      children: [
        Positioned.fill(
          child: FramedPreview(
            image: _preview,
            outputAspect: shape == null ? 16 / 9 : shape.width / shape.height,
            rotate: item?.rotate ?? 0,
            framing: item?.frame,
            fit: _project.output.fit,
            framingMode: _framing && item != null,
            onFramingChanged: item == null
                ? null
                : (framing) => _project.updateItem(
                    item.id, (i) => i.copyWith(frame: framing), 'Reframe'),
          ),
        ),
        if (_framing) Positioned(left: 12, top: 12, child: _framingControls(item)),
      ],
    );
  }

  Widget _framingControls(seq.Item? item) {
    if (item == null) {
      return const _Hint('Select an item on the strip to frame it');
    }
    final framing = item.frame ?? defaultFrame;
    return Card(
      color: const Color(0xE61B1D22),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Text('Drag to move, scroll to zoom',
                style: TextStyle(fontSize: 12, color: Colors.white70)),
            const SizedBox(width: 16),
            Text('${framing.zoom.toStringAsFixed(2)}x',
                style: const TextStyle(fontSize: 12)),
            const SizedBox(width: 8),
            TextButton(
              onPressed: isDefault(item.frame, item.rotate)
                  ? null
                  : () => _project.updateItem(
                      item.id,
                      (i) => seq.Item(
                            id: i.id,
                            sourceId: i.sourceId,
                            inPoint: i.inPoint,
                            outPoint: i.outPoint,
                            rotate: 0,
                            transition: i.transition,
                            gain: i.gain,
                            muted: i.muted,
                          ),
                      'Reset framing'),
              child: const Text('Reset'),
            ),
          ],
        ),
      ),
    );
  }

  Widget _toolbar() {
    final theme = Theme.of(context);
    final undo = _project.undoLabel;
    final redo = _project.redoLabel;

    return Material(
      color: const Color(0xFF1B1D22),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
        child: Row(
          children: [
            Text('QCKCUT', style: theme.textTheme.titleMedium),
            const SizedBox(width: 16),
            FilledButton.tonalIcon(
              onPressed: _busy ? null : _import,
              icon: const Icon(Icons.add, size: 18),
              label: const Text('Import'),
            ),
            const SizedBox(width: 8),
            IconButton.filled(
              tooltip: _playing ? 'Stop' : 'Play the sequence',
              onPressed: _project.items.isEmpty || _progress != null
                  ? null
                  : () => unawaited(_togglePlay()),
              icon: Icon(_playing ? Icons.stop : Icons.play_arrow, size: 18),
            ),
            const SizedBox(width: 8),
            FilledButton.icon(
              onPressed: _project.items.isEmpty || _progress != null || _playing
                  ? null
                  : _exportSequence,
              icon: const Icon(Icons.movie_creation_outlined, size: 18),
              label: const Text('Export sequence'),
            ),
            const SizedBox(width: 12),
            // Says what it would undo rather than offering a bare arrow.
            IconButton(
              tooltip: undo == null ? 'Nothing to undo' : 'Undo $undo',
              onPressed: undo == null ? null : _project.undo,
              icon: const Icon(Icons.undo, size: 18),
            ),
            IconButton(
              tooltip: redo == null ? 'Nothing to redo' : 'Redo $redo',
              onPressed: redo == null ? null : _project.redo,
              icon: const Icon(Icons.redo, size: 18),
            ),

            if (_progress != null) ...[
              const SizedBox(width: 12),
              SizedBox(width: 140, child: LinearProgressIndicator(value: _progress)),
              const SizedBox(width: 8),
              Text('$_phase ${(_progress! * 100).toStringAsFixed(0)}%',
                  style: const TextStyle(fontSize: 12)),
              TextButton(onPressed: widget.engine.cancel, child: const Text('Cancel')),
            ],

            const Spacer(),
            IconButton(
              tooltip: _framing ? 'Done framing' : 'Frame the selected item',
              isSelected: _framing,
              selectedIcon: const Icon(Icons.crop, size: 18),
              icon: const Icon(Icons.crop_free, size: 18),
              onPressed: () => setState(() => _framing = !_framing),
            ),
            TextButton.icon(
              icon: const Icon(Icons.aspect_ratio, size: 16),
              label: Text(_project.output.label),
              onPressed: _openSettings,
            ),
            const SizedBox(width: 8),
            _fadeToggle('Fade in', _project.intro, _project.setIntro),
            const SizedBox(width: 8),
            _fadeToggle('Fade out', _project.outro, _project.setOutro),
            const SizedBox(width: 12),
            _Chip(label: widget.engine.hasCuda ? 'CUDA' : 'CPU only',
                good: widget.engine.hasCuda),
          ],
        ),
      ),
    );
  }

  Widget _fadeToggle(
      String label, seq.Transition? value, void Function(seq.Transition?) set) {
    final on = value?.type == 'fade';
    return FilterChip(
      label: Text(label, style: const TextStyle(fontSize: 12)),
      selected: on,
      onSelected: (_) => set(on
          ? null
          : const seq.Transition(type: 'fade', duration: transitions.defaultDuration)),
    );
  }

  Widget _errorBar() {
    final theme = Theme.of(context);
    return Container(
      width: double.infinity,
      color: theme.colorScheme.errorContainer,
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
      child: Row(
        children: [
          Expanded(
            child: Text(_error!,
                style: TextStyle(color: theme.colorScheme.onErrorContainer)),
          ),
          IconButton(
            icon: const Icon(Icons.close, size: 16),
            onPressed: () => setState(() => _error = null),
          ),
        ],
      ),
    );
  }

  Widget _scrubber(Source source) {
    final duration = source.info.duration;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 4),
      child: Row(
        children: [
          Text(_time(_playhead), style: _mono),
          Expanded(
            child: Slider(
              value: _playhead.clamp(0, duration),
              max: duration <= 0 ? 1 : duration,
              onChanged: (at) {
                setState(() { _playhead = at; _sequenceAt = null; });
                if (source.hasVideo) unawaited(_showSourceFrame(source, at));
              },
            ),
          ),
          Text(_time(duration), style: _mono),
          const SizedBox(width: 12),
          OutlinedButton(
            onPressed: () => setState(() => _inPoint = _playhead),
            child: Text('In ${_time(_inPoint)}'),
          ),
          const SizedBox(width: 6),
          OutlinedButton(
            onPressed: () => setState(() => _outPoint = _playhead),
            child: Text('Out ${_time(_outPoint)}'),
          ),
          const SizedBox(width: 6),
          FilledButton.tonal(
            onPressed: _outPoint > _inPoint
                ? () => _project.addRange(source, _inPoint, _outPoint)
                : null,
            child: Text('Add ${(_outPoint - _inPoint).toStringAsFixed(2)}s'),
          ),
        ],
      ),
    );
  }

  Widget _statusBar(Source? source) {
    final bits = <String>[
      if (source != null) source.name,
      if (source != null && source.hasVideo)
        '${source.info.width}x${source.info.height}',
      if (source?.info.videoCodec != null) source!.info.videoCodec!,
      if (source != null && source.info.rotation != 0)
        'rotated ${source.info.rotation}',
      '${_project.items.length} items',
      '${_project.duration.toStringAsFixed(2)}s',
      if (_preview != null) _hardware ? 'NVDEC' : 'software decode',
    ];
    return Container(
      width: double.infinity,
      color: const Color(0xFF1B1D22),
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
      child: Text(bits.join('   ·   '),
          style: const TextStyle(fontSize: 12, color: Colors.white54)),
    );
  }

  static const _mono = TextStyle(fontFeatures: [ui.FontFeature.tabularFigures()]);

  static String _time(double seconds) {
    if (seconds.isNaN || seconds < 0) seconds = 0;
    final minutes = seconds ~/ 60;
    final rest = seconds - minutes * 60;
    return '$minutes:${rest.toStringAsFixed(2).padLeft(5, '0')}';
  }
}

class _PlayIntent extends Intent { const _PlayIntent(); }
class _UndoIntent extends Intent { const _UndoIntent(); }
class _RedoIntent extends Intent { const _RedoIntent(); }
class _MarkInIntent extends Intent { const _MarkInIntent(); }
class _MarkOutIntent extends Intent { const _MarkOutIntent(); }

class _SourceList extends StatelessWidget {
  const _SourceList({
    required this.project,
    required this.busy,
    required this.onImport,
    required this.onPick,
  });

  final Project project;
  final bool busy;
  final VoidCallback onImport;
  final ValueChanged<Source> onPick;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: 230,
      child: Container(
        color: const Color(0xFF16181D),
        child: project.sources.isEmpty
            ? Center(
                child: TextButton.icon(
                  onPressed: busy ? null : onImport,
                  icon: const Icon(Icons.add, size: 16),
                  label: const Text('Import media'),
                ),
              )
            : ListView.builder(
                padding: const EdgeInsets.symmetric(vertical: 8),
                itemCount: project.sources.length,
                itemBuilder: (context, index) {
                  final source = project.sources[index];
                  final selected = project.selectedSourceId == source.id;
                  return InkWell(
                    onTap: () => onPick(source),
                    child: Container(
                      color: selected ? const Color(0x40232830) : null,
                      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                      child: Row(
                        children: [
                          SizedBox(
                            width: 52,
                            height: 30,
                            child: source.tiles.isNotEmpty
                                ? RawImage(image: source.tiles.first, fit: BoxFit.cover)
                                : Container(
                                    color: Colors.black26,
                                    child: Icon(
                                      source.hasVideo
                                          ? Icons.movie_outlined
                                          : Icons.music_note,
                                      size: 14,
                                      color: Colors.white30,
                                    ),
                                  ),
                          ),
                          const SizedBox(width: 8),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(source.name,
                                    overflow: TextOverflow.ellipsis,
                                    style: TextStyle(
                                      fontSize: 12,
                                      fontWeight:
                                          selected ? FontWeight.w600 : FontWeight.w400,
                                    )),
                                Text('${source.info.duration.toStringAsFixed(1)}s',
                                    style: const TextStyle(
                                        fontSize: 10, color: Colors.white38)),
                              ],
                            ),
                          ),
                          IconButton(
                            icon: const Icon(Icons.close, size: 14),
                            onPressed: () => project.removeSource(source.id),
                          ),
                        ],
                      ),
                    ),
                  );
                },
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

class _Hint extends StatelessWidget {
  const _Hint(this.text);
  final String text;

  @override
  Widget build(BuildContext context) => Card(
        color: const Color(0xE61B1D22),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          child: Text(text,
              style: const TextStyle(fontSize: 12, color: Colors.white70)),
        ),
      );
}
