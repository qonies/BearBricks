// 输入命令抽象（技术设计 §5.3 / §5.6 iPad 触屏适配）
// 键盘、虚拟按键、手势三种输入源都只通过这套命令驱动执行器：
//   单人 EngineRunner / 联机 NetGameRunner 共用同一条动作通道，
//   触屏不产生新的协议消息（仍走 game.input 的离散 GameAction 与 game.soft 持续态）。

import type { GameAction } from '@bearbricks/shared';
import type { Dir } from '../game/autoshift';

export type { Dir };

export interface GameCommands {
  /** 离散动作（移动/旋转/硬降/Hold）：本地立即应用；联机同时带 seq 上行 */
  apply(action: GameAction): unknown;
  /** 方向键按下（DAS 起点 + 立即移动一次） */
  pressDirection(dir: Dir): void;
  /** 方向键释放 */
  releaseDirection(dir: Dir): void;
  /** 软降持续态（联机会上行 game.soft） */
  setSoft(on: boolean): void;
}
