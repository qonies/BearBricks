// TC-ENG-004：碰撞（墙/地板/堆叠/Block Out）；TC-ENG-006：消行；TC-ENG-010：垃圾行原语

import { describe, expect, it } from 'vitest';
import {
  BOARD_WIDTH,
  TOTAL_HEIGHT,
  PIECE_CELLS,
  boardFromString,
  boardToString,
  createBoard,
  cellAt,
  clearLines,
  collides,
  insertGarbage,
} from '../src';

describe('碰撞（TC-ENG-004）', () => {
  it('左墙/右墙/地板越界判定', () => {
    const b = createBoard();
    // T rot0 最小 x=0：ox=-1 越左墙
    expect(collides(b, PIECE_CELLS.T[0], -1, 5)).toBe(true);
    // T rot0 最大 x=2：ox=8 → x=10 越右墙
    expect(collides(b, PIECE_CELLS.T[0], 8, 5)).toBe(true);
    expect(collides(b, PIECE_CELLS.T[0], 7, 5)).toBe(false);
    // O 最大 y=1：oy=21 → y=22 越地板
    expect(collides(b, PIECE_CELLS.O[0], 4, 21)).toBe(true);
    expect(collides(b, PIECE_CELLS.O[0], 4, 20)).toBe(false);
  });

  it('堆叠判定', () => {
    const b = createBoard();
    b[21 * BOARD_WIDTH + 5] = 'I';
    // O 在 (4,20)：占据 (5,20),(6,20),(5,21),(6,21) → (5,21) 被占
    expect(collides(b, PIECE_CELLS.O[0], 4, 20)).toBe(true);
    expect(collides(b, PIECE_CELLS.O[0], 6, 20)).toBe(false);
  });

  it('顶部越界允许（踢墙旋转踢出上界不视为碰撞）', () => {
    const b = createBoard();
    expect(collides(b, PIECE_CELLS.T[0], 3, -1)).toBe(false);
  });
});

describe('消行（TC-ENG-006）', () => {
  it('单行消除且上方行下移', () => {
    const b = createBoard();
    for (let c = 0; c < BOARD_WIDTH; c++) b[21 * BOARD_WIDTH + c] = 'I';
    b[19 * BOARD_WIDTH + 0] = 'T';
    expect(clearLines(b)).toBe(1);
    expect(cellAt(b, 20, 0)).toBe('T');
    expect(cellAt(b, 19, 0)).toBeNull();
  });

  it('四行同时消除（Tetris）', () => {
    const b = createBoard();
    for (let r = 18; r < TOTAL_HEIGHT; r++)
      for (let c = 0; c < BOARD_WIDTH; c++) b[r * BOARD_WIDTH + c] = 'I';
    b[17 * BOARD_WIDTH + 3] = 'T';
    expect(clearLines(b)).toBe(4);
    expect(cellAt(b, 21, 3)).toBe('T');
    expect(b.every((c) => c === null || c === 'T')).toBe(true);
  });
});

describe('垃圾行原语（TC-ENG-010 引擎侧）', () => {
  it('同批次洞在同一列，底部插入且棋盘整体上移', () => {
    const b = createBoard();
    b[0] = 'I'; // row0 col0
    b[5 * BOARD_WIDTH + 5] = 'T'; // row5 col5
    const holeCol = 6;
    insertGarbage(b, 4, holeCol);
    expect(b).toHaveLength(BOARD_WIDTH * TOTAL_HEIGHT);
    for (let r = 18; r < TOTAL_HEIGHT; r++) {
      for (let c = 0; c < BOARD_WIDTH; c++) {
        if (c === holeCol) expect(cellAt(b, r, c)).toBeNull();
        else expect(cellAt(b, r, c)).toBe('G');
      }
    }
    // 顶部原有内容整体上移 4 行：row5 的 T → row1
    expect(cellAt(b, 1, 5)).toBe('T');
    expect(cellAt(b, 0, 0)).toBeNull(); // row0 的 I 已被移出
  });

  it('insertGarbage 返回顶行是否被顶出（堆到顶 → true）', () => {
    const b = createBoard();
    expect(insertGarbage(b, 2, 5)).toBe(false);
    const b2 = createBoard();
    b2[0] = 'I'; // 顶行有方块，将被移出
    expect(insertGarbage(b2, 1, 5)).toBe(true);
  });
});

describe('棋盘字符串编解码（protocol.md §5）', () => {
  it('boardToString / boardFromString 往返一致；非法输入报错', () => {
    const b = createBoard();
    b[21 * BOARD_WIDTH + 0] = 'I';
    b[2 * BOARD_WIDTH + 9] = 'G';
    const s = boardToString(b);
    expect(s).toHaveLength(BOARD_WIDTH * TOTAL_HEIGHT); // 220 字符无分隔符
    expect(boardFromString(s)).toEqual(b);
    expect(() => boardFromString('short')).toThrow();
    expect(() => boardFromString('X'.repeat(BOARD_WIDTH * TOTAL_HEIGHT))).toThrow();
  });
});
