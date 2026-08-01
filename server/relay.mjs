import { WebSocketServer } from 'ws';

// The party line: a dumb WebSocket relay with rooms. It holds NO game state —
// the host's browser tab is the authority; this just carries envelopes:
//   guest → host   {t:'from', seat, msg}
//   host  → guest  send {t:'to', seat, msg} or {t:'broadcast', msg}
// Rooms die with their host. Codes are four friendly letters.

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ'; // no lookalikes

function makeCode(taken) {
  for (let tries = 0; tries < 64; tries++) {
    let code = '';
    for (let i = 0; i < 4; i++) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    if (!taken.has(code)) return code;
  }
  return 'Z' + Math.floor(Math.random() * 1000);
}

export function attachRelay(httpServer, path = '/mp') {
  const wss = new WebSocketServer({ noServer: true });
  const rooms = new Map(); // code → { host: ws, guests: Map<seatId, ws>, nextSeat }

  httpServer.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://x');
    } catch {
      return;
    }
    if (url.pathname !== path) return;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
  });

  const send = (ws, obj) => {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  };

  wss.on('connection', (ws) => {
    let role = null;   // 'host' | 'guest'
    let room = null;   // room record
    let code = null;
    let seat = 0;

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }

      // First message decides who you are
      if (!role && msg.t === 'host') {
        role = 'host';
        code = makeCode(rooms);
        room = { host: ws, guests: new Map(), nextSeat: 1 };
        rooms.set(code, room);
        send(ws, { t: 'hosted', code });
        return;
      }
      if (!role && msg.t === 'join') {
        const r = rooms.get(String(msg.code ?? '').toUpperCase());
        if (!r) return send(ws, { t: 'no-room' });
        role = 'guest';
        room = r;
        seat = r.nextSeat++;
        r.guests.set(seat, ws);
        send(ws, { t: 'joined', seat });
        send(r.host, { t: 'peer-joined', seat, name: String(msg.name ?? 'PLAYER').slice(0, 12) });
        return;
      }
      if (!role || !room) return;

      if (role === 'guest') {
        // everything a guest says is for the host's ears
        send(room.host, { t: 'from', seat, msg });
        return;
      }
      // host speaking
      if (msg.t === 'to') send(room.guests.get(msg.seat), { t: 'msg', msg: msg.msg });
      else if (msg.t === 'broadcast') {
        for (const g of room.guests.values()) send(g, { t: 'msg', msg: msg.msg });
      }
    });

    ws.on('close', () => {
      if (!room) return;
      if (role === 'host') {
        for (const g of room.guests.values()) send(g, { t: 'room-closed' });
        for (const g of room.guests.values()) g.close();
        if (code) rooms.delete(code);
      } else if (role === 'guest') {
        room.guests.delete(seat);
        send(room.host, { t: 'peer-left', seat });
      }
    });
  });

  return wss;
}
