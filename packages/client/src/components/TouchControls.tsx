// 屏上触控键（FR-12.3 / 技术设计 §5.6）：iPad 主输入方式
// - 只发 press / release，自动重复完全复用 AutoShiftScheduler（DAS/ARR 与键盘一致）
// - 多指同时按住由 InputRouter 合并（不会互相取消）
// - 命中区 ≥56px（Apple HIG 建议 ≥44pt），尊重安全区，禁用长按菜单/文本选择/双击缩放

import { useEffect, useRef, useState } from 'react';
import { computeTouchButtonSize } from '../input/touchLayout';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { InputRouter } from '../input/router';
import { useSettings } from '../store/settings';

interface TouchControlsProps {
  router: InputRouter;
  disabled?: boolean;
}

type ButtonVariant = 'move' | 'soft' | 'action' | 'hold';


function TouchButton(props: {
  label: string;
  ariaLabel: string;
  size: number;
  opacity: number;
  variant: ButtonVariant;
  disabled?: boolean;
  onPress: () => void;
  onRelease?: () => void;
}) {
  const { label, ariaLabel, size, opacity, variant, disabled, onPress, onRelease } = props;
  const [pressed, setPressed] = useState(false);

  const down = (e: ReactPointerEvent<HTMLButtonElement>): void => {
    if (disabled) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // 某些 WebKit 版本在指针已释放时会抛；忽略
    }
    setPressed(true);
    onPress();
  };
  const up = (): void => {
    if (!pressed) return;
    setPressed(false);
    onRelease?.();
  };

  const variantClass =
    variant === 'hold'
      ? 'bg-amber-700/80 border-amber-500/70'
      : variant === 'soft'
        ? 'bg-sky-800/80 border-sky-600/70'
        : variant === 'move'
          ? 'bg-slate-700/85 border-slate-500/70'
          : 'bg-slate-700/85 border-slate-500/70';

  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label={ariaLabel}
      disabled={disabled}
      onPointerDown={down}
      onPointerUp={up}
      onPointerCancel={up}
      onLostPointerCapture={up}
      onContextMenu={(e) => e.preventDefault()}
      style={{ width: size, height: size, opacity: disabled ? 0.35 : opacity }}
      className={`touch-btn flex flex-col items-center justify-center rounded-2xl border text-center font-semibold leading-none shadow-lg transition-transform duration-75 select-none ${variantClass} ${
        pressed ? 'scale-95 ring-2 ring-emerald-400 brightness-125' : ''
      } disabled:opacity-40`}
    >
      <span style={{ fontSize: Math.round(size * 0.32) }}>{label}</span>
    </button>
  );
}

export function TouchControls({ router, disabled }: TouchControlsProps) {
  const layout = useSettings((s) => s.touchLayout);
  const scale = useSettings((s) => s.touchScale);
  const opacity = useSettings((s) => s.touchOpacity);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  // 初始用窗口宽度估算，挂载后由 ResizeObserver 精确校正（分屏/旋转/Stage Manager）
  const [width, setWidth] = useState(() =>
    typeof window === 'undefined' ? 375 : window.innerWidth,
  );
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = (): void => setWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const size = computeTouchButtonSize(width, scale);

  const move = (
    <div className="pointer-events-auto grid grid-cols-3 items-end gap-2">
      <TouchButton
        label="←"
        ariaLabel="左移"
        size={size}
        opacity={opacity}
        variant="move"
        disabled={disabled}
        onPress={() => router.pressDirection('L', 'touch')}
        onRelease={() => router.releaseDirection('L', 'touch')}
      />
      <TouchButton
        label="→"
        ariaLabel="右移"
        size={size}
        opacity={opacity}
        variant="move"
        disabled={disabled}
        onPress={() => router.pressDirection('R', 'touch')}
        onRelease={() => router.releaseDirection('R', 'touch')}
      />
      <TouchButton
        label="▼"
        ariaLabel="软降"
        size={size}
        opacity={opacity}
        variant="soft"
        disabled={disabled}
        onPress={() => router.setSoft(true, 'touch')}
        onRelease={() => router.setSoft(false, 'touch')}
      />
    </div>
  );

  const actions = (
    <div className="pointer-events-auto grid grid-cols-2 items-end gap-2">
      <TouchButton
        label="⟲"
        ariaLabel="逆时针旋转"
        size={size}
        opacity={opacity}
        variant="action"
        disabled={disabled}
        onPress={() => router.apply('rotCCW')}
      />
      <TouchButton
        label="⟳"
        ariaLabel="顺时针旋转"
        size={size}
        opacity={opacity}
        variant="action"
        disabled={disabled}
        onPress={() => router.apply('rotCW')}
      />
      <TouchButton
        label="HOLD"
        ariaLabel="Hold 暂存"
        size={size}
        opacity={opacity}
        variant="hold"
        disabled={disabled}
        onPress={() => router.apply('hold')}
      />
      <TouchButton
        label="⤓"
        ariaLabel="硬降"
        size={size}
        opacity={opacity}
        variant="action"
        disabled={disabled}
        onPress={() => router.apply('hard')}
      />
    </div>
  );

  return (
    <div
      ref={wrapRef}
      className={`pointer-events-none flex w-full flex-wrap items-end justify-between gap-4 px-3 ${
        layout === 'right' ? 'flex-row-reverse' : ''
      }`}
      style={{ paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom))' }}
    >
      {move}
      {actions}
    </div>
  );
}
