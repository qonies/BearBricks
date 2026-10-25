// 棋盘手势识别（纯逻辑，技术设计 §5.6 / FR-12.3：虚拟按键 + 滑动手势）
// 只跟踪第一根手指（多指整体忽略，避免误触）；输出仍是离散 GameAction，
// 由 InputRouter 走与键盘/按键完全相同的通道。

import type { GameAction } from '@bearbricks/shared';

export interface GestureOptions {
  /** 横向移动一格所需位移（px），通常取棋盘格宽 */
  stepPx: number;
  /** 轻点动作（默认顺时针旋转） */
  tapAction: GameAction;
  /** 下滑动作：hard = 硬降；soft = 逐格软降（每 SOFT_STEP_PX 一格） */
  downAction: 'hard' | 'soft';
}

/** 轻点判定上限（px）：位移小于该值视为轻点 */
export const TAP_MAX_PX = 10;
/** 纵向手势最小位移（px）：小于该值不触发硬降/软降/Hold */
export const SWIPE_MIN_PX = 24;
/** 硬降判定所需纵向位移（px） */
export const HARD_MIN_PX = 56;
/** 横向移动阈值占格宽比例：略小于 1 格，手感更跟手 */
const STEP_RATIO = 0.8;
/** 纵向占优系数：横向位移过大时不判为纵向手势 */
const VERTICAL_DOMINANCE = 1.2;
/** 下滑软降模式下每格所需位移（px） */
const SOFT_STEP_PX = 28;

interface Track {
  id: number;
  x0: number;
  y0: number;
  /** 已累计发出的横向列数（有符号：+ 向右 / - 向左） */
  cols: number;
  /** 已累计发出的软降格数 */
  softSteps: number;
  /** 已触发一次性动作（硬降），后续事件忽略 */
  done: boolean;
}

export class GestureRecognizer {
  private track: Track | null = null;

  get active(): boolean {
    return this.track != null;
  }

  /** 返回 false 表示本次指针不参与手势（已有一根手指在跟踪） */
  begin(id: number, x: number, y: number): boolean {
    if (this.track) return false;
    this.track = { id, x0: x, y0: y, cols: 0, softSteps: 0, done: false };
    return true;
  }

  move(id: number, x: number, y: number, opts: GestureOptions): GameAction[] {
    const t = this.track;
    if (!t || t.id !== id || t.done) return [];
    const out: GameAction[] = [];
    const dx = x - t.x0;
    const dy = y - t.y0;

    // 纵向优先：下滑足够长且纵向占优
    if (dy >= SWIPE_MIN_PX && Math.abs(dy) > Math.abs(dx) * VERTICAL_DOMINANCE) {
      if (opts.downAction === 'hard') {
        if (dy >= HARD_MIN_PX) {
          t.done = true;
          out.push('hard');
        }
        return out;
      }
      const target = Math.floor(dy / SOFT_STEP_PX);
      while (t.softSteps < target) {
        t.softSteps++;
        out.push('soft');
      }
      return out;
    }

    // 横向逐格移动（允许中途反向：按有符号列数差值补齐/回退）
    const step = Math.max(8, opts.stepPx * STEP_RATIO);
    const target = Math.trunc(dx / step);
    while (t.cols !== target) {
      if (target > t.cols) {
        t.cols++;
        out.push('moveR');
      } else {
        t.cols--;
        out.push('moveL');
      }
    }
    return out;
  }

  end(id: number, x: number, y: number, opts: GestureOptions): GameAction[] {
    const t = this.track;
    // 先校验 pointerId：第二根手指的 pointerup 不能清掉第一根手指的手势（多指忽略）
    if (!t || t.id !== id || t.done) return [];
    this.track = null;
    const dx = x - t.x0;
    const dy = y - t.y0;
    if (Math.hypot(dx, dy) <= TAP_MAX_PX) return [opts.tapAction];
    // 上滑 = Hold（下滑已在 move 中处理，避免同一手势重复触发）
    if (dy <= -SWIPE_MIN_PX && Math.abs(dy) > Math.abs(dx)) return ['hold'];
    return [];
  }

  cancel(id?: number): void {
    if (id != null && this.track && this.track.id !== id) return;
    this.track = null;
  }
}
