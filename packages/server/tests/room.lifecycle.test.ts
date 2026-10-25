// Room 生命周期回归（P1-3 / P2-8）：倒计时期间离线不得绕过 30s 宽限；
// checkGrace 只处置一次；开局重置 abandoned 残留；sprint 宽限超时作废 resumeToken。
// 使用假 Session（无 ws），不占端口、不依赖真实网络。

import { describe, expect, it } from 'vitest';
import { createModeStrategy, type GameModeStrategy } from '@bearbricks/shared';
import { Room, type Seat } from '../src/room/room';
import type { Session } from '../src/net/session';

interface SentMessage {
  t: string;
  d: Record<string, unknown>;
}

function fakeSession(name: string, sink?: SentMessage[]): Session {
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
    send: (t: string, d: unknown) => sink?.push({ t, d: d as Record<string, unknown> }),
    sendError: (code: string, message: string) =>
      sink?.push({ t: 'error', d: { code, message } }),
    rateLimitNotice: () => {},
    close: () => {},
    start: () => {},
    stopHeartbeat: () => {},
    shutdown: () => {},
  } as unknown as Session;
}

function makeRoom(mode: 'sprint' | 'survival' | 'timed'): {
  room: Room;
  sink: SentMessage[];
  sessions: Session[];
} {
  const room = new Room('ABC234', 'public');
  room.settings.mode = mode;
  (room as unknown as { strategy: GameModeStrategy }).strategy = createModeStrategy(mode);
  const sink: SentMessage[] = [];
  const sessions = [fakeSession('H', sink), fakeSession('P2', sink)];
  expect(room.join(sessions[0])).toBe(true);
  expect(room.join(sessions[1])).toBe(true);
  return { room, sink, sessions };
}

type RoomInternals = {
  beginGame: () => void;
  checkGrace: (now: number) => void;
  survivalAliveSeats: () => Seat[];
};

const internals = (room: Room): RoomInternals => room as unknown as RoomInternals;

describe('开局离线与宽限（P1-3）', () => {
  it('survival：倒计时期间离线 → 开局不判放弃、不立即终局；宽限到期只淘汰一次', () => {
    const { room, sessions } = makeRoom('survival');
    room.handleDisconnect(1, sessions[1]);
    room.phase = 'COUNTDOWN';
    internals(room).beginGame();
    expect(room.phase).toBe('PLAYING');
    const seat = room.seats[1] as Seat;
    expect(seat.abandoned).toBe(false);
    expect(internals(room).survivalAliveSeats()).toHaveLength(2); // 两人局不立即结束
    internals(room).checkGrace(Date.now() + 31_000);
    expect(seat.eliminated).toBe(true);
    expect(seat.topOuts).toBe(1);
    expect(seat.pendingGarbage).toBe(0); // 淘汰即清空待收垃圾
    internals(room).checkGrace(Date.now() + 62_000);
    expect(seat.topOuts).toBe(1); // 不重复处置
    room.stopTimers();
  });

  it('宽限内 resume：恢复座位与在线状态，不受开局影响', () => {
    const { room, sessions } = makeRoom('sprint');
    room.handleDisconnect(1, sessions[1]);
    room.phase = 'COUNTDOWN';
    internals(room).beginGame();
    expect(room.seats[1].abandoned).toBe(false);
    const p2 = sessions[1];
    p2.resumeToken = room.seats[1].resumeToken;
    expect(room.resumeSeat(1, p2)).toBe(true);
    expect(room.seats[1].online).toBe(true);
    expect(room.seats[1].disconnectedAt).toBeNull();
    room.stopTimers();
  });

  it('sprint：宽限超时移出排名并作废 resumeToken；checkGrace 不重复处置', () => {
    const { room, sink, sessions } = makeRoom('sprint');
    room.handleDisconnect(1, sessions[1]);
    room.phase = 'COUNTDOWN';
    internals(room).beginGame();
    internals(room).checkGrace(Date.now() + 31_000);
    const seat = room.seats[1] as Seat;
    expect(seat.abandoned).toBe(true);
    expect(seat.resumeToken).toBeNull();
    expect(seat.disconnectedAt).toBeNull();
    const countLeaves = (): number =>
      sink.filter((m) => m.t === 'chat.system' && (m.d as { code?: string }).code === 'LEAVE')
        .length;
    const leavesAfterFirst = countLeaves();
    internals(room).checkGrace(Date.now() + 62_000);
    expect(countLeaves()).toBe(leavesAfterFirst);
    room.stopTimers();
  });

  it('开局重置上一局残留的 abandoned 标记', () => {
    const { room } = makeRoom('sprint');
    (room.seats[1] as Seat).abandoned = true;
    room.phase = 'COUNTDOWN';
    internals(room).beginGame();
    expect(room.seats[1].abandoned).toBe(false);
    room.stopTimers();
  });
});