import { describe, expect, it } from 'vitest';
import { computeTouchButtonSize } from '../src/input/touchLayout';

describe('computeTouchButtonSize（320px Split View 触控布局）', () => {
  it('320px 默认/小/大档都收缩到 51px，塞得下 5 键 + 间距', () => {
    expect(computeTouchButtonSize(320, 1)).toBe(51);
    expect(computeTouchButtonSize(320, 0.9)).toBe(51);
    expect(computeTouchButtonSize(320, 1.15)).toBe(51);
  });

  it('375px 及以上使用用户倍率（58px 基准）', () => {
    expect(computeTouchButtonSize(375, 1)).toBe(58);
    expect(computeTouchButtonSize(400, 1)).toBe(58);
    expect(computeTouchButtonSize(400, 1.15)).toBe(67);
  });

  it('极窄时不低于 44px 命中区（由外层 flex-wrap 换行兜底）', () => {
    expect(computeTouchButtonSize(280, 1)).toBe(44);
  });

  it('未测量（0/NaN）时返回倍率值', () => {
    expect(computeTouchButtonSize(0, 1)).toBe(58);
    expect(computeTouchButtonSize(Number.NaN, 0.9)).toBe(52);
  });
});
