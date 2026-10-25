// Bot 消行攻击结算回归（P2-10）：botTick 在同一 tick 内 takeLastClear + forwardAttack，
// bot 最后一手（完赛/淘汰/复活前）的消行攻击不再丢失。使用假 Session，不依赖 ws。

import { describe, expect, it } from 'vitest';
import {
  BOARD_WIDTH,
  createModeStrategy,
  TetrisGame,
  type BotController,
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
    sendError: () => {},
    rateLimitNotice: () => {},
    close: () => {},
    start: () => {},
    stopHeartbeat: () => {},
    shutdown: () => {},
  } as unknown as Session;
}

describe('botTick 消行攻击结算（P2-10）', () => {
  it('bot 硬降消行的攻击在同一 tick 转发给存活对手', () => {
    const room = new Room('ABC234', 'public');
    room.settings.mode = 'survival';
    (room as unknown as { strategy: GameModeStrategy }).strategy =
      createModeStrategy('survival');
    const sink: SentMessage[] = [];
    expect(room.join(fakeSession('H', sink))).toBe(true);
    expect(room.join(fakeSession('P2', sink))).toBe(true);
    room.phase = 'PLAYING';

    // 座位 1 改造为 bot 座位并注入受控控制器：固定输出 hard
    const botSeat = room.seats[1] as Seat;
    botSeat.kind = 'bot';
    botSeat.bot = { decide: () => 'hard' } as unknown as BotController;
    // 构造棋盘：rows 18~21 除 col5 外填满；I 竖向（rot1，col=x+2=5）硬降补满 → 恰好消 4 行（Tetris）；
    // rows 2~17 留散块（col0）防止 Perfect Clear 干扰攻击值
    const game = new TetrisGame({ mode: 'marathon', seed: 'bot-attack' });
    for (let r = 18; r <= 21; r++) {
      for (let c = 0; c < BOARD_WIDTH; c++) {
        if (c !== 5) game.board[r * BOARD_WIDTH + c] = 'G';
      }
    }
    for (let r = 2; r <= 17; r++) game.board[r * BOARD_WIDTH + 0] = 'G';
    game.active = { type: 'I', x: 3, y: 0, rot: 1 };
    botSeat.game = game;
    // 己方座位（seat0）为存活真人对手
    room.seats[0].game = new TetrisGame({ mode: 'marathon', seed: 'opponent' });

    (room as unknown as { botTick: (s: Seat) => void }).botTick(botSeat);

    const attack = sink.find(
      (m) => m.t === 'game.attack',
    ) as { t: string; d: { lines: number; targets: number[]; fromSeat: number } } | undefined;
    expect(attack).toBeTruthy();
    expect(attack?.d.lines).toBe(4);
    expect(attack?.d.fromSeat).toBe(1);
    expect(attack?.d.targets).toContain(0);
    expect(room.seats[0].pendingGarbage).toBe(4);
    expect(room.seats[0].garbageDueTick).not.toBeNull();
    expect(game.lastClear).toBeNull(); // lastClear 已消费，不会下一 tick 重复结算
    room.stopTimers();
  });
});