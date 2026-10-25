// 消行三闪动画（技术设计 §5.1）：纯视觉层。
// 引擎只在 lock() 时记录"消行前的棋盘 + 被消除行号"（ClearVisual），客户端在 240ms 内
// 以 3 次明暗闪烁呈现，随后切回实时棋盘（行已塌下）。不参与权威状态：
// stateHash / 协议快照 / 攻击与垃圾行判定完全不受影响。

import type { Board, ClearVisual, TetrisGame } from '@bearbricks/shared';

/** 单相位（亮 / 暗）时长 */
export const CLEAR_FLASH_MS = 40;
/** 闪烁次数（亮-暗 × N） */
export const CLEAR_FLASH_COUNT = 3;
/** 动画总时长 = N × (亮 + 暗) */
export const CLEAR_FX_MS = CLEAR_FLASH_MS * 2 * CLEAR_FLASH_COUNT;

export interface ClearFxFrame {
  /** 消行前的棋盘（含待消失行） */
  board: Board;
  /** 待闪烁行号（消行前坐标，升序） */
  rows: number[];
  /** true = 亮（白色覆盖）；false = 暗（原色压暗） */
  flashOn: boolean;
}

/**
 * 跟踪引擎的 clearVisual 并在本地播一次三闪动画。
 * 帧循环里每帧 `update(game, now)` → `frame(now)`，无动画时 frame 返回 null（绘制实时棋盘）。
 */
export class ClearFxTracker {
  private lastId: number;
  private fx: { view: ClearVisual; startedAt: number } | null = null;

  /** 用引擎当前 clearVisual.id 播种：构造前已发生的消行不会被补播 */
  constructor(game?: TetrisGame) {
    this.lastId = game?.clearVisual?.id ?? 0;
  }

  /** 发现新的消行事件 → 启动一次动画（快照副本：引擎继续推进/被快照校正都不影响播放） */
  update(game: TetrisGame, now: number = performance.now()): void {
    const v = game.clearVisual;
    if (!v || v.id === this.lastId) return;
    this.lastId = v.id;
    this.fx = { view: { id: v.id, rows: [...v.rows], board: [...v.board] }, startedAt: now };
  }

  /** 当前应绘制的动画帧；动画结束返回 null */
  frame(now: number = performance.now()): ClearFxFrame | null {
    const fx = this.fx;
    if (!fx) return null;
    const elapsed = Math.max(0, now - fx.startedAt);
    if (elapsed >= CLEAR_FX_MS) {
      this.fx = null;
      return null;
    }
    // 相位 0..5：亮-暗-亮-暗-亮-暗（共 3 次闪烁）
    const phase = Math.floor(elapsed / CLEAR_FLASH_MS);
    return { board: fx.view.board, rows: fx.view.rows, flashOn: phase % 2 === 0 };
  }

  /** 换局 / 重开：清空当前动画并以新引擎的 clearVisual.id 重新播种 */
  reset(game?: TetrisGame): void {
    this.fx = null;
    this.lastId = game?.clearVisual?.id ?? 0;
  }
}
