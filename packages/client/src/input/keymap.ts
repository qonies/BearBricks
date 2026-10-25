// 键位映射（FR-5.2 改键 + 持久化，技术设计 §5.6）
// 键名规范化：单字符统一小写（'X' → 'x'），其它保持 KeyboardEvent.key 原样
// （'ArrowLeft' / 'Control' / 'Shift' / ' ' / 'Escape'）。

import type { GameAction } from '@bearbricks/shared';

export type InputAction = GameAction | 'pause';

/** 设置屏展示顺序 */
export const INPUT_ACTIONS: readonly InputAction[] = [
  'moveL',
  'moveR',
  'rotCCW',
  'rotCW',
  'soft',
  'hard',
  'hold',
  'pause',
] as const;

export const ACTION_LABELS: Record<InputAction, string> = {
  moveL: '左移',
  moveR: '右移',
  rotCCW: '逆时针旋转',
  rotCW: '顺时针旋转',
  soft: '软降',
  hard: '硬降',
  hold: 'Hold',
  pause: '暂停 / 设置',
};

export type Keymap = Record<InputAction, string[]>;

/** 默认键位（requirements FR-5.2） */
export const DEFAULT_KEYMAP: Keymap = {
  moveL: ['ArrowLeft'],
  moveR: ['ArrowRight'],
  rotCCW: ['z', 'Control'],
  rotCW: ['ArrowUp', 'x'],
  soft: ['ArrowDown'],
  hard: [' '],
  hold: ['Shift', 'c'],
  pause: ['Escape'],
};

export function cloneKeymap(map: Keymap = DEFAULT_KEYMAP): Keymap {
  const out = {} as Keymap;
  for (const action of INPUT_ACTIONS) out[action] = [...(map[action] ?? [])];
  return out;
}

export function normalizeKey(key: string): string {
  return key.length === 1 ? key.toLowerCase() : key;
}

/** rawKey → action 的查表（一次构建，多次 keydown 复用；构建代价极低） */
export function buildKeyIndex(map: Keymap): Map<string, InputAction> {
  const index = new Map<string, InputAction>();
  for (const action of INPUT_ACTIONS) {
    for (const key of map[action] ?? []) {
      const nk = normalizeKey(key);
      if (!index.has(nk)) index.set(nk, action);
    }
  }
  return index;
}

/** 某键当前被哪个动作占用（设置屏冲突提示用） */
export function findKeyOwner(map: Keymap, key: string): InputAction | null {
  const nk = normalizeKey(key);
  for (const action of INPUT_ACTIONS) {
    if ((map[action] ?? []).some((k) => normalizeKey(k) === nk)) return action;
  }
  return null;
}

/**
 * 为动作绑定单个键（改键语义）：
 * - 先从所有动作中移除该键（避免一键多动作）；
 * - 再写入目标动作。
 * 返回新对象（zustand 不可变更新）。
 */
export function assignKey(map: Keymap, action: InputAction, key: string): Keymap {
  const nk = normalizeKey(key);
  const next = cloneKeymap(map);
  for (const a of INPUT_ACTIONS) {
    next[a] = (next[a] ?? []).filter((k) => normalizeKey(k) !== nk);
  }
  next[action] = [...next[action], nk];
  return next;
}

/** 展示用键名（空格 / 修饰键友好化） */
export function keyLabel(key: string): string {
  const nk = normalizeKey(key);
  const special: Record<string, string> = {
    ' ': 'Space',
    ArrowLeft: '←',
    ArrowRight: '→',
    ArrowUp: '↑',
    ArrowDown: '↓',
    Escape: 'Esc',
    Control: 'Ctrl',
    Shift: 'Shift',
    Enter: 'Enter',
    Tab: 'Tab',
  };
  return special[nk] ?? (nk.length === 1 ? nk.toUpperCase() : nk);
}

export function keymapLabel(map: Keymap, action: InputAction): string {
  return (map[action] ?? []).map(keyLabel).join(' / ') || '未绑定';
}
