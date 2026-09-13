// Exercises the sequence render: several items from one or more sources, laid
// out end to end, with a dip between them and fades at each end.
//
//   ./qk_seq out.mp4 a.mp4 [b.mp4 ...]

#include "qckcut_engine.h"

#include <cstdio>
#include <cstdlib>
#include <vector>

static int last_phase = -1;

static void on_progress(double fraction, int32_t phase, void* user) {
  (void)user;
  if (phase != last_phase) {
    printf("\n  %s ", phase == QK_PHASE_VIDEO ? "video" : "audio");
    last_phase = phase;
  }
  printf("\r  %s %5.1f%%", phase == QK_PHASE_VIDEO ? "video" : "audio", fraction * 100);
  fflush(stdout);
}

int main(int argc, char** argv) {
  if (argc < 3) {
    fprintf(stderr, "usage: qk_seq <output.mp4> <input> [input ...]\n");
    return 2;
  }

  QkEngine* engine = qk_engine_create();
  printf("CUDA: %s\n", qk_engine_has_cuda(engine) ? "yes" : "no");

  // Three items per input, each a different second, so the cuts are visible and
  // the layout is obviously end to end.
  std::vector<QkSequenceItem> items;
  for (int i = 2; i < argc; i++) {
    for (int k = 0; k < 3; k++) {
      QkSequenceItem item = {};
      item.path = argv[i];
      item.in_point = 0.5 + k * 1.5;
      item.out_point = item.in_point + 1.0;
      item.gain = 1.0;
      item.rotate = (k == 1) ? 90 : 0;          // one turned item, to exercise the transpose
      item.has_frame = (k == 2) ? 1 : 0;        // one reframed item, to exercise the crop
      item.zoom = 1.6;
      item.frame_x = 0.5;
      item.frame_y = 0.5;
      item.dip_duration = (k == 1) ? 0.4 : 0.0; // one dip, to exercise the darkening
      items.push_back(item);
    }
  }

  QkOutputSettings settings = {};
  settings.width = 1280;
  settings.height = 720;
  settings.fps = 30;
  settings.codec = QK_CODEC_H264;
  settings.fit = 0;  // contain

  printf("%zu items, %.1fs total, into 1280x720 at 30fps\n", items.size(),
         items.size() * 1.0);

  QkStatus status = qk_export_sequence(engine, items.data(),
                                       static_cast<int32_t>(items.size()), argv[1],
                                       &settings, 0.5, 0.5, on_progress, nullptr);
  printf("\n");
  if (status != QK_OK) {
    fprintf(stderr, "sequence failed (%d): %s\n", status, qk_last_error());
    qk_engine_destroy(engine);
    return 1;
  }
  printf("wrote %s\n", argv[1]);
  qk_engine_destroy(engine);
  return 0;
}
