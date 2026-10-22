// M3 survival 生存淘汰（TC-MD-B-001/002/003 + TC-ENG-010 补充）：
// 策略攻击计算、垃圾行顶出接入、排名（淘汰顺序倒序/并列/abandoned）、快照 modeState.survival

import { describe, expect, it } from 'vitest';
import {
  BOARD_WIDTH,
  OTHER_SEAT_SNAPSHOT_SCHEMA,
  SELF_SNAPSHOT_SCHEMA,
  SprintStrategy,
  SurvivalStrategy,
  TimedStrategy,
  TOTAL_HEIGHT,
  TetrisGame,
  buildOtherSeatSnapshot,
  buildSelfSnapshot,
  computeSurvivalRanking,
  createModeStrategy,
  insertGarbage,
  otherSeatHash,
} from '../src';

describe('survival 策略攻击（TC-MD-B-001 / §4.3 攻击表）', () => {
  const s = new SurvivalStrategy();

  it('Double+ 产生攻击：Double 1 / Triple 2 / Tetris 4', () => {
    expect(s.onLinesCleared({ lines: 1, tspin: 'none', combo: 1, b2b: false, perfectClear: false })).toEqual({ lines: 0 });
    expect(s.onLinesCleared({ lines: 2, tspin: 'none', combo: 1, b2b: false, perfectClear: false })).toEqual({ lines: 1 });
    expect(s.onLinesCleared({ lines: 3, tspin: 'none', combo: 1, b2b: false, perfectClear: false })).toEqual({ lines: 2 });
    expect(s.onLinesCleared({ lines: 4, tspin: 'none', combo: 1, b2b: false, perfectClear: false })).toEqual({ lines: 4 });
  });

  it('B2B ×1.5 向上取整；Combo 第 2 连起每连 +1（上限 +5）', () => {
    expect(s.onLinesCleared({ lines: 2, tspin: 'none', combo: 1, b2b: true, perfectClear: false })).toEqual({ lines: 2 });
    expect(s.onLinesCleared({ lines: 4, tspin: 'none', combo: 1, b2b: true, perfectClear: false })).toEqual({ lines: 6 });
    expect(s.onLinesCleared({ lines: 2, tspin: 'none', combo: 3, b2b: false, perfectClear: false })).toEqual({ lines: 3 });
    expect(s.onLinesCleared({ lines: 2, tspin: 'none', combo: 99, b2b: false, perfectClear: false })).toEqual({ lines: 6 });
  });

  it('timed 策略：顶出 RESPAWN、工厂注册（M4）；sprint 策略无攻击、顶出 RESET_BOARD', () => {
    expect(s.onTopOut()).toBe('ELIMINATE');
    expect(s.engineMode()).toBe('marathon');
    const sp = new SprintStrategy();
    expect(sp.onLinesCleared({ lines: 4, tspin: 'none', combo: 5, b2b: true, perfectClear: false })).toBeNull();
    expect(sp.onTopOut()).toBe('RESET_BOARD');
    expect(sp.engineMode()).toBe('sprint');
    expect(createModeStrategy('survival')).toBeInstanceOf(SurvivalStrategy);
    expect(createModeStrategy('timed')).toBeInstanceOf(TimedStrategy);
  });
});

describe('survival 排名（TC-MD-B-002/003）', () => {
  it('排名 = 淘汰顺序倒序；存活者并列第 1', () => {
    const r = computeSurvivalRanking([
      { seatId: 0, eliminatedAtMs: 10_000, abandoned: false },
      { seatId: 1, eliminatedAtMs: 20_000, abandoned: false },
      { seatId: 2, eliminatedAtMs: null, abandoned: false },
      { seatId: 3, eliminatedAtMs: 30_000, abandoned: false },
    ]);
    expect(r.get(2)).toBe(1); // 存活
    expect(r.get(3)).toBe(2); // 最晚淘汰
    expect(r.get(1)).toBe(3);
    expect(r.get(0)).toBe(4);
  });

  it('剩余全员同 tick 顶出 → 并列第 1（TC-MD-B-003）', () => {
    const r = computeSurvivalRanking([
      { seatId: 0, eliminatedAtMs: 88_888, abandoned: false },
      { seatId: 1, eliminatedAtMs: 88_888, abandoned: false },
      { seatId: 2, eliminatedAtMs: 88_888, abandoned: false },
    ]);
    expect(r.get(0)).toBe(1);
    expect(r.get(1)).toBe(1);
    expect(r.get(2)).toBe(1);
  });

  it('同刻淘汰并列；abandoned（宽限超时判淘汰）垫底并列', () => {
    const r = computeSurvivalRanking([
      { seatId: 0, eliminatedAtMs: 5_000, abandoned: false },
      { seatId: 1, eliminatedAtMs: 9_000, abandoned: false },
      { seatId: 2, eliminatedAtMs: 9_000, abandoned: false },
      { seatId: 3, eliminatedAtMs: null, abandoned: true },
    ]);
    expect(r.get(1)).toBe(1);
    expect(r.get(2)).toBe(1);
    expect(r.get(0)).toBe(3);
    expect(r.get(3)).toBe(4);
  });

  it('两名 abandoned 并列垫底', () => {
    const r = computeSurvivalRanking([
      { seatId: 0, eliminatedAtMs: null, abandoned: true },
      { seatId: 1, eliminatedAtMs: null, abandoned: true },
      { seatId: 2, eliminatedAtMs: 42_000, abandoned: false },
    ]);
    expect(r.get(2)).toBe(1);
    expect(r.get(0)).toBe(2);
    expect(r.get(1)).toBe(2);
  });
});

