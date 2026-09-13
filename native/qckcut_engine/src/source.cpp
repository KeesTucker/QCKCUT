// Opening a file and reading pictures and sound out of it.
//
// The decoder is kept open and warm between calls, because scrubbing is the
// thing this app does most: the original kept a pool of at most four open
// decoders for exactly this reason, and here the pool lives on the Dart side
// while each QkSource is one warm decoder.

#include "internal.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <vector>

namespace {

/**
 * Pick the CUDA surface format when the decoder offers it.
 *
 * FFmpeg calls this during avcodec_open2 and again if the stream's format
 * changes. Returning AV_PIX_FMT_CUDA is what actually commits the stream to
 * NVDEC; returning anything else silently drops to software, which is the usual
 * reason a "hardware" pipeline turns out not to be one.
 */
AVPixelFormat pick_hw_format(AVCodecContext* ctx, const AVPixelFormat* formats) {
  (void)ctx;
  for (const AVPixelFormat* p = formats; *p != AV_PIX_FMT_NONE; p++) {
    if (*p == AV_PIX_FMT_CUDA) return *p;
  }
  // No CUDA surface on offer: let FFmpeg have its first choice rather than
  // failing the open. A software decode is slow, not wrong.
  return formats[0];
}

/** The container's display rotation, in the 0/90/180/270 the UI thinks in. */
int rotation_of(const AVStream* stream) {
  const AVPacketSideData* side = av_packet_side_data_get(
      stream->codecpar->coded_side_data, stream->codecpar->nb_coded_side_data,
      AV_PKT_DATA_DISPLAYMATRIX);
  if (!side) return 0;
  double theta = av_display_rotation_get(reinterpret_cast<const int32_t*>(side->data));
  if (std::isnan(theta)) return 0;
  // av_display_rotation_get measures anticlockwise; the UI counts clockwise.
  int degrees = static_cast<int>(std::lround(-theta));
  degrees = ((degrees % 360) + 360) % 360;
  // Snap to the quarter turns the framing model supports.
  if (degrees > 315 || degrees <= 45) return 0;
  if (degrees <= 135) return 90;
  if (degrees <= 225) return 180;
  return 270;
}

/** Open one decoder, through NVDEC when the engine and the codec allow it. */
AVCodecContext* open_decoder(QkEngine* engine, AVStream* stream, bool want_hw, bool* got_hw) {
  const AVCodec* codec = avcodec_find_decoder(stream->codecpar->codec_id);
  if (!codec) return nullptr;

  AVCodecContext* ctx = avcodec_alloc_context3(codec);
  if (!ctx) return nullptr;
  if (avcodec_parameters_to_context(ctx, stream->codecpar) < 0) {
    avcodec_free_context(&ctx);
    return nullptr;
  }
  ctx->pkt_timebase = stream->time_base;

  if (want_hw && engine && engine->cuda) {
    ctx->hw_device_ctx = av_buffer_ref(engine->hw_device);
    ctx->get_format = pick_hw_format;
  }

  // Decoding is the hot path and frames are independent enough for FFmpeg to
  // thread them; on a software fallback this is the difference between usable
  // and not.
  ctx->thread_count = 0;

  if (avcodec_open2(ctx, codec, nullptr) < 0) {
    avcodec_free_context(&ctx);
    return nullptr;
  }
  // Deliberately not reported as hardware yet. Opening with a CUDA device only
  // says we asked; FFmpeg falls back to software without complaining, so the
  // claim is not made until a frame actually arrives on a CUDA surface.
  if (got_hw) *got_hw = false;
  return ctx;
}

/**
 * Bring a decoded frame down to RGBA at the requested size, letterboxed.
 *
 * A hardware frame lands in `AV_PIX_FMT_CUDA` and has to be transferred before
 * swscale can touch it. That copy is the one unavoidable cost of showing a
 * frame in a Flutter pixel-buffer texture; the GL-interop path that skips it is
 * a later optimisation and is why the transfer is isolated here.
 */
bool to_rgba(QkSource* src, AVFrame* decoded, uint8_t* out, int out_w, int out_h) {
  if (out_w <= 0 || out_h <= 0) return false;

  // A CUDA surface here is the proof that NVDEC carried this frame.
  src->hw = decoded->format == AV_PIX_FMT_CUDA;

  AVFrame* picture = decoded;
  if (decoded->format == AV_PIX_FMT_CUDA) {
    av_frame_unref(src->frame);
    if (av_hwframe_transfer_data(src->frame, decoded, 0) < 0) return false;
    src->frame->pts = decoded->pts;
    picture = src->frame;
  }

  auto in_fmt = static_cast<AVPixelFormat>(picture->format);

  // The picture keeps its shape inside the output, which is the `contain` fit
  // the original letterboxed with. Anything not covered stays black.
  const double scale = std::min(static_cast<double>(out_w) / picture->width,
                                static_cast<double>(out_h) / picture->height);
  int dst_w = std::max(2, static_cast<int>(std::lround(picture->width * scale)) & ~1);
  int dst_h = std::max(2, static_cast<int>(std::lround(picture->height * scale)) & ~1);
  dst_w = std::min(dst_w, out_w);
  dst_h = std::min(dst_h, out_h);

  if (!src->scaler || src->scaler_w != dst_w || src->scaler_h != dst_h ||
      src->scaler_in != in_fmt) {
    sws_freeContext(src->scaler);
    src->scaler = sws_getContext(picture->width, picture->height, in_fmt,
                                 dst_w, dst_h, AV_PIX_FMT_RGBA,
                                 SWS_BILINEAR, nullptr, nullptr, nullptr);
    src->scaler_w = dst_w;
    src->scaler_h = dst_h;
    src->scaler_in = in_fmt;
  }
  if (!src->scaler) return false;

  std::memset(out, 0, static_cast<size_t>(out_w) * out_h * 4);

  // Scale straight into the middle of the caller's buffer by offsetting the
  // destination pointer, rather than scaling to a scratch buffer and blitting.
  const int x = (out_w - dst_w) / 2;
  const int y = (out_h - dst_h) / 2;
  uint8_t* dst_data[4] = {out + (static_cast<size_t>(y) * out_w + x) * 4, nullptr, nullptr, nullptr};
  int dst_stride[4] = {out_w * 4, 0, 0, 0};

  sws_scale(src->scaler, picture->data, picture->linesize, 0, picture->height,
            dst_data, dst_stride);
  return true;
}

/** Seconds for a frame's pts on a stream's timebase. */
double seconds_of(const AVFrame* frame, AVRational tb) {
  if (frame->pts == AV_NOPTS_VALUE) return -1;
  return frame->pts * av_q2d(tb);
}

}  // namespace

