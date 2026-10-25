// M4 timed 集成测试（真实 ws，随机高位端口，afterAll 关闭——测试纪律：不占端口）
// 覆盖：TC-MD-C-002（顶出 → RESPAWN 3s，分数保留、棋盘清空、复活倒计时/免伤窗口）、
//       timed 攻击链路（§4.3 垃圾行插入）、timeLimit 校验、TC-MD-X-001（rematch 无残留）、
//       计时归零结算 + 排名（总分→消行→顶出，abandoned 移出；TC-MD-C-001，tick 推进仿真）

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

interface SelfSnapshotLike {
  board: string;
  score: number;
  modeState?: {
    timed?: { endsAt: number; respawnAt?: number; immuneUntil?: number };
  };
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

  next<T = any>(t: string, timeout = 8000): Promise<Msg & { d: T }> {
    const idx = this.queue.findIndex((m) => m.t === t);
    if (idx >= 0) return Promise.resolve(this.queue.splice(idx, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting ${t}`)), timeout);
      this.waiters.push({ pred: (m) => m.t === t, resolve: resolve as (m: Msg) => void, timer });
    });
  }

  /** 按谓词等待（跳过队列中不匹配的陈旧消息） */
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

/** 轮询等待条件成立（并发测试负载下 60Hz tick 可能落后于墙钟，固定 sleep 不可靠） */
async function waitUntil(label: string, cond: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`waitUntil timeout: ${label}`);
}

describe('M4 timed 限时赛（真实 ws）', () => {
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

  it('timed 全流程：模式/时长设置→攻击→顶出 RESPAWN（3s 冻结+免伤）→计时归零结算→rematch 无残留（TC-MD-C-001/002, TC-MD-X-001）', async () => {
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

    // ===== timeLimit 校验（FR-2.6）：非法值 → E4001 =====
    a.send('room.updateSettings', { mode: 'timed', timeLimit: 100 });
    expect((await a.next('error')).d.code).toBe('E4001');

    // ===== 切 timed：默认 timeLimit=180；改 120 生效 =====
    a.send('room.updateSettings', { mode: 'timed' });
    const st180 = await a.nextWhere<{ room: { settings: { mode: string; timeLimit?: number } } }>(
      'room.state',
      (d) => d.room.settings.mode === 'timed',
    );
    expect(st180.d.room.settings.timeLimit).toBe(180);
    a.send('room.updateSettings', { mode: 'timed', timeLimit: 120 });
    const st120 = await a.nextWhere<{ room: { settings: { timeLimit?: number } } }>(
      'room.state',
      (d) => d.room.settings.timeLimit === 120,
    );
    expect(st120.d.room.settings.timeLimit).toBe(120);

    // ===== 开局：game.start 携带 timeLimit；引擎 marathon 语义 =====
    a.send('game.start', {});
    const startA = await a.next('game.start');
    await b.next('game.start');
    expect(startA.d.mode).toBe('timed');
    expect(startA.d.timeLimit).toBe(120);

    const room = manager.getRoom(code)!;
    const seatA = room.seats[0];
    const seatB = room.seats[1];
    expect(seatA.game!.mode).toBe('marathon'); // timed 引擎语义：顶出即终局，由 Room 复活

    // ===== timed 攻击链路（§4.3）：B 造 Double → 攻击 1 行定向 A → 500ms 后插入 =====
    const gB = seatB.game!;
    for (const r of [20, 21])
      for (let c = 0; c < BOARD_WIDTH - 1; c++) gB.board[r * BOARD_WIDTH + c] = 'G';
    gB.active = { type: 'I', x: 7, y: 18, rot: 1 };
    b.send('game.input', { seq: 1, action: 'hard' });
    const atk = await a.next('game.attack');
    expect(atk.d.fromSeat).toBe(1);
    expect(atk.d.targets).toEqual([0]);
    // 垃圾行到期插入（timed 同样走 insertDueGarbage）
    const deadline = Date.now() + 3000;
    let gotGarbage = false;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      if (seatA.game!.board.slice((TOTAL_HEIGHT - 1) * BOARD_WIDTH).includes('G')) {
        gotGarbage = true;
        break;
      }
    }
    expect(gotGarbage).toBe(true);

    // ===== TC-MD-C-002：A 顶出 → RESPAWN（棋盘清空/分数保留/3s 冻结） =====
    const gA = seatA.game!;
    const scoreBefore = gA.score;
    const linesBefore = gA.lines;
    for (let i = 0; i < BOARD_WIDTH * TOTAL_HEIGHT; i++) gA.board[i] = 'G';
    gA.validateActiveAfterBoardChange();
    expect(gA.status).toBe('finished');

    const topOutA = await a.next('game.topOut');
    expect(topOutA.d).toEqual({ seatId: 0, action: 'RESPAWN' });
    const topOutB = await b.next('game.topOut');
    expect(topOutB.d).toEqual({ seatId: 0, action: 'RESPAWN' });
    // 系统消息 RESPAWN 播报（跳过加入时的陈旧 JOIN 等系统消息）
    const sysRespawn = await b.nextWhere<{ code: string }>('chat.system', (d) => d.code === 'RESPAWN');
    expect(sysRespawn.d.code).toBe('RESPAWN');

    // 引擎立即复活（棋盘清空、分数保留）+ 复活/免伤窗口记账
    expect(gA.status).toBe('running');
    expect(gA.board.every((c) => c === null)).toBe(true);
    expect(gA.score).toBe(scoreBefore);
    expect(gA.lines).toBe(linesBefore);
    expect(seatA.topOuts).toBe(1);
    expect(seatA.pendingGarbage).toBe(0); // 待收垃圾随棋盘清空
    expect(seatA.respawnUntilTick).not.toBeNull();
    expect(seatA.immuneUntilTick).toBe(seatA.respawnUntilTick! + 180); // 免伤 3s = 180 tick

    // 己方快照携带 modeState.timed（endsAt + respawnAt + immuneUntil）
    const snap = await a.nextWhere<SelfSnapshotLike>(
      'game.snapshot.self',
      (d) => d.modeState?.timed?.respawnAt != null,
    );
    expect(snap.d.modeState.timed!.endsAt).toBeGreaterThan(Date.now());
    expect(snap.d.modeState.timed!.respawnAt!).toBeGreaterThan(Date.now());
    expect(snap.d.board).toMatch(/^\.+$/); // 棋盘已清空
    expect(snap.d.score).toBe(scoreBefore);

    // 复活倒计时期间输入被静默丢弃（不堆积、不生效）；丢弃也会确认 seq（P2-4：
    // 客户端据此 trim 未确认日志，避免重放已丢弃的输入——复活事件清日志不再是唯一途径）
    a.send('game.input', { seq: 500, action: 'hard' });
    await new Promise((r) => setTimeout(r, 300));
    expect(seatA.pendingInputs).toHaveLength(0);
    expect(seatA.lastSeq).toBe(500);

    // ===== 免伤窗（§4.5）：复活倒计时结束（轮询等待），B 的攻击不指向 A =====
    await waitUntil(
      'respawn countdown end',
      () => seatA.respawnUntilTick === null,
    );
    expect(seatA.immuneUntilTick).not.toBeNull();
    const gB2 = seatB.game!;
    for (const r of [20, 21])
      for (let c = 0; c < BOARD_WIDTH - 1; c++) gB2.board[r * BOARD_WIDTH + c] = 'G';
    gB2.active = { type: 'I', x: 7, y: 18, rot: 1 };
    b.send('game.input', { seq: 2, action: 'hard' });
    const atk2 = await a.next('game.attack', 3000).catch(() => null);
    if (atk2) expect(atk2.d.targets).not.toContain(0); // A 免伤中：不是攻击目标
    expect(seatA.pendingGarbage).toBe(0);
    // 免伤到期后窗口关闭（免伤窗 = 复活后 3s，轮询等待）
    await waitUntil('immune window end', () => seatA.immuneUntilTick === null);

    // ===== TC-MD-C-001：计时归零结算（测试钩子：把 timeLimit 收到 1s，下一 tick 即归零） =====
    seatA.game!.score = 5000;
    seatB.game!.score = 3000;
    room.settings.timeLimit = 1; // tick*STEP_MS ≥ timeLimit*1000 → 下一 tickStep 触发 finishGame('timeout')
    const resultA = await a.next('game.result', 10000);
    expect(resultA.d.mode).toBe('timed');
    expect(resultA.d.reason).toBe('timeout');
    expect(resultA.d.ranking).toHaveLength(2);
    const rankA = resultA.d.ranking.find((r: any) => r.seatId === 0);
    const rankB = resultA.d.ranking.find((r: any) => r.seatId === 1);
    expect(rankA.rank).toBe(1); // 总分高者第 1
    expect(rankA.score).toBe(5000);
    expect(rankB.rank).toBe(2);
    expect(rankB.score).toBe(3000);
    expect(rankA.status).toBe('finished');
    expect(rankA.timeMs).toBeNull();
    expect(room.phase).toBe('FINISHED');
    room.settings.timeLimit = 120; // 恢复测试钩子改动的时长，验证 rematch 设置保留

    // ===== TC-MD-X-001：再来一局 → WAITING，timed 设置保留、复活/顶出状态无残留 =====
    a.clearQueue();
    a.send('room.rematch', {});
    const rem = await a.nextWhere<{
      room: { phase: string; settings: { mode: string; timeLimit?: number } };
    }>('room.state', (d) => d.room.phase === 'WAITING');
    expect(rem.d.room.settings.mode).toBe('timed');
    expect(rem.d.room.settings.timeLimit).toBe(120);
    expect(seatA.topOuts).toBe(0);
    expect(seatA.respawnUntilTick).toBeNull();
    expect(seatA.immuneUntilTick).toBeNull();
    expect(seatA.game).toBeNull();
    expect(seatA.pendingGarbage).toBe(0);

    a.close();
    b.close();
  }, 40_000);

  it('timed abandoned 移出排名；单人计时归零结算（TC-MD-C-001/003 结算 wiring）', async () => {
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
    a.send('room.updateSettings', { mode: 'timed', timeLimit: 120 });
    await a.nextWhere('room.state', (d: any) => d.room.settings.mode === 'timed');
    a.send('game.start', {});
    await a.next('game.start');
    await b.next('game.start');

    const room = manager.getRoom(code)!;
    // B 主动离开（PLAYING 中 = abandoned，FR-10）→ 移出排名
    b.send('room.leave', {});
    await new Promise((r) => setTimeout(r, 300));
    expect(room.seats[1].kind).toBe('empty');
    expect(room.phase).toBe('PLAYING'); // A 仍在 → 不结束

    // 计时归零（测试钩子：timeLimit 收到 1s）
    room.seats[0].game!.score = 777;
    room.settings.timeLimit = 1;
    const result = await a.next('game.result', 10000);
    expect(result.d.mode).toBe('timed');
    expect(result.d.reason).toBe('timeout');
    expect(result.d.ranking).toHaveLength(1); // abandoned 不参与排名
    expect(result.d.ranking[0].seatId).toBe(0);
    expect(result.d.ranking[0].rank).toBe(1);
    expect(result.d.ranking[0].score).toBe(777);

    a.close();
  }, 30_000);

  it('timed 断线宽限超时 → 计一次顶出并继续复活循环（不 abandoned，仍在排名；FR-10.3）', async () => {
    const a = new TestClient(port, UUID_A, 'Alice');
    const b = new TestClient(port, UUID_B, 'Bob');
    await a.hello();
    a.send('room.create', { visibility: 'private' });
    const code = (await a.next('room.state')).d.room.roomCode as string;
    await b.hello();
    b.send('room.join', { roomCode: code });
    await b.next('room.state');
    b.send('game.ready', { ready: true });
    a.send('room.updateSettings', { mode: 'timed', timeLimit: 120 });
    await a.nextWhere('room.state', (d: any) => d.room.settings.mode === 'timed');
    a.send('game.start', {});
    await a.next('game.start');
    await b.next('game.start');

    const room = manager.getRoom(code)!;
    const seatB = room.seats[1];
    const token = b.resumeToken;
    expect(token).toBeTruthy();

    // B 断线并超过 30s 宽限（直接推进时钟调用 checkGrace，等价 5s 扫描周期到期）
    b.close();
    await new Promise((r) => setTimeout(r, 300));
    room.checkGrace(Date.now() + 31_000);

    // FR-10.3：计一次顶出并继续复活循环——不移出排名、座位与 resumeToken 保留
    expect(seatB.abandoned).toBe(false);
    expect(seatB.eliminated).toBe(false);
    expect(seatB.topOuts).toBe(1);
    expect(seatB.game!.status).toBe('running');
    expect(seatB.game!.board.every((c) => c === null)).toBe(true); // 棋盘已随复活清空
    expect(seatB.respawnUntilTick).not.toBeNull();
    expect(seatB.resumeToken).toBe(token);

    // 在场玩家收到 RESPAWN 处置事件
    const topOutB = await a.next('game.topOut');
    expect(topOutB.d).toEqual({ seatId: 1, action: 'RESPAWN' });

    // 迟到的 resume 仍可恢复座位并拿到全量态（含 modeState.timed.respawnAt）
    const b2 = new TestClient(port, UUID_B, 'Bob');
    await b2.open();
    b2.send('hello', { playerId: UUID_B, nickname: 'Bob', resumeToken: token });
    const w = await b2.next('welcome');
    expect(w.d.room?.phase).toBe('PLAYING');
    await b2.next('game.state.full');

    // 计时归零结算：B 仍参与排名（仅 sprint abandoned 移出口径不同）
    room.seats[0].game!.score = 1000;
    room.seats[1].game!.score = 500;
    room.settings.timeLimit = 1;
    const result = await a.next('game.result', 10000);
    expect(result.d.mode).toBe('timed');
    expect(result.d.ranking).toHaveLength(2);
    const rankB = result.d.ranking.find((r: any) => r.seatId === 1);
    expect(rankB.rank).toBe(2);
    expect(rankB.score).toBe(500);
    expect(rankB.status).toBe('finished');

    a.close();
    b2.close();
  }, 30_000);
});