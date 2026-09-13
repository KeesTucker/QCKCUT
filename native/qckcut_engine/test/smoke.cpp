// A standalone exercise of the engine, so the pipeline can be proved without
// starting Flutter. Run it against any file:
//
//   ./qk_smoke input.mp4 /tmp/out.mp4
//
// It reports what the machine can do, decodes a frame from the middle, and
// exports a two second range through NVENC.

#include "qckcut_engine.h"

#include <cstdio>
#include <cstdlib>
#include <vector>

static void on_progress(double fraction, int32_t phase, void* user) {
  (void)user;
  printf("\r  %s %5.1f%%", phase == QK_PHASE_VIDEO ? "video" : "audio", fraction * 100);
  fflush(stdout);
}

int main(int argc, char** argv) {
  if (argc < 3) {
    fprintf(stderr, "usage: qk_smoke <input> <output.mp4>\n");
    return 2;
  }

  printf("%s\n", qk_version());

  QkEngine* engine = qk_engine_create();
  if (!engine) { fprintf(stderr, "no engine\n"); return 1; }

  printf("CUDA: %s (%s)\n", qk_engine_has_cuda(engine) ? "yes" : "no",
         qk_engine_gpu_name(engine));

  printf("decode:");
  for (int c = 0; c < QK_CODEC_COUNT; c++) {
    if (qk_can_decode(engine, static_cast<QkCodec>(c))) {
      printf(" %s", qk_codec_label(static_cast<QkCodec>(c)));
    }
  }
  printf("\nencode:");
  for (int c = 0; c < QK_CODEC_COUNT; c++) {
    if (qk_can_encode(engine, static_cast<QkCodec>(c))) {
      printf(" %s", qk_codec_label(static_cast<QkCodec>(c)));
    }
  }
  printf("\n\n");

  QkSource* source = qk_source_open(engine, argv[1]);
  if (!source) {
    fprintf(stderr, "open failed: %s\n", qk_last_error());
    return 1;
  }

  QkSourceInfo info;
  qk_source_info(source, &info);
  printf("%s\n", argv[1]);
  printf("  %.3fs  %dx%d  rot %d  %s%s\n", info.duration, info.width, info.height,
         info.rotation, info.video_codec ? info.video_codec : "(no video)",
         info.hw_decoded ? "  [NVDEC]" : "  [software]");
  if (info.has_audio) {
    printf("  audio: %s  %d Hz  %d ch\n", info.audio_codec, info.sample_rate, info.channels);
  }

  // A frame from the middle, written as a PPM so it can be eyeballed.
  const int w = 320, h = 180;
  std::vector<uint8_t> rgba(static_cast<size_t>(w) * h * 4);
  if (info.has_video) {
    const double at = info.duration / 2;
    QkStatus status = qk_source_frame_at(source, at, rgba.data(), w, h);
    if (status != QK_OK) {
      fprintf(stderr, "frame_at(%.3f) failed: %s\n", at, qk_last_error());
    } else {
      FILE* ppm = fopen("/tmp/qk_frame.ppm", "wb");
      if (ppm) {
        fprintf(ppm, "P6\n%d %d\n255\n", w, h);
        for (size_t i = 0; i < rgba.size(); i += 4) fwrite(&rgba[i], 1, 3, ppm);
        fclose(ppm);
        printf("  frame at %.3fs -> /tmp/qk_frame.ppm\n", at);
      }
    }

    // Thumbnails, the filmstrip path.
    const int tiles = 8;
    const int tw = qk_thumb_width(source);
    std::vector<uint8_t> strip(static_cast<size_t>(tiles) * tw * QK_THUMB_H * 4);
    if (qk_source_thumbnails(source, tiles, strip.data(), tw) == QK_OK) {
      printf("  %d thumbnails at %dx%d\n", tiles, tw, QK_THUMB_H);
    } else {
      fprintf(stderr, "  thumbnails failed: %s\n", qk_last_error());
    }
  }

  if (info.has_audio) {
    std::vector<float> pcm(48000 * 2);
    int64_t got = qk_source_audio(source, 0.0, 1.0, pcm.data(), 48000);
    printf("  audio: %lld frames for the first second\n", static_cast<long long>(got));
  }

  qk_source_close(source);

  // Export a range. Asking for a different codec forces the NVENC path rather
  // than the remux shortcut, which is the half worth proving.
  const double start = 0.5;
  const double end = start + 2.0 < info.duration ? start + 2.0 : info.duration;

  QkOutputSettings settings = {};
  settings.codec = QK_CODEC_HEVC;
  settings.fit = 0;

  printf("\nexport [%.2f, %.2f) through NVENC:\n", start, end);
  QkStatus status = qk_export_clip(engine, argv[1], argv[2], start, end, &settings,
                                   on_progress, nullptr);
  printf("\n");
  if (status != QK_OK) {
    fprintf(stderr, "export failed (%d): %s\n", status, qk_last_error());
    qk_engine_destroy(engine);
    return 1;
  }
  printf("wrote %s\n", argv[2]);

  qk_engine_destroy(engine);
  return 0;
}
