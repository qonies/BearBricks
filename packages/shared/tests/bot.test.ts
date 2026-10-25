// M5 BotController 测试：落点评估 / Hold 权衡 / 难度差异（TC-BOT-001 批量回归口径）/
// 确定性 / timed 复活后继续对局（顶出循环验证）
import { describe, expect, it } from 'vitest';
import {
  BOARD_WIDTH,
  BOT_DIFFICULTY_PARAMS,
  BOT_MIN_HARD_DROP_ROWS,
  BotController,
  Rng,
  TetrisGame,
  TOTAL_HEIGHT,
  enumeratePlacements,
  evaluateBoard,
  simulateBotGame,
  type TetrisGame as Game,
} from '../src';

const STEP_MS = 1000 / 60;

/** 驱动 bot 直到谓词满足或步数上限（与服务端 tickStep 同构：decide → applyInput / update） */
function driveBot(
  g: Game,
  bot: BotController,
  until: (g: Game) => boolean,
  maxTicks = 3000,
): number {
  let ticks = 0;
  while (!until(g) && ticks < maxTicks) {
    const action = bot.decide(g);
    if (action) g.applyInput(action);
    else g.update(STEP_MS);
    ticks++;
  }
  return ticks;
}

/** 底行留 cols [from,to) 空洞，其余填满（行不完整避免立即消行） */
function fillBottomGap(g: Game, from: number, to: number): void {
  const row = (TOTAL_HEIGHT - 1) * BOARD_WIDTH;
  for (let c = 0; c < BOARD_WIDTH; c++) g.board[row + c] = c >= from && c < to ? null : 'I';
}

/** 从 topRow 起堆不完整垃圾堆（每行缺一格，逼顶出用） */
function fillStack(g: Game, topRow: number): void {
  for (let r = topRow; r < TOTAL_HEIGHT; r++)
    for (let c = 0; c < BOARD_WIDTH; c++)
      if (c !== r % BOARD_WIDTH) g.board[r * BOARD_WIDTH + c] = 'G';
}

describe('BotController 难度参数（技术设计 §6）', () => {
  it('三档难度 = 思考延迟 450/300/180ms，误操作率 0.3/0.18/0.06（M6 下调）', () => {
    expect(BOT_DIFFICULTY_PARAMS.EASY).toEqual({ thinkDelayMs: 450, mistakeRate: 0.3 });
    expect(BOT_DIFFICULTY_PARAMS.NORMAL).toEqual({ thinkDelayMs: 300, mistakeRate: 0.18 });
    expect(BOT_DIFFICULTY_PARAMS.HARD).toEqual({ thinkDelayMs: 180, mistakeRate: 0.06 });
    expect(BOT_MIN_HARD_DROP_ROWS).toBe(10); // 20 行可见区的一半
  });
});

describe('落点评估（enumeratePlacements / evaluateBoard）', () => {
  it('空盘返回全部合法候选且按代价升序', () => {
    const g = new TetrisGame({ mode: 'marathon', seed: 'bot-empty' });
    const out = enumeratePlacements(g.board, 'T', false);
    expect(out.length).toBeGreaterThan(0);
    for (let i = 1; i < out.length; i++) expect(out[i].cost).toBeGreaterThanOrEqual(out[i - 1].cost);
    for (const p of out) {
      expect(p.x).toBeGreaterThanOrEqual(-1);
      expect(p.x).toBeLessThanOrEqual(BOARD_WIDTH - 1);
    }
  });

  it('棋盘无合法落点（堆到顶）→ 空数组（bot 兜底硬降）', () => {
    const g = new TetrisGame({ mode: 'marathon', seed: 'bot-full' });
    fillStack(g, 0); // 顶行（出生区）起全堆满（每行缺一格，T 块无法嵌入任何出生位）
    expect(enumeratePlacements(g.board, 'T', false)).toHaveLength(0);
  });

  it('evaluateBoard 特征：空洞与累计井深计数正确', () => {
    const g = new TetrisGame({ mode: 'marathon', seed: 'bot-feat' });
    // 空洞：col9 row19 有块、row20 空（被覆盖）、row21 有块 → holes = 1
    g.board[19 * BOARD_WIDTH + 9] = 'I';
    g.board[21 * BOARD_WIDTH + 9] = 'I';
    // 井：col0（row20/21 有块）与 col2（row20/21 有块，col3 全堵）之间 col1 成 2 深井
    for (let r = 20; r < TOTAL_HEIGHT; r++) g.board[r * BOARD_WIDTH + 2] = 'I';
    for (let r = 19; r < TOTAL_HEIGHT; r++) g.board[r * BOARD_WIDTH + 3] = 'I';
    for (let r = 20; r < TOTAL_HEIGHT; r++) g.board[r * BOARD_WIDTH + 0] = 'I';
    const f = evaluateBoard(g.board);
    expect(f.holes).toBe(1);
    expect(f.wells).toBe(3); // col1：row20 深度 1 + row21 深度 2
  });
});

