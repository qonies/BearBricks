// 统一输入 hook（技术设计 §5.6）：键盘 / 触屏按钮 / 棋盘手势 → InputRouter → 执行器
// - 键位每次事件从 store 读取（改键立即生效，无需重绑监听）
// - 触屏按钮由 TouchControls 直接调用 router（本 hook 只负责键盘与手势）
// - 失焦 / 切后台 / 卸载 一律全释放，避免回前台后"键卡住自己下滑"

import { useEffect, useRef, type RefObject } from 'react';
import type { GameAction } from '@bearbricks/shared';
import type { InputRouter } from './router';
import { buildKeyIndex, normalizeKey, type InputAction, type Keymap } from './keymap';
import { GestureRecognizer, type GestureOptions } from './gestures';
import { useSettings } from '../store/settings';

export interface GameInputOptions {
  router: InputRouter;
  /** 当前是否接受对局输入（终局 / 暂停 / 复活冻结 / 结算遮罩 → false） */
  canInput: () => boolean;
  /** 手势横向步长所需的格子像素宽（随视口实时变化） */
  getCellPx: () => number;
  /** Esc（单人：切换暂停） */
  onPause?: () => void;
  /** Esc（联机：打开设置面板，游戏不暂停） */
  onEscape?: () => void;
  /** 手势表面（棋盘容器）；不传则不启用触屏手势 */
  surfaceRef?: RefObject<HTMLElement | null>;
}

function isTypingTarget(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  return (
    el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    el.tagName === 'SELECT' ||
    el.isContentEditable
  );
}

/** 组合键（Ctrl/Cmd/Alt + 其它键）不当作游戏键，避免 Ctrl+C 触发 Hold；修饰键本身照常生效 */
function isModifierCombo(e: KeyboardEvent): boolean {
  if (!e.ctrlKey && !e.metaKey && !e.altKey) return false;
  return e.key !== 'Control' && e.key !== 'Shift' && e.key !== 'Alt';
}

export function useGameInput(options: GameInputOptions): void {
  const { router, surfaceRef } = options;
  const optsRef = useRef(options);
  optsRef.current = options;

  // ===== 键盘 =====
  useEffect(() => {
    // 键位索引按 keymap 引用缓存（改键 → store 产生新对象 → 重建索引）
    let cachedMap: Keymap | null = null;
    let cachedIndex: Map<string, InputAction> = new Map();
    const index = (): Map<string, InputAction> => {
      const map = useSettings.getState().keymap;
      if (map !== cachedMap) {
        cachedMap = map;
        cachedIndex = buildKeyIndex(map);
      }
      return cachedIndex;
    };

    const down = (e: KeyboardEvent): void => {
      if (isTypingTarget()) return;
      if (isModifierCombo(e)) return;
      const action = index().get(normalizeKey(e.key));
      if (!action) return;
      if (action === 'pause') {
        if (e.repeat) return;
        e.preventDefault();
        const o = optsRef.current;
        if (o.onPause) o.onPause();
        else o.onEscape?.();
        return;
      }
      if (!optsRef.current.canInput()) return;
      e.preventDefault();
      if (e.repeat) return;
      switch (action) {
        case 'moveL':
          router.pressDirection('L', 'keyboard');
          break;
        case 'moveR':
          router.pressDirection('R', 'keyboard');
          break;
        case 'soft':
          router.setSoft(true, 'keyboard');
          break;
        default:
          router.apply(action);
      }
    };

    const up = (e: KeyboardEvent): void => {
      const action = index().get(normalizeKey(e.key));
      if (!action) return;
      if (action === 'moveL') router.releaseDirection('L', 'keyboard');
      else if (action === 'moveR') router.releaseDirection('R', 'keyboard');
      else if (action === 'soft') router.setSoft(false, 'keyboard');
    };

    const release = (): void => router.releaseAll();
    const onVisibility = (): void => {
      if (document.hidden) release();
    };

    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', release);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', release);
      document.removeEventListener('visibilitychange', onVisibility);
      release();
    };
  }, [router]);

  // ===== 棋盘手势（Pointer Events，默认关闭，可在设置中开启） =====
  useEffect(() => {
    const el = surfaceRef?.current;
    if (!el) return;
    const rec = new GestureRecognizer();
    const gestureOpts = (): GestureOptions => {
      const s = useSettings.getState();
      return {
        stepPx: Math.max(12, optsRef.current.getCellPx()),
        tapAction: s.gestureTap,
        downAction: s.gestureDown,
      };
    };
    const emit = (actions: GameAction[]): void => {
      for (const a of actions) {
        if (!optsRef.current.canInput()) return;
        router.apply(a);
      }
    };
    const onDown = (e: PointerEvent): void => {
      const s = useSettings.getState();
      if (!s.gestures || !optsRef.current.canInput()) return;
      if (e.pointerType === 'mouse') return; // 桌面鼠标不触发手势（避免拖拽误操作）
      if (!rec.begin(e.pointerId, e.clientX, e.clientY)) return;
      e.preventDefault();
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        // pointercancel 后调用可能抛异常；忽略
      }
    };
    const onMove = (e: PointerEvent): void => {
      if (!rec.active) return;
      emit(rec.move(e.pointerId, e.clientX, e.clientY, gestureOpts()));
    };
    const onUp = (e: PointerEvent): void => {
      if (!rec.active) return;
      emit(rec.end(e.pointerId, e.clientX, e.clientY, gestureOpts()));
    };
    const onCancel = (e: PointerEvent): void => {
      rec.cancel(e.pointerId);
    };

    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onCancel);
    el.addEventListener('lostpointercapture', onCancel);
    return () => {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onCancel);
      el.removeEventListener('lostpointercapture', onCancel);
      rec.cancel();
      router.releaseSource('gesture');
    };
  }, [router, surfaceRef]);
}
