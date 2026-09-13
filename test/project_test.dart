// The project as a whole: importing, editing, saving and reopening against the
// real engine. The file format is covered in store_test; what is checked here
// is that a project that has been through a save and a reopen is the same
// project, which is the thing a user actually notices.

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:qckcut/core/sequence.dart' as seq;
import 'package:qckcut/engine/engine.dart';
import 'package:qckcut/state/project.dart';
import 'package:qckcut/state/store.dart';

bool get _haveFfmpeg {
  try {
    return Process.runSync('ffmpeg', ['-version']).exitCode == 0;
  } catch (_) {
    return false;
  }
}

void main() {
  late Directory work;
  late String fixture;
  late MediaEngine engine;
  late ProjectStore store;

  setUpAll(() async {
    if (!_haveFfmpeg) return;
    work = Directory.systemTemp.createTempSync('qckcut_project_');
    fixture = '${work.path}/fixture.mp4';
    Process.runSync('ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=4',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
      fixture,
    ]);
    engine = await MediaEngine.start();
    store = ProjectStore(directory: Directory('${work.path}/projects'));
  });

  tearDownAll(() {
    if (_haveFfmpeg && work.existsSync()) work.deleteSync(recursive: true);
  });

  test('an imported source and its ranges survive a reopen', () async {
    final project = Project(engine, store: store, name: 'Round trip');
    final source = await project.import(fixture);
    project.addRange(source, 0.5, 1.5);
    project.addRange(source, 2.0, 3.0);
    project.setIntro(const seq.Transition(type: 'fade', duration: 0.5));
    await project.save();

    final saved = store.load(project.id)!;
    final reopened = await Project.open(engine, saved, store: store);

    expect(reopened.name, 'Round trip');
    expect(reopened.sources, hasLength(1));
    expect(reopened.sources.single.path, fixture);
    expect(reopened.items, hasLength(2));
    expect(reopened.duration, closeTo(2.0, 1e-6));
    expect(reopened.intro!.type, 'fade');
    expect(reopened.missing, isEmpty);

    project.dispose();
    reopened.dispose();
  });

  // Ids come from a counter, so reopening has to start it past anything already
  // used or a new item would collide with an old one and the wrong one would be
  // selected, moved or deleted.
  test('ids handed out after a reopen do not collide with the old ones', () async {
    final project = Project(engine, store: store, name: 'Ids');
    final source = await project.import(fixture);
    project.addRange(source, 0, 1);
    project.addRange(source, 1, 2);
    await project.save();

    final reopened = await Project.open(engine, store.load(project.id)!, store: store);
    final before = reopened.items.map((i) => i.id).toSet();
    reopened.addRange(reopened.sources.single, 2, 3);

    expect(before.contains(reopened.items.last.id), isFalse,
        reason: 'a new item reused an id from the saved project');
    expect(reopened.items.map((i) => i.id).toSet(), hasLength(3));

    project.dispose();
    reopened.dispose();
  });

  test('a source whose file has moved is reported, not silently dropped', () async {
    final movable = '${work.path}/movable.mp4';
    File(fixture).copySync(movable);

    final project = Project(engine, store: store, name: 'Moved');
    final source = await project.import(movable);
    project.addRange(source, 0, 1);
    await project.save();
    project.dispose();

    File(movable).deleteSync();
    final reopened = await Project.open(engine, store.load(project.id)!, store: store);

    expect(reopened.sources, isEmpty);
    expect(reopened.missing, hasLength(1));
    expect(reopened.missing.single.name, 'movable.mp4');
    // The items stay: putting the file back should be enough to recover, and
    // throwing away the edit would make a moved file cost you the work.
    expect(reopened.items, hasLength(1));

    // And a save must not lose the missing source either, or the next reopen
    // would have items pointing at a source that is no longer even recorded.
    await reopened.save();
    expect(store.load(project.id)!.sources, hasLength(1));

    reopened.dispose();
  });

  test('removing a source takes its items with it', () async {
    final project = Project(engine, store: store, name: 'Cascade');
    final source = await project.import(fixture);
    project.addRange(source, 0, 1);
    project.addRange(source, 1, 2);
    expect(project.items, hasLength(2));

    await project.removeSource(source.id);
    expect(project.items, isEmpty);
    expect(project.sources, isEmpty);
    project.dispose();
  });

  test('undo puts back what the last change took away', () async {
    final project = Project(engine, store: store, name: 'Undo');
    final source = await project.import(fixture);
    project.addRange(source, 0, 1);
    project.addRange(source, 1, 2);
    expect(project.undoLabel, isNotNull);

    project.removeItem(project.items.first.id);
    expect(project.items, hasLength(1));

    project.undo();
    expect(project.items, hasLength(2));

    project.redo();
    expect(project.items, hasLength(1));
    project.dispose();
  });
}