describe('垃圾行接入引擎（TC-ENG-010 补充：插入后顶出判定）', () => {
  it('insertGarbage 灌满棋盘 → validateActiveAfterBoardChange 判顶出', () => {
    const g = new TetrisGame({ mode: 'marathon', seed: 'garbage-topout' });
    insertGarbage(g.board, TOTAL_HEIGHT, 7);
    g.validateActiveAfterBoardChange();
    expect(g.status).toBe('finished');
    expect(g.topOut).toBe(true);
    expect(g.finishTimeMs).not.toBeNull();
  });

  it('垃圾行未挤压 active → 对局继续', () => {
    const g = new TetrisGame({ mode: 'marathon', seed: 'garbage-ok' });
    insertGarbage(g.board, 2, 0);
    g.validateActiveAfterBoardChange();
    expect(g.status).toBe('running');
    expect(g.topOut).toBe(false);
  });

  it('takeLastClear：取出后清空（每次锁定只结算一次攻击）', () => {
    const g = new TetrisGame({ mode: 'marathon', seed: 'take-clear' });
    const clear = { lines: 2, tspin: 'none' as const, points: 300, b2b: false, combo: 1, perfectClear: false };
    g.lastClear = clear;
    expect(g.takeLastClear()).toEqual(clear);
    expect(g.takeLastClear()).toBeNull();
  });

  it('receiveGarbage：active 随棋盘整体上移，与堆叠相对位置保持（TC-ENG-010 修复回归）', () => {
    const g = new TetrisGame({ mode: 'marathon', seed: 'garbage-shift' });
    g.active = { type: 'T', x: 4, y: 18, rot: 0 };
    g.board[20 * BOARD_WIDTH + 5] = 'I'; // 参照块：active 中下格正下方
    g.receiveGarbage(2, 0);
    expect(g.active!.y).toBe(16); // 18 - 2：方块被垃圾行推着上升
    expect(g.board[18 * BOARD_WIDTH + 5]).toBe('I'); // 参照块 row20 → row18
    expect(g.status).toBe('running');
    expect(g.topOut).toBe(false);
  });

  it('receiveGarbage：对局已结束时为 no-op', () => {
    const g = new TetrisGame({ mode: 'marathon', seed: 'garbage-done' });
    g.status = 'finished';
    const before = [...g.board];
    g.receiveGarbage(4, 3);
    expect(g.board).toEqual(before);
  });
});

describe('survival 快照协议（modeState.survival / eliminated / pendingGarbage）', () => {
  it('self 快照通过 schema 校验（survival modeState）', () => {
    const g = new TetrisGame({ mode: 'marathon', seed: 'snap-survival' });
    const snap = buildSelfSnapshot(g, 10, 3, { survival: { aliveCount: 3, pendingGarbage: 5 } });
    expect(() => SELF_SNAPSHOT_SCHEMA.parse(snap)).not.toThrow();
    expect(snap.modeState.survival?.aliveCount).toBe(3);
    expect(snap.modeState.survival?.pendingGarbage).toBe(5);
  });

  it('对手快照：eliminated 状态与 pendingGarbage；hash 随 pending 变化', () => {
    const g = new TetrisGame({ mode: 'marathon', seed: 'snap-eliminated' });
    const snap = buildOtherSeatSnapshot(g, 1, 'eliminated', 4);
    expect(() => OTHER_SEAT_SNAPSHOT_SCHEMA.parse(snap)).not.toThrow();
    expect(snap.status).toBe('eliminated');
    expect(snap.pendingGarbage).toBe(4);
    const withoutPending = buildOtherSeatSnapshot(g, 1, 'playing');
    expect(otherSeatHash(snap)).not.toBe(otherSeatHash(withoutPending));
    expect(() => OTHER_SEAT_SNAPSHOT_SCHEMA.parse(withoutPending)).not.toThrow();
  });
});