// AutoShiftScheduler：DAS/ARR 与 ARR=0 瞬间到墙（修复原死循环缺陷）

import { describe, expect, it } from 'vitest';
import { TetrisGame } from '@bearbricks/shared';
import { AutoShiftScheduler } from '../src/game/autoshift';

describe('AutoShiftScheduler', () => {
  it('ARR=0：瞬间到墙且不死循环', () => {
    const g = new TetrisGame({ mode: 'marathon', seed: 'arr0' });
    const sched = new AutoShiftScheduler(
      (dir) => g.applyInput(dir === 'L' ? 'moveL' : 'moveR'),
      0,
      0,
    );
    sched.press('R');
    sched.update(16);
    expect(g.active!.x).toBeGreaterThan(3); // 已向右移动
    for (let i = 0; i < 5; i++) sched.update(16); // 不死循环
    expect(g.active!.x).toBe(7); // T rot0 最右（cells 最大 x=2）
  });

  it('ARR=0 撞墙闩锁：不再连发输入，新块生成后 2 帧内再次到墙', () => {
    const g = new TetrisGame({ mode: 'marathon', seed: 'latch' });
    let calls = 0;
    const sched = new AutoShiftScheduler(
      (dir) => {
        calls++;
        return g.applyInput(dir === 'L' ? 'moveL' : 'moveR');
      },
      0,
      0,
    );
    sched.press('R');
    sched.update(16); // 一次推到墙并闩锁
    const atWall = g.active!.x;
    expect(atWall).toBe(7);
    const before = calls;
    for (let i = 0; i < 10; i++) sched.update(16); // 闩锁期：每帧至多 1 次试探
    expect(g.active!.x).toBe(atWall);
    expect(calls - before).toBeLessThanOrEqual(10); // 有限次，而非每帧 10 连发
    g.applyInput('hard'); // 锁定 → 新块
    const newX = g.active!.x;
    sched.update(16); // 试探成功 → 解锁
    sched.update(16); // 瞬间到墙
    expect(g.active!.x).toBeGreaterThan(newX);
    expect(g.active!.x).toBe(7);
  });

  it('DAS 延迟后按 ARR 间隔重复', () => {
    const moves: number[] = [];
    const sched = new AutoShiftScheduler(
      () => {
        moves.push(1);
        return true;
      },
      100,
      50,
    );
    sched.press('L');
    expect(moves.length).toBe(1); // 按下立即一次
    sched.update(50); // 未到 DAS
    expect(moves.length).toBe(1);
    sched.update(60); // 越过 DAS 10ms < ARR
    expect(moves.length).toBe(1);
    sched.update(60); // ARR 累计 70 ≥ 50 → 一次
    expect(moves.length).toBe(2);
  });

  it('换向重置 DAS/ARR 计时', () => {
    const moves: string[] = [];
    const sched = new AutoShiftScheduler(
      (dir) => {
        moves.push(dir);
        return true;
      },
      100,
      50,
    );
    sched.press('L');
    sched.update(90);
    sched.press('R'); // 换向：立即一次并重置
    sched.update(90);
    expect(moves).toEqual(['L', 'R']);
    expect(moves.length).toBe(2); // 未达新 DAS
  });
});