describe('BotController 对局行为', () => {
  it('HARD bot 能发现填洞消行落点（I 块补 4 格缺口消 1 行）', () => {
    const g = new TetrisGame({ mode: 'marathon', seed: 'bot-gap' });
    fillBottomGap(g, 3, 7);
    g.active = { type: 'I', x: 3, y: 0, rot: 0 };
    const bot = new BotController('HARD', { rng: new Rng('bot-gap:bot') });
    const ticks = driveBot(g, bot, (gg) => gg.lines >= 1);
    expect(ticks).toBeLessThan(3000);
    expect(g.lines).toBe(1);
    expect(g.status).toBe('running');
  });

  it('Hold 权衡：当前块明显劣于 Hold 块时先换块再填洞', () => {
    const g = new TetrisGame({ mode: 'marathon', seed: 'bot-hold' });
    fillBottomGap(g, 3, 7);
    g.active = { type: 'S', x: 3, y: 0, rot: 0 }; // S 块补不了 4 格缺口
    g.hold = 'I';
    const bot = new BotController('HARD', { rng: new Rng('bot-hold:bot') });
    // 首调（新块）+ 180ms 思考（约 11 tick）→ 共 12 次 null
    for (let i = 0; i < 12; i++) expect(bot.decide(g)).toBeNull();
    const action = bot.decide(g);
    expect(action).toBe('hold');
    g.applyInput(action!); // Room 层职责：把 decide 产出的动作送进引擎（同一输入通道）
    expect(g.hold).toBe('S'); // 换块成功
    const ticks = driveBot(g, bot, (gg) => gg.lines >= 1);
    expect(ticks).toBeLessThan(3000);
    expect(g.lines).toBe(1);
  });

  it('timed 复活循环：反复顶出 → respawn 后 bot 继续对局（topOuts 场景验证）', () => {
    const g = new TetrisGame({ mode: 'marathon', seed: 'bot-respawn' });
    // 用 EASY（高误操作率）+ 更高的垃圾堆，确保能稳定触发多次顶出（HARD 会清行续命）
    const bot = new BotController('EASY', { rng: new Rng('bot-respawn:bot'), attackMode: true });
    let topOuts = 0;
    let piecesAfterRespawn = 0;
    let lastPiece = g.active;
    let ticks = 0;
    fillStack(g, 3);
    while (topOuts < 3 && ticks < 20_000) {
      if (g.active && g.active !== lastPiece) {
        lastPiece = g.active;
        if (topOuts > 0) piecesAfterRespawn++;
      }
      const action = bot.decide(g);
      if (action) g.applyInput(action);
      else g.update(STEP_MS);
      if (g.status === 'finished') {
        topOuts++;
        g.respawn(); // timed 语义（Room.markSeatGameEnded 同款）：清盘复活
        fillStack(g, 3);
      }
      ticks++;
    }
    expect(topOuts).toBeGreaterThanOrEqual(3);
    expect(piecesAfterRespawn).toBeGreaterThan(0); // 复活后 bot 继续落子
  });

  it('硬降门槛：必须逐格 soft 至少一半可见高度后才允许 hard', () => {
    const g = new TetrisGame({ mode: 'marathon', seed: 'bot-step' });
    g.canHold = false; // 避免 Hold 换块重置本块起点，专测单块下降
    const bot = new BotController('HARD', { rng: new Rng('bot-step:bot') });
    let softs = 0;
    let sawHard = false;
    for (let i = 0; i < 800 && !sawHard; i++) {
      const action = bot.decide(g);
      if (action === 'hard') {
        expect(softs).toBeGreaterThanOrEqual(BOT_MIN_HARD_DROP_ROWS);
        expect(g.active!.y).toBeGreaterThanOrEqual(1 + BOT_MIN_HARD_DROP_ROWS);
        sawHard = true;
        break;
      }
      if (action === 'soft') softs += 1;
      if (action) g.applyInput(action);
      else g.update(STEP_MS);
    }
    expect(sawHard).toBe(true);
    expect(softs).toBeGreaterThanOrEqual(BOT_MIN_HARD_DROP_ROWS);
  });

  it('确定性：同 seed + 同难度两次模拟结果完全一致', { timeout: 20_000 }, () => {
    const a = simulateBotGame({ seed: 'determinism', difficulty: 'HARD', maxTicks: 3000 });
    const b = simulateBotGame({ seed: 'determinism', difficulty: 'HARD', maxTicks: 3000 });
    expect(a).toEqual(b);
  });
});

describe('TC-BOT-001 批量对局回归：HARD 显著强于 EASY', () => {
  const SEEDS = Array.from({ length: 12 }, (_, i) => `tc-bot-001-${i}`);

  it('固定 seed 批量对局：HARD 平均消行数远高于 EASY，且顶出率更低', { timeout: 20_000 }, () => {
    const hard = SEEDS.map((s) => simulateBotGame({ seed: s, difficulty: 'HARD', maxTicks: 4000 }));
    const easy = SEEDS.map((s) => simulateBotGame({ seed: s, difficulty: 'EASY', maxTicks: 4000 }));
    const avg = (xs: { lines: number }[]) => xs.reduce((acc, x) => acc + x.lines, 0) / xs.length;
    const topOutRate = (xs: { topOut: boolean }[]) => xs.filter((x) => x.topOut).length / xs.length;
    expect(avg(hard)).toBeGreaterThan(avg(easy) * 2);
    expect(topOutRate(hard)).toBeLessThan(topOutRate(easy));
  });
});
