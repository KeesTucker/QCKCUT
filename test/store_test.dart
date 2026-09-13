// Project persistence, against a real temporary directory.
//
// A project file is the one artefact a user can lose work through, so what is
// tested here is mostly what happens when it is wrong: truncated, from a
// future version, or pointing at a file that has moved.

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:qckcut/core/frame.dart';
import 'package:qckcut/core/sequence.dart' as seq;
import 'package:qckcut/state/store.dart';

void main() {
  late Directory work;
  late ProjectStore store;

  setUp(() {
    work = Directory.systemTemp.createTempSync('qckcut_store_');
    store = ProjectStore(directory: work);
  });

  tearDown(() {
    if (work.existsSync()) work.deleteSync(recursive: true);
  });

  StoredProject sample({String id = 'p1'}) => StoredProject(
        id: id,
        name: 'A cut',
        updatedAt: DateTime(2026, 9, 13),
        sources: [
          StoredSource(
            id: 's0',
            path: '${work.path}/clip.mp4',
            duration: 6,
            width: 1920,
            height: 1080,
            hasVideo: true,
            hasAudio: true,
            videoCodec: 'h264',
          ),
        ],
        items: [
          seq.Item(
            id: 'i0',
            sourceId: 's0',
            inPoint: 0.5,
            outPoint: 2.5,
            rotate: 90,
            frame: const Framing(zoom: 1.6, x: 0.4, y: 0.6),
            transition: const seq.Transition(type: 'dip', duration: 0.4),
            gain: 0.8,
            muted: true,
          ),
        ],
        intro: const seq.Transition(type: 'fade', duration: 0.5),
      );

  test('a project survives a round trip whole', () async {
    await store.save(sample());
    final read = store.load('p1')!;

    expect(read.name, 'A cut');
    expect(read.sources.single.path, '${work.path}/clip.mp4');
    expect(read.sources.single.width, 1920);

    final item = read.items.single;
    expect(item.inPoint, 0.5);
    expect(item.outPoint, 2.5);
    expect(item.rotate, 90);
    expect(item.frame!.zoom, 1.6);
    expect(item.frame!.x, 0.4);
    expect(item.transition!.type, 'dip');
    expect(item.gain, 0.8);
    expect(item.muted, isTrue);
    expect(read.intro!.type, 'fade');
    expect(read.outro, isNull);
  });

  test('the order of the sequence is the order it is read back in', () async {
    final project = sample();
    project.items = [
      for (var i = 0; i < 5; i++)
        seq.Item(id: 'i$i', sourceId: 's0', inPoint: i * 1.0, outPoint: i + 1.0),
    ];
    await store.save(project);
    expect(store.load('p1')!.items.map((i) => i.id), ['i0', 'i1', 'i2', 'i3', 'i4']);
  });

  test('lists projects newest first', () async {
    await store.save(sample(id: 'old'));
    await store.save(sample(id: 'new'));
    final listed = store.list();
    expect(listed, hasLength(2));
    expect(listed.first.id, 'new');
  });

  // A half-written file read back at the next launch is worse than no file, so
  // a broken one is skipped rather than taking the list down with it.
  test('a corrupt project file does not break the list', () async {
    await store.save(sample(id: 'good'));
    File('${work.path}/broken.json').writeAsStringSync('{"id": "broken", ');
    final listed = store.list();
    expect(listed.map((p) => p.id), ['good']);
    expect(store.load('broken'), isNull);
  });

  test('a missing project is null rather than an exception', () {
    expect(store.load('nothing'), isNull);
  });

  test('saving twice leaves one file, not a temporary beside it', () async {
    await store.save(sample());
    await store.save(sample());
    final files = work.listSync().whereType<File>().map((f) => f.path).toList();
    expect(files, hasLength(1));
    expect(files.single, endsWith('p1.json'));
  });

  // A path is stable but not guaranteed, which is the one thing the browser
  // original did not have to worry about.
  test('reports whether a source is still where it was left', () async {
    await store.save(sample());
    final read = store.load('p1')!;
    expect(read.sources.single.exists, isFalse);

    File('${work.path}/clip.mp4').writeAsStringSync('not really a video');
    expect(store.load('p1')!.sources.single.exists, isTrue);
  });

  test('an unset transition reads back as null rather than a none', () async {
    final project = sample();
    project.intro = const seq.Transition(type: 'none', duration: 0);
    await store.save(project);
    expect(store.load('p1')!.intro, isNull);
  });
}