extern "C" {

QkSource* qk_source_open(QkEngine* engine, const char* path) {
  if (!engine || !path) {
    qk::fail(QK_ERR_ARG, "no engine or no path");
    return nullptr;
  }

  auto* src = new QkSource();
  src->engine = engine;
  src->path = path;

  int err = avformat_open_input(&src->format, path, nullptr, nullptr);
  if (err < 0) {
    qk::fail_av(QK_ERR_OPEN, err, "%s: cannot open", path);
    delete src;
    return nullptr;
  }
  if ((err = avformat_find_stream_info(src->format, nullptr)) < 0) {
    qk::fail_av(QK_ERR_OPEN, err, "%s: cannot read stream info", path);
    qk_source_close(src);
    return nullptr;
  }

  src->video_index = av_find_best_stream(src->format, AVMEDIA_TYPE_VIDEO, -1, -1, nullptr, 0);
  src->audio_index = av_find_best_stream(src->format, AVMEDIA_TYPE_AUDIO, -1, -1, nullptr, 0);

  if (src->video_index < 0 && src->audio_index < 0) {
    qk::fail(QK_ERR_NO_TRACK, "%s: no video or audio track", path);
    qk_source_close(src);
    return nullptr;
  }

  if (src->video_index >= 0) {
    AVStream* stream = src->format->streams[src->video_index];
    src->video = open_decoder(engine, stream, true, &src->hw);
    if (!src->video) {
      // Worth saying which way this failed: the original made a point of telling
      // the user whether the limit was the machine's or the file's, because only
      // the first is worth trying somewhere else.
      const char* name = avcodec_get_name(stream->codecpar->codec_id);
      qk::fail(QK_ERR_DECODE,
               "%s: cannot decode %s here. Support depends on the GPU and the "
               "FFmpeg build, not the file, so it may open elsewhere",
               path, name);
      qk_source_close(src);
      return nullptr;
    }
    src->rotation = rotation_of(stream);
    src->video_codec_name = avcodec_get_name(stream->codecpar->codec_id);
  }

  if (src->audio_index >= 0) {
    AVStream* stream = src->format->streams[src->audio_index];
    src->audio = open_decoder(engine, stream, false, nullptr);
    if (src->audio) {
      src->audio_codec_name = avcodec_get_name(stream->codecpar->codec_id);
    } else if (src->video_index < 0) {
      qk::fail(QK_ERR_DECODE, "%s: cannot decode %s", path,
               avcodec_get_name(stream->codecpar->codec_id));
      qk_source_close(src);
      return nullptr;
    }
  }

  src->packet = av_packet_alloc();
  src->frame = av_frame_alloc();
  src->hw_frame = av_frame_alloc();
  if (!src->packet || !src->frame || !src->hw_frame) {
    qk::fail(QK_ERR_OPEN, "out of memory opening %s", path);
    qk_source_close(src);
    return nullptr;
  }

  src->duration = src->format->duration != AV_NOPTS_VALUE
                      ? src->format->duration / static_cast<double>(AV_TIME_BASE)
                      : 0.0;
  return src;
}

void qk_source_close(QkSource* source) {
  if (!source) return;
  if (source->scaler) sws_freeContext(source->scaler);
  if (source->resampler) swr_free(&source->resampler);
  if (source->video) avcodec_free_context(&source->video);
  if (source->audio) avcodec_free_context(&source->audio);
  if (source->packet) av_packet_free(&source->packet);
  if (source->frame) av_frame_free(&source->frame);
  if (source->hw_frame) av_frame_free(&source->hw_frame);
  if (source->format) avformat_close_input(&source->format);
  delete source;
}

QkStatus qk_source_info(QkSource* source, QkSourceInfo* out) {
  if (!source || !out) return qk::fail(QK_ERR_ARG, "no source or no output struct");
  std::memset(out, 0, sizeof(*out));

  out->duration = source->duration;
  out->rotation = source->rotation;
  out->has_video = source->video ? 1 : 0;
  out->has_audio = source->audio ? 1 : 0;
  out->hw_decoded = source->hw ? 1 : 0;

  if (source->video) {
    // Rotation swaps the picture's width and height, the same rule frame.dart
    // applies. Reporting the display shape here means nothing downstream has to
    // remember to.
    const bool turned = source->rotation == 90 || source->rotation == 270;
    out->width = turned ? source->video->height : source->video->width;
    out->height = turned ? source->video->width : source->video->height;
    out->video_codec = source->video_codec_name.c_str();
  }
  if (source->audio) {
    out->sample_rate = source->audio->sample_rate;
    out->channels = source->audio->ch_layout.nb_channels;
    out->audio_codec = source->audio_codec_name.c_str();
  }
  return QK_OK;
}

QkStatus qk_source_seek(QkSource* source, double timestamp) {
  if (!source || !source->format) return qk::fail(QK_ERR_ARG, "no source");
  const int stream = source->video_index >= 0 ? source->video_index : source->audio_index;
  const AVRational tb = source->format->streams[stream]->time_base;
  const int64_t target = static_cast<int64_t>(timestamp / av_q2d(tb));

  // Backwards to the keyframe at or before the target, then decode forward to
  // it. Seeking forward to the nearest keyframe would land past the requested
  // instant, which for a scrub is visibly the wrong frame.
  int err = av_seek_frame(source->format, stream, target, AVSEEK_FLAG_BACKWARD);
  if (err < 0) return qk::fail_av(QK_ERR_SEEK, err, "cannot seek to %.3fs", timestamp);

  if (source->video) avcodec_flush_buffers(source->video);
  if (source->audio) avcodec_flush_buffers(source->audio);
  source->last_pts = -1;
  return QK_OK;
}

/**
 * Pull one decoded video frame. Returns QK_OK, or QK_ERR_DECODE at the end of
 * the stream. The frame lands in `out_frame`, which the caller must unref.
 */
static QkStatus next_video_frame(QkSource* source, AVFrame* out_frame) {
  if (!source->video) return qk::fail(QK_ERR_DECODE, "this source has no video");

  for (;;) {
    av_frame_unref(out_frame);
    int err = avcodec_receive_frame(source->video, out_frame);
    if (err == 0) return QK_OK;
    if (err != AVERROR(EAGAIN) && err != AVERROR_EOF) {
      return qk::fail_av(QK_ERR_DECODE, err, "decode failed");
    }
    if (err == AVERROR_EOF) return qk::fail(QK_ERR_DECODE, "end of stream");

    // The decoder wants more input.
    for (;;) {
      av_packet_unref(source->packet);
      err = av_read_frame(source->format, source->packet);
      if (err == AVERROR_EOF) {
        avcodec_send_packet(source->video, nullptr);  // flush
        break;
      }
      if (err < 0) return qk::fail_av(QK_ERR_DECODE, err, "read failed");
      if (source->packet->stream_index != source->video_index) continue;

      err = avcodec_send_packet(source->video, source->packet);
      av_packet_unref(source->packet);
      if (err < 0 && err != AVERROR(EAGAIN)) {
        return qk::fail_av(QK_ERR_DECODE, err, "decoder rejected a packet");
      }
      break;
    }
  }
}

QkStatus qk_source_next_frame(QkSource* source, uint8_t* out, int32_t width,
                              int32_t height, double* timestamp) {
  if (!source || !out) return qk::fail(QK_ERR_ARG, "no source or no buffer");

  QkStatus status = next_video_frame(source, source->hw_frame);
  if (status != QK_OK) return status;

  const AVRational tb = source->format->streams[source->video_index]->time_base;
  const double at = seconds_of(source->hw_frame, tb);
  source->last_pts = at;
  if (timestamp) *timestamp = at;

  if (!to_rgba(source, source->hw_frame, out, width, height)) {
    return qk::fail(QK_ERR_DECODE, "cannot convert the frame to RGBA");
  }
  return QK_OK;
}

QkStatus qk_source_frame_at(QkSource* source, double timestamp, uint8_t* out,
                            int32_t width, int32_t height) {
  if (!source || !out) return qk::fail(QK_ERR_ARG, "no source or no buffer");
  if (!source->video) return qk::fail(QK_ERR_DECODE, "this source has no video");

  // A small step forward from where the decoder already sits is just more
  // decoding; a jump backwards, or a long jump forward, needs a keyframe seek.
  // Scrubbing forward is therefore cheap and scrubbing backwards is not, which
  // is a property of every long-GOP codec rather than of this code.
  constexpr double kForwardReuse = 2.0;
  const bool reuse = source->last_pts >= 0 && timestamp >= source->last_pts &&
                     timestamp - source->last_pts < kForwardReuse;
  if (!reuse) {
    QkStatus seek = qk_source_seek(source, timestamp);
    if (seek != QK_OK) return seek;
  }

  const AVRational tb = source->format->streams[source->video_index]->time_base;
  // The frame *covering* the instant is the one to show, so decode until the
  // next frame would be past it, then keep the one before.
  for (;;) {
    QkStatus status = next_video_frame(source, source->hw_frame);
    if (status != QK_OK) {
      // Past the end: the last frame decoded is the best answer there is.
      if (source->last_pts >= 0) break;
      return status;
    }
    const double at = seconds_of(source->hw_frame, tb);
    source->last_pts = at;
    if (at < 0 || at >= timestamp - 1e-6) break;
  }

  if (!to_rgba(source, source->hw_frame, out, width, height)) {
    return qk::fail(QK_ERR_DECODE, "cannot convert the frame to RGBA");
  }
  return QK_OK;
}

int32_t qk_thumb_width(QkSource* source) {
  if (!source || !source->video) return 0;
  QkSourceInfo info;
  if (qk_source_info(source, &info) != QK_OK || info.height <= 0) return 0;
  const int w = static_cast<int>(std::lround(
      static_cast<double>(QK_THUMB_H) * info.width / info.height));
  return std::max(1, w);
}

QkStatus qk_source_thumbnails(QkSource* source, int32_t count, uint8_t* out,
                              int32_t tile_width) {
  if (!source || !out || count <= 0 || tile_width <= 0) {
    return qk::fail(QK_ERR_ARG, "bad thumbnail request");
  }
  if (!source->video) return qk::fail(QK_ERR_DECODE, "this source has no video");
  if (source->duration <= 0) return qk::fail(QK_ERR_ARG, "the source has no duration");

  const size_t tile_bytes = static_cast<size_t>(tile_width) * QK_THUMB_H * 4;

  // Evenly spaced sample points, one per equal slice of the duration: the same
  // `(i + 0.5) * step` the original used, so a filmstrip samples the middle of
  // each slice rather than its edge.
  const double step = source->duration / count;
  for (int32_t i = 0; i < count; i++) {
    if (source->engine && source->engine->cancelled.load()) {
      return qk::fail(QK_ERR_CANCELLED, "thumbnails cancelled");
    }
    const double at = (i + 0.5) * step;
    uint8_t* tile = out + static_cast<size_t>(i) * tile_bytes;
    if (qk_source_frame_at(source, at, tile, tile_width, QK_THUMB_H) != QK_OK) {
      std::memset(tile, 0, tile_bytes);  // a tile that would not decode stays black
    }
  }
  return QK_OK;
}

// ─── Audio ───────────────────────────────────────────────────────────────────

/** Set up the resampler to land on the mixer's rate and layout. */
static bool ensure_resampler(QkSource* source) {
  if (source->resampler) return true;
  AVChannelLayout out_layout;
  av_channel_layout_default(&out_layout, qk::kAudioChannels);

  int err = swr_alloc_set_opts2(&source->resampler, &out_layout, AV_SAMPLE_FMT_FLT,
                                qk::kAudioRate, &source->audio->ch_layout,
                                source->audio->sample_fmt, source->audio->sample_rate,
                                0, nullptr);
  av_channel_layout_uninit(&out_layout);
  if (err < 0 || swr_init(source->resampler) < 0) {
    swr_free(&source->resampler);
    return false;
  }
  return true;
}

int64_t qk_source_audio(QkSource* source, double from, double to, float* out,
                        int64_t capacity_frames) {
  if (!source || !out || capacity_frames <= 0) {
    return qk::fail(QK_ERR_ARG, "bad audio request");
  }
  if (!source->audio) return 0;  // silence, which is what keeps the picture in sync
  if (!ensure_resampler(source)) return qk::fail(QK_ERR_DECODE, "cannot resample this audio");

  const AVRational tb = source->format->streams[source->audio_index]->time_base;
  const int64_t target = static_cast<int64_t>(from / av_q2d(tb));
  int err = av_seek_frame(source->format, source->audio_index, target, AVSEEK_FLAG_BACKWARD);
  if (err < 0) return qk::fail_av(QK_ERR_SEEK, err, "cannot seek audio to %.3fs", from);
  avcodec_flush_buffers(source->audio);

  AVFrame* frame = av_frame_alloc();
  if (!frame) return qk::fail(QK_ERR_DECODE, "out of memory");

  int64_t written = 0;
  bool done = false;
  std::vector<float> scratch;

  while (!done && written < capacity_frames) {
    av_packet_unref(source->packet);
    err = av_read_frame(source->format, source->packet);
    if (err < 0) break;
    if (source->packet->stream_index != source->audio_index) continue;

    if (avcodec_send_packet(source->audio, source->packet) < 0) continue;
    while (written < capacity_frames) {
      err = avcodec_receive_frame(source->audio, frame);
      if (err == AVERROR(EAGAIN) || err == AVERROR_EOF) break;
      if (err < 0) { done = true; break; }

      const double at = frame->pts != AV_NOPTS_VALUE ? frame->pts * av_q2d(tb) : from;
      if (at >= to) { done = true; break; }

      // Resample into scratch, then copy only the part inside the range: a
      // packet can start before `from`, so it is trimmed from the front rather
      // than being dropped whole.
      const int max_out = swr_get_out_samples(source->resampler, frame->nb_samples);
      scratch.resize(static_cast<size_t>(max_out) * qk::kAudioChannels);
      uint8_t* dst = reinterpret_cast<uint8_t*>(scratch.data());
      const int got = swr_convert(source->resampler, &dst, max_out,
                                  const_cast<const uint8_t**>(frame->data), frame->nb_samples);
      if (got <= 0) continue;

      const int skip = at < from
          ? std::min(got, static_cast<int>((from - at) * qk::kAudioRate))
          : 0;
      const int64_t room = std::min<int64_t>(got - skip, capacity_frames - written);
      if (room > 0) {
        std::memcpy(out + written * qk::kAudioChannels,
                    scratch.data() + static_cast<size_t>(skip) * qk::kAudioChannels,
                    static_cast<size_t>(room) * qk::kAudioChannels * sizeof(float));
        written += room;
      }
    }
    av_packet_unref(source->packet);
  }

  av_frame_free(&frame);
  return written;
}

QkStatus qk_source_peaks(QkSource* source, float* out, int32_t count) {
  if (!source || !out || count <= 0) return qk::fail(QK_ERR_ARG, "bad peaks request");
  std::memset(out, 0, static_cast<size_t>(count) * sizeof(float));
  if (!source->audio || source->duration <= 0) return QK_OK;

  // Streamed rather than decoded whole: a long music bed held as one buffer is
  // tens of megabytes and all we keep is `count` floats.
  const double per_second = count / source->duration;
  const int64_t chunk = qk::kAudioRate;  // a second at a time
  std::vector<float> buffer(static_cast<size_t>(chunk) * qk::kAudioChannels);

  for (double at = 0; at < source->duration; at += 1.0) {
    if (source->engine && source->engine->cancelled.load()) {
      return qk::fail(QK_ERR_CANCELLED, "peaks cancelled");
    }
    const int64_t got = qk_source_audio(source, at, at + 1.0, buffer.data(), chunk);
    if (got <= 0) continue;
    for (int64_t i = 0; i < got; i++) {
      const int bucket = static_cast<int>((at + static_cast<double>(i) / qk::kAudioRate) * per_second);
      if (bucket < 0 || bucket >= count) continue;
      const float value = std::fabs(buffer[static_cast<size_t>(i) * qk::kAudioChannels]);
      if (value > out[bucket]) out[bucket] = value;
    }
  }
  return QK_OK;
}

}  // extern "C"
