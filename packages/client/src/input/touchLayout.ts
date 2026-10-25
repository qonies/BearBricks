// 触控按键尺寸反算（H-7）：一行 5 个键（3 移动 + 2 动作）
// 固定开销 = 外间距 16 + 左右 padding 24 + 3 个内间距 24 = 64；其余均分给 5 个键。
export const TOUCH_BASE_SIZE = 58;
export const TOUCH_MIN_SIZE = 44;
export const TOUCH_INNER_GAP = 8;
export const TOUCH_OUTER_GAP = 16;
export const TOUCH_H_PADDING = 24;

/**
 * 单个触控键边长：优先使用用户倍率，但必须塞得进可用宽度（320px Split View 也不重叠）。
 * availableWidth <= 0（尚未测量）时返回倍率值，由 ResizeObserver 随后校正。
 */
export function computeTouchButtonSize(availableWidth: number, scale: number): number {
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const preferred = Math.round(TOUCH_BASE_SIZE * s);
  if (!Number.isFinite(availableWidth) || availableWidth <= 0) {
    return Math.max(TOUCH_MIN_SIZE, preferred);
  }
  const fit = Math.floor(
    (availableWidth - (TOUCH_OUTER_GAP + TOUCH_H_PADDING + TOUCH_INNER_GAP * 3)) / 5,
  );
  return Math.max(TOUCH_MIN_SIZE, Math.min(preferred, fit));
}
