import { DurableObject } from 'cloudflare:workers';

// The party line, worldwide: a Cloudflare Worker serving the built game and,
// at /mp, the same dumb relay the dev server runs — one Durable Object per
// room, found by its four-letter code, holding NO game state. The host's tab
// stays the only authority; this just carries envelopes across the planet:
//   guest → host   {t:'from', seat, msg}
//   host  → guest  send {t:'to', seat, msg} or {t:'broadcast', msg}
// Rooms die with their host. Pings answer from the edge without waking us.

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ'; // no lookalikes
const MAX_MSG_BYTES = 32_000; // snapshots run ~2KB; anything huge is not ours

function makeCode() {
  let code = '';
  for (let i = 0; i < 4; i++) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return code;
}

// Best-effort delivery: a socket caught mid-death throws on send, and one
// uncaught throw in a handler can abort a broadcast round — or the room
function post(ws, wire) {
  try {
    ws?.send(wire);
  } catch { /* already gone; close/error will bury him */ }
}

// Accept a socket just long enough to say why it's being turned away
function refuse(reason) {
  const pair = new WebSocketPair();
  const server = pair[1];
  server.accept();
  server.send(JSON.stringify({ t: reason }));
  server.close(1008, reason);
  return new Response(null, { status: 101, webSocket: pair[0] });
}

export class GolazoRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // pings bounce straight off the edge — a hibernating room never wakes
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'),
    );
  }

  hostWs() {
    return this.ctx.getWebSockets('host')[0] ?? null;
  }

  // The worker's vacancy check before it hands a fresh code to a host
  hasHost() {
    return this.hostWs() !== null;
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('golazo relay: websocket only', { status: 426 });
    }
    const url = new URL(request.url);

    if (url.searchParams.get('role') === 'host') {
      if (this.hostWs()) return refuse('room-busy'); // one armband per room
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1], ['host']);
      pair[1].serializeAttachment({ role: 'host' });
      pair[1].send(JSON.stringify({ t: 'hosted', code: url.searchParams.get('code') ?? '' }));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    const host = this.hostWs();
    if (!host) return refuse('no-room');
    const seat = (await this.ctx.storage.get('nextSeat')) ?? 1;
    await this.ctx.storage.put('nextSeat', seat + 1);
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], ['guest', `seat:${seat}`]);
    pair[1].serializeAttachment({ role: 'guest', seat });
    pair[1].send(JSON.stringify({ t: 'joined', seat }));
    post(host, JSON.stringify({
      t: 'peer-joined', seat,
      name: (url.searchParams.get('name') ?? 'PLAYER').slice(0, 12),
    }));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  webSocketMessage(ws, raw) {
    if (typeof raw !== 'string' || raw.length > MAX_MSG_BYTES) return;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return; // garbage on the wire is nobody's problem
    }
    const who = ws.deserializeAttachment() ?? {};
    if (who.role === 'guest') {
      // everything a guest says is for the host's ears
      post(this.hostWs(), JSON.stringify({ t: 'from', seat: who.seat, msg }));
      return;
    }
    if (who.role !== 'host') return;
    if (msg.t === 'to') {
      post(this.ctx.getWebSockets(`seat:${msg.seat}`)[0], JSON.stringify({ t: 'msg', msg: msg.msg }));
    } else if (msg.t === 'broadcast') {
      const wire = JSON.stringify({ t: 'msg', msg: msg.msg });
      for (const g of this.ctx.getWebSockets('guest')) post(g, wire);
    }
  }

  // The runtime reports a socket's end through close OR error, never both
  async webSocketClose(ws) {
    await this.dropSocket(ws);
  }

  async webSocketError(ws) {
    await this.dropSocket(ws);
  }

  async dropSocket(ws) {
    const who = ws.deserializeAttachment() ?? {};
    if (who.role === 'host') {
      for (const g of this.ctx.getWebSockets('guest')) {
        post(g, JSON.stringify({ t: 'room-closed' }));
        try {
          g.close(1000, 'room closed');
        } catch { /* already gone */ }
      }
      await this.ctx.storage.deleteAll(); // the room dies with its host
    } else if (who.role === 'guest') {
      post(this.hostWs(), JSON.stringify({ t: 'peer-left', seat: who.seat }));
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/mp') return env.ASSETS.fetch(request);
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('golazo relay: websocket only', { status: 426 });
    }

    if (url.searchParams.get('role') === 'host') {
      // deal fresh codes until one names an empty room (first try, in practice)
      let code = makeCode();
      for (let tries = 0; tries < 6 && (await env.ROOMS.getByName(code).hasHost()); tries++) code = makeCode();
      const target = new URL(url);
      target.searchParams.set('code', code);
      return env.ROOMS.getByName(code).fetch(new Request(target, request));
    }

    const code = (url.searchParams.get('code') ?? '').toUpperCase();
    if (!/^[A-Z0-9]{3,8}$/.test(code)) return refuse('no-room'); // garbage never mints a room
    return env.ROOMS.getByName(code).fetch(request);
  },
};
