// Project persistence.
//
// The browser original kept each project in its own IndexedDB database and put
// the source *blobs* in it, because a web page has no filesystem and a dropped
// File does not survive a reload. On the desktop that constraint is gone: a
// path is stable, so a project stores paths and nothing else. Nothing is
// copied, a project file is a few kilobytes whatever the footage weighs, and
// you can read one in a text editor.
//
// The cost of that trade is that a source can move or be deleted behind the
// project's back, which the browser version could not suffer. So a project
// records enough about each source to describe it in the UI without opening it,
// and a source that will not reopen is reported rather than silently dropped.
//
// One file per project in the data directory; the project list is the
// directory. Writes go to a temporary file and are renamed into place, because
// a half-written project file read back at the next launch is worse than no
// project file at all.

import 'dart:convert';
import 'dart:io';

import '../core/frame.dart';
import '../core/output.dart';
import '../core/sequence.dart' as seq;

const int _formatVersion = 1;

/// Where projects live, following the XDG base directory spec.
Directory projectsDirectory() {
  final home = Platform.environment['HOME'] ?? '.';
  final data = Platform.environment['XDG_DATA_HOME'] ?? '$home/.local/share';
  return Directory('$data/qckcut/projects');
}

/// What a source was, recorded so the project can be listed and drawn without
/// opening a decoder for every file in it.
class StoredSource {
  const StoredSource({
    required this.id,
    required this.path,
    required this.duration,
    required this.width,
    required this.height,
    required this.hasVideo,
    required this.hasAudio,
    this.videoCodec,
  });

  final String id;
  final String path;
  final double duration;
  final int width;
  final int height;
  final bool hasVideo;
  final bool hasAudio;
  final String? videoCodec;

  String get name => path.split('/').last;

  /// Whether the file is still where the project left it.
  bool get exists => File(path).existsSync();

  Map<String, Object?> toJson() => {
        'id': id,
        'path': path,
        'duration': duration,
        'width': width,
        'height': height,
        'hasVideo': hasVideo,
        'hasAudio': hasAudio,
        'videoCodec': videoCodec,
      };

  static StoredSource fromJson(Map<String, Object?> json) => StoredSource(
        id: json['id']! as String,
        path: json['path']! as String,
        duration: (json['duration'] as num?)?.toDouble() ?? 0,
        width: (json['width'] as num?)?.toInt() ?? 0,
        height: (json['height'] as num?)?.toInt() ?? 0,
        hasVideo: json['hasVideo'] as bool? ?? false,
        hasAudio: json['hasAudio'] as bool? ?? false,
        videoCodec: json['videoCodec'] as String?,
      );
}

/// A whole project, as it sits on disk.
class StoredProject {
  StoredProject({
    required this.id,
    required this.name,
    required this.updatedAt,
    this.sources = const [],
    this.items = const [],
    this.intro,
    this.outro,
    this.output = const OutputShape(),
    this.codec = 0,
  });

  final String id;
  String name;
  DateTime updatedAt;
  List<StoredSource> sources;
  List<seq.Item> items;
  seq.Transition? intro;
  seq.Transition? outro;

  /// What the project is being cut for. Stored per project, since it describes
  /// that project's deliverable rather than a preference.
  OutputShape output;
  int codec;

  Map<String, Object?> toJson() => {
        'version': _formatVersion,
        'id': id,
        'name': name,
        'updatedAt': updatedAt.toIso8601String(),
        'sources': [for (final source in sources) source.toJson()],
        // The sequence is written whole rather than per item: its order *is* its
        // timing, so a partial write would be a reordered sequence.
        'items': [for (final item in items) _itemToJson(item)],
        'intro': _transitionToJson(intro),
        'outro': _transitionToJson(outro),
        'output': {
          'width': output.width,
          'height': output.height,
          'fps': output.fps,
          'fit': output.fit.name,
        },
        'codec': codec,
      };

  static StoredProject fromJson(Map<String, Object?> json) => StoredProject(
        id: json['id']! as String,
        name: json['name'] as String? ?? 'Untitled',
        updatedAt:
            DateTime.tryParse(json['updatedAt'] as String? ?? '') ?? DateTime.now(),
        sources: [
          for (final source in (json['sources'] as List? ?? const []))
            StoredSource.fromJson((source as Map).cast<String, Object?>()),
        ],
        items: [
          for (final item in (json['items'] as List? ?? const []))
            _itemFromJson((item as Map).cast<String, Object?>()),
        ],
        intro: _transitionFromJson(json['intro']),
        outro: _transitionFromJson(json['outro']),
        output: _outputFromJson(json['output']),
        codec: (json['codec'] as num?)?.toInt() ?? 0,
      );
}

