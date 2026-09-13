// The sequence, drawn as a strip.
//
// Each item's width is its duration, so the strip is the sequence clock rather
// than a list that happens to be in order. Dragging reorders; the drop slot is
// worked out by `sequence.slotAt`, which is pure and tested, so what you see
// and what the model does cannot disagree.

import 'package:flutter/material.dart';

import '../core/sequence.dart' as seq;
import '../core/transitions.dart' as transitions;
import '../state/project.dart';

class Timeline extends StatelessWidget {
  const Timeline({
    super.key,
    required this.project,
    required this.playhead,
    required this.onScrub,
  });

  final Project project;
  final double playhead;
  final ValueChanged<double> onScrub;

  static const double height = 96;

  @override
  Widget build(BuildContext context) {
    final rows = project.rows;
    final total = project.duration;

    if (rows.isEmpty) {
      return const SizedBox(
        height: height,
        child: Center(
          child: Text('Mark a range and add it to build a sequence',
              style: TextStyle(color: Colors.white30)),
        ),
      );
    }

    return SizedBox(
      height: height,
      child: LayoutBuilder(
        builder: (context, constraints) {
          final width = constraints.maxWidth;
          final scale = total > 0 ? width / total : 0.0;

          return Stack(
            children: [
              // The strip itself.
              Row(
                children: [
                  for (final row in rows)
                    _Item(
                      row: row,
                      width: row.duration * scale,
                      project: project,
                      selected: project.selectedItemId == row.item.id,
                    ),
                ],
              ),

              // Scrubbing anywhere on the strip moves the playhead, so the
              // timeline is a control rather than only a picture.
              Positioned.fill(
                child: GestureDetector(
                  behavior: HitTestBehavior.translucent,
                  onTapDown: (details) =>
                      onScrub((details.localPosition.dx / scale).clamp(0, total)),
                  onHorizontalDragUpdate: (details) =>
                      onScrub((details.localPosition.dx / scale).clamp(0, total)),
                ),
              ),

              if (total > 0)
                Positioned(
                  left: (playhead * scale).clamp(0, width - 2),
                  top: 0,
                  bottom: 0,
                  width: 2,
                  child: const ColoredBox(color: Color(0xFFFF5D5D)),
                ),
            ],
          );
        },
      ),
    );
  }
}

class _Item extends StatelessWidget {
  const _Item({
    required this.row,
    required this.width,
    required this.project,
    required this.selected,
  });

  final seq.Row row;
  final double width;
  final Project project;
  final bool selected;

  @override
  Widget build(BuildContext context) {
    final source = project.sourceOf(row.item);
    final dip = row.item.transition?.type == 'dip';

    final body = Container(
      width: width,
      margin: const EdgeInsets.symmetric(horizontal: 1, vertical: 8),
      decoration: BoxDecoration(
        color: const Color(0xFF2A2E36),
        borderRadius: BorderRadius.circular(4),
        border: Border.all(
          color: selected ? const Color(0xFF6E9BFF) : Colors.transparent,
          width: 2,
        ),
      ),
      clipBehavior: Clip.antiAlias,
      child: Stack(
        fit: StackFit.expand,
        children: [
          if (source != null && source.tiles.isNotEmpty)
            Row(
              children: [
                for (final tile in source.tiles.take(4))
                  Expanded(child: RawImage(image: tile, fit: BoxFit.cover)),
              ],
            ),
          Container(color: Colors.black38),
          Padding(
            padding: const EdgeInsets.all(6),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  source?.name ?? 'missing source',
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w600),
                ),
                const Spacer(),
                Row(
                  children: [
                    Text('${row.duration.toStringAsFixed(2)}s',
                        style: const TextStyle(fontSize: 10, color: Colors.white70)),
                    if (row.item.rotate != 0) ...[
                      const SizedBox(width: 4),
                      Icon(Icons.rotate_90_degrees_ccw,
                          size: 11, color: Colors.white.withValues(alpha: 0.7)),
                    ],
                    if (row.item.muted) ...[
                      const SizedBox(width: 4),
                      Icon(Icons.volume_off,
                          size: 11, color: Colors.white.withValues(alpha: 0.7)),
                    ],
                    if (dip) ...[
                      const SizedBox(width: 4),
                      Icon(Icons.gradient,
                          size: 11, color: Colors.white.withValues(alpha: 0.7)),
                    ],
                  ],
                ),
              ],
            ),
          ),
        ],
      ),
    );

    return Draggable<int>(
      data: row.index,
      axis: Axis.horizontal,
      feedback: Opacity(
        opacity: 0.8,
        child: Material(color: Colors.transparent, child: SizedBox(width: width, height: 80, child: body)),
      ),
      childWhenDragging: Opacity(opacity: 0.3, child: body),
      child: DragTarget<int>(
        onWillAcceptWithDetails: (details) => details.data != row.index,
        // `to` is an index into the list *before* the move, which is what a drop
        // position naturally gives you, and what `sequence.move` expects.
        onAcceptWithDetails: (details) => project.moveItem(details.data, row.index),
        builder: (context, candidate, rejected) => Opacity(
          opacity: candidate.isEmpty ? 1 : 0.6,
          child: GestureDetector(
            onTap: () => project.selectItem(row.item.id),
            child: body,
          ),
        ),
      ),
    );
  }
}

/// The controls for whichever item is selected: the things that are per-item
/// rather than per-project.
class ItemInspector extends StatelessWidget {
  const ItemInspector({super.key, required this.project});

  final Project project;

  @override
  Widget build(BuildContext context) {
    final id = project.selectedItemId;
    seq.Item? item;
    for (final candidate in project.items) {
      if (candidate.id == id) item = candidate;
    }
    if (item == null) return const SizedBox.shrink();
    final selected = item;

    final index = project.items.indexOf(selected);
    final dip = selected.transition?.type == 'dip';

    return Container(
      color: const Color(0xFF1B1D22),
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      child: Row(
        children: [
          Text(project.sourceOf(selected)?.name ?? 'missing source',
              style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600)),
          const SizedBox(width: 16),

          IconButton(
            tooltip: 'Rotate',
            icon: const Icon(Icons.rotate_right, size: 18),
            onPressed: () => project.updateItem(
                selected.id,
                (i) => i.copyWith(rotate: (i.rotate + 90) % 360),
                'Rotate'),
          ),
          IconButton(
            tooltip: selected.muted ? 'Unmute' : 'Mute',
            icon: Icon(selected.muted ? Icons.volume_off : Icons.volume_up, size: 18),
            onPressed: () => project.updateItem(
                selected.id, (i) => i.copyWith(muted: !i.muted), 'Mute'),
          ),

          // A dip is only meaningful between two items. Before the first there
          // is nothing to dip from, which is what the intro fade is for.
          if (index > 0)
            TextButton.icon(
              icon: Icon(dip ? Icons.gradient : Icons.linear_scale, size: 16),
              label: Text(dip ? 'Dip to black' : 'Hard cut'),
              onPressed: () => project.updateItem(
                selected.id,
                (i) => i.copyWith(
                  transition: dip
                      ? const seq.Transition(type: 'none', duration: 0)
                      : const seq.Transition(
                          type: 'dip', duration: transitions.defaultDuration),
                ),
                dip ? 'Hard cut' : 'Dip to black',
              ),
            ),

          const Spacer(),
          TextButton.icon(
            icon: const Icon(Icons.delete_outline, size: 16),
            label: const Text('Remove'),
            onPressed: () => project.removeItem(selected.id),
          ),
        ],
      ),
    );
  }
}
