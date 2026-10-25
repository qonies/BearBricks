// 棋盘格子自适应（需求 1B / 技术设计 §5.6）：横屏受限高、竖屏受限宽、分屏极窄

import { describe, expect, it } from 'vitest';
import { computeCell } from '../src/game/fitCell';

const opts = { cols: 10, rows: 20 };

describe('computeCell', () => {
  it('高度受限（iPad 横屏）：按高度反推', () => {
    expect(computeCell(1180, 700, opts)).toBe(34); // 700/20=35 → 上限 34
    expect(computeCell(1180, 560, opts)).toBe(28);
  });

  it('宽度受限（分屏窄栏）：按宽度反推', () => {
    expect(computeCell(320, 900, opts)).toBe(32);
    expect(computeCell(240, 900, opts)).toBe(24);
  });

  it('上限 / 下限钳制', () => {
    expect(computeCell(4000, 4000, opts)).toBe(34);
    expect(computeCell(4000, 4000, { ...opts, max: 44 })).toBe(44);
    expect(computeCell(60, 60, opts)).toBe(10);
    expect(computeCell(60, 60, { ...opts, min: 6 })).toBe(6);
  });

  it('无效尺寸回退到最小格宽（布局未测量完成时）', () => {
    expect(computeCell(0, 700, opts)).toBe(10);
    expect(computeCell(700, 0, opts)).toBe(10);
    expect(computeCell(Number.NaN, 700, opts)).toBe(10);
    expect(computeCell(700, 700, { cols: 0, rows: 20, min: 9 })).toBe(9);
  });
});
