// TC-ENG-007：计分（含 B2B/Combo/PC）；TC-ENG-008：T-Spin 判定；TC-ENG-009：攻击表

import { describe, expect, it } from 'vitest';
import { BOARD_WIDTH, calcAttack, createBoard, detectTSpin, scoreClear } from '../src';

describe('计分（TC-ENG-007）', () => {
  const base = { tspin: 'none', perfectClear: false, b2bEligible: false, combo: 0 } as const;

  it('Single~Tetris × 等级', () => {
    expect(scoreClear({ ...base, lines: 1, level: 1 }).points).toBe(100);
    expect(scoreClear({ ...base, lines: 2, level: 2 }).points).toBe(600);
    expect(scoreClear({ ...base, lines: 3, level: 2 }).points).toBe(1000);
    expect(scoreClear({ ...base, lines: 4, level: 3 }).points).toBe(2400);
  });

  it('B2B：Tetris ×1.5', () => {
    const r = scoreClear({ ...base, lines: 4, level: 3, b2bEligible: true });
    expect(r.points).toBe(3600);
    expect(r.b2bUsed).toBe(true);
    expect(r.difficult).toBe(true);
  });

  it('B2B 不作用于普通消行', () => {
    expect(scoreClear({ ...base, lines: 2, level: 1, b2bEligible: true }).b2bUsed).toBe(false);
  });

  it('T-Spin 系列', () => {
    expect(scoreClear({ ...base, tspin: 'normal', lines: 1, level: 2 }).points).toBe(1600);
    expect(scoreClear({ ...base, tspin: 'normal', lines: 2, level: 1 }).points).toBe(1200);
    expect(scoreClear({ ...base, tspin: 'mini', lines: 1, level: 1 }).points).toBe(200);
    expect(scoreClear({ ...base, tspin: 'normal', lines: 0, level: 1 }).points).toBe(400);
    expect(scoreClear({ ...base, tspin: 'mini', lines: 0, level: 1 }).points).toBe(100);
  });

  it('Combo：第 n 连额外 50×(n-1)×等级', () => {
    // 第 3 连（combo=3），Single，level 2 → 200 + 200
    expect(scoreClear({ ...base, lines: 1, level: 2, combo: 3 }).points).toBe(400);
    // 首消无加成
    expect(scoreClear({ ...base, lines: 1, level: 2, combo: 1 }).points).toBe(200);
  });

  it('Perfect Clear +3500', () => {
    expect(scoreClear({ ...base, lines: 1, level: 1, perfectClear: true }).points).toBe(3600);
  });
});

describe('T-Spin 判定（TC-ENG-008）', () => {
  it('3 角规则：正面两角占据 → normal，否则 mini；最后动作非旋转 → none', () => {
    const b = createBoard();
    // T 盒在 (4,10)，rot2（指向下），正面角 = (4,12),(6,12)
    b[10 * BOARD_WIDTH + 4] = 'T';
    b[10 * BOARD_WIDTH + 6] = 'T';
    b[12 * BOARD_WIDTH + 4] = 'T';
    expect(detectTSpin(b, 4, 10, 2, true)).toBe('mini');
    b[12 * BOARD_WIDTH + 6] = 'T';
    expect(detectTSpin(b, 4, 10, 2, true)).toBe('normal');
    expect(detectTSpin(b, 4, 10, 2, false)).toBe('none');
  });

  it('不足 3 角 → none', () => {
    const b = createBoard();
    b[10 * BOARD_WIDTH + 4] = 'T';
    expect(detectTSpin(b, 4, 10, 2, true)).toBe('none');
  });

  it('场外上方角落视为占据（Guideline，TC-ENG-008 边界）', () => {
    const b = createBoard();
    // T 盒在 (4,-1)：上两角在场上方 → 计为占据；正面两角已填 → 4 角满 → normal
    b[1 * BOARD_WIDTH + 4] = 'T';
    b[1 * BOARD_WIDTH + 6] = 'T';
    expect(detectTSpin(b, 4, -1, 2, true)).toBe('normal');
  });
});

describe('攻击表（TC-ENG-009）', () => {
  const base = { tspin: 'none', combo: 0, b2b: false, perfectClear: false } as const;

  it('基础攻击值', () => {
    expect(calcAttack({ ...base, lines: 1 })).toBe(0);
    expect(calcAttack({ ...base, lines: 2 })).toBe(1);
    expect(calcAttack({ ...base, lines: 3 })).toBe(2);
    expect(calcAttack({ ...base, lines: 4 })).toBe(4);
    expect(calcAttack({ ...base, lines: 1, tspin: 'mini' })).toBe(1);
    expect(calcAttack({ ...base, lines: 1, tspin: 'normal' })).toBe(2);
    expect(calcAttack({ ...base, lines: 2, tspin: 'normal' })).toBe(4);
    expect(calcAttack({ ...base, lines: 3, tspin: 'normal' })).toBe(6);
  });

  it('B2B ×1.5 向上取整', () => {
    expect(calcAttack({ ...base, lines: 4, b2b: true })).toBe(6);
    expect(calcAttack({ ...base, lines: 2, b2b: true })).toBe(2); // ceil(1.5)
  });

  it('Combo 加成（第 2 连起 +1，上限 +5）', () => {
    expect(calcAttack({ ...base, lines: 1, combo: 5 })).toBe(4); // 0 + 4
    expect(calcAttack({ ...base, lines: 4, combo: 9 })).toBe(9); // 4 + 5（封顶）
  });

  it('Perfect Clear +10', () => {
    expect(calcAttack({ ...base, lines: 1, perfectClear: true })).toBe(10);
  });
});
