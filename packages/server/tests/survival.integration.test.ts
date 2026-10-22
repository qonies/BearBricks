// M3 survival 集成测试（真实 ws，随机高位端口，afterAll 关闭——测试纪律：不占端口）
// 覆盖：TC-MD-B-001（攻击→垃圾行插入）、TC-MD-B-002（仅剩 1 人→结算排名）、
//       TC-MD-B-004（淘汰者转观战仍可聊天）、TC-MD-X-001（rematch 无模式状态残留）

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import { BOARD_WIDTH, TOTAL_HEIGHT } from '@bearbricks/shared';
import { createApp } from '../src/app';

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const UUID_C = '33333333-3333-4333-8333-333333333333';
const UUID_D = '44444444-4444-4444-8444-444444444444';

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
    if (this.ws.readyState === this.ws.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', reject);
    });
  }

  send(t: string, d: unknown): void {
    this.ws.send(JSON.stringify({ t, ts: Date.now(), d }));
  }

  next<T = any>(t: string, timeout = 5000): Promise<Msg & { d: T }> {
    const idx = this.queue.findIndex((m) => m.t === t);
    if (idx >= 0) return Promise.resolve(this.queue.splice(idx, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting ${t}`)), timeout);
      this.waiters.push({ pred: (m) => m.t === t, resolve: resolve as (m: Msg) => void, timer });
    });
  }

  /** 按谓词等待（跳过队列中不匹配的陈旧消息） */
  nextWhere<T = any>(t: string, pred: (d: T) => boolean, timeout = 5000): Promise<Msg & { d: T }> {
    const idx = this.queue.findIndex((m) => m.t === t && pred(m.d as T));
    if (idx >= 0) return Promise.resolve(this.queue.splice(idx, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting ${t}`)), timeout);
      this.waiters.push({
        pred: (m) => m.t === t && pred(m.d as T),
        resolve: resolve as (m: Msg) => void,
        timer,
      });
    });
  }

  /** 队列中是否已收到某类型消息（不消费） */
  has(t: string): boolean {
    return this.queue.some((m) => m.t === t);
  }

  /** 清空已缓存消息（等待 FINISHED 之后的新 room.state 等场景） */
  clearQueue(): void {
    this.queue.length = 0;
  }

  async hello(): Promise<void> {
    await this.open();
    this.send('hello', { playerId: this.playerId, nickname: this.nickname });
    await this.next('welcome');
  }

  close(): void {
    this.ws.terminate();
  }
}

