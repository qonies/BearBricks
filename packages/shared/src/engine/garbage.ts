// 垃圾行批次生成：同批次洞在同一列（洞列随机源；offset/缓冲/插入在 Room 层 + TetrisGame.receiveGarbage）

import { BOARD_WIDTH } from '../rules/constants';
import type { Rng } from './rng';

export function pickHoleColumn(rng: Rng): number {
  return Math.floor(rng.next() * BOARD_WIDTH);
}
