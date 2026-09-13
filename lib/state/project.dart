// What the editor is holding: the sources that have been imported, and the
// sequence built out of them.
//
// The sequence model itself lives in `core/sequence.dart` and is pure. This
// file is the mutable shell around it: it owns the open decoders, the decoded
// thumbnails, and the undo stack, none of which belong in a model that is meant
// to be reasoned about on its own.

import 'dart:async';
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';

import '../core/sequence.dart' as seq;
import '../core/transitions.dart' as transitions;
import '../engine/engine.dart';

/// One imported file, with its decoder kept warm.
class Source {
  Source({
    required this.id,
    required this.path,
    required this.handle,
    required this.info,
  });

  final String id;
  final String path;
  final int handle;
  final SourceInfo info;

  /// Filmstrip tiles, filled in after the import so a long source becomes
  /// scannable without the import itself waiting on them.
  List<ui.Image> tiles = const [];
  int tileWidth = 0;

  String get name => path.split('/').last;

  bool get hasVideo => info.hasVideo;
}

/// A snapshot of everything undo has to put back. Taken whole rather than as a
/// difference: working out the minimal change between two states would be a lot
/// of care for no gain at these sizes, and getting it subtly wrong would
/// corrupt a project.
class _Snapshot {
  const _Snapshot(this.items, this.intro, this.outro, this.label);
  final List<seq.Item> items;
  final seq.Transition? intro;
  final seq.Transition? outro;
  final String label;
}

class Project extends ChangeNotifier {
  Project(this.engine);

  final MediaEngine engine;

  final List<Source> sources = [];
  List<seq.Item> items = [];

  seq.Transition? intro;
  seq.Transition? outro;

  String? selectedSourceId;
  String? selectedItemId;

  final List<_Snapshot> _undo = [];
  final List<_Snapshot> _redo = [];

  /// What the last undoable change was, so the UI can say what it would undo
  /// rather than offering a bare arrow.
  String? get undoLabel => _undo.isEmpty ? null : _undo.last.label;
  String? get redoLabel => _redo.isEmpty ? null : _redo.last.label;

  List<seq.Row> get rows => seq.layout(items);
  double get duration => seq.totalDuration(items);

  Source? get selectedSource => _find(selectedSourceId);
  Source? sourceOf(seq.Item item) => _find(item.sourceId);

  Source? _find(String? id) {
    if (id == null) return null;
    for (final source in sources) {
      if (source.id == id) return source;
    }
    return null;
  }

  /// Selection is not undoable: it is where you are looking, not a change to
  /// the project, and putting it on the undo stack would mean an undo sometimes
  /// only moved the highlight.
  void selectItem(String? id) {
    if (selectedItemId == id) return;
    selectedItemId = id;
    notifyListeners();
  }

  void selectSource(String? id) {
    if (selectedSourceId == id) return;
    selectedSourceId = id;
    notifyListeners();
  }

  var _nextId = 0;
  String _id(String prefix) => '$prefix${_nextId++}';

  // ─── Sources ───────────────────────────────────────────────────────────────

  Future<Source> import(String path) async {
    final handle = await engine.open(path);
    final info = await engine.info(handle);
    final source = Source(id: _id('s'), path: path, handle: handle, info: info);
    sources.add(source);
    selectedSourceId = source.id;
    notifyListeners();

    if (source.hasVideo) unawaited(_loadTiles(source));
    return source;
  }

  Future<void> _loadTiles(Source source) async {
    try {
      final (tiles, width) = await engine.thumbnails(source.handle, 16);
      final images = <ui.Image>[];
      for (final tile in tiles) {
        final completer = Completer<ui.Image>();
        ui.decodeImageFromPixels(
            tile, width, 88, ui.PixelFormat.rgba8888, completer.complete);
        images.add(await completer.future);
      }
      source.tiles = images;
      source.tileWidth = width;
      notifyListeners();
    } catch (_) {
      // A filmstrip that will not decode is not worth interrupting the edit for.
    }
  }

