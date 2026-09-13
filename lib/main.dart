// QCKCUT on the desktop.
//
// The browser original ran everything through WebCodecs. Here the same work is
// done by FFmpeg with NVDEC and NVENC behind `lib/engine`, and this file is the
// shell around it: start the engine, reopen the last project, hand both to the
// editor.

import 'package:flutter/material.dart';

import 'engine/engine.dart';
import 'state/project.dart';
import 'state/store.dart';
import 'ui/editor.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // The engine starts before the first frame so the UI can say what this
  // machine can actually do rather than guessing and correcting itself later.
  MediaEngine? engine;
  Project? project;
  Object? failure;

  try {
    engine = await MediaEngine.start();

    // The most recently touched project, or a new one. Opening the last thing
    // you were working on is what every editor does, and the alternative is an
    // empty window that makes you go and find it.
    final store = ProjectStore();
    final saved = store.list();
    project = saved.isEmpty
        ? Project(engine, store: store)
        : await Project.open(engine, saved.first, store: store);
  } catch (error) {
    failure = error;
  }

  runApp(QckcutApp(engine: engine, project: project, failure: failure));
}

class QckcutApp extends StatelessWidget {
  const QckcutApp({super.key, this.engine, this.project, this.failure});

  final MediaEngine? engine;
  final Project? project;
  final Object? failure;

  @override
  Widget build(BuildContext context) {
    final scheme = ColorScheme.fromSeed(
      seedColor: const Color(0xFF6E9BFF),
      brightness: Brightness.dark,
    );

    return MaterialApp(
      title: 'QCKCUT',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorScheme: scheme,
        useMaterial3: true,
        scaffoldBackgroundColor: const Color(0xFF121316),
      ),
      home: engine != null && project != null
          ? EditorPage(engine: engine!, project: project!)
          : EngineFailure(error: failure),
    );
  }
}

/// Shown when the engine will not start at all. Worth its own screen: without
/// it the app would come up looking fine and fail on the first import.
class EngineFailure extends StatelessWidget {
  const EngineFailure({super.key, this.error});

  final Object? error;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 560),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('The media engine did not start',
                  style: Theme.of(context).textTheme.headlineSmall),
              const SizedBox(height: 12),
              Text('$error',
                  style: Theme.of(context)
                      .textTheme
                      .bodyMedium
                      ?.copyWith(color: Theme.of(context).colorScheme.error)),
              const SizedBox(height: 16),
              const Text(
                'libqckcut_engine.so is built with the app. If this says the '
                'library was not found, the Linux build has not run yet.',
              ),
            ],
          ),
        ),
      ),
    );
  }
}
