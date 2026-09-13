// Turning a range into an MP4, on the GPU.
//
// Two paths, and which one runs matters a great deal. When the output asks for
// nothing the source does not already provide, packets are copied straight
// across: no decode, no encode, no quality loss, and it finishes about as fast
// as the disk allows. That is the native equivalent of the original's
// passthrough, and it is the common case for "cut this bit out".
//
// Otherwise the range is decoded on NVDEC and re-encoded on NVENC. Frames stay
// in GPU memory the whole way: the decoder hands out AV_PIX_FMT_CUDA surfaces
// and the encoder takes them directly, so nothing crosses the PCIe bus except
// the finished bitstream.

#include "internal.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <string>
#include <vector>

namespace {

const char* nvenc_name(QkCodec codec) {
  switch (codec) {
    case QK_CODEC_H264: return "h264_nvenc";
    case QK_CODEC_HEVC: return "hevc_nvenc";
    case QK_CODEC_AV1: return "av1_nvenc";
    default: return nullptr;
  }
}

/** Everything one export needs, so the cleanup is in one place. */
struct Job {
  AVFormatContext* in = nullptr;
  AVFormatContext* out = nullptr;
  AVCodecContext* decoder = nullptr;
  AVCodecContext* encoder = nullptr;
  AVBufferRef* frames_ctx = nullptr;
  AVPacket* packet = nullptr;
  AVFrame* frame = nullptr;
  int video_in = -1;
  int audio_in = -1;
  int video_out = -1;
  int audio_out = -1;

