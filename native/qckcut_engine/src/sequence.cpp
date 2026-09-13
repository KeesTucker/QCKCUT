// Rendering a laid-out sequence to one file.
//
// A single clip can be remuxed; a sequence cannot. Its items come from
// different sources with different codecs, resolutions and rotations, so every
// frame is drawn into one output-sized picture and re-encoded.
//
// The output is a fixed frame rate, and frames are *pulled*: for each instant
// the output needs, the item covering it is asked for the frame covering that
// instant. The alternative, pushing each source's own frames through and
// hoping the timing lines up, is where sequence renders drift a frame per cut
// against an audio mix that used exact boundaries.
//
// Compositing goes through libavfilter rather than by hand. Rotation, crop,
// scale and letterbox are four things that are each easy to get subtly wrong
// and that FFmpeg already gets right.

#include "internal.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <string>
#include <vector>

extern "C" {
#include <libavfilter/avfilter.h>
#include <libavfilter/buffersink.h>
#include <libavfilter/buffersrc.h>
}

namespace {

constexpr double kEpsilon = 1e-6;

// ─── Layout, mirroring sequence.dart ─────────────────────────────────────────

struct Placed {
  const QkSequenceItem* item;
  double start;
  double duration;
  double end() const { return start + duration; }
};

std::vector<Placed> layout(const QkSequenceItem* items, int count) {
  std::vector<Placed> rows;
  rows.reserve(count);
  double start = 0;
  for (int i = 0; i < count; i++) {
    const double duration = std::max(0.0, items[i].out_point - items[i].in_point);
    rows.push_back({&items[i], start, duration});
    start += duration;
  }
  return rows;
}

// ─── Transitions, mirroring transitions.dart ─────────────────────────────────

struct Dip {
  double at;
  double duration;
};

double clamp01(double v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

/// How black the frame at `time` should be, 0 (untouched) to 1 (fully black).
double dim_at(double time, double total, double intro, double outro,
              const std::vector<Dip>& dips) {
  double dim = 0;

  if (intro > 0 && time < intro) dim = std::max(dim, 1 - clamp01(time / intro));

  if (outro > 0 && total > 0) {
    const double from = total - outro;
    if (time > from) dim = std::max(dim, clamp01((time - from) / outro));
  }

  // Each dip takes half its duration from the outgoing side and half from the
  // incoming one, so the sequence keeps its length.
  for (const Dip& dip : dips) {
    if (dip.duration <= 0) continue;
    const double half = dip.duration / 2;
    const double distance = std::fabs(time - dip.at);
    if (distance < half) dim = std::max(dim, 1 - clamp01(distance / half));
  }

  return clamp01(dim);
}

// ─── Framing, mirroring frame.dart ───────────────────────────────────────────

struct Rect {
  int left, top, width, height;
};

bool crop_for(double width, double height, int rotate, double out_w, double out_h,
              double zoom, double x, double y, Rect* out) {
  if (width <= 0 || height <= 0 || out_w <= 0 || out_h <= 0) return false;

  // Rotation swaps the picture's width and height; every number below is in the
  // rotated display space, which is what the crop is expressed in.
  const double sw = (rotate == 90 || rotate == 270) ? height : width;
  const double sh = (rotate == 90 || rotate == 270) ? width : height;

  const double aspect = out_w / out_h;
  const double widest = std::min(sw, sh * aspect);
  const double z = std::max(1.0, std::min(zoom, 6.0));
  const double crop_w = widest / z;
  const double crop_h = crop_w / aspect;

  if (z <= 1 && std::fabs(crop_w - sw) < 0.5 && std::fabs(crop_h - sh) < 0.5) {
    return false;  // nothing is cropped, so there is nothing to do
  }

  // Rounded before being clamped, so the rectangle is inside the picture by
  // construction rather than by a pixel of luck.
  const int w = static_cast<int>(std::lround(std::min(crop_w, sw)));
  const int h = static_cast<int>(std::lround(std::min(crop_h, sh)));
  const double max_left = std::max(0.0, sw - w);
  const double max_top = std::max(0.0, sh - h);
  const double left = std::min(std::max(x * sw - crop_w / 2, 0.0), max_left);
  const double top = std::min(std::max(y * sh - crop_h / 2, 0.0), max_top);

  out->left = static_cast<int>(std::lround(left));
  out->top = static_cast<int>(std::lround(top));
  out->width = w;
  out->height = h;
  return true;
}

// ─── One item's decoder and filter chain ─────────────────────────────────────

struct Clip {
  AVFormatContext* format = nullptr;
  AVCodecContext* decoder = nullptr;
  int stream = -1;
  AVPacket* packet = nullptr;
  AVFrame* decoded = nullptr;
  AVFrame* filtered = nullptr;

  AVFilterGraph* graph = nullptr;
  AVFilterContext* graph_in = nullptr;
  AVFilterContext* graph_out = nullptr;

  // The graph cannot be built until a frame has been decoded: a hardware frame
  // carries the pool it came from, and `hw_frames_ctx` does not exist before
  // the decoder has actually seen the stream. Building it at open time left
  // buffersrc told to expect CUDA frames with no pool to describe them, which
  // fails at configure and rendered every item black.
  const QkSequenceItem* item = nullptr;
  int out_w = 0;
  int out_h = 0;
  int fit = 0;
  bool graph_built = false;

  double last_pts = -1;
  bool drained = false;

  ~Clip() {
    if (graph) avfilter_graph_free(&graph);
    if (packet) av_packet_free(&packet);
    if (decoded) av_frame_free(&decoded);
    if (filtered) av_frame_free(&filtered);
    if (decoder) avcodec_free_context(&decoder);
    if (format) avformat_close_input(&format);
  }
};

AVPixelFormat pick_cuda(AVCodecContext*, const AVPixelFormat* formats) {
  for (const AVPixelFormat* p = formats; *p != AV_PIX_FMT_NONE; p++) {
    if (*p == AV_PIX_FMT_CUDA) return *p;
  }
  return formats[0];
}

QkStatus open_clip(QkEngine* engine, const QkSequenceItem& item, Clip& clip) {
  int err = avformat_open_input(&clip.format, item.path, nullptr, nullptr);
  if (err < 0) return qk::fail_av(QK_ERR_OPEN, err, "%s: cannot open", item.path);
  if ((err = avformat_find_stream_info(clip.format, nullptr)) < 0) {
    return qk::fail_av(QK_ERR_OPEN, err, "%s: cannot read stream info", item.path);
  }

  clip.stream = av_find_best_stream(clip.format, AVMEDIA_TYPE_VIDEO, -1, -1, nullptr, 0);
  if (clip.stream < 0) return QK_ERR_NO_TRACK;  // audio-only: rendered as black

  AVStream* stream = clip.format->streams[clip.stream];
  const AVCodec* codec = avcodec_find_decoder(stream->codecpar->codec_id);
  if (!codec) return qk::fail(QK_ERR_DECODE, "%s: no decoder", item.path);

  clip.decoder = avcodec_alloc_context3(codec);
  if (!clip.decoder) return qk::fail(QK_ERR_DECODE, "out of memory");
  avcodec_parameters_to_context(clip.decoder, stream->codecpar);
  clip.decoder->pkt_timebase = stream->time_base;
  clip.decoder->thread_count = 0;
  if (engine->cuda) {
    clip.decoder->hw_device_ctx = av_buffer_ref(engine->hw_device);
    clip.decoder->get_format = pick_cuda;
  }

  if ((err = avcodec_open2(clip.decoder, codec, nullptr)) < 0) {
    return qk::fail_av(QK_ERR_DECODE, err, "%s: cannot open the decoder", item.path);
  }

  clip.packet = av_packet_alloc();
  clip.decoded = av_frame_alloc();
  clip.filtered = av_frame_alloc();
  if (!clip.packet || !clip.decoded || !clip.filtered) {
    return qk::fail(QK_ERR_DECODE, "out of memory");
  }
  return QK_OK;
}

/**
 * Build the chain that turns one item's frames into output-sized NV12.
 *
 * Order matters and matches the framing model: rotate first, because a crop is
 * expressed in the rotated display space, then crop, then fit into the output.
 * A crop already matches the output's shape, so there is nothing left to
 * letterbox and the scale is exact.
 */
QkStatus build_graph(Clip& clip, const QkSequenceItem& item, int out_w, int out_h,
                     int fit, const AVFrame* first) {
  const bool hardware = first->format == AV_PIX_FMT_CUDA;
  clip.graph = avfilter_graph_alloc();
  if (!clip.graph) return qk::fail(QK_ERR_ENCODE, "out of memory");

  AVStream* stream = clip.format->streams[clip.stream];

  // Built through parameters rather than an args string. A hardware pixel
  // format cannot be expressed as text: buffersrc has to be handed the pool the
  // frames came from, and `avfilter_graph_create_filter` has nowhere to put it,
  // so it rejects pix_fmt=cuda outright.
  const AVFilter* buffersrc = avfilter_get_by_name("buffer");
  if (!buffersrc) return qk::fail(QK_ERR_ENCODE, "no buffer filter in this FFmpeg build");
  clip.graph_in = avfilter_graph_alloc_filter(clip.graph, buffersrc, "in");
  if (!clip.graph_in) return qk::fail(QK_ERR_ENCODE, "cannot create the filter source");

  AVBufferSrcParameters* params = av_buffersrc_parameters_alloc();
  if (!params) return qk::fail(QK_ERR_ENCODE, "out of memory");
  params->format = first->format;
  params->width = first->width;
  params->height = first->height;
  params->time_base = stream->time_base;
  params->sample_aspect_ratio = first->sample_aspect_ratio.num
                                    ? first->sample_aspect_ratio
                                    : AVRational{1, 1};
  if (first->hw_frames_ctx) params->hw_frames_ctx = av_buffer_ref(first->hw_frames_ctx);

  int err = av_buffersrc_parameters_set(clip.graph_in, params);
  av_free(params);
  if (err < 0) return qk::fail_av(QK_ERR_ENCODE, err, "cannot describe the input frames");

  if ((err = avfilter_init_dict(clip.graph_in, nullptr)) < 0) {
    return qk::fail_av(QK_ERR_ENCODE, err, "cannot initialise the filter source");
  }

  err = avfilter_graph_create_filter(&clip.graph_out, avfilter_get_by_name("buffersink"),
                                     "out", nullptr, nullptr, clip.graph);
  if (err < 0) return qk::fail_av(QK_ERR_ENCODE, err, "cannot create the filter sink");

  std::string chain;
  // Down from the GPU to composite. This is the one copy the pipeline still
  // makes, and moving crop/scale onto scale_cuda is what would remove it.
  if (hardware) chain += "hwdownload,format=nv12,";

  switch (((item.rotate % 360) + 360) % 360) {
    case 90: chain += "transpose=clock,"; break;
    case 180: chain += "transpose=clock,transpose=clock,"; break;
    case 270: chain += "transpose=cclock,"; break;
    default: break;
  }

  // The source's shape in the space the crop is expressed in.
  const bool turned = item.rotate == 90 || item.rotate == 270;
  const double sw = turned ? clip.decoder->height : clip.decoder->width;
  const double sh = turned ? clip.decoder->width : clip.decoder->height;

  Rect crop;
  const bool cropped = item.has_frame != 0 &&
                       crop_for(clip.decoder->width, clip.decoder->height, item.rotate,
                                out_w, out_h, item.zoom, item.frame_x, item.frame_y, &crop);

  char step[256];
  if (cropped) {
    snprintf(step, sizeof(step), "crop=%d:%d:%d:%d,", crop.width, crop.height,
             crop.left, crop.top);
    chain += step;
    // The crop already matches the output's shape, so this is exact rather than
    // a fit with something left over.
    snprintf(step, sizeof(step), "scale=%d:%d,", out_w, out_h);
    chain += step;
  } else if (fit == 1) {  // cover: fill the frame and lose the overflow
    snprintf(step, sizeof(step),
             "scale=%d:%d:force_original_aspect_ratio=increase,crop=%d:%d,",
             out_w, out_h, out_w, out_h);
    chain += step;
  } else if (fit == 2) {  // fill: stretch, which is the only way to squash a picture
    snprintf(step, sizeof(step), "scale=%d:%d,", out_w, out_h);
    chain += step;
  } else {  // contain: letterbox rather than stretch, since items differ in shape
    snprintf(step, sizeof(step),
             "scale=%d:%d:force_original_aspect_ratio=decrease,"
             "pad=%d:%d:(ow-iw)/2:(oh-ih)/2:black,",
             out_w, out_h, out_w, out_h);
    chain += step;
  }
  (void)sw;
  (void)sh;

  chain += "format=nv12";

  AVFilterInOut* outputs = avfilter_inout_alloc();
  AVFilterInOut* inputs = avfilter_inout_alloc();
  if (!outputs || !inputs) {
    avfilter_inout_free(&outputs);
    avfilter_inout_free(&inputs);
    return qk::fail(QK_ERR_ENCODE, "out of memory");
  }
  outputs->name = av_strdup("in");
  outputs->filter_ctx = clip.graph_in;
  outputs->pad_idx = 0;
  outputs->next = nullptr;
  inputs->name = av_strdup("out");
  inputs->filter_ctx = clip.graph_out;
  inputs->pad_idx = 0;
  inputs->next = nullptr;

  err = avfilter_graph_parse_ptr(clip.graph, chain.c_str(), &inputs, &outputs, nullptr);
  avfilter_inout_free(&outputs);
  avfilter_inout_free(&inputs);
  if (err < 0) return qk::fail_av(QK_ERR_ENCODE, err, "cannot build the filter chain '%s'",
                                  chain.c_str());

  if ((err = avfilter_graph_config(clip.graph, nullptr)) < 0) {
    return qk::fail_av(QK_ERR_ENCODE, err, "the filter chain '%s' will not run", chain.c_str());
  }
  return QK_OK;
}

/** Decode and filter until the frame covering `want` (in source time) is out. */
QkStatus advance_to(Clip& clip, double want, bool* have) {
  *have = false;
  if (clip.drained) return QK_OK;
  AVStream* stream = clip.format->streams[clip.stream];
  const AVRational tb = stream->time_base;

  // Already sitting on it: a sequence render only ever moves forward, so the
  // frame that was good for the last instant is often good for this one too.
  if (clip.last_pts >= 0 && clip.filtered->width > 0 && clip.last_pts >= want - kEpsilon) {
    *have = true;
    return QK_OK;
  }

  for (;;) {
    // Anything already waiting in the graph first. Before the first frame has
    // been decoded there is no graph to ask.
    av_frame_unref(clip.filtered);
    int err = clip.graph_built ? av_buffersink_get_frame(clip.graph_out, clip.filtered)
                               : AVERROR(EAGAIN);
    if (err >= 0) {
      clip.last_pts = clip.filtered->pts != AV_NOPTS_VALUE
                          ? clip.filtered->pts * av_q2d(tb)
                          : clip.last_pts;
      *have = true;
      if (clip.last_pts >= want - kEpsilon) return QK_OK;
      av_frame_unref(clip.filtered);
      continue;
    }
    if (err != AVERROR(EAGAIN) && err != AVERROR_EOF) {
      return qk::fail_av(QK_ERR_DECODE, err, "the filter chain failed");
    }
    if (err == AVERROR_EOF) { clip.drained = true; return QK_OK; }

    // Then more from the decoder.
    av_frame_unref(clip.decoded);
    err = avcodec_receive_frame(clip.decoder, clip.decoded);
    if (err == 0) {
      if (!clip.graph_built) {
        QkStatus status = build_graph(clip, *clip.item, clip.out_w, clip.out_h,
                                      clip.fit, clip.decoded);
        if (status != QK_OK) return status;
        clip.graph_built = true;
      }
      if (av_buffersrc_add_frame_flags(clip.graph_in, clip.decoded,
                                       AV_BUFFERSRC_FLAG_KEEP_REF) < 0) {
        return qk::fail(QK_ERR_DECODE, "the filter chain rejected a frame");
      }
      continue;
    }
    if (err == AVERROR_EOF) {
      if (!clip.graph_built) { clip.drained = true; return QK_OK; }
      if (av_buffersrc_add_frame_flags(clip.graph_in, nullptr, 0) < 0) {
        return qk::fail(QK_ERR_DECODE, "cannot flush the filter chain");
      }
      continue;
    }
    if (err != AVERROR(EAGAIN)) {
      return qk::fail_av(QK_ERR_DECODE, err, "decode failed");
    }

    // Then more from the file.
    bool sent = false;
    while (!sent) {
      av_packet_unref(clip.packet);
      err = av_read_frame(clip.format, clip.packet);
      if (err == AVERROR_EOF) {
        avcodec_send_packet(clip.decoder, nullptr);
        sent = true;
        break;
      }
      if (err < 0) return qk::fail_av(QK_ERR_DECODE, err, "read failed");
      if (clip.packet->stream_index != clip.stream) continue;
      err = avcodec_send_packet(clip.decoder, clip.packet);
      av_packet_unref(clip.packet);
      if (err < 0 && err != AVERROR(EAGAIN)) {
        return qk::fail_av(QK_ERR_DECODE, err, "the decoder rejected a packet");
      }
      sent = true;
    }
  }
}

/**
 * Darken an NV12 frame toward black, in place.
 *
 * The same function the preview will call, because a transition that looks one
 * way on screen and another in the file is worse than no transition. Video is
 * limited range, so black is Y=16 and neutral chroma is 128; pulling toward 0
 * instead would crush into illegal values.
 */
void darken(AVFrame* frame, double dim) {
  if (dim <= 0) return;
  const double keep = 1.0 - clamp01(dim);

  for (int y = 0; y < frame->height; y++) {
    uint8_t* row = frame->data[0] + static_cast<ptrdiff_t>(y) * frame->linesize[0];
    for (int x = 0; x < frame->width; x++) {
      row[x] = static_cast<uint8_t>(16 + (row[x] - 16) * keep);
    }
  }
  for (int y = 0; y < frame->height / 2; y++) {
    uint8_t* row = frame->data[1] + static_cast<ptrdiff_t>(y) * frame->linesize[1];
    for (int x = 0; x < frame->width; x++) {
      row[x] = static_cast<uint8_t>(128 + (row[x] - 128) * keep);
    }
  }
}

/** An all-black NV12 frame, for audio-only items and for the tail. */
void fill_black(AVFrame* frame) {
  for (int y = 0; y < frame->height; y++) {
    std::memset(frame->data[0] + static_cast<ptrdiff_t>(y) * frame->linesize[0], 16,
                frame->width);
  }
  for (int y = 0; y < frame->height / 2; y++) {
    std::memset(frame->data[1] + static_cast<ptrdiff_t>(y) * frame->linesize[1], 128,
                frame->width);
  }
}

// ─── Audio ───────────────────────────────────────────────────────────────────

/// The mix: every item's sound flattened onto one buffer at a single rate, so
/// sources that disagree about sample rate or channel count still line up.
/// Items with no audio simply leave silence, which is what keeps the picture in
/// sync rather than shortening the mix.
struct Mix {
  std::vector<float> samples;  // interleaved stereo at kAudioRate
  bool any = false;
};

QkStatus mix_item(const Placed& row, Mix& mix, double total, QkEngine* engine) {
  const QkSequenceItem& item = *row.item;
  // Zero is skipped outright: a silent item still costs a full decode.
  const double level = item.muted ? 0.0 : item.gain;
  if (level <= 0) return QK_OK;

  AVFormatContext* format = nullptr;
  int err = avformat_open_input(&format, item.path, nullptr, nullptr);
  if (err < 0) return QK_OK;  // a source that will not open contributes silence

  struct Closer {
    AVFormatContext** f;
    ~Closer() { if (*f) avformat_close_input(f); }
  } closer{&format};

  if (avformat_find_stream_info(format, nullptr) < 0) return QK_OK;
  const int index = av_find_best_stream(format, AVMEDIA_TYPE_AUDIO, -1, -1, nullptr, 0);
  if (index < 0) return QK_OK;

  AVStream* stream = format->streams[index];
  const AVCodec* codec = avcodec_find_decoder(stream->codecpar->codec_id);
  if (!codec) return QK_OK;

  AVCodecContext* decoder = avcodec_alloc_context3(codec);
  if (!decoder) return qk::fail(QK_ERR_DECODE, "out of memory");
  struct DecCloser {
    AVCodecContext** d;
    ~DecCloser() { if (*d) avcodec_free_context(d); }
  } dec_closer{&decoder};

  avcodec_parameters_to_context(decoder, stream->codecpar);
  decoder->pkt_timebase = stream->time_base;
  if (avcodec_open2(decoder, codec, nullptr) < 0) return QK_OK;

  AVChannelLayout out_layout;
  av_channel_layout_default(&out_layout, qk::kAudioChannels);
  SwrContext* resampler = nullptr;
  err = swr_alloc_set_opts2(&resampler, &out_layout, AV_SAMPLE_FMT_FLT, qk::kAudioRate,
                            &decoder->ch_layout, decoder->sample_fmt,
                            decoder->sample_rate, 0, nullptr);
  av_channel_layout_uninit(&out_layout);
  if (err < 0 || swr_init(resampler) < 0) {
    swr_free(&resampler);
    return QK_OK;
  }
  struct SwrCloser {
    SwrContext** s;
    ~SwrCloser() { if (*s) swr_free(s); }
  } swr_closer{&resampler};

  const AVRational tb = stream->time_base;
  av_seek_frame(format, index, static_cast<int64_t>(item.in_point / av_q2d(tb)),
                AVSEEK_FLAG_BACKWARD);
  avcodec_flush_buffers(decoder);

  AVPacket* packet = av_packet_alloc();
  AVFrame* frame = av_frame_alloc();
  struct FreeAV {
    AVPacket** p;
    AVFrame** f;
    ~FreeAV() { av_packet_free(p); av_frame_free(f); }
  } free_av{&packet, &frame};
  if (!packet || !frame) return qk::fail(QK_ERR_DECODE, "out of memory");

  std::vector<float> scratch;
  bool done = false;

  while (!done) {
    if (engine->cancelled.load()) return qk::fail(QK_ERR_CANCELLED, "export cancelled");
    av_packet_unref(packet);
    if (av_read_frame(format, packet) < 0) break;
    if (packet->stream_index != index) continue;
    if (avcodec_send_packet(decoder, packet) < 0) continue;

    for (;;) {
      err = avcodec_receive_frame(decoder, frame);
      if (err == AVERROR(EAGAIN) || err == AVERROR_EOF) break;
      if (err < 0) { done = true; break; }

      const double at = frame->pts != AV_NOPTS_VALUE ? frame->pts * av_q2d(tb)
                                                     : item.in_point;
      if (at >= item.out_point) { done = true; break; }

      const int room = swr_get_out_samples(resampler, frame->nb_samples);
      scratch.resize(static_cast<size_t>(room) * qk::kAudioChannels);
      uint8_t* dst = reinterpret_cast<uint8_t*>(scratch.data());
      const int got = swr_convert(resampler, &dst, room,
                                  const_cast<const uint8_t**>(frame->data),
                                  frame->nb_samples);
      if (got <= 0) continue;

      // A packet can start before the in point, so it is trimmed from the front
      // rather than scheduled at a negative time.
      const int skip = at < item.in_point
          ? std::min(got, static_cast<int>((item.in_point - at) * qk::kAudioRate))
          : 0;
      // Where this lands on the sequence clock.
      const double when = row.start + std::max(0.0, at - item.in_point);
      int64_t offset = static_cast<int64_t>(std::llround(when * qk::kAudioRate));
      const int64_t limit =
          std::min<int64_t>(static_cast<int64_t>(std::llround(std::min(row.end(), total) *
                                                             qk::kAudioRate)),
                            static_cast<int64_t>(mix.samples.size() / qk::kAudioChannels));

      for (int i = skip; i < got && offset < limit; i++, offset++) {
        if (offset < 0) continue;
        const size_t at_sample = static_cast<size_t>(offset) * qk::kAudioChannels;
        // Lanes are parallel, so their sound simply sums.
        mix.samples[at_sample] += scratch[static_cast<size_t>(i) * qk::kAudioChannels] * level;
        mix.samples[at_sample + 1] +=
            scratch[static_cast<size_t>(i) * qk::kAudioChannels + 1] * level;
      }
      mix.any = true;
    }
  }
  return QK_OK;
}

/// Encode the mix to AAC, collecting the packets so they can be interleaved
/// against the video rather than written in one lump at the front.
QkStatus encode_audio(const Mix& mix, AVFormatContext* out, AVStream* stream,
                      AVCodecContext** encoder_out, std::vector<AVPacket*>* packets) {
  const AVCodec* codec = avcodec_find_encoder(AV_CODEC_ID_AAC);
  if (!codec) return qk::fail(QK_ERR_ENCODE, "no AAC encoder in this FFmpeg build");

  AVCodecContext* encoder = avcodec_alloc_context3(codec);
  if (!encoder) return qk::fail(QK_ERR_ENCODE, "out of memory");
  *encoder_out = encoder;

  av_channel_layout_default(&encoder->ch_layout, qk::kAudioChannels);
  encoder->sample_fmt = AV_SAMPLE_FMT_FLTP;
  encoder->sample_rate = qk::kAudioRate;
  encoder->bit_rate = 192000;
  encoder->time_base = AVRational{1, qk::kAudioRate};
  if (out->oformat->flags & AVFMT_GLOBALHEADER) {
    encoder->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;
  }

  int err = avcodec_open2(encoder, codec, nullptr);
  if (err < 0) return qk::fail_av(QK_ERR_ENCODE, err, "cannot open the AAC encoder");
  if ((err = avcodec_parameters_from_context(stream->codecpar, encoder)) < 0) {
    return qk::fail_av(QK_ERR_ENCODE, err, "cannot describe the audio stream");
  }
  stream->time_base = encoder->time_base;

  const int block = encoder->frame_size > 0 ? encoder->frame_size : 1024;
  const int64_t total = static_cast<int64_t>(mix.samples.size() / qk::kAudioChannels);

  AVFrame* frame = av_frame_alloc();
  AVPacket* packet = av_packet_alloc();
  struct FreeAV {
    AVFrame** f;
    AVPacket** p;
    ~FreeAV() { av_frame_free(f); av_packet_free(p); }
  } free_av{&frame, &packet};
  if (!frame || !packet) return qk::fail(QK_ERR_ENCODE, "out of memory");

  frame->format = AV_SAMPLE_FMT_FLTP;
  frame->nb_samples = block;
  av_channel_layout_default(&frame->ch_layout, qk::kAudioChannels);
  if ((err = av_frame_get_buffer(frame, 0)) < 0) {
    return qk::fail_av(QK_ERR_ENCODE, err, "cannot allocate an audio frame");
  }

  auto drain = [&](AVFrame* input) -> QkStatus {
    int e = avcodec_send_frame(encoder, input);
    if (e < 0 && e != AVERROR_EOF) {
      return qk::fail_av(QK_ERR_ENCODE, e, "the AAC encoder rejected a frame");
    }
    for (;;) {
      av_packet_unref(packet);
      e = avcodec_receive_packet(encoder, packet);
      if (e == AVERROR(EAGAIN) || e == AVERROR_EOF) return QK_OK;
      if (e < 0) return qk::fail_av(QK_ERR_ENCODE, e, "audio encode failed");
      AVPacket* kept = av_packet_clone(packet);
      if (!kept) return qk::fail(QK_ERR_ENCODE, "out of memory");
      kept->stream_index = stream->index;
      av_packet_rescale_ts(kept, encoder->time_base, stream->time_base);
      packets->push_back(kept);
    }
  };

  for (int64_t start = 0; start < total; start += block) {
    if ((err = av_frame_make_writable(frame)) < 0) {
      return qk::fail_av(QK_ERR_ENCODE, err, "cannot write to the audio frame");
    }
    const int count = static_cast<int>(std::min<int64_t>(block, total - start));
    auto* left = reinterpret_cast<float*>(frame->data[0]);
    auto* right = reinterpret_cast<float*>(frame->data[1]);
    for (int i = 0; i < count; i++) {
      const size_t at = (static_cast<size_t>(start) + i) * qk::kAudioChannels;
      left[i] = mix.samples[at];
      right[i] = mix.samples[at + 1];
    }
    // The final block is padded with silence rather than shortened: AAC wants
    // whole blocks, and the trailing samples are beyond the sequence anyway.
    for (int i = count; i < block; i++) { left[i] = 0; right[i] = 0; }

    frame->pts = start;
    QkStatus status = drain(frame);
    if (status != QK_OK) return status;
  }

  return drain(nullptr);
}
}  // namespace

// ─── The render ──────────────────────────────────────────────────────────────

namespace {

/// Everything one sequence render holds, so the cleanup is in one place.
struct Render {
  AVFormatContext* out = nullptr;
  AVCodecContext* video = nullptr;
  AVCodecContext* audio = nullptr;
  AVBufferRef* frames = nullptr;
  AVFrame* composed = nullptr;   // output-sized NV12 on the CPU
  AVFrame* uploaded = nullptr;   // the same picture on the GPU
  AVPacket* packet = nullptr;
  std::vector<AVPacket*> audio_packets;
  size_t audio_written = 0;
  int video_stream = -1;
  int audio_stream = -1;

