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

  it('ARR=0 撞墙闩锁：闩锁后不再按帧试探，新方块需显式解锁（P1-1）', () => {
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
    for (let i = 0; i < 100; i++) sched.update(16); // 闩锁期：完全静默
    expect(g.active!.x).toBe(atWall);
    expect(calls - before).toBe(0);
    g.applyInput('hard'); // 锁定 → 新块
    const newX = g.active!.x;
    sched.resetWallLatch(); // 新块解锁（Runner 在 active 身份变化时调用）
    sched.update(16); // 瞬间到墙
    expect(g.active!.x).toBeGreaterThan(newX);
    expect(g.active!.x).toBe(7);
  });

  it('ARR=0 高刷新率：240Hz 持续 1 秒，apply 调用次数有界（P1-1 回归）', () => {
    const g = new TetrisGame({ mode: 'marathon', seed: 'hz' });
    let calls = 0;
    const sched = new AutoShiftScheduler(
      (dir) => {
        calls++;
        return g.applyInput(dir === 'L' ? 'moveL' : 'moveR');
      },
      0,
      0,
    );
    sched.press('L');
    for (let i = 0; i < 240; i++) sched.update(1000 / 240);
    // 按下 1 次 + 瞬间到墙批量（≤ BOARD_WIDTH 次）；闩锁后 0 次
    expect(calls).toBeLessThanOrEqual(1 + 10);
    expect(g.active!.x).toBe(0); // T rot0 最左（cells 最小 x=0 → 盒 x=0）
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
