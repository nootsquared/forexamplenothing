import { defineConfig, type ViteDevServer, type PreviewServer } from 'vite';
import { execSync } from 'node:child_process';
import { attachRelay } from './server/relay.mjs';

// Version straight off the git ledger: 1.<large changes>.<commits since the
// last large one>. MAJORS counts the feature rounds by hand; when you commit
// a new large round, bump MAJORS and set LAST_MAJOR_TOTAL to the new commit
// count — every fix commit after it raises the third number on its own.
const MAJORS = 21;
const LAST_MAJOR_TOTAL = 41; // rev-list count at the tutorial round
const commitCount = (() => {
  try { return parseInt(execSync('git rev-list --count HEAD').toString().trim(), 10); }
  catch { return LAST_MAJOR_TOTAL; }
})();
const GAME_VERSION = `1.${MAJORS}.${Math.max(0, commitCount - LAST_MAJOR_TOTAL)}`;

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
  define: { __GAME_VERSION__: JSON.stringify(GAME_VERSION) },
  plugins: [relayPlugin],
});