  Future<void> removeSource(String id) async {
    final source = _find(id);
    if (source == null) return;
    _remember('Remove ${source.name}');
    // Items that pointed at it go too: a sequence referring to a source that is
    // no longer open would render as black with nothing to explain why.
    items = items.where((item) => item.sourceId != id).toList();
    sources.remove(source);
    for (final tile in source.tiles) {
      tile.dispose();
    }
    if (selectedSourceId == id) selectedSourceId = sources.isEmpty ? null : sources.first.id;
    notifyListeners();
    await engine.close(source.handle);
  }

  // ─── The sequence ──────────────────────────────────────────────────────────

  void _remember(String label) {
    _undo.add(_Snapshot(List.of(items), intro, outro, label));
    _redo.clear();
    // A stack that grows without limit is a memory leak wearing a feature's
    // clothes; this many steps is well past what anyone reaches for.
    if (_undo.length > 100) _undo.removeAt(0);
  }

  void addRange(Source source, double inPoint, double outPoint) {
    if (outPoint <= inPoint) return;
    _remember('Add ${source.name}');
    items = seq.insert(
      items,
      seq.Item(
        id: _id('i'),
        sourceId: source.id,
        inPoint: inPoint,
        outPoint: outPoint,
      ),
      items.length,
    );
    selectedItemId = items.last.id;
    notifyListeners();
  }

  void removeItem(String id) {
    _remember('Remove from sequence');
    items = seq.remove(items, id);
    if (selectedItemId == id) selectedItemId = null;
    notifyListeners();
  }

  void moveItem(int from, int to) {
    if (from == to) return;
    _remember('Reorder');
    items = seq.move(items, from, to);
    notifyListeners();
  }

  void updateItem(String id, seq.Item Function(seq.Item) change, String label) {
    _remember(label);
    items = [
      for (final item in items) item.id == id ? change(item) : item,
    ];
    notifyListeners();
  }

  void setIntro(seq.Transition? value) {
    _remember('Sequence start');
    intro = value;
    notifyListeners();
  }

  void setOutro(seq.Transition? value) {
    _remember('Sequence end');
    outro = value;
    notifyListeners();
  }

  transitions.Plan get plan => transitions.plan(rows, intro: intro, outro: outro);

  // ─── Undo ──────────────────────────────────────────────────────────────────

  void undo() {
    if (_undo.isEmpty) return;
    final snapshot = _undo.removeLast();
    _redo.add(_Snapshot(List.of(items), intro, outro, snapshot.label));
    items = snapshot.items;
    intro = snapshot.intro;
    outro = snapshot.outro;
    notifyListeners();
  }

  void redo() {
    if (_redo.isEmpty) return;
    final snapshot = _redo.removeLast();
    _undo.add(_Snapshot(List.of(items), intro, outro, snapshot.label));
    items = snapshot.items;
    intro = snapshot.intro;
    outro = snapshot.outro;
    notifyListeners();
  }

  // ─── Export ────────────────────────────────────────────────────────────────

  /// The sequence as the engine wants it: paths rather than handles, because
  /// the render opens its own decoders and must not disturb the warm ones the
  /// preview is using.
  List<SequenceItem> get renderItems => [
        for (final item in items)
          if (sourceOf(item) case final source?)
            SequenceItem(
              path: source.path,
              inPoint: item.inPoint,
              outPoint: item.outPoint,
              rotate: item.rotate,
              zoom: item.frame?.zoom,
              frameX: item.frame?.x ?? 0.5,
              frameY: item.frame?.y ?? 0.5,
              gain: item.gain,
              muted: item.muted,
              dipDuration:
                  item.transition?.type == 'dip' ? item.transition!.duration : 0,
            ),
      ];

  @override
  void dispose() {
    for (final source in sources) {
      for (final tile in source.tiles) {
        tile.dispose();
      }
      unawaited(engine.close(source.handle));
    }
    super.dispose();
  }
}
