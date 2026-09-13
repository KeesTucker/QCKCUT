// The import filter patterns.
//
// Worth testing because the failure is invisible: a wrong pattern does not
// error, it just shows an empty folder, which reads as a broken dialog rather
// than as a bad filter.

import 'package:flutter_test/flutter_test.dart';
import 'package:qckcut/ui/media_types.dart';

/// What GTK is actually handed, since file_selector_linux prepends the glob.
String pattern(String extension) => '*.${anyCase(extension)}';

/// fnmatch as GTK applies it, enough for the character classes used here.
bool matches(String glob, String name) {
  final buffer = StringBuffer('^');
  var i = 0;
  while (i < glob.length) {
    final character = glob[i];
    if (character == '*') {
      buffer.write('.*');
    } else if (character == '[') {
      final close = glob.indexOf(']', i);
      buffer.write(glob.substring(i, close + 1));
      i = close;
    } else if ('.\\+?()|{}^\$'.contains(character)) {
      buffer..write('\\')..write(character);
    } else {
      buffer.write(character);
    }
    i++;
  }
  buffer.write(r'$');
  return RegExp(buffer.toString()).hasMatch(name);
}

void main() {
  test('a letter becomes a case class and a digit is left alone', () {
    expect(anyCase('mp4'), '[mM][pP]4');
    expect(anyCase('m2ts'), '[mM]2[tT][sS]');
  });

  // The actual reported failure: twelve files straight off a camera, every one
  // of them shouting, and none of them selectable.
  test('matches an extension however it is cased', () {
    final glob = pattern('mp4');
    for (final name in ['clip.mp4', 'CLIP.MP4', 'Clip.Mp4', 'clip.mP4']) {
      expect(matches(glob, name), isTrue, reason: '$glob should match $name');
    }
  });

  test('does not match a different extension', () {
    final glob = pattern('mp4');
    for (final name in ['clip.mov', 'clip.mp3', 'clip.mp', 'mp4']) {
      expect(matches(glob, name), isFalse, reason: '$glob should not match $name');
    }
  });

  test('every offered extension survives the round trip', () {
    for (final extension in [...videoExtensions, ...audioExtensions]) {
      final glob = pattern(extension);
      expect(matches(glob, 'a.$extension'), isTrue, reason: extension);
      expect(matches(glob, 'a.${extension.toUpperCase()}'), isTrue,
          reason: extension.toUpperCase());
    }
  });

  test('the groups include an escape hatch, last', () {
    final groups = importGroups();
    expect(groups.last.label, 'All files');
    expect(groups.first.extensions, isNotEmpty);
  });
}
