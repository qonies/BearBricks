// TC-ENG-005：锁定延迟与重置上限；TC-ENG-011：重力公式；TC-ENG-012：Hold；
// TC-ENG-013：Lock Out / Block Out 顶出；TC-MD-A-003：sprint 顶出清盘保留计数

import { describe, expect, it } from 'vitest';
import {
  BOARD_WIDTH,
  SPRINT_TIMEOUT_MS,
  TetrisGame,
  collides,
  gravitySecondsPerLine,
  pieceCells,
  type GameMode,
} from '../src';

/** 让当前块真正落地（软降至下方碰撞即触地，锁定延迟仅累积极少量时间） */
function groundPiece(g: TetrisGame): void {
  g.setSoftDrop(true);
  for (let i = 0; i < 600; i++) {
    g.update(10);
    const a = g.active;
    if (!a) break;
    if (collides(g.board, pieceCells(a.type, a.rot), a.x, a.y + 1)) break;
  }
  g.setSoftDrop(false);
}

/** 填充棋盘区域（留最右列空，避免填满整行意外触发消行） */
function fillBoard(g: TetrisGame, fromRow: number, toRow: number): void {
  for (let r = fromRow; r < toRow; r++)
    for (let c = 0; c < BOARD_WIDTH - 1; c++) g.board[r * BOARD_WIDTH + c] = 'G';
}

function makeGame(mode: GameMode, seed: string): TetrisGame {
  return new TetrisGame({ mode, seed, targetLines: 40 });
}

describe('重力公式（TC-ENG-011）', () => {
  it('level 1/5/10/15/20 数值（Guideline: (0.8-(lv-1)*0.007)^(lv-1) 秒/行）', () => {
    expect(gravitySecondsPerLine(1)).toBeCloseTo(1.0, 6); // 0.8^0 = 1
    expect(gravitySecondsPerLine(5)).toBeCloseTo(0.3552, 3);
    expect(gravitySecondsPerLine(10)).toBeCloseTo(0.0642, 3);
    expect(gravitySecondsPerLine(15)).toBeCloseTo(0.00706, 4); // 0.702^14
    expect(gravitySecondsPerLine(20)).toBeCloseTo(0.000455, 5); // 0.667^19
  });
});

describe('锁定延迟（TC-ENG-005）', () => {
  it('500ms 内不锁定，超时强制锁定', () => {
    const g = makeGame('marathon', 'lock-delay');
    groundPiece(g);
    const filledBefore = g.board.filter((c) => c !== null).length;
    g.update(400);
    expect(g.status).toBe('running');
    expect(g.board.filter((c) => c !== null).length).toBe(filledBefore);
    g.update(200); // 累计 ≥ 500ms → 锁定并生成下一块
    expect(g.board.filter((c) => c !== null).length).toBeGreaterThanOrEqual(filledBefore + 4);
    expect(g.active?.y).toBe(1); // 新块出生后下移一格（Guideline），底行进入可见区
  });

  it('移动/旋转重置 15 次后强制锁定', () => {
    const g = makeGame('marathon', 'move-reset');
    groundPiece(g);
    // 15 次成功移动，每次重置锁定延迟
    for (let i = 0; i < 15; i++) {
      const moved = g.applyInput(i % 2 === 0 ? 'moveR' : 'moveL');
      expect(moved).toBe(true);
      g.update(100); // 每次重置后 100ms 不会锁定
      expect(g.status).toBe('running');
    }
    // 第 16 次移动成功但不再重置 → 600ms 后锁定
    g.applyInput('moveR');
    g.update(600);
    expect(g.board.filter((c) => c !== null).length).toBeGreaterThanOrEqual(4);
  });
});

describe('Hold（TC-ENG-012）', () => {
  it('每块锁定前最多 1 次；锁定后复位', () => {
    const g = makeGame('marathon', 'hold');
    const first = g.active!.type;
    const second = g.queue[0];
    expect(g.applyInput('hold')).toBe(true);
    expect(g.hold).toBe(first);
    expect(g.active!.type).toBe(second);
    expect(g.canHold).toBe(false);
    expect(g.applyInput('hold')).toBe(false);
    g.applyInput('hard');
    expect(g.canHold).toBe(true);
  });
});

