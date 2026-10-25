// 棋盘：行主序一维数组，top-down 索引 0~21（row 0 = 顶部隐藏行，row 21 = 底行）
// 格子值：方块色 L/J/I/O/S/T/Z、垃圾行 'G'、null 为空

import { BOARD_WIDTH, TOTAL_HEIGHT } from '../rules/constants';
import type { Cells, PieceType } from './srs';

export type Cell = PieceType | 'G' | null;
export type Board = Cell[];

export function createBoard(): Board {
  return new Array<Cell>(BOARD_WIDTH * TOTAL_HEIGHT).fill(null);
}

export function cellAt(board: Board, row: number, col: number): Cell {
  return board[row * BOARD_WIDTH + col];
}

export function collides(board: Board, cells: Cells, ox: number, oy: number): boolean {
  for (const [cx, cy] of cells) {
    const x = ox + cx;
    const y = oy + cy;
    if (x < 0 || x >= BOARD_WIDTH || y >= TOTAL_HEIGHT) return true;
    if (y < 0) continue; // 顶部越界允许（踢墙旋转可能踢出场地上界）
    if (board[y * BOARD_WIDTH + x] !== null) return true;
  }
  return false;
}

export function mergePiece(board: Board, type: PieceType, cells: Cells, ox: number, oy: number): void {
  for (const [cx, cy] of cells) {
    const y = oy + cy;
    if (y >= 0 && y < TOTAL_HEIGHT) board[y * BOARD_WIDTH + (ox + cx)] = type;
  }
}

function isFullRow(board: Board, row: number): boolean {
  for (let c = 0; c < BOARD_WIDTH; c++) {
    if (board[row * BOARD_WIDTH + c] === null) return false;
  }
  return true;
}

/**
 * 满行行号（top-down 索引升序）。消行只改变行的位置、不改变格子内容，
 * 因此本函数返回的集合与 clearLines 实际清除的行集合等价（供消行动画取"消行前坐标"）。
 */
export function findFullRows(board: Board): number[] {
  const rows: number[] = [];
  for (let r = 0; r < TOTAL_HEIGHT; r++) if (isFullRow(board, r)) rows.push(r);
  return rows;
}

/** 消行并整体下移，返回消除行数 */
export function clearLines(board: Board): number {
  let cleared = 0;
  for (let r = TOTAL_HEIGHT - 1; r >= 0; r--) {
    if (isFullRow(board, r)) {
      board.splice(r * BOARD_WIDTH, BOARD_WIDTH);
      const newRow: Cell[] = new Array<Cell>(BOARD_WIDTH).fill(null);
      board.unshift(...newRow);
      cleared++;
      r++; // 上方行已下移，重新检查同一行号
    }
  }
  return cleared;
}

/** 当前方块到落点的垂直距离（Ghost 用） */
export function dropDistance(board: Board, cells: Cells, ox: number, oy: number): number {
  let d = 0;
  while (!collides(board, cells, ox, oy + d + 1)) d++;
  return d;
}

export function isBoardEmpty(board: Board): boolean {
  return board.every((c) => c === null);
}

/** 协议快照编码（protocol.md §5）：每行 10 字符，'.' 为空，'G' 为垃圾行 */
export function boardToString(board: Board): string {
  return board.map((c) => c ?? '.').join('');
}

/**
 * 在棋盘底部插入垃圾行：每行恰有一个洞，同批次洞在同一列（TC-ENG-010）。
 * 单批上限 8 行的切分由调用方（Room 层）负责；本函数只移动棋盘格，
 * active piece 的随动上移与顶出校验由 TetrisGame.receiveGarbage 统一处理。
 * 返回 true 表示顶行存在方块被顶出棋盘（棋盘溢出信号）。
 */
export function insertGarbage(board: Board, rows: number, holeCol: number): boolean {
  let discarded = false;
  for (let i = 0; i < rows; i++) {
    for (let c = 0; c < BOARD_WIDTH; c++) {
      if (board[c] !== null) {
        discarded = true;
        break;
      }
    }
    board.splice(0, BOARD_WIDTH); // 移除顶部一行
    for (let c = 0; c < BOARD_WIDTH; c++) board.push(c === holeCol ? null : 'G');
  }
  return discarded;
}

/** 协议快照解码（protocol.md §5）：220 字符 → Board，'.' 为空 */
export function boardFromString(s: string): Board {
  if (s.length !== BOARD_WIDTH * TOTAL_HEIGHT) {
    throw new Error(`board string length ${s.length} != ${BOARD_WIDTH * TOTAL_HEIGHT}`);
  }
  const board: Board = new Array<Cell>(BOARD_WIDTH * TOTAL_HEIGHT).fill(null);
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '.') continue;
    if (!'IJLOSTZG'.includes(ch)) throw new Error(`invalid cell char: ${ch}`);
    board[i] = ch as Cell;
  }
  return board;
}
