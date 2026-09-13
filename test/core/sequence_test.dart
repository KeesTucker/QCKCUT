// The sequence model's own tests. Pure, so they need neither a decoder nor a
// window, which is the point of having kept it pure.

import 'package:flutter_test/flutter_test.dart';
import 'package:qckcut/core/sequence.dart';

Item item(String id, double inPoint, double outPoint) =>
    Item(id: id, sourceId: 's', inPoint: inPoint, outPoint: outPoint);

void main() {
  group('duration', () {
    test('is out minus in', () {
      expect(item('a', 1, 4).duration, 3);
    });

    test('never goes negative', () {
      expect(item('a', 4, 1).duration, 0);
    });

    test('totals across items', () {
      expect(totalDuration([item('a', 0, 2), item('b', 5, 8)]), 5);
    });
  });

  group('layout', () {
    test('places items end to end with no gaps', () {
      final rows = layout([item('a', 0, 2), item('b', 10, 13), item('c', 0, 1)]);
      expect(rows.map((r) => r.start), [0, 2, 5]);
      expect(rows.map((r) => r.end), [2, 5, 6]);
    });

    test('an empty sequence lays out to nothing', () {
      expect(layout([]), isEmpty);
    });

    // Position is the index, not a stored time, so a trim ripples without any
    // pass over the later items.
    test('ripples automatically after a trim', () {
      final items = [item('a', 0, 2), item('b', 0, 3)];
      final trimmed = [items[0].copyWith(outPoint: 1), items[1]];
      expect(layout(trimmed).last.start, 1);
    });
  });

  group('at', () {
    final rows = layout([item('a', 0, 2), item('b', 0, 3)]);

    test('finds the row covering a time', () {
      expect(at(rows, 0)!.item.id, 'a');
      expect(at(rows, 1.99)!.item.id, 'a');
      expect(at(rows, 2)!.item.id, 'b');
    });

    test('is null past the end', () {
      expect(at(rows, 5), isNull);
      expect(at(rows, 99), isNull);
    });

    test('maps a sequence time back into the source', () {
      final row = layout([item('a', 10, 12)]).first;
      expect(sourceTime(row, 0.5), 10.5);
    });
  });

  group('move', () {
    final items = [item('a', 0, 1), item('b', 0, 1), item('c', 0, 1)];

    test('moves forwards, accounting for the gap the item leaves', () {
      expect(move(items, 0, 2).map((i) => i.id), ['b', 'a', 'c']);
    });

    test('moves backwards', () {
      expect(move(items, 2, 0).map((i) => i.id), ['c', 'a', 'b']);
    });

    test('ignores an index that is not there', () {
      expect(move(items, 9, 0), same(items));
    });
  });

  group('insert and remove', () {
    test('clamps an out of range index', () {
      final items = [item('a', 0, 1)];
      expect(insert(items, item('b', 0, 1), 99).map((i) => i.id), ['a', 'b']);
      expect(insert(items, item('b', 0, 1), -5).map((i) => i.id), ['b', 'a']);
    });

    test('removes by id', () {
      final items = [item('a', 0, 1), item('b', 0, 1)];
      expect(remove(items, 'a').map((i) => i.id), ['b']);
    });
  });

  group('slotAt', () {
    final bounds = [
      (left: 0.0, right: 100.0),
      (left: 100.0, right: 200.0),
    ];

    test('picks the slot by the midpoint of each item', () {
      expect(slotAt(bounds, 10), 0);
      expect(slotAt(bounds, 60), 1);
      expect(slotAt(bounds, 190), 2);
    });
  });
}
