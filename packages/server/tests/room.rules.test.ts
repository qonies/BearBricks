// Room 规则回归（P1-1 / P1-2 / P2-2 / P2-3）：seed 按座位下发、timed 免伤期双向禁攻、
// survival 主动离开与断线判淘汰同口径（座位保留垫底、再来一局清理）、输入限流丢弃也确认 seq。
// 使用假 Session（无 ws），不占端口、不依赖真实网络。

import { describe, expect, it } from 'vitest';
import {
  BOARD_WIDTH,
  TetrisGame,
  createModeStrategy,
  type GameModeStrategy,
} from '@bearbricks/shared';
import { Room, type Seat } from '../src/room/room';
import type { Session } from '../src/net/session';

interface SentMessage {
  t: string;
  d: Record<string, unknown>;
}

function fakeSession(name: string, sink: SentMessage[]): Session {
  return {
    playerId: `player-${name}`,
    nickname: name,
    resumeToken: `rt-${name}`,
    room: null,
    seatId: -1,
    stale: false,
    ip: '127.0.0.1',
    authenticated: true,
    socket: { readyState: 1 },
    send: (t: string, d: unknown) => sink.push({ t, d: d as Record<string, unknown> }),
    sendError: (code: string, message: string) => sink.push({ t: 'error', d: { code, message } }),
    rateLimitNotice: () => {},
    close: () => {},
    start: () => {},
    stopHeartbeat: () => {},
    shutdown: () => {},
  } as unknown as Session;
}

function makeRoom(mode: 'sprint' | 'survival' | 'timed'): {
  room: Room;
  sinkA: SentMessage[];
  sinkB: SentMessage[];
  sessions: Session[];
} {
  const room = new Room('RUL234', 'public');
  room.settings.mode = mode;
  (room as unknown as { strategy: GameModeStrategy }).strategy = createModeStrategy(mode);
  const sinkA: SentMessage[] = [];
  const sinkB: SentMessage[] = [];
  const sessions = [fakeSession('A', sinkA), fakeSession('B', sinkB)];
  expect(room.join(sessions[0])).toBe(true);
  expect(room.join(sessions[1])).toBe(true);
  return { room, sinkA, sinkB, sessions };
}

type RoomInternals = {
  beginGame: () => void;
  tickStep: () => void;
};

const internals = (room: Room): RoomInternals => room as unknown as RoomInternals;

/** 造一次 Double（底部两行只差第 8/9 列，O 块 x=7 硬降补满），并留散块避免 Perfect Clear */
function doubleClear(game: TetrisGame): void {
  game.board[2 * BOARD_WIDTH] = 'G';
  for (let r = 20; r <= 21; r++)
    for (let c = 0; c < BOARD_WIDTH - 2; c++) game.board[r * BOARD_WIDTH + c] = 'G';
  game.active = { type: 'O', x: 7, y: 3, rot: 0 };
  game.applyInput('hard');
}

function startSeeds(msg: SentMessage | undefined): Record<string, string> {
  return (msg?.d.seeds ?? {}) as Record<string, string>;
}


describe('对抗公平性', () => {
  it('game.start 只下发本人 seed（P1-1：不得让客户端推算对手队列）', () => {
    const { room, sinkA, sinkB } = makeRoom('sprint');
    room.phase = 'COUNTDOWN';
    internals(room).beginGame();

    const seedA = startSeeds(sinkA.find((m) => m.t === 'game.start'));
    const seedB = startSeeds(sinkB.find((m) => m.t === 'game.start'));
    expect(Object.keys(seedA)).toEqual(['0']); // 只含自己（座位 0）
    expect(Object.keys(seedB)).toEqual(['1']); // 只含自己（座位 1）
    expect(seedA['0']).toBe(room.seats[0].seed);
    expect(seedB['1']).toBe(room.seats[1].seed);
    expect(room.seats[0].seed).not.toBe(room.seats[1].seed);
    expect(seedA['1']).toBeUndefined(); // 广播消息里不再出现对手座位键
    room.stopTimers();
  });

  it('timed 免伤窗内消行不产生攻击（P1-2：§4.5 不收发攻击是双向的）', () => {
    const { room, sinkB } = makeRoom('timed');
    room.phase = 'PLAYING';
    const attacker = new TetrisGame({ mode: 'marathon', seed: 'queue-a' });
    room.seats[0].game = attacker;
    room.seats[1].game = new TetrisGame({ mode: 'marathon', seed: 'queue-b' });

    // 免伤窗生效中：消行既不转发，也不抵消自己的待收垃圾
    room.seats[0].immuneUntilTick = 120;
    room.seats[0].pendingGarbage = 2;
    doubleClear(attacker);
    internals(room).tickStep();
    expect(sinkB.filter((m) => m.t === 'game.attack')).toHaveLength(0);
    expect(room.seats[1].pendingGarbage).toBe(0);
    expect(room.seats[0].pendingGarbage).toBe(2);

    // 免伤窗结束后同样的消行照常转发（证明上一步是免伤拦下的，而非掷地无声）
    room.seats[0].immuneUntilTick = room.tick + 1;
    room.seats[0].pendingGarbage = 0;
    doubleClear(attacker);
    internals(room).tickStep();
    expect(sinkB.filter((m) => m.t === 'game.attack')).toHaveLength(1);
    expect(room.seats[1].pendingGarbage).toBeGreaterThan(0);
    room.stopTimers();
  });
});


