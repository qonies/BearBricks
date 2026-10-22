// 设置（FR-12.1：DAS/ARR/Ghost，持久化 localStorage；音效/改键/色盲为 M6）

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface SettingsState {
  das: number;
  arr: number;
  ghost: boolean;
  update: (patch: Partial<Omit<SettingsState, 'update'>>) => void;
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      das: 133,
      arr: 33,
      ghost: true,
      update: (patch) => set(patch),
    }),
    { name: 'bearbricks.settings' },
  ),
);