describe('M3 survival 对战（真实 ws）', () => {
  let port: number;
  let app: ReturnType<typeof createApp>['app'];
  let manager: ReturnType<typeof createApp>['manager'];

  beforeAll(async () => {
    process.env.ROOM_CREATE_LIMIT = '20';
    ({ app, manager } = createApp());
    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    manager.shutdown();
    await app.close();
    delete process.env.ROOM_CREATE_LIMIT;
  });

  it('survival 全流程：模式切换→攻击→垃圾行→淘汰→结算→再来一局（TC-MD-B-001/002/004, TC-MD-X-001）', async () => {
    const a = new TestClient(port, UUID_A, 'Alice');
    const b = new TestClient(port, UUID_B, 'Bob');
    await a.hello();
    a.send('room.create', { visibility: 'private' });
    const created = await a.next('room.state');
    const code = created.d.room.roomCode as string;

    await b.hello();
    b.send('room.join', { roomCode: code });
    await b.next('room.state');
    b.send('game.ready', { ready: true });

    // timed 仍拒绝（M4）
    a.send('room.updateSettings', { mode: 'timed' });
    const err = await a.next('error');
    expect(err.d.code).toBe('E4031');

    // 切 survival（房主权限）
    a.send('room.updateSettings', { mode: 'survival' });
    const st = await a.nextWhere<{ room: { settings: { mode: string } } }>(
      'room.state',
      (d) => d.room.settings.mode === 'survival',
    );
    expect(st.d.room.settings.mode).toBe('survival');

    a.send('game.start', {});
    const startA = await a.next('game.start');
    const startB = await b.next('game.start');
    expect(startA.d.mode).toBe('survival');
    expect(startB.d.mode).toBe('survival');

    const room = manager.getRoom(code);
    expect(room).toBeDefined();
    const seatA = room!.seats[0];
    const seatB = room!.seats[1];
    expect(seatA.game).not.toBeNull();
    expect(seatA.game!.mode).toBe('marathon'); // survival 引擎语义：顶出即终局
    expect(seatA.pendingGarbage).toBe(0);

    // ===== TC-MD-B-001：A 造 Double → 攻击 1 行定向 B =====
    // 棋盘底部两行填 cols 0-8，active 置为竖直 I（col 9，rows 18-21）→ 硬降清 2 行
    const gA = seatA.game!;
    for (const r of [20, 21])
      for (let c = 0; c < BOARD_WIDTH - 1; c++) gA.board[r * BOARD_WIDTH + c] = 'G';
    gA.active = { type: 'I', x: 7, y: 18, rot: 1 }; // cells cx=2 → col 9
    a.send('game.input', { seq: 1, action: 'hard' });

    const atkA = await a.next('game.attack');
    expect(atkA.d.fromSeat).toBe(0);
    expect(atkA.d.lines).toBe(1);
    expect(atkA.d.targets).toEqual([1]);
    await b.next('game.attack');
    expect(seatB.pendingGarbage).toBe(1);
    expect(seatB.garbageDueTick).not.toBeNull();
    // 500ms 缓冲到期后整批插入：底行出现同批同列洞的 'G' 行
    const deadline = Date.now() + 3000;
    let holeCol = -1;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      const bottom = seatB.game!.board.slice((TOTAL_HEIGHT - 1) * BOARD_WIDTH);
      if (bottom.includes('G')) {
        holeCol = bottom.indexOf(null);
        break;
      }
    }
    expect(holeCol).toBeGreaterThanOrEqual(0);
    expect(holeCol).toBeLessThan(BOARD_WIDTH);
    expect(seatB.pendingGarbage).toBe(0);
    expect(seatB.garbageDueTick).toBeNull();
    // 底行恰 9 个 'G' + 1 个洞（同批次同列洞）
    const bottomRow = seatB.game!.board.slice((TOTAL_HEIGHT - 1) * BOARD_WIDTH);
    expect(bottomRow.filter((c) => c === 'G')).toHaveLength(BOARD_WIDTH - 1);

    // ===== TC-MD-B-002：B 顶出 → 淘汰 → 仅剩 A → 结算 =====
    for (let i = 0; i < BOARD_WIDTH * TOTAL_HEIGHT; i++) seatB.game!.board[i] = 'G';
    seatB.game!.validateActiveAfterBoardChange();
    expect(seatB.game!.status).toBe('finished');

    const topOutA = await a.next('game.topOut');
    expect(topOutA.d).toEqual({ seatId: 1, action: 'ELIMINATE' });
    await b.next('game.topOut');
    expect(seatB.eliminated).toBe(true);
    expect(seatB.eliminatedAtMs).not.toBeNull();

    const resultA = await a.next('game.result');
    expect(resultA.d.mode).toBe('survival');
    expect(resultA.d.reason).toBe('finished');
    const rankA = resultA.d.ranking.find((r: any) => r.seatId === 0);
    const rankB = resultA.d.ranking.find((r: any) => r.seatId === 1);
    expect(rankA.rank).toBe(1);
    expect(rankA.timeMs).toBeNull(); // 存活到终局
    expect(rankB.rank).toBe(2);
    expect(rankB.timeMs).not.toBeNull();
    const resultB = await b.next('game.result');
    expect(resultB.d.mode).toBe('survival');

    // ===== TC-MD-B-004：淘汰者转观战仍可聊天；输入被静默丢弃 =====
    b.send('chat.send', { text: 'gg' });
    const chat = await a.next('chat.message');
    expect(chat.d.text).toBe('gg');
    expect(chat.d.seatId).toBe(1);
    b.send('game.input', { seq: 1, action: 'hard' });

    // ===== FINISHED 后输入一律拒绝（E4031，不再堆积 pendingInputs）=====
    a.send('game.input', { seq: 99, action: 'hard' });
    expect((await a.next('error')).d.code).toBe('E4031');

    // ===== TC-MD-X-001：再来一局 → WAITING，模式保留、状态无残留 =====
    a.clearQueue(); // 清空陈旧消息，等待 FINISHED 之后的新 room.state
    a.send('room.rematch', {});
    const rem = await a.nextWhere<{ room: { phase: string; settings: { mode: string } } }>(
      'room.state',
      (d) => d.room.phase === 'WAITING',
    );
    expect(rem.d.room.phase).toBe('WAITING');
    expect(rem.d.room.settings.mode).toBe('survival');
    expect(seatA.eliminated).toBe(false);
    expect(seatA.pendingGarbage).toBe(0);
    expect(seatB.eliminated).toBe(false);
    expect(seatB.pendingGarbage).toBe(0);
    expect(seatA.game).toBeNull();

    a.close();
    b.close();
  }, 30_000);

  it('宽限期内断线不提前终局（FR-10.2/10.3 回归）；resume 后 softDrop 与未消费输入复位', async () => {
    const a = new TestClient(port, UUID_C, 'Carol');
    const b = new TestClient(port, UUID_D, 'Dave');
    await a.hello();
    a.send('room.create', { visibility: 'private' });
    const created = await a.next('room.state');
    const code = created.d.room.roomCode as string;

    await b.hello();
    b.send('room.join', { roomCode: code });
    await b.next('room.state');
    b.send('game.ready', { ready: true });
    a.send('room.updateSettings', { mode: 'survival' });
    await a.nextWhere<{ room: { settings: { mode: string } } }>(
      'room.state',
      (d) => d.room.settings.mode === 'survival',
    );
    a.send('game.start', {});
    await a.next('game.start');
    await b.next('game.start');

    const room = manager.getRoom(code)!;
    a.send('game.soft', { on: true }); // 置软降持续态
    await new Promise((r) => setTimeout(r, 100));
    expect(room.seats[0].softDrop).toBe(true);

    // A 断线：宽限期内对局必须继续（修复前：aliveSeats 排除离线者 → 立即结算且掉线者并列第 1）
    a.close();
    await new Promise((r) => setTimeout(r, 1200));
    expect(room.phase).toBe('PLAYING');
    expect(b.has('game.result')).toBe(false);

    // 宽限内 resume：座位与棋局恢复；softDrop 不跨断线残留（否则恢复后棋盘自己下冲）
    const a2 = new TestClient(port, UUID_C, 'Carol');
    await a2.open();
    a2.send('hello', { playerId: UUID_C, nickname: 'Carol', resumeToken: a.resumeToken });
    await a2.next('welcome');
    await a2.next('game.state.full');
    expect(room.seats[0].online).toBe(true);
    expect(room.seats[0].softDrop).toBe(false);
    expect(room.seats[0].pendingInputs).toHaveLength(0);

    a2.close();
    b.close();
  }, 20_000);
});