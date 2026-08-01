import { defineConfig, type ViteDevServer, type PreviewServer } from 'vite';
import { attachRelay } from './server/relay.mjs';

// The multiplayer relay rides the dev/preview server itself: the host runs
// `pnpm dev`, friends open http://<host-ip>:5173/ and every client's
// websocket meets at /mp. Self-hosting IS starting the game.
const relayPlugin = {
  name: 'golazo-mp-relay',
  configureServer(server: ViteDevServer) {
    if (server.httpServer) attachRelay(server.httpServer);
  },
  configurePreviewServer(server: PreviewServer) {
    if (server.httpServer) attachRelay(server.httpServer);
  },
};

export default defineConfig({
  server: { port: 5173, strictPort: false, host: true },
  build: { target: 'es2022' },
  plugins: [relayPlugin],
});
