// M5 BotController 集成测试（真实 ws，随机高位端口，afterAll 关闭——测试纪律：不占端口）
// 覆盖：TC-BOT-001（AI 输入经同一 GameLoop/game.applyInput 路径参与对局）+
//       TC-BOT-002（WAITING 移除 AI 后座位立即空出、不产生对局）
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import { BOARD_WIDTH } from '@bearbricks/shared';
import { createApp } from '../src/app';

const UUID_A = '55555555-5555-4555-8555-555555555555';

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
      if (msg.t === 'ping') {
        this.ws.send(
          JSON.stringify({ t: 'pong', ts: Date.now(), d: { id: (msg.d as { id?: number })?.id ?? 0 } }),
        );
        return;
      }
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

  next<T = any>(t: string, timeout = 8000): Promise<Msg & { d: T }> {
    const idx = this.queue.findIndex((m) => m.t === t);
    if (idx >= 0) return Promise.resolve(this.queue.splice(idx, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting ${t}`)), timeout);
      this.waiters.push({ pred: (m) => m.t === t, resolve: resolve as (m: Msg) => void, timer });
    });
  }

  nextWhere<T = any>(t: string, pred: (d: T) => boolean, timeout = 8000): Promise<Msg & { d: T }> {
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

  async hello(): Promise<void> {
    await this.open();
    this.send('hello', { playerId: this.playerId, nickname: this.nickname });
    await this.next('welcome');
  }

  close(): void {
    this.ws.terminate();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('M5 BotController 对战（真实 ws）', () => {
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

  it('WAITING 添加/移除 AI：座位立即生效、不产生对局（TC-BOT-002）', async () => {
    const a = new TestClient(port, UUID_A, 'Alice');
    await a.hello();
    a.send('room.create', { visibility: 'private' });
    const created = await a.next('room.state');
    const code = created.d.room.roomCode as string;

    a.send('room.addBot', { seatId: 1, difficulty: 'HARD' });
    await a.nextWhere<{ room: { seats: { kind: string }[] } }>(
      'room.state',
      (d) => d.room.seats[1].kind === 'bot',
    );
    const room = manager.getRoom(code)!;
    expect(room.seats[1].difficulty).toBe('HARD');
    expect(room.seats[1].ready).toBe(true);

    a.send('room.removeSeat', { seatId: 1 });
    await a.nextWhere<{ room: { seats: { kind: string }[] } }>(
      'room.state',
      (d) => d.room.seats[1].kind === 'empty',
    );
    expect(room.seats[1].game).toBeNull();
    a.close();
  });

  it('HARD bot 经同一 GameLoop 参与对局：持续落子、对局推进（TC-BOT-001 服务端路径）', async () => {
    const a = new TestClient(port, UUID_A, 'Alice');
    await a.hello();
    a.send('room.create', { visibility: 'private' });
    const created = await a.next('room.state');
    const code = created.d.room.roomCode as string;

    a.send('room.addBot', { seatId: 1, difficulty: 'HARD' });
    await a.nextWhere('room.state', (d: any) => d.room.seats[1].kind === 'bot');

    a.send('game.start', {});
    const start = await a.next<{ mode: string }>('game.start');
    expect(start.d.mode).toBe('sprint');

    const room = manager.getRoom(code)!;
    expect(room.phase).toBe('PLAYING');
    const game = room.seats[1].game!;
    expect(game).not.toBeNull();

    // 轮询等待 bot 在可见区落下方块（BotController 决策驱动 + 同一 applyInput 通道 + GameLoop 推进）
    const placedDeadline = Date.now() + 15_000;
    let visibleCells = 0;
    while (Date.now() < placedDeadline) {
      visibleCells = game.board.slice(2 * BOARD_WIDTH).filter((c) => c !== null).length;
      if (visibleCells >= 4) break; // 至少一整块已锁定
      await sleep(100);
    }
    expect(visibleCells).toBeGreaterThanOrEqual(4);

    // 对局继续推进（bot 未终局、房间仍 PLAYING、引擎仍 running）
    expect(game.status).toBe('running');
    expect(room.phase).toBe('PLAYING');
    expect(room.seats[1].bot).not.toBeNull();

    // 真人端能收到 bot 的对手快照（对手小板显示数据源）
    const others = await a.nextWhere<{ seats: { seatId: number }[] }>(
      'game.snapshot.others',
      (d) => d.seats.some((s) => s.seatId === 1),
      8000,
    );
    expect(others.d.seats[0].seatId).toBe(1);

    // 再等一小段，确认 bot 持续行动（棋盘状态仍在变化，而非一次性落子后挂死）
    const hashBefore = game.stateHash();
    const progressDeadline = Date.now() + 10_000;
    let progressed = false;
    while (Date.now() < progressDeadline) {
      if (game.stateHash() !== hashBefore) {
        progressed = true;
        break;
      }
      await sleep(100);
    }
    expect(progressed).toBe(true);

    a.close();
  });
});
