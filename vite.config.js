import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5173, strictPort: true },
  build: {
    // WebCodecs is the floor for this app anyway, so there is nothing to gain
    // from down-levelling the output.
    target: 'es2022',
    // The bundle is ~530kB because mediabunny is ~530kB. Splitting it would not
    // help: the app cannot show a frame without the demuxer and decoder.
    chunkSizeWarningLimit: 700,
  },
});
