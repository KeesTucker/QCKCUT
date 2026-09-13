// The sequence model, kept pure and Flutter-free so it can be reasoned about
// and tested on its own.
//
// A timeline item is the same reference shape as a clip: a source, an in point
// and an out point. Its position is its index, not a stored start time. That is
// deliberate: there are no gaps to manage, no overlaps to resolve, and rippling
// after a trim or a delete is automatic rather than a pass over every later
// item.

import 'package:meta/meta.dart';

import 'frame.dart';

/// A transition attached to a cut. Declared here rather than in transitions.dart
/// because it is part of an item's own state, and putting it there would make
/// the two files import each other.
@immutable
class Transition {
  const Transition({required this.type, required this.duration});
  final String type;
  final double duration;
}

@immutable
class Item {
  const Item({
    required this.id,
    required this.sourceId,
    required this.inPoint,
    required this.outPoint,
    this.rotate = 0,
    this.frame,
    this.transition,
    this.gain = 1.0,
    this.muted = false,
  });

  final String id;
  final String sourceId;

  /// `in` and `out` are reserved words in Dart, hence the longer names. They are
  /// the same two numbers the original used and mean the same thing: seconds
  /// into the source.
  final double inPoint;
  final double outPoint;

  final int rotate;
  final Framing? frame;
  final Transition? transition;
  final double gain;
  final bool muted;

  Item copyWith({
    double? inPoint,
    double? outPoint,
    int? rotate,
    Framing? frame,
    Transition? transition,
    double? gain,
    bool? muted,
  }) =>
      Item(
        id: id,
        sourceId: sourceId,
        inPoint: inPoint ?? this.inPoint,
        outPoint: outPoint ?? this.outPoint,
        rotate: rotate ?? this.rotate,
        frame: frame ?? this.frame,
        transition: transition ?? this.transition,
        gain: gain ?? this.gain,
        muted: muted ?? this.muted,
      );

  double get duration => (outPoint - inPoint) < 0 ? 0 : outPoint - inPoint;
}

/// An item placed on the sequence clock.
@immutable
class Row {
  const Row({
    required this.item,
    required this.index,
    required this.start,
    required this.duration,
  });

  final Item item;
  final int index;
  final double start;
  final double duration;

  double get end => start + duration;
}

double itemDuration(Item item) => item.duration;

double totalDuration(List<Item> items) =>
    items.fold(0.0, (sum, item) => sum + item.duration);

/// Place every item on the sequence clock.
List<Row> layout(List<Item> items) {
  var start = 0.0;
  final rows = <Row>[];
  for (var index = 0; index < items.length; index++) {
    final item = items[index];
    final row = Row(item: item, index: index, start: start, duration: item.duration);
    rows.add(row);
    start = row.end;
  }
  return rows;
}

/// The row covering a sequence time, or null past the end.
Row? at(List<Row> rows, double time) {
  for (final row in rows) {
    if (time >= row.start && time < row.end) return row;
  }
  return null;
}

/// Where a sequence time falls inside its item's source.
double sourceTime(Row row, double time) => row.item.inPoint + (time - row.start);

/// Insert an item, clamping the index into range. Returns a new list.
List<Item> insert(List<Item> items, Item item, int index) {
  final next = List<Item>.from(items);
  next.insert(_clampIndex(index, next.length), item);
  return next;
}

/// Move the item at [from] so it lands before what is currently at [to].
///
/// [to] is an index into the list *before* the move, which is what a drop
/// position naturally gives you.
List<Item> move(List<Item> items, int from, int to) {
  if (from < 0 || from >= items.length) return items;
  final next = List<Item>.from(items);
  final moved = next.removeAt(from);
  next.insert(_clampIndex(from < to ? to - 1 : to, next.length), moved);
  return next;
}

List<Item> remove(List<Item> items, String id) =>
    items.where((item) => item.id != id).toList();

/// Which insertion slot a pointer sits in, given each rendered item's
/// horizontal bounds in the same coordinate space. Returns 0..bounds.length.
int slotAt(List<({double left, double right})> bounds, double x) {
  for (var i = 0; i < bounds.length; i++) {
    if (x < (bounds[i].left + bounds[i].right) / 2) return i;
  }
  return bounds.length;
}

int _clampIndex(int i, int max) => i < 0 ? 0 : (i > max ? max : i);
