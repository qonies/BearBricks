// 视口适配（技术设计 §5.6，需求 1B：iPad 横屏 / 竖屏 / 分屏任意尺寸）
// 棋盘格子尺寸由「可用容器尺寸」反推，取代原先写死的 CELL=30 / CELL=26：
//   iPad 横屏高度受限、竖屏宽度受限、Split View/Stage Manager 可压到 ~320px 宽。
// 注意：格子尺寸只能通过 ref 传给 rAF 循环，**绝不能进 GameView/GameViewMP 的 effect 依赖**，
// 否则每次旋转/分屏都会重建 runner，棋局直接丢失。

import { useEffect, useState, type RefObject } from 'react';
import { useSettings } from '../store/settings';
import { computeCell, type FitCellOptions } from './fitCell';

export { computeCell, type FitCellOptions } from './fitCell';

/** 观察容器尺寸（含横竖屏切换 / 分屏拖拽），返回适配后的格子边长 */
export function useFitCell(ref: RefObject<HTMLElement | null>, opts: FitCellOptions): number {
  const { cols, rows } = opts;
  const min = opts.min ?? 10;
  const max = opts.max ?? 34;
  const [cell, setCell] = useState(min);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = (): void => {
      setCell(computeCell(el.clientWidth, el.clientHeight, { cols, rows, min, max }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener('orientationchange', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('orientationchange', measure);
    };
  }, [ref, cols, rows, min, max]);

  return cell;
}

/** 媒体查询（布局分支用；避免在 rAF 里反复 matchMedia） */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia(query).matches,
  );
  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia(query);
    const onChange = (): void => setMatches(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

/** 触屏检测（any-pointer 覆盖 iPad 接妙控键盘/触控板的场景）；可被设置项覆盖 */
export function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(
    () => typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(any-pointer: coarse)').matches,
  );
  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia('(any-pointer: coarse)');
    const onChange = (): void => setCoarse(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return coarse;
}

/** 是否显示屏上触控键（auto 模式下按指针类型判断） */
export function useShowTouchControls(): boolean {
  const mode = useSettings((s) => s.inputMode);
  const coarse = useCoarsePointer();
  if (mode === 'touch') return true;
  if (mode === 'keyboard') return false;
  return coarse;
}