  ~Job() {
    if (packet) av_packet_free(&packet);
    if (frame) av_frame_free(&frame);
    if (decoder) avcodec_free_context(&decoder);
    if (encoder) avcodec_free_context(&encoder);
    if (frames_ctx) av_buffer_unref(&frames_ctx);
    if (out) {
      if (out->pb && !(out->oformat->flags & AVFMT_NOFILE)) avio_closep(&out->pb);
      avformat_free_context(out);
    }
    if (in) avformat_close_input(&in);
  }
};

/** True when the settings ask for nothing that would force a re-encode. */
bool can_remux(const QkOutputSettings* s, AVStream* video) {
  if (!s) return true;
  if (s->fps > 0) return false;
  if (s->width > 0 && s->width != video->codecpar->width) return false;
  if (s->height > 0 && s->height != video->codecpar->height) return false;
  if (s->bitrate > 0) return false;
  // A requested codec that the source already is costs nothing to keep.
  const AVCodecID wanted = qk::codec_id_of(s->codec);
  if (wanted != AV_CODEC_ID_NONE && wanted != video->codecpar->codec_id) return false;
  return true;
}

/** Copy a stream's parameters into a new output stream. */
int add_copied_stream(Job& job, AVStream* in_stream, int* out_index) {
  AVStream* out_stream = avformat_new_stream(job.out, nullptr);
  if (!out_stream) return AVERROR(ENOMEM);
  int err = avcodec_parameters_copy(out_stream->codecpar, in_stream->codecpar);
  if (err < 0) return err;
  out_stream->codecpar->codec_tag = 0;  // let the muxer pick a tag it accepts
  out_stream->time_base = in_stream->time_base;
  *out_index = out_stream->index;
  return 0;
}

/**
 * Remux the range: read packets, keep the ones inside it, rebase their stamps
 * to zero and write them out.
 *
 * Video is cut at keyframes, because a range that starts mid-GOP has no
 * self-contained first frame and every player would show the tear. So the cut
 * lands on the keyframe at or before `start`, which is what the user sees when
 * a trim snaps slightly earlier than where they dropped it.
 */
QkStatus remux(QkEngine* engine, Job& job, double start, double end,
               QkProgressFn progress, void* user) {
  const double span = std::max(1e-6, end - start);

  int err = avformat_write_header(job.out, nullptr);
  if (err < 0) return qk::fail_av(QK_ERR_ENCODE, err, "cannot write the header");

  // Seek on the video stream when there is one: its keyframes are what the cut
  // has to land on.
  const int seek_stream = job.video_in >= 0 ? job.video_in : job.audio_in;
  const AVRational seek_tb = job.in->streams[seek_stream]->time_base;
  err = av_seek_frame(job.in, seek_stream, static_cast<int64_t>(start / av_q2d(seek_tb)),
                      AVSEEK_FLAG_BACKWARD);
  if (err < 0) return qk::fail_av(QK_ERR_SEEK, err, "cannot seek to %.3fs", start);

  // Each stream is rebased by its own first kept packet, so audio and video stay
  // in the relationship they had rather than both being shifted by the video's
  // keyframe.
  int64_t offset[2] = {AV_NOPTS_VALUE, AV_NOPTS_VALUE};
  bool started = false;

  for (;;) {
    if (engine->cancelled.load()) return qk::fail(QK_ERR_CANCELLED, "export cancelled");

    av_packet_unref(job.packet);
    err = av_read_frame(job.in, job.packet);
    if (err == AVERROR_EOF) break;
    if (err < 0) return qk::fail_av(QK_ERR_ENCODE, err, "read failed");

    const int index = job.packet->stream_index;
    int slot;
    int out_index;
    if (index == job.video_in) { slot = 0; out_index = job.video_out; }
    else if (index == job.audio_in) { slot = 1; out_index = job.audio_out; }
    else continue;
    if (out_index < 0) continue;

    AVStream* in_stream = job.in->streams[index];
    AVStream* out_stream = job.out->streams[out_index];
    const double at = job.packet->pts != AV_NOPTS_VALUE
                          ? job.packet->pts * av_q2d(in_stream->time_base)
                          : 0.0;

    if (at >= end) {
      // Video past the end means the picture is done; keep going only if audio
      // still has something to contribute.
      if (slot == 0) {
        job.video_out = -1;
        if (job.audio_out < 0) break;
      }
      continue;
    }
    // Drop the run-up between the keyframe and the requested start for audio,
    // but keep it for video: those frames are what the first visible frame is
    // built from.
    if (slot == 1 && at < start) continue;

    if (offset[slot] == AV_NOPTS_VALUE) {
      offset[slot] = job.packet->pts != AV_NOPTS_VALUE ? job.packet->pts : 0;
    }

    job.packet->stream_index = out_index;
    if (job.packet->pts != AV_NOPTS_VALUE) job.packet->pts -= offset[slot];
    if (job.packet->dts != AV_NOPTS_VALUE) job.packet->dts -= offset[slot];
    av_packet_rescale_ts(job.packet, in_stream->time_base, out_stream->time_base);
    job.packet->pos = -1;

    err = av_interleaved_write_frame(job.out, job.packet);
    if (err < 0) return qk::fail_av(QK_ERR_ENCODE, err, "write failed");
    started = true;

    if (progress && slot == 0) {
      progress(std::min(1.0, std::max(0.0, (at - start) / span)), QK_PHASE_VIDEO, user);
    }
  }

  if (!started) return qk::fail(QK_ERR_ENCODE, "the range holds no packets");
  err = av_write_trailer(job.out);
  if (err < 0) return qk::fail_av(QK_ERR_ENCODE, err, "cannot finalise the file");
  if (progress) progress(1.0, QK_PHASE_VIDEO, user);
  return QK_OK;
}

/** Set up NVDEC for the input's video stream. */
QkStatus open_decoder(QkEngine* engine, Job& job) {
  AVStream* stream = job.in->streams[job.video_in];
  const AVCodec* codec = avcodec_find_decoder(stream->codecpar->codec_id);
  if (!codec) return qk::fail(QK_ERR_DECODE, "no decoder for this video");

  job.decoder = avcodec_alloc_context3(codec);
  if (!job.decoder) return qk::fail(QK_ERR_DECODE, "out of memory");
  avcodec_parameters_to_context(job.decoder, stream->codecpar);
  job.decoder->pkt_timebase = stream->time_base;
  if (engine->cuda) job.decoder->hw_device_ctx = av_buffer_ref(engine->hw_device);

  int err = avcodec_open2(job.decoder, codec, nullptr);
  if (err < 0) return qk::fail_av(QK_ERR_DECODE, err, "cannot open the decoder");
  return QK_OK;
}

/** Set up NVENC, sharing the decoder's frame pool so nothing leaves the GPU. */
QkStatus open_encoder(QkEngine* engine, Job& job, const QkOutputSettings* s,
                      AVRational time_base, AVRational frame_rate) {
  const char* name = nvenc_name(s->codec);
  const AVCodec* codec = name ? avcodec_find_encoder_by_name(name) : nullptr;
  if (!codec) {
    // Falling back would silently turn a hardware export into a software one,
    // which on a long sequence is the difference between a minute and an hour.
    // Better to say so.
    return qk::fail(QK_ERR_ENCODE, "%s is not available in this FFmpeg build",
                    name ? name : "that encoder");
  }

  job.encoder = avcodec_alloc_context3(codec);
  if (!job.encoder) return qk::fail(QK_ERR_ENCODE, "out of memory");

  job.encoder->width = s->width > 0 ? s->width : job.decoder->width;
  job.encoder->height = s->height > 0 ? s->height : job.decoder->height;
  job.encoder->time_base = time_base;
  job.encoder->framerate = frame_rate;
  job.encoder->pix_fmt = AV_PIX_FMT_CUDA;
  job.encoder->bit_rate = s->bitrate > 0 ? s->bitrate : 0;
  if (!job.encoder->bit_rate) {
    // NVENC's constant-quality mode, which gives a sane file size without the
    // caller having to guess a bitrate for an unknown resolution.
    av_opt_set(job.encoder->priv_data, "rc", "vbr", 0);
    av_opt_set(job.encoder->priv_data, "cq", "21", 0);
    av_opt_set(job.encoder->priv_data, "preset", "p5", 0);
  }
  if (job.out->oformat->flags & AVFMT_GLOBALHEADER) {
    job.encoder->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;
  }

  // The encoder needs a frame pool describing the surfaces it will be handed.
  // When the sizes match, the decoder's own pool is reused and the whole path is
  // zero copy; when they differ, a fresh pool is made and the scale happens on
  // the GPU.
  if (job.decoder->hw_frames_ctx && job.encoder->width == job.decoder->width &&
      job.encoder->height == job.decoder->height) {
    job.encoder->hw_frames_ctx = av_buffer_ref(job.decoder->hw_frames_ctx);
  } else if (engine->cuda) {
    job.frames_ctx = av_hwframe_ctx_alloc(engine->hw_device);
    if (!job.frames_ctx) return qk::fail(QK_ERR_ENCODE, "cannot allocate a frame pool");
    auto* ctx = reinterpret_cast<AVHWFramesContext*>(job.frames_ctx->data);
    ctx->format = AV_PIX_FMT_CUDA;
    ctx->sw_format = AV_PIX_FMT_NV12;
    ctx->width = job.encoder->width;
    ctx->height = job.encoder->height;
    ctx->initial_pool_size = 32;
    int err = av_hwframe_ctx_init(job.frames_ctx);
    if (err < 0) return qk::fail_av(QK_ERR_ENCODE, err, "cannot initialise the frame pool");
    job.encoder->hw_frames_ctx = av_buffer_ref(job.frames_ctx);
  }

  int err = avcodec_open2(job.encoder, codec, nullptr);
  if (err < 0) return qk::fail_av(QK_ERR_ENCODE, err, "cannot open %s", name);
  return QK_OK;
}

/** Push one frame (or null to flush) through the encoder and write what comes out. */
QkStatus drain_encoder(Job& job, AVFrame* frame) {
  int err = avcodec_send_frame(job.encoder, frame);
  if (err < 0 && err != AVERROR_EOF) {
    return qk::fail_av(QK_ERR_ENCODE, err, "the encoder rejected a frame");
  }
  for (;;) {
    av_packet_unref(job.packet);
    err = avcodec_receive_packet(job.encoder, job.packet);
    if (err == AVERROR(EAGAIN) || err == AVERROR_EOF) return QK_OK;
    if (err < 0) return qk::fail_av(QK_ERR_ENCODE, err, "encode failed");

    job.packet->stream_index = job.video_out;
    av_packet_rescale_ts(job.packet, job.encoder->time_base,
                         job.out->streams[job.video_out]->time_base);
    err = av_interleaved_write_frame(job.out, job.packet);
    if (err < 0) return qk::fail_av(QK_ERR_ENCODE, err, "write failed");
  }
}

/**
 * Decode the range on NVDEC and re-encode it on NVENC, keeping the source's
 * audio as it is.
 *
 * The awkward part is ordering. The encoder cannot be opened until the decoder
 * has produced a frame, because `hw_frames_ctx` describing the GPU surfaces
 * does not exist before then; and the header cannot be written until the
 * encoder is open. But audio packets start arriving before the first video
 * frame in range does. So those are held until the header goes out and then
 * flushed in order. The run-up is short, so the hold is bounded.
 */
QkStatus transcode(QkEngine* engine, Job& job, double start, double end,
                   const QkOutputSettings* s, QkProgressFn progress, void* user) {
  const double span = std::max(1e-6, end - start);
  AVStream* in_stream = job.in->streams[job.video_in];

  QkStatus status = open_decoder(engine, job);
  if (status != QK_OK) return status;

  AVStream* out_stream = avformat_new_stream(job.out, nullptr);
  if (!out_stream) return qk::fail(QK_ERR_ENCODE, "cannot add the video stream");
  job.video_out = out_stream->index;

  const AVRational tb = in_stream->time_base;
  int err = av_seek_frame(job.in, job.video_in,
                          static_cast<int64_t>(start / av_q2d(tb)), AVSEEK_FLAG_BACKWARD);
  if (err < 0) return qk::fail_av(QK_ERR_SEEK, err, "cannot seek to %.3fs", start);

  const AVRational frame_rate = s->fps > 0
      ? av_d2q(s->fps, 1000000)
      : (in_stream->avg_frame_rate.num ? in_stream->avg_frame_rate : AVRational{30, 1});
  const AVRational enc_tb = av_inv_q(frame_rate);

  bool header_written = false;
  int64_t first_pts = AV_NOPTS_VALUE;
  int64_t audio_offset = AV_NOPTS_VALUE;
  std::vector<AVPacket*> pending;  // audio held until the header is out

  // Cleanup for the held packets on every exit, including the failure ones.
  struct Holder {
    std::vector<AVPacket*>& packets;
    ~Holder() { for (AVPacket* p : packets) av_packet_free(&p); }
  } holder{pending};

  /** Write one audio packet, rebased onto the range's start. */
  auto write_audio = [&](AVPacket* pkt) -> QkStatus {
    AVStream* a_in = job.in->streams[job.audio_in];
    AVStream* a_out = job.out->streams[job.audio_out];
    if (audio_offset == AV_NOPTS_VALUE) {
      audio_offset = pkt->pts != AV_NOPTS_VALUE ? pkt->pts : 0;
    }
    pkt->stream_index = job.audio_out;
    if (pkt->pts != AV_NOPTS_VALUE) pkt->pts -= audio_offset;
    if (pkt->dts != AV_NOPTS_VALUE) pkt->dts -= audio_offset;
    av_packet_rescale_ts(pkt, a_in->time_base, a_out->time_base);
    pkt->pos = -1;
    int e = av_interleaved_write_frame(job.out, pkt);
    return e < 0 ? qk::fail_av(QK_ERR_ENCODE, e, "audio write failed") : QK_OK;
  };

  bool eof = false;
  while (!eof) {
    if (engine->cancelled.load()) return qk::fail(QK_ERR_CANCELLED, "export cancelled");

    av_packet_unref(job.packet);
    err = av_read_frame(job.in, job.packet);
    if (err == AVERROR_EOF) {
      avcodec_send_packet(job.decoder, nullptr);  // flush
      eof = true;
    } else if (err < 0) {
      return qk::fail_av(QK_ERR_ENCODE, err, "read failed");
    } else if (job.packet->stream_index == job.audio_in && job.audio_out >= 0) {
      const double at = job.packet->pts != AV_NOPTS_VALUE
                            ? job.packet->pts * av_q2d(job.in->streams[job.audio_in]->time_base)
                            : 0.0;
      if (at >= start - 1e-6 && at < end) {
        if (header_written) {
          status = write_audio(job.packet);
          if (status != QK_OK) return status;
        } else {
          AVPacket* held = av_packet_clone(job.packet);
          if (held) pending.push_back(held);
        }
      }
      continue;
    } else if (job.packet->stream_index != job.video_in) {
      continue;
    } else {
      err = avcodec_send_packet(job.decoder, job.packet);
      if (err < 0 && err != AVERROR(EAGAIN)) {
        return qk::fail_av(QK_ERR_DECODE, err, "the decoder rejected a packet");
      }
    }

    for (;;) {
      av_frame_unref(job.frame);
      err = avcodec_receive_frame(job.decoder, job.frame);
      if (err == AVERROR(EAGAIN)) break;
      if (err == AVERROR_EOF) { eof = true; break; }
      if (err < 0) return qk::fail_av(QK_ERR_DECODE, err, "decode failed");

      const double at = job.frame->pts != AV_NOPTS_VALUE ? job.frame->pts * av_q2d(tb) : 0.0;
      if (at < start - 1e-6) continue;   // the run-up from the keyframe
      if (at >= end) { eof = true; break; }

      if (!header_written) {
        status = open_encoder(engine, job, s, enc_tb, frame_rate);
        if (status != QK_OK) return status;
        err = avcodec_parameters_from_context(out_stream->codecpar, job.encoder);
        if (err < 0) return qk::fail_av(QK_ERR_ENCODE, err, "cannot describe the stream");
        out_stream->time_base = enc_tb;
        err = avformat_write_header(job.out, nullptr);
        if (err < 0) return qk::fail_av(QK_ERR_ENCODE, err, "cannot write the header");
        header_written = true;

        for (AVPacket* held : pending) {
          status = write_audio(held);
          if (status != QK_OK) return status;
        }
        for (AVPacket*& held : pending) av_packet_free(&held);
        pending.clear();
      }

      // Rebased so the range starts at zero, and stamped on the encoder's own
      // clock rather than the source's.
      if (first_pts == AV_NOPTS_VALUE) first_pts = job.frame->pts;
      const double elapsed = (job.frame->pts - first_pts) * av_q2d(tb);
      job.frame->pts = static_cast<int64_t>(std::llround(elapsed / av_q2d(enc_tb)));
      job.frame->pkt_dts = AV_NOPTS_VALUE;

      status = drain_encoder(job, job.frame);
      if (status != QK_OK) return status;

      if (progress) {
        progress(std::min(1.0, std::max(0.0, (at - start) / span)), QK_PHASE_VIDEO, user);
      }
    }
  }

  if (!header_written) return qk::fail(QK_ERR_ENCODE, "the range holds no frames");

  status = drain_encoder(job, nullptr);  // flush
  if (status != QK_OK) return status;

  err = av_write_trailer(job.out);
  if (err < 0) return qk::fail_av(QK_ERR_ENCODE, err, "cannot finalise the file");
  if (progress) progress(1.0, QK_PHASE_VIDEO, user);
  return QK_OK;
}

}  // namespace

