// Checks the playback clock without making a sound: silence exercises the ring
// buffer, the thread and the latency correction exactly as real audio does.

#include "qckcut_engine.h"

#include <chrono>
#include <cstdio>
#include <thread>
#include <vector>

int main() {
  QkPlayer* player = qk_player_create();
  if (!player) {
    fprintf(stderr, "no audio device: %s\n", qk_last_error());
    return 1;
  }

  const int rate = 48000;
  std::vector<float> silence(rate * 2, 0.0f);  // one second, stereo

  qk_player_flush(player, 0.0);

  const auto started = std::chrono::steady_clock::now();
  int64_t queued_total = 0;

  // Two seconds of audio, topped up the way the UI will do it rather than
  // written in one lump, so the non-blocking write path is what is tested.
  while (queued_total < rate * 2) {
    const int32_t took = qk_player_write(player, silence.data(),
                                         static_cast<int32_t>(rate / 10));
    queued_total += took;
    if (took == 0) std::this_thread::sleep_for(std::chrono::milliseconds(10));
  }

  double last = -1;
  for (int i = 0; i < 25; i++) {
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
    const double clock = qk_player_clock(player);
    const double wall = std::chrono::duration<double>(
                            std::chrono::steady_clock::now() - started).count();
    if (i % 5 == 0) {
      printf("  wall %5.2fs   audio clock %5.2fs   queued %6d\n", wall, clock,
             qk_player_queued(player));
    }
    if (clock < last - 1e-6) {
      fprintf(stderr, "clock went backwards: %f then %f\n", last, clock);
      qk_player_destroy(player);
      return 1;
    }
    last = clock;
  }

  const double wall = std::chrono::duration<double>(
                          std::chrono::steady_clock::now() - started).count();
  printf("after %.2fs of wall time the clock reads %.2fs\n", wall, last);

  // The clock must track the wall while there is audio to play, and must not
  // run past what was queued.
  const bool sane = last > 1.0 && last <= 2.2;
  printf("%s\n", sane ? "clock tracks playback" : "CLOCK IS WRONG");

  qk_player_flush(player, 7.5);
  printf("after a flush to 7.5s the clock reads %.2fs\n", qk_player_clock(player));

  qk_player_destroy(player);
  return sane ? 0 : 1;
}
