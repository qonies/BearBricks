// T-Spin 判定（3 角规则 + Mini 区分）与计分（requirements.md §4.2）

import { BOARD_WIDTH, TOTAL_HEIGHT } from '../rules/constants';
import type { Rotation } from './srs';
import type { Board } from './board';

export type TSpinKind = 'none' | 'mini' | 'normal';

const T_CORNERS: readonly (readonly [number, number])[] = [
  [0, 0],
  [2, 0],
  [0, 2],
  [2, 2],
];
// 「正面」两角：T 指向方向一侧的盒角。rot0 上、rot1 右、rot2 下、rot3 左
const T_FRONT: readonly [readonly [number, number], readonly [number, number]][] = [
  [
    [0, 0],
    [2, 0],
  ],
  [
    [2, 0],
    [2, 2],
  ],
  [
    [0, 2],
    [2, 2],
  ],
  [
    [0, 0],
    [0, 2],
  ],
];

function occupied(board: Board, x: number, y: number): boolean {
  // Guideline：场外（含场地上方）一律视为已占据
  if (x < 0 || x >= BOARD_WIDTH || y < 0 || y >= TOTAL_HEIGHT) return true;
  return board[y * BOARD_WIDTH + x] !== null;
}

/** ox/oy 为 T 块 3×3 盒左上角绝对坐标；lastActionWasRotation 为「最后成功动作是否为旋转」 */
export function detectTSpin(
  board: Board,
  ox: number,
  oy: number,
  rot: Rotation,
  lastActionWasRotation: boolean,
): TSpinKind {
  if (!lastActionWasRotation) return 'none';
  let count = 0;
  for (const [cx, cy] of T_CORNERS) {
    if (occupied(board, ox + cx, oy + cy)) count++;
  }
  if (count < 3) return 'none';
  const [fa, fb] = T_FRONT[rot];
  const frontFilled =
    occupied(board, ox + fa[0], oy + fa[1]) && occupied(board, ox + fb[0], oy + fb[1]);
  return frontFilled ? 'normal' : 'mini';
}

export interface ScoreInput {
  lines: number;
  tspin: TSpinKind;
  perfectClear: boolean;
  /** 上一 difficult 消行已建立 B2B */
  b2bEligible: boolean;
  /** 本次为连续消行的第 n 连（本块未消行则为 0） */
  combo: number;
  level: number;
}

export interface ScoreOutput {
  points: number;
  /** 是否 difficult（Tetris / T-Spin 消行），驱动 B2B 链 */
  difficult: boolean;
  b2bUsed: boolean;
}

export function scoreClear(inp: ScoreInput): ScoreOutput {
  const { lines, tspin, level } = inp;
  let base: number;
  if (lines === 0) {
    base = tspin === 'normal' ? 400 : tspin === 'mini' ? 100 : 0;
  } else if (tspin === 'normal') {
    base = [0, 800, 1200, 1600][lines] ?? 0;
  } else if (tspin === 'mini') {
    // T-Spin Mini Double 在 SRS 几何上不可达（mini 踢法无法构成双消），Guideline 亦不设分值 → 0
    base = lines === 1 ? 200 : 0;
  } else {
    base = [0, 100, 300, 500, 800][lines] ?? 0;
  }
  let points = base * level;
  const difficult = lines === 4 || (tspin !== 'none' && lines > 0);
  let b2bUsed = false;
  if (difficult && inp.b2bEligible) {
    points = Math.floor(points * 1.5);
    b2bUsed = true;
  }
  // Combo：连续消行第 n 连（n≥2）额外 50×(n-1)×等级
  if (lines > 0 && inp.combo >= 2) points += 50 * (inp.combo - 1) * level;
  if (inp.perfectClear) points += 3500;
  return { points, difficult, b2bUsed };
}
