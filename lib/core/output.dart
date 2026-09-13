// What the project is being cut *for*.
//
// Nulls mean "match the source", which is the default and what most exports
// want. The shape matters beyond the file size: a crop always matches the
// output's aspect ratio, so changing the output shape changes what every
// framed item shows. That is the whole point of reframing 16:9 footage into
// 9:16, and it is why this lives in core beside `frame.dart` rather than in a
// settings dialog's state.

import 'package:meta/meta.dart';

/// How an item that does not match the output's shape is fitted into it.
enum Fit {
  /// Letterbox. The whole picture, with black where it does not reach.
  contain,

  /// Fill the frame and lose the overflow.
  cover,

  /// Stretch. The only way to produce a squashed picture, and here only
  /// because sometimes that is genuinely what is wanted.
  fill;

  String get label => switch (this) {
        Fit.contain => 'Letterbox',
        Fit.cover => 'Fill and crop',
        Fit.fill => 'Stretch',
      };
}

@immutable
class OutputShape {
  const OutputShape({this.width, this.height, this.fps, this.fit = Fit.contain});

  /// Null for both means match the first item that has pictures.
  final int? width;
  final int? height;

  /// Null means keep the source's own rate.
  final double? fps;

  final Fit fit;

  bool get matchesSource => width == null || height == null;

  double? get aspect =>
      (width != null && height != null && height! > 0) ? width! / height! : null;

  OutputShape copyWith({
    int? width,
    int? height,
    double? fps,
    Fit? fit,
    bool clearSize = false,
    bool clearFps = false,
  }) =>
      OutputShape(
        width: clearSize ? null : (width ?? this.width),
        height: clearSize ? null : (height ?? this.height),
        fps: clearFps ? null : (fps ?? this.fps),
        fit: fit ?? this.fit,
      );

  String get label {
    if (matchesSource) return 'Match source';
    return '$width x $height';
  }
}

/// The shapes worth one click.
///
/// Vertical is first among the fixed sizes on purpose: turning landscape
/// footage into something that fills a phone is the job this tool exists for,
/// and it is the one that cannot be done by simply exporting what you shot.
@immutable
class ShapePreset {
  const ShapePreset(this.name, this.width, this.height);
  final String name;
  final int? width;
  final int? height;

  static const presets = <ShapePreset>[
    ShapePreset('Match source', null, null),
    ShapePreset('Vertical 1080x1920', 1080, 1920),
    ShapePreset('Square 1080x1080', 1080, 1080),
    ShapePreset('1080p', 1920, 1080),
    ShapePreset('1440p', 2560, 1440),
    ShapePreset('4K', 3840, 2160),
  ];

  bool matches(OutputShape shape) => shape.width == width && shape.height == height;
}
