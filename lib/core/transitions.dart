// Transitions, kept pure so the preview and the render cannot disagree about
// what they look like.
//
// Every transition here works by darkening the picture that is already being
// drawn, so it needs one decoder and no overlap between items. That is what
// lets the same function drive both the preview and the export: they call
// `dimAt()` with the same numbers and paint the same black over the same frame.
//
// A cross dissolve is deliberately not in this set. It needs two items decoded
// at once and it overlaps them, which shortens the sequence, so it changes the
// layout as well as the painting. See the note at the bottom.

import 'dart:math' as math;

import 'package:meta/meta.dart';

import 'sequence.dart';

@immutable
class Kind {
  const Kind(this.label, this.duration);
  final String label;
  final double duration;
}

const Map<String, Kind> kinds = {
  'none': Kind('None', 0),
  'fade': Kind('Fade', 0.5),
  'dip': Kind('Dip to black', 0.6),
};

const double defaultDuration = 0.5;

@immutable
class Dip {
  const Dip({required this.at, required this.duration});
  final double at;
  final double duration;
}

/// What [dimAt] needs from the current sequence.
@immutable
class Plan {
  const Plan({this.total = 0, this.intro, this.outro, this.dips = const []});
  final double total;
  final Transition? intro;
  final Transition? outro;
  final List<Dip> dips;
}

double _clamp01(double v) => v < 0 ? 0 : (v > 1 ? 1 : v);

/// How black the frame at [time] should be, 0 (untouched) to 1 (fully black).
///
/// `intro` and `outro` fade the very start and very end. `dips` are cuts
/// between items: each takes half its duration from the outgoing side and half
/// from the incoming one, so the sequence keeps its length.
double dimAt(double time, Plan plan) {
  var dim = 0.0;

  final intro = plan.intro;
  if (intro != null && intro.type == 'fade' && intro.duration > 0 && time < intro.duration) {
    dim = math.max(dim, 1 - _clamp01(time / intro.duration));
  }

  final outro = plan.outro;
  if (outro != null && outro.type == 'fade' && outro.duration > 0 && plan.total > 0) {
    final from = plan.total - outro.duration;
    if (time > from) dim = math.max(dim, _clamp01((time - from) / outro.duration));
  }

  for (final dip in plan.dips) {
    if (dip.duration <= 0) continue;
    final half = dip.duration / 2;
    final distance = (time - dip.at).abs();
    if (distance < half) dim = math.max(dim, 1 - _clamp01(distance / half));
  }

  return _clamp01(dim);
}

/// A place where a transition can sit.
@immutable
class Boundary {
  const Boundary({
    required this.key,
    required this.kind,
    required this.at,
    required this.label,
    this.itemId,
  });

  final String key;
  final String kind; // 'intro' | 'between' | 'outro'
  final double at;
  final String label;
  final String? itemId;
}

/// The boundaries a sequence has: before the first item, between each pair, and
/// after the last. Empty for an empty sequence, since there is nothing to join.
List<Boundary> boundaries(List<Row> rows) {
  if (rows.isEmpty) return const [];
  final between = rows.skip(1).map((row) => Boundary(
        key: 'item:${row.item.id}',
        kind: 'between',
        itemId: row.item.id,
        at: row.start,
        label: 'Transition',
      ));
  return [
    const Boundary(key: 'intro', kind: 'intro', at: 0, label: 'Sequence start'),
    ...between,
    Boundary(key: 'outro', kind: 'outro', at: rows.last.end, label: 'Sequence end'),
  ];
}

/// Which transition kinds a given boundary can take.
List<String> kindsFor(Boundary boundary) =>
    boundary.kind == 'between' ? const ['none', 'dip'] : const ['none', 'fade'];

/// Gather what [dimAt] needs from the current sequence.
Plan plan(List<Row> rows, {Transition? intro, Transition? outro}) {
  final total = rows.isNotEmpty ? rows.last.end : 0.0;
  final dips = <Dip>[];
  for (final row in rows.skip(1)) {
    final set = row.item.transition;
    if (set != null && set.type == 'dip' && set.duration > 0) {
      dips.add(Dip(at: row.start, duration: set.duration));
    }
  }
  return Plan(total: total, intro: intro, outro: outro, dips: dips);
}

// NOTE on cross dissolve: it would need the outgoing and incoming items decoded
// at the same instant, and the items would overlap by its duration, so the
// sequence would get shorter as you added them. That is a change to layout(),
// to the render loop, and to playback, rather than another entry in `kinds`.
