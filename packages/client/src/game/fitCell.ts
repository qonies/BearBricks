// 棋盘格子尺寸计算（纯函数，技术设计 §5.6 / 需求 1B）
// 单独成文件的原因：不依赖 React/store，可在 Node 环境直接单测。

export interface FitCellOptions {
  cols: number;
  rows: number;
  /** 最小格宽（分屏极窄时也要可玩） */
  min?: number;
  /** 最大格宽（大屏不至于把棋盘拉得过大） */
  max?: number;
}

export function computeCell(width: number, height: number, opts: FitCellOptions): number {
  const { cols, rows, min = 10, max = 34 } = opts;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return min;
  if (cols <= 0 || rows <= 0) return min;
  const fit = Math.floor(Math.min(width / cols, height / rows));
  return Math.max(min, Math.min(max, fit));
}
