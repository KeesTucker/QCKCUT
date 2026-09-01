import { join } from 'node:path';

export const FIXTURE_DIR = join(import.meta.dirname, '..', '.fixtures');

// Every clip uses a 2-second GOP, so seeking has to hunt a keyframe and decode
// forward the way a real recording does. An all-keyframe clip would make the
// scrubbing tests pass for the wrong reason.
export const FIXTURES = {
  land: { seconds: 6, fps: 30, width: 640, height: 360, keyFrameInterval: 2 },
  port: { seconds: 4, fps: 30, width: 360, height: 640, keyFrameInterval: 2 },
  hd: { seconds: 10, fps: 30, width: 1280, height: 720, keyFrameInterval: 2 },
};
