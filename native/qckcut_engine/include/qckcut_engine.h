// The native media engine behind QCKCUT.
//
// The browser original did decode, composite and encode through WebCodecs. On
// Linux there is no such thing, so this library is the replacement: FFmpeg with
// CUDA, which means NVDEC on the way in and NVENC on the way out. Frames stay on
// the GPU from decode until the point they are actually needed on the CPU.
//
// The surface is deliberately a flat C API with opaque handles, because the only
// caller is Dart's FFI and everything here has to cross that boundary. No C++
// types, no exceptions escaping, no ownership that is not spelled out.
//
// Threading: a QkSource is NOT thread safe. The Dart side keeps one per isolate
// and does its decoding off the UI isolate.

#ifndef QCKCUT_ENGINE_H
#define QCKCUT_ENGINE_H

#include <stdint.h>

#if defined(_WIN32)
#define QK_EXPORT __declspec(dllexport)
#else
#define QK_EXPORT __attribute__((visibility("default")))
#endif

#ifdef __cplusplus
extern "C" {
#endif

// ─── Status ──────────────────────────────────────────────────────────────────
// Every call that can fail returns one of these. `qk_last_error` gives the
// human sentence for the most recent failure on the calling thread, in the
// spirit of the original's "say whether this is the machine's limit or the
// file's" error text.

typedef enum {
  QK_OK = 0,
  QK_ERR_OPEN = -1,       // the container would not open
  QK_ERR_NO_TRACK = -2,   // no video and no audio
  QK_ERR_DECODE = -3,     // the decoder refused the stream
  QK_ERR_SEEK = -4,
  QK_ERR_ENCODE = -5,
  QK_ERR_CANCELLED = -6,  // stopped on purpose, the Cancelled of the original
  QK_ERR_ARG = -7,
} QkStatus;

/** The last failure on this thread, as a sentence. Never null; owned by us. */
QK_EXPORT const char* qk_last_error(void);

/** Library version string, for the about/help panel. */
QK_EXPORT const char* qk_version(void);

// ─── Engine ──────────────────────────────────────────────────────────────────
// Holds the CUDA device context. One per process is plenty: NVDEC and NVENC
// sessions are per-context, and sharing it is what lets a decoded frame be fed
// to the encoder without ever leaving the GPU.

typedef struct QkEngine QkEngine;

QK_EXPORT QkEngine* qk_engine_create(void);
QK_EXPORT void qk_engine_destroy(QkEngine* engine);

/** Non-zero when CUDA came up and NVDEC/NVENC are actually usable. */
QK_EXPORT int qk_engine_has_cuda(const QkEngine* engine);

/** The GPU's name, or "" when there is no CUDA. Owned by the engine. */
QK_EXPORT const char* qk_engine_gpu_name(const QkEngine* engine);

// ─── Capability probing ──────────────────────────────────────────────────────
// The original asked the browser at runtime what it could decode, because the
// answer was a property of the machine rather than the file. That reasoning
// survives the port intact: NVDEC's codec set differs by GPU generation, so we
// ask the driver instead of hardcoding a table.

typedef enum {
  QK_CODEC_H264 = 0,
  QK_CODEC_HEVC = 1,
  QK_CODEC_AV1 = 2,
  QK_CODEC_VP9 = 3,
  QK_CODEC_VP8 = 4,
  QK_CODEC_MPEG4 = 5,
  QK_CODEC_COUNT = 6,
} QkCodec;

/** Non-zero when this machine can hardware-decode that codec. */
QK_EXPORT int qk_can_decode(QkEngine* engine, QkCodec codec);

/** Non-zero when this machine can hardware-encode that codec. */
QK_EXPORT int qk_can_encode(QkEngine* engine, QkCodec codec);

/** The codec's display name, e.g. "HEVC / H.265". Static storage. */
QK_EXPORT const char* qk_codec_label(QkCodec codec);

// ─── Sources ─────────────────────────────────────────────────────────────────
// A source is one opened file. As in the original, it is either video (with or
// without sound) or audio-only, and anything that draws pictures must check
// `qk_source_has_video` first.

typedef struct QkSource QkSource;

typedef struct {
  double duration;     // seconds
  int32_t width;       // display width, rotation applied; 0 when audio-only
  int32_t height;
  int32_t rotation;    // 0/90/180/270, from the container's display matrix
  int32_t has_video;
  int32_t has_audio;
  int32_t sample_rate; // 0 when there is no audio
  int32_t channels;
  int32_t hw_decoded;  // non-zero when NVDEC is carrying this one
  const char* video_codec; // owned by the source, valid until close
  const char* audio_codec;
} QkSourceInfo;

/**
 * Open a file. Returns null on failure, with `qk_last_error` set.
 * Every open must be paired with a close.
 */
QK_EXPORT QkSource* qk_source_open(QkEngine* engine, const char* path);
QK_EXPORT void qk_source_close(QkSource* source);

/** Fill `out` with what the file turned out to be. */
QK_EXPORT QkStatus qk_source_info(QkSource* source, QkSourceInfo* out);

// ─── Reading pictures ────────────────────────────────────────────────────────

/**
 * Decode the frame covering `timestamp` and write it as RGBA into `out`.
 *
 * `out` must hold `width * height * 4` bytes. The picture is scaled to fit the
 * requested size with the aspect preserved and the remainder left black, which
 * is the letterboxing the original did on its canvas.
 *
 * Seeking backwards or by more than a group of pictures costs a keyframe seek
 * plus a decode up to the target; small forward steps reuse the open decoder,
 * so scrubbing forward is cheap and scrubbing backwards is not.
 */
QK_EXPORT QkStatus qk_source_frame_at(QkSource* source, double timestamp,
                                      uint8_t* out, int32_t width, int32_t height);

/**
 * The next frame in decode order, for playback. Writes RGBA into `out` and the
 * frame's presentation time into `timestamp`. Returns QK_ERR_DECODE at the end
 * of the stream.
 *
 * Playback pulls frames this way rather than calling frame_at per tick: the
 * decoder stays hot and the picture is paced by the caller against the audio
 * clock, which is the arrangement the original settled on for the same reason.
 */
QK_EXPORT QkStatus qk_source_next_frame(QkSource* source, uint8_t* out,
                                        int32_t width, int32_t height,
                                        double* timestamp);

/** Point the decoder at `timestamp` so the next `next_frame` starts there. */
QK_EXPORT QkStatus qk_source_seek(QkSource* source, double timestamp);

// ─── Thumbnails ──────────────────────────────────────────────────────────────
// Keyframes only, exactly as the original insisted: never decode a delta frame
// to fill a filmstrip tile.

#define QK_THUMB_H 88

/**
 * Decode `count` evenly spaced keyframe tiles into `out`, which must hold
 * `count * tile_width * QK_THUMB_H * 4` bytes. `tile_width` is what
 * `qk_thumb_width` returns for this source.
 */
QK_EXPORT QkStatus qk_source_thumbnails(QkSource* source, int32_t count,
                                        uint8_t* out, int32_t tile_width);

/** Tile width for a source at QK_THUMB_H tall. */
QK_EXPORT int32_t qk_thumb_width(QkSource* source);

// ─── Audio ───────────────────────────────────────────────────────────────────

/**
 * Decode the range [from, to) to interleaved stereo float32 at 48 kHz, the rate
 * the mixer works in. Returns the frame count written, or a negative QkStatus.
 * `out` must hold `capacity_frames * 2` floats.
 */
QK_EXPORT int64_t qk_source_audio(QkSource* source, double from, double to,
                                  float* out, int64_t capacity_frames);

/**
 * Peak amplitudes for drawing a waveform, streamed rather than by holding the
 * whole song decoded: a long music bed is tens of megabytes and we only ever
 * draw the peaks.
 */
QK_EXPORT QkStatus qk_source_peaks(QkSource* source, float* out, int32_t count);

// ─── Export ──────────────────────────────────────────────────────────────────

/** How progress and cancellation cross back into Dart. */
typedef void (*QkProgressFn)(double fraction, int32_t phase, void* user);

#define QK_PHASE_AUDIO 0
#define QK_PHASE_VIDEO 1

typedef struct {
  int32_t width;       // 0 to match the source
  int32_t height;
  double fps;          // 0 to keep the source's own timing
  QkCodec codec;       // NVENC target
  int64_t bitrate;     // 0 for the quality default
  int32_t fit;         // 0 contain (letterbox), 1 cover, 2 fill
} QkOutputSettings;

/**
 * Render one range of one source, the single-clip export. Where the settings
 * ask for nothing the source does not already give, packets are remuxed rather
 * than re-encoded, which is the native equivalent of the original's passthrough.
 */
QK_EXPORT QkStatus qk_export_clip(QkEngine* engine, const char* in_path,
                                  const char* out_path, double start, double end,
                                  const QkOutputSettings* settings,
                                  QkProgressFn progress, void* user);

// ─── Playback ────────────────────────────────────────────────────────────────
// The important idea here is the clock.
//
// Video paced against a wall clock is fine on its own but drifts against audio,
// because the sound card runs on its own crystal and does not agree with the
// system timer about how long a second is. So once sound is playing the audio
// clock is the master and the picture is paced against it. That is what keeps
// the two from separating over a long sequence, and it is the reason this
// player exists at all rather than a timer in Dart.
//
// The player owns a thread and a ring buffer. Writes are non-blocking: the
// caller tops the buffer up ahead of the clock and is told how much was taken,
// rather than being blocked inside the audio device.

typedef struct QkPlayer QkPlayer;

/** Open the audio device. Returns null if there is none; see `qk_last_error`. */
QK_EXPORT QkPlayer* qk_player_create(void);
QK_EXPORT void qk_player_destroy(QkPlayer* player);

/**
 * Queue interleaved stereo float at 48 kHz. Returns the number of frames
 * actually taken, which is less than asked for when the buffer is full.
 */
QK_EXPORT int32_t qk_player_write(QkPlayer* player, const float* frames, int32_t count);

/** Seconds of sound actually heard, accounting for what is still in the device. */
QK_EXPORT double qk_player_clock(QkPlayer* player);

/** Frames queued but not yet played, so the caller knows how far ahead it is. */
QK_EXPORT int32_t qk_player_queued(QkPlayer* player);

/** Drop everything queued and reset the clock to `at`. For a seek. */
QK_EXPORT void qk_player_flush(QkPlayer* player, double at);

QK_EXPORT void qk_player_pause(QkPlayer* player, int32_t paused);

// ─── Sequences ───────────────────────────────────────────────────────────────
// A single clip can be remuxed. A sequence cannot: its items come from
// different sources, with different codecs, resolutions and rotations, so every
// frame is drawn into one output-sized picture and re-encoded. The decode and
// the encode both stay on the GPU; only the compositing step comes down, and
// that is where the next optimisation is.
//
// Position is the item's index, not a stored start time. The engine lays them
// out end to end exactly as `sequence.dart` does, so the two cannot disagree
// about where a cut falls.

typedef struct {
  const char* path;     // the source file this item comes from
  double in_point;      // seconds into the source
  double out_point;

  int32_t rotate;       // 0/90/180/270, applied before the crop

  // Framing. `has_frame` of 0 means the item is left exactly as shot and the
  // project's own fit is used instead.
  int32_t has_frame;
  double zoom;
  double frame_x;       // centre, in fractions of the source
  double frame_y;

  // Sound. A muted item still occupies its time, so the picture stays in sync.
  double gain;
  int32_t muted;

  // The dip to black at this item's *start*, in seconds. Half is taken from the
  // outgoing side and half from the incoming one, so the sequence keeps its
  // length. Zero for a hard cut.
  double dip_duration;
} QkSequenceItem;

/**
 * Render a laid-out sequence to one file.
 *
 * `intro_fade` and `outro_fade` fade the very start and very end, in seconds.
 * Progress is reported for both phases: audio is mixed before any picture is
 * touched, and on a long sequence that is many seconds with nothing to show for
 * it, so the phase is reported rather than left to look like a hang.
 */
QK_EXPORT QkStatus qk_export_sequence(QkEngine* engine, const QkSequenceItem* items,
                                      int32_t count, const char* out_path,
                                      const QkOutputSettings* settings,
                                      double intro_fade, double outro_fade,
                                      QkProgressFn progress, void* user);

/** Ask a running export to stop. It ends with QK_ERR_CANCELLED. */
QK_EXPORT void qk_cancel(QkEngine* engine);
QK_EXPORT void qk_uncancel(QkEngine* engine);

#ifdef __cplusplus
}
#endif

#endif  // QCKCUT_ENGINE_H
