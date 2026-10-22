// M2 集成测试（真实 ws，随机高位端口，afterAll 关闭——测试纪律：不占端口）
// 覆盖：TC-ROOM-001/002/005、TC-CHAT-001/002、TC-SEC-001、TC-NET-003（宽限内 resume）

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app';

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const UUID_C = '33333333-3333-4333-8333-333333333333';
const UUID_D = '44444444-4444-4444-8444-444444444444';
const UUID_E = '55555555-5555-4555-8555-555555555555';
const UUID_F = '66666666-6666-4666-8666-666666666666';
const UUID_G = '77777777-7777-4777-8777-777777777777';
const UUID_H = '88888888-8888-4888-8888-888888888888';
const UUID_I = '99999999-9999-4999-8999-999999999999';
const UUID_J = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const UUID_K = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

interface Msg {
  t: string;
  d: any;
}

class TestClient {
  private ws: WebSocket;
  private queue: Msg[] = [];
  private waiters: {
    pred: (m: Msg) => boolean;
    resolve: (m: Msg) => void;
    timer: NodeJS.Timeout;
  }[] = [];
  resumeToken: string | null = null;

  constructor(
    port: number,
    readonly playerId: string,
    private nickname: string,
  ) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { origin: 'http://localhost:5173' },
    });
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw)) as Msg;
      // 回应服务器心跳，避免长测试被 30s 无响应判定断开
      if (msg.t === 'ping') {
        this.ws.send(
          JSON.stringify({ t: 'pong', ts: Date.now(), d: { id: (msg.d as { id?: number })?.id ?? 0 } }),
        );
        return;
      }
      if (msg.t === 'welcome') this.resumeToken = msg.d.session.resumeToken;
      const waiter = this.waiters.find((w) => w.pred(msg));
      if (waiter) {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        clearTimeout(waiter.timer);
        waiter.resolve(msg);
      } else {
        this.queue.push(msg);
      }
    });
  }

  open(): Promise<void> {
    // 连接可能在构造后已完成 open（如先 await 过其它 promise）：直接 resolve，避免错过 open 事件永挂
    if (this.ws.readyState === this.ws.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
  }

  send(t: string, d: unknown): void {
    this.ws.send(JSON.stringify({ t, ts: Date.now(), d }));
  }

  raw(payload: string): void {
    this.ws.send(payload);
  }

  next<T = any>(t: string, timeout = 5000): Promise<Msg & { d: T }> {
    const idx = this.queue.findIndex((m) => m.t === t);
    if (idx >= 0) return Promise.resolve(this.queue.splice(idx, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting ${t}`)), timeout);
      this.waiters.push({ pred: (m) => m.t === t, resolve: resolve as (m: Msg) => void, timer });
    });
  }

  async hello(): Promise<void> {
    await this.open();
    this.send('hello', { playerId: this.playerId, nickname: this.nickname });
    await this.next('welcome');
  }

  /** 等待连接关闭（超大帧/校验超限断开等场景） */
  closed(): Promise<void> {
    return new Promise((resolve) => {
      if (this.ws.readyState === this.ws.CLOSED) return resolve();
      this.ws.once('close', () => resolve());
    });
  }

  close(): void {
    this.ws.terminate();
  }
}

describe('M2 房间联机（真实 ws）', () => {
  let port: number;
  let app: ReturnType<typeof createApp>['app'];
  let manager: ReturnType<typeof createApp>['manager'];

  beforeAll(async () => {
    process.env.ROOM_CREATE_LIMIT = '20'; // 测试客户端同 IP，放宽建房限流
    ({ app, manager } = createApp());
    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    manager.shutdown();
    await app.close();
    delete process.env.ROOM_CREATE_LIMIT;
  });

  it('创建/加入/权限/开局条件/倒计时/快照/输入/聊天/限流/校验（TC-ROOM-001/002/005, TC-NET-001/002, TC-CHAT, TC-SEC-001）', async () => {
    const a = new TestClient(port, UUID_A, 'Alice');
    await a.hello();
    a.send('room.create', { visibility: 'public' });
    const st = await a.next('room.state');
    const code = st.d.room.roomCode as string;
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    expect(st.d.room.seats[0].kind).toBe('human');

    // 不存在房间 → E4040
    const c = new TestClient(port, UUID_B, 'Bob');
    await c.hello();
    c.send('room.join', { roomCode: 'ZZZZ99' });
    expect((await c.next('error')).d.code).toBe('E4040');

    // 加入
    c.send('room.join', { roomCode: code });
    const st2 = await c.next('room.state');
    expect(st2.d.room.seats.filter((s: any) => s.kind !== 'empty')).toHaveLength(2);

    // 非房主开局 → E4030；非房主改设置 → E4030
    c.send('game.start', {});
    expect((await c.next('error')).d.code).toBe('E4030');
    c.send('room.updateSettings', { mode: 'sprint', targetLines: 20 });
    expect((await c.next('error')).d.code).toBe('E4030');

    // 存在未准备真人 → E4031（TC-ROOM-005）
    a.send('game.start', {});
    expect((await a.next('error')).d.code).toBe('E4031');

    // 准备 → 开局 → 倒计时 → game.start（含 seed）
    c.send('game.ready', { ready: true });
    await a.next('room.state');
    a.send('game.start', {});
    expect((await a.next('room.countdown')).d.seconds).toBe(3);
    const startA = await a.next('game.start', 8000);
    expect(startA.d.mode).toBe('sprint');
    expect(typeof startA.d.seeds['0']).toBe('string');
    await c.next('game.start');

    // 输入 → 权威快照（seq 已应用、board 220 字符）
    a.send('game.input', { seq: 1, action: 'moveL' });
    a.send('game.input', { seq: 2, action: 'hard' });
    const snap = await a.next('game.snapshot.self', 5000);
    expect(snap.d.seq).toBeGreaterThanOrEqual(2);
    expect(snap.d.board).toHaveLength(220);
    expect(snap.d.modeState.sprint.target).toBe(40);

    // 对手快照
    const others = await c.next('game.snapshot.others', 5000);
    expect(Array.isArray(others.d.seats)).toBe(true);

    // 聊天广播
    c.send('chat.send', { text: 'hello <script>' });
    const chat = await a.next('chat.message');
    expect(chat.d.text).toBe('hello <script>');

    // 聊天限流 → E4290
    for (let i = 0; i < 12; i++) c.send('chat.send', { text: `msg${i}` });
    expect((await c.next('error', 5000)).d.code).toBe('E4290');

    // 未知消息类型 → E4031（伪造）
    c.raw(JSON.stringify({ t: 'game.cheat', ts: Date.now(), d: { score: 999999 } }));
    expect((await c.next('error')).d.code).toBe('E4031');

    // 已知类型校验失败 → E4001
    c.send('game.input', { seq: -1, action: 'fly' });
    expect((await c.next('error')).d.code).toBe('E4001');

    a.close();
    c.close();
  }, 25_000);

  it('PLAYING 中断线 → 30s 宽限内 resume 恢复座位并下发 game.state.full（TC-NET-003）', async () => {
    const a = new TestClient(port, UUID_C, 'Carol');
    await a.hello();
    a.send('room.create', { visibility: 'private' });
    const code = (await a.next('room.state')).d.room.roomCode as string;
    const b = new TestClient(port, UUID_D, 'Dave');
    await b.hello();
    b.send('room.join', { roomCode: code });
    await a.next('room.state');
    b.send('game.ready', { ready: true });
    await a.next('room.state');
    a.send('game.start', {});
    await b.next('game.start', 8000);
    const token = a.resumeToken;
    expect(token).toBeTruthy();

    a.close(); // 断线（宽限期内）
    await new Promise((r) => setTimeout(r, 300));

    const a2 = new TestClient(port, UUID_C, 'Carol');
    await a2.open();
    a2.send('hello', { playerId: UUID_C, nickname: 'Carol', resumeToken: token });
    const welcome = await a2.next('welcome');
    expect(welcome.d.room?.phase).toBe('PLAYING');
    const full = await a2.next('game.state.full', 5000);
    expect(typeof full.d.seed).toBe('string');
    expect(full.d.self.board).toHaveLength(220);

    a2.close();
    b.close();
  }, 20_000);

  it('协议鲁棒性：JSON null / 原型链键 / 超大帧不崩服（TC-SEC-003/008 回归）', async () => {
    const e = new TestClient(port, UUID_E, 'Eve');
    await e.open();
    // JSON "null"：修复前 null.t 抛 TypeError → uncaughtException → 进程退出
    e.raw('null');
    expect((await e.next('error')).d.code).toBe('E4001');
    // 原型链键：修复前 '__proto__' 命中 Object.prototype → safeParse 不存在 → TypeError
    e.raw(JSON.stringify({ t: '__proto__', ts: Date.now(), d: {} }));
    expect((await e.next('error')).d.code).toBe('E4031');
    e.raw(JSON.stringify({ t: 'toString', ts: Date.now(), d: {} }));
    expect((await e.next('error')).d.code).toBe('E4031');
    // 连接仍可用：正常握手 + 建房
    e.send('hello', { playerId: UUID_E, nickname: 'Eve' });
    await e.next('welcome');
    e.send('room.create', { visibility: 'private' });
    expect((await e.next('room.state')).d.room.roomCode).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    // 超大帧（>4KB）：ws 层 maxPayload 直接拒绝并关闭连接（不发应用层消息）
    e.raw(JSON.stringify({ t: 'chat.send', ts: Date.now(), d: { text: 'x'.repeat(5000) } }));
    await e.closed();
    // 服务器仍存活：新连接正常工作
    const e2 = new TestClient(port, UUID_E, 'Eve2');
    await e2.hello();
    e2.close();
  }, 15_000);

  it('输入限流：>60 action/s 丢弃并回 E4290（TC-NET-001）', async () => {
    const a = new TestClient(port, UUID_F, 'Frank');
    await a.hello();
    a.send('room.create', { visibility: 'private' });
    const code = (await a.next('room.state')).d.room.roomCode as string;
    const b = new TestClient(port, UUID_G, 'Grace');
    await b.hello();
    b.send('room.join', { roomCode: code });
    await a.next('room.state');
    b.send('game.ready', { ready: true });
    await a.next('room.state');
    a.send('game.start', {});
    await a.next('game.start', 8000);
    await b.next('game.start', 8000);
    for (let i = 1; i <= 80; i++) a.send('game.input', { seq: i, action: 'rotCW' });
    expect((await a.next('error', 5000)).d.code).toBe('E4290');
    a.close();
    b.close();
  }, 20_000);

  it('旧连接未断开时 resume 强制接管座位并顶号（TC-NET-003 补充）', async () => {
    const a = new TestClient(port, UUID_H, 'Hank');
    await a.hello();
    a.send('room.create', { visibility: 'private' });
    const code = (await a.next('room.state')).d.room.roomCode as string;
    const b = new TestClient(port, UUID_I, 'Ivy');
    await b.hello();
    b.send('room.join', { roomCode: code });
    await a.next('room.state');
    b.send('game.ready', { ready: true });
    await a.next('room.state');
    a.send('game.start', {});
    await b.next('game.start', 8000);
    const token = a.resumeToken;
    expect(token).toBeTruthy();

    // 旧连接 a 仍在线（未 close），新连接直接 resume → 必须接管成功
    const a2 = new TestClient(port, UUID_H, 'Hank');
    await a2.open();
    a2.send('hello', { playerId: UUID_H, nickname: 'Hank', resumeToken: token });
    const welcome = await a2.next('welcome', 5000);
    expect(welcome.d.session.selfSeatId).toBe(0);
    const full = await a2.next('game.state.full', 5000);
    expect(full.d.seatId).toBe(0);
    expect(typeof full.d.seed).toBe('string');
    // 旧连接被顶号下线
    expect((await a.next('error', 5000)).d.code).toBe('E4010');
    a.close();
    a2.close();
    b.close();
  }, 20_000);

  it('每连接入站消息限流：>120 条/s 直接断开且不崩服（协议 §9）', async () => {
    const f = new TestClient(port, UUID_J, 'Flood');
    await f.open();
    for (let i = 0; i < 200; i++) {
      f.raw(JSON.stringify({ t: 'pong', ts: Date.now(), d: { id: 1 } }));
    }
    await f.closed(); // 限流直接断开连接
    // 服务器仍存活：新连接正常工作
    const g = new TestClient(port, UUID_K, 'AfterFlood');
    await g.hello();
    g.close();
  }, 15_000);
});
