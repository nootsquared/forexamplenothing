import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, Server } from 'node:http';
import { AddressInfo, Socket } from 'node:net';
import WebSocket from 'ws';
// @ts-expect-error plain-JS module shared with the dev server
import { attachRelay } from '../server/relay.mjs';

// One protocol, two homes: every test below runs against the in-process node
// relay, and — when RELAY_WS points at `pnpm cf:dev` — against the real
// Cloudflare Worker + Durable Object. The clients can't tell them apart;
// neither may these tests.

// A websocket that hands messages over one at a time, in order
class Wire {
  private queue: unknown[] = [];
  private waiters: ((m: unknown) => void)[] = [];
  private opened: Promise<void>;
  closed = false;
  onclose: Promise<void>;

  constructor(private ws: WebSocket) {
    this.opened = new Promise((res, rej) => {
      ws.once('open', res);
      ws.once('error', rej);
    });
    this.onclose = new Promise((res) => ws.once('close', () => {
      this.closed = true;
      res();
    }));
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw));
      const w = this.waiters.shift();
      if (w) w(m);
      else this.queue.push(m);
    });
  }

  async ready() {
    await this.opened;
    return this;
  }

  next(timeoutMs = 5000): Promise<Record<string, unknown>> {
    if (this.queue.length) return Promise.resolve(this.queue.shift() as Record<string, unknown>);
    return new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error('timed out waiting for a relay message')), timeoutMs);
      this.waiters.push((m) => {
        clearTimeout(timer);
        res(m as Record<string, unknown>);
      });
    });
  }

  send(obj: unknown) {
    this.ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
  }

  close() {
    this.ws.close();
  }

  // the raw TCP pipe under the websocket — for clients that misbehave on purpose
  private get pipe(): Socket {
    return (this.ws as unknown as { _socket: Socket })._socket;
  }

  abandon() {
    this.pipe.destroy(); // torn down mid-sentence — the lid just shut
  }

  spewGarbage() {
    this.pipe.write(Buffer.from([0x8f, 0xff, 0x13, 0x37])); // not a websocket frame
  }
}