OutputShape _outputFromJson(Object? json) {
  if (json is! Map) return const OutputShape();
  return OutputShape(
    width: (json['width'] as num?)?.toInt(),
    height: (json['height'] as num?)?.toInt(),
    fps: (json['fps'] as num?)?.toDouble(),
    fit: Fit.values.firstWhere(
      (fit) => fit.name == json['fit'],
      orElse: () => Fit.contain,
    ),
  );
}

Map<String, Object?> _itemToJson(seq.Item item) => {
      'id': item.id,
      'sourceId': item.sourceId,
      'in': item.inPoint,
      'out': item.outPoint,
      'rotate': item.rotate,
      if (item.frame case final frame?)
        'frame': {'zoom': frame.zoom, 'x': frame.x, 'y': frame.y},
      'transition': _transitionToJson(item.transition),
      'gain': item.gain,
      'muted': item.muted,
    };

seq.Item _itemFromJson(Map<String, Object?> json) {
  final frame = json['frame'] as Map?;
  return seq.Item(
    id: json['id']! as String,
    sourceId: json['sourceId']! as String,
    inPoint: (json['in'] as num).toDouble(),
    outPoint: (json['out'] as num).toDouble(),
    rotate: (json['rotate'] as num?)?.toInt() ?? 0,
    frame: frame == null
        ? null
        : Framing(
            zoom: (frame['zoom'] as num?)?.toDouble() ?? 1,
            x: (frame['x'] as num?)?.toDouble() ?? 0.5,
            y: (frame['y'] as num?)?.toDouble() ?? 0.5,
          ),
    transition: _transitionFromJson(json['transition']),
    gain: (json['gain'] as num?)?.toDouble() ?? 1,
    muted: json['muted'] as bool? ?? false,
  );
}

Map<String, Object?>? _transitionToJson(seq.Transition? transition) =>
    transition == null || transition.type == 'none'
        ? null
        : {'type': transition.type, 'duration': transition.duration};

seq.Transition? _transitionFromJson(Object? json) {
  if (json is! Map) return null;
  final type = json['type'] as String?;
  if (type == null || type == 'none') return null;
  return seq.Transition(
      type: type, duration: (json['duration'] as num?)?.toDouble() ?? 0);
}

// ─── Reading and writing ─────────────────────────────────────────────────────

class ProjectStore {
  ProjectStore({Directory? directory}) : _directory = directory ?? projectsDirectory();

  final Directory _directory;

  File _fileFor(String id) => File('${_directory.path}/$id.json');

  /// Every project on disk, newest first. A file that will not parse is skipped
  /// rather than taking the whole list down with it.
  List<StoredProject> list() {
    if (!_directory.existsSync()) return const [];
    final projects = <StoredProject>[];
    for (final entry in _directory.listSync()) {
      if (entry is! File || !entry.path.endsWith('.json')) continue;
      try {
        final json = jsonDecode(entry.readAsStringSync()) as Map<String, Object?>;
        projects.add(StoredProject.fromJson(json));
      } catch (_) {
        continue;
      }
    }
    projects.sort((a, b) => b.updatedAt.compareTo(a.updatedAt));
    return projects;
  }

  StoredProject? load(String id) {
    final file = _fileFor(id);
    if (!file.existsSync()) return null;
    try {
      return StoredProject.fromJson(
          jsonDecode(file.readAsStringSync()) as Map<String, Object?>);
    } catch (_) {
      return null;
    }
  }

  /// Written to a temporary file and renamed into place. A rename within one
  /// filesystem is atomic, so a crash mid-write leaves the previous project
  /// intact rather than a truncated file that fails to parse at next launch.
  Future<void> save(StoredProject project) async {
    await _directory.create(recursive: true);
    project.updatedAt = DateTime.now();
    final encoded = const JsonEncoder.withIndent('  ').convert(project.toJson());
    final temporary = File('${_fileFor(project.id).path}.tmp');
    await temporary.writeAsString(encoded, flush: true);
    await temporary.rename(_fileFor(project.id).path);
  }

  Future<void> delete(String id) async {
    final file = _fileFor(id);
    if (await file.exists()) await file.delete();
  }
}
