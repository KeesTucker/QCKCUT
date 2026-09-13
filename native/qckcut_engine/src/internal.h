// Shared internals. Not part of the public surface; Dart never sees this.
#ifndef QCKCUT_INTERNAL_H
#define QCKCUT_INTERNAL_H

#include "qckcut_engine.h"

#include <atomic>
#include <string>

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/hwcontext.h>
#include <libavutil/display.h>
#include <libavutil/imgutils.h>
#include <libavutil/opt.h>
#include <libswresample/swresample.h>
#include <libswscale/swscale.h>
}

namespace qk {

// The mixer's rate, matching the original's AUDIO_RATE/AUDIO_CHANNELS. Sources
// that disagree are resampled to this so they line up on one timeline.
constexpr int kAudioRate = 48000;
constexpr int kAudioChannels = 2;

/** Record a failure for `qk_last_error`, and hand back the status for return. */
QkStatus fail(QkStatus status, const char* fmt, ...);

/** Same, but appending FFmpeg's own words for an AVERROR. */
QkStatus fail_av(QkStatus status, int averr, const char* fmt, ...);

/** FFmpeg's message for an error code, as a std::string. */
std::string av_message(int averr);

AVCodecID codec_id_of(QkCodec codec);

}  // namespace qk

struct QkEngine {
  AVBufferRef* hw_device = nullptr;   // the shared CUDA context
  bool cuda = false;
  std::string gpu;
  std::atomic<bool> cancelled{false};
};

struct QkSource {
  QkEngine* engine = nullptr;
  std::string path;

  AVFormatContext* format = nullptr;

  // Video
  int video_index = -1;
  AVCodecContext* video = nullptr;
  bool hw = false;                    // decoding through NVDEC
  AVFrame* hw_frame = nullptr;        // the GPU-side frame, reused
  AVFrame* frame = nullptr;           // the CPU-side frame, reused
  AVPacket* packet = nullptr;
  SwsContext* scaler = nullptr;
  int scaler_w = 0, scaler_h = 0;     // what the scaler is currently set up for
  AVPixelFormat scaler_in = AV_PIX_FMT_NONE;
  int rotation = 0;

  // Audio
  int audio_index = -1;
  AVCodecContext* audio = nullptr;
  SwrContext* resampler = nullptr;

  std::string video_codec_name;
  std::string audio_codec_name;

  double duration = 0;
  double last_pts = -1;               // where the decoder currently sits
};

#endif  // QCKCUT_INTERNAL_H
