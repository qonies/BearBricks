// 同一 tick 内多次锁定的消行攻击回归（P1）：修复前 Room 每个 tick 只取一次 lastClear，
// 后一次"无消行锁定"会把 lastClear 置 null → 前一次消行的攻击丢失（输入积压 / game.inputBatch / 补帧
// 时可达）。现在 Room 循环 takeLastClear，逐个结算。使用假 Session，不依赖 ws。

import { describe, expect, it } from 'vitest';
import {
  BOARD_WIDTH,
  TetrisGame,
  createModeStrategy,
  type GameModeStrategy,
} from '@bearbricks/shared';
import { Room } from '../src/room/room';
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
    sendError: () => {},
    rateLimitNotice: () => {},
    close: () => {},
    start: () => {},
    stopHeartbeat: () => {},
    shutdown: () => {},
  } as unknown as Session;
}

/**
 * 造一次 Double：底部两行只差第 8/9 列，O 块（x=7）硬降补满 → 消 2 行。
 * row2 col0 留散块：避免消空棋盘触发 Perfect Clear（+10）干扰攻击值断言。
 */
function doubleClear(game: TetrisGame): void {
  game.board[2 * BOARD_WIDTH] = 'G';
  for (let r = 20; r <= 21; r++)
    for (let c = 0; c < BOARD_WIDTH - 2; c++) game.board[r * BOARD_WIDTH + c] = 'G';
  game.active = { type: 'O', x: 7, y: 3, rot: 0 };
  game.applyInput('hard');
}

describe('同一 tick 多次锁定的消行攻击结算', () => {
  it('两次消行在一个 tick 内累计 → 两次 game.attack 都转发，对手累计收 2 行', () => {
    const room = new Room('ABC234', 'public');
    room.settings.mode = 'survival';
    (room as unknown as { strategy: GameModeStrategy }).strategy =
      createModeStrategy('survival');
    const sinkA: SentMessage[] = [];
    const sinkB: SentMessage[] = [];
    expect(room.join(fakeSession('A', sinkA))).toBe(true);
    expect(room.join(fakeSession('B', sinkB))).toBe(true);
    room.phase = 'PLAYING';
    const attacker = new TetrisGame({ mode: 'marathon', seed: 'queue-a' });
    room.seats[0].game = attacker;
    room.seats[1].game = new TetrisGame({ mode: 'marathon', seed: 'queue-b' });

    doubleClear(attacker); // 第 1 次消行（尚未被 tick 结算）
    doubleClear(attacker); // 第 2 次消行：同一 tick 内累计
    expect(attacker.lines).toBe(4);

    (room as unknown as { tickStep: () => void }).tickStep();

    // 每个座位各收一份广播：只统计座位 A 的收件箱
    const attacks = sinkA.filter((m) => m.t === 'game.attack');
    expect(attacks).toHaveLength(2); // 每次消行各转发一次（修复前只剩 1 次或 0 次）
    expect(attacks.map((m) => m.d.lines)).toEqual([1, 2]); // Double 1 行；Combo 第 2 连 +1
    expect(sinkB.filter((m) => m.t === 'game.attack')).toHaveLength(2);
    expect(room.seats[1].pendingGarbage).toBe(3); // 1 + 2：两次攻击逐个结算
    expect(room.seats[0].pendingGarbage).toBe(0);
  });
});
