// DAS/ARR 自动重复调度器（纯逻辑，技术设计 §5.3；EngineRunner 与 NetGameRunner 共用）
// ARR <= 0 表示「瞬间到墙」：越过 DAS 后一次推到墙边（有限次数，绝不死循环），
// 撞墙后闩锁——每个新块最多再试探一次，避免每帧连发 10 条无效输入打爆上行限流

import { BOARD_WIDTH } from '@bearbricks/shared';

export type Dir = 'L' | 'R';

export class AutoShiftScheduler {
  private held: Dir | null = null;
  private dasElapsed = 0;
  private arrElapsed = 0;
  /** ARR=0 撞墙闩锁：true 时每帧仅试探一次（新块生成后可立即解锁） */
  private wallLatched = false;

  constructor(
    private readonly apply: (dir: Dir) => boolean,
    private das: number,
    private arr: number,
  ) {}

  setTiming(das: number, arr: number): void {
    this.das = Math.max(0, das);
    this.arr = Math.max(0, arr);
  }

  press(dir: Dir): void {
    if (this.held !== dir) {
      this.held = dir;
      this.dasElapsed = 0;
      this.arrElapsed = 0;
    }
    this.wallLatched = false;
    this.apply(dir);
  }

  release(dir: Dir): void {
    if (this.held === dir) this.held = null;
  }

  releaseAll(): void {
    this.held = null;
  }

  /** 新方块生成/校正后调用：解除 ARR=0 撞墙闩锁，恢复瞬间到墙（由 Runner 在 active 身份变化时调用） */
  resetWallLatch(): void {
    this.wallLatched = false;
  }

  get heldDirection(): Dir | null {
    return this.held;
  }

  update(dt: number): void {
    if (!this.held || dt <= 0) return;
    this.dasElapsed += dt;
    if (this.dasElapsed < this.das) return;
    // 越过 DAS 的剩余时间计入 ARR
    this.arrElapsed += this.dasElapsed - this.das;
    this.dasElapsed = this.das;
    if (this.arr <= 0) {
      if (this.wallLatched) {
        // 已在墙边：闩锁后不再按帧试探（P1-1：高刷新率下每帧重试会打爆入站限流），
        // 等待 resetWallLatch（新方块/校正）或重新按键解锁
        return;
      }
      // 瞬间到墙：最多 BOARD_WIDTH 次有效移动，有限循环
      let moved = 0;
      for (let i = 0; i < BOARD_WIDTH; i++) {
        if (!this.apply(this.held)) break;
        moved++;
      }
      if (moved < BOARD_WIDTH) this.wallLatched = true; // 撞墙 → 闩锁，停止连发
      return;
    }
    while (this.arrElapsed >= this.arr) {
      this.arrElapsed -= this.arr;
      this.apply(this.held);
    }
  }
}
