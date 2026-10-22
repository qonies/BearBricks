// GameModeStrategy（ADR-0005）：三模式差异集中在「消行后做什么 / 顶出后做什么」两个钩子；
// Room 持有一个策略实例，不写模式分支散落逻辑；新增模式 = 新增策略类 + 注册（timed 为 M4）
// offset（1:1 抵消 pending 垃圾）与目标选择（其他存活对手）在 Room 层执行，策略层只算攻击值

import type { GameMode } from '../engine/game';
import { calcAttack, type AttackInput } from '../rules/attackTable';

export type TopOutAction = 'ELIMINATE' | 'RESPAWN' | 'RESET_BOARD';

/** 攻击计划：lines 已含 B2B/Combo/PC 加成；offset 与目标转发由 Room 层负责 */
export interface AttackPlan {
  lines: number;
}

export interface GameModeStrategy {
  readonly id: 'sprint' | 'survival' | 'timed';
  /** 消行 → 攻击计划；攻击关闭（sprint）返回 null */
  onLinesCleared(clear: AttackInput): AttackPlan | null;
  /** 顶出处置动作 */
  onTopOut(): TopOutAction;
  /** TetrisGame 引擎模式（sprint：引擎内 300s 超时 + 顶出清盘；其余用 marathon 语义，由策略/Room 层处置） */
  engineMode(): GameMode;
}

export class SprintStrategy implements GameModeStrategy {
  readonly id = 'sprint' as const;
  onLinesCleared(_clear: AttackInput): AttackPlan | null {
    return null; // sprint 攻击关闭（TC-MD-A-002）
  }
  onTopOut(): TopOutAction {
    return 'RESET_BOARD';
  }
  engineMode(): GameMode {
    return 'sprint';
  }
}

export class SurvivalStrategy implements GameModeStrategy {
  readonly id = 'survival' as const;
  onLinesCleared(clear: AttackInput): AttackPlan {
    return { lines: calcAttack(clear) };
  }
  onTopOut(): TopOutAction {
    return 'ELIMINATE';
  }
  engineMode(): GameMode {
    return 'marathon';
  }
}

/** 工厂：timed 策略 M4 落地（Room.updateSettings 已拒绝 timed） */
export function createModeStrategy(id: 'sprint' | 'survival' | 'timed'): GameModeStrategy {
  if (id === 'survival') return new SurvivalStrategy();
  if (id === 'sprint') return new SprintStrategy();
  throw new Error('timed 模式将在 M4 实现');
}