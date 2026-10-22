// M4 timed 限时赛（TC-MD-C-001/002/003）：策略（攻击/RESPAWN/marathon 语义）、
// 排名（总分→消行→顶出次数，平局并列，abandoned 移出）、引擎 respawn（清盘保分）、快照 modeState.timed

import { describe, expect, it } from 'vitest';
import {
  SELF_SNAPSHOT_SCHEMA,
  TetrisGame,
  TIMED_DEFAULT_TIME_LIMIT,
  TIMED_TIME_LIMITS,
  buildSelfSnapshot,
  computeTimedRanking,
  createModeStrategy,
  TimedStrategy,
} from '../src';

describe('timed 策略（TC-MD-C-002 / ADR-0005）', () => {
  const s = new TimedStrategy();

  it('攻击开启，与 survival 同用攻击表：Double 1 / Tetris 4 / B2B 加成', () => {
    expect(s.onLinesCleared({ lines: 2, tspin: 'none', combo: 1, b2b: false, perfectClear: false })).toEqual({ lines: 1 });
    expect(s.onLinesCleared({ lines: 4, tspin: 'none', combo: 1, b2b: false, perfectClear: false })).toEqual({ lines: 4 });
    expect(s.onLinesCleared({ lines: 2, tspin: 'none', combo: 1, b2b: true, perfectClear: false })).toEqual({ lines: 2 });
  });

  it('顶出 → RESPAWN；引擎语义 marathon（顶出即终局，由 Room 复活）', () => {
    expect(s.onTopOut()).toBe('RESPAWN');
    expect(s.engineMode()).toBe('marathon');
    expect(createModeStrategy('timed')).toBeInstanceOf(TimedStrategy);
  });

  it('timeLimit 常量：可选 120/180/300，默认 180（FR-2.6）', () => {
    expect(TIMED_TIME_LIMITS).toEqual([120, 180, 300]);
    expect(TIMED_DEFAULT_TIME_LIMIT).toBe(180);
  });
});

describe('timed 排名（TC-MD-C-001/003 / requirements §4.4 §C）', () => {
  it('总分降序 → 消行数降序 → 顶出次数升序', () => {
    const ranks = computeTimedRanking([
      { seatId: 0, score: 100, lines: 10, topOuts: 0 },
      { seatId: 1, score: 300, lines: 8, topOuts: 1 },
      { seatId: 2, score: 200, lines: 20, topOuts: 2 },
      { seatId: 3, score: 200, lines: 20, topOuts: 5 },
    ]);
    expect(ranks.get(1)).toBe(1); // 总分最高
    expect(ranks.get(2)).toBe(2); // 同分比消行
    expect(ranks.get(3)).toBe(3); // 同分同消行比顶出次数
    expect(ranks.get(0)).toBe(4);
  });

  it('完全同分同消行同顶出 → 并列；abandoned 移出排名', () => {
    const ranks = computeTimedRanking([
      { seatId: 0, score: 500, lines: 30, topOuts: 1 },
      { seatId: 1, score: 500, lines: 30, topOuts: 1 },
      { seatId: 2, score: 100, lines: 5, topOuts: 0, abandoned: true },
    ]);
    expect(ranks.get(0)).toBe(1);
    expect(ranks.get(1)).toBe(1); // 平局并列
    expect(ranks.has(2)).toBe(false); // abandoned 不参与排名
  });

  it('消行数多的同分者名次更高（score 并列时）', () => {
    const ranks = computeTimedRanking([
      { seatId: 0, score: 400, lines: 5, topOuts: 0 },
      { seatId: 1, score: 400, lines: 12, topOuts: 0 },
    ]);
    expect(ranks.get(1)).toBe(1);
    expect(ranks.get(0)).toBe(2);
  });
});

describe('引擎 respawn（TC-MD-C-002：棋盘清空、分数/消行保留）', () => {
  it('顶出后 respawn：status 恢复 running、棋盘清空、active 生成、score/lines/level 保留', () => {
    const g = new TetrisGame({ mode: 'marathon', seed: 'timed-respawn' });
    while (g.status === 'running') g.applyInput('hard'); // 连续硬降堆满 → 顶出
    expect(g.status).toBe('finished');
    expect(g.topOut).toBe(true);
    const { score, lines, level } = g;
    g.respawn();
    expect(g.status).toBe('running');
    expect(g.topOut).toBe(false);
    expect(g.score).toBe(score);
    expect(g.lines).toBe(lines);
    expect(g.level).toBe(level);
    expect(g.active).not.toBeNull();
    expect(g.board.every((c) => c === null)).toBe(true);
    expect(g.combo).toBe(0);
    expect(g.canHold).toBe(true);
    // 复活后可继续正常游玩（update 推进不报错、方块继续下落）
    expect(() => g.update(16)).not.toThrow();
  });
});

describe('timed 快照协议（modeState.timed）', () => {
  it('self 快照通过 schema 校验（endsAt/respawnAt/immuneUntil）', () => {
    const g = new TetrisGame({ mode: 'marathon', seed: 'snap-timed' });
    const snap = buildSelfSnapshot(g, 10, 3, {
      timed: { endsAt: 1234567890, respawnAt: 1234567000, immuneUntil: 1234570000 },
    });
    expect(() => SELF_SNAPSHOT_SCHEMA.parse(snap)).not.toThrow();
    expect(snap.modeState.timed?.endsAt).toBe(1234567890);
    expect(snap.modeState.timed?.respawnAt).toBe(1234567000);
    expect(snap.modeState.timed?.immuneUntil).toBe(1234570000);
  });

  it('respawnAt/immuneUntil 可省略（正常对局中仅 endsAt）', () => {
    const g = new TetrisGame({ mode: 'marathon', seed: 'snap-timed2' });
    const snap = buildSelfSnapshot(g, 0, 0, { timed: { endsAt: 42 } });
    expect(() => SELF_SNAPSHOT_SCHEMA.parse(snap)).not.toThrow();
    expect(snap.modeState.timed?.respawnAt).toBeUndefined();
  });

  it('v1.5：self 快照携带座位 status 与 timed.pendingGarbage', () => {
    const g = new TetrisGame({ mode: 'marathon', seed: 'snap-timed3' });
    const snap = buildSelfSnapshot(
      g,
      5,
      2,
      { timed: { endsAt: 1000, pendingGarbage: 3 } },
      'playing',
    );
    expect(() => SELF_SNAPSHOT_SCHEMA.parse(snap)).not.toThrow();
    expect(snap.status).toBe('playing');
    expect(snap.modeState.timed?.pendingGarbage).toBe(3);
    const eliminated = buildSelfSnapshot(g, 5, 2, { timed: { endsAt: 1000 } }, 'eliminated');
    expect(eliminated.status).toBe('eliminated');
    // 省略 status 时字段不出现（向后兼容旧客户端）
    const legacy = buildSelfSnapshot(g, 0, 0, { timed: { endsAt: 1 } });
    expect('status' in legacy).toBe(false);
    expect(() => SELF_SNAPSHOT_SCHEMA.parse(legacy)).not.toThrow();
  });
});