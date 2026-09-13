// What the project is being cut for.
//
// Small, and deliberately so: a shape, a rate and a codec. Everything else the
// engine can work out from the footage, and a setting that only ever takes its
// default is a setting worth not having.

import 'package:flutter/material.dart';

import '../core/output.dart';
import '../engine/bindings.dart' show QkCodec;
import '../engine/engine.dart';

class OutputSettingsDialog extends StatefulWidget {
  const OutputSettingsDialog({
    super.key,
    required this.shape,
    required this.codec,
    required this.engine,
  });

  final OutputShape shape;
  final int codec;
  final MediaEngine engine;

  @override
  State<OutputSettingsDialog> createState() => _OutputSettingsDialogState();
}

class _OutputSettingsDialogState extends State<OutputSettingsDialog> {
  late OutputShape _shape = widget.shape;
  late int _codec = widget.codec;

  static const _codecs = [
    (QkCodec.h264, 'H.264', 'Plays everywhere. The safe answer.'),
    (QkCodec.hevc, 'HEVC / H.265', 'Smaller files, less universal.'),
    (QkCodec.av1, 'AV1', 'Smallest, newest, slowest to decode elsewhere.'),
  ];

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    // Asked of the machine rather than listed from a table: NVENC's codec set
    // moves with the GPU generation.
    final available = widget.engine.encodable;

    return AlertDialog(
      title: const Text('Output'),
      content: SizedBox(
        width: 460,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Shape', style: theme.textTheme.labelLarge),
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final preset in ShapePreset.presets)
                  ChoiceChip(
                    label: Text(preset.name),
                    selected: preset.matches(_shape),
                    onSelected: (_) => setState(() => _shape = preset.width == null
                        ? _shape.copyWith(clearSize: true)
                        : _shape.copyWith(
                            width: preset.width, height: preset.height)),
                  ),
              ],
            ),
            const SizedBox(height: 20),

            Text('Fitting', style: theme.textTheme.labelLarge),
            const SizedBox(height: 4),
            Text(
              'What happens to an item that is not the output\'s shape and has '
              'no framing of its own.',
              style: theme.textTheme.bodySmall?.copyWith(color: Colors.white54),
            ),
            const SizedBox(height: 8),
            SegmentedButton<Fit>(
              segments: [
                for (final fit in Fit.values)
                  ButtonSegment(value: fit, label: Text(fit.label)),
              ],
              selected: {_shape.fit},
              onSelectionChanged: (selection) =>
                  setState(() => _shape = _shape.copyWith(fit: selection.first)),
            ),
            const SizedBox(height: 20),

            Text('Frame rate', style: theme.textTheme.labelLarge),
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              children: [
                ChoiceChip(
                  label: const Text('Match source'),
                  selected: _shape.fps == null,
                  onSelected: (_) =>
                      setState(() => _shape = _shape.copyWith(clearFps: true)),
                ),
                for (final rate in [24.0, 25.0, 30.0, 60.0])
                  ChoiceChip(
                    label: Text(rate.toStringAsFixed(0)),
                    selected: _shape.fps == rate,
                    onSelected: (_) =>
                        setState(() => _shape = _shape.copyWith(fps: rate)),
                  ),
              ],
            ),
            const SizedBox(height: 20),

            Text('Codec', style: theme.textTheme.labelLarge),
            const SizedBox(height: 8),
            RadioGroup<int>(
              groupValue: _codec,
              onChanged: (picked) => setState(() => _codec = picked ?? _codec),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  for (final (value, name, note) in _codecs)
                    RadioListTile<int>(
                      dense: true,
                      contentPadding: EdgeInsets.zero,
                      value: value,
                      // An encoder this machine does not have would fail at the
                      // end of an export rather than at the start, so it is not
                      // offered at all.
                      enabled: available.contains(name),
                      title: Text(name),
                      subtitle: Text(
                        available.contains(name)
                            ? note
                            : 'Not available on this machine',
                        style: theme.textTheme.bodySmall,
                      ),
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: () => Navigator.of(context).pop((_shape, _codec)),
          child: const Text('Done'),
        ),
      ],
    );
  }
}
