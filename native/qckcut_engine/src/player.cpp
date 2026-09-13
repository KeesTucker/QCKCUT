// Audio output, and the clock that comes with it.
//
// PulseAudio's simple API, which PipeWire serves too, so this is one path that
// works on every desktop Linux worth naming. It blocks on write, which is why
// the device is fed from a thread of its own and the caller only ever touches a
// ring buffer.
//
// The clock is the point of the whole file. `qk_player_clock` reports what has
// actually been *heard*, which is what has been handed to the device minus what
// is still sitting in it. Pacing the picture against that rather than against a
// timer is what stops sound and picture drifting apart.

#include "internal.h"

#include <atomic>
#include <condition_variable>
#include <cstring>
#include <mutex>
#include <thread>
#include <vector>

#include <pulse/error.h>
#include <pulse/simple.h>

namespace {
constexpr int kChannels = qk::kAudioChannels;
constexpr int kRate = qk::kAudioRate;
// Four seconds of headroom. Enough that a slow decode does not gap the sound,
// small enough that a seek does not have seconds of stale audio to throw away.
constexpr size_t kCapacityFrames = kRate * 4;
// What goes to the device in one write. Smaller means a tighter response to
// pause and flush; larger means fewer syscalls. 20ms is the usual compromise.
constexpr size_t kChunkFrames = kRate / 50;
}  // namespace

struct QkPlayer {
  pa_simple* device = nullptr;

  std::vector<float> ring;      // interleaved stereo, kCapacityFrames * kChannels
  size_t head = 0;              // where the writer puts frames
  size_t tail = 0;              // where the thread takes them
  size_t filled = 0;            // frames currently in the ring

  std::mutex lock;
  std::condition_variable wake;
  std::thread worker;
  std::atomic<bool> running{true};
  std::atomic<bool> paused{false};

  // Frames handed to the device since the last flush, and where that flush put
  // the clock. Together these say what time it is.
  std::atomic<int64_t> written{0};
  std::atomic<double> origin{0};
};

namespace {

void run(QkPlayer* player) {
  std::vector<float> chunk(kChunkFrames * kChannels);

  while (player->running.load()) {
    size_t frames = 0;
    {
      std::unique_lock<std::mutex> held(player->lock);
      player->wake.wait(held, [player] {
        return !player->running.load() || (player->filled > 0 && !player->paused.load());
      });
      if (!player->running.load()) return;

      frames = std::min(player->filled, kChunkFrames);
      for (size_t i = 0; i < frames * kChannels; i++) {
        chunk[i] = player->ring[(player->tail * kChannels + i) % player->ring.size()];
      }
      player->tail = (player->tail + frames) % kCapacityFrames;
      player->filled -= frames;
    }

    if (frames == 0) continue;

    int error = 0;
    // Blocking, and deliberately outside the lock: the writer must be able to
    // top the ring up while the device is busy, which is the whole reason for
    // the ring in the first place.
    if (pa_simple_write(player->device, chunk.data(), frames * kChannels * sizeof(float),
                        &error) < 0) {
      // A device that has gone away should stop the thread rather than spin on
      // it. The clock stops with it, and playback stalls visibly.
      player->running.store(false);
      return;
    }
    player->written.fetch_add(static_cast<int64_t>(frames));
  }
}

}  // namespace

extern "C" {

QkPlayer* qk_player_create(void) {
  pa_sample_spec spec = {};
  spec.format = PA_SAMPLE_FLOAT32NE;
  spec.rate = kRate;
  spec.channels = kChannels;

  // A short target latency: this is an editor, and the delay between pressing
  // play and hearing it is the thing being judged.
  pa_buffer_attr attr = {};
  attr.maxlength = static_cast<uint32_t>(-1);
  attr.tlength = static_cast<uint32_t>(kRate / 10 * kChannels * sizeof(float));
  attr.prebuf = static_cast<uint32_t>(-1);
  attr.minreq = static_cast<uint32_t>(-1);
  attr.fragsize = static_cast<uint32_t>(-1);

  int error = 0;
  pa_simple* device = pa_simple_new(nullptr, "QCKCUT", PA_STREAM_PLAYBACK, nullptr,
                                    "preview", &spec, nullptr, &attr, &error);
  if (!device) {
    qk::fail(QK_ERR_OPEN, "cannot open the audio device: %s", pa_strerror(error));
    return nullptr;
  }

  auto* player = new QkPlayer();
  player->device = device;
  player->ring.assign(kCapacityFrames * kChannels, 0.0f);
  player->worker = std::thread(run, player);
  return player;
}

void qk_player_destroy(QkPlayer* player) {
  if (!player) return;
  player->running.store(false);
  player->wake.notify_all();
  if (player->worker.joinable()) player->worker.join();
  if (player->device) {
    pa_simple_free(player->device);
  }
  delete player;
}

int32_t qk_player_write(QkPlayer* player, const float* frames, int32_t count) {
  if (!player || !frames || count <= 0) return 0;

  std::lock_guard<std::mutex> held(player->lock);
  const size_t room = kCapacityFrames - player->filled;
  const size_t take = std::min(room, static_cast<size_t>(count));
  for (size_t i = 0; i < take * kChannels; i++) {
    player->ring[(player->head * kChannels + i) % player->ring.size()] = frames[i];
  }
  player->head = (player->head + take) % kCapacityFrames;
  player->filled += take;
  player->wake.notify_one();
  return static_cast<int32_t>(take);
}

double qk_player_clock(QkPlayer* player) {
  if (!player) return 0;
  const double handed = static_cast<double>(player->written.load()) / kRate;

  // What is still inside the device has been written but not heard, so it does
  // not count yet. Without this the picture would run ahead of the sound by the
  // device's buffer, which is exactly the drift this is meant to prevent.
  int error = 0;
  const pa_usec_t latency = pa_simple_get_latency(player->device, &error);
  const double behind = error == 0 ? latency / 1e6 : 0.0;

  const double at = player->origin.load() + handed - behind;
  return at < player->origin.load() ? player->origin.load() : at;
}

int32_t qk_player_queued(QkPlayer* player) {
  if (!player) return 0;
  std::lock_guard<std::mutex> held(player->lock);
  return static_cast<int32_t>(player->filled);
}

void qk_player_flush(QkPlayer* player, double at) {
  if (!player) return;
  {
    std::lock_guard<std::mutex> held(player->lock);
    player->head = player->tail = player->filled = 0;
  }
  // Drop what the device is still holding too, or a seek would play the old
  // position for as long as its buffer lasts.
  int error = 0;
  pa_simple_flush(player->device, &error);
  player->written.store(0);
  player->origin.store(at);
}

void qk_player_pause(QkPlayer* player, int32_t paused) {
  if (!player) return;
  player->paused.store(paused != 0);
  player->wake.notify_all();
}

}  // extern "C"
