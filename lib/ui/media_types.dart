// Which files the import dialog will let you pick.
//
// GTK matches filter patterns case-sensitively, and `file_selector_linux` hands
// each extension straight to `gtk_file_filter_add_pattern` as `*.ext`. So
// `*.mp4` does not match `VIDEO.MP4`, and cameras and phones very often shout:
// a folder full of footage straight off a device can be entirely invisible in
// the picker while looking, from the outside, like the dialog is broken.
//
// Turning every letter into a character class makes the pattern insensitive
// without having to enumerate the cases, which would miss `.Mp4` anyway.

import 'package:file_selector/file_selector.dart';

const List<String> videoExtensions = [
  'mp4', 'mov', 'mkv', 'webm', 'm4v', 'avi', 'mts', 'm2ts', 'mpg', 'mpeg', 'wmv',
];

const List<String> audioExtensions = [
  'mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'wma',
];

/// `mp4` becomes `[mM][pP]4`, which GTK then matches as `*.[mM][pP]4`.
String anyCase(String extension) {
  final buffer = StringBuffer();
  for (final rune in extension.runes) {
    final character = String.fromCharCode(rune);
    final lower = character.toLowerCase();
    final upper = character.toUpperCase();
    if (lower == upper) {
      buffer.write(character);
    } else {
      buffer..write('[')..write(lower)..write(upper)..write(']');
    }
  }
  return buffer.toString();
}

/// The groups offered in the import dialog.
///
/// "All files" is last and deliberately present. The list above is a guess at
/// what people have, and being unable to open a file because we did not think
/// of its extension is a worse failure than opening one we cannot decode: the
/// engine says exactly what it could not do with it, which is a better answer
/// than a picker that shows nothing.
List<XTypeGroup> importGroups() => [
      XTypeGroup(
        label: 'Video and audio',
        extensions: [
          for (final extension in [...videoExtensions, ...audioExtensions])
            anyCase(extension),
        ],
      ),
      XTypeGroup(
        label: 'Video',
        extensions: [for (final extension in videoExtensions) anyCase(extension)],
      ),
      XTypeGroup(
        label: 'Audio',
        extensions: [for (final extension in audioExtensions) anyCase(extension)],
      ),
      const XTypeGroup(label: 'All files', extensions: ['*']),
    ];
