// 快照构建（protocol.md §5 / technical-design §3.1 snapshotter）
// 行编码：220 字符无分隔符，'.' 为空，'G' 为垃圾行；坐标 top-down（index 0 = 顶部）

import { BOARD_WIDTH, TOTAL_HEIGHT } from '../rules/constants';
import { boardToString } from '../engine/board';
import type { TetrisGame } from '../engine/game';
import type { ActivePieceData, OtherSeatSnapshot, SelfSnapshot } from './messages';

export { boardFromString, boardToString } from '../engine/board';

export const BOARD_STRING_LENGTH = BOARD_WIDTH * TOTAL_HEIGHT; // 220

export type SeatPlayStatus = 'playing' | 'finished' | 'eliminated' | 'abandoned';

/** 模式状态（protocol §5）：sprint 目标行数；survival 存活数 + 待接收垃圾行 */
export type SelfModeState = SelfSnapshot['modeState'];

/** 己方权威快照（含重建乐观预测所需全部字段；变化才发由调用方按 h 判断） */
export function buildSelfSnapshot(
  g: TetrisGame,
  tick: number,
  lastSeq: number,
  modeState: SelfModeState,
  status?: SeatPlayStatus,
): SelfSnapshot {
  return {
    tick,
    seq: lastSeq,
    h: g.stateHash(),
    board: boardToString(g.board),
    active: g.active ? ({ type: g.active.type, x: g.active.x, y: g.active.y, rot: g.active.rot } as ActivePieceData) : null,
    queue: g.queue.slice(0, 8),
    hold: g.hold,
    canHold: g.canHold,
    score: g.score,
    lines: g.lines,
    level: g.level,
    combo: g.combo,
    b2b: g.b2bActive,
    elapsedMs: g.elapsedMs,
    ...(status != null ? { status } : {}),
    modeState,
  };
}

/** 对手快照（省略 queue/hold，防窥探 + 减体积）；survival 附带待接收垃圾行数（预警可视化） */
export function buildOtherSeatSnapshot(
  g: TetrisGame,
  seatId: number,
  status: SeatPlayStatus,
  pendingGarbage?: number,
): OtherSeatSnapshot {
  return {
    seatId,
    board: boardToString(g.board),
    active: g.active ? ({ type: g.active.type, x: g.active.x, y: g.active.y, rot: g.active.rot } as ActivePieceData) : null,
    score: g.score,
    lines: g.lines,
    status,
    ...(pendingGarbage != null ? { pendingGarbage } : {}),
  };
}

/** 对手座位的快照指纹（服务端变化检测） */
export function otherSeatHash(s: OtherSeatSnapshot): string {
  return `${s.board}|${s.active ? `${s.active.type},${s.active.x},${s.active.y},${s.active.rot}` : '-'}|${s.score}|${s.lines}|${s.status}|${s.pendingGarbage ?? 0}`;
}