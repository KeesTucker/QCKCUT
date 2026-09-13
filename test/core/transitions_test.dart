import 'package:flutter_test/flutter_test.dart';
import 'package:qckcut/core/sequence.dart';
import 'package:qckcut/core/transitions.dart';

Item item(String id, double length, {Transition? transition}) =>
    Item(id: id, sourceId: 's', inPoint: 0, outPoint: length, transition: transition);

void main() {
  group('dimAt', () {
    test('an intro fade starts black and clears', () {
      const plan = Plan(total: 10, intro: Transition(type: 'fade', duration: 1));
      expect(dimAt(0, plan), 1);
      expect(dimAt(0.5, plan), closeTo(0.5, 1e-9));
      expect(dimAt(1, plan), 0);
    });

    test('an outro fade ends black', () {
      const plan = Plan(total: 10, outro: Transition(type: 'fade', duration: 1));
      expect(dimAt(9, plan), 0);
      expect(dimAt(10, plan), 1);
    });

    // Half from each side is what keeps the sequence its original length.
    test('a dip takes half its duration from each side of the cut', () {
      const plan = Plan(total: 10, dips: [Dip(at: 5, duration: 1)]);
      expect(dimAt(5, plan), 1);
      expect(dimAt(4.75, plan), closeTo(0.5, 1e-9));
      expect(dimAt(5.25, plan), closeTo(0.5, 1e-9));
      expect(dimAt(4.5, plan), 0);
    });

    test('overlapping darkenings take the strongest rather than summing', () {
      const plan = Plan(
        total: 2,
        intro: Transition(type: 'fade', duration: 2),
        dips: [Dip(at: 0, duration: 2)],
      );
      expect(dimAt(0, plan), 1);
    });

    test('is zero with nothing set', () {
      expect(dimAt(3, const Plan(total: 10)), 0);
    });
  });

  group('boundaries', () {
    test('an empty sequence has none, since there is nothing to join', () {
      expect(boundaries(const []), isEmpty);
    });

    test('one item still has a start and an end', () {
      final rows = layout([item('a', 2)]);
      expect(boundaries(rows).map((b) => b.kind), ['intro', 'outro']);
    });

    test('each pair of items gets a boundary between them', () {
      final rows = layout([item('a', 2), item('b', 2), item('c', 2)]);
      final kinds = boundaries(rows).map((b) => b.kind).toList();
      expect(kinds, ['intro', 'between', 'between', 'outro']);
      expect(boundaries(rows)[1].at, 2);
    });

    test('the ends take fades and the cuts take dips', () {
      final rows = layout([item('a', 2), item('b', 2)]);
      final all = boundaries(rows);
      expect(kindsFor(all.first), ['none', 'fade']);
      expect(kindsFor(all[1]), ['none', 'dip']);
    });
  });

  group('plan', () {
    test('gathers dips from the items that carry them', () {
      final rows = layout([
        item('a', 2),
        item('b', 2, transition: const Transition(type: 'dip', duration: 0.6)),
      ]);
      final p = plan(rows);
      expect(p.total, 4);
      expect(p.dips.single.at, 2);
      expect(p.dips.single.duration, 0.6);
    });

    test('ignores a transition set to none', () {
      final rows = layout([
        item('a', 2),
        item('b', 2, transition: const Transition(type: 'none', duration: 0)),
      ]);
      expect(plan(rows).dips, isEmpty);
    });
  });
}