function relaySuite(name: string, base: () => string, enabled: () => boolean) {
  describe.skipIf(!enabled())(name, () => {
    const open = (params: string) => new Wire(new WebSocket(`${base()}/mp?${params}`)).ready();
    const hostUp = async () => {
      const host = await open('role=host');
      const hosted = await host.next();
      expect(hosted.t).toBe('hosted');
      return { host, code: hosted.code as string };
    };
    const guestUp = async (code: string, name = 'ALICE') => {
      const guest = await open(`role=guest&code=${code}&name=${name}`);
      const joined = await guest.next();
      expect(joined.t).toBe('joined');
      return { guest, seat: joined.seat as number };
    };

    it('deals the host a room with a friendly code', async () => {
      const { host, code } = await hostUp();
      expect(code).toMatch(/^[A-Z0-9]{3,8}$/);
      host.close();
    });

    it('seats guests in order and announces them to the host', async () => {
      const { host, code } = await hostUp();
      const a = await guestUp(code, 'ALICE');
      expect(a.seat).toBe(1);
      expect(await host.next()).toMatchObject({ t: 'peer-joined', seat: 1, name: 'ALICE' });
      const b = await guestUp(code.toLowerCase(), 'BOB'); // codes are case-blind
      expect(b.seat).toBe(2);
      expect(await host.next()).toMatchObject({ t: 'peer-joined', seat: 2, name: 'BOB' });
      host.close();
    });

    it('turns a wrong code away with no-room', async () => {
      const guest = await open('role=guest&code=ZZZZ&name=LOST');
      expect((await guest.next()).t).toBe('no-room');
      await guest.onclose;
    });

    it('wraps guest talk for the host and unwraps host talk for guests', async () => {
      const { host, code } = await hostUp();
      const { guest } = await guestUp(code);
      await host.next(); // peer-joined
      guest.send({ t: 'claim', team: 0 });
      expect(await host.next()).toMatchObject({ t: 'from', seat: 1, msg: { t: 'claim', team: 0 } });
      host.send({ t: 'to', seat: 1, msg: { t: 'lobby', state: { code } } });
      expect(await guest.next()).toMatchObject({ t: 'msg', msg: { t: 'lobby', state: { code } } });
      host.close();
    });

    it('broadcasts reach every seat', async () => {
      const { host, code } = await hostUp();
      const { guest: a } = await guestUp(code, 'A');
      const { guest: b } = await guestUp(code, 'B');
      await host.next();
      await host.next();
      host.send({ t: 'broadcast', msg: { t: 'snap', snap: { tick: 7 } } });
      expect(await a.next()).toMatchObject({ t: 'msg', msg: { t: 'snap', snap: { tick: 7 } } });
      expect(await b.next()).toMatchObject({ t: 'msg', msg: { t: 'snap', snap: { tick: 7 } } });
      host.close();
    });

    it('answers ping with pong for both roles', async () => {
      const { host, code } = await hostUp();
      const { guest } = await guestUp(code);
      await host.next();
      host.send('{"t":"ping"}');
      expect((await host.next()).t).toBe('pong');
      guest.send('{"t":"ping"}');
      expect((await guest.next()).t).toBe('pong');
      host.close();
    });

    it('the room dies with its host', async () => {
      const { host, code } = await hostUp();
      const { guest } = await guestUp(code);
      await host.next();
      host.close();
      // guests are told and hang up on their side, no ack awaited (as
      // NetSession does — the line is already dead)...
      expect((await guest.next()).t).toBe('room-closed');
      guest.close();
      // ...and the code is stone dead afterwards
      const late = await open(`role=guest&code=${code}&name=LATE`);
      expect((await late.next()).t).toBe('no-room');
    });

    it('a leaving guest is reported, and the seat roll keeps counting', async () => {
      const { host, code } = await hostUp();
      const { guest: a } = await guestUp(code, 'A');
      await host.next();
      a.close();
      expect(await host.next()).toMatchObject({ t: 'peer-left', seat: 1 });
      const { seat } = await guestUp(code, 'B');
      expect(seat).toBe(2); // seats are never reissued
      host.close();
    });

    it('drops oversized junk without dropping the line', async () => {
      const { host, code } = await hostUp();
      const { guest } = await guestUp(code);
      await host.next();
      guest.send('{"t":"hello","name":"' + 'X'.repeat(40_000) + '"}');
      guest.send({ t: 'ready', ready: true });
      // the flood never lands; the next honest message does
      expect(await host.next()).toMatchObject({ t: 'from', seat: 1, msg: { t: 'ready', ready: true } });
      host.close();
    });

    it('a client spewing garbage frames never takes the room down', async () => {
      const { host, code } = await hostUp();
      const { guest: evil } = await guestUp(code, 'EVIL');
      await host.next(); // peer-joined
      evil.spewGarbage();
      // node hangs up on him, workerd shrugs — either way the room must keep
      // dealing seats and carrying the mail (unhandled, this KILLED the relay)
      const { guest } = await guestUp(code, 'HONEST');
      let m = await host.next();
      if (m.t === 'peer-left') m = await host.next(); // EVIL's exit, if the relay noticed
      expect(m).toMatchObject({ t: 'peer-joined', name: 'HONEST' });
      host.send({ t: 'broadcast', msg: { t: 'snap', snap: { tick: 1 } } });
      expect(await guest.next()).toMatchObject({ t: 'msg', msg: { t: 'snap', snap: { tick: 1 } } });
      host.close();
    });

    it('a guest dying without goodbye is reported, and the room lives on', async () => {
      const { host, code } = await hostUp();
      const { guest } = await guestUp(code, 'SLEEPY');
      await host.next();
      guest.abandon();
      expect(await host.next()).toMatchObject({ t: 'peer-left', seat: 1 });
      const late = await guestUp(code, 'LATE');
      expect(late.seat).toBe(2);
      host.close();
    });

    it('carries a full lobby-to-kickoff conversation', async () => {
      const { host, code } = await hostUp();
      const { guest } = await guestUp(code, 'RIVAL');
      await host.next();
      guest.send({ t: 'claim', team: 1 });
      expect(await host.next()).toMatchObject({ t: 'from', msg: { t: 'claim', team: 1 } });
      guest.send({ t: 'ready', ready: true });
      expect(await host.next()).toMatchObject({ t: 'from', msg: { t: 'ready', ready: true } });
      host.send({ t: 'broadcast', msg: { t: 'start', config: { halfLength: 120 } } });
      expect(await guest.next()).toMatchObject({ t: 'msg', msg: { t: 'start' } });
      // sixty input packets up, thirty snaps down — a second of match traffic
      for (let i = 0; i < 60; i++) guest.send({ t: 'input', input: { mx: 1, my: 0, sp: false, ch: false, kp: 0, kx: 0, ky: 0, tk: false, sw: false } });
      for (let i = 0; i < 60; i++) expect((await host.next()).t).toBe('from');
      for (let i = 0; i < 30; i++) host.send({ t: 'broadcast', msg: { t: 'snap', snap: { tick: i } } });
      for (let i = 0; i < 30; i++) {
        expect(await guest.next()).toMatchObject({ t: 'msg', msg: { t: 'snap', snap: { tick: i } } });
      }
      host.close();
    });
  });
}

// Backend 1: the node relay riding the dev server, booted in-process
let server: Server;
let nodePort = 0;
beforeAll(async () => {
  server = createServer();
  attachRelay(server);
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  nodePort = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((res) => server.close(() => res())));
relaySuite('the dev relay speaks the party protocol', () => `ws://127.0.0.1:${nodePort}`, () => true);

// Backend 2: the Cloudflare Worker + Durable Object, when `pnpm cf:dev` is
// up and RELAY_WS says where (e.g. RELAY_WS=ws://127.0.0.1:8788 pnpm test)
relaySuite('the cloudflare relay speaks the party protocol', () => process.env.RELAY_WS ?? '', () => !!process.env.RELAY_WS);