describe('顶出（TC-ENG-013）', () => {
  it('Lock Out：完全锁在隐藏缓冲区 → marathon 结束', () => {
    const g = makeGame('marathon', 'lock-out');
    fillBoard(g, 2, 22); // 可见区全满，出生位(隐藏区)空闲
    g.update(600); // 出生即触地 → 锁定延迟到期
    expect(g.status).toBe('finished');
    expect(g.topOut).toBe(true);
  });

  it('Block Out：出生位被占 → marathon 结束', () => {
    const g = makeGame('marathon', 'block-out');
    g.board[0 * BOARD_WIDTH + 4] = 'T';
    g.board[1 * BOARD_WIDTH + 3] = 'T';
    g.board[1 * BOARD_WIDTH + 4] = 'T';
    g.board[1 * BOARD_WIDTH + 5] = 'T';
    g.spawnActive();
    expect(g.status).toBe('finished');
    expect(g.topOut).toBe(true);
  });

  it('sprint 顶出：棋盘清空重来、消行计数保留（TC-MD-A-003）', () => {
    const g = makeGame('sprint', 'sprint-reset');
    g.lines = 23; // 模拟已有进度
    g.combo = 3;
    g.b2bActive = true;
    fillBoard(g, 2, 22);
    g.update(600);
    expect(g.status).toBe('running'); // 不结束
    expect(g.board.every((c) => c === null)).toBe(true); // 棋盘清空
    expect(g.lines).toBe(23); // 计数保留
    expect(g.combo).toBe(0); // 顶出重置连击
    expect(g.b2bActive).toBe(false);
  });
});

describe('sprint 计时（TC-MD-A-004 前置）', () => {
  it('300s 超时结束', () => {
    const g = makeGame('sprint', 'sprint-timeout');
    // 以 60Hz 步长推进 301s
    const steps = Math.ceil((SPRINT_TIMEOUT_MS + 1000) / (1000 / 60));
    for (let i = 0; i < steps && g.status === 'running'; i++) g.update(1000 / 60);
    expect(g.status).toBe('finished');
    expect(g.finishTimeMs).toBeNull(); // 超时未完赛
  });
});

describe('踢墙旋转功能验证（TC-ENG-001/002 补充）', () => {
  it('T 块贴右墙 0→R 经踢墙成功', () => {
    const g = makeGame('marathon', 'kick-t');
    g.active!.x = 8; // rot0 格子最大 x=2 → 10 越界，需踢墙
    expect(g.applyInput('rotCW')).toBe(true);
    expect(g.active!.rot).toBe(1);
    expect(g.active!.x).toBe(7); // 命中 (-1, 0) 偏移
  });

  it('I 块贴地 0→R 经 (1,2) 踢墙成功', () => {
    const g = makeGame('marathon', 'kick-i');
    g.active = { type: 'I', x: 3, y: 19, rot: 0 };
    expect(g.applyInput('rotCW')).toBe(true);
    expect(g.active!.rot).toBe(1);
    expect(g.active!.y).toBe(17); // ny = 19 - 2
  });
});

