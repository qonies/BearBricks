// 设置（FR-12.1 / FR-12.2）：手感 + 键位 + 触控 + 音效，统一持久化 localStorage
// 触控与键位为 iPad 适配新增（技术设计 §5.6）；旧版本存储缺少新字段时由 merge 补默认值。

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { cloneKeymap, DEFAULT_KEYMAP, type Keymap } from '../input/keymap';

/** 触控形态：auto = 按指针类型自动判断；touch / keyboard 用于强制覆盖（如 iPad 接妙控键盘） */
export type InputModeSetting = 'auto' | 'touch' | 'keyboard';
/** 触控按键左右手布局：left = 移动键簇在左侧（默认）；right = 镜像 */
export type TouchLayout = 'left' | 'right';

export interface GameSettingsValues {
  /** DAS（ms）：按住方向键后开始自动重复的延迟 */
  das: number;
  /** ARR（ms）：自动重复间隔，0 = 瞬间到墙 */
  arr: number;
  /** 显示 Ghost（落点预览） */
  ghost: boolean;
  /** 键位映射（改键，FR-5.2） */
  keymap: Keymap;
  inputMode: InputModeSetting;
  touchLayout: TouchLayout;
  /** 触控按键尺寸倍率（0.9 / 1 / 1.15） */
  touchScale: number;
  /** 触控按键不透明度（0.4 ~ 1） */
  touchOpacity: number;
  /** 棋盘手势开关（默认关，防止误触） */
  gestures: boolean;
  /** 轻点手势动作 */
  gestureTap: 'rotCW' | 'rotCCW';
  /** 下滑手势动作 */
  gestureDown: 'hard' | 'soft';
  /** 音效音量（0~1；音效本体尚未实现，先持久化） */
  soundVolume: number;
  /** 音乐音量（0~1；同上） */
  musicVolume: number;
}

export const DEFAULT_SETTINGS: GameSettingsValues = {
  das: 133,
  arr: 33,
  ghost: true,
  keymap: DEFAULT_KEYMAP,
  inputMode: 'auto',
  touchLayout: 'left',
  touchScale: 1,
  touchOpacity: 0.9,
  gestures: false,
  gestureTap: 'rotCW',
  gestureDown: 'hard',
  soundVolume: 0.7,
  musicVolume: 0.4,
};

interface SettingsState extends GameSettingsValues {
  update: (patch: Partial<GameSettingsValues>) => void;
  reset: () => void;
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      ...DEFAULT_SETTINGS,
      keymap: cloneKeymap(),
      update: (patch) =>
        set((s) => ({
          ...s,
          ...patch,
          ...(patch.keymap ? { keymap: cloneKeymap(patch.keymap) } : {}),
        })),
      reset: () => set({ ...DEFAULT_SETTINGS, keymap: cloneKeymap() }),
    }),
    {
      name: 'bearbricks.settings',
      version: 1,
      // 浅合并会把旧版本缺失的字段留空（如新增的 keymap 动作）→ 逐项补默认值
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<SettingsState>;
        return {
          ...current,
          ...p,
          keymap: { ...cloneKeymap(), ...(p.keymap ?? {}) },
        };
      },
    },
  ),
);
