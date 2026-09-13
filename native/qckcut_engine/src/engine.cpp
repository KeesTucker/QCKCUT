// The engine: the CUDA context, what this machine can actually do with it, and
// the thread-local error channel.

#include "internal.h"

#include <cstdarg>
#include <cstdio>
#include <cstring>

namespace qk {

namespace {
// Thread-local so a decode failing on a worker cannot overwrite the message a
// different worker is about to read.
thread_local std::string g_error = "";
}  // namespace

std::string av_message(int averr) {
  char buf[AV_ERROR_MAX_STRING_SIZE] = {0};
  av_strerror(averr, buf, sizeof(buf));
  return std::string(buf);
}

QkStatus fail(QkStatus status, const char* fmt, ...) {
  char buf[1024];
  va_list args;
  va_start(args, fmt);
  vsnprintf(buf, sizeof(buf), fmt, args);
  va_end(args);
  g_error = buf;
  return status;
}

QkStatus fail_av(QkStatus status, int averr, const char* fmt, ...) {
  char buf[1024];
  va_list args;
  va_start(args, fmt);
  vsnprintf(buf, sizeof(buf), fmt, args);
  va_end(args);
  g_error = std::string(buf) + ": " + av_message(averr);
  return status;
}

AVCodecID codec_id_of(QkCodec codec) {
  switch (codec) {
    case QK_CODEC_H264: return AV_CODEC_ID_H264;
    case QK_CODEC_HEVC: return AV_CODEC_ID_HEVC;
    case QK_CODEC_AV1: return AV_CODEC_ID_AV1;
    case QK_CODEC_VP9: return AV_CODEC_ID_VP9;
    case QK_CODEC_VP8: return AV_CODEC_ID_VP8;
    case QK_CODEC_MPEG4: return AV_CODEC_ID_MPEG4;
    default: return AV_CODEC_ID_NONE;
  }
}

const char* error_text() { return g_error.c_str(); }

}  // namespace qk

extern "C" {

const char* qk_last_error(void) { return qk::error_text(); }

const char* qk_version(void) { return "qckcut-engine 0.1.0"; }

QkEngine* qk_engine_create(void) {
  auto* engine = new QkEngine();

  // One CUDA context for the whole process. Decode and encode share it, which
  // is what lets an NVDEC surface be handed to NVENC without a round trip
  // through system memory.
  int err = av_hwdevice_ctx_create(&engine->hw_device, AV_HWDEVICE_TYPE_CUDA,
                                   nullptr, nullptr, 0);
  if (err < 0) {
    // Not fatal. Without a GPU we fall back to software decoding, which is slow
    // but correct, and the UI can say so rather than refusing to start.
    qk::fail_av(QK_ERR_DECODE, err, "CUDA unavailable, falling back to software");
    engine->cuda = false;
    engine->hw_device = nullptr;
    return engine;
  }

  engine->cuda = true;

  // NVML would give the marketing name, but linking it to read one string, and
  // taking a CUDA SDK dependency to do it, is not worth it for a label.
  engine->gpu = "NVIDIA (CUDA)";
  return engine;
}

void qk_engine_destroy(QkEngine* engine) {
  if (!engine) return;
  if (engine->hw_device) av_buffer_unref(&engine->hw_device);
  delete engine;
}

int qk_engine_has_cuda(const QkEngine* engine) {
  return engine && engine->cuda ? 1 : 0;
}

const char* qk_engine_gpu_name(const QkEngine* engine) {
  return engine ? engine->gpu.c_str() : "";
}

// ─── What this machine can do ────────────────────────────────────────────────
// Asked of the driver rather than answered from a table. NVDEC's codec set
// moves with the GPU generation: Blackwell decodes AV1, Pascal does not, and a
// hardcoded list would be wrong on half the machines it ran on.

int qk_can_decode(QkEngine* engine, QkCodec codec) {
  AVCodecID id = qk::codec_id_of(codec);
  if (id == AV_CODEC_ID_NONE) return 0;

  if (engine && engine->cuda) {
    // The cuvid decoders are the NVDEC entry points; finding one by name is the
    // cheapest honest test short of opening a session.
    static const char* names[QK_CODEC_COUNT] = {
        "h264_cuvid", "hevc_cuvid", "av1_cuvid", "vp9_cuvid", "vp8_cuvid", "mpeg4_cuvid"};
    if (codec >= 0 && codec < QK_CODEC_COUNT && avcodec_find_decoder_by_name(names[codec])) {
      return 1;
    }
  }
  // Software still counts as "can decode"; the caller asks separately whether it
  // will be hardware.
  return avcodec_find_decoder(id) != nullptr ? 1 : 0;
}

int qk_can_encode(QkEngine* engine, QkCodec codec) {
  static const char* names[QK_CODEC_COUNT] = {
      "h264_nvenc", "hevc_nvenc", "av1_nvenc", nullptr, nullptr, nullptr};
  if (codec < 0 || codec >= QK_CODEC_COUNT || !names[codec]) return 0;
  if (!engine || !engine->cuda) return 0;
  return avcodec_find_encoder_by_name(names[codec]) != nullptr ? 1 : 0;
}

const char* qk_codec_label(QkCodec codec) {
  switch (codec) {
    case QK_CODEC_H264: return "H.264";
    case QK_CODEC_HEVC: return "HEVC / H.265";
    case QK_CODEC_AV1: return "AV1";
    case QK_CODEC_VP9: return "VP9";
    case QK_CODEC_VP8: return "VP8";
    case QK_CODEC_MPEG4: return "MPEG-4";
    default: return "unknown";
  }
}

void qk_cancel(QkEngine* engine) {
  if (engine) engine->cancelled.store(true);
}

void qk_uncancel(QkEngine* engine) {
  if (engine) engine->cancelled.store(false);
}

}  // extern "C"