  ~Render() {
    for (AVPacket* p : audio_packets) av_packet_free(&p);
    if (packet) av_packet_free(&packet);
    if (composed) av_frame_free(&composed);
    if (uploaded) av_frame_free(&uploaded);
    if (video) avcodec_free_context(&video);
    if (audio) avcodec_free_context(&audio);
    if (frames) av_buffer_unref(&frames);
    if (out) {
      if (out->pb && !(out->oformat->flags & AVFMT_NOFILE)) avio_closep(&out->pb);
      avformat_free_context(out);
    }
  }
};

const char* nvenc_for(QkCodec codec) {
  switch (codec) {
    case QK_CODEC_H264: return "h264_nvenc";
    case QK_CODEC_HEVC: return "hevc_nvenc";
    case QK_CODEC_AV1: return "av1_nvenc";
    default: return nullptr;
  }
}

/// Write any audio that belongs before `until` on the output clock, so the two
/// streams interleave instead of the whole mix landing at the front.
QkStatus flush_audio(Render& render, double until) {
  if (render.audio_stream < 0) return QK_OK;
  AVStream* stream = render.out->streams[render.audio_stream];
  while (render.audio_written < render.audio_packets.size()) {
    AVPacket* packet = render.audio_packets[render.audio_written];
    const double at = packet->pts * av_q2d(stream->time_base);
    if (at > until) break;
    int err = av_interleaved_write_frame(render.out, packet);
    render.audio_written++;
    if (err < 0) return qk::fail_av(QK_ERR_ENCODE, err, "audio write failed");
  }
  return QK_OK;
}

/// Push one composed frame through NVENC and write what comes out.
QkStatus encode_video(Render& render, AVFrame* frame) {
  int err = avcodec_send_frame(render.video, frame);
  if (err < 0 && err != AVERROR_EOF) {
    return qk::fail_av(QK_ERR_ENCODE, err, "the encoder rejected a frame");
  }
  for (;;) {
    av_packet_unref(render.packet);
    err = avcodec_receive_packet(render.video, render.packet);
    if (err == AVERROR(EAGAIN) || err == AVERROR_EOF) return QK_OK;
    if (err < 0) return qk::fail_av(QK_ERR_ENCODE, err, "encode failed");

    render.packet->stream_index = render.video_stream;
    av_packet_rescale_ts(render.packet, render.video->time_base,
                         render.out->streams[render.video_stream]->time_base);
    err = av_interleaved_write_frame(render.out, render.packet);
    if (err < 0) return qk::fail_av(QK_ERR_ENCODE, err, "write failed");
  }
}

}  // namespace

extern "C" {

QkStatus qk_export_sequence(QkEngine* engine, const QkSequenceItem* items, int32_t count,
                            const char* out_path, const QkOutputSettings* settings,
                            double intro_fade, double outro_fade,
                            QkProgressFn progress, void* user) {
  if (!engine || !items || count <= 0 || !out_path || !settings) {
    return qk::fail(QK_ERR_ARG, "the sequence is empty");
  }
  engine->cancelled.store(false);

  const std::vector<Placed> rows = layout(items, count);
  const double total = rows.back().end();
  if (!(total > 0)) return qk::fail(QK_ERR_ARG, "the sequence is empty");

  std::vector<Dip> dips;
  for (size_t i = 1; i < rows.size(); i++) {
    if (rows[i].item->dip_duration > 0) {
      dips.push_back({rows[i].start, rows[i].item->dip_duration});
    }
  }

  Render render;

  // ── Output shape and rate ──
  int out_w = settings->width;
  int out_h = settings->height;
  double fps = settings->fps;

  // The caller may not have said, in which case the first item that has
  // pictures decides, since that is the one the sequence is shaped around.
  if (out_w <= 0 || out_h <= 0 || fps <= 0) {
    for (const Placed& row : rows) {
      AVFormatContext* probe = nullptr;
      if (avformat_open_input(&probe, row.item->path, nullptr, nullptr) < 0) continue;
      if (avformat_find_stream_info(probe, nullptr) >= 0) {
        const int index = av_find_best_stream(probe, AVMEDIA_TYPE_VIDEO, -1, -1, nullptr, 0);
        if (index >= 0) {
          AVStream* stream = probe->streams[index];
          const bool turned = row.item->rotate == 90 || row.item->rotate == 270;
          if (out_w <= 0 || out_h <= 0) {
            out_w = turned ? stream->codecpar->height : stream->codecpar->width;
            out_h = turned ? stream->codecpar->width : stream->codecpar->height;
          }
          if (fps <= 0 && stream->avg_frame_rate.num > 0) {
            fps = av_q2d(stream->avg_frame_rate);
          }
          avformat_close_input(&probe);
          break;
        }
      }
      avformat_close_input(&probe);
    }
  }
  if (fps <= 0) fps = 30;
  if (out_w <= 0 || out_h <= 0) {
    return qk::fail(QK_ERR_ARG, "the sequence has no dimensions");
  }
  // NVENC wants even dimensions, and an odd one is almost always a rounding
  // slip upstream rather than a deliberate choice.
  out_w &= ~1;
  out_h &= ~1;

  // ── Container ──
  int err = avformat_alloc_output_context2(&render.out, nullptr, nullptr, out_path);
  if (err < 0 || !render.out) {
    return qk::fail_av(QK_ERR_OPEN, err, "%s: cannot create the output", out_path);
  }

  AVStream* video_stream = avformat_new_stream(render.out, nullptr);
  if (!video_stream) return qk::fail(QK_ERR_ENCODE, "cannot add the video stream");
  render.video_stream = video_stream->index;

  // ── Audio first ──
  // The track has to exist before the output starts, and mixing is the slow
  // half on a long sequence, so it happens before any picture is touched.
  if (progress) progress(0, QK_PHASE_AUDIO, user);

  Mix mix;
  mix.samples.assign(
      static_cast<size_t>(std::llround(total * qk::kAudioRate)) * qk::kAudioChannels, 0.0f);

  for (size_t i = 0; i < rows.size(); i++) {
    if (engine->cancelled.load()) return qk::fail(QK_ERR_CANCELLED, "export cancelled");
    QkStatus status = mix_item(rows[i], mix, total, engine);
    if (status != QK_OK) return status;
    if (progress) progress(static_cast<double>(i + 1) / rows.size(), QK_PHASE_AUDIO, user);
  }

  if (mix.any) {
    AVStream* audio_stream = avformat_new_stream(render.out, nullptr);
    if (!audio_stream) return qk::fail(QK_ERR_ENCODE, "cannot add the audio stream");
    render.audio_stream = audio_stream->index;
    QkStatus status =
        encode_audio(mix, render.out, audio_stream, &render.audio, &render.audio_packets);
    if (status != QK_OK) return status;
  }
  // The mix is no longer needed once encoded, and on a long sequence it is the
  // largest thing in the process.
  mix.samples.clear();
  mix.samples.shrink_to_fit();

  // ── Video encoder ──
  const char* name = nvenc_for(settings->codec);
  const AVCodec* codec = name ? avcodec_find_encoder_by_name(name) : nullptr;
  const bool hardware = engine->cuda && codec != nullptr;
  if (!codec) {
    codec = avcodec_find_encoder(qk::codec_id_of(settings->codec));
    if (!codec) return qk::fail(QK_ERR_ENCODE, "no encoder for the requested codec");
  }

  render.video = avcodec_alloc_context3(codec);
  if (!render.video) return qk::fail(QK_ERR_ENCODE, "out of memory");
  render.video->width = out_w;
  render.video->height = out_h;
  render.video->time_base = av_inv_q(av_d2q(fps, 1000000));
  render.video->framerate = av_d2q(fps, 1000000);
  render.video->pix_fmt = hardware ? AV_PIX_FMT_CUDA : AV_PIX_FMT_NV12;
  render.video->bit_rate = settings->bitrate > 0 ? settings->bitrate : 0;
  if (!render.video->bit_rate && hardware) {
    av_opt_set(render.video->priv_data, "rc", "vbr", 0);
    av_opt_set(render.video->priv_data, "cq", "21", 0);
    av_opt_set(render.video->priv_data, "preset", "p5", 0);
  }
  if (render.out->oformat->flags & AVFMT_GLOBALHEADER) {
    render.video->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;
  }

  if (hardware) {
    render.frames = av_hwframe_ctx_alloc(engine->hw_device);
    if (!render.frames) return qk::fail(QK_ERR_ENCODE, "cannot allocate a frame pool");
    auto* ctx = reinterpret_cast<AVHWFramesContext*>(render.frames->data);
    ctx->format = AV_PIX_FMT_CUDA;
    ctx->sw_format = AV_PIX_FMT_NV12;
    ctx->width = out_w;
    ctx->height = out_h;
    ctx->initial_pool_size = 32;
    if ((err = av_hwframe_ctx_init(render.frames)) < 0) {
      return qk::fail_av(QK_ERR_ENCODE, err, "cannot initialise the frame pool");
    }
    render.video->hw_frames_ctx = av_buffer_ref(render.frames);
  }

  if ((err = avcodec_open2(render.video, codec, nullptr)) < 0) {
    return qk::fail_av(QK_ERR_ENCODE, err, "cannot open %s", codec->name);
  }
  if ((err = avcodec_parameters_from_context(video_stream->codecpar, render.video)) < 0) {
    return qk::fail_av(QK_ERR_ENCODE, err, "cannot describe the video stream");
  }
  video_stream->time_base = render.video->time_base;

  if (!(render.out->oformat->flags & AVFMT_NOFILE)) {
    if ((err = avio_open(&render.out->pb, out_path, AVIO_FLAG_WRITE)) < 0) {
      return qk::fail_av(QK_ERR_OPEN, err, "%s: cannot write there", out_path);
    }
  }
  if ((err = avformat_write_header(render.out, nullptr)) < 0) {
    return qk::fail_av(QK_ERR_ENCODE, err, "cannot write the header");
  }

  // ── Working frames ──
  render.packet = av_packet_alloc();
  render.composed = av_frame_alloc();
  if (!render.packet || !render.composed) return qk::fail(QK_ERR_ENCODE, "out of memory");
  render.composed->format = AV_PIX_FMT_NV12;
  render.composed->width = out_w;
  render.composed->height = out_h;
  if ((err = av_frame_get_buffer(render.composed, 32)) < 0) {
    return qk::fail_av(QK_ERR_ENCODE, err, "cannot allocate the output frame");
  }

  if (hardware) {
    render.uploaded = av_frame_alloc();
    if (!render.uploaded) return qk::fail(QK_ERR_ENCODE, "out of memory");
  }

  // ── Frames ──
  if (progress) progress(0, QK_PHASE_VIDEO, user);
  const int64_t frames_total = std::max<int64_t>(1, std::llround(total * fps));
  size_t row_index = 0;
  Clip clip;
  bool clip_open = false;
  bool clip_usable = false;

  for (int64_t k = 0; k < frames_total; k++) {
    if (engine->cancelled.load()) return qk::fail(QK_ERR_CANCELLED, "export cancelled");
    const double at = k / fps;

    // Which item covers this instant. Items are laid out end to end, so this
    // only ever moves forward.
    while (row_index + 1 < rows.size() && at >= rows[row_index].end() - kEpsilon) {
      row_index++;
      clip = Clip();          // the previous item's decoder goes with it
      clip_open = false;
    }
    const Placed& row = rows[row_index];

    if (!clip_open) {
      clip_open = true;
      clip_usable = false;
      QkStatus status = open_clip(engine, *row.item, clip);
      if (status == QK_OK) {
        clip.item = row.item;
        clip.out_w = out_w;
        clip.out_h = out_h;
        clip.fit = settings->fit;
        // Seek to the item's in point; the pull then finds the exact frame.
        AVStream* stream = clip.format->streams[clip.stream];
        av_seek_frame(clip.format, clip.stream,
                      static_cast<int64_t>(row.item->in_point /
                                           av_q2d(stream->time_base)),
                      AVSEEK_FLAG_BACKWARD);
        avcodec_flush_buffers(clip.decoder);
        clip_usable = true;
      } else if (status != QK_ERR_NO_TRACK) {
        // Only an item with no pictures at all is legitimately black. Anything
        // else is a failure, and swallowing it here is how a whole render comes
        // out black with nothing to say why.
        return status;
      }
      // An audio-only item still occupies its time, so it renders as black
      // rather than being skipped, which would shorten the sequence and desync
      // the mix.
    }

    if ((err = av_frame_make_writable(render.composed)) < 0) {
      return qk::fail_av(QK_ERR_ENCODE, err, "cannot write to the output frame");
    }

    bool drawn = false;
    if (clip_usable) {
      const double want = row.item->in_point + (at - row.start);
      bool have = false;
      QkStatus status = advance_to(clip, want, &have);
      if (status != QK_OK) return status;
      if (have && clip.filtered->width == out_w && clip.filtered->height == out_h) {
        av_image_copy2(render.composed->data, render.composed->linesize,
                       clip.filtered->data, clip.filtered->linesize,
                       AV_PIX_FMT_NV12, out_w, out_h);
        drawn = true;
      }
    }
    if (!drawn) fill_black(render.composed);

    // The same darkening the preview applies, from the same numbers.
    darken(render.composed, dim_at(at, total, intro_fade, outro_fade, dips));

    AVFrame* to_encode = render.composed;
    if (hardware) {
      av_frame_unref(render.uploaded);
      if ((err = av_hwframe_get_buffer(render.frames, render.uploaded, 0)) < 0) {
        return qk::fail_av(QK_ERR_ENCODE, err, "cannot get a GPU frame");
      }
      if ((err = av_hwframe_transfer_data(render.uploaded, render.composed, 0)) < 0) {
        return qk::fail_av(QK_ERR_ENCODE, err, "cannot upload the frame");
      }
      to_encode = render.uploaded;
    }
    to_encode->pts = k;

    QkStatus status = encode_video(render, to_encode);
    if (status != QK_OK) return status;
    if ((status = flush_audio(render, at)) != QK_OK) return status;

    if (progress && (k % 8 == 0)) {
      progress(static_cast<double>(k) / frames_total, QK_PHASE_VIDEO, user);
    }
  }

  QkStatus status = encode_video(render, nullptr);  // flush
  if (status != QK_OK) return status;
  if ((status = flush_audio(render, total + 1e9)) != QK_OK) return status;

  if ((err = av_write_trailer(render.out)) < 0) {
    return qk::fail_av(QK_ERR_ENCODE, err, "cannot finalise the file");
  }
  if (progress) progress(1.0, QK_PHASE_VIDEO, user);
  return QK_OK;
}

}  // extern "C"