describe('出生下移与软降计分（M2 前置修复）', () => {
  it('出生后下移一格：至少一行进入可见区', () => {
    const g = makeGame('marathon', 'spawn-drop');
    expect(g.active!.y).toBe(1);
    const cells = pieceCells(g.active!.type, g.active!.rot);
    const maxY = Math.max(...cells.map(([, cy]) => cy));
    expect(g.active!.y + maxY).toBeGreaterThanOrEqual(2); // HIDDEN_ROWS = 2
  });

  it('applyInput("soft") 成功下移一格并 +1 分（与持续软降同分）', () => {
    const g = makeGame('marathon', 'soft-score');
    expect(g.applyInput('soft')).toBe(true);
    expect(g.score).toBe(1);
  });

  it('sprint Block Out 同样重置 combo/B2B（与 Lock Out 一致）', () => {
    const g = makeGame('sprint', 'blockout-reset');
    g.combo = 3;
    g.b2bActive = true;
    g.board[0 * BOARD_WIDTH + 4] = 'T';
    g.board[1 * BOARD_WIDTH + 3] = 'T';
    g.board[1 * BOARD_WIDTH + 4] = 'T';
    g.board[1 * BOARD_WIDTH + 5] = 'T';
    g.spawnActive();
    expect(g.status).toBe('running');
    expect(g.combo).toBe(0);
    expect(g.b2bActive).toBe(false);
  });

  it('applySnapshotState 重建状态且 stateHash 与源一致', () => {
    const a = makeGame('sprint', 'snap-a');
    a.applyInput('moveR');
    a.applyInput('hard');
    const b = new TetrisGame({ mode: 'sprint', targetLines: 40, seed: 'snap-b' });
    b.applySnapshotState({
      board: a.board,
      active: a.active,
      queue: a.queue,
      hold: a.hold,
      canHold: a.canHold,
      score: a.score,
      lines: a.lines,
      level: a.level,
      combo: a.combo,
      b2bActive: a.b2bActive,
      elapsedMs: a.elapsedMs,
    });
    expect(b.stateHash()).toBe(a.stateHash());
  });

  it('applySnapshotState 携带 status：running 恢复本地预测的顶出卡死 / finished 落地终局', () => {
    const g = makeGame('marathon', 'snap-status');
    g.status = 'finished';
    g.topOut = true;
    g.finishTimeMs = 123;
    g.applySnapshotState({
      board: g.board,
      active: g.active,
      queue: g.queue,
      hold: g.hold,
      canHold: g.canHold,
      score: 0,
      lines: 0,
      level: 1,
      combo: 0,
      b2bActive: false,
      elapsedMs: 0,
      status: 'running',
    });
    expect(g.status).toBe('running');
    expect(g.topOut).toBe(false);
    expect(g.finishTimeMs).toBeNull();
    expect(g.applyInput('moveR')).toBe(true); // 卡死解除：可继续操作

    const h = makeGame('marathon', 'snap-status2');
    h.applySnapshotState({
      board: h.board,
      active: h.active,
      queue: h.queue,
      hold: h.hold,
      canHold: h.canHold,
      score: 0,
      lines: 0,
      level: 1,
      combo: 0,
      b2bActive: false,
      elapsedMs: 0,
      status: 'finished',
    });
    expect(h.status).toBe('finished');
    expect(h.applyInput('moveR')).toBe(false);
  });
});

describe('Hold 出生下移一致性（holdSwap 不得双重 postSpawnDrop）', () => {
  it('Hold 为空取新块：出生 y 与正常出生一致（都只下移一格）', () => {
    const a = makeGame('marathon', 'hold-drop-a');
    const b = makeGame('marathon', 'hold-drop-a'); // 同 seed 同序列
    const normalY = a.active!.y;
    expect(b.applyInput('hold')).toBe(true);
    expect(b.active!.y).toBe(normalY);
    expect(b.active!.type).toBe(a.queue[0]);
  });

  it('Hold 交换回已存块：出生 y 同样只下移一格', () => {
    const g = makeGame('marathon', 'hold-drop-b');
    const first = g.active!;
    expect(g.applyInput('hold')).toBe(true);
    const swappedY = g.active!.y;
    g.canHold = true;
    expect(g.applyInput('hold')).toBe(true);
    expect(g.active!.type).toBe(first.type);
    expect(g.active!.y).toBe(swappedY);
  });
});

describe('垃圾行溢出（receiveGarbage 顶出判定）', () => {
  it('堆叠被垃圾推出场地上界 → 按模式顶出（不得静默丢弃方块）', () => {
    const g = makeGame('marathon', 'garbage-overflow');
    for (let r = 0; r < 22; r++)
      for (let c = 0; c < BOARD_WIDTH; c++) g.board[r * BOARD_WIDTH + c] = 'G';
    g.receiveGarbage(4, 0);
    expect(g.status).toBe('finished');
    expect(g.topOut).toBe(true);
  });

  it('未溢出的垃圾插入不触发顶出（回归：正常攻击链路）', () => {
    const g = makeGame('marathon', 'garbage-ok');
    g.receiveGarbage(4, 0);
    expect(g.status).toBe('running');
    expect(g.topOut).toBe(false);
    expect(g.board.slice((22 - 4) * BOARD_WIDTH).every((c, i) => (i % 10 === 0 ? c === null : c === 'G'))).toBe(true);
  });
});
