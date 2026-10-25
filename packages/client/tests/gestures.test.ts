// 手势识别（FR-12.3 / 技术设计 §5.6）：轻点旋转、横滑逐格、下滑落子、上滑 Hold、多指忽略

import { describe, expect, it } from 'vitest';
import { GestureRecognizer, type GestureOptions } from '../src/input/gestures';

const hard: GestureOptions = { stepPx: 30, tapAction: 'rotCW', downAction: 'hard' };
const soft: GestureOptions = { ...hard, downAction: 'soft' };

describe('GestureRecognizer', () => {
  it('轻点（位移 ≤10px）→ 顺时针旋转', () => {
    const g = new GestureRecognizer();
    g.begin(1, 100, 100);
    expect(g.move(1, 104, 103, hard)).toEqual([]);
    expect(g.end(1, 104, 103, hard)).toEqual(['rotCW']);
  });

  it('横滑按格宽 80% 逐格移动，越过阈值才发动作', () => {
    const g = new GestureRecognizer();
    g.begin(1, 100, 100);
    expect(g.move(1, 110, 100, hard)).toEqual([]); // 10 < 24（30*0.8）
    expect(g.move(1, 125, 100, hard)).toEqual(['moveR']);
    expect(g.move(1, 150, 100, hard)).toEqual(['moveR']);
    expect(g.end(1, 150, 100, hard)).toEqual([]);
  });

  it('横滑反向回退时按有符号列数补齐 moveL', () => {
    const g = new GestureRecognizer();
    g.begin(1, 200, 100);
    expect(g.move(1, 280, 100, hard)).toEqual(['moveR', 'moveR', 'moveR']); // 80/24 = 3 格
    expect(g.move(1, 200, 100, hard)).toEqual(['moveL', 'moveL', 'moveL']);
  });

  it('下滑 ≥56px 且纵向占优 → 硬降只触发一次', () => {
    const g = new GestureRecognizer();
    g.begin(1, 100, 100);
    expect(g.move(1, 102, 160, hard)).toEqual(['hard']);
    expect(g.move(1, 102, 200, hard)).toEqual([]);
    expect(g.end(1, 102, 200, hard)).toEqual([]);
  });

  it('下滑 mode=soft 时逐格软降（每 28px 一格）', () => {
    const g = new GestureRecognizer();
    g.begin(1, 100, 100);
    expect(g.move(1, 100, 120, soft)).toEqual([]);
    expect(g.move(1, 100, 130, soft)).toEqual(['soft']);
    expect(g.move(1, 100, 160, soft)).toEqual(['soft']);
  });

  it('上滑 → Hold', () => {
    const g = new GestureRecognizer();
    g.begin(1, 100, 200);
    expect(g.end(1, 102, 150, hard)).toEqual(['hold']);
  });

  it('多指忽略：第二根手指不接管手势', () => {
    const g = new GestureRecognizer();
    expect(g.begin(1, 100, 100)).toBe(true);
    expect(g.begin(2, 300, 300)).toBe(false);
    expect(g.move(2, 360, 300, hard)).toEqual([]); // 非跟踪指针
    expect(g.move(1, 130, 100, hard)).toEqual(['moveR']);
  });

  it('第二根手指抬起不终止第一根手指的手势（H-2 回归）', () => {
    const g = new GestureRecognizer();
    g.begin(1, 100, 100);
    expect(g.end(2, 300, 300, hard)).toEqual([]);
    expect(g.active).toBe(true);
    expect(g.move(1, 130, 100, hard)).toEqual(['moveR']);
    expect(g.end(1, 130, 100, hard)).toEqual([]);
  });

  it('cancel 后不再产生动作（pointercancel 防护）', () => {
    const g = new GestureRecognizer();
    g.begin(1, 100, 100);
    g.move(1, 140, 100, hard);
    g.cancel(1);
    expect(g.active).toBe(false);
    expect(g.end(1, 140, 100, hard)).toEqual([]);
  });

  it('cancel(其它指针) 不影响当前跟踪', () => {
    const g = new GestureRecognizer();
    g.begin(1, 100, 100);
    g.cancel(2);
    expect(g.active).toBe(true);
    expect(g.end(1, 100, 100, hard)).toEqual(['rotCW']);
  });
});
