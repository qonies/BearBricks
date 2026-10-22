// 全局常量与 Guideline 重力公式（requirements.md §4.1）

export const BOARD_WIDTH = 10;
export const VISIBLE_HEIGHT = 20;
export const HIDDEN_ROWS = 2;
export const TOTAL_HEIGHT = VISIBLE_HEIGHT + HIDDEN_ROWS; // 22

export const LOCK_DELAY_MS = 500;
export const MAX_LOCK_RESETS = 15;
export const DAS_MS = 133;
export const ARR_MS = 33;
export const SOFT_DROP_FACTOR = 20;
export const NEXT_PREVIEW_COUNT = 5;
export const LINES_PER_LEVEL = 10;
export const MAX_LEVEL = 20;

export const SPRINT_TIMEOUT_MS = 300_000; // sprint 超时固定 300s（不可调）
export const RESPAWN_DELAY_MS = 3_000; // timed 模式固定常量（不可调）

/** Guideline 重力：秒/行 = (0.8 - (level-1)*0.007)^(level-1) */
export function gravitySecondsPerLine(level: number): number {
  const lv = Math.min(Math.max(1, Math.floor(level)), MAX_LEVEL);
  return Math.pow(0.8 - (lv - 1) * 0.007, lv - 1);
}