extern "C" {

QkStatus qk_export_clip(QkEngine* engine, const char* in_path, const char* out_path,
                        double start, double end, const QkOutputSettings* settings,
                        QkProgressFn progress, void* user) {
  if (!engine || !in_path || !out_path) return qk::fail(QK_ERR_ARG, "missing paths");
  if (!(end > start)) return qk::fail(QK_ERR_ARG, "the range is empty");

  engine->cancelled.store(false);
  Job job;

  int err = avformat_open_input(&job.in, in_path, nullptr, nullptr);
  if (err < 0) return qk::fail_av(QK_ERR_OPEN, err, "%s: cannot open", in_path);
  if ((err = avformat_find_stream_info(job.in, nullptr)) < 0) {
    return qk::fail_av(QK_ERR_OPEN, err, "%s: cannot read stream info", in_path);
  }

  job.video_in = av_find_best_stream(job.in, AVMEDIA_TYPE_VIDEO, -1, -1, nullptr, 0);
  job.audio_in = av_find_best_stream(job.in, AVMEDIA_TYPE_AUDIO, -1, -1, nullptr, 0);
  if (job.video_in < 0 && job.audio_in < 0) {
    return qk::fail(QK_ERR_NO_TRACK, "%s: no video or audio track", in_path);
  }

  err = avformat_alloc_output_context2(&job.out, nullptr, nullptr, out_path);
  if (err < 0 || !job.out) {
    return qk::fail_av(QK_ERR_OPEN, err, "%s: cannot create the output", out_path);
  }

  job.packet = av_packet_alloc();
  job.frame = av_frame_alloc();
  if (!job.packet || !job.frame) return qk::fail(QK_ERR_ENCODE, "out of memory");

  const bool passthrough =
      job.video_in < 0 || can_remux(settings, job.in->streams[job.video_in]);

  // The source's audio is kept untouched either way: it is already at the right
  // rate and the trim does not change it, so re-encoding it would only lose
  // quality. This is the same choice the original made for a single clip.
  if (passthrough && job.video_in >= 0) {
    if ((err = add_copied_stream(job, job.in->streams[job.video_in], &job.video_out)) < 0) {
      return qk::fail_av(QK_ERR_ENCODE, err, "cannot copy the video stream");
    }
  }
  if (job.audio_in >= 0) {
    if ((err = add_copied_stream(job, job.in->streams[job.audio_in], &job.audio_out)) < 0) {
      return qk::fail_av(QK_ERR_ENCODE, err, "cannot copy the audio stream");
    }
  }

  if (!(job.out->oformat->flags & AVFMT_NOFILE)) {
    err = avio_open(&job.out->pb, out_path, AVIO_FLAG_WRITE);
    if (err < 0) return qk::fail_av(QK_ERR_OPEN, err, "%s: cannot write there", out_path);
  }

  QkStatus status = passthrough
      ? remux(engine, job, start, end, progress, user)
      : transcode(engine, job, start, end, settings, progress, user);

  return status;
}

}  // extern "C"
