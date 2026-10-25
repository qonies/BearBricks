// 消行三闪动画：引擎 clearVisual → ClearFxTracker 的帧序列（纯逻辑、显式时间戳、无定时器）

import { describe, expect, it } from 'vitest';
import { BOARD_WIDTH, TOTAL_HEIGHT, TetrisGame } from '@bearbricks/shared';
import { CLEAR_FLASH_MS, CLEAR_FX_MS, ClearFxTracker } from '../src/game/clearFx';

/** 底部两行只差第 8/9 列 → O 块（x=7 覆盖 8/9 列）补满 → Double，消行后棋盘完全为空 */
function makeDouble(g: TetrisGame): void {
  for (let r = TOTAL_HEIGHT - 2; r < TOTAL_HEIGHT; r++)
    for (let c = 0; c < BOARD_WIDTH - 2; c++) g.board[r * BOARD_WIDTH + c] = 'G';
  g.active = { type: 'O', x: 7, y: 3, rot: 0 };
  g.applyInput('hard');
}

const newGame = (seed = 'clear-fx'): TetrisGame => new TetrisGame({ mode: 'marathon', seed });

describe('ClearFxTracker（消行三闪动画）', () => {
  it('未消行时无动画帧；消行后绘制消行前棋盘 + 待消失行', () => {
    const g = newGame();
    const fx = new ClearFxTracker(g);
    expect(g.applyInput('moveR')).toBe(true); // 仅移动，不消行
    fx.update(g, 0);
    expect(fx.frame(0)).toBeNull();

    makeDouble(g);
    fx.update(g, 1000);
    const f = fx.frame(1000);
    expect(f).not.toBeNull();
    expect(f!.rows).toEqual([TOTAL_HEIGHT - 2, TOTAL_HEIGHT - 1]);
    expect(f!.board).toEqual(g.clearVisual!.board); // 消行前快照：待消失行仍在原位
    expect(g.board.every((c) => c === null)).toBe(true); // 实时棋盘已塌下
    expect(f!.flashOn).toBe(true); // 起始相位为亮
  });

  it('3 次闪烁：亮-暗交替、单相位 40ms、240ms 后结束', () => {
    const g = newGame('clear-fx-phases');
    const fx = new ClearFxTracker(g);
    makeDouble(g);
    fx.update(g, 0);
    const phases: boolean[] = [];
    for (let t = 0; t < CLEAR_FX_MS; t += CLEAR_FLASH_MS) phases.push(fx.frame(t)!.flashOn);
    expect(phases).toEqual([true, false, true, false, true, false]);
    expect(phases.filter(Boolean)).toHaveLength(3); // 亮 3 次
    expect(fx.frame(CLEAR_FX_MS - 1)).not.toBeNull();
    expect(fx.frame(CLEAR_FX_MS)).toBeNull(); // 动画结束 → 切回实时棋盘
    expect(fx.frame(CLEAR_FX_MS + 100)).toBeNull();
  });

  it('同一次消行只播一次：重复 update（同 clearVisual.id）不重启动画', () => {
    const g = newGame('clear-fx-once');
    const fx = new ClearFxTracker(g);
    makeDouble(g);
    fx.update(g, 0);
    fx.update(g, 50); // 同一事件
    expect(fx.frame(50)!.flashOn).toBe(false); // 相位 1（暗）：未被重置回相位 0（亮）
  });

  it('构造函数用当前 clearVisual.id 播种：构造前发生的消行不补播', () => {
    const g = newGame('clear-fx-seed');
    makeDouble(g);
    const fx = new ClearFxTracker(g);
    fx.update(g, 0);
    expect(fx.frame(0)).toBeNull();
  });

  it('动画使用快照副本：播放期间引擎棋盘变化不影响闪烁内容', () => {
    const g = newGame('clear-fx-snapshot');
    const fx = new ClearFxTracker(g);
    makeDouble(g);
    fx.update(g, 0);
    const before = fx.frame(0)!.board;
    g.board[21 * BOARD_WIDTH] = 'T'; // 播放期间棋盘被改动（垃圾行/新块）
    expect(fx.frame(10)!.board).toEqual(before);
  });

  it('reset 清空动画并以新引擎重新播种', () => {
    const g = newGame('clear-fx-reset');
    const fx = new ClearFxTracker(g);
    makeDouble(g);
    fx.update(g, 0);
    expect(fx.frame(0)).not.toBeNull();
    fx.reset(g); // 换局/重开
    expect(fx.frame(0)).toBeNull();
  });
});