describe('survival 离场口径（P2-3）', () => {
  it('对局中主动离开 = 判淘汰、座位保留垫底、resumeToken 作废', () => {
    const { room, sinkA, sessions } = makeRoom('survival');
    room.phase = 'PLAYING';
    room.seats[0].game = new TetrisGame({ mode: 'marathon', seed: 'a' });
    room.seats[1].game = new TetrisGame({ mode: 'marathon', seed: 'b' });
    room.seats[1].pendingGarbage = 3;
    const leaver = sessions[1];

    room.leaveSeat(1);

    const seat = room.seats[1] as Seat;
    expect(seat.kind).toBe('human'); // 座位保留在结算表（不再直接置空）
    expect(seat.eliminated).toBe(true);
    expect(seat.rankBottom).toBe(true);
    expect(seat.topOuts).toBe(1);
    expect(seat.pendingGarbage).toBe(0);
    expect(seat.resumeToken).toBeNull();
    expect(seat.session).toBeNull();
    expect(leaver.room).toBeNull();
    expect(leaver.seatId).toBe(-1);
    // 存活者（座位 0）收到与"引擎顶出/断线淘汰"完全相同的广播
    expect(
      sinkA.some((m) => m.t === 'game.topOut' && (m.d as { action?: string }).action === 'ELIMINATE'),
    ).toBe(true);

    // 两人局：淘汰后只剩 1 人存活 → 立即终局，离开者垫底且状态 eliminated（与断线一致）
    expect(room.phase).toBe('FINISHED');
    const result = sinkA.find((m) => m.t === 'game.result');
    const ranking = (result?.d as { ranking: { seatId: number; rank: number; status: string }[] })
      .ranking;
    const loser = ranking.find((r) => r.seatId === 1);
    expect(loser?.rank).toBe(2);
    expect(loser?.status).toBe('abandoned');
    expect(room.resumeSeat(1, leaver)).toBe(false); // 已作废，无法 resume 回原座位
    room.stopTimers();
  });

  it('4 人局：主动离开者垫底（rankBottom），已淘汰观战者离开仍保留原名次（H-1）', () => {
    const room = new Room('RUL235', 'public');
    room.settings.mode = 'survival';
    (room as unknown as { strategy: GameModeStrategy }).strategy = createModeStrategy('survival');
    const sinkA: SentMessage[] = [];
    const sessions = [
      fakeSession('A', sinkA),
      fakeSession('B', []),
      fakeSession('C', []),
      fakeSession('D', []),
    ];
    for (const s of sessions) expect(room.join(s)).toBe(true);
    room.phase = 'PLAYING';
    for (let i = 0; i < 4; i++) {
      room.seats[i].game = new TetrisGame({ mode: 'marathon', seed: `g${i}` });
    }
    // 座位 2 在 1000ms、座位 3 在 500ms 被顶出（真实淘汰时刻）
    room.seats[2].eliminated = true;
    room.seats[2].eliminatedAtMs = 1000;
    room.seats[3].eliminated = true;
    room.seats[3].eliminatedAtMs = 500;
    // 已淘汰观战者离开：保留座位/结算记录（不重复 TOP_OUT，只播 LEAVE）
    room.leaveSeat(3);
    expect(room.seats[3].kind).toBe('human');
    expect(room.seats[3].eliminated).toBe(true);
    expect(room.seats[3].session).toBeNull();
    expect(room.seats[3].resumeToken).toBeNull();
    // 座位 1 仍存活时主动离开：应判淘汰且垫底（排在真实淘汰者之后）
    room.leaveSeat(1);
    expect(room.phase).toBe('FINISHED');
    const ranking = (sinkA.find((m) => m.t === 'game.result')?.d as {
      ranking: { seatId: number; rank: number; status: string }[],
    }).ranking;
    const byId = (id: number) => ranking.find((r) => r.seatId === id);
    expect(byId(0)?.rank).toBe(1); // 唯一存活
    expect(byId(1)?.rank).toBe(4); // 主动离开者垫底
    expect(byId(1)?.status).toBe('abandoned');
    expect(byId(2)?.rank).toBe(2); // 1000ms 淘汰
    expect(byId(3)?.rank).toBe(3); // 500ms 淘汰
    room.stopTimers();
  });

  it('再来一局清理不可恢复的离场座位（避免幽灵真人卡死开局条件）', () => {
    const { room, sessions } = makeRoom('survival');
    room.phase = 'PLAYING';
    room.seats[0].game = new TetrisGame({ mode: 'marathon', seed: 'a' });
    room.seats[1].game = new TetrisGame({ mode: 'marathon', seed: 'b' });
    room.leaveSeat(1);
    expect(room.phase).toBe('FINISHED');

    room.rematch(sessions[0]);

    expect(room.phase).toBe('WAITING');
    expect(room.seats[1].kind).toBe('empty');
    expect(room.seats[0].kind).toBe('human');
    room.stopTimers();
  });
});

describe('输入限流（P2-2）', () => {
  it('被限流丢弃的输入也确认 seq，客户端据此裁剪 inputLog', () => {
    const { room, sessions } = makeRoom('sprint');
    room.phase = 'PLAYING';
    room.seats[0].game = new TetrisGame({ mode: 'sprint', targetLines: 40, seed: 'a' });
    room.seats[1].game = new TetrisGame({ mode: 'sprint', targetLines: 40, seed: 'b' });
    const session = sessions[0];

    for (let seq = 1; seq <= 60; seq++) room.handleInput(session, { seq, action: 'moveL' });
    expect(room.seats[0].pendingInputs).toHaveLength(60);
    expect(room.seats[0].lastSeq).toBe(0); // 已入队但尚未结算（lastSeq 在 tick 应用时才推进）

    room.handleInput(session, { seq: 61, action: 'moveL' }); // 超限 → 丢弃
    expect(room.seats[0].pendingInputs).toHaveLength(60);
    expect(room.seats[0].lastSeq).toBe(61); // 丢弃同时也确认 seq，客户端可裁日志
    room.stopTimers();
  });
});
